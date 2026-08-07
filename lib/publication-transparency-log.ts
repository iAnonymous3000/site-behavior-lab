import { canonicalJson } from "./canonical-json";
import { REPORT_ID_PATTERN } from "./report-validation";
import { sha256Hex } from "./sha256";

/**
 * The publication transparency log: an append-only hash chain over every
 * report this project has ever published.
 *
 * WHAT IT PROVES. Each entry commits to the entry before it, so the single
 * `head` digest commits to the entire publication history. Re-editing any
 * published report changes its digests, which changes that entry, which
 * changes every entry after it and the head. The chain is self-contained:
 * anyone can recompute it from the log alone, offline, with no access to this
 * repository and no trust in its operator.
 *
 * WHAT IT DOES NOT PROVE, AND WHY THAT MATTERS. A hash chain proves ORDER and
 * INTEGRITY. On its own it proves nothing about WHEN, because the party that
 * can rewrite the chain can also rewrite it consistently. Existence at a point
 * in time requires an external witness that we cannot forge, which is what
 * `anchors` carries. Anchors are OpenTimestamps proofs over chain heads,
 * produced by transparency-log-anchor-cli and committed with the log; while
 * the array is empty the honest claim is exactly "append-only and internally
 * consistent, corroborated by public Git history", and no published copy may
 * say more than that. The seam is validated rather than speculative: an
 * anchor whose head does not match the chain at its own entry count is
 * rejected here, and a freshly minted proof that does not commit to our head
 * is rejected before it can ever be stored.
 *
 * ENTRY ORDER IS PUBLICATION ORDER, NOT ID ORDER. Sorting by report id would
 * look tidier, but back-filling one older report would then insert into the
 * middle and rewrite every digest after it, turning a legitimate publication
 * into a history-gate failure. The log's own order is authoritative, and the
 * generator only ever appends.
 *
 * ENTRIES OUTLIVE THEIR REPORTS. Retention prunes reports; the log keeps their
 * entries forever. An entry records that something WAS published, not that it
 * is still served. Chain verification is therefore always self-contained,
 * while cross-checking against present bundles applies only to entries whose
 * bundles are still committed.
 */

export const TRANSPARENCY_LOG_SCHEMA = "https://sitebehavior.org/transparency-log.schema.json";

/**
 * Names both the hash and the serialization that feed it. It is part of every
 * entry preimage, so changing either rule is a new algorithm identity rather
 * than a silent redefinition of what existing digests meant.
 */
export const TRANSPARENCY_LOG_CHAIN_ALGORITHM = "sha256-canon-v1";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const ANCHOR_PROOF_TYPES = new Set(["opentimestamps"]);
export const TRANSPARENCY_LOG_MAX_ANCHOR_PROOF_CHARS = 64 * 1024;

const LOG_KEYS = new Set([
  "$schema",
  "schemaVersion",
  "chainAlgorithm",
  "entryCount",
  "head",
  "entries",
  "anchors"
]);
const ENTRY_KEYS = new Set(["sequence", "reportId", "reportWireSha256", "publicDigest", "entryDigest"]);
const ANCHOR_KEYS = new Set(["entryCount", "head", "proofType", "proof"]);

export interface TransparencyLogEntry {
  readonly sequence: number;
  readonly reportId: string;
  /** sha256 of the exact published report wire bytes, as `index.json` records. */
  readonly reportWireSha256: string;
  /** Canonical (canon-v1) digest from the report's provenance sidecar. */
  readonly publicDigest: string;
  readonly entryDigest: string;
}

/**
 * An external existence proof over a chain head. Empty until a witness is
 * actually obtained; see the module docblock for why that emptiness is load
 * bearing rather than an oversight.
 */
export interface TransparencyLogAnchor {
  readonly entryCount: number;
  readonly head: string;
  readonly proofType: "opentimestamps";
  /** Base64 proof bytes, kept inline so the log stays self-contained. */
  readonly proof: string;
}

export interface ParsedTransparencyLog {
  readonly $schema: typeof TRANSPARENCY_LOG_SCHEMA;
  readonly schemaVersion: 1;
  readonly chainAlgorithm: typeof TRANSPARENCY_LOG_CHAIN_ALGORITHM;
  readonly entryCount: number;
  readonly head: string | null;
  readonly entries: readonly TransparencyLogEntry[];
  readonly anchors: readonly TransparencyLogAnchor[];
}

export interface TransparencyLogAddition {
  readonly reportId: string;
  readonly reportWireSha256: string;
  readonly publicDigest: string;
}

/**
 * The preimage binds the algorithm identity, the predecessor, the position,
 * and both published digests. `previousEntryDigest` is null only at sequence
 * zero, so a chain cannot be silently re-rooted at a later entry.
 */
