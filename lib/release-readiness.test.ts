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

function readinessLib() {
  return nativeImport(
    pathToFileURL(path.join(process.cwd(), "scripts", "release-readiness-lib.mjs")).href
  );
}

test("the committed manifest reports NOT READY today, with the digest pin as the one green gate", async () => {
  const { evaluateReleaseReadiness } = await readinessLib();
  const result = evaluateReleaseReadiness();
  assert.equal(result.ready, false);
  assert.deepEqual(result.manifestProblems, []);
  const byId = new Map(result.gates.map((gate: { id: string; status: string }) => [gate.id, gate.status]));
  // The one gate the repository can already satisfy.
  assert.equal(byId.get("compatibility-surface-pinned"), "pass");
  // The honest reds this test exists to keep honest: when one flips, the
  // evidence landed and THIS assertion is the one that moves.
  for (const id of [
    "decisions-approved",
    "errata-resolution",
    "current-method-corpus",
    "aa-repeatability",
    "detector-calibration",
    "legal-review",
    "runner-cycles",
    "r2-lifecycle",
    "release-receipt-archive",
    "durable-soak",
    "egress-backstop"
  ]) {
    assert.equal(byId.get(id), "fail", `${id} should be failing today`);
  }
  assert.equal(result.gates.length, 16);
});

function approvedDecision(extra: Record<string, unknown> = {}) {
  return {
    status: "approved",
    decidedBy: "iAnonymous3000",
    decidedAt: "2026-08-10T00:00:00.000Z",
    ...extra
  };
}

function attestation(gateId: string) {
  return {
    kind: "site-behavior-operator-attestation",
    gateId,
    attestedBy: "iAnonymous3000",
    attestedAt: "2026-08-10T00:00:00.000Z",
    statements: [{ claim: `${gateId} evidence captured`, true: true }],
    evidenceRefs: [`actions-run-${gateId}`]
  };
}

