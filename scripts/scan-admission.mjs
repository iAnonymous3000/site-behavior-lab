import { createHmac, randomBytes } from "node:crypto";

export const SCAN_ADMISSION_CAPABILITY_HEADER = "x-site-behavior-lab-scan-admission";
export const SCAN_ADMISSION_COMMITMENT_HEADER =
  "x-site-behavior-lab-scan-admission-commitment";

const COMMITMENT_DOMAIN = "site-behavior-lab/scan-admission/commitment/v1";
const ALLOWED_KEYS = new Set([
  "url",
  "device",
  "gpcEnabled",
  "compareGpc",
  "compareShields",
  "compareConsent",
  "consentMode",
  "turnstileToken"
]);

/**
 * Give non-browser scan clients the same request-bound admission wire as the
 * web UI. Sending these headers is harmless when durable mode is disabled and
 * required when a deployment advertises durable admission.
 */
export function prepareScanAdmission(input, randomBytesImpl = randomBytes) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Scan admission requires an object body.");
  }
  if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new Error("Scan admission body contains an unsupported field.");
  }
  const body = {
    url: canonicalTargetUrl(input.url),
    device: input.device,
    gpcEnabled: input.gpcEnabled ?? false,
    compareGpc: input.compareGpc ?? false,
    compareShields: input.compareShields ?? false,
    compareConsent: input.compareConsent ?? false,
    consentMode: input.consentMode,
    ...(input.turnstileToken !== undefined ? { turnstileToken: input.turnstileToken } : {})
  };
  if (
    (body.device !== "desktop" && body.device !== "mobile") ||
    typeof body.gpcEnabled !== "boolean" ||
    typeof body.compareGpc !== "boolean" ||
    typeof body.compareShields !== "boolean" ||
    typeof body.compareConsent !== "boolean" ||
    Number(body.compareGpc) + Number(body.compareShields) + Number(body.compareConsent) > 1 ||
    body.consentMode !== "observe" ||
    ("turnstileToken" in body && typeof body.turnstileToken !== "string")
  ) {
    throw new Error("Scan admission body is not canonical.");
  }

  const capabilityBytes = randomBytesImpl(32);
  if (!(capabilityBytes instanceof Uint8Array) || capabilityBytes.byteLength !== 32) {
    throw new Error("Scan admission capability source must return 32 bytes.");
  }
  const capabilityToken = Buffer.from(capabilityBytes).toString("base64url");
  const semantics = {
    version: 1,
    url: body.url,
    device: body.device,
    gpcEnabled: body.gpcEnabled,
    compareGpc: body.compareGpc,
    compareShields: body.compareShields,
    compareConsent: body.compareConsent,
    consentMode: "observe"
  };
  const requestCommitment = createHmac("sha256", capabilityBytes)
    .update(`${COMMITMENT_DOMAIN}\0${JSON.stringify(semantics)}`)
    .digest("base64url");
  return {
    body,
    credential: { capabilityToken, requestCommitment },
    headers: {
      [SCAN_ADMISSION_CAPABILITY_HEADER]: capabilityToken,
      [SCAN_ADMISSION_COMMITMENT_HEADER]: requestCommitment
    }
  };
}

function canonicalTargetUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new Error("Scan admission requires a valid target URL.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Scan admission requires a valid target URL.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("Scan admission requires a standard credential-free HTTP(S) URL.");
  }
  // The scanner ignores fragments. Queries affect a lower-level direct API
  // request and therefore remain inside the keyed commitment.
  url.hash = "";
  return url.href;
}
