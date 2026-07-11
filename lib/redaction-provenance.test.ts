import assert from "node:assert/strict";
import { test } from "node:test";
import { CANONICALIZATION_VERSION } from "./canonical-json";
import {
  buildProvenanceEntry,
  committedSidecarFilename,
  isProvenanceEntry,
  matchProvenance,
  r2SidecarKey
} from "./redaction-provenance";

const REPORT = { schemaVersion: 1, reportType: "single", summary: { firstPartyDomain: "example.com" } };

function entryFor(report: unknown) {
  return buildProvenanceEntry({
    reportId: "20260711-" + "a".repeat(32),
    publicReport: report,
    writtenAt: "2026-07-11T20:00:00.000Z",
    createdAt: "2026-06-25T00:00:00.000Z",
    expiresAt: null
  });
}

test("sidecar names live outside the report-id pattern", () => {
  const id = "20260711-" + "a".repeat(32);
  assert.equal(committedSidecarFilename(id), `${id}.provenance.json`);
  assert.equal(r2SidecarKey(`reports/${id}.json`), `reports/${id}.json.provenance.json`);
  // The corpus file pattern must never match a sidecar.
  assert.equal(/^([0-9]{8}-[0-9a-f]{32})\.json$/.test(committedSidecarFilename(id)), false);
});

test("a matching sidecar vouches for the exact public bytes", () => {
  const entry = entryFor(REPORT);
  assert.equal(entry.canonicalizationVersion, CANONICALIZATION_VERSION);
  // Formatting differences do not break the match (canonical digesting).
  const reparsed = JSON.parse(JSON.stringify(REPORT, null, 2));
  const match = matchProvenance(reparsed, entry);
  assert.equal(match.status, "matched");
});

test("any modification after the sidecar was written is a digest mismatch", () => {
  const entry = entryFor(REPORT);
  const tampered = { ...REPORT, summary: { firstPartyDomain: "evil.example" } };
  const match = matchProvenance(tampered, entry);
  assert.equal(match.status, "digest-mismatch");
});

test("defects resolve to unknown provenance, never a false remediated", () => {
  assert.deepEqual(matchProvenance(REPORT, null), { status: "unknown", reason: "malformed-sidecar" });
  assert.deepEqual(matchProvenance(REPORT, { nonsense: true }), { status: "unknown", reason: "malformed-sidecar" });

  const foreign = { ...entryFor(REPORT), canonicalizationVersion: "canon-v999" };
  assert.deepEqual(matchProvenance(REPORT, foreign), { status: "unknown", reason: "canonicalization-version-mismatch" });
});

test("retention fields are carried verbatim and never invented", () => {
  const entry = entryFor(REPORT);
  assert.equal(entry.createdAt, "2026-06-25T00:00:00.000Z");
  assert.equal(entry.expiresAt, null);
  assert.equal(isProvenanceEntry(entry), true);
  assert.equal(isProvenanceEntry({ ...entry, publicDigest: "not-hex" }), false);
});
