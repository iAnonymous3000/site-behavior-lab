import {
  SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
  SERVER_STORED_REPORT_JSON_MAX_BYTES
} from "./report-resource-limits";

/**
 * The remediation Worker may inspect legacy reports that predate today's
 * tighter producer limits. Keep its read ceiling aligned with the public
 * report readers so the safety control does not silently narrow the supported
 * migration set.
 */
export const R2_REMEDIATION_REPORT_MAX_BYTES = SERVER_STORED_REPORT_JSON_MAX_BYTES;
export const R2_REMEDIATION_SIDECAR_MAX_BYTES = SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES;

/**
 * A remediation run intentionally inventories the complete prefix before it
 * can write. These ceilings make that fail-closed proof finite even if the
 * bound bucket or prefix is unexpectedly large.
 */
// Ten thousand objects allow up to five thousand canonical report/sidecar
// pairs. The independent key-byte limit remains generous for canonical keys
// while stopping a smaller population of abnormally long keys.
export const R2_REMEDIATION_INVENTORY_MAX_PAGES = 16;
export const R2_REMEDIATION_INVENTORY_MAX_OBJECTS = 10_000;
export const R2_REMEDIATION_INVENTORY_MAX_KEY_BYTES = 2 * 1024 * 1024;
export const R2_REMEDIATION_LIST_PAGE_SIZE = 1_000;

export type R2RemediationObjectKind = "report" | "sidecar";

export type R2RemediationByteObject = {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type R2RemediationInventoryUsage = {
  pages: number;
  objects: number;
  keyBytes: number;
};

export const EMPTY_R2_REMEDIATION_INVENTORY_USAGE: Readonly<R2RemediationInventoryUsage> = Object.freeze({
  pages: 0,
  objects: 0,
  keyBytes: 0
});

export class R2RemediationResourceLimitError extends Error {
  readonly code = "r2-remediation-resource-limit";

  constructor(
    readonly resource:
      | "report-object"
      | "sidecar-object"
      | "inventory-pages"
      | "inventory-objects"
      | "inventory-key-bytes"
  ) {
    super(`R2 remediation ${resource} exceeded its resource limit.`);
    this.name = "R2RemediationResourceLimitError";
  }
}

export class R2RemediationDecodeError extends Error {
  readonly code = "r2-remediation-invalid-utf8";

  constructor(readonly kind: R2RemediationObjectKind) {
    super(`R2 remediation ${kind} object is not exact valid UTF-8.`);
    this.name = "R2RemediationDecodeError";
  }
}

/**
 * R2 supplies an immutable object size alongside the body. Reject an invalid
 * or oversized declaration before allocating the body, require the returned
 * byte count to match that declaration, and decode with replacement disabled.
 * JSON parsing and provenance therefore operate on the exact stored bytes.
 */
export async function readR2RemediationObjectText(
  object: R2RemediationByteObject,
  kind: R2RemediationObjectKind
): Promise<string> {
  const maxBytes = kind === "report" ? R2_REMEDIATION_REPORT_MAX_BYTES : R2_REMEDIATION_SIDECAR_MAX_BYTES;
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > maxBytes) {
    throw new R2RemediationResourceLimitError(kind === "report" ? "report-object" : "sidecar-object");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size || bytes.byteLength > maxBytes) {
    throw new R2RemediationResourceLimitError(kind === "report" ? "report-object" : "sidecar-object");
  }
  try {
    // Preserve a leading BOM instead of silently normalizing the stored wire.
    // Strict JSON parsing will then reject it consistently with FS/runtime
    // readers, while valid UTF-8 remains replacement-free.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new R2RemediationDecodeError(kind);
  }
}

/** Account for one complete R2 list page before retaining any of its keys. */
export function accountR2RemediationInventoryPage(
  current: Readonly<R2RemediationInventoryUsage>,
  keys: readonly string[]
): R2RemediationInventoryUsage {
  const pages = current.pages + 1;
  if (pages > R2_REMEDIATION_INVENTORY_MAX_PAGES) {
    throw new R2RemediationResourceLimitError("inventory-pages");
  }

  const objects = current.objects + keys.length;
  if (!Number.isSafeInteger(objects) || objects > R2_REMEDIATION_INVENTORY_MAX_OBJECTS) {
    throw new R2RemediationResourceLimitError("inventory-objects");
  }

  let keyBytes = current.keyBytes;
  for (const key of keys) {
    keyBytes += utf8ByteLength(key);
    if (!Number.isSafeInteger(keyBytes) || keyBytes > R2_REMEDIATION_INVENTORY_MAX_KEY_BYTES) {
      throw new R2RemediationResourceLimitError("inventory-key-bytes");
    }
  }

  return { pages, objects, keyBytes };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