export function transparencyLogEntryDigest(input: {
  readonly previousEntryDigest: string | null;
  readonly sequence: number;
  readonly reportId: string;
  readonly reportWireSha256: string;
  readonly publicDigest: string;
}): string {
  return sha256Hex(
    canonicalJson({
      chainAlgorithm: TRANSPARENCY_LOG_CHAIN_ALGORITHM,
      previousEntryDigest: input.previousEntryDigest,
      sequence: input.sequence,
      reportId: input.reportId,
      reportWireSha256: input.reportWireSha256,
      publicDigest: input.publicDigest
    })
  );
}

/** Chain new publications onto an existing prefix. Never reorders or rewrites. */
export function appendTransparencyLogEntries(
  existing: readonly TransparencyLogEntry[],
  additions: readonly TransparencyLogAddition[]
): TransparencyLogEntry[] {
  const entries = [...existing];
  const known = new Set(entries.map((entry) => entry.reportId));
  for (const addition of additions) {
    if (known.has(addition.reportId)) continue;
    known.add(addition.reportId);
    const sequence = entries.length;
    const previousEntryDigest = sequence === 0 ? null : entries[sequence - 1].entryDigest;
    entries.push({
      sequence,
      reportId: addition.reportId,
      reportWireSha256: addition.reportWireSha256,
      publicDigest: addition.publicDigest,
      entryDigest: transparencyLogEntryDigest({
        previousEntryDigest,
        sequence,
        reportId: addition.reportId,
        reportWireSha256: addition.reportWireSha256,
        publicDigest: addition.publicDigest
      })
    });
  }
  return entries;
}

/** Assemble the published wire object. `head` is derived, never asserted. */
export function buildTransparencyLog(
  entries: readonly TransparencyLogEntry[],
  anchors: readonly TransparencyLogAnchor[] = []
): ParsedTransparencyLog {
  return {
    $schema: TRANSPARENCY_LOG_SCHEMA,
    schemaVersion: 1,
    chainAlgorithm: TRANSPARENCY_LOG_CHAIN_ALGORITHM,
    entryCount: entries.length,
    head: entries.length === 0 ? null : entries[entries.length - 1].entryDigest,
    entries: [...entries],
    anchors: [...anchors]
  };
}

