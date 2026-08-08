import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";
import {
  parseTransparencyLog,
  verifyTransparencyLogChain
} from "./publication-transparency-log";
import { inspectOtsProof } from "./transparency-log-anchoring";
import { sha256Hex } from "./sha256";
import { listStaticReportCandidateIds, readStaticReportBundle } from "./static-report-files";

/**
 * How many published entries may sit above the newest anchored head.
 *
 * Derived, not guessed: the busiest week in the committed log published 152
 * entries (2026 W30), and .github/workflows/anchor-transparency-log.yml runs
 * weekly. The ceiling is two peak weeks plus headroom, so one missed anchoring
 * run never fails an unrelated pull request, while a month of silence does.
 * Raising it is a decision about how long publications may go unwitnessed;
 * make it deliberately.
 */
const MAX_UNANCHORED_ENTRIES = 320;

/**
 * The committed transparency log against the committed corpus.
 *
 * The log and `public/reports/index.json` both carry `reportWireSha256`,
 * derived independently. Two files answering one question is the failure mode
 * this repository keeps rediscovering, so this suite makes the two agree by
 * test rather than by hope, and re-derives both from the report bytes so a
 * shared bug in either builder cannot satisfy it.
 */

const rootDir = process.cwd();
const reportsDir = path.join(rootDir, "public", "reports");

async function readLog() {
  const wire = await readFile(path.join(rootDir, "public", "transparency-log.json"), "utf8");
  return parseTransparencyLog(JSON.parse(wire) as unknown);
}

test("the committed transparency log verifies as a chain on its own bytes", async () => {
  const log = await readLog();
  assert.doesNotThrow(() => verifyTransparencyLogChain(log));
  assert.ok(log.entryCount > 0, "the committed corpus is not empty");
  assert.equal(log.head, log.entries[log.entries.length - 1].entryDigest);
});

test("every logged entry matches the report bytes actually committed", async () => {
  const log = await readLog();
  const logged = new Map(log.entries.map((entry) => [entry.reportId, entry]));

  let checked = 0;
  for (const id of await listStaticReportCandidateIds(reportsDir)) {
    const entry = logged.get(id);
    assert.ok(entry, `committed report ${id} is missing from the transparency log`);
    const read = await readStaticReportBundle(reportsDir, id);
    assert.equal(read.outcome, "found", `committed report ${id} is not a readable managed bundle`);
    if (read.outcome !== "found") continue;
    assert.equal(entry.reportWireSha256, sha256Hex(read.wire), `${id} wire digest drifted from the log`);
    assert.equal(entry.publicDigest, read.provenance.publicDigest, `${id} canonical digest drifted from the log`);
    checked += 1;
  }
  assert.ok(checked > 0, "no committed bundles were checked");
});

test("the transparency log and the gallery manifest never disagree about a report", async () => {
  const log = await readLog();
  const manifest = JSON.parse(
    await readFile(path.join(reportsDir, "index.json"), "utf8")
  ) as { reports: { id: string; reportWireSha256: string }[] };

  const logged = new Map(log.entries.map((entry) => [entry.reportId, entry.reportWireSha256]));
  for (const report of manifest.reports) {
    const loggedDigest = logged.get(report.id);
    assert.ok(loggedDigest, `manifest report ${report.id} is absent from the transparency log`);
    assert.equal(
      loggedDigest,
      report.reportWireSha256,
      `manifest and transparency log disagree about ${report.id}`
    );
  }
});

test("the published schema and the runtime parser accept exactly the same log", async () => {
  const schema = JSON.parse(
    await readFile(path.join(rootDir, "public", "transparency-log.schema.json"), "utf8")
  ) as object;
  const wire = JSON.parse(
    await readFile(path.join(rootDir, "public", "transparency-log.json"), "utf8")
  ) as Record<string, unknown>;

  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate(wire), true, JSON.stringify(validate.errors));

  // A published JSON Schema that is laxer than the runtime parser would invite
  // readers to build tooling the producer then rejects, so the mutants each
  // validator refuses must be the same set.
  const mutants: Record<string, unknown>[] = [
    { ...wire, chainAlgorithm: "sha256" },
    { ...wire, schemaVersion: 2 },
    { ...wire, entries: [{ ...(wire.entries as Record<string, unknown>[])[0], reportId: "nope" }] },
    { ...wire, anchors: [{ entryCount: 1, head: "0".repeat(64), proofType: "notary", proof: "AA" }] }
  ];
  for (const [index, mutant] of mutants.entries()) {
    assert.equal(validate(mutant), false, `schema accepted mutant ${index}`);
    assert.throws(() => parseTransparencyLog(mutant), `parser accepted mutant ${index}`);
  }
});

test("log entries are unique and contiguous, so nothing was quietly dropped", async () => {
  const log = await readLog();
  const ids = new Set(log.entries.map((entry) => entry.reportId));
  assert.equal(ids.size, log.entries.length, "a report id appears twice in the log");
  log.entries.forEach((entry, index) => {
    assert.equal(entry.sequence, index, "log sequence numbers must be contiguous from zero");
  });
});

test("every committed anchor is a real detached timestamp over a real chain head", async () => {
  const log = await readLog();
  assert.ok(log.anchors.length > 0, "the committed log must carry at least one anchor");

  let previousEntryCount = 0;
  for (const anchor of log.anchors) {
    // Parsing only checks base64 shape and size, and chain verification only
    // checks that the anchor names a head the chain reached. Neither opens the
    // proof, so a foreign or truncated blob committed by mistake would pass
    // both, and no human can review 300 characters of base64 in a diff.
    const inspection = inspectOtsProof(
      Buffer.from(anchor.proof, "base64"),
      anchor.head
    );
    assert.ok(
      inspection.pendingAttestations + inspection.bitcoinAttestations > 0,
      `anchor at entryCount ${anchor.entryCount} carries neither a calendar nor a Bitcoin attestation`
    );

    assert.ok(
      anchor.entryCount >= 1 && anchor.entryCount <= log.entries.length,
      `anchor entryCount ${anchor.entryCount} is outside the log's ${log.entries.length} entries`
    );
    // A witness that moves backwards is either a rewind or a mis-ordered
    // append; both mean the anchor list no longer reads as a history.
    assert.ok(
      anchor.entryCount >= previousEntryCount,
      "committed anchors must not decrease in entryCount"
    );
    previousEntryCount = anchor.entryCount;
  }
});

test("the anchored prefix of the log is disclosed, not assumed", async () => {
  const log = await readLog();
  const anchored = Math.max(...log.anchors.map((anchor) => anchor.entryCount));
  const unanchored = log.entries.length - anchored;

  // Not a failure: entries published after the newest anchor legitimately have
  // no external time bound until the next anchoring run. This asserts the gap
  // stays bounded, so "the log is anchored" never quietly becomes a statement
  // about a small anchored prefix of a much longer log.
  assert.ok(
    unanchored <= MAX_UNANCHORED_ENTRIES,
    `${unanchored} of ${log.entries.length} published entries sit above the newest anchored head ` +
      `(${anchored}); run npm run transparency:log:anchor. The ceiling is ${MAX_UNANCHORED_ENTRIES}.`
  );
});
