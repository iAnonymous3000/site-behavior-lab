import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, (...args: any[]) => any>;
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ScriptExports>;

function script(name: string) {
  return nativeImport(pathToFileURL(path.join(process.cwd(), "scripts", name)).href);
}

const EXPECTED_GATES: Record<string, string> = {
  "decisions-approved": "decisions",
  "compatibility-surface-pinned": "document-digest",
  "errata-resolution": "errata",
  "current-method-corpus": "corpus",
  "aa-repeatability": "aa-study",
  "detector-calibration": "calibration",
  "legal-review": "review-ledger",
  "runner-cycles": "runner-receipts",
  "r2-lifecycle": "lifecycle-receipt",
  "release-receipt-archive": "receipt-archive",
  "durable-soak": "operator-attestation",
  "egress-backstop": "operator-attestation",
  "waf-ceilings": "operator-attestation",
  "log-retention": "operator-attestation",
  "staging-teardown": "operator-attestation",
  "container-image-licensing": "operator-attestation"
};
const EXPECTED_DECISIONS = [
  "claimBoundary",
  "stableApiClaim",
  "compatibilitySurface",
  "reportRevisionR3",
  "calibrationCensoringPolicy",
  "wasmReproducibility"
];

test("the committed manifest is NOT READY, every gate is pinned by id and kind, and only the digest pin is green", async () => {
  const { evaluateReleaseReadiness } = await script("release-readiness-lib.mjs");
  const result = evaluateReleaseReadiness();
  assert.equal(result.ready, false);
  assert.deepEqual(result.manifestProblems, []);

  // Pin the full governance surface: every gate id, its kind, and its status.
  // Repurposing a gate (changing its kind) or weakening the set moves THIS.
  const gates = new Map(
    result.gates.map((gate: { id: string; kind: string; status: string }) => [gate.id, gate])
  );
  assert.deepEqual([...gates.keys()].sort(), Object.keys(EXPECTED_GATES).sort());
  for (const [id, kind] of Object.entries(EXPECTED_GATES)) {
    const gate = gates.get(id) as { kind: string; status: string };
    assert.equal(gate.kind, kind, `${id} kind`);
    assert.equal(
      gate.status,
      id === "compatibility-surface-pinned" ? "pass" : "fail",
      `${id} status`
    );
  }

  // Pin the governed decision set: deleting a decision must stay visible.
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(
    readFileSync(path.join(process.cwd(), "RELEASE_READINESS.json"), "utf8")
  );
  assert.deepEqual(Object.keys(manifest.decisions).sort(), [...EXPECTED_DECISIONS].sort());
  assert.deepEqual(
    [...manifest.gates["decisions-approved"].requiredDecisions].sort(),
    [...EXPECTED_DECISIONS].sort()
  );
});

function approvedDecision(extra: Record<string, unknown> = {}) {
  return {
    status: "approved",
    decidedBy: "iAnonymous3000",
    decidedAt: "2026-08-10T00:00:00.000Z",
    ...extra
  };
}

function attestation(gateId: string, attestedAt = "2026-08-09T00:00:00.000Z") {
  return {
    kind: "site-behavior-operator-attestation",
    gateId,
    targetRelease: "1.0.0",
    attestedBy: "iAnonymous3000",
    attestedAt,
    statements: [{ claim: `${gateId} evidence captured for this candidate`, true: true }],
    evidenceRefs: [`actions-run-${gateId}`]
  };
}

function runnerReceipt(actionsRunId: number) {
  return {
    kind: "site-behavior-controlled-runner-destruction-receipt",
    receiptVersion: 1,
    actionsRunId,
    actionsRunAttempt: 1,
    workflow: "scan-featured.yml",
    runnerLabel: "sbl-controlled-r2",
    recordedAt: "2026-08-03T08:00:00.000Z",
    provisioning: {
      provisionedAt: "2026-08-03T05:00:00.000Z",
      hostImageIdentity: "ami-1",
      singleUse: true,
      registration: { repository: "o/r", labels: ["sbl-controlled-r2"], ephemeral: true }
    },
    isolation: {
      cloudMetadataBlocked: true,
      controlPlaneCredentialsAbsent: true,
      persistentStateAbsent: true
    },
    egress: {
      declaredRegion: "us-east",
      natIdentity: "nat-1",
      independentPolicyEnforced: true,
      blockedClasses: ["private", "link-local", "metadata"]
    },
    destruction: {
      destroyedAt: "2026-08-03T07:00:00.000Z",
      verifiedAbsentAt: "2026-08-03T07:05:00.000Z",
      method: "terminate",
      verification: "absence proof"
    },
    operator: { attestedBy: "iAnonymous3000", evidenceRefs: [`run-${actionsRunId}`] }
  };
}

