import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertDiscriminatorMatchesProduct,
  normalizeHistoricalLossDetail,
  RESPONSE_BYTE_CAPTURE_LOSS_DETAIL
} from "./historical-loss-detail.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const BYTE_WARNING =
  "Some responses were not fully read after reaching the 64 MiB aggregate response-byte budget.";
const CAP_WARNING =
  "The scan stopped recording or loading additional requests after 1000 requests.";
const merged = () => ({
  family: "requests",
  phaseId: null,
  kind: "cap",
  count: 42,
  detail: "request-capture"
});

test("a byte-budget loss is resolved away from the recording cap", () => {
  assert.equal(
    normalizeHistoricalLossDetail(merged(), [BYTE_WARNING]).detail,
    RESPONSE_BYTE_CAPTURE_LOSS_DETAIL
  );
});

test("a recording-cap loss is left alone", () => {
  assert.equal(normalizeHistoricalLossDetail(merged(), [CAP_WARNING]).detail, "request-capture");
  assert.equal(normalizeHistoricalLossDetail(merged(), []).detail, "request-capture");
});

/**
 * The ambiguous run is the whole reason this is a discriminator and not a
 * rename. When both ceilings fired, nothing in the record says which one cut
 * which request, so the merged token stands.
 */
test("a run that hit both ceilings keeps the merged token", () => {
  assert.equal(
    normalizeHistoricalLossDetail(merged(), [BYTE_WARNING, CAP_WARNING]).detail,
    "request-capture"
  );
});

test("losses that never shared a token are untouched", () => {
  for (const detail of ["proxy-traffic", "cname-lookups", "public-request-unregistrable-hosts"]) {
    const loss = { ...merged(), detail };
    assert.equal(normalizeHistoricalLossDetail(loss, [BYTE_WARNING]).detail, detail);
  }
  assert.equal(normalizeHistoricalLossDetail(null, [BYTE_WARNING]), null);
});

test("the restated discriminator still matches the product rule", () => {
  assert.doesNotThrow(() => assertDiscriminatorMatchesProduct(repoRoot));

  // Mutation coverage. The pin's whole value is refusing a drifted product
  // source, so it is shown refusing one.
  const fake = mkdtempSync(path.join(tmpdir(), "loss-detail-pin-"));
  try {
    mkdirSync(path.join(fake, "lib"), { recursive: true });
    writeFileSync(
      path.join(fake, "lib", "scan-report-censorship.ts"),
      "const RESPONSE_BYTE_LIMIT_WARNING = /a different sentence/;\n"
    );
    assert.throws(
      () => assertDiscriminatorMatchesProduct(fake),
      /historical capture-loss discriminator drifted/
    );
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

/**
 * Anchored to the committed artifact, not only to the function, so the
 * attribution cannot silently revert to the merged token the next time the
 * driver is regenerated.
 */
test("the committed findings attribute the byte-budget loss separately", () => {
  const findings = readFileSync(
    path.join(here, "corpus-censoring-findings.txt"),
    "utf8"
  );
  assert.match(findings, /requests\/response-bytes\/cap/);
  assert.doesNotMatch(
    findings,
    /5 {2}requests\/request-capture\/cap/,
    "five recording-cap losses is the pre-discriminator count"
  );
});
