import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publicReportDigest } from "./canonical-json";
import {
  appendTransparencyLogEntries,
  buildTransparencyLog,
  parseTransparencyLog,
  verifyTransparencyLogChain,
  type ParsedTransparencyLog,
  type TransparencyLogAddition
} from "./publication-transparency-log";
import { buildProvenanceEntry } from "./redaction-provenance";
import { buildStaticReportShare } from "./report-locator";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { sha256Hex } from "./sha256";
import { listStaticReportCandidateIds } from "./static-report-files";
import { anchorFromCalendarTimestamp } from "./transparency-log-anchoring";
import type { ScanResult } from "./types";

/**
 * Behavior tests for the reader-facing verifier, run as a subprocess because
 * that is how a reader runs it. A verifier is only worth publishing if it can
 * be shown to fail, so every check here pairs an honest bundle with a tampered
 * one.
 */

const root = process.cwd();
const cliPath = path.join(root, ".unit-test-dist", "lib", "verify-published-report-cli.js");
const reportsDir = path.join(root, "public", "reports");

function runCli(args: readonly string[], cwd = root) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function fixtureBundle(): Promise<{ dir: string; id: string }> {
  const ids = await listStaticReportCandidateIds(reportsDir);
  const id = ids[0];
  assert.ok(id, "the committed corpus must contain at least one report");
  const dir = mkdtempSync(path.join(tmpdir(), "verify-report-"));
  mkdirSync(dir, { recursive: true });
  for (const name of [`${id}.json`, `${id}.provenance.json`, "index.json"]) {
    copyFileSync(path.join(reportsDir, name), path.join(dir, name));
  }
  return { dir, id };
}

/**
 * Change a value the report already records, rather than adding a key.
 *
 * The tamper used to be `report.title = "TAMPERED"`, which works only because
 * `ids[0]` happens to be a v1 comparison today. On an r2 report `title` is not
 * a valid key at all, so the reader returns `invalid-report` and the assertion
 * on `digest-mismatch` fails -- the test would report a schema complaint while
 * claiming to prove that a changed VALUE breaks the digest. Those are different
 * guarantees, and only the second is what a reader verifying published bytes
 * depends on.
 *
 * `summary.durationMs` exists on every schema this repo publishes, under
 * whichever run wrapper that schema uses, so editing it keeps the document
 * structurally valid and moves only the bytes.
 */
function tamperRecordedValue(report: Record<string, unknown>): void {
  const runs = ["run", "baseline", "variant"]
    .map((key) => report[key])
    .filter((run): run is Record<string, unknown> => isRecord(run));
  const summaries = [report, ...runs]
    .map((holder) => holder.summary)
    .filter((summary): summary is Record<string, unknown> => isRecord(summary));
  const target = summaries.find((summary) => typeof summary.durationMs === "number");
  assert.ok(
    target,
    "no summary.durationMs to tamper; pick another recorded value that exists on this schema rather than adding a key"
  );
  target!.durationMs = (target!.durationMs as number) + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("an untampered committed bundle verifies and exits zero", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Verified: these bytes are exactly what this project published/);
    assert.doesNotMatch(result.stdout, /FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed recorded value fails both the index and the canonical digest", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    const reportPath = path.join(dir, `${id}.json`);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    tamperRecordedValue(report);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /NOT VERIFIED/);
    assert.match(result.stdout, /FAIL {2}wire digest vs published index/);
    assert.match(result.stdout, /FAIL {2}managed report validation\s+digest-mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a whitespace-only edit still fails, because the index pins exact bytes", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    // Canonicalization is deliberately whitespace-insensitive, so the sidecar
    // digest still matches here. That is exactly why the published index is
    // checked independently: without it, a reformatted republish would pass.
    const reportPath = path.join(dir, `${id}.json`);
    writeFileSync(reportPath, `${readFileSync(reportPath, "utf8")}\n`);

    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}wire digest vs published index/);
    assert.match(result.stdout, /ok {4}canonical digest vs sidecar/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a report absent from the published index is reported, not silently accepted", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    writeFileSync(path.join(dir, "index.json"), JSON.stringify({ generatedAt: "", reports: [] }));
    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /not listed in reports\/index\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a full report URL is accepted, since that is what a reader has in hand", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    const result = runCli([`https://sitebehavior.org/reports/${id}/`, "--from", dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`Verifying ${id}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed ids, unknown options, and unsafe origins are refused before any read", () => {
  const badId = runCli(["not-a-report-id", "--from", reportsDir]);
  assert.equal(badId.status, 1);
  assert.match(badId.stderr, /is not a report id/);

  const unknownOption = runCli(["--wat"]);
  assert.equal(unknownOption.status, 1);
  assert.match(unknownOption.stderr, /Unknown option/);

  const noArgs = runCli([]);
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /Usage/);

  const insecureOrigin = runCli([`20260101-${"a".repeat(32)}`, "--origin", "http://example.test"]);
  assert.equal(insecureOrigin.status, 1);
  assert.match(insecureOrigin.stderr, /must be https/);
});