const AA_BUILD = "a".repeat(40);
const AA_FRAME = "b".repeat(64);
const AA_CONDITIONS = { device: "desktop", gpcEnabled: false, consentMode: "observe" };

function aaPreregistration() {
  return {
    kind: "site-behavior-aa-preregistration",
    studyVersion: 1,
    studyId: "aa-synthetic",
    declaredAt: "2026-08-01T00:00:00.000Z",
    buildCommit: AA_BUILD,
    sitesFileDigest: AA_FRAME,
    targetCount: 1,
    repetitionsPerTarget: 2,
    conditions: AA_CONDITIONS,
    thresholds: {
      minimumEligibleTargets: 1,
      maximumFailingTargetFraction: 0,
      maximumMetricRelativeRange: { thirdPartyRequests: 0.25 },
      minimumThirdPartyDomainJaccard: 0.7,
      requireCounterbalancedOrders: false
    }
  };
}

async function aaLedger() {
  const fidelityStudyLib = await script("scanner-fidelity-study-lib.mjs");
  const runtime = {
    buildCommit: AA_BUILD,
    observer: "node-playwright",
    methodologyVersion: "methodology-x",
    detectorRegistry: { version: "registry-x", digest: "c".repeat(64) },
    fingerprints: {
      execution: "d".repeat(64),
      measurementEnvironment: "e".repeat(64),
      condition: "f".repeat(64)
    },
    runtime: {
      automation: "playwright-chromium",
      browser: { name: "chromium", version: "140.0.0.0" },
      device: { viewport: "1280x800" },
      locale: "en-US",
      language: "en",
      timezone: "UTC",
      egress: { label: "github-actions-ubuntu" },
      headless: true
    }
  };
  const attempts = [1, 2].map((repetition) => ({
    url: "https://one.example/",
    shape: "aa",
    repetition,
    outcome: "pass",
    censoredFamilies: [],
    observation: {
      schemaVersion: 2,
      reportType: "single",
      order: null,
      arms: {
        run: {
          runOutcome: "complete",
          requestOutcome: "complete",
          counts: { totalRequests: 40, thirdPartyRequests: 20, knownTrackerRequests: 5, thirdPartyDomains: 8 },
          thirdPartyDomains: ["a.example", "b.example"],
          producerRuntime: runtime
        }
      }
    }
  }));
  return fidelityStudyLib.buildAttemptLedger({
    createdAt: "2026-08-02T06:00:00.000Z",
    baseOrigin: "http://127.0.0.1:3000",
    sitesFile: "public/scanner-fidelity-sites.json",
    conditions: AA_CONDITIONS,
    repetitions: 2,
    selectedTargets: 1,
    shardIndex: 0,
    shardCount: 1,
    attempts,
    acceptanceThresholds: { minimumAnsweringTargets: 1, minimumRepeatableTargets: 1 },
    provenance: {
      expectedBuildCommit: AA_BUILD,
      sitesFileDigest: AA_FRAME,
      driverRuntime: { nodeVersion: "v24.14.1", platform: "linux", architecture: "x64" }
    }
  });
}

