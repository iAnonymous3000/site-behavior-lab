/**
 * Read one verifier artifact without ever consuming more than the configured
 * byte ceiling. Published origins may omit Content-Length (for example, when
 * a response is chunked), so the header is only an early refusal; the stream
 * itself remains the authoritative limit.
 */
export async function readVerifyArtifactTextWithinLimit(
  response: Response,
  url: string,
  maxBytes: number
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("The verifier response byte ceiling must be a positive safe integer.");
  }
  const contentEncoding = response.headers.get("content-encoding");
  const declaredLengthDescribesBody =
    contentEncoding === null || contentEncoding.trim().toLowerCase() === "identity";
  let expectedLength: number | null = null;
  if (declaredLengthDescribesBody) {
    const declaredHeader = response.headers.get("content-length");
    if (declaredHeader !== null && !/^[0-9]+$/.test(declaredHeader)) {
      cancelBodyDetached(response);
      throw new Error(`${url} returned an invalid Content-Length.`);
    }
    const declared = declaredHeader === null ? null : Number(declaredHeader);
    if (declared !== null && (!Number.isSafeInteger(declared) || declared > maxBytes)) {
      cancelBodyDetached(response);
      throw new Error(`${url} declares ${declared} bytes, above the ${maxBytes} ceiling.`);
    }
    expectedLength = declared;
  }

  if (!response.body) {
    if (expectedLength !== null && expectedLength !== 0) {
      throw new Error(`${url} body length does not match Content-Length.`);
    }
    return "";
  }

  const reader = response.body.getReader();
  // A chunk array is not safe here: an origin can send arbitrarily many tiny
  // or empty chunks while remaining below the byte ceiling, turning array and
  // object metadata into an unbounded allocation. One fixed-capacity buffer
  // keeps retained body storage bounded independently of chunk count.
  const bytes = new Uint8Array(maxBytes);
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;

      if (value.byteLength > maxBytes - totalBytes) {
        // Cancellation is best-effort cleanup, not part of the admission
        // decision. An adversarial stream must not keep the verifier waiting
        // by returning a cancel promise that never settles.
        cancelReaderDetached(reader);
        throw new Error(`${url} exceeded the ${maxBytes} byte ceiling.`);
      }
      bytes.set(value, totalBytes);
      totalBytes += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A broken stream must not mask the authoritative size refusal.
    }
  }

  if (expectedLength !== null && totalBytes !== expectedLength) {
    throw new Error(`${url} body length does not match Content-Length.`);
  }
  return new TextDecoder().decode(bytes.subarray(0, totalBytes));
}

function cancelBodyDetached(response: Response): void {
  try {
    observeDetached(response.body?.cancel());
  } catch {
    // The declared-size refusal remains authoritative if cleanup fails.
  }
}

function cancelReaderDetached(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    observeDetached(reader.cancel());
  } catch {
    // The streamed-size refusal remains authoritative if cleanup fails.
  }
}

function observeDetached(value: Promise<void> | undefined): void {
  void value?.catch(() => undefined);
}
