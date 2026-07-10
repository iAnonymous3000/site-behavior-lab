/**
 * Differential harness (docs/scan-report-v2-rfc.md, 10.3): the hand-written
 * runtime validator and the generated JSON Schema must agree wherever the
 * schema can express the rule, and the committed schema file must equal a
 * fresh generation from the types (drift gate).
 *
 * Two mutant classes, kept separate on purpose:
 * - STRUCTURAL: expressible in JSON Schema (unknown keys, missing required
 *   fields, enum/const violations). Runtime and Ajv must BOTH reject.
 * - RUNTIME-ONLY SEMANTIC: cross-field consistency the schema cannot express
 *   (phase references, canonical timestamps, derived-block agreement). Runtime
 *   must reject; Ajv acceptance is expected and asserted, so a rule silently
 *   moving out of the schema's reach fails loudly here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Ajv from "ajv";
import { createGenerator } from "ts-json-schema-generator";
import {
  makeDescriptiveComparisonReportV2,
  makeEphemeralSingleReport,
  makeInterventionComparisonReportV2,
  makePublicSingleReportV2,
  makeTemporalComparisonReportV2
} from "./scan-report-v2-fixtures";
import { isPublicScanReportV2 } from "./scan-report-v2-validation";
import { readStoredScanReport } from "./scan-report-reader";

const rootDir = process.cwd();
const SCHEMA_ID = "https://sitebehavior.org/schemas/scan-report.v2.r1.schema.json";

// Keep in sync with scripts/build-schema.mjs (ESM, not importable from this
// CJS-compiled test); the drift test below fails if the two ever diverge in
// output.
function generateSchema(): Record<string, unknown> {
  const schema = createGenerator({
    path: path.join(rootDir, "lib", "scan-report-v2.ts"),
    type: "PublicScanReportV2",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("PublicScanReportV2");
  return { $id: SCHEMA_ID, ...schema } as Record<string, unknown>;
}

const generated = generateSchema();
const ajv = new Ajv({ strict: false, allowUnionTypes: true });
const validateWithSchema = ajv.compile(generated);

function mutate<T>(fixture: T, apply: (draft: T) => void): T {
  const draft = structuredClone(fixture);
  apply(draft);
  return draft;
}

type AnyRecord = Record<string, any>;

test("the committed schema files equal a fresh generation from the types", () => {
  const committed = JSON.parse(readFileSync(path.join(rootDir, "public", "schemas", "scan-report.v2.r1.schema.json"), "utf8"));
  assert.deepEqual(committed, generated, "run `npm run build:schema` and commit the result");
  // While the alias targets r1 it must be the SAME BYTES, not merely
  // JSON-equivalent: a reordered or reformatted alias would hash differently
  // and undermine the freeze pin below.
  const aliasBytes = readFileSync(path.join(rootDir, "public", "scan-report.schema.json"));
  const revisionedBytes = readFileSync(path.join(rootDir, "public", "schemas", "scan-report.v2.r1.schema.json"));
  assert.equal(aliasBytes.equals(revisionedBytes), true, "the stable alias must be byte-identical to the current revision");
});

// THE r1 freeze, executable (RFC 10.2). The drift test above would pass if
// someone edited the r1 types and regenerated the committed file with them;
// this pin cannot. It never changes: new shapes belong in a new revision's
// schema file, and the alias moves only after complete consumer migration.
const R1_SCHEMA_SHA256 = "7b865e6903ecdd1ecc2a5d5e848ffb320b7a1db9742dc108f603e5e21c9756a6";

test("the published r1 schema file is frozen byte-for-byte", () => {
  const bytes = readFileSync(path.join(rootDir, "public", "schemas", "scan-report.v2.r1.schema.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), R1_SCHEMA_SHA256);
});

test("every valid fixture passes both the runtime validator and the generated schema", () => {
  const fixtures = [
    makePublicSingleReportV2(),
    makeInterventionComparisonReportV2(),
    makeTemporalComparisonReportV2(),
    makeDescriptiveComparisonReportV2()
  ];
  for (const fixture of fixtures) {
    assert.equal(isPublicScanReportV2(fixture), true);
    assert.equal(
      validateWithSchema(fixture),
      true,
      `schema rejected a valid fixture: ${JSON.stringify(validateWithSchema.errors?.slice(0, 3))}`
    );
  }
});

test("structural mutants are rejected by BOTH validators", () => {
  const structuralMutants: Array<[string, unknown]> = [
    ["ephemeral block at the root", makeEphemeralSingleReport()],
    ["unknown root key", mutate(makePublicSingleReportV2(), (draft) => ((draft as AnyRecord).extra = 1))],
    [
      "unknown key inside a request record",
      mutate(makePublicSingleReportV2(), (draft) => ((draft.run.evidence.requests[0] as AnyRecord).rawHeaders = { cookie: "SECRET" }))
    ],
    [
      "unknown key under diff",
      mutate(makeInterventionComparisonReportV2(), (draft) => ((draft.diff.families["raw-counts"] as AnyRecord).screenshot = "SECRET"))
    ],
    ["missing required run block", mutate(makePublicSingleReportV2(), (draft) => delete (draft.run as AnyRecord).summary)],
    [
      "missing detector ledger entry",
      mutate(makePublicSingleReportV2(), (draft) => delete (draft.run.detectors as AnyRecord)["cname-uncloaking"])
    ],
    ["enum violation on shields condition", mutate(makePublicSingleReportV2(), (draft) => (((draft.run.conditions as AnyRecord).shields = "on")))],
    ["schemaRevision const violation", mutate(makePublicSingleReportV2(), (draft) => (((draft as AnyRecord).schemaRevision = 2)))],
    [
      "verification smuggled onto a temporal experiment",
      mutate(makeTemporalComparisonReportV2(), (draft) => (((draft.experiment as AnyRecord).verification = {})))
    ]
  ];
  for (const [label, mutant] of structuralMutants) {
    assert.equal(isPublicScanReportV2(mutant), false, `runtime accepted structural mutant: ${label}`);
    assert.equal(validateWithSchema(mutant), false, `schema accepted structural mutant: ${label}`);
  }
});

test("runtime-only semantic mutants are rejected by the reader even though the schema accepts them", () => {
  const semanticMutants: Array<[string, unknown]> = [
    [
      "phase reference out of range",
      mutate(makePublicSingleReportV2(), (draft) => ((draft.run.evidence.requests[0] as AnyRecord).phaseId = 7))
    ],
    [
      "non-canonical timestamp",
      mutate(makePublicSingleReportV2(), (draft) => ((draft.run as AnyRecord).startedAt = "2026-07-09T10:00:00Z"))
    ],
    [
      "forged interventionVerified",
      mutate(makeInterventionComparisonReportV2(), (draft) => {
        if (draft.experiment.kind === "intervention") {
          draft.experiment.verification.variant.observed = null;
          draft.experiment.verification.variant.outcome = "inconclusive";
        }
      })
    ],
    [
      "forged diff delta",
      mutate(makeInterventionComparisonReportV2(), (draft) => {
        draft.diff.families["raw-counts"].metrics.totalRequests.delta = 999;
      })
    ],
    [
      "intervention with no condition delta on its axis",
      mutate(makeInterventionComparisonReportV2(), (draft) => {
        draft.variant.conditions.shields = "classification";
      })
    ]
  ];
  for (const [label, mutant] of semanticMutants) {
    const read = readStoredScanReport(mutant);
    assert.equal(read.ok, false, `reader accepted semantic mutant: ${label}`);
    // These rules live beyond JSON Schema's reach; if one becomes schema-
    // expressible, move it to the structural set instead of losing coverage.
    assert.equal(validateWithSchema(mutant), true, `expected the schema to accept (runtime-only): ${label}`);
  }
});
