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

/**
 * The public shape of a failed request.
 *
 * `cause` is present ONLY when the thrower declared one. Two reasons it is
 * omitted rather than set to undefined: the existing contract tests compare
 * this object with deepEqual to pin the exact public shape, and an unexplained
 * failure should carry no cause at all so the client renders the message
 * verbatim instead of attaching an instruction nobody derived.
 *
 * The unexpected-error branch deliberately declares no cause either. Its
 * scrubbed message already carries its own advice, and classifying an error we
 * could not identify would be the same guess this whole mechanism removed.
 */
export function toPublicError(error: unknown): {
  message: string;
  status: number;
  cause?: ScanFailureCause;
} {
  if (error instanceof PublicFacingError) {
    return error.failureCause === undefined
      ? { message: error.message, status: error.status }
      : { message: error.message, status: error.status, cause: error.failureCause };
  }

  console.error(error);
  return { message: "The service could not complete this request. Try again later.", status: 500 };
}
