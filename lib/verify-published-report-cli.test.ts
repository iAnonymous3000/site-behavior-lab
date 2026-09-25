import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendTransparencyLogEntries, buildTransparencyLog } from "./publication-transparency-log";
import { buildProvenanceEntry } from "./redaction-provenance";
import { buildStaticReportShare } from "./report-locator";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { sha256Hex } from "./sha256";
import { listStaticReportCandidateIds } from "./static-report-files";
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
