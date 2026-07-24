import { parseJsonBytesWithPolicy } from "./client-fetch-policy";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export class ClientReportIntegrityError extends Error {
  readonly code = "client-report-integrity";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClientReportIntegrityError";
  }
}

/** Verify the exact response bytes before UTF-8 decoding or JSON parsing. */
export async function parseDigestBoundReportJson(
  bytes: Uint8Array,
  expectedSha256: string,
  label: string
): Promise<unknown> {
  if (!SHA256_HEX_PATTERN.test(expectedSha256)) {
    throw new ClientReportIntegrityError(`${label} did not include a valid server evidence digest.`);
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ClientReportIntegrityError(`${label} could not be verified in this browser.`);
  }

  // WebCrypto keeps the up-to-8 MiB verification pass off the main thread.
  // Re-wrap ArrayBuffer-backed views so byteOffset/byteLength remain exact;
  // the copy fallback exists only for SharedArrayBuffer-backed test inputs.
  const digestInput = bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  let actualSha256: string;
  try {
    const digest = new Uint8Array(await subtle.digest("SHA-256", digestInput));
    actualSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    throw new ClientReportIntegrityError(`${label} could not be verified in this browser.`, { cause: error });
  }

  if (actualSha256 !== expectedSha256) {
    throw new ClientReportIntegrityError(`${label} did not match the evidence used to render this page.`);
  }
  return parseJsonBytesWithPolicy(bytes, label);
}
