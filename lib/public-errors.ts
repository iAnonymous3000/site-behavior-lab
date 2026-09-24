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
    public readonly failureCause?: ScanFailureCause,
    /** The producer's known wait, carried as data beside a quota refusal. */
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = name;
  }
}

export class PublicScanError extends PublicFacingError {
  constructor(message: string, status = 400, failureCause?: ScanFailureCause, retryAfterSeconds?: number) {
    super(message, status, "PublicScanError", failureCause, retryAfterSeconds);
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
  retryAfterSeconds?: number;
} {
  if (error instanceof PublicFacingError) {
    // `retryAfterSeconds` follows the same rule as `cause`: present only when
    // the thrower supplied a usable value, never set to undefined.
    return {
      message: error.message,
      status: error.status,
      ...(error.failureCause === undefined ? {} : { cause: error.failureCause }),
      ...(Number.isSafeInteger(error.retryAfterSeconds) && (error.retryAfterSeconds as number) > 0
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {})
    };
  }

  console.error(error);
  return { message: "The service could not complete this request. Try again later.", status: 500 };
}

/**
 * The one wire body for a failed request. Every producer that serializes a
 * public error builds it here, so `cause` and `retryAfterSeconds` cannot reach
 * the client from one producer and silently go missing from another. With
 * neither present the bytes are exactly `{"ok":false,"error":...}`.
 */
export function publicErrorBody(publicError: ReturnType<typeof toPublicError>): {
  ok: false;
  error: string;
  cause?: ScanFailureCause;
  retryAfterSeconds?: number;
} {
  return {
    ok: false,
    error: publicError.message,
    ...(publicError.cause === undefined ? {} : { cause: publicError.cause }),
    ...(publicError.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: publicError.retryAfterSeconds })
  };
}
