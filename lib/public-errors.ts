import type { ScanFailureCause } from "./scan-failure-causes";

/**
 * `failureCause` is the DECLARED reason a request failed, carried to the client so it
 * never has to infer one from this message's wording. See
 * lib/scan-failure-causes.ts for why inference was removed. It is named
 * `failureCause`, not `cause`, because ES2022 `Error` already owns `cause`
 * with a different meaning (the wrapped error) and shadowing it fights the
 * base type. The WIRE field stays `cause`. It is optional:
 * an undeclared cause makes the client render this message verbatim with no
 * added instruction, which is the safe direction.
 */
export class PublicFacingError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    name = "PublicFacingError",
    public readonly failureCause?: ScanFailureCause
  ) {
    super(message);
    this.name = name;
  }
}

export class PublicScanError extends PublicFacingError {
  constructor(message: string, status = 400, failureCause?: ScanFailureCause) {
    super(message, status, "PublicScanError", failureCause);
  }
}

export function toPublicError(error: unknown): {
  message: string;
  status: number;
  cause?: ScanFailureCause;
} {
  if (error instanceof PublicFacingError) {
    return { message: error.message, status: error.status, cause: error.failureCause };
  }

  console.error(error);
  return {
    message: "The service could not complete this request. Try again later.",
    status: 500,
    cause: "service-error"
  };
}
