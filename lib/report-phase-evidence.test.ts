import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STATE_CHANGE_ROW_LIMIT,
  buildVisitPhaseEvidence,
  stateChangeOperationLabel,
  visitPhaseLabel,
  visitPhaseSpanLabel
} from "./report-phase-evidence";
import { makeConsentSingleReportV2R2, makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";

test("legacy views stay absent while an empty v2 ledger stays recorded", () => {
  assert.equal(buildVisitPhaseEvidence(viewFromV1Report(makeScanReportV1()).runs[0]), null);

  const report = makePublicSingleReportV2R2();
  const model = buildVisitPhaseEvidence(viewFromV2(report, 2).runs[0]);
  assert.notEqual(model, null);
  assert.deepEqual(model?.changes, []);
  assert.equal(model?.phases.length, 1);
  assert.equal(model?.cookieLedgerIncomplete, false);
  assert.equal(model?.storageLedgerIncomplete, false);
});

test("phase presentation joins sparse counts without turning excluded traffic into zero", () => {
  const report = makeConsentSingleReportV2R2();
  report.run.phases.push({ phaseId: 3, kind: "active-probe", startedAtMs: 5000, endedAtMs: 5200 });
  report.run.summary.countsByPhase = [
    { phaseId: 0, totalRequests: 12, thirdPartyRequests: 8, knownTrackerRequests: 2 },
    { phaseId: 1, totalRequests: 1, thirdPartyRequests: 1, knownTrackerRequests: 0 }
  ];

  const model = buildVisitPhaseEvidence(viewFromV2(report, 2).runs[0]);
  assert.notEqual(model, null);
  assert.deepEqual(
    model?.phases.map((phase) => [phase.phaseId, phase.label, phase.requestCountState]),
    [
      [0, "Initial page load", "recorded"],
      [1, "Consent interaction", "recorded"],
      [2, "Post-choice verification reload", "no-retained-rows"],
      [3, "Active input probe", "no-retained-rows"]
    ]
  );
  assert.equal(model?.phases[2].requestCounts, null);
  assert.equal(model?.phases[3].requestCounts, null);
  assert.equal(visitPhaseSpanLabel(model!.phases[1]), "2,000–3,000 ms (1,000 ms)");
});

test("mutation rows use boundary-truthful copy and never expose unreviewed names", () => {
  const report = makeConsentSingleReportV2R2();
  report.run.evidence.cookieMutations = [
    {
      phaseId: 0,
      op: "added",
      cookie: {
        name: "_ga",
        domain: ".example.com",
        path: "/",
        sameSite: "Lax",
        secure: true,
        httpOnly: false,
        session: false,
        thirdParty: false
      }
    },
    {
      phaseId: 1,
      op: "changed",
      cookie: {
        name: "alice_private_session",
        domain: ".example.com",
        path: "/",
        sameSite: "Lax",
        secure: true,
        httpOnly: true,
        session: true,
        thirdParty: false
      }
    }
  ];
  report.run.evidence.storageMutations = [
    {
      phaseId: 2,
      op: "removed",
      entry: { area: "localStorage", key: "[redacted]", valueBytes: 2048 }
    }
  ];
  report.run.qualityFacts.captureLoss.push({
    family: "storage",
    phaseId: 2,
    kind: "dropped",
    count: 1,
    detail: "storage-snapshot"
  });
  report.run.quality.byFamily.storage = { outcome: "censored", reasons: ["capture-loss:dropped"] };

  const model = buildVisitPhaseEvidence(viewFromV2(report, 2).runs[0]);
  assert.notEqual(model, null);
  assert.equal(model?.hiddenNameRecords, 2);
  assert.equal(model?.storageLedgerIncomplete, true);
  assert.deepEqual(model?.phases[0].cookieChanges, { added: 1, changed: 0, removed: 0, total: 1 });
  assert.deepEqual(model?.phases[2].incompleteFamilies, ["storage"]);
  assert.deepEqual(
    model?.changes.map((row) => [row.phaseId, row.subjectLabel, row.operationLabel]),
    [
      [0, "_ga", "Present at first snapshot"],
      [1, "Cookie 2 · name hidden for privacy", "Changed by phase boundary"],
      [2, "Storage key 1 · name hidden for privacy", "Absent by phase boundary"]
    ]
  );
  assert.match(model!.changes[2].context, /last observed size 2,048 bytes/);
  const serialized = JSON.stringify(model);
  assert.equal(serialized.includes("alice_private_session"), false);
  assert.equal(serialized.includes("[redacted]"), false);
  assert.equal(serialized.includes("example.com"), false, "the mutation ledger never renders imported cookie domains");
});

test("unphased mutation clipping marks every affected tally partial while final-list clipping does not", () => {
  const report = makeConsentSingleReportV2R2();
  report.run.qualityFacts.captureLoss.push(
    { family: "cookies", phaseId: null, kind: "clipped", count: 4, detail: "public-cookie-mutations" },
    { family: "storage", phaseId: null, kind: "clipped", count: 2, detail: "public-storage-final" }
  );
  report.run.quality.byFamily.cookies = { outcome: "censored", reasons: ["capture-loss:clipped"] };
  report.run.quality.byFamily.storage = { outcome: "censored", reasons: ["capture-loss:clipped"] };

  const model = buildVisitPhaseEvidence(viewFromV2(report, 2).runs[0]);
  assert.notEqual(model, null);
  assert.equal(model?.cookieLedgerIncomplete, true);
  assert.equal(model?.storageLedgerIncomplete, false, "clipping only the final list leaves the mutation ledger intact");
  assert.equal(model?.phases.every((phase) => phase.incompleteFamilies.includes("cookies")), true);
  assert.equal(model?.phases.some((phase) => phase.incompleteFamilies.includes("storage")), false);
});

test("closed phase and operation labels remain stable", () => {
  assert.equal(visitPhaseLabel("policy-analysis"), "Privacy-policy analysis");
  assert.equal(stateChangeOperationLabel("added", "passive-load"), "Present at first snapshot");
  assert.equal(stateChangeOperationLabel("added", "consent-interaction"), "Appeared by phase boundary");
  assert.equal(stateChangeOperationLabel("changed", "consent-interaction"), "Changed by phase boundary");
  assert.equal(stateChangeOperationLabel("removed", "post-choice-reload"), "Absent by phase boundary");
  assert.equal(STATE_CHANGE_ROW_LIMIT, 80);
});
