const AUTHORIZATION_PREFIX = "hmac-sha256:";
const DOMAIN = "site-behavior-lab/durable-restart-control/v1";
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const JOB_ID_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/;
const AUTHORIZATION_PATTERN = /^hmac-sha256:([A-Za-z0-9_-]{43})$/;

export type DurableRestartControlBinding = Readonly<{
  githubRunId: string;
  jobId: string;
  reportId: string;
}>;

export function isDurableRestartGithubRunId(
  value: unknown
): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

export async function createDurableRestartControlAuthorization(
  secret: string,
  binding: DurableRestartControlBinding
): Promise<string> {
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    copyArrayBuffer(messageBytes(binding))
  );
  return `${AUTHORIZATION_PREFIX}${base64url(
    new Uint8Array(signature)
  )}`;
}

export async function verifyDurableRestartControlAuthorization(
  secret: string,
  binding: DurableRestartControlBinding,
  authorization: string
): Promise<boolean> {
  const match = AUTHORIZATION_PATTERN.exec(authorization);
  if (!match) return false;
  let signature: Uint8Array;
  try {
    signature = base64urlBytes(match[1]);
  } catch {
    return false;
  }
  if (base64url(signature) !== match[1]) return false;
  const key = await importHmacKey(secret, ["verify"]);
  return crypto.subtle.verify(
    "HMAC",
    key,
    copyArrayBuffer(signature),
    copyArrayBuffer(messageBytes(binding))
  );
}

function messageBytes(binding: DurableRestartControlBinding): Uint8Array {
  if (
    !isDurableRestartGithubRunId(binding.githubRunId) ||
    !JOB_ID_PATTERN.test(binding.jobId) ||
    !JOB_ID_PATTERN.test(binding.reportId) ||
    binding.jobId === binding.reportId
  ) {
    throw new Error(
      "The durable restart control binding is invalid."
    );
  }
  return new TextEncoder().encode(
    `${DOMAIN}\0${binding.githubRunId}\0${binding.jobId}\0${binding.reportId}`
  );
}

async function importHmacKey(
  secret: string,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  if (
    secret.length < 32 ||
    secret.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(secret)
  ) {
    throw new Error(
      "The durable restart control secret is invalid."
    );
  }
  return crypto.subtle.importKey(
    "raw",
    copyArrayBuffer(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64urlBytes(value: string): Uint8Array {
  const canonical = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = canonical.padEnd(
    canonical.length + ((4 - (canonical.length % 4)) % 4),
    "="
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) =>
    character.charCodeAt(0)
  );
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
