import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkEvidenceId, decodeJson, isShapeRefusal, readInspectOutput, readObserveOutput, readScriptManifest, RECORDER } from "../core/recorder-shapes";
import {
  PROVENANCE_PATH_6_8_0,
  readInspectOutput680,
  readObserveOutput680,
  readProvenance680,
  readRecorderFailure,
  RECORDER_6_8_0,
  RECORDER_LIMITATIONS_6_8_0,
  recorderIdentity680
} from "../core/recorder-shapes-6-8-0";
import { PROVENANCE_RECORD } from "./recorded-fixture";

/**
 * The 6.8.0 adapter, on output REA 6.8.0 wrote in the S4 fixture runs (local pages, linux/arm64,
 * Chromium 158), copied byte for byte into investigation/test/recorded (its README names each file's
 * run, step and SHA-256). The files are read as data, never executed. One 6.7.0 failure sits beside them,
 * so the test can show the two releases' budget refusals read as different outcomes.
 */
const RECORDED = path.join(process.cwd(), "investigation/test/recorded");
const recorded = (name: string): unknown => decodeJson(name, readFileSync(path.join(RECORDED, name)));
const plain = (name: string): Record<string, unknown> => {
  const value = recorded(name);
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), name);
  return value as Record<string, unknown>;
};

test("6.8.0's observe output reads under 6.8.0's table, and under 6.5.0's, whose twelve sentences it keeps word for word", () => {
  const view = readObserveOutput680("observe-control.json", recorded("rea-6.8.0/observe-control.json"));
  assert.ok(!isShapeRefusal(view), JSON.stringify(view));
  assert.equal(view.endReason, "window_elapsed");
  assert.equal(view.cleanup, "confirmed");
  assert.equal(view.sources.length, 1);
  assert.ok([...view.coverage.values()].flat().some((fn) => fn.name === "branchy"));
  assert.equal(view.limitations.length, 12);
  assert.deepEqual(readObserveOutput("observe-control.json", recorded("rea-6.8.0/observe-control.json")), view);
});

test("6.8.0's inspection reads under 6.8.0's table, which adds the worker sentence, and 6.5.0's table refuses it", () => {
  const view = readInspectOutput680("inspect-control.json", recorded("rea-6.8.0/inspect-control.json"));
  assert.ok(!isShapeRefusal(view), JSON.stringify(view));
  assert.ok(view.limitations.includes("worker-targets-snapshot-only"));
  assert.equal(view.limitations.length, 8);
  assert.deepEqual(readInspectOutput("inspect-control.json", recorded("rea-6.8.0/inspect-control.json")), { ok: false, refusal: "unknown-shape", at: "inspect-control.json: limitations" });
  assert.equal(Object.keys(RECORDER_LIMITATIONS_6_8_0["rea.web-page-inspection"]).length, 8);
});

test("a sentence outside 6.8.0's table, or a ninth envelope key, is a shape this does not know", () => {
  const sentence = { ...plain("rea-6.8.0/observe-control.json") };
  sentence.limitations = [...(sentence.limitations as string[]).slice(1), "A sentence 6.8.0 does not write."];
  assert.deepEqual(readObserveOutput680("observe", sentence), { ok: false, refusal: "unknown-shape", at: "observe: limitations" });
  const extra = { ...plain("rea-6.8.0/inspect-control.json"), added: null };
  assert.deepEqual(readInspectOutput680("inspect", extra), { ok: false, refusal: "unknown-shape", at: "inspect: envelope keys" });
});

test("6.5.0's evidence-id recipe does not recompute 6.8.0's ids, so the 6.8.0 adapter makes no claim about them", async () => {
  // Unedited output REA 6.8.0 wrote, which 6.5.0's recipe names otherwise: 6.8.0 hashes another set of
  // fields or spells them another way. Reading its recipe means reading its package inside the runner
  // image, which this stage did not do, so an id is neither checked nor trusted for 6.8.0 output.
  for (const name of ["rea-6.8.0/observe-control.json", "rea-6.8.0/inspect-control.json"]) {
    const value = plain(name);
    assert.match(String(value.evidence_id), /^ev_[0-9a-f]{64}$/, name);
    assert.deepEqual(await checkEvidenceId(name, value), { ok: false, refusal: "digest-mismatch", at: `${name}: evidence_id` }, name);
  }
});