function syntheticWorld(root: string) {
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
      cohorts: [{ id: "v2-r2:test", schemaVersion: 2, schemaRevision: 2, sampleSize: 55, metrics }]
    })
  );

  mkdirSync(path.join(root, "research", "aa-studies", "aa-1"), { recursive: true });
  writeFileSync(
    path.join(root, "research", "aa-studies", "aa-1", "evaluation.json"),
    JSON.stringify({ kind: "site-behavior-aa-evaluation", status: "pass" })
  );

  writeFileSync(
    path.join(root, "reviews.json"),
    JSON.stringify({
      artifactKind: "site-behavior-third-party-review-ledger",
      reviews: [
        {
          key: "npm:left-pad@1.0.0",
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

  mkdirSync(path.join(root, "research", "runner-receipts"), { recursive: true });
  const receipt = {
    kind: "site-behavior-controlled-runner-destruction-receipt",
    receiptVersion: 1,
    actionsRunId: 1,
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
    operator: { attestedBy: "iAnonymous3000", evidenceRefs: ["run-1"] }
  };
  for (const runId of [1, 2]) {
    writeFileSync(
      path.join(root, "research", "runner-receipts", `${runId}.json`),
      JSON.stringify({ ...receipt, actionsRunId: runId })
    );
  }

  mkdirSync(path.join(root, "research", "ops-receipts"), { recursive: true });
  writeFileSync(
    path.join(root, "research", "ops-receipts", "r2-lifecycle-readback.json"),
    JSON.stringify({
      kind: "site-behavior-r2-lifecycle-readback",
      ok: true,
      recordedAt: "2026-08-09T00:00:00.000Z"
    })
  );
  for (const gateId of ["durable-soak", "egress-backstop"]) {
    writeFileSync(
      path.join(root, "research", "ops-receipts", `${gateId}-attestation.json`),
      JSON.stringify(attestation(gateId))
    );
  }

  mkdirSync(path.join(root, "docs", "release-receipts", "0.3.0"), { recursive: true });
  writeFileSync(path.join(root, "docs", "release-receipts", "0.3.0", "release-receipt.json"), "{}");

  // The calibration gate is deliberately absent from this manifest: an
  // eligible study cannot be fixtured (it must bind the CURRENT release
  // identity); its fail-closed behavior is asserted separately below.
  const manifest = {
    schemaVersion: 1,
    artifactKind: "site-behavior-release-readiness-manifest",
    targetRelease: "1.0.0",
    decisions: {
      claimBoundary: approvedDecision(),
      compatibilitySurface: approvedDecision({ document: "promise.md", sha256: digest })
    },
    gates: {
      "decisions-approved": { kind: "decisions", title: "decisions" },
      "compatibility-surface-pinned": { kind: "document-digest", title: "digest", document: "promise.md" },
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
      "legal-review": { kind: "review-ledger", title: "legal", artifact: "reviews.json" },
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
        attestation: "research/ops-receipts/durable-soak-attestation.json"
      },
      "egress-backstop": {
        kind: "operator-attestation",
        title: "egress",
        attestation: "research/ops-receipts/egress-backstop-attestation.json"
      }
    }
  };
  writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(manifest));
  return manifest;
}

test("a fully evidenced synthetic world is READY, and single regressions fail closed", async () => {
  const { evaluateReleaseReadiness } = await readinessLib();
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-"));
  try {
    const manifest = syntheticWorld(root);
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    const ready = evaluateReleaseReadiness(root, now);
    assert.equal(
      ready.ready,
      true,
      JSON.stringify(ready.gates.filter((gate: { status: string }) => gate.status !== "pass"))
    );

    // Stale lifecycle receipt: freshness is part of the gate.
    const staleNow = Date.parse("2026-10-01T00:00:00.000Z");
    const stale = evaluateReleaseReadiness(root, staleNow);
    const lifecycle = stale.gates.find((gate: { id: string }) => gate.id === "r2-lifecycle");
    assert.equal(lifecycle.status, "fail");
    assert.match(lifecycle.reasons[0], /older than 30 days/);

    // Editing the promised surface without re-approving turns the pin red.
    writeFileSync(path.join(root, "promise.md"), "# Promise\nEdited without approval.\n");
    const drifted = evaluateReleaseReadiness(root, now);
    const pin = drifted.gates.find((gate: { id: string }) => gate.id === "compatibility-surface-pinned");
    assert.equal(pin.status, "fail");

    // A decision downgraded from approved goes red with its status named.
    manifest.decisions.claimBoundary = { status: "recommended-pending-approval" } as never;
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(manifest));
    const unapproved = evaluateReleaseReadiness(root, now);
    const decisions = unapproved.gates.find((gate: { id: string }) => gate.id === "decisions-approved");
    assert.equal(decisions.status, "fail");
    assert.match(decisions.reasons.join(" "), /claimBoundary is recommended-pending-approval/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the calibration gate fails closed when no eligible study exists", async () => {
  const { evaluateReleaseReadiness } = await readinessLib();
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-cal-"));
  try {
    writeFileSync(
      path.join(root, "RELEASE_READINESS.json"),
      JSON.stringify({
        schemaVersion: 1,
        artifactKind: "site-behavior-release-readiness-manifest",
        decisions: {},
        gates: {
          "detector-calibration": {
            kind: "calibration",
            title: "calibration",
            requiredDetectors: ["pixel-events"]
          }
        }
      })
    );
    const result = evaluateReleaseReadiness(root);
    assert.equal(result.ready, false);
    assert.match(result.gates[0].reasons.join(" "), /pixel-events|unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator attestations refuse soft truths and mismatched gate ids", async () => {
  const { operatorAttestationIssues } = await readinessLib();
  const clean = attestation("egress-backstop");
  assert.deepEqual(operatorAttestationIssues(clean, "egress-backstop"), []);

  const soft = attestation("egress-backstop");
  (soft.statements[0] as Record<string, unknown>).true = "yes";
  assert.equal(
    operatorAttestationIssues(soft, "egress-backstop").some((issue: string) => /literally true/.test(issue)),
    true
  );

  assert.equal(
    operatorAttestationIssues(clean, "durable-soak").some((issue: string) => /gateId/.test(issue)),
    true
  );
});
