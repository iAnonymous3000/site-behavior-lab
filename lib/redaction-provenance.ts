import { CANONICALIZATION_VERSION, publicReportDigest } from "./canonical-json";
import { REDACTION_VERSION } from "./redaction-v2";
import { REPORT_ID_PATTERN } from "./report-validation";

/**
 * Redaction provenance sidecars (RFC scan-report-v2 15.8). v1 wire is frozen,
 * so a report's redaction version is NEVER inferred from scan dates; managed
 * reports (the committed corpus and the R2 share store) get a sidecar with a
 * digest of the exact public bytes it vouches for.
 *
 * The contract this module encodes:
 * - A report matches its sidecar iff the recomputed canonical digest equals
 *   the stored one; anything else is UNKNOWN provenance and the report is
 *   treated as unremediated. Failure ordering (report first, sidecar second,
 *   no atomicity) therefore fails safe toward re-remediation.
 * - `createdAt`/`expiresAt` are the ORIGINAL clocks, copied verbatim through
 *   every rewrite; a sidecar never extends, restarts, or decides retention.
 * - Sidecar file names live OUTSIDE the report-id pattern
 *   (`<id>.provenance.json`), so report tooling never mistakes one for a
 *   report; a dangling sidecar (no report) is invalid.
 *
 * Pure module: callers own the storage IO (filesystem for the committed
 * corpus, the report-store backend for R2), this owns naming, entry
 * construction, and match verification.
 */

export type RedactionProvenanceEntry = {
  reportId: string;
  /** sha256 hex over the CANONICAL JSON of the public report (3.2 rules). */
  publicDigest: string;
  /** Versions the digesting itself. */
  canonicalizationVersion: string;
  /** The sanitizer that produced these bytes. */
  redactionVersion: number;
  /** Manifest write / remediation timestamp. */
  writtenAt: string;
  /** ORIGINAL creation, copied from the object; never the rewrite's clock. */
  createdAt: string;
  /** ORIGINAL expiry; null for committed reports, which never expire. */
  expiresAt: string | null;
};

/** Sidecar filename for a committed report id (outside the report-id pattern). */
export function committedSidecarFilename(reportId: string): string {
  return `${reportId}.provenance.json`;
}

/** Sidecar key beside an R2 report object key. */
export function r2SidecarKey(reportKey: string): string {
  return `${reportKey}.provenance.json`;
}

export function buildProvenanceEntry(input: {
  reportId: string;
  publicReport: unknown;
  writtenAt: string;
  createdAt: string;
  expiresAt: string | null;
  redactionVersion?: number;
}): RedactionProvenanceEntry {
  const entry: RedactionProvenanceEntry = {
    reportId: input.reportId,
    publicDigest: publicReportDigest(input.publicReport),
    canonicalizationVersion: CANONICALIZATION_VERSION,
    redactionVersion: input.redactionVersion ?? REDACTION_VERSION,
    writtenAt: input.writtenAt,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt
  };
  if (!isProvenanceEntry(entry)) {
    throw new Error("Invalid redaction provenance entry.");
  }
  return entry;
}

export type ProvenanceMatch =
  | { status: "matched"; entry: RedactionProvenanceEntry }
  | { status: "digest-mismatch"; entry: RedactionProvenanceEntry; recomputedDigest: string }
  | {
      status: "unknown";
      reason:
        | "no-sidecar"
        | "malformed-sidecar"
        | "report-id-mismatch"
        | "canonicalization-version-mismatch"
        | "redaction-version-mismatch";
    };

/**
 * Whether a stored report is vouched for by its sidecar. Any defect resolves
 * to UNKNOWN or mismatch, never to a false "remediated": that is the fail-safe
 * direction (re-remediate rather than trust).
 */
export function matchProvenance(publicReport: unknown, sidecar: unknown, expectedReportId: string): ProvenanceMatch {
  if (sidecar === null || sidecar === undefined) return { status: "unknown", reason: "no-sidecar" };
  if (!isProvenanceEntry(sidecar)) return { status: "unknown", reason: "malformed-sidecar" };
  if (!REPORT_ID_PATTERN.test(expectedReportId) || sidecar.reportId !== expectedReportId) {
    return { status: "unknown", reason: "report-id-mismatch" };
  }
  if (sidecar.canonicalizationVersion !== CANONICALIZATION_VERSION) {
    return { status: "unknown", reason: "canonicalization-version-mismatch" };
  }
  if (sidecar.redactionVersion !== REDACTION_VERSION) {
    return { status: "unknown", reason: "redaction-version-mismatch" };
  }
  const recomputedDigest = publicReportDigest(publicReport);
  if (recomputedDigest !== sidecar.publicDigest) {
    return { status: "digest-mismatch", entry: sidecar, recomputedDigest };
  }
  return { status: "matched", entry: sidecar };
}

export function isProvenanceEntry(value: unknown): value is RedactionProvenanceEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RedactionProvenanceEntry>;
  const keys = Object.keys(value);
  return (
    keys.length === 7 &&
    keys.every((key) => PROVENANCE_ENTRY_KEYS.has(key as keyof RedactionProvenanceEntry)) &&
    typeof entry.reportId === "string" &&
    REPORT_ID_PATTERN.test(entry.reportId) &&
    typeof entry.publicDigest === "string" &&
    /^[0-9a-f]{64}$/.test(entry.publicDigest) &&
    typeof entry.canonicalizationVersion === "string" &&
    typeof entry.redactionVersion === "number" &&
    Number.isInteger(entry.redactionVersion) &&
    entry.redactionVersion > 0 &&
    isCanonicalTimestamp(entry.writtenAt) &&
    isCanonicalTimestamp(entry.createdAt) &&
    (entry.expiresAt === null || isCanonicalTimestamp(entry.expiresAt)) &&
    Date.parse(entry.writtenAt) >= Date.parse(entry.createdAt) &&
    (entry.expiresAt === null || Date.parse(entry.expiresAt) > Date.parse(entry.createdAt))
  );
}

const PROVENANCE_ENTRY_KEYS = new Set<keyof RedactionProvenanceEntry>([
  "reportId",
  "publicDigest",
  "canonicalizationVersion",
  "redactionVersion",
  "writtenAt",
  "createdAt",
  "expiresAt"
]);

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
