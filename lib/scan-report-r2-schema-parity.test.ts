/**
 * Independent differential harness for the v2 REVISION 2 schema (RFC 14.6),
 * mirroring the r1 harness: the hand-written r2 runtime validator and the
 * generated r2 JSON Schema must agree wherever the schema can express the
 * rule; the committed r2 file must equal a fresh generation and is pinned
 * byte-for-byte; and the stable alias must still serve r1.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Ajv from "ajv";
import { createGenerator } from "ts-json-schema-generator";
import { isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import { readStoredScanReport } from "./scan-report-reader";
import {
  makeConsentInterventionReportV2R2,
  makeConsentSingleReportV2R2,
  makeContradictedConsentRunR2,
  makeDescriptiveReportV2R2,
  makeDuplicateSequenceMutantR2,
  makeFailedConsentRunR2,
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2,
  makeSupportingPairInterventionReportV2R2,
  makeTemporalReportV2R2
} from "./scan-report-v2-r2-fixtures";
import type { PublicScanReportV2R2 } from "./scan-report-v2-r2";

const rootDir = process.cwd();
const R2_SCHEMA_ID = "https://sitebehavior.org/schemas/scan-report.v2.r2.schema.json";

// THE r2 freeze, executable in tests as well as the build (RFC 10.2/14.6).
const R2_SCHEMA_SHA256 = "539a0fbdcf2e06c41fa4e8662209d275a4e59364153137ab7c4a9f41c5b7c0c7";

// Keep in sync with scripts/build-schema.mjs (ESM, not importable here);
// the drift test below fails if the two diverge in output.
function generateR2Schema(): Record<string, unknown> {
  const schema = createGenerator({
    path: path.join(rootDir, "lib", "scan-report-v2-r2.ts"),
    type: "PublicScanReportV2R2",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("PublicScanReportV2R2");
  return { $id: R2_SCHEMA_ID, ...schema } as Record<string, unknown>;
}

const generated = generateR2Schema();
const ajv = new Ajv({ strict: false, allowUnionTypes: true });
const validateWithSchema = ajv.compile(generated);

type AnyRecord = Record<string, any>;

function mutate<T>(fixture: T, apply: (draft: T) => void): T {
  const draft = structuredClone(fixture);
  apply(draft);
  return draft;
}

function singleWith(run: AnyRecord): PublicScanReportV2R2 {
  return { schemaVersion: 2, schemaRevision: 2, reportType: "single", run } as PublicScanReportV2R2;
}

test("the committed r2 schema equals a fresh generation and is frozen byte-for-byte", () => {
  const committedPath = path.join(rootDir, "public", "schemas", "scan-report.v2.r2.schema.json");
  const committed = JSON.parse(readFileSync(committedPath, "utf8"));
  assert.deepEqual(committed, generated, "run `npm run build:schema` and commit the result");
  const bytes = readFileSync(committedPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), R2_SCHEMA_SHA256);

  // The stable alias must STILL serve r1, byte for byte (RFC 14.9: it moves
  // only after complete dual-read consumer migration).
  const aliasBytes = readFileSync(path.join(rootDir, "public", "scan-report.schema.json"));
  const r1Bytes = readFileSync(path.join(rootDir, "public", "schemas", "scan-report.v2.r1.schema.json"));
  assert.equal(aliasBytes.equals(r1Bytes), true, "the stable alias must stay on r1");
});

test("every valid r2 fixture passes both the runtime validator and the generated schema", () => {
  const fixtures = [
    makePublicSingleReportV2R2(),
    makeConsentSingleReportV2R2(),
    singleWith(makeFailedConsentRunR2()),
    singleWith(makeContradictedConsentRunR2()),
    makeGpcInterventionReportV2R2(),
    makeShieldsInterventionReportV2R2(),
    makeConsentInterventionReportV2R2(),
    makeTemporalReportV2R2(),
    makeDescriptiveReportV2R2(),
    makeSupportingPairInterventionReportV2R2()
  ];
  for (const fixture of fixtures) {
    assert.equal(isPublicScanReportV2R2(fixture), true);
    assert.equal(
      validateWithSchema(fixture),
      true,
      `r2 schema rejected a valid fixture: ${JSON.stringify(validateWithSchema.errors?.slice(0, 3))}`
    );
  }
});

test("r2 structural mutants are rejected by BOTH validators", () => {
  const structuralMutants: Array<[string, unknown]> = [
    [
      "unknown key in gpc facts",
      mutate(makeGpcInterventionReportV2R2(), (draft) => (((draft.baseline.verificationFacts!.gpc as AnyRecord).secret = "x")))
    ],
    [
      "unknown key in a result block",
      mutate(makeConsentSingleReportV2R2(), (draft) => (((draft.run.evidence.consent!.verificationObservations[0].result as AnyRecord).secret = "x")))
    ],
    [
      "errorCode on a read outcome",
      mutate(makeConsentSingleReportV2R2(), (draft) => (((draft.run.evidence.consent!.verificationObservations[0].result as AnyRecord).errorCode = "api-timeout")))
    ],
    [
      "bad banner moment",
      mutate(makeConsentSingleReportV2R2(), (draft) => (((draft.run.evidence.consent!.bannerTransition!.observations[0] as AnyRecord).moment = "later")))
    ],
    [
      "unknown key inside a supporting-pair run",
      mutate(makeSupportingPairInterventionReportV2R2(), (draft) => {
        if (draft.experiment.kind === "intervention") {
          (draft.experiment.supportingPairs![0].variant as AnyRecord).screenshot = "SECRET";
        }
      })
    ],
    ["ephemeral block at the root", { ...makePublicSingleReportV2R2(), ephemeral: { screenshot: null } }],
    ["wrong revision literal", mutate(makePublicSingleReportV2R2(), (draft) => (((draft as AnyRecord).schemaRevision = 1)))]
  ];
  for (const [label, mutant] of structuralMutants) {
    assert.equal(isPublicScanReportV2R2(mutant), false, `runtime accepted structural mutant: ${label}`);
    assert.equal(validateWithSchema(mutant), false, `schema accepted structural mutant: ${label}`);
  }
});

test("r2 runtime-only semantic mutants are rejected by the reader even though the schema accepts them", () => {
  const semanticMutants: Array<[string, unknown]> = [
    ["duplicate observation sequence", singleWith(makeDuplicateSequenceMutantR2())],
    [
      // TS `number` cannot express nonnegativity, so the generated schema
      // accepts it; the runtime validator's integer/count rule rejects it.
      "negative shields counter",
      mutate(makeShieldsInterventionReportV2R2(), (draft) => (((draft.variant.verificationFacts!.shields as AnyRecord).requestsMatched = -1)))
    ],
    [
      "forged shields summary",
      mutate(makeShieldsInterventionReportV2R2(), (draft) => {
        draft.variant.summary.counts.shieldsBlockedRequests = 9;
      })
    ],
    [
      "supporting-pair order against chronology",
      mutate(makeSupportingPairInterventionReportV2R2(), (draft) => {
        if (draft.experiment.kind === "intervention") draft.experiment.supportingPairs![0].order = "AB";
      })
    ],
    [
      "forged interventionVerified",
      mutate(makeGpcInterventionReportV2R2(), (draft) => {
        draft.comparability.interventionVerified = false; // arms passed
      })
    ]
  ];
  for (const [label, mutant] of semanticMutants) {
    const read = readStoredScanReport(mutant);
    assert.equal(read.ok, false, `reader accepted semantic mutant: ${label}`);
    assert.equal(validateWithSchema(mutant), true, `expected the r2 schema to accept (runtime-only): ${label}`);
  }
});