test("6.8.0's script manifest reads under the shared reader, every path inside its folder", () => {
  const scripts = readScriptManifest("script-manifest.json", recorded("rea-6.8.0/script-manifest.json"));
  assert.ok(!isShapeRefusal(scripts), JSON.stringify(scripts));
  assert.ok(scripts.length > 0);
});

test("6.8.0's failures read as typed outcomes, and its budget refusal is not 6.7.0's unreadable output", () => {
  const budget = readRecorderFailure("failure-source-budget.json", recorded("rea-6.8.0/failure-source-budget.json"));
  assert.deepEqual(budget, {
    code: "resource_constraint",
    category: "resource_constraint",
    retryable: false,
    operation: "observe_web_execution",
    cleanup: null,
    budget: { boundary: "browser-runtime-retention", kind: "sources", retainedBytes: 34_663_815, limitBytes: 33_554_432 },
    outcome: "budget-refused"
  });
  const older = readRecorderFailure("6.7.0 failure-source-budget.json", recorded("rea-6.7.0/failure-source-budget.json"));
  assert.ok(!isShapeRefusal(older), JSON.stringify(older));
  assert.equal(older.outcome, "unreadable-output");
  assert.equal(older.budget, null);
  const outcomes = Object.fromEntries(
    ["failure-sigint", "failure-page-crash", "failure-large-post", "failure-input"].map((name) => {
      const read = readRecorderFailure(name, recorded(`rea-6.8.0/${name}.json`));
      assert.ok(!isShapeRefusal(read), `${name}: ${JSON.stringify(read)}`);
      return [name, [read.outcome, read.cleanup]];
    })
  );
  assert.deepEqual(outcomes, {
    "failure-sigint": ["cancelled", "complete"],
    "failure-page-crash": ["cleanup-unconfirmed", "incomplete"],
    "failure-large-post": ["cleanup-unconfirmed", "incomplete"],
    "failure-input": ["input-refused", null]
  });
});

test("a failure object is read strictly: no extra key, one word for its code, and never its message", () => {
  const base = plain("rea-6.8.0/failure-source-budget.json");
  assert.deepEqual(readRecorderFailure("f", { ...base, extra: 1 }), { ok: false, refusal: "unknown-shape", at: "f: failure keys" });
  assert.deepEqual(readRecorderFailure("f", { ...base, code: "resource constraint, see page text" }), { ok: false, refusal: "unknown-shape", at: "f: code" });
  const details = base.details as Record<string, unknown>;
  assert.deepEqual(readRecorderFailure("f", { ...base, details: { ...details, reported_limits: { ...(details.reported_limits as object), limit_bytes: -1 } } }), { ok: false, refusal: "unknown-shape", at: "f: details.reported_limits" });
  const read = readRecorderFailure("f", base);
  assert.ok(!isShapeRefusal(read));
  assert.ok(!JSON.stringify(read).includes(String(base.message)));
});

test("6.8.0's provenance rule names its own package and commit, and 6.5.0's record does not pass for it", () => {
  const digest = RECORDER_6_8_0.integrity.replace(/^sha512:/, "");
  const own = decodeJson(PROVENANCE_PATH_6_8_0, PROVENANCE_RECORD({ name: "pkg:npm/rea-agents@6.8.0", digest, commit: RECORDER_6_8_0.commit }));
  const provenance = readProvenance680(PROVENANCE_PATH_6_8_0, own);
  assert.deepEqual(provenance, { exactStatements: true, namesPackage: true, namesCommit: true });
  const identity = recorderIdentity680({ provenance, declaredRelease: "6.8.0", outputsRead: 1, outputRefusal: null });
  assert.equal(identity.status, "present");
  assert.match(identity.reason, /^attested: a provenance statement at provenance-check\/rea-agents-6\.8\.0\.attestations\.json names REA 6\.8\.0/);
  assert.deepEqual(readProvenance680(PROVENANCE_PATH_6_8_0, decodeJson(PROVENANCE_PATH_6_8_0, PROVENANCE_RECORD())), { exactStatements: true, namesPackage: false, namesCommit: false });
  assert.equal(recorderIdentity680({ provenance: null, declaredRelease: RECORDER.release, outputsRead: 1, outputRefusal: null }).status, "incompatible");
});
