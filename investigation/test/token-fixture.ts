import type { AccessPolicy, KeySetFetch } from "../core/access-token";

export const ISSUER = "https://sbl-test.cloudflareaccess.com";
export const AUDIENCE = "a".repeat(64);
/** Distinct by default, as two Access applications would be. The tests name the one-application shape on purpose. */
export const HEALTH_AUDIENCE = "d".repeat(64);
export const OWNER = "7335d417-61da-459d-899c-0a01c76a2f94";
export const OWNER_EMAIL = "owner@example.org";
export const HEALTH_CLIENT = "healthcheck.access";
export const NOW_MS = Date.UTC(2026, 10, 1, 12);
export const NOW_SECONDS = NOW_MS / 1000;

export const POLICY: AccessPolicy = Object.freeze({
  issuer: ISSUER,
  audience: AUDIENCE,
  ownerSubject: OWNER,
  ownerEmail: OWNER_EMAIL,
  healthClientId: HEALTH_CLIENT,
  healthAudience: HEALTH_AUDIENCE
});

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export type SigningKey = { id: string; privateKey: CryptoKey; publicJwk: JsonWebKey };

export async function generateSigningKey(id: string, modulusLength = 2048): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    { ...RSA, modulusLength, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"]
  );
  return { id, privateKey: pair.privateKey, publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

export function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function ownerClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: [AUDIENCE],
    email: OWNER_EMAIL,
    exp: NOW_SECONDS + 3600,
    iat: NOW_SECONDS - 60,
    nbf: NOW_SECONDS - 60,
    iss: ISSUER,
    type: "app",
    identity_nonce: "nonce",
    sub: OWNER,
    country: "US",
    ...overrides
  };
}

export function serviceClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: [HEALTH_AUDIENCE],
    common_name: HEALTH_CLIENT,
    exp: NOW_SECONDS + 3600,
    iat: NOW_SECONDS - 60,
    iss: ISSUER,
    type: "app",
    sub: "",
    ...overrides
  };
}

export async function signToken(
  key: SigningKey,
  claims: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {}
): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", kid: key.id, typ: "JWT", ...headerOverrides }));
  const payload = base64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(RSA.name, key.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/** A token over payload bytes exactly as given, for what JSON.stringify could not write. */
export async function signPayloadBytes(key: SigningKey, payloadBytes: Uint8Array): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", kid: key.id, typ: "JWT" }));
  const payload = base64url(payloadBytes);
  const signature = await crypto.subtle.sign(RSA.name, key.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

export type Certs = { fetcher: KeySetFetch; calls: () => number; respond: (next: () => Response | Promise<Response>) => void };

export function certsFor(...keys: SigningKey[]): Certs {
  let calls = 0;
  let responder: () => Response | Promise<Response> = () => certsResponse(...keys);
  return {
    fetcher: async (url) => {
      calls += 1;
      if (url !== `${ISSUER}/cdn-cgi/access/certs`) throw new Error(`Unexpected key set address: ${url}`);
      return responder();
    },
    calls: () => calls,
    respond: (next) => {
      responder = next;
    }
  };
}

export function certsResponse(...keys: SigningKey[]): Response {
  return Response.json({
    keys: keys.map((key) => ({ ...key.publicJwk, kid: key.id, alg: "RS256", use: "sig" })),
    public_cert: { kid: "ignored", cert: "ignored" },
    public_certs: [{ kid: "ignored", cert: "ignored" }]
  });
}
