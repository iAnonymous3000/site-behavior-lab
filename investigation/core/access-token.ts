// Verifies the Cloudflare Access application token on a request to the private
// investigation workspace.
//
// Access stands in front of the workspace, and this module does not trust that
// on its own: a misconfigured policy, a route that skips Access, or an alias
// would otherwise hand the Worker an unauthenticated request. So every request
// is verified here, and anything this module cannot verify is refused.
//
// Pure, with no Node builtin and no dependency, so it runs in a Worker and in
// the unit suite alike. The clock and the fetch are passed in.
//
// A stated limit: `sub` is documented as unique per email per account, so nothing in
// a token tells this module which login method produced it. Two methods for one email
// look the same here. Restricting the identity provider is a setting in Access, and
// nothing here checks it.
//
// https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

export const ACCESS_TOKEN_HEADER = "cf-access-jwt-assertion";

const MAX_TOKEN_CHARS = 16_384;
const MAX_KEY_SET_BYTES = 65_536;
const MIN_RSA_MODULUS_BITS = 2048;
/** The exponent every RSA signing key Access mints uses, base64url. */
const RSA_EXPONENT_65537 = "AQAB";
/**
 * How long a fetched key set is trusted, from when its fetch began. Access rotates
 * its signing key every six weeks and leaves the old one valid for seven days, so
 * this bounds how long a key removed in an emergency keeps working, not routine
 * rotation.
 */
export const KEY_SET_TRUST_MS = 5 * 60_000;
/**
 * After any fetch finishes, a miss waits this long to fetch again, so a stream of
 * unknown key ids, or an outage, costs one fetch per interval. Misses that arrive
 * before a fetch has finished each fetch: see AccessKeySet.
 */
export const KEY_SET_REFETCH_INTERVAL_MS = 30_000;
const KEY_SET_FETCH_BOUND_MS = 5_000;
/** Allows for a Worker's clock behind the one that minted the token. Expiry gets no such allowance. */
const ISSUED_AT_SKEW_SECONDS = 10;

/**
 * The one service token admitted, to the health route only, and the audience it must
 * carry, or neither. Half of this cannot be configured. Access gives each application
 * its own AUD, so a policy scoped to the health path means a second application with
 * its own audience. In a one-application setup the two audiences are simply equal.
 */
type HealthAccess = Readonly<{ healthClientId: string; healthAudience: string }> | Readonly<{ healthClientId: null; healthAudience: null }>;

export type AccessPolicy = Readonly<{
  /** The team domain, exactly as the token's `iss` carries it. */
  issuer: string;
  /** The AUD tag of the Access application the owner signs in to. */
  audience: string;
  /** The owner's `sub`, unique to an email per account. It changes if they are removed and re-added. */
  ownerSubject: string;
  /**
   * The owner's email, exactly as the token's `email` carries it. Both this and the
   * subject must match. Compared exactly, so an identity provider that changes the
   * spelling locks the owner out until configuration changes, and never admits a
   * near match.
   */
  ownerEmail: string;
}> &
  HealthAccess;

export type VerifiedIdentity =
  | Readonly<{ kind: "owner"; issuer: string; subject: string; email: string; issuedAt: number; expiresAt: number }>
  | Readonly<{ kind: "health-service"; issuer: string; clientId: string; issuedAt: number; expiresAt: number }>;

export type AccessRefusal =
  | "missing-token"
  | "malformed-token"
  | "unsupported-algorithm"
  | "keys-unavailable"
  | "unknown-key"
  | "bad-signature"
  | "wrong-issuer"
  | "wrong-audience"
  | "wrong-token-type"
  | "malformed-claims"
  | "expired"
  | "not-yet-valid"
  | "not-the-owner-subject"
  | "not-the-owner-email"
  | "unrecognized-service-token";

export type AccessDecision = Readonly<{ ok: true; identity: VerifiedIdentity }> | Readonly<{ ok: false; refusal: AccessRefusal }>;