async function syntheticWorld(root: string) {
  const aaStudyLib = await script("aa-study-lib.mjs");
  const doc = "# Promise\nExactly these surfaces.\n";
  writeFileSync(path.join(root, "promise.md"), doc);
  const digest = createHash("sha256").update(doc).digest("hex");

  const metrics = Object.fromEntries(
    ["thirdPartyRequests", "thirdPartyDomains"].map((metric) => [
      metric,
      { count: 55, min: 0, max: 10, p50: 3, p75: 5, p90: 8, p95: 9 }
    ])
  );
  writeFileSync(
    path.join(root, "corpus-stats.json"),
    JSON.stringify({
      primaryCohortId: "v2-r2:test",
      metricContractDigest: "1".repeat(64),
      cohorts: [
        {
          id: "v2-r2:test",
          schemaVersion: 2,
          schemaRevision: 2,
          metricContractDigest: "1".repeat(64),
          sampleSize: 55,
          metrics
        }
      ]
    })
  );

  const studyDir = path.join(root, "research", "aa-studies", "aa-synthetic");
  mkdirSync(studyDir, { recursive: true });
  const preregistration = aaPreregistration();
  const ledger = await aaLedger();
  const evaluation = aaStudyLib.evaluateAaStudy({ preregistration, ledger });
  assert.equal(evaluation.status, "pass", JSON.stringify(evaluation.checks));
  writeFileSync(path.join(studyDir, "preregistration.json"), JSON.stringify(preregistration));
  writeFileSync(path.join(studyDir, "attempt-ledger.json"), JSON.stringify(ledger));
  writeFileSync(path.join(studyDir, "evaluation.json"), JSON.stringify(evaluation));

  writeFileSync(
    path.join(root, "reviews.json"),
    JSON.stringify({
      artifactKind: "site-behavior-third-party-review-ledger",
      reviews: [
        {
          key: "npm:left-pad@1.0.0",
          ecosystem: "npm",
          name: "left-pad",
          version: "1.0.0",
          runtime: true,
          status: "reviewed",
          reviewer: "iAnonymous3000",
          reviewedAt: "2026-08-01",
          determinedLicense: "MIT",
          obligations: []
        }
      ]
    })
  );
  writeFileSync(
    path.join(root, "inventory.json"),
    JSON.stringify({
      npm: [{ name: "left-pad", version: "1.0.0", license: "MIT", developmentOnly: false }],
      cargo: [],
      filterLists: { sources: [] }
    })
  );

  mkdirSync(path.join(root, "research", "runner-receipts"), { recursive: true });
  for (const runId of [1, 2]) {
    writeFileSync(
      path.join(root, "research", "runner-receipts", `${runId}.json`),
      JSON.stringify(runnerReceipt(runId))
    );
  }

  const day = 86_400;
  mkdirSync(path.join(root, "research", "ops-receipts"), { recursive: true });
  writeFileSync(
    path.join(root, "research", "ops-receipts", "r2-lifecycle-readback.json"),
    JSON.stringify({
      kind: "site-behavior-r2-lifecycle-readback",
      ok: true,
      recordedAt: "2026-08-09T00:00:00.000Z",
      rules: [
        {
          id: "reports-retention-backstop-8d",
          enabled: true,
          conditions: { prefix: "reports/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 8 * day } }
        }
      ]
    })
  );
  for (const gateId of ["durable-soak", "egress-backstop"]) {
    writeFileSync(
      path.join(root, "research", "ops-receipts", `${gateId}-attestation.json`),
      JSON.stringify(attestation(gateId))
    );
  }

  mkdirSync(path.join(root, "docs", "release-receipts", "0.3.0"), { recursive: true });
  writeFileSync(
    path.join(root, "docs", "release-receipts", "0.3.0", "release-receipt.json"),
    JSON.stringify({ receiptVersion: 1, tag: "v0.3.0" })
  );

  // The calibration gate is deliberately absent: an eligible study cannot be
  // fixtured (it must bind the CURRENT release identity); its fail-closed
  // behavior is asserted separately below.
  const manifest = {
    schemaVersion: 1,
    artifactKind: "site-behavior-release-readiness-manifest",
    targetRelease: "1.0.0",
    decisions: {
      claimBoundary: approvedDecision(),
      compatibilitySurface: approvedDecision({ document: "promise.md", sha256: digest })
    },
    gates: {
      "decisions-approved": {
        kind: "decisions",
        title: "decisions",
        requiredDecisions: ["claimBoundary", "compatibilitySurface"]
      },
      "compatibility-surface-pinned": { kind: "document-digest", title: "digest" },
      "errata-resolution": { kind: "errata", title: "errata", openErrata: [], resolvedBy: "reportRevisionR3" },
      "current-method-corpus": {
        kind: "corpus",
        title: "corpus",
        artifact: "corpus-stats.json",
        requiredCohort: { schemaVersion: 2, schemaRevision: 2 },
        minimumSitesPerMetric: 50,
        requiredMetrics: ["thirdPartyRequests", "thirdPartyDomains"]
      },
      "aa-repeatability": { kind: "aa-study", title: "aa", directory: "research/aa-studies" },
      "legal-review": {
        kind: "review-ledger",
        title: "legal",
        artifact: "reviews.json",
        inventory: "inventory.json"
      },
      "runner-cycles": {
        kind: "runner-receipts",
        title: "runner",
        directory: "research/runner-receipts",
        minimumReceipts: 2
      },
      "r2-lifecycle": {
        kind: "lifecycle-receipt",
        title: "lifecycle",
        receipt: "research/ops-receipts/r2-lifecycle-readback.json",
        maxAgeDays: 30
      },
      "release-receipt-archive": {
        kind: "receipt-archive",
        title: "archive",
        directory: "docs/release-receipts"
      },
      "durable-soak": {
        kind: "operator-attestation",
        title: "soak",
        attestation: "research/ops-receipts/durable-soak-attestation.json",
        maxAgeDays: 45
      },
      "egress-backstop": {
        kind: "operator-attestation",
        title: "egress",
        attestation: "research/ops-receipts/egress-backstop-attestation.json",
        maxAgeDays: 90
      }
    }
  };
  writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(manifest));
  return manifest;
}

