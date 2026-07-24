/**
 * Browser File reads allocate the selected Blob in the tab before parsing it.
 * Every untrusted upload therefore has to pass an immutable File.size check at
 * the read boundary, not only at the picker. The post-read check is defense in
 * depth for tests and non-native File implementations whose declared size can
 * disagree with the returned payload.
 */

export type ClientFileReadPolicy = {
  label: string;
  maxBytes: number;
  signal?: AbortSignal;
  allowEmpty?: boolean;
};

type BufferReadableFile = Pick<File, "size" | "arrayBuffer">;

export class ClientFileTooLargeError extends Error {
  readonly code = "client-file-too-large";

  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number,
    label: string
  ) {
    super(`${label} is ${formatBytes(actualBytes)}; uploads are limited to ${formatBytes(maxBytes)}.`);
    this.name = "ClientFileTooLargeError";
  }
}

export class ClientFileEmptyError extends Error {
  readonly code = "client-file-empty";

  constructor(label: string) {
    super(`${label} is empty.`);
    this.name = "ClientFileEmptyError";
  }
}

export class ClientFileInvalidUtf8Error extends Error {
  readonly code = "client-file-invalid-utf8";

  constructor(label: string, options?: ErrorOptions) {
    super(`${label} is not valid UTF-8 text.`, options);
    this.name = "ClientFileInvalidUtf8Error";
  }
}

/** Synchronous picker guard; the async readers below repeat this exact check. */
export function assertClientFileReadable(
  file: Pick<File, "size">,
  policy: ClientFileReadPolicy
): void {
  policy.signal?.throwIfAborted();
  const maxBytes = positiveByteLimit(policy.maxBytes);
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new Error(`${policy.label} has an invalid byte length and cannot be opened.`);
  }
  if (!policy.allowEmpty && file.size === 0) throw new ClientFileEmptyError(policy.label);
  if (file.size > maxBytes) throw new ClientFileTooLargeError(file.size, maxBytes, policy.label);
}

/** Read text only after the native File byte length is known to be bounded. */
export async function readClientFileText(
  file: BufferReadableFile,
  policy: ClientFileReadPolicy
): Promise<string> {
  assertClientFileReadable(file, policy);
  const buffer = await file.arrayBuffer();
  policy.signal?.throwIfAborted();
  assertReturnedSize(buffer.byteLength, policy);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new ClientFileInvalidUtf8Error(policy.label, { cause: error });
  }
}

/** Read bytes only after the native File byte length is known to be bounded. */
export async function readClientFileArrayBuffer(
  file: BufferReadableFile,
  policy: ClientFileReadPolicy
): Promise<ArrayBuffer> {
  assertClientFileReadable(file, policy);
  const buffer = await file.arrayBuffer();
  policy.signal?.throwIfAborted();
  assertReturnedSize(buffer.byteLength, policy);
  return buffer;
}

function assertReturnedSize(actualBytes: number, policy: ClientFileReadPolicy): void {
  const maxBytes = positiveByteLimit(policy.maxBytes);
  if (!policy.allowEmpty && actualBytes === 0) throw new ClientFileEmptyError(policy.label);
  if (actualBytes > maxBytes) throw new ClientFileTooLargeError(actualBytes, maxBytes, policy.label);
}

function positiveByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("file byte limit must be a positive integer.");
  }
  return value;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${formatUnit(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${formatUnit(bytes / 1024)} KB`;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

function formatUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