/** Strict structural parse. Every unknown key is a refusal, never ignored. */
export function parseTransparencyLog(value: unknown): ParsedTransparencyLog {
  const log = exactRecord(value, LOG_KEYS, "log");
  if (log.$schema !== TRANSPARENCY_LOG_SCHEMA) throw new Error("$schema is not the canonical transparency-log schema URL");
  if (log.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (log.chainAlgorithm !== TRANSPARENCY_LOG_CHAIN_ALGORITHM) {
    throw new Error(`chainAlgorithm must be ${TRANSPARENCY_LOG_CHAIN_ALGORITHM}`);
  }
  if (!Array.isArray(log.entries)) throw new Error("entries must be an array");
  if (!Array.isArray(log.anchors)) throw new Error("anchors must be an array");

  const seenReportIds = new Set<string>();
  const entries: TransparencyLogEntry[] = log.entries.map((candidate, index) => {
    const label = `entries[${index}]`;
    const entry = exactRecord(candidate, ENTRY_KEYS, label);
    if (entry.sequence !== index) throw new Error(`${label}.sequence must equal its position ${index}`);
    const reportId = requiredPattern(entry.reportId, REPORT_ID_PATTERN, `${label}.reportId`);
    if (seenReportIds.has(reportId)) throw new Error(`${label}.reportId duplicates ${reportId}`);
    seenReportIds.add(reportId);
    return {
      sequence: index,
      reportId,
      reportWireSha256: requiredPattern(entry.reportWireSha256, SHA256_HEX_PATTERN, `${label}.reportWireSha256`),
      publicDigest: requiredPattern(entry.publicDigest, SHA256_HEX_PATTERN, `${label}.publicDigest`),
      entryDigest: requiredPattern(entry.entryDigest, SHA256_HEX_PATTERN, `${label}.entryDigest`)
    };
  });

  if (log.entryCount !== entries.length) throw new Error("entryCount must equal the number of entries");
  const expectedHead = entries.length === 0 ? null : entries[entries.length - 1].entryDigest;
  if (log.head !== expectedHead) throw new Error("head must be the last entry digest, or null for an empty log");

  const anchors: TransparencyLogAnchor[] = log.anchors.map((candidate, index) => {
    const label = `anchors[${index}]`;
    const anchor = exactRecord(candidate, ANCHOR_KEYS, label);
    const entryCount = anchor.entryCount;
    if (!Number.isSafeInteger(entryCount) || (entryCount as number) < 1) {
      throw new Error(`${label}.entryCount must be a positive safe integer`);
    }
    const proofType = anchor.proofType;
    if (typeof proofType !== "string" || !ANCHOR_PROOF_TYPES.has(proofType)) {
      throw new Error(`${label}.proofType is not a supported proof type`);
    }
    const proof = requiredString(anchor.proof, `${label}.proof`);
    if (proof.length > TRANSPARENCY_LOG_MAX_ANCHOR_PROOF_CHARS) throw new Error(`${label}.proof exceeds the proof size ceiling`);
    if (!BASE64_PATTERN.test(proof)) throw new Error(`${label}.proof must be base64`);
    return {
      entryCount: entryCount as number,
      head: requiredPattern(anchor.head, SHA256_HEX_PATTERN, `${label}.head`),
      proofType: proofType as "opentimestamps",
      proof
    };
  });

  return {
    $schema: TRANSPARENCY_LOG_SCHEMA,
    schemaVersion: 1,
    chainAlgorithm: TRANSPARENCY_LOG_CHAIN_ALGORITHM,
    entryCount: entries.length,
    head: expectedHead,
    entries,
    anchors
  };
}

/**
 * Recompute the whole chain. This is the check a third party runs, so it must
 * depend on nothing but the log itself.
 */
export function verifyTransparencyLogChain(log: ParsedTransparencyLog): void {
  let previousEntryDigest: string | null = null;
  for (const entry of log.entries) {
    const expected = transparencyLogEntryDigest({
      previousEntryDigest,
      sequence: entry.sequence,
      reportId: entry.reportId,
      reportWireSha256: entry.reportWireSha256,
      publicDigest: entry.publicDigest
    });
    if (expected !== entry.entryDigest) {
      throw new Error(
        `Transparency log entry ${entry.sequence} (${entry.reportId}) has digest ${entry.entryDigest} but the chain computes ${expected}`
      );
    }
    previousEntryDigest = entry.entryDigest;
  }

  for (const [index, anchor] of log.anchors.entries()) {
    if (anchor.entryCount > log.entries.length) {
      throw new Error(`anchors[${index}] attests to ${anchor.entryCount} entries but the log holds ${log.entries.length}`);
    }
    const anchoredHead = log.entries[anchor.entryCount - 1].entryDigest;
    if (anchor.head !== anchoredHead) {
      throw new Error(
        `anchors[${index}] attests to head ${anchor.head} but the chain head at ${anchor.entryCount} entries is ${anchoredHead}`
      );
    }
  }
}

/**
 * Append-only enforcement across a revision boundary. The published prefix is
 * immutable: entries may be added, never removed, reordered, or edited.
 * Anchors are prefix-immutable for the same reason, since a witness that can
 * be withdrawn witnesses nothing.
 */
export function assertTransparencyLogHistory(previousValue: unknown, currentValue: unknown): void {
  const previous = parseTransparencyLog(previousValue);
  const current = parseTransparencyLog(currentValue);
  verifyTransparencyLogChain(current);

  if (current.entries.length < previous.entries.length) {
    throw new Error("Transparency log entries were removed; history must be an unchanged prefix");
  }
  for (const [index, previousEntry] of previous.entries.entries()) {
    const currentEntry = current.entries[index];
    if (
      previousEntry.reportId !== currentEntry.reportId ||
      previousEntry.reportWireSha256 !== currentEntry.reportWireSha256 ||
      previousEntry.publicDigest !== currentEntry.publicDigest ||
      previousEntry.entryDigest !== currentEntry.entryDigest
    ) {
      throw new Error(`Transparency log entries[${index}] changed; history must be an unchanged prefix`);
    }
  }

  if (current.anchors.length < previous.anchors.length) {
    throw new Error("Transparency log anchors were removed; published witnesses are immutable");
  }
  for (const [index, previousAnchor] of previous.anchors.entries()) {
    const currentAnchor = current.anchors[index];
    if (
      previousAnchor.entryCount !== currentAnchor.entryCount ||
      previousAnchor.head !== currentAnchor.head ||
      previousAnchor.proofType !== currentAnchor.proofType ||
      previousAnchor.proof !== currentAnchor.proof
    ) {
      throw new Error(`Transparency log anchors[${index}] changed; published witnesses are immutable`);
    }
  }
}

function exactRecord(value: unknown, allowedKeys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
  return record;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredPattern(value: unknown, pattern: RegExp, label: string): string {
  const text = requiredString(value, label);
  if (!pattern.test(text)) throw new Error(`${label} has an invalid format`);
  return text;
}
