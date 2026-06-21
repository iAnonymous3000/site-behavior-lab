export class PublicFacingError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    name = "PublicFacingError"
  ) {
    super(message);
    this.name = name;
  }
}

export class PublicScanError extends PublicFacingError {
  constructor(message: string, status = 400) {
    super(message, status, "PublicScanError");
  }
}

export function toPublicError(error: unknown): { message: string; status: number } {
  if (error instanceof PublicFacingError) {
    return { message: error.message, status: error.status };
  }

  console.error(error);
  return { message: "Scan failed. Check the target URL and try again.", status: 500 };
}