const NOW = Date.parse("2026-08-10T12:00:00.000Z");

test("a fully evidenced synthetic world is READY", async () => {
  const { evaluateReleaseReadiness } = await script("release-readiness-lib.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-"));
  try {
    await syntheticWorld(root);
    const ready = evaluateReleaseReadiness(root, NOW);
    assert.equal(
      ready.ready,
      true,
      JSON.stringify(ready.gates.filter((gate: { status: string }) => gate.status !== "pass"))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the hardened failure modes stay closed", async () => {
  const { evaluateReleaseReadiness } = await script("release-readiness-lib.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-hard-"));
  try {
    const manifest = await syntheticWorld(root);
    const byId = (result: { gates: { id: string; status: string; reasons: string[] }[] }, id: string) =>
      result.gates.find((gate) => gate.id === id)!;

    // Deleting a required decision is a failure, never an approval.
    const trimmed = JSON.parse(JSON.stringify(manifest));
    delete trimmed.decisions.claimBoundary;
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(trimmed));
    const missingDecision = byId(evaluateReleaseReadiness(root, NOW), "decisions-approved");
    assert.equal(missingDecision.status, "fail");
    assert.match(missingDecision.reasons.join(" "), /claimBoundary is missing/);

    // A hand-written passing evaluation without a preregistration re-derives red.
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(manifest));
    const fakeStudy = path.join(root, "research", "aa-studies", "fake");
    mkdirSync(fakeStudy, { recursive: true });
    writeFileSync(
      path.join(fakeStudy, "evaluation.json"),
      JSON.stringify({ kind: "site-behavior-aa-evaluation", status: "pass" })
    );
    const aaGate = byId(evaluateReleaseReadiness(root, NOW), "aa-repeatability");
    // The synthetic real study still passes; the fake one must surface as a note.
    assert.equal(aaGate.status, "pass");
    assert.match(aaGate.reasons.join(" "), /fake:/);
    rmSync(fakeStudy, { recursive: true, force: true });

    // Duplicate receipt bytes are one cycle, not two.
    writeFileSync(
      path.join(root, "research", "runner-receipts", "2.json"),
      JSON.stringify(runnerReceipt(1))
    );
    const dupes = byId(evaluateReleaseReadiness(root, NOW), "runner-cycles");
    assert.equal(dupes.status, "fail");
    assert.match(dupes.reasons[0], /1 of 2 required distinct/);
    writeFileSync(
      path.join(root, "research", "runner-receipts", "2.json"),
      JSON.stringify(runnerReceipt(2))
    );

    // A lifecycle receipt whose ok flag disagrees with its recorded rules fails.
    const receiptPath = path.join(root, "research", "ops-receipts", "r2-lifecycle-readback.json");
    writeFileSync(
      receiptPath,
      JSON.stringify({
        kind: "site-behavior-r2-lifecycle-readback",
        ok: true,
        recordedAt: "2026-08-09T00:00:00.000Z",
        rules: []
      })
    );
    const flipped = byId(evaluateReleaseReadiness(root, NOW), "r2-lifecycle");
    assert.equal(flipped.status, "fail");
    assert.match(flipped.reasons.join(" "), /recorded rules|disagrees/);

    // A future-dated receipt is invalid, not eternally fresh.
    writeFileSync(
      receiptPath,
      JSON.stringify({
        kind: "site-behavior-r2-lifecycle-readback",
        ok: true,
        recordedAt: "2027-01-01T00:00:00.000Z",
        rules: [
          {
            id: "reports-retention-backstop-8d",
            enabled: true,
            conditions: { prefix: "reports/" },
            deleteObjectsTransition: { condition: { type: "Age", maxAge: 8 * 86_400 } }
          }
        ]
      })
    );
    const future = byId(evaluateReleaseReadiness(root, NOW), "r2-lifecycle");
    assert.equal(future.status, "fail");
    assert.match(future.reasons.join(" "), /future/);

    // An attestation for another release, or a stale one, never satisfies 1.0.
    const soakPath = path.join(root, "research", "ops-receipts", "durable-soak-attestation.json");
    writeFileSync(
      soakPath,
      JSON.stringify({ ...attestation("durable-soak"), targetRelease: "0.3.0" })
    );
    const wrongRelease = byId(evaluateReleaseReadiness(root, NOW), "durable-soak");
    assert.equal(wrongRelease.status, "fail");
    assert.match(wrongRelease.reasons.join(" "), /targetRelease/);
    writeFileSync(
      soakPath,
      JSON.stringify(attestation("durable-soak", "2026-01-01T00:00:00.000Z"))
    );
    const stale = byId(evaluateReleaseReadiness(root, NOW), "durable-soak");
    assert.equal(stale.status, "fail");
    assert.match(stale.reasons.join(" "), /older than 45 days/);

    // Malformed gate config fails closed: empty metric list, stringy errata.
    const doctored = JSON.parse(JSON.stringify(manifest));
    doctored.gates["current-method-corpus"].requiredMetrics = [];
    doctored.gates["errata-resolution"].openErrata = "E1, E2";
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(doctored));
    const doctoredResult = evaluateReleaseReadiness(root, NOW);
    assert.equal(byId(doctoredResult, "current-method-corpus").status, "fail");
    assert.equal(byId(doctoredResult, "errata-resolution").status, "fail");

    // A clearing cohort that is not the primary claim-backing cohort fails.
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(manifest));
    const corpus = JSON.parse(
      JSON.stringify({
        primaryCohortId: "v1:legacy",
        metricContractDigest: "1".repeat(64),
        cohorts: [
          {
            id: "v2-r2:test",
            schemaVersion: 2,
            schemaRevision: 2,
            metricContractDigest: "1".repeat(64),
            sampleSize: 55,
            metrics: Object.fromEntries(
              ["thirdPartyRequests", "thirdPartyDomains"].map((metric) => [
                metric,
                { count: 55, min: 0, max: 10, p50: 3, p75: 5, p90: 8, p95: 9 }
              ])
            )
          }
        ]
      })
    );
    writeFileSync(path.join(root, "corpus-stats.json"), JSON.stringify(corpus));
    const notPrimary = byId(evaluateReleaseReadiness(root, NOW), "current-method-corpus");
    assert.equal(notPrimary.status, "fail");
    assert.match(notPrimary.reasons.join(" "), /not the primary claim-backing cohort/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the calibration gate fails closed without eligible studies and rejects registry drift", async () => {
  const { evaluateReleaseReadiness } = await script("release-readiness-lib.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-cal-"));
  try {
    const manifest = {
      schemaVersion: 1,
      artifactKind: "site-behavior-release-readiness-manifest",
      targetRelease: "1.0.0",
      decisions: {},
      gates: {
        "detector-calibration": {
          kind: "calibration",
          title: "calibration",
          requiredDetectors: [
            "keystroke-exfiltration",
            "pixel-events",
            "consent-banner",
            "fingerprint-heuristics",
            "cname-uncloaking",
            "privacy-policy"
          ]
        }
      }
    };
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(manifest));
    const result = evaluateReleaseReadiness(root, NOW);
    assert.equal(result.ready, false);
    assert.match(result.gates[0].reasons.join(" "), /no eligible study|unavailable/);

    // A detector name outside the registry is a config error, and a registry
    // detector missing from the list is a coverage failure.
    manifest.gates["detector-calibration"].requiredDetectors = ["pixel-events", "made-up-detector"];
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(manifest));
    const drift = evaluateReleaseReadiness(root, NOW);
    const reasons = drift.gates[0].reasons.join(" ");
    if (!/unavailable/.test(reasons)) {
      assert.match(reasons, /made-up-detector is not a registry detector id/);
      assert.match(reasons, /not covered by requiredDetectors/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator attestations refuse soft truths, mismatched gates, and wrong releases", async () => {
  const { operatorAttestationIssues } = await script("release-readiness-lib.mjs");
  const binding = { targetRelease: "1.0.0", maxAgeDays: 45, now: NOW };
  assert.deepEqual(operatorAttestationIssues(attestation("egress-backstop"), "egress-backstop", binding), []);

  const soft = attestation("egress-backstop");
  (soft.statements[0] as Record<string, unknown>).true = "yes";
  assert.equal(
    operatorAttestationIssues(soft, "egress-backstop", binding).some((issue: string) =>
      /literally true/.test(issue)
    ),
    true
  );
  assert.equal(
    operatorAttestationIssues(attestation("egress-backstop"), "durable-soak", binding).some(
      (issue: string) => /gateId/.test(issue)
    ),
    true
  );
  assert.equal(
    operatorAttestationIssues(attestation("egress-backstop"), "egress-backstop", {
      ...binding,
      targetRelease: "1.1.0"
    }).some((issue: string) => /targetRelease/.test(issue)),
    true
  );
});
