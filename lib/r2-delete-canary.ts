const DEFAULT_CANARY_PREFIX = "health/r2-delete-canary/";

export type R2DeleteCanaryObjectBody = {
  text(): Promise<string>;
};

export type R2DeleteCanaryBucket = {
  put(
    key: string,
    value: string,
    options: {
      onlyIf: { etagDoesNotMatch: "*" };
      httpMetadata: { contentType: "text/plain; charset=utf-8" };
      customMetadata: { purpose: "production-delete-canary"; createdAt: string };
    }
  ): Promise<unknown | null>;
  get(key: string): Promise<R2DeleteCanaryObjectBody | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<unknown | null>;
};

export type R2DeleteCanaryResult = {
  keyPrefix: string;
  created: true;
  readBack: true;
  deleted: true;
};

export type R2DeleteCanaryOptions = {
  now?: () => Date;
  randomUUID?: () => string;
  prefix?: string;
};

/**
 * Exercise one create-only R2 write, exact readback, delete, and absence
 * readback. The key is generated internally beneath a fixed prefix; callers
 * cannot select an existing report key or turn this into a general deletion
 * primitive.
 */
export async function runR2DeleteCanary(
  bucket: R2DeleteCanaryBucket,
  options: R2DeleteCanaryOptions = {}
): Promise<R2DeleteCanaryResult> {
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("R2 delete canary received an invalid clock value.");

  const prefix = normalizeCanaryPrefix(options.prefix ?? DEFAULT_CANARY_PREFIX);
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const nonce = randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) {
    throw new Error("R2 delete canary received an invalid random UUID.");
  }

  const createdAt = now.toISOString();
  const key = `${prefix}${createdAt.replace(/[-:.]/g, "")}-${nonce}.txt`;
  if (!key.startsWith(DEFAULT_CANARY_PREFIX) || key.includes("..")) {
    throw new Error("R2 delete canary key escaped its fixed prefix.");
  }
  const marker = `site-behavior-lab-r2-delete-canary\n${createdAt}\n${nonce}\n`;
  let created = false;
  let operationError: unknown;

  try {
    const stored = await bucket.put(key, marker, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { purpose: "production-delete-canary", createdAt }
    });
    if (stored === null) throw new Error("R2 delete canary create-only write conflicted.");
    created = true;

    const readback = await bucket.get(key);
    if (readback === null || (await readback.text()) !== marker) {
      throw new Error("R2 delete canary readback did not match the exact written marker.");
    }
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  if (created) {
    try {
      await bucket.delete(key);
      if ((await bucket.head(key)) !== null) {
        throw new Error("R2 delete canary object still existed after deletion.");
      }
    } catch (error) {
      cleanupError = error;
    }
  }

  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([operationError, cleanupError], "R2 delete canary operation and cleanup both failed.");
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (!created) throw new Error("R2 delete canary did not create its object.");

  return { keyPrefix: prefix, created: true, readBack: true, deleted: true };
}

function normalizeCanaryPrefix(value: string): string {
  if (value !== DEFAULT_CANARY_PREFIX) {
    throw new Error(`R2 delete canary prefix must remain ${DEFAULT_CANARY_PREFIX}.`);
  }
  return value;
}

export const R2_DELETE_CANARY_PREFIX = DEFAULT_CANARY_PREFIX;