export type KeySetFetch = (url: string, init: RequestInit) => Promise<Response>;

const TEAM_ISSUER = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD_TAG = /^[0-9a-f]{64}$/;
const SAFE_IDENTIFIER = /^[\x21-\x7e]{1,256}$/;
/** One address with one `@`, in printable ASCII with no space. What the provider vouches for is up to it. */
const OWNER_EMAIL = /^[\x21-\x3f\x41-\x7e]{1,64}@[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,189}[a-zA-Z0-9])?$/;

/** A policy only from complete, well-formed configuration, so a missing value can never admit anyone. */
export function accessPolicyFrom(values: {
  issuer?: unknown;
  audience?: unknown;
  ownerSubject?: unknown;
  ownerEmail?: unknown;
  healthClientId?: unknown;
  healthAudience?: unknown;
}): AccessPolicy | null {
  const { issuer, audience, ownerSubject, ownerEmail, healthClientId, healthAudience } = values;
  if (typeof issuer !== "string" || !TEAM_ISSUER.test(issuer)) return null;
  if (typeof audience !== "string" || !AUD_TAG.test(audience)) return null;
  if (typeof ownerSubject !== "string" || !SAFE_IDENTIFIER.test(ownerSubject)) return null;
  if (typeof ownerEmail !== "string" || !OWNER_EMAIL.test(ownerEmail)) return null;
  const noClientId = healthClientId === undefined || healthClientId === "";
  const noHealthAudience = healthAudience === undefined || healthAudience === "";
  if (noClientId && noHealthAudience) {
    return Object.freeze({ issuer, audience, ownerSubject, ownerEmail, healthClientId: null, healthAudience: null });
  }
  // Past here both are required, so a half-configured health path gives no policy at all.
  if (typeof healthClientId !== "string" || !SAFE_IDENTIFIER.test(healthClientId)) return null;
  if (typeof healthAudience !== "string" || !AUD_TAG.test(healthAudience)) return null;
  return Object.freeze({ issuer, audience, ownerSubject, ownerEmail, healthClientId, healthAudience });
}

/**
 * Identities this module verified. A VerifiedIdentity is a plain object that any
 * code could spell, so holding the type says nothing: this set is how actor
 * derivation tells a verification's result from a look-alike. Nothing is added to
 * it but the two results in decideClaims below, and nothing about an object's
 * shape puts it here, so a copy or a parsed one is not in it.
 */
const verifiedIdentities = new WeakSet<VerifiedIdentity>();

/** Whether this exact object came out of verifyAccessToken in this isolate. */
export function isVerifiedIdentity(identity: VerifiedIdentity): boolean {
  return verifiedIdentities.has(identity);
}

function admit(identity: VerifiedIdentity): AccessDecision {
  const frozen = Object.freeze(identity);
  verifiedIdentities.add(frozen);
  return { ok: true, identity: frozen };
}

function base64urlBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
  // One value has one spelling: stray trailing bits are refused.
  if (btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !== value) return null;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function jsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A token time is a count of seconds since the epoch. Access mints whole ones, and an entry holds them as they are, which -0 has no form for. */
function isNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

type KeyLookup = CryptoKey | "unknown-key" | "keys-unavailable";

function isWithin(since: number | null, now: number, span: number): boolean {
  // A clock that moved backward earns nothing.
  return since !== null && now >= since && now - since < span;
}

/**
 * The team's signing keys by id. Nothing here may hold a promise across requests:
 * a Worker cannot await another request's fetch, so concurrent misses each fetch,
 * and fetches can finish out of order. The newest one started stands.
 */
export class AccessKeySet {
  private keys: ReadonlyMap<string, CryptoKey> = new Map();
  /** When the fetch behind `keys` began, so a slow fetch earns no extra trust. */
  private keysFetchStartedAt: number | null = null;
  private lastFetchFinishedAt: number | null = null;
  private fetchesStarted = 0;
  private newestFetchApplied = 0;

