import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildFrameArtifacts,
  caseIdForIndex,
  drawFrame,
  drawKey
} from "./calibration-frame-lib.mjs";

const SEED = "a".repeat(64);
// The CANONICAL cname-uncloaking arm, not a well-formed lookalike. The
// acquisition validator compares each case's condition against
// calibrationMeasurementCondition(detector) including its exact interpretation
// text, so a fixture that invents its own wording tests bytes the ceremony
// would reject.
const CONDITION = {
  device: "desktop",
  gpcEnabled: false,
  consentMode: "observe",
  interpretation:
    "Rates are conditional on desktop visits with GPC disabled under passive consent observation with no consent action."
};

function pool(n) {
  return Array.from({ length: n }, (_, i) => ({ url: `https://site${i}.example/` }));
}

test("the draw is reproducible from the seed alone, with no PRNG to agree on", () => {
  const a = drawFrame(pool(50), SEED, 10);
  const b = drawFrame(pool(50).reverse(), SEED, 10);
  // Pool ORDER must not matter: the frame is determined by the keys, so an
  // operator cannot influence the sample by reordering the pool file.
  assert.deepEqual(a.map((c) => c.url), b.map((c) => c.url));
});

test("a third party can recompute the draw with one sha256 per candidate", () => {
  const entries = pool(40);
  const drawn = drawFrame(entries, SEED, 5);
  const expected = entries
    .map((entry) => ({
      url: entry.url,
      key: createHash("sha256").update(`${SEED}\n${entry.url}`).digest("hex")
    }))
    .sort((x, y) => (x.key < y.key ? -1 : 1))
    .slice(0, 5)
    .map((entry) => entry.url);
  assert.deepEqual(drawn.map((c) => c.url), expected);
});

test("a different seed draws a different frame", () => {
  const a = drawFrame(pool(200), SEED, 20).map((c) => c.url);
  const b = drawFrame(pool(200), "b".repeat(64), 20).map((c) => c.url);
  assert.notDeepEqual(a, b);
});

test("case ids are opaque, ordered, and leak nothing about the site", () => {
  const drawn = drawFrame(pool(30), SEED, 3);
  assert.deepEqual(drawn.map((c) => c.caseId), ["case-0001", "case-0002", "case-0003"]);
  assert.equal(caseIdForIndex(0), "case-0001");
  for (const entry of drawn) {
    assert.equal(entry.caseId.includes("example"), false);
    assert.equal(entry.caseId.includes("site"), false);
  }
});

test("a duplicated pool url is refused rather than drawn twice", () => {
  // Two keys for one site would give it two chances and break both the
  // equal-probability draw and the study's independentUnits declaration.
  const entries = [...pool(5), { url: "https://site2.example/" }];
  assert.throws(() => drawFrame(entries, SEED, 3), /more than once/);
});

test("the draw refuses a pool smaller than the frame instead of drawing short", () => {
  assert.throws(() => drawFrame(pool(10), SEED, 11), /cannot draw 11/);
});

test("non-https pool entries are refused", () => {
  assert.throws(() => drawFrame([{ url: "http://insecure.example/" }], SEED, 1), /https url/);
  assert.throws(() => drawFrame([{ host: "no-url.example" }], SEED, 1), /https url/);
});

test("frozen case bytes are canonical and their digests match those exact bytes", () => {
  const artifacts = buildFrameArtifacts({
    drawn: drawFrame(pool(20), SEED, 2),
    studyId: "study-x",
    detector: "cname-uncloaking",
    measurementCondition: CONDITION
  });
  for (const artifact of artifacts) {
    assert.equal(
      artifact.selectionDigest,
      createHash("sha256").update(artifact.selectionText).digest("hex")
    );
    assert.equal(
      artifact.conditionDigest,
      createHash("sha256").update(artifact.conditionText).digest("hex")
    );
    // Two-space indent and a trailing newline: the acquisition validator
    // recomputes the digest over these exact bytes, so a different indent
    // fails closed after the one-shot ceremony has already begun.
    assert.equal(artifact.selectionText.endsWith("}\n"), true);
    assert.equal(artifact.selectionText.includes('\n  "schemaVersion": 1'), true);
  }
});

test("the condition carries only the three request axes, never the interpretation", () => {
  const [artifact] = buildFrameArtifacts({
    drawn: drawFrame(pool(5), SEED, 1),
    studyId: "study-x",
    detector: "cname-uncloaking",
    measurementCondition: CONDITION
  });
  const condition = JSON.parse(artifact.conditionText);
  assert.deepEqual(Object.keys(condition.request), ["device", "gpcEnabled", "consentMode"]);
  assert.equal(artifact.conditionText.includes("interpretation"), false);
  assert.deepEqual(Object.keys(condition), [
    "schemaVersion",
    "artifactKind",
    "studyId",
    "detector",
    "caseId",
    "request"
  ]);
});

test("the selection artifact key order matches the validator's exact list", () => {
  const [artifact] = buildFrameArtifacts({
    drawn: drawFrame(pool(5), SEED, 1),
    studyId: "study-x",
    detector: "cname-uncloaking",
    measurementCondition: CONDITION
  });
  assert.deepEqual(Object.keys(JSON.parse(artifact.selectionText)), [
    "schemaVersion",
    "artifactKind",
    "studyId",
    "detector",
    "caseId",
    "url"
  ]);
});

test("drawKey binds the seed, so the same url keys differently per study", () => {
  assert.notEqual(drawKey(SEED, "https://a.example/"), drawKey("c".repeat(64), "https://a.example/"));
});

test("the frozen bytes this producer writes are accepted by the real acquisition validator", async () => {
  // The defect class this guards is one contract restated in two files: the
  // producer serializing one way and the acquisition validator recomputing
  // digests another. Both halves would pass their own tests and disagree only
  // during the one-shot ceremony. So this runs the actual consumer over the
  // actual produced bytes rather than asserting a shape twice.
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const { validateCalibrationCaseInputs } = await import("./calibration-study-lib.mjs");

  const root = mkdtempSync(nodePath.join(os.tmpdir(), "calibration-frame-"));
  const artifacts = buildFrameArtifacts({
    drawn: drawFrame(pool(20), SEED, 3),
    studyId: "study-x",
    detector: "cname-uncloaking",
    measurementCondition: CONDITION
  });
  for (const artifact of artifacts) {
    const dir = nodePath.join(root, "cases", artifact.caseId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(nodePath.join(dir, "selection.json"), artifact.selectionText);
    writeFileSync(nodePath.join(dir, "condition.json"), artifact.conditionText);
  }

  const frameById = new Map(
    artifacts.map((artifact) => [
      artifact.caseId,
      {
        caseId: artifact.caseId,
        selectionDigest: artifact.selectionDigest,
        conditionDigest: artifact.conditionDigest,
        referenceEvidenceDigest: "0".repeat(64)
      }
    ])
  );
  const cases = validateCalibrationCaseInputs({
    candidate: {
      studyId: "study-x",
      detector: "cname-uncloaking",
      preregistration: { design: { measurementCondition: CONDITION } },
      frameById
    },
    caseInputRoot: root
  });
  assert.equal(cases.length, 3);
  assert.deepEqual(cases.map((c) => c.caseId), ["case-0001", "case-0002", "case-0003"]);
});
