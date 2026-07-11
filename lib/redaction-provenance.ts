import { CANONICALIZATION_VERSION, publicReportDigest } from "./canonical-json";
import { REDACTION_VERSION } from "./redaction-v2";

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
  return {
    reportId: input.reportId,
    publicDigest: publicReportDigest(input.publicReport),
    canonicalizationVersion: CANONICALIZATION_VERSION,
    redactionVersion: input.redactionVersion ?? REDACTION_VERSION,
    writtenAt: input.writtenAt,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt
  };
}

export type ProvenanceMatch =
  | { status: "matched"; entry: RedactionProvenanceEntry }
  | { status: "digest-mismatch"; entry: RedactionProvenanceEntry; recomputedDigest: string }
  | { status: "unknown"; reason: "no-sidecar" | "malformed-sidecar" | "canonicalization-version-mismatch" };

/**
 * Whether a stored report is vouched for by its sidecar. Any defect resolves
 * to UNKNOWN or mismatch, never to a false "remediated": that is the fail-safe
 * direction (re-remediate rather than trust).
 */
export function matchProvenance(publicReport: unknown, sidecar: unknown): ProvenanceMatch {
  if (!isProvenanceEntry(sidecar)) return { status: "unknown", reason: "malformed-sidecar" };
  if (sidecar.canonicalizationVersion !== CANONICALIZATION_VERSION) {
    return { status: "unknown", reason: "canonicalization-version-mismatch" };
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
  return (
    typeof entry.reportId === "string" &&
    typeof entry.publicDigest === "string" &&
    /^[0-9a-f]{64}$/.test(entry.publicDigest) &&
    typeof entry.canonicalizationVersion === "string" &&
    typeof entry.redactionVersion === "number" &&
    Number.isInteger(entry.redactionVersion) &&
    typeof entry.writtenAt === "string" &&
    typeof entry.createdAt === "string" &&
    (entry.expiresAt === null || typeof entry.expiresAt === "string")
  );
}
