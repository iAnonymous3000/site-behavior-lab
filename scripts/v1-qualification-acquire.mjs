import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { CASES, LIMITATIONS, createQualificationOrigin, referenceProblems, qualificationPresentationProblems } from "./v1-qualification-lib.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** No release approval is generated here. Failures and independent receipts survive. */
export async function acquireQualification({ outputDir, buildCommit, runtime, progress = () => {} }) {
  await mkdir(outputDir); // Create-only: an earlier attempt can never be overwritten.
  const { server, events, setArm } = createQualificationOrigin();
  const env = {
    SITE_BEHAVIOR_LAB_BUILD_COMMIT: buildCommit,
    SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND: "filesystem",
    SITE_BEHAVIOR_LAB_REPORT_STORE_DIR: path.join(outputDir, "store"),
    SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "1",
    SITE_BEHAVIOR_LAB_SCANNER_EGRESS: "local",
    SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION: "",
    SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION: "0"
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const ledger = { schemaVersion: 1, artifactKind: "site-behavior-v1-qualification-capture", candidateCommit: buildCommit,
    startedAt: new Date().toISOString(), completedAt: null, limitations: LIMITATIONS,
    approval: "pending-human-review", cases: [] };
  const write = (relative, value) => writeFile(path.join(outputDir, relative), serialize(value), { flag: "wx" });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    const options = { publicUrlAlreadyVerified: true, verifyPublicUrl: async () => undefined,
      resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
      connectProxyUpstreamForTests: () => connect(port, "127.0.0.1"), resolveCnameChain: async () => [] };
    for (const scenario of CASES) {
      progress(`Collecting ${scenario.id}`);
      events.length = 0;
      await mkdir(path.join(outputDir, scenario.id));
      const entry = { ...scenario, problems: [], artifacts: [] };
      ledger.cases.push(entry);
      try {
        const visit = async (arm, changes = {}, extra = {}) => {
          setArm(arm);
          return runtime.scanner.scanSiteWithMeasurement({ url: `http://qualification.example.com/${scenario.id}`,
            device: "desktop", gpcEnabled: false, consentMode: "observe", ...changes }, { ...options, ...extra });
        };
        let report;
        if (scenario.mode === "single") {
          report = runtime.builder.buildRuntimeScanReportV2R2(await visit("single"), "operator-cli");
        } else {
          const consent = scenario.mode === "consent";
          const baseline = await visit("baseline", consent ? { consentMode: "accept-all" } : {});
          const variant = await visit("variant", consent ? { consentMode: "reject-all" } :
            scenario.mode === "gpc" ? { gpcEnabled: true } : {},
            scenario.mode === "blocker" ? { shieldsBlockingEnabled: true } : {});
          report = runtime.builder.buildRuntimeComparisonScanReportV2R2(baseline, variant, "baseline", "operator-cli");
        }
        // This is the real transactional filesystem backend and managed readback.
        const prepared = runtime.store.prepareScanReportBundle(report);
        const wire = JSON.parse(prepared.reportWire);
        // Keep the produced public report even if persistence or a later check fails.
        await write(`${scenario.id}/report.json`, wire);
        entry.artifacts.push({ path: `${scenario.id}/report.json`, sha256: digest(serialize(wire)) });
        const saved = await runtime.store.commitPreparedScanReportBundle(prepared);
        const stored = await runtime.store.readStoredScanReportById(saved.share.id);
        assert.equal(stored.outcome, "found", "managed persistence readback failed");
        assert.equal(stored.wire, prepared.reportWire, "managed readback changed the committed bytes");
        const loaded = runtime.view.readScanTransportPayload(saved);
        assert.equal(loaded.kind, "report", "immediate response cannot be read");
        const exported = runtime.view.publicWireForExportOrPersistence(loaded.loaded);
        assert.deepEqual(exported, wire, "JSON export and persisted report differ");
        const reopened = runtime.view.readScanTransportPayload(wire);
        assert.equal(reopened.kind, "report", "persisted report cannot be reopened");
        const presentation = runtime.consistency.validateReportPresentation(reopened.loaded.view, null);
        const headline = runtime.headline.buildReportHeadline(reopened.loaded.view);
        entry.problems.push(...referenceProblems(scenario.id, wire, events));
        entry.problems.push(...presentation.violations.map((violation) => `presentation: ${JSON.stringify(violation)}`));
        entry.problems.push(...qualificationPresentationProblems(scenario.id, headline));
        const reviewEvidence = {
          expectation: scenario.expectation, problems: entry.problems,
          automatedChecks: { managedFilesystemReadback: true, exportEqualsStoredWire: true,
            presentationConsistency: presentation.violations.length === 0 },
          headline, remainingReview: ["independent reference correctness", "rendered browser UI", "public deployment and R2"],
          status: "pending-human-review"
        };
        await write(`${scenario.id}/review-evidence.json`, reviewEvidence);
        entry.artifacts.push({ path: `${scenario.id}/review-evidence.json`, sha256: digest(serialize(reviewEvidence)) });
      } catch (error) {
        entry.problems.push(error instanceof Error ? error.message : String(error));
      } finally {
        const reference = { referenceKind: "controlled-http-server-receipts", capturedIndependentlyOfReport: true,
          transport: "explicit-loopback-test-seam", events: structuredClone(events) };
        await write(`${scenario.id}/reference.json`, reference);
        entry.artifacts.push({ path: `${scenario.id}/reference.json`, sha256: digest(serialize(reference)) });
        progress(`${scenario.id}: ${entry.problems.length ? entry.problems.join("; ") : "automated expectations passed; human review pending"}`);
      }
    }
  } finally {
    await runtime.scanner.closeSharedBrowserForTests();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    ledger.completedAt = new Date().toISOString();
    await write("capture.json", ledger);
  }
  return ledger;
}
