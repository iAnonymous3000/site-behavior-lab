import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";

/**
 * Browser report reads are limited to the largest public r2 wire the active
 * producer may emit. Keeping this separate from the storage ceiling prevents
 * legacy capacity from becoming an accidental browser allocation budget.
 */
export const BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES =
  NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES;

/**
 * Server-side readers must retain compatibility with historical managed
 * reports, remediation input, and the retired Browser Run store.
 */
export const SERVER_STORED_REPORT_JSON_MAX_BYTES = 32 * 1024 * 1024;

/** Provenance sidecars are tiny, fixed-shape JSON; this is over 50x the current wire. */
export const SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES = 16 * 1024;

/** Immutable retention companions contain only two canonical timestamps. */
export const SERVER_STORED_RETENTION_METADATA_MAX_BYTES = 64 * 1024;

/** Generated static gallery index; bounded independently from report bodies. */
export const STATIC_REPORT_MANIFEST_JSON_MAX_BYTES = 32 * 1024 * 1024;

/** Generated aggregate corpus statistics control file. */
export const CORPUS_STATS_JSON_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Append-only publication transparency log. Every publication rewrites the
 * whole file under this one byte limit, and entries outlive the reports they
 * name, so the limit bounds the number of publications the log can ever
 * hold: the limit divided by the size of one pretty-printed entry (a few
 * hundred bytes each, digests and ids included), less the anchors, which
 * carry inline proof bytes and are separately capped per anchor. That is
 * tens of thousands of publications, not millions. Reaching it needs a
 * verifiable transition to a new log segment, which does not exist yet.
 */
export const TRANSPARENCY_LOG_JSON_MAX_BYTES = 16 * 1024 * 1024;