  constructor(
    private readonly issuer: string,
    private readonly fetcher: KeySetFetch,
    private readonly now: () => number,
    private readonly fetchBoundMs: number = KEY_SET_FETCH_BOUND_MS
  ) {}

  async keyFor(keyId: string): Promise<KeyLookup> {
    const now = this.now();
    const trusted = isWithin(this.keysFetchStartedAt, now, KEY_SET_TRUST_MS);
    const known = trusted ? this.keys.get(keyId) : undefined;
    if (known !== undefined) return known;
    if (isWithin(this.lastFetchFinishedAt, now, KEY_SET_REFETCH_INTERVAL_MS)) return trusted ? "unknown-key" : "keys-unavailable";
    return this.fetchThenLookUp(keyId);
  }

  private async fetchThenLookUp(keyId: string): Promise<KeyLookup> {
    const startedAt = this.now();
    this.fetchesStarted += 1;
    const sequence = this.fetchesStarted;
    const fetched = await this.fetchKeys();
    const finishedAt = this.now();
    this.lastFetchFinishedAt = finishedAt;
    if (fetched !== null && sequence > this.newestFetchApplied) {
      this.newestFetchApplied = sequence;
      this.keys = fetched;
      this.keysFetchStartedAt = startedAt;
    }
    // A failed fetch leaves a set still in trust alone: it stops being read at its
    // time, and until then a forged key id cannot lock out the keys it holds.
    if (!isWithin(this.keysFetchStartedAt, finishedAt, KEY_SET_TRUST_MS)) return "keys-unavailable";
    const known = this.keys.get(keyId);
    if (known !== undefined) return known;
    return fetched === null ? "keys-unavailable" : "unknown-key";
  }

  private async fetchKeys(): Promise<ReadonlyMap<string, CryptoKey> | null> {
    try {
      const response = await this.fetcher(`${this.issuer}/cdn-cgi/access/certs`, {
        // No cached copy can extend a key's life past the trust above.
        cache: "no-store",
        // Workers refuse redirect: "error", so a redirect is refused by its status below.
        redirect: "manual",
        signal: AbortSignal.timeout(this.fetchBoundMs)
      });
      if (response.status !== 200) return null;
      const text = await boundedText(response);
      if (text === null) return null;
      const body: unknown = JSON.parse(text);
      const entries = (body as { keys?: unknown } | null)?.keys;
      if (!Array.isArray(entries)) return null;
      const keys = new Map<string, CryptoKey>();
      for (const entry of entries as unknown[]) {
        const imported = await importSigningKey(entry);
        if (imported !== null) keys.set(imported.id, imported.key);
      }
      return keys.size > 0 ? keys : null;
    } catch {
      return null;
    }
  }
}

async function boundedText(response: Response): Promise<string | null> {
  if (Number(response.headers.get("content-length") ?? 0) > MAX_KEY_SET_BYTES) return null;
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_KEY_SET_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The modulus's own bits: zero padding cannot make a short key look long. */
function isStrongModulus(modulus: Uint8Array): boolean {
  if (modulus[0] === 0) return false;
  return (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0])) >= MIN_RSA_MODULUS_BITS;
}

async function importSigningKey(entry: unknown): Promise<{ id: string; key: CryptoKey } | null> {
  if (entry === null || typeof entry !== "object") return null;
  const { kid, kty, n, e, alg, use } = entry as Record<string, unknown>;
  if (typeof kid !== "string" || kid === "" || kty !== "RSA" || typeof n !== "string" || e !== RSA_EXPONENT_65537) return null;
  if ((alg !== undefined && alg !== "RS256") || (use !== undefined && use !== "sig")) return null;
  const modulus = base64urlBytes(n);
  if (modulus === null || !isStrongModulus(modulus)) return null;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n, e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return { id: kid, key };
  } catch {
    return null;
  }
}

function refuse(refusal: AccessRefusal): AccessDecision {
  return { ok: false, refusal };
}