test("a rewritten sidecar clock still verifies, so the boundary must name the sidecar timestamps", async () => {
  // The transparency log binds the report bytes and the canonical digest only,
  // and the CLI feeds the reader a retention clock copied from the same
  // sidecar, so createdAt/writtenAt verify against themselves. That is a
  // documented boundary of the one-command path, not a chain break; the
  // verdict is honest only while the closing output says so.
  const { dir, id } = await fixtureBundle();
  try {
    const sidecarPath = path.join(dir, `${id}.provenance.json`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
    assert.equal(typeof sidecar.createdAt, "string");
    sidecar.createdAt = "2025-01-01T00:00:00.000Z";
    sidecar.writtenAt = "2025-01-01T00:00:00.000Z";
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Verified: these bytes are exactly what this project published/);
    assert.match(result.stdout, /This command does not prove:[\s\S]*the sidecar's own timestamps \(createdAt, writtenAt\)/);
    assert.match(result.stdout, /sidecar bytes are bound only by the CI evidence manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the boundary is printed on success as well as failure", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    // A verifier that prints only "verified" invites the reading that
    // everything about the report is settled. The limits ship with the result.
    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /This command does not prove:/);
    assert.match(result.stdout, /describe what the site actually did/);
    assert.match(result.stdout, /Sigstore attestation/);
    assert.match(result.stdout, /coverage-boundary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a report later removed for privacy verifies against the log and says it was removed", () => {
  // A reader's saved evidence package of a report the ledger later removed
  // for privacy: the current sanitizer changes it (that is why it was
  // removed), and the published index no longer lists it. The log still
  // records its digest, so it is verified published evidence, not tampering.
  const originalId = "20260709-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const replacementId = "20260709-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const original: ScanResult = {
    ...(makeScanReportV1() as ScanResult),
    share: buildStaticReportShare(originalId),
    privacyPolicy: {
      url: "https://example.com/privacy",
      claims: [{ kind: "honors-gpc", quote: "We honor GPC; email privacy@example.com with questions." }],
      mentionedEntities: [],
      unmentionedEntities: [],
      policyTextLength: 1_000
    }
  };
  const wire = `${JSON.stringify(original, null, 2)}\n`;
  const sidecar = buildProvenanceEntry({
    reportId: originalId,
    publicReport: original,
    writtenAt: "2026-07-09T12:00:00.000Z",
    createdAt: original.conditions.scannedAt,
    expiresAt: null
  });
  const clone = mkdtempSync(path.join(tmpdir(), "verify-report-clone-"));
  const evidence = mkdtempSync(path.join(tmpdir(), "verify-report-removed-"));
  try {
    mkdirSync(path.join(clone, "public"), { recursive: true });
    writeFileSync(path.join(evidence, `${originalId}.json`), wire);
    writeFileSync(path.join(evidence, `${originalId}.provenance.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
    writeFileSync(path.join(evidence, "index.json"), `${JSON.stringify({ reports: [] })}\n`);
    const log = buildTransparencyLog(appendTransparencyLogEntries([], [
      { reportId: originalId, reportWireSha256: sha256Hex(wire), publicDigest: sidecar.publicDigest }
    ]));
    writeFileSync(path.join(clone, "public", "transparency-log.json"), `${JSON.stringify(log, null, 2)}\n`);
    const ledger = (entries: object[]) => `${JSON.stringify({
      $schema: "https://sitebehavior.org/corrections.schema.json",
      schemaVersion: 1,
      policy: "https://sitebehavior.org/corrections/",
      entries
    }, null, 2)}\n`;
    const removal = {
      eventId: "SBL-CORR-2026-001",
      publishedAt: "2026-07-10T12:00:00.000Z",
      state: "privacy-superseded",
      reportIds: [originalId],
      replacementReportIds: [replacementId],
      summary: "A redacted copy replaced a report that published a contact address.",
      detailsUrl: "https://sitebehavior.org/corrections/privacy-replacement/"
    };

    // Without the ledger event the same bytes fail, as any report that is not
    // a fixed point of the sanitizer and not in the index must.
    writeFileSync(path.join(clone, "public", "corrections.json"), ledger([]));
    const unexplained = runCli([originalId, "--from", evidence], clone);
    assert.equal(unexplained.status, 1, unexplained.stdout + unexplained.stderr);
    assert.match(unexplained.stdout, /FAIL\s+managed report validation\s+redaction-not-idempotent/);
    assert.match(unexplained.stdout, /NOT VERIFIED/);

    writeFileSync(path.join(clone, "public", "corrections.json"), ledger([removal]));
    const removed = runCli([originalId, "--from", evidence], clone);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.doesNotMatch(removed.stdout, /FAIL/);
    assert.match(removed.stdout, /wire digest vs published index\s+not listed: SBL-CORR-2026-001 removed this report for privacy/);
    assert.match(removed.stdout, /wire digest vs transparency log\s+entry 0 of 1/);
    assert.match(removed.stdout, new RegExp(`Removed for privacy: SBL-CORR-2026-001 replaced this report with a redacted copy,\\s+${replacementId}`));
    assert.match(removed.stdout, /See https:\/\/sitebehavior\.org\/corrections\/privacy-replacement\//);
    assert.match(removed.stdout, /Verified: these bytes are exactly what this project published/);

    // The explanation never excuses changed bytes.
    writeFileSync(path.join(evidence, `${originalId}.json`), wire.replace("privacy@example.com", "privacy@example.org"));
    const tampered = runCli([originalId, "--from", evidence], clone);
    assert.equal(tampered.status, 1);
    assert.match(tampered.stdout, /FAIL\s+managed report validation\s+digest-mismatch/);
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
});

// The witness of an entry, and the exit status of each verdict.
//
// These build their own log beside a committed bundle instead of reading the
// committed log's anchors. Whether a committed report sits beneath an anchor
// changes every time an anchor proposal merges, and "after the newest anchored
// head" is an empty set the day one does.

const PENDING_ATTESTATION_TAG = [0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e];
const BITCOIN_ATTESTATION_TAG = [0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01];

/** Bytes shaped like a calendar reply: an append op, then one attestation tag and a URI. */
function calendarReply(kind: "pending" | "bitcoin"): Uint8Array {
  const uri = new TextEncoder().encode("https://calendar.example");
  return Uint8Array.from([
    0xf0,
    0x10,
    ...(kind === "pending" ? PENDING_ATTESTATION_TAG : BITCOIN_ATTESTATION_TAG),
    uri.length,
    ...uri
  ]);
}

function filler(index: number): TransparencyLogAddition {
  return {
    reportId: `20260101-${String(index).padStart(32, "0")}`,
    reportWireSha256: "a".repeat(64),
    publicDigest: "b".repeat(64)
  };
}

/** A log with `before` unrelated entries, then the bundle's own entry, then `after` more. */
function logAround(
  own: TransparencyLogAddition,
  shape: { before: number; after: number; anchors: readonly { entryCount: number; kind: "pending" | "bitcoin" }[] }
): ParsedTransparencyLog {
  const entries = appendTransparencyLogEntries([], [
    ...Array.from({ length: shape.before }, (_, index) => filler(index)),
    own,
    ...Array.from({ length: shape.after }, (_, index) => filler(shape.before + index))
  ]);
  return buildTransparencyLog(
    entries,
    shape.anchors.map((anchor) =>
      anchorFromCalendarTimestamp(anchor.entryCount, entries[anchor.entryCount - 1].entryDigest, calendarReply(anchor.kind))
    )
  );
}

/** The log entry the bundle in `dir` earns as it stands on disk. */
function ownEntry(dir: string, id: string): TransparencyLogAddition {
  const sidecar = JSON.parse(readFileSync(path.join(dir, `${id}.provenance.json`), "utf8")) as { publicDigest: string };
  return {
    reportId: id,
    reportWireSha256: sha256Hex(readFileSync(path.join(dir, `${id}.json`), "utf8")),
    publicDigest: sidecar.publicDigest
  };
}

/** A working directory holding only `public/transparency-log.json`, as a clone would. */
function cloneWithLog(log: ParsedTransparencyLog | null): string {
  const clone = mkdtempSync(path.join(tmpdir(), "verify-report-clone-"));
  mkdirSync(path.join(clone, "public"), { recursive: true });
  if (log) writeFileSync(path.join(clone, "public", "transparency-log.json"), `${JSON.stringify(log, null, 2)}\n`);
  return clone;
}

/**
 * Rewrite a published report the way an operator who controls every file
 * could: change a recorded value, then recompute the sidecar digest and the
 * index row so the bundle agrees with itself again.
 */
function rewriteBundleConsistently(dir: string, id: string): void {
  const reportPath = path.join(dir, `${id}.json`);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
  tamperRecordedValue(report);
  const wire = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, wire);

  const sidecarPath = path.join(dir, `${id}.provenance.json`);
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
  sidecar.publicDigest = publicReportDigest(report);
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  const indexPath = path.join(dir, "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as { reports: Record<string, unknown>[] };
  const row = index.reports.find((candidate) => candidate.id === id);
  assert.ok(row, "the fixture index must list the fixture report");
  row.reportWireSha256 = sha256Hex(wire);
  row.reportWireBytes = Buffer.byteLength(wire);
  writeFileSync(indexPath, JSON.stringify(index));
}

test("an entry beneath an anchored head names the anchor, says the proof was only opened, and exits zero", async () => {
  const { dir, id } = await fixtureBundle();
  const log = logAround(ownEntry(dir, id), { before: 1, after: 1, anchors: [{ entryCount: 2, kind: "pending" }] });
  const clone = cloneWithLog(log);
  try {
    const result = runCli([id, "--from", dir], clone);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Verified: these bytes are exactly what this project published/);
    assert.match(result.stdout, /External witness: entry 1 lies beneath the head at 2 entries, which anchors\[0\] names\./);
    assert.match(result.stdout, /holds a calendar's pending promise and no Bitcoin attestation yet/);
    assert.match(result.stdout, /structural reading: this command opened the proof and did not replay it/);
    assert.match(result.stdout, /jq -r '\.anchors\[0\]\.proof' public\/transparency-log\.json \| base64 -d > head\.ots/);
    assert.match(result.stdout, /ots upgrade head\.ots/);
    assert.match(result.stdout, new RegExp(`ots verify -d ${log.anchors[0].head} head\\.ots`));
    assert.doesNotMatch(result.stdout, /No external witness/);
    // Whether the log was only ever appended to is a property of two
    // revisions of it. This command reads one and must not vouch for it.
    assert.doesNotMatch(result.stdout, /append-only/);
    assert.match(
      result.stdout,
      /This command does not prove:[\s\S]*that the transparency log in this working directory is this project's log, unaltered\./
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("a Bitcoin-attested anchor over the entry is reported ahead of a pending one", async () => {
  const { dir, id } = await fixtureBundle();
  const log = logAround(ownEntry(dir, id), {
    before: 1,
    after: 1,
    anchors: [
      { entryCount: 2, kind: "pending" },
      { entryCount: 3, kind: "bitcoin" }
    ]
  });
  const clone = cloneWithLog(log);
  try {
    const result = runCli([id, "--from", dir], clone);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /External witness: entry 1 lies beneath the head at 3 entries, which anchors\[1\] names\./);
    assert.match(result.stdout, /commits to that head and holds a Bitcoin attestation\./);
    assert.match(result.stdout, new RegExp(`ots verify -d ${log.anchors[1].head} head\\.ots`));
    // There is nothing to upgrade once the attestation is in the stored proof.
    assert.doesNotMatch(result.stdout, /ots upgrade/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("an entry after the newest anchored head verifies and says it has no external witness", async () => {
  const { dir, id } = await fixtureBundle();
  const log = logAround(ownEntry(dir, id), { before: 1, after: 1, anchors: [{ entryCount: 1, kind: "pending" }] });
  const clone = cloneWithLog(log);
  try {
    const result = runCli([id, "--from", dir], clone);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Verified: these bytes are exactly what this project published/);
    assert.match(result.stdout, /No external witness yet: entry 1 is after the newest anchored head \(1 entries\),/);
    assert.match(result.stdout, /nothing outside this log file bounds when it was written/);
    assert.doesNotMatch(result.stdout, /External witness: entry/);
    assert.doesNotMatch(result.stdout, /ots verify/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("a rewritten log with its anchors removed cannot read like an anchored one", async () => {
  // Nothing in one log file can show that it was rewritten end to end. What
  // the output can do is refuse to describe the result as witnessed: the
  // genuine log places this entry beneath an anchor, the rewrite cannot.
  const { dir, id } = await fixtureBundle();
  const shape = { before: 1, after: 1, anchors: [{ entryCount: 3, kind: "pending" as const }] };
  const genuine = cloneWithLog(logAround(ownEntry(dir, id), shape));
  let forged: string | null = null;
  try {
    const honest = runCli([id, "--from", dir], genuine);
    assert.equal(honest.status, 0, honest.stdout + honest.stderr);
    assert.match(honest.stdout, /External witness: entry 1 lies beneath the head at 3 entries/);

    rewriteBundleConsistently(dir, id);
    const stale = runCli([id, "--from", dir], genuine);
    assert.equal(stale.status, 1, "the genuine log must refuse the rewritten bytes");

    forged = cloneWithLog(logAround(ownEntry(dir, id), { ...shape, anchors: [] }));
    const result = runCli([id, "--from", dir], forged);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /FAIL/);
    assert.match(result.stdout, /No external witness yet: this log holds no anchor,/);
    assert.match(result.stdout, /bounds when entry 1 was written/);
    assert.doesNotMatch(result.stdout, /External witness: entry/);
    assert.doesNotMatch(result.stdout, /append-only/);
    assert.match(result.stdout, /that the transparency log in this working directory is this project's log, unaltered\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(genuine, { recursive: true, force: true });
    if (forged) rmSync(forged, { recursive: true, force: true });
  }
});

test("a rewritten log whose anchor rows were pointed at the new heads is refused", async () => {
  const { dir, id } = await fixtureBundle();
  const shape = { before: 1, after: 1, anchors: [{ entryCount: 3, kind: "pending" as const }] };
  const genuineLog = logAround(ownEntry(dir, id), shape);
  let forged: string | null = null;
  try {
    rewriteBundleConsistently(dir, id);
    const rechained = logAround(ownEntry(dir, id), { ...shape, anchors: [] });
    // Keep every anchor row and its proof bytes; only repoint `head`.
    const forgedLog = buildTransparencyLog(
      rechained.entries,
      genuineLog.anchors.map((anchor) => ({ ...anchor, head: rechained.entries[anchor.entryCount - 1].entryDigest }))
    );
    assert.notEqual(forgedLog.anchors[0].head, genuineLog.anchors[0].head);
    // The parser and the chain accept this log: an anchor row is only held to
    // name a head the chain reached. Opening the proof is the one check left.
    assert.doesNotThrow(() => verifyTransparencyLogChain(parseTransparencyLog(JSON.parse(JSON.stringify(forgedLog)))));

    forged = cloneWithLog(forgedLog);
    const result = runCli([id, "--from", dir], forged);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /NOT VERIFIED/);
    assert.match(
      result.stdout,
      /FAIL {2}wire digest vs transparency log\s+the committed log is unusable: anchors\[0\] does not hold a proof for the head it names/
    );
    assert.doesNotMatch(result.stdout, /Verified: these bytes/);
    // A log that cannot be used is not a log that lacks this id.
    assert.doesNotMatch(result.stdout, /contains this report id/);
    assert.match(result.stdout, /could not be used as a chain/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (forged) rmSync(forged, { recursive: true, force: true });
  }
});

test("a consistent bundle that nothing vouched for exits 2, apart from verified and from failed", async () => {
  // A script reads the status. An altered report with a recomputed sidecar is
  // consistent with itself, so "Consistent" may not share a status with
  // "Verified".
  const { dir, id } = await fixtureBundle();
  const noLog = cloneWithLog(null);
  const otherLog = cloneWithLog(buildTransparencyLog(appendTransparencyLogEntries([], [filler(0), filler(1)])));
  try {
    rewriteBundleConsistently(dir, id);

    const withoutLog = runCli([id, "--from", dir], noLog);
    assert.equal(withoutLog.status, 2, withoutLog.stdout + withoutLog.stderr);
    assert.doesNotMatch(withoutLog.stdout, /FAIL/);
    assert.match(withoutLog.stdout, /Consistent: these bytes agree with the provenance sidecar and manifest/);
    assert.match(withoutLog.stdout, /Provenance is NOT established/);
    assert.doesNotMatch(withoutLog.stdout, /Verified: these bytes/);
    assert.match(withoutLog.stdout, /Nothing above cross-checked an independent record/);

    const notListed = runCli([id, "--from", dir], otherLog);
    assert.equal(notListed.status, 2, notListed.stdout + notListed.stderr);
    assert.match(notListed.stdout, /not checked: this id is not in the committed chain/);
    assert.match(notListed.stdout, /Consistent: these bytes agree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(noLog, { recursive: true, force: true });
    rmSync(otherLog, { recursive: true, force: true });
  }
});

test("a cross-check that ran and failed is not followed by advice to find a log that lists the id", async () => {
  const { dir, id } = await fixtureBundle();
  const clone = cloneWithLog(logAround(ownEntry(dir, id), { before: 0, after: 0, anchors: [] }));
  try {
    const reportPath = path.join(dir, `${id}.json`);
    writeFileSync(reportPath, `${readFileSync(reportPath, "utf8")}\n`);

    const result = runCli([id, "--from", dir], clone);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}wire digest vs transparency log\s+the chain recorded [0-9a-f]{64}, these bytes are [0-9a-f]{64}/);
    assert.doesNotMatch(result.stdout, /Nothing above cross-checked an independent record/);
    assert.doesNotMatch(result.stdout, /contains this report id/);
    assert.match(result.stdout, /that the transparency log in this working directory is this project's log, unaltered\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("against the committed log, the verdict states this entry's witness as the log's own anchors give it", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    const log = parseTransparencyLog(
      JSON.parse(readFileSync(path.join(root, "public", "transparency-log.json"), "utf8")) as unknown
    );
    const entry = log.entries.find((candidate) => candidate.reportId === id);
    assert.ok(entry, "the committed log must record the fixture report");
    const beneath = log.anchors.some((anchor) => anchor.entryCount > entry.sequence);

    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    if (beneath) {
      assert.match(result.stdout, new RegExp(`External witness: entry ${entry.sequence} lies beneath the head at \\d+ entries`));
      assert.doesNotMatch(result.stdout, /No external witness/);
    } else {
      assert.match(result.stdout, new RegExp(`No external witness yet: (this log holds no anchor|entry ${entry.sequence} is after)`));
      assert.doesNotMatch(result.stdout, /External witness: entry/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
