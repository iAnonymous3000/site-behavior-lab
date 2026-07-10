import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeEphemeralSingleReport,
  makeInterventionComparisonReportV2,
  makePublicSingleReportV2,
  makeTemporalComparisonReportV2
} from "./scan-report-v2-fixtures";
import { toPublicScanReport } from "./scan-report-projection";
import { isPublicScanReportV2 } from "./scan-report-v2-validation";
import type { EphemeralComparisonReport } from "./scan-report-v2";

test("projection drops the ephemeral block and validates as public", () => {
  const ephemeral = makeEphemeralSingleReport();
  const projected = toPublicScanReport(ephemeral);

  assert.equal("ephemeral" in projected, false);
  assert.equal(isPublicScanReportV2(projected), true);
  // The ephemeral shell itself must never validate as public.
  assert.equal(isPublicScanReportV2(ephemeral), false);
  // Everything public survives byte-for-byte.
  assert.deepEqual(projected, makePublicSingleReportV2());
});

test("projection drops unknown fields at every level, not just the root", () => {
  const ephemeral = makeEphemeralSingleReport() as unknown as Record<string, any>;
  ephemeral.futureRootField = "leak";
  ephemeral.run.futureRunField = "leak";
  ephemeral.run.evidence.requests[0].rawHeaders = { cookie: "secret" };
  ephemeral.run.conditions.egress.internalHostname = "10.0.0.5";
  ephemeral.run.provenance.internalTicket = "OPS-123";

  const projected = toPublicScanReport(ephemeral as unknown as ReturnType<typeof makeEphemeralSingleReport>);
  const json = JSON.stringify(projected);

  assert.equal(json.includes("leak"), false);
  assert.equal(json.includes("secret"), false);
  assert.equal(json.includes("10.0.0.5"), false);
  assert.equal(json.includes("OPS-123"), false);
  assert.equal(isPublicScanReportV2(projected), true);
});

test("projection preserves each experiment kind exactly", () => {
  const intervention = makeInterventionComparisonReportV2();
  const temporal = makeTemporalComparisonReportV2();
  const interventionEphemeral: EphemeralComparisonReport = {
    ...intervention,
    ephemeral: { baselineScreenshot: null, variantScreenshot: "data:image/png;base64,BBBB" }
  };
  const temporalEphemeral: EphemeralComparisonReport = {
    ...temporal,
    ephemeral: { baselineScreenshot: null, variantScreenshot: null }
  };

  assert.deepEqual(toPublicScanReport(interventionEphemeral), intervention);
  assert.deepEqual(toPublicScanReport(temporalEphemeral), temporal);
  // A stray verification block smuggled onto a temporal experiment does not survive.
  (temporalEphemeral.experiment as unknown as Record<string, unknown>).verification = { fake: true };
  const projected = toPublicScanReport(temporalEphemeral);
  assert.equal("verification" in (projected.experiment as Record<string, unknown>), false);
});