/** Decide one token. Nothing is read from its claims until its signature has verified. */
export async function verifyAccessToken(
  token: string | null,
  policy: AccessPolicy,
  keySet: Pick<AccessKeySet, "keyFor">,
  now: () => number
): Promise<AccessDecision> {
  if (token === null || token === "") return refuse("missing-token");
  if (token.length > MAX_TOKEN_CHARS) return refuse("malformed-token");
  const segments = token.split(".");
  if (segments.length !== 3) return refuse("malformed-token");
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const headerBytes = base64urlBytes(encodedHeader);
  const payloadBytes = base64urlBytes(encodedPayload);
  const signature = base64urlBytes(encodedSignature);
  if (headerBytes === null || payloadBytes === null || signature === null) return refuse("malformed-token");
  const header = jsonObject(headerBytes);
  if (header === null) return refuse("malformed-token");

  if (header.alg !== "RS256") return refuse("unsupported-algorithm");
  // A critical extension must be understood, and this verifier understands none.
  if (header.crit !== undefined) return refuse("unsupported-algorithm");
  if (typeof header.kid !== "string" || header.kid === "") return refuse("malformed-token");

  const key = await keySet.keyFor(header.kid);
  if (key === "keys-unavailable" || key === "unknown-key") return refuse(key);

  const signedBytes = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  let verified = false;
  try {
    verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedBytes);
  } catch {
    // A runtime may throw on a signature of the wrong length, not answer false.
  }
  if (!verified) return refuse("bad-signature");

  const payload = jsonObject(payloadBytes);
  if (payload === null) return refuse("malformed-claims");
  return decideClaims(payload, policy, now() / 1000);
}

function decideClaims(payload: Record<string, unknown>, policy: AccessPolicy, nowSeconds: number): AccessDecision {
  if (payload.iss !== policy.issuer) return refuse("wrong-issuer");

  const { exp, iat, nbf, sub, email, common_name: commonName } = payload;
  if (typeof sub !== "string") return refuse("malformed-claims");
  // A token's kind comes first, because it decides whose audience the token must carry.
  const isServiceToken = sub === "";
  const requiredAudience = isServiceToken ? policy.healthAudience : policy.audience;
  if (requiredAudience === null) return refuse("unrecognized-service-token");
  const audiences = Array.isArray(payload.aud) ? (payload.aud as unknown[]) : [payload.aud];
  if (!audiences.includes(requiredAudience)) return refuse("wrong-audience");
  if (payload.type !== "app") return refuse("wrong-token-type");

  if (!isNumericDate(exp) || !isNumericDate(iat)) return refuse("malformed-claims");
  if (nbf !== undefined && !isNumericDate(nbf)) return refuse("malformed-claims");
  if (nowSeconds >= exp) return refuse("expired");
  if (iat > nowSeconds + ISSUED_AT_SKEW_SECONDS) return refuse("not-yet-valid");
  if (nbf !== undefined && nbf > nowSeconds + ISSUED_AT_SKEW_SECONDS) return refuse("not-yet-valid");

  if (isServiceToken) {
    // A service token carries an empty sub and names itself by client id.
    if (typeof commonName !== "string" || commonName === "") return refuse("malformed-claims");
    if (commonName !== policy.healthClientId) return refuse("unrecognized-service-token");
    return admit({ kind: "health-service", issuer: policy.issuer, clientId: commonName, issuedAt: iat, expiresAt: exp });
  }
  // A token claiming to be both a person and a service token is neither.
  if (commonName !== undefined && commonName !== "") return refuse("malformed-claims");
  if (sub !== policy.ownerSubject) return refuse("not-the-owner-subject");
  if (typeof email !== "string" || email === "") return refuse("malformed-claims");
  if (email !== policy.ownerEmail) return refuse("not-the-owner-email");
  return admit({ kind: "owner", issuer: policy.issuer, subject: sub, email, issuedAt: iat, expiresAt: exp });
}
