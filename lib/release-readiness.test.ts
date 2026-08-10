import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runFixtureGit } from "./git-fixture";
import { corpusCohortIdentityForView } from "./corpus-cohort";
import {
  makePublicSingleReportV2R2,
  makeSupportingPairInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { toReportView } from "./scan-report-view";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, (...args: any[]) => any>;
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ScriptExports>;

function script(name: string) {
  return nativeImport(pathToFileURL(path.join(process.cwd(), "scripts", name)).href);
}

const RELEASE_GOVERNANCE_REPOSITORY =
  "iAnonymous3000/site-behavior-lab";

async function releaseGovernanceFixture(
  repository = RELEASE_GOVERNANCE_REPOSITORY
) {
  const governanceLib = await script(
    "release-tag-governance-receipt-lib.mjs"
  );
  const owner = repository.split("/")[0];
  const capturedAt = "2026-08-01T01:02:03.000Z";
  const releaseApp = {
    clientId: "Iv23releaseclient123",
    integrationId: 111,
    slug: "site-behavior-release",
    permissions: { contents: "write", metadata: "read" },
    events: [],
    installation: {
      id: 1111,
      accountLogin: owner,
      accountType: "User",
      repositorySelection: "selected",
      proofKind: "app-jwt-full-installation-repository-enumeration",
      repositories: [repository]
    }
  };
  const promotionApp = {
    clientId: "Iv23promotionclient1",
    integrationId: 222,
    slug: "site-behavior-promotion",
    permissions: { contents: "write", metadata: "read" },
    events: [],
    installation: {
      id: 2222,
      accountLogin: owner,
      accountType: "User",
      repositorySelection: "selected",
      proofKind: "app-jwt-full-installation-repository-enumeration",
      repositories: [repository]
    }
  };
  const ruleset = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    name: "fixture",
    target: "branch",
    source_type: "Repository",
    source: repository,
    enforcement: "active",
    conditions: {
      ref_name: { exclude: [], include: ["refs/heads/production"] }
    },
    rules: [{ type: "non_fast_forward" }],
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T01:00:00Z",
    bypass_actors: [],
    ...overrides
  });
  const requiredJobs = JSON.parse(
    readFileSync(
      path.join(process.cwd(), ".github", "required-ci-jobs.json"),
      "utf8"
    )
  ).jobs as string[];
  const receipt = governanceLib.buildReleaseTagGovernanceReceipt({
    repository,
    capturedAt,
    releaseApp,
    promotionApp,
    secretScope: {
      name: "RELEASE_APP_PRIVATE_KEY",
      observedAt: capturedAt,
      scopeKind: "point-in-time-name-inventory",
      environment: "release-tag",
      environmentPresent: true,
      repositoryPresent: false,
      ownerLogin: owner,
      ownerType: "User",
      organizationPresent: null
    },
    immutableTags: ruleset({
      id: 20050122,
      name: "Protect immutable release tags",
      target: "tag",
      conditions: {
        ref_name: { exclude: [], include: ["refs/tags/v*"] }
      },
      rules: [{ type: "deletion" }, { type: "update" }]
    }),
    tagCreation: ruleset({
      id: 20060001,
      name: "Restrict release tag creation",
      target: "tag",
      conditions: {
        ref_name: { exclude: [], include: ["refs/tags/v*"] }
      },
      rules: [{ type: "creation" }],
      bypass_actors: [
        {
          actor_id: releaseApp.integrationId,
          actor_type: "Integration",
          bypass_mode: "always"
        }
      ]
    }),
    productionEvidence: ruleset({
      id: 20050303,
      name: "Protect production evidence",
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "required_linear_history" },
        {
          type: "required_status_checks",
          parameters: {
            do_not_enforce_on_create: false,
            required_status_checks: requiredJobs.map((context) => ({
              context,
              integration_id: 15368
            })),
            strict_required_status_checks_policy: false
          }
        }
      ]
    }),
    productionUpdater: ruleset({
      id: 20050309,
      name: "Restrict production updates to promoter App",
      rules: [{ type: "update" }],
      bypass_actors: [
        {
          actor_id: promotionApp.integrationId,
          actor_type: "Integration",
          bypass_mode: "always"
        }
      ]
    })
  });
  const bytes = governanceLib.serializeReleaseTagGovernanceReceipt(receipt);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    receipt,
    bytes,
    digest,
    path: governanceLib.releaseTagGovernanceReceiptPath(digest)
  };
}

function testGit(root: string, args: string[], env: Record<string, string> = {}) {
  return runFixtureGit(root, args, env).trim();
}

// The runtime container image builds from a git-less context by design (.git
// never enters the Docker build context), so inside the image's `npm run
// check` the repository head is unavailable. State that environmental
// precondition as an explicit skip; every host lane runs the gated test.
const repositoryHeadSkip = (() => {
  try {
    testGit(process.cwd(), ["rev-parse", "HEAD"]);
    return false as const;
  } catch {
    return "the build context has no .git, so the repository head is unavailable; host lanes run this test";
  }
})();

const EXPECTED_GATES: Record<string, string> = {
  "decisions-approved": "decisions",
  "release-tag-governance": "release-tag-governance",
  "measurement-candidate-binding": "measurement-candidate-binding",
  "measurement-freeze": "measurement-freeze",
  "compatibility-surface-pinned": "document-digest",
  "errata-resolution": "errata",
  "current-method-corpus": "corpus",
  "legal-review": "review-ledger",
  "runner-cycles": "runner-receipts",
  "controlled-publications": "controlled-publications",
  "r2-lifecycle": "lifecycle-receipt",
  "release-receipt-archive": "receipt-archive",
  "durable-soak": "durable-soak",
  "egress-backstop": "operator-attestation",
  "waf-ceilings": "operator-attestation",
  "log-retention": "operator-attestation",
  "container-image-licensing": "operator-attestation",
  "container-package-review": "container-package-review"
};
const EXPECTED_DECISIONS = [
  "claimBoundary",
  "stableApiClaim",
  "compatibilitySurface",
  "reportRevisionR3",
  "calibrationCensoringPolicy",
  "wasmReproducibility"
];
// The lean 1.0 fork: these evidence programs gate the 1.1 calibrated-claims
// release. Restoring either to EXPECTED_GATES and manifest.gates is the
// reviewed enforcement edit that reverses the fork.
const DEFERRED_GATES: Record<string, string> = {
  "aa-repeatability": "aa-study",
  "detector-calibration": "calibration"
};

test("the committed manifest is NOT READY, every gate is pinned by id and kind, and only evidenced gates are green", async () => {
  const { evaluateReleaseReadiness } = await script("release-readiness-lib.mjs");
  // Evaluated AS OF a frozen instant so freshness windows cannot redden CI by
  // calendar: this pins the evaluator over committed evidence, and staleness
  // enforcement is exercised by the synthetic tests below. Bump the instant
  // whenever new evidence lands.
  const AS_OF = Date.parse("2026-08-03T00:00:00.000Z");
  const result = evaluateReleaseReadiness(process.cwd(), AS_OF);
  assert.equal(result.ready, false);
  assert.deepEqual(result.manifestProblems, []);

  // Pin the full governance surface: every gate id, its kind, and its status.
  // Repurposing a gate (changing its kind) or weakening the set moves THIS.
  const gates = new Map(
    result.gates.map((gate: { id: string; kind: string; status: string }) => [gate.id, gate])
  );
  assert.deepEqual([...gates.keys()].sort(), Object.keys(EXPECTED_GATES).sort());
  // Gates whose evidence lands through WORKFLOW-GENERATED proposal PRs
  // (receipt archive, corpus regeneration) get kind-only pins: a generated
  // proposal cannot carry the pin move its own CI would need, so a status
  // assertion here would redden every such proposal on arrival. Their
  // fail-closed behavior is pinned by the synthetic tests below. Every other
  // gate's evidence is hand-committed, so its flip rides the same PR that
  // moves this pin.
  const automationLanded = new Set(["release-receipt-archive", "current-method-corpus"]);
  // Hand-committed evidence that has actually landed. Every flip moves here.
  const evidenced = new Set([
    "compatibility-surface-pinned",
    "decisions-approved",
    "errata-resolution"
  ]);
  for (const [id, kind] of Object.entries(EXPECTED_GATES)) {
    const gate = gates.get(id) as { kind: string; status: string };
    assert.equal(gate.kind, kind, `${id} kind`);
    if (automationLanded.has(id)) continue;
    assert.equal(gate.status, evidenced.has(id) ? "pass" : "fail", `${id} status`);
  }
  const releaseGovernance = gates.get("release-tag-governance") as {
    reasons: string[];
  };
  assert.equal(
    releaseGovernance.reasons.some((reason) =>
      /RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256 must select/.test(reason)
    ),
    true
  );
  assert.equal(
    releaseGovernance.reasons.some((reason) =>
      /does not preserve the exclusive promotion App client-id\/App-id migration path/.test(reason)
    ),
    false
  );

  // Pin the governed decision set: deleting a decision must stay visible.
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(
    readFileSync(path.join(process.cwd(), "RELEASE_READINESS.json"), "utf8")
  );
  assert.equal(
    manifest.gates["release-tag-governance"].maxAgeDays,
    1,
    "release governance secret-scope capture must expire after one day"
  );
  assert.deepEqual(manifest.gates["release-tag-governance"].digestBinding, {
    kind: "github-actions-prepare-snapshot",
    name: "RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256"
  });
  assert.equal(
    manifest.gates["runner-cycles"].expectedEnvironment,
    null,
    "the candidate cannot invent the not-yet-reviewed controlled runner environment"
  );
  assert.deepEqual(Object.keys(manifest.decisions).sort(), [...EXPECTED_DECISIONS].sort());
  assert.deepEqual(
    [...manifest.gates["decisions-approved"].requiredDecisions].sort(),
    [...EXPECTED_DECISIONS].sort()
  );
  // The deferred record is governance surface too: deleting it, un-deferring
  // silently, or retargeting it away from 1.1.0 must move this pin.
  assert.deepEqual(
    Object.keys(manifest.deferredGates).sort(),
    Object.keys(DEFERRED_GATES).sort()
  );
  for (const [id, kind] of Object.entries(DEFERRED_GATES)) {
    assert.equal(manifest.deferredGates[id].kind, kind, `${id} deferred kind`);
    assert.equal(manifest.deferredGates[id].deferredTo, "1.1.0", `${id} deferredTo`);
    assert.equal(manifest.deferredGates[id].deferredBy, "iAnonymous3000", `${id} deferredBy`);
    assert.equal(
      manifest.deferredGates[id].deferredAt,
      "2026-08-02T22:10:00.000Z",
      `${id} deferredAt`
    );
    assert.equal(
      typeof manifest.deferredGates[id].reason === "string" &&
        manifest.deferredGates[id].reason.length > 0,
      true,
      `${id} deferral reason`
    );
    assert.equal(id in manifest.gates, false, `${id} must not also be a live gate`);
  }
  // The deferred gate bodies must survive intact so restoring either gate is
  // a pin move, not a reconstruction.
  assert.deepEqual(manifest.deferredGates["detector-calibration"].requiredDetectors, [
    "keystroke-exfiltration",
    "pixel-events",
    "consent-banner",
    "fingerprint-heuristics",
    "cname-uncloaking",
    "privacy-policy"
  ]);
  assert.equal(
    manifest.deferredGates["aa-repeatability"].directory,
    "research/aa-studies"
  );
  assert.equal(
    manifest.gates["measurement-candidate-binding"].requiredEvidenceCategories.includes(
      "operator-evidence"
    ),
    true
  );
  assert.deepEqual(
    Object.fromEntries(
      [
        "egress-backstop",
        "waf-ceilings",
        "log-retention",
        "container-image-licensing"
      ].map((id) => [id, manifest.gates[id].evidence])
    ),
    {
      "egress-backstop": "research/ops-evidence/egress-backstop.json",
      "waf-ceilings": "research/ops-evidence/waf-ceilings.json",
      "log-retention": "research/ops-evidence/log-retention.json",
      "container-image-licensing":
        "research/ops-evidence/container-image-licensing.json"
    }
  );
  assert.equal(
    Object.hasOwn(
      manifest.decisions.calibrationCensoringPolicy,
      "recommended"
    ),
    false
  );
  assert.match(
    manifest.decisions.calibrationCensoringPolicy.methodologicalAssessment,
    /not a recommendation to approve or use it/
  );
  assert.match(
    manifest.notice,
    /release workflow for exact 1\.0\.0 and 1\.0\.0-rc\.N/
  );
  assert.doesNotMatch(manifest.notice, /advisory|until then/i);
});

test("release readiness CLI requires the trusted freeze context and digest together", () => {
  const cli = path.join(process.cwd(), "scripts", "release-readiness.mjs");
  for (const args of [
    ["--report", "--live-artifact-context", "/tmp/freeze-context"],
    [
      "--report",
      "--live-artifact-context",
      "/tmp/freeze-context",
      "--live-artifact-context-sha256",
      "not-a-digest"
    ]
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});

test("release readiness propagates an explicit trusted freeze context into candidate verification", async () => {
  const { measurementCandidateBindingVerificationOptions } = await script(
    "release-readiness-lib.mjs"
  );
  const source = readFileSync(
    path.join(process.cwd(), "scripts", "release-readiness-lib.mjs"),
    "utf8"
  );
  const directory = path.resolve(
    tmpdir(),
    "site-behavior-lab-freeze-artifact-context"
  );
  const sha256 = "a".repeat(64);
  assert.deepEqual(
    measurementCandidateBindingVerificationOptions({
      liveArtifactContext: directory,
      liveArtifactContextSha256: sha256
    }),
    {
      freezeArtifactContext: {
        directory,
        sha256
      }
    }
  );
  assert.deepEqual(measurementCandidateBindingVerificationOptions({}), {});
  assert.throws(
    () =>
      measurementCandidateBindingVerificationOptions({
        liveArtifactContext: directory
      }),
    /must be supplied together/
  );
  assert.throws(
    () =>
      measurementCandidateBindingVerificationOptions({
        liveArtifactContext: "relative/context",
        liveArtifactContextSha256: sha256
      }),
    /absolute path/
  );
  assert.match(
    source,
    /bindingModule\.verifiedMeasurementCandidateBinding\(\s*rootDir,\s*measurementCandidateBindingVerificationOptions\(options\)\s*\)/
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

function errataDispositionDigest(gate: Record<string, unknown>) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        requiredErrata: gate.requiredErrata,
        resolution: gate.resolution,
        document: gate.document,
        sha256: gate.sha256,
        resolvedBy: gate.resolvedBy,
        requiredSelection: gate.requiredSelection
      })
    )
    .digest("hex");
}

const SYNTHETIC_ATTESTATION_CONTRACTS: Record<
  string,
  {
    requiredClaims: { id: string; claim: string }[];
    requiredBindings: string[];
    minimumEvidenceHours?: number;
  }
> = {
  "durable-soak": {
    requiredClaims: [
      { id: "replay-passed", claim: "Both replay modes passed." },
      { id: "restart-observed", claim: "A real restart recovered queued work." }
    ],
    requiredBindings: ["candidateCommit", "deploymentDigest"],
    minimumEvidenceHours: 24
  },
  "egress-backstop": {
    requiredClaims: [
      { id: "independent-boundary", claim: "An independent boundary blocked forbidden destinations." }
    ],
    requiredBindings: ["candidateCommit", "networkPolicyDigest"]
  }
};

function attestation(gateId: string, attestedAt = "2026-08-09T00:00:00.000Z") {
  const contract = SYNTHETIC_ATTESTATION_CONTRACTS[gateId] ?? SYNTHETIC_ATTESTATION_CONTRACTS["egress-backstop"];
  const bindings = Object.fromEntries(
    contract.requiredBindings.map((name) => [
      name,
      name.endsWith("Commit") ? "a".repeat(40) : name.endsWith("Digest") ? "b".repeat(64) : "subject"
    ])
  );
  return {
    kind: "site-behavior-operator-attestation",
    gateId,
    targetRelease: "1.0.0",
    attestedBy: "iAnonymous3000",
    attestedAt,
    evidenceCapturedAt: "2026-08-09T00:00:00.000Z",
    bindings,
    statements: contract.requiredClaims.map((entry) => ({
      claimId: entry.id,
      claim: entry.claim,
      true: true
    })),
    evidenceRefs: [`actions-run-${gateId}`],
    ...(contract.minimumEvidenceHours
      ? {
          evidenceWindow: {
            startedAt: "2026-08-08T00:00:00.000Z",
            restartObservedAt: "2026-08-08T12:00:00.000Z",
            endedAt: "2026-08-09T00:00:00.000Z"
          }
        }
      : {})
  };
}

function runnerReceipt(actionsRunId: number) {
  const day = actionsRunId === 1 ? "2026-08-03" : "2026-08-10";
  const jobId = 1_000 + actionsRunId;
  const artifactId = 2_000 + actionsRunId;
  const destructionRunId = 10_000 + actionsRunId;
  const destructionJobId = 11_000 + actionsRunId;
  const destructionArtifactId = 12_000 + actionsRunId;
  const destructionArtifactSha = (
    actionsRunId === 1 ? "e" : "f"
  ).repeat(64);
  const destructionReadbackSha = (
    actionsRunId === 1 ? "c" : "d"
  ).repeat(64);
  return {
    kind: "site-behavior-controlled-runner-destruction-receipt",
    receiptVersion: 3,
    actionsRunId,
    actionsRunAttempt: 1,
    workflow: "scan-featured.yml",
    runnerLabelRef:
      "sha256:6786aaad2225cf8b2d9659dc71941110c1db9ff797ed417e6aaf6da85215f609",
    recordedAt: `${day}T08:00:00.000Z`,
    provisioning: {
      provisionedAt: `${day}T05:00:00.000Z`,
      hostImageIdentityRef:
        "sha256:d5a94e7f8eb5e312a18d3d31491990da4e7e55b9687bb35d4cf76a4f74636e40",
      singleUse: true,
      registration: {
        repository: "iAnonymous3000/site-behavior-lab",
        labelRefs: [
          "sha256:6786aaad2225cf8b2d9659dc71941110c1db9ff797ed417e6aaf6da85215f609",
          "sha256:837bb135955dd22e9d056991fba31bccf91761ffbc07d2bc6c03003ad906ad32"
        ],
        ephemeral: true
      }
    },
    runEvidence: {
      conclusion: "success",
      reportMode: "r2",
      acquisition: "ci-workflow",
      headSha: "a".repeat(40),
      catalog: "public/featured-sites.json",
      collectionDate: day,
      job: {
        id: jobId,
        name: "Populate Featured Gallery",
        startedAt: `${day}T05:23:00.000Z`,
        completedAt: `${day}T07:40:00.000Z`,
        url: `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${actionsRunId}/job/${jobId}`
      },
      artifact: {
        id: artifactId,
        name: `site-behavior-featured-publication-${actionsRunId}-1`,
        sha256: "b".repeat(64),
        url: `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${actionsRunId}/artifacts/${artifactId}`
      }
    },
    isolation: {
      cloudMetadataBlocked: true,
      controlPlaneCredentialsAbsent: true,
      persistentStateAbsent: true
    },
    egress: {
      declaredRegion: "us-east",
      natIdentityRef:
        "sha256:48aedb89df46ba5c745fd8eb856443eca6cdc963e622d471b322ad8803f47268",
      independentPolicyEnforced: true,
      blockedClasses: ["private", "link-local", "metadata"]
    },
    destruction: {
      destroyedAt: `${day}T07:45:00.000Z`,
      verifiedAbsentAt: `${day}T07:50:00.000Z`,
      method: "instance-terminate",
      verification: `sha256:${destructionReadbackSha}`
    },
    destructionEvidence: {
      workflow: ".github/workflows/runner-destruction-evidence.yml",
      runId: destructionRunId,
      runAttempt: 1,
      headSha: "a".repeat(40),
      conclusion: "success",
      job: {
        id: destructionJobId,
        name: "Read back provider destruction and absence",
        startedAt: `${day}T07:51:00.000Z`,
        completedAt: `${day}T07:55:00.000Z`,
        url: `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${destructionRunId}/job/${destructionJobId}`
      },
      artifact: {
        id: destructionArtifactId,
        name:
          `site-behavior-runner-destruction-evidence-${destructionRunId}-1`,
        sha256: destructionArtifactSha,
        url: `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${destructionRunId}/artifacts/${destructionArtifactId}`
      },
      readback: {
        path: "destruction-evidence.json",
        sha256: destructionReadbackSha
      }
    },
    operator: {
      attestedBy: "iAnonymous3000",
      evidenceRefs: [
        {
          kind: "github-actions-run-evidence",
          actionsRunId,
          runUrl: `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${actionsRunId}`,
          artifactName:
            `site-behavior-featured-publication-${actionsRunId}-1`,
          artifactRef: `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${actionsRunId}/artifacts/${artifactId}`,
          artifactSha256: "b".repeat(64)
        },
        {
          kind: "github-actions-run-evidence",
          actionsRunId: destructionRunId,
          runUrl: `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${destructionRunId}`,
          artifactName:
            `site-behavior-runner-destruction-evidence-${destructionRunId}-1`,
          artifactRef: `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${destructionRunId}/artifacts/${destructionArtifactId}`,
          artifactSha256: destructionArtifactSha
        }
      ]
    }
  };
}

const AA_BUILD = "a".repeat(40);
const AA_TARGET_FRAME = [
  { targetId: "one-example", url: "https://one.example/" }
];
const AA_TARGET_FRAME_TEXT = JSON.stringify(AA_TARGET_FRAME);
const AA_FRAME = createHash("sha256")
  .update(AA_TARGET_FRAME_TEXT)
  .digest("hex");
const AA_IDENTITY = "9".repeat(64);
const AA_SITES_FILE =
  "research/aa-studies/aa-synthetic/target-frame.json";
const AA_CONDITIONS = { device: "desktop", gpcEnabled: false, consentMode: "observe" };

function aaPreregistration() {
  return {
    kind: "site-behavior-aa-preregistration",
    studyVersion: 2,
    studyId: "aa-synthetic",
    declaredAt: "2026-08-01T00:00:00.000Z",
    measurementIdentityManifestPath:
      "research/measurement-candidate/measurement-identity.json",
    measurementIdentityDigest: AA_IDENTITY,
    sitesFile: AA_SITES_FILE,
    sitesFileDigest: AA_FRAME,
    targetCount: 1,
    repetitionsPerTarget: 2,
    conditions: AA_CONDITIONS,
    thresholds: {
      minimumEligibleTargets: 1,
      maximumFailingTargetFraction: 0,
      maximumMetricRelativeRange: {
        totalRequests: 0.25,
        thirdPartyRequests: 0.25,
        knownTrackerRequests: 0.5,
        thirdPartyDomains: 0.25
      },
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
    collection: {
      startedAt: "2026-08-02T05:00:00.000Z",
      completedAt: "2026-08-02T05:59:00.000Z"
    },
    baseOrigin: "http://127.0.0.1:3000",
    sitesFile: AA_SITES_FILE,
    conditions: AA_CONDITIONS,
    repetitions: 2,
    selectedTargets: 1,
    shardIndex: 0,
    shardCount: 1,
    attempts,
    acceptanceThresholds: { minimumAnsweringTargets: 1, minimumRepeatableTargets: 1 },
    provenance: {
      expectedBuildCommit: AA_BUILD,
      measurementIdentityDigest: AA_IDENTITY,
      sitesFileDigest: AA_FRAME,
      driverRuntime: { nodeVersion: "v24.14.1", platform: "linux", architecture: "x64" }
    }
  });
}

async function syntheticWorld(root: string) {
  const aaStudyLib = await script("aa-study-lib.mjs");
  const lifecycleLib = await script("r2-lifecycle-lib.mjs");
  const runnerReceiptLib = await script("runner-receipt-lib.mjs");
  const doc = "# Promise\nExactly these surfaces.\n";
  writeFileSync(path.join(root, "promise.md"), doc);
  const digest = createHash("sha256").update(doc).digest("hex");
  const errataDoc =
    "# Published errata\n\n**E1 (published erratum)**: first corrected statement.\n\n" +
    "**E2 (published erratum)**: second corrected statement.\n";
  writeFileSync(path.join(root, "errata.md"), errataDoc);
  const errataDigest = createHash("sha256").update(errataDoc).digest("hex");
  const errataGate = {
    kind: "errata",
    title: "errata",
    requiredErrata: ["E1", "E2"],
    resolution: "published-errata-for-1.0",
    document: "errata.md",
    sha256: errataDigest,
    resolvedBy: "reportRevisionR3",
    requiredSelection: "no-r3-for-1.0"
  };

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
  writeFileSync(
    path.join(studyDir, "target-frame.json"),
    AA_TARGET_FRAME_TEXT
  );
  const preregistration = aaPreregistration();
  const ledger = await aaLedger();
  const evaluation = aaStudyLib.evaluateAaStudy({
    preregistration,
    targetFrame: AA_TARGET_FRAME,
    targetFrameText: AA_TARGET_FRAME_TEXT,
    ledger
  });
  assert.equal(evaluation.status, "pass", JSON.stringify(evaluation.checks));
  writeFileSync(path.join(studyDir, "preregistration.json"), JSON.stringify(preregistration));
  writeFileSync(path.join(studyDir, "attempt-ledger.json"), JSON.stringify(ledger));
  writeFileSync(path.join(studyDir, "evaluation.json"), JSON.stringify(evaluation));

  writeFileSync(
    path.join(root, "reviews.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifactKind: "site-behavior-third-party-review-ledger",
      reviews: [
        {
          key: "npm:left-pad@1.0.0",
          ecosystem: "npm",
          name: "left-pad",
          version: "1.0.0",
          runtime: true,
          declaredLicense: "MIT",
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
      schemaVersion: 1,
      artifactKind: "deterministic-third-party-inventory-and-notice-evidence",
      npm: [{ name: "left-pad", version: "1.0.0", license: "MIT", developmentOnly: false }],
      cargo: [],
      filterLists: { sources: [] }
    })
  );

  mkdirSync(path.join(root, "research", "runner-receipts"), { recursive: true });
  for (const runId of [1, 2]) {
    writeFileSync(
      path.join(root, "research", "runner-receipts", `${runId}.json`),
      runnerReceiptLib.serializeRunnerDestructionReceipt(
        runnerReceipt(runId)
      )
    );
  }

  const day = 86_400;
  mkdirSync(path.join(root, "research", "ops-receipts"), { recursive: true });
  const lifecycleRules = [
    {
      id: "reports-retention-backstop-8d",
      enabled: true,
      conditions: { prefix: "reports/" },
      deleteObjectsTransition: {
        condition: { type: "Age", maxAge: 8 * day }
      }
    }
  ];
  writeFileSync(
    path.join(root, "research", "ops-receipts", "r2-lifecycle-readback.json"),
    JSON.stringify(
      lifecycleLib.buildR2LifecycleReadbackReceipt({
        bucket: "site-behavior-lab-reports",
        source: "cloudflare-api",
        recordedAt: "2026-08-09T00:00:00.000Z",
        sourceBytes: Buffer.from(
          JSON.stringify({
            success: true,
            result: { rules: lifecycleRules }
          })
        )
      })
    )
  );
  // Build a real miniature source commit and annotated tag. The archive gate
  // must prove the committed receipt against Git history, not just recognize a
  // receipt-shaped JSON object.
  const governance = await releaseGovernanceFixture();
  const governanceAbsolute = path.join(
    root,
    ...governance.path.split("/")
  );
  mkdirSync(path.dirname(governanceAbsolute), { recursive: true });
  writeFileSync(governanceAbsolute, governance.bytes);
  const measurementBindingPath = path.join(
    root,
    "research",
    "measurement-candidate-binding.json"
  );
  writeFileSync(
    measurementBindingPath,
    JSON.stringify({
      repository: RELEASE_GOVERNANCE_REPOSITORY,
      targetRelease: "1.0.0",
      evidence: [
        {
          category: "release-tag-governance-receipt",
          path: governance.path,
          change: "added",
          sha256: governance.digest
        }
      ]
    })
  );
  const sourceInputBytes = {
    packageLock: { path: "package-lock.json", bytes: "{\"lockfileVersion\":3}\n" },
    dockerfile: { path: "Dockerfile", bytes: "FROM scratch\n" },
    productionContainerConfig: { path: "wrangler.container.jsonc", bytes: "{}\n" },
    releasePolicy: { path: "release-policy.json", bytes: "{\"status\":\"released\"}\n" }
  };
  for (const input of Object.values(sourceInputBytes)) {
    writeFileSync(path.join(root, input.path), input.bytes);
  }
  testGit(root, ["init", "-q"]);
  testGit(root, ["config", "user.name", "Synthetic Release"]);
  testGit(root, ["config", "user.email", "release@example.test"]);
  testGit(root, [
    "add",
    ...Object.values(sourceInputBytes).map((input) => input.path),
    governance.path,
    "research/measurement-candidate-binding.json"
  ]);
  const releaseGitEnv = {
    GIT_AUTHOR_DATE: "2026-08-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-01T00:00:00Z"
  };
  testGit(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "Synthetic release source"], releaseGitEnv);
  const sourceCommit = testGit(root, ["rev-parse", "HEAD"]);
  const sourceTree = testGit(root, ["rev-parse", "HEAD^{tree}"]);
  const committedAt = new Date(
    Date.parse(testGit(root, ["show", "-s", "--format=%cI", sourceCommit]))
  ).toISOString();
  const inputs = Object.fromEntries(
    Object.entries(sourceInputBytes).map(([name, input]) => {
      const bytes = Buffer.from(input.bytes);
      return [
        name,
        {
          path: input.path,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex")
        }
      ];
    })
  );
  const staticFileBytes = Buffer.from("<h1>release</h1>\n");
  const staticFiles = [
    {
      path: "index.html",
      bytes: staticFileBytes.length,
      sha256: createHash("sha256").update(staticFileBytes).digest("hex")
    }
  ];
  const archivedReceipt = {
    schemaVersion: 1,
    evidenceKind: "exact-source-and-tested-artifact-manifest",
    release: {
      status: "released",
      version: "0.3.0",
      tag: "v0.3.0",
      releaseDate: "2026-08-01",
      stablePublicApi: false,
      npmPublication: "disabled",
      requiredNode: "24.14.1",
      requiredNpm: "11.11.0",
      repository: "https://github.com/iAnonymous3000/site-behavior-lab",
      tagExists: false,
      evidencesReleaseCommit: false
    },
    source: {
      repository: "https://github.com/iAnonymous3000/site-behavior-lab",
      commit: sourceCommit,
      tree: sourceTree,
      requiredNode: "24.14.1",
      requiredNpm: "11.11.0"
    },
    inputs,
    artifacts: [
      {
        name: "static-pages",
        kind: "directory-manifest",
        path: "out",
        deployment: {
          schemaVersion: 1,
          deployment: sourceCommit,
          revisionCommittedAt: committedAt
        },
        digestAlgorithm: "sha256",
        manifestSha256: createHash("sha256").update(JSON.stringify(staticFiles)).digest("hex"),
        fileCount: staticFiles.length,
        bytes: staticFileBytes.length,
        files: staticFiles
      }
    ]
  };
  const archivedReceiptBytes = JSON.stringify(archivedReceipt);
  const archivedReceiptPath = path.join(
    root,
    "docs",
    "release-receipts",
    "0.3.0",
    "release-receipt.json"
  );
  mkdirSync(path.dirname(archivedReceiptPath), { recursive: true });
  writeFileSync(archivedReceiptPath, archivedReceiptBytes);
  const archivedReceiptSha256 = createHash("sha256").update(archivedReceiptBytes).digest("hex");
  testGit(
    root,
    [
      "-c",
      "tag.gpgSign=false",
      "tag",
      "-a",
      "v0.3.0",
      "-m",
      `Synthetic release\n\nRelease receipt sha256: ${archivedReceiptSha256}`,
      sourceCommit
    ],
    releaseGitEnv
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
      compatibilitySurface: approvedDecision({ document: "promise.md", sha256: digest }),
      reportRevisionR3: approvedDecision({
        recommended: "no-r3-for-1.0",
        selected: "no-r3-for-1.0",
        dispositionSha256: errataDispositionDigest(errataGate)
      })
    },
    gates: {
      "decisions-approved": {
        kind: "decisions",
        title: "decisions",
        requiredDecisions: ["claimBoundary", "compatibilitySurface"]
      },
      "compatibility-surface-pinned": { kind: "document-digest", title: "digest" },
      "errata-resolution": errataGate,
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
        minimumReceipts: 2,
        expectedEnvironment:
          runnerReceiptLib.runnerDestructionEnvironmentTuple(
            runnerReceipt(1)
          )
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

test("release readiness derives the runner environment pin and rejects drift end to end", async () => {
  const { evaluateReleaseReadiness } = await script("release-readiness-lib.mjs");
  const {
    runnerDestructionEnvironmentTuple,
    serializeRunnerDestructionReceipt
  } = await script("runner-receipt-lib.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-runner-pin-"));
  try {
    const receiptDirectory = path.join(root, "research", "runner-receipts");
    mkdirSync(receiptDirectory, { recursive: true });
    for (const runId of [1, 2]) {
      writeFileSync(
        path.join(receiptDirectory, `${runId}.json`),
        serializeRunnerDestructionReceipt(runnerReceipt(runId))
      );
    }
    const expectedEnvironment =
      runnerDestructionEnvironmentTuple(runnerReceipt(1));
    const manifest = {
      schemaVersion: 1,
      artifactKind: "site-behavior-release-readiness-manifest",
      targetRelease: "1.0.0",
      gates: {
        "runner-cycles": {
          kind: "runner-receipts",
          title: "runner",
          directory: "research/runner-receipts",
          minimumReceipts: 2,
          expectedEnvironment,
          maxAgeDays: 45
        }
      }
    };
    writeFileSync(
      path.join(root, "RELEASE_READINESS.json"),
      JSON.stringify(manifest)
    );
    const matching = evaluateReleaseReadiness(root, NOW);
    const matchingGate = matching.gates.find(
      (gate: { id: string }) => gate.id === "runner-cycles"
    );
    assert.equal(matchingGate?.status, "pass", matchingGate?.reasons.join("; "));

    const {
      expectedEnvironment: omittedExpectedEnvironment,
      ...runnerWithoutExpectedEnvironment
    } = manifest.gates["runner-cycles"];
    assert.deepEqual(omittedExpectedEnvironment, expectedEnvironment);
    writeFileSync(
      path.join(root, "RELEASE_READINESS.json"),
      JSON.stringify({
        ...manifest,
        gates: {
          ...manifest.gates,
          "runner-cycles": runnerWithoutExpectedEnvironment
        }
      })
    );
    const omitted = evaluateReleaseReadiness(root, NOW);
    const omittedGate = omitted.gates.find(
      (gate: { id: string }) => gate.id === "runner-cycles"
    );
    assert.equal(omittedGate?.status, "fail");
    assert.match(
      omittedGate?.reasons.join(" ") ?? "",
      /gate config: expectedEnvironment must be an object/
    );

    manifest.gates["runner-cycles"].expectedEnvironment = {
      ...expectedEnvironment,
      natIdentityRef:
        "sha256:5b59d1e92464c5fbc0a1bf9f8afc9c901a1ffe7d2283511894e767e5e933c0b9"
    };
    writeFileSync(
      path.join(root, "RELEASE_READINESS.json"),
      JSON.stringify(manifest)
    );
    const drifted = evaluateReleaseReadiness(root, NOW);
    const driftedGate = drifted.gates.find(
      (gate: { id: string }) => gate.id === "runner-cycles"
    );
    assert.equal(driftedGate?.status, "fail");
    assert.match(
      driftedGate?.reasons.join(" ") ?? "",
      /does not match the candidate-owned expectedEnvironment/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("calibration approval binds one fixed policy artifact and semantic disposition", async () => {
  const { evaluateReleaseReadiness } = await script("release-readiness-lib.mjs");
  const { calibrationPolicyDispositionSha256 } = await script(
    "calibration-study-lib.mjs"
  );
  const CALIBRATION_CENSORING_POLICY_ID =
    "complete-case-only-zero-censoring";
  const CALIBRATION_CENSORING_POLICY_PATH =
    "research/measurement-candidate/calibration-censoring-policy.json";
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-calibration-decision-"));
  try {
    const manifest = await syntheticWorld(root);
    const decisions = manifest.decisions as unknown as Record<
      string,
      Record<string, unknown>
    >;
    const policy = `${JSON.stringify(
      {
        schemaVersion: 1,
        artifactKind: "site-behavior-detector-calibration-censoring-policy",
        id: CALIBRATION_CENSORING_POLICY_ID,
        allowedReasons: [
          "capture-failed",
          "reference-label-uncertain",
          "artifact-unreadable",
          "eligibility-criteria-not-met"
        ],
        releaseEligibility: {
          anyCensoredCase: "study-ineligible",
          plannedDenominator: "must-remain-complete"
        }
      },
      null,
      2
    )}\n`;
    const policyAbsolute = path.join(
      root,
      ...CALIBRATION_CENSORING_POLICY_PATH.split("/")
    );
    mkdirSync(path.dirname(policyAbsolute), { recursive: true });
    writeFileSync(policyAbsolute, policy);
    const policySha256 = createHash("sha256").update(policy).digest("hex");
    decisions.calibrationCensoringPolicy = approvedDecision({
      currentlySupportedSelections: [CALIBRATION_CENSORING_POLICY_ID],
      recommendedDisposition: "human-decision-required-before-labeling",
      methodologicalAssessment:
        "Supported by the current analyzer; not a recommendation to approve or use it.",
      selected: CALIBRATION_CENSORING_POLICY_ID,
      policyArtifactPath: CALIBRATION_CENSORING_POLICY_PATH,
      policyArtifactSha256: policySha256,
      semanticDisposition: {
        anyCensoredCase: "study-ineligible",
        plannedDenominator: "must-remain-complete"
      },
      dispositionSha256:
        calibrationPolicyDispositionSha256(policySha256)
    });
    manifest.gates["decisions-approved"].requiredDecisions.push(
      "calibrationCensoringPolicy"
    );
    writeFileSync(
      path.join(root, "RELEASE_READINESS.json"),
      JSON.stringify(manifest)
    );
    const approved = evaluateReleaseReadiness(root, NOW);
    assert.equal(
      approved.gates.find(
        (gate: { id: string }) => gate.id === "decisions-approved"
      )?.status,
      "pass"
    );

    decisions.calibrationCensoringPolicy.dispositionSha256 = "0".repeat(64);
    writeFileSync(
      path.join(root, "RELEASE_READINESS.json"),
      JSON.stringify(manifest)
    );
    const substituted = evaluateReleaseReadiness(root, NOW);
    const decisionGate = substituted.gates.find(
      (gate: { id: string }) => gate.id === "decisions-approved"
    );
    assert.equal(decisionGate?.status, "fail");
    assert.match(
      decisionGate?.reasons.join(" ") ?? "",
      /calibrationCensoringPolicy dispositionSha256/
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

    // An approval cannot be dated in the future.
    const futureDecision = JSON.parse(JSON.stringify(manifest));
    futureDecision.decisions.claimBoundary.decidedAt = "2027-01-01T00:00:00.000Z";
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(futureDecision));
    const futureDecisionGate = byId(evaluateReleaseReadiness(root, NOW), "decisions-approved");
    assert.equal(futureDecisionGate.status, "fail");
    assert.match(futureDecisionGate.reasons.join(" "), /future/);

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
      (
        await script("runner-receipt-lib.mjs")
      ).serializeRunnerDestructionReceipt(runnerReceipt(1))
    );
    const dupes = byId(evaluateReleaseReadiness(root, NOW), "runner-cycles");
    assert.equal(dupes.status, "fail");
    assert.match(dupes.reasons.join(" "), /duplicates|distinct/);
    writeFileSync(
      path.join(root, "research", "runner-receipts", "2.json"),
      (
        await script("runner-receipt-lib.mjs")
      ).serializeRunnerDestructionReceipt(runnerReceipt(2))
    );
    writeFileSync(
      path.join(root, "research", "runner-receipts", "malformed.json"),
      '{"kind":"not-a-runner-receipt"}\n'
    );
    const malformedRunnerReceipt = byId(evaluateReleaseReadiness(root, NOW), "runner-cycles");
    assert.equal(malformedRunnerReceipt.status, "fail");
    assert.match(malformedRunnerReceipt.reasons.join(" "), /malformed\.json/);
    rmSync(path.join(root, "research", "runner-receipts", "malformed.json"));

    // A lifecycle receipt whose ok flag disagrees with its recorded rules fails.
    const receiptPath = path.join(root, "research", "ops-receipts", "r2-lifecycle-readback.json");
    const validLifecycleReceipt = JSON.parse(
      readFileSync(receiptPath, "utf8")
    );
    writeFileSync(
      receiptPath,
      JSON.stringify({ ...validLifecycleReceipt, ok: false })
    );
    const flipped = byId(evaluateReleaseReadiness(root, NOW), "r2-lifecycle");
    assert.equal(flipped.status, "fail");
    assert.match(
      flipped.reasons.join(" "),
      /ok must exactly match re-validation|receiptDigest/
    );

    // A future-dated receipt is invalid, not eternally fresh.
    writeFileSync(
      receiptPath,
      JSON.stringify({
        ...validLifecycleReceipt,
        recordedAt: "2027-01-01T00:00:00.000Z",
      })
    );
    const future = byId(evaluateReleaseReadiness(root, NOW), "r2-lifecycle");
    assert.equal(future.status, "fail");
    assert.match(future.reasons.join(" "), /future/);

    // Malformed gate config fails closed: empty metric list, stringy errata.
    const doctored = JSON.parse(JSON.stringify(manifest));
    doctored.gates["current-method-corpus"].requiredMetrics = [];
    doctored.gates["errata-resolution"].requiredErrata = "E1, E2";
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(doctored));
    const doctoredResult = evaluateReleaseReadiness(root, NOW);
    assert.equal(byId(doctoredResult, "current-method-corpus").status, "fail");
    assert.equal(byId(doctoredResult, "errata-resolution").status, "fail");

    // Errata cannot be cleared by deleting ids, approving no selection, or
    // changing the published bytes without moving the digest.
    for (const mutation of [
      (value: typeof manifest) => {
        value.gates["errata-resolution"].requiredErrata = [];
      },
      (value: typeof manifest) => {
        value.gates["errata-resolution"].requiredErrata = ["E1"];
      },
      (value: typeof manifest) => {
        (value.decisions.reportRevisionR3 as Record<string, unknown>).selected = null;
      },
      (value: typeof manifest) => {
        value.gates["errata-resolution"].sha256 = "0".repeat(64);
      }
    ]) {
      const malformed = JSON.parse(JSON.stringify(manifest));
      mutation(malformed);
      writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(malformed));
      const errata = byId(evaluateReleaseReadiness(root, NOW), "errata-resolution");
      assert.equal(errata.status, "fail");
    }

    // Moving the errata document and its gate digest together still requires
    // a fresh human disposition digest.
    const changedErrataDoc =
      "# Published errata\n\n**E1 (published erratum)**: revised first statement.\n\n" +
      "**E2 (published erratum)**: second corrected statement.\n";
    const changedErrata = JSON.parse(JSON.stringify(manifest));
    changedErrata.gates["errata-resolution"].sha256 = createHash("sha256")
      .update(changedErrataDoc)
      .digest("hex");
    writeFileSync(path.join(root, "errata.md"), changedErrataDoc);
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(changedErrata));
    const movedDisposition = byId(evaluateReleaseReadiness(root, NOW), "errata-resolution");
    assert.equal(movedDisposition.status, "fail");
    assert.match(movedDisposition.reasons.join(" "), /approve disposition sha256/);
    writeFileSync(
      path.join(root, "errata.md"),
      "# Published errata\n\n**E1 (published erratum)**: first corrected statement.\n\n" +
        "**E2 (published erratum)**: second corrected statement.\n"
    );

    // A nonempty arbitrary JSON file is not a release receipt.
    writeFileSync(
      path.join(root, "RELEASE_READINESS.json"),
      JSON.stringify(manifest)
    );
    const archivePath = path.join(root, "docs", "release-receipts", "0.3.0", "release-receipt.json");
    const validArchiveBytes = readFileSync(archivePath);
    writeFileSync(archivePath, JSON.stringify({ anything: true }));
    const fakeArchive = byId(evaluateReleaseReadiness(root, NOW), "release-receipt-archive");
    assert.equal(fakeArchive.status, "fail");
    assert.match(fakeArchive.reasons.join(" "), /schemaVersion|evidenceKind/);
    writeFileSync(archivePath, validArchiveBytes);

    const wrongInputArchive = JSON.parse(validArchiveBytes.toString("utf8"));
    wrongInputArchive.inputs.packageLock.sha256 = "0".repeat(64);
    writeFileSync(archivePath, JSON.stringify(wrongInputArchive));
    const wrongInput = byId(evaluateReleaseReadiness(root, NOW), "release-receipt-archive");
    assert.equal(wrongInput.status, "fail");
    assert.match(wrongInput.reasons.join(" "), /packageLock does not match/);
    writeFileSync(archivePath, validArchiveBytes);

    const wrongTreeArchive = JSON.parse(validArchiveBytes.toString("utf8"));
    wrongTreeArchive.source.tree = "0".repeat(40);
    writeFileSync(archivePath, JSON.stringify(wrongTreeArchive));
    const wrongTree = byId(evaluateReleaseReadiness(root, NOW), "release-receipt-archive");
    assert.equal(wrongTree.status, "fail");
    assert.match(wrongTree.reasons.join(" "), /source\.tree does not match/);
    writeFileSync(archivePath, validArchiveBytes);

    const unboundArchive = JSON.parse(validArchiveBytes.toString("utf8"));
    unboundArchive.release.releaseDate = "2026-08-02";
    writeFileSync(archivePath, JSON.stringify(unboundArchive));
    const wrongTagDigest = byId(evaluateReleaseReadiness(root, NOW), "release-receipt-archive");
    assert.equal(wrongTagDigest.status, "fail");
    assert.match(wrongTagDigest.reasons.join(" "), /does not embed the archived receipt sha256/);
    writeFileSync(archivePath, validArchiveBytes);

    testGit(root, ["tag", "-d", "v0.3.0"]);
    const missingTag = byId(evaluateReleaseReadiness(root, NOW), "release-receipt-archive");
    assert.equal(missingTag.status, "fail");
    assert.match(missingTag.reasons.join(" "), /must be an available annotated tag/);
    const validArchiveSha256 = createHash("sha256").update(validArchiveBytes).digest("hex");
    testGit(root, [
      "-c",
      "tag.gpgSign=false",
      "tag",
      "-a",
      "v0.3.0",
      "-m",
      `Synthetic release\n\nRelease receipt sha256: ${validArchiveSha256}`,
      testGit(root, ["rev-parse", "HEAD"])
    ]);

    // Schema v2 adds the ceremony-selected governance receipt digest to the
    // attested receipt. The selected content-addressed receipt and its add-only
    // candidate binding both exist in source.commit; the annotated tag carries
    // the same selection.
    const sourceBinding = JSON.parse(
      readFileSync(
        path.join(
          root,
          "research",
          "measurement-candidate-binding.json"
        ),
        "utf8"
      )
    );
    const governanceDigest = sourceBinding.evidence[0].sha256 as string;
    const governanceBoundArchive = {
      ...JSON.parse(validArchiveBytes.toString("utf8")),
      schemaVersion: 2,
      releaseTagGovernanceReceiptSha256: governanceDigest
    };
    const governanceBoundBytes = Buffer.from(
      JSON.stringify(governanceBoundArchive)
    );
    writeFileSync(archivePath, governanceBoundBytes);
    const governanceBoundSha256 = createHash("sha256")
      .update(governanceBoundBytes)
      .digest("hex");
    testGit(root, ["tag", "-d", "v0.3.0"]);
    testGit(root, [
      "-c",
      "tag.gpgSign=false",
      "tag",
      "-a",
      "v0.3.0",
      "-m",
      `Synthetic release\n\nRelease receipt sha256: ${governanceBoundSha256}\nRelease governance receipt sha256: ${governanceDigest}`,
      testGit(root, ["rev-parse", "HEAD"])
    ]);
    const governanceBound = byId(
      evaluateReleaseReadiness(root, NOW),
      "release-receipt-archive"
    );
    assert.equal(governanceBound.status, "pass");

    const missingGovernanceDigest = "a".repeat(64);
    const missingGovernanceArchive = {
      ...governanceBoundArchive,
      releaseTagGovernanceReceiptSha256: missingGovernanceDigest
    };
    const missingGovernanceBytes = Buffer.from(
      JSON.stringify(missingGovernanceArchive)
    );
    writeFileSync(archivePath, missingGovernanceBytes);
    const missingGovernanceArchiveSha256 = createHash("sha256")
      .update(missingGovernanceBytes)
      .digest("hex");
    testGit(root, ["tag", "-d", "v0.3.0"]);
    testGit(root, [
      "-c",
      "tag.gpgSign=false",
      "tag",
      "-a",
      "v0.3.0",
      "-m",
      `Synthetic release\n\nRelease receipt sha256: ${missingGovernanceArchiveSha256}\nRelease governance receipt sha256: ${missingGovernanceDigest}`,
      testGit(root, ["rev-parse", "HEAD"])
    ]);
    const missingGovernanceBlob = byId(
      evaluateReleaseReadiness(root, NOW),
      "release-receipt-archive"
    );
    assert.equal(missingGovernanceBlob.status, "fail");
    assert.match(
      missingGovernanceBlob.reasons.join(" "),
      /governance receipt .* is unavailable at source\.commit/
    );

    writeFileSync(archivePath, governanceBoundBytes);

    testGit(root, ["tag", "-d", "v0.3.0"]);
    testGit(root, [
      "-c",
      "tag.gpgSign=false",
      "tag",
      "-a",
      "v0.3.0",
      "-m",
      `Synthetic release\n\nRelease receipt sha256: ${governanceBoundSha256}`,
      testGit(root, ["rev-parse", "HEAD"])
    ]);
    const missingGovernanceTagBinding = byId(
      evaluateReleaseReadiness(root, NOW),
      "release-receipt-archive"
    );
    assert.equal(missingGovernanceTagBinding.status, "fail");
    assert.match(
      missingGovernanceTagBinding.reasons.join(" "),
      /does not embed the selected release governance receipt sha256/
    );

    // Restore the historical v1 fixture for the remaining archive tests.
    writeFileSync(archivePath, validArchiveBytes);
    testGit(root, ["tag", "-d", "v0.3.0"]);
    testGit(root, [
      "-c",
      "tag.gpgSign=false",
      "tag",
      "-a",
      "v0.3.0",
      "-m",
      `Synthetic release\n\nRelease receipt sha256: ${validArchiveSha256}`,
      testGit(root, ["rev-parse", "HEAD"])
    ]);

    // One valid historical archive cannot mask a malformed sibling.
    const malformedArchiveDir = path.join(root, "docs", "release-receipts", "0.2.0");
    mkdirSync(malformedArchiveDir, { recursive: true });
    writeFileSync(
      path.join(malformedArchiveDir, "release-receipt.json"),
      JSON.stringify({ schemaVersion: 1 })
    );
    const malformedArchive = byId(evaluateReleaseReadiness(root, NOW), "release-receipt-archive");
    assert.equal(malformedArchive.status, "fail");
    assert.match(malformedArchive.reasons.join(" "), /0\.2\.0/);
    rmSync(malformedArchiveDir, { recursive: true, force: true });

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

test("schema-v2 archived governance closure rejects tampered bytes and non-add-only binding", async (t) => {
  const { archivedReleaseGovernanceProblems } = await script(
    "release-readiness-lib.mjs"
  );
  const root = mkdtempSync(
    path.join(tmpdir(), "sbl-archived-governance-closure-")
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  testGit(root, ["init", "-q"]);
  testGit(root, ["config", "user.name", "Archived Governance Test"]);
  testGit(root, [
    "config",
    "user.email",
    "archived-governance@example.invalid"
  ]);
  const governance = await releaseGovernanceFixture();
  const governanceAbsolute = path.join(
    root,
    ...governance.path.split("/")
  );
  const bindingRelative = "research/measurement-candidate-binding.json";
  const bindingAbsolute = path.join(root, ...bindingRelative.split("/"));
  mkdirSync(path.dirname(governanceAbsolute), { recursive: true });
  const writeBinding = (change: string, digest = governance.digest) => {
    mkdirSync(path.dirname(bindingAbsolute), { recursive: true });
    writeFileSync(
      bindingAbsolute,
      JSON.stringify({
        repository: RELEASE_GOVERNANCE_REPOSITORY,
        targetRelease: "1.0.0",
        evidence: [
          {
            category: "release-tag-governance-receipt",
            path: governance.path,
            change,
            sha256: digest
          }
        ]
      })
    );
  };
  const commit = (message: string) => {
    testGit(root, ["add", "-A"]);
    testGit(root, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      message
    ]);
    return testGit(root, ["rev-parse", "HEAD"]);
  };

  writeFileSync(governanceAbsolute, governance.bytes);
  writeBinding("added");
  const validCommit = commit("valid governance closure");
  assert.deepEqual(
    archivedReleaseGovernanceProblems(
      root,
      validCommit,
      governance.digest
    ),
    []
  );

  writeFileSync(governanceAbsolute, "{}\n");
  const tamperedCommit = commit("tamper governance bytes");
  assert.match(
    archivedReleaseGovernanceProblems(
      root,
      tamperedCommit,
      governance.digest
    ).join(" "),
    /bytes do not match its content-addressed sha256/
  );

  writeFileSync(governanceAbsolute, governance.bytes);
  writeBinding("refreshed");
  const nonAddOnlyCommit = commit("weaken governance binding");
  assert.match(
    archivedReleaseGovernanceProblems(
      root,
      nonAddOnlyCommit,
      governance.digest
    ).join(" "),
    /exactly once as add-only.*measurement-candidate binding/
  );

  writeBinding("added");
  unlinkSync(governanceAbsolute);
  const missingCommit = commit("remove governance receipt");
  assert.match(
    archivedReleaseGovernanceProblems(
      root,
      missingCommit,
      governance.digest
    ).join(" "),
    /is unavailable at source\.commit/
  );
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

test("the aa evidence requirement follows the manifest: valid deferral drops it, deletion or a hollow record restores it", async () => {
  const { evaluateReleaseReadiness } = await script("release-readiness-lib.mjs");
  const AA_CATEGORIES = [
    "aa-attempt-ledger",
    "aa-evaluation",
    "aa-producer-receipt",
    "aa-producer-attestation"
  ];
  const committed = JSON.parse(
    readFileSync(path.join(process.cwd(), "RELEASE_READINESS.json"), "utf8")
  );
  const leanCategories: string[] =
    committed.gates["measurement-candidate-binding"].requiredEvidenceCategories;
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-lean-fork-"));
  try {
    const manifest = () => ({
      schemaVersion: 1,
      artifactKind: "site-behavior-release-readiness-manifest",
      targetRelease: "1.0.0",
      decisions: {},
      gates: {
        "measurement-candidate-binding": {
          kind: "measurement-candidate-binding",
          title: "binding",
          artifact: "research/measurement-candidate-binding.json",
          requiredEvidenceCategories: [...leanCategories]
        }
      },
      deferredGates: JSON.parse(JSON.stringify(committed.deferredGates))
    });
    const bindingGate = (result: { gates: { id: string; status: string; reasons: string[] }[] }) =>
      result.gates.find((gate) => gate.id === "measurement-candidate-binding")!;

    // Both kinds carry valid deferral records, so the committed lean category
    // list is exactly right: no config-mismatch reason, no demand for aa
    // evidence. The gate fails only on what the fixture genuinely lacks, the
    // binding file itself.
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(manifest()));
    const lean = bindingGate(evaluateReleaseReadiness(root, NOW));
    assert.equal(lean.status, "fail");
    const leanReasons = lean.reasons.join(" ");
    assert.doesNotMatch(leanReasons, /requiredEvidenceCategories must be exactly/);
    assert.doesNotMatch(leanReasons, /measurement binding enumerates no aa-/);
    if (!/unavailable/.test(leanReasons)) {
      assert.deepEqual(lean.reasons, [
        "research/measurement-candidate-binding.json does not exist"
      ]);
    }

    // Deleting the deferral records without restoring the gates reverts to the
    // FULL requirement: the same lean gate config becomes a config error that
    // names the complete category list, aa entries included.
    const deleted = manifest();
    delete deleted.deferredGates;
    writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(deleted));
    const restored = bindingGate(evaluateReleaseReadiness(root, NOW));
    assert.equal(restored.status, "fail");
    const prefix = "gate config: requiredEvidenceCategories must be exactly ";
    const exactConfig = restored.reasons.find((reason) => reason.startsWith(prefix));
    assert.notEqual(exactConfig, undefined);
    assert.deepEqual(
      exactConfig!.slice(prefix.length).split(", ").sort(),
      [...leanCategories, ...AA_CATEGORIES].sort()
    );

    // A deferral record whose deferredTo is missing or empty is not a
    // deferral: full requirements stay.
    for (const hollow of [
      (record: Record<string, unknown>) => {
        delete record.deferredTo;
      },
      (record: Record<string, unknown>) => {
        record.deferredTo = "";
      }
    ]) {
      const undeferred = manifest();
      hollow(undeferred.deferredGates["aa-repeatability"]);
      writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(undeferred));
      const gate = bindingGate(evaluateReleaseReadiness(root, NOW));
      assert.equal(gate.status, "fail");
      assert.match(
        gate.reasons.join(" "),
        /requiredEvidenceCategories must be exactly .*aa-attempt-ledger/
      );
    }

    // Live wins: restoring the gate while a stale deferral record lingers
    // must restore the FULL requirement, not keep the lean one.
    const liveAndDeferred = manifest();
    (liveAndDeferred.gates as Record<string, unknown>)["aa-repeatability"] = {
      kind: "aa-study",
      title: "aa",
      directory: "research/aa-studies"
    };
    writeFileSync(
      path.join(root, "RELEASE_READINESS.json"),
      JSON.stringify(liveAndDeferred)
    );
    const liveWins = bindingGate(evaluateReleaseReadiness(root, NOW));
    assert.equal(liveWins.status, "fail");
    assert.match(
      liveWins.reasons.join(" "),
      /requiredEvidenceCategories must be exactly .*aa-attempt-ledger/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator attestations refuse soft truths, mismatched gates, and wrong releases", async () => {
  const {
    operatorAttestationIssues,
    trustedProviderCapturePreflightIssue
  } = await script("release-readiness-lib.mjs");
  for (const gateId of [
    "egress-backstop",
    "log-retention"
  ]) {
    assert.match(
      trustedProviderCapturePreflightIssue(gateId),
      /trusted GitHub-hosted.*provider capture is unavailable/
    );
  }
  assert.equal(
    trustedProviderCapturePreflightIssue("waf-ceilings"),
    null
  );
  assert.equal(
    trustedProviderCapturePreflightIssue(
      "container-image-licensing"
    ),
    null
  );
  const binding = {
    targetRelease: "1.0.0",
    maxAgeDays: 45,
    now: NOW,
    ...SYNTHETIC_ATTESTATION_CONTRACTS["egress-backstop"]
  };
  assert.deepEqual(operatorAttestationIssues(attestation("egress-backstop"), "egress-backstop", binding), []);

  const soft = attestation("egress-backstop");
  (soft.statements[0] as Record<string, unknown>).true = "yes";
  assert.equal(
    operatorAttestationIssues(soft, "egress-backstop", binding).some((issue: string) =>
      /literally true/.test(issue)
    ),
    true
  );

  const extraTopLevel = {
    ...attestation("egress-backstop"),
    unreviewedNarrative: "this field is not part of the evidence contract"
  };
  assert.equal(
    operatorAttestationIssues(
      extraTopLevel,
      "egress-backstop",
      binding
    ).some((issue: string) => /must contain exactly/.test(issue)),
    true
  );

  const exactReleaseBindings = {
    ...binding,
    expectedBindings: {
      candidateCommit: "c".repeat(40),
      networkPolicyDigest: "d".repeat(64)
    }
  };
  const substitutedSubjects = attestation("egress-backstop");
  substitutedSubjects.bindings.candidateCommit = "a".repeat(40);
  substitutedSubjects.bindings.networkPolicyDigest = "b".repeat(64);
  const subjectIssues = operatorAttestationIssues(
    substitutedSubjects,
    "egress-backstop",
    exactReleaseBindings
  );
  assert.equal(
    subjectIssues.some((issue: string) =>
      /candidateCommit does not match the release-derived/.test(issue)
    ),
    true
  );
  assert.equal(
    subjectIssues.some((issue: string) =>
      /networkPolicyDigest does not match the release-derived/.test(issue)
    ),
    true
  );
  const wrongEvidenceRef = attestation("egress-backstop");
  const evidenceRefIssues = operatorAttestationIssues(
    wrongEvidenceRef,
    "egress-backstop",
    {
      ...binding,
      expectedEvidenceRefs: [
        `research/ops-evidence/egress-backstop.json#sha256:${"e".repeat(64)}`
      ]
    }
  );
  assert.equal(
    evidenceRefIssues.some((issue: string) =>
      /must exactly bind the canonical underlying evidence/.test(issue)
    ),
    true
  );

  const unrelated = attestation("egress-backstop");
  unrelated.statements = [{ claimId: "math", claim: "2 + 2 = 4", true: true }];
  unrelated.evidenceRefs = [null] as unknown as string[];
  const unrelatedIssues = operatorAttestationIssues(unrelated, "egress-backstop", binding);
  assert.equal(unrelatedIssues.some((issue: string) => /required claim/.test(issue)), true);
  assert.equal(unrelatedIssues.some((issue: string) => /evidenceRefs/.test(issue)), true);

  const wrongBinding = attestation("egress-backstop");
  wrongBinding.bindings.candidateCommit = "short";
  assert.equal(
    operatorAttestationIssues(wrongBinding, "egress-backstop", binding).some((issue: string) =>
      /candidateCommit/.test(issue)
    ),
    true
  );

  const staleEvidence = attestation("egress-backstop");
  staleEvidence.evidenceCapturedAt = "2026-01-01T00:00:00.000Z";
  assert.equal(
    operatorAttestationIssues(staleEvidence, "egress-backstop", binding).some((issue: string) =>
      /evidenceCapturedAt is older/.test(issue)
    ),
    true
  );

  const impossibleDate = attestation("egress-backstop");
  impossibleDate.attestedAt = "2026-02-30T00:00:00.000Z";
  impossibleDate.evidenceCapturedAt = "2026-02-30T00:00:00.000Z";
  assert.equal(
    operatorAttestationIssues(impossibleDate, "egress-backstop", binding).some((issue: string) =>
      /real canonical UTC instant/.test(issue)
    ),
    true
  );

  const durableBinding = {
    targetRelease: "1.0.0",
    maxAgeDays: 45,
    now: NOW,
    ...SYNTHETIC_ATTESTATION_CONTRACTS["durable-soak"]
  };
  const ancientWindow = attestation("durable-soak");
  ancientWindow.evidenceWindow = {
    startedAt: "2010-01-01T00:00:00.000Z",
    restartObservedAt: "2010-01-01T12:00:00.000Z",
    endedAt: "2010-01-02T00:00:00.000Z"
  };
  const ancientIssues = operatorAttestationIssues(ancientWindow, "durable-soak", durableBinding);
  assert.equal(ancientIssues.some((issue: string) => /evidenceWindow\.endedAt is older/.test(issue)), true);
  assert.equal(ancientIssues.some((issue: string) => /must equal evidenceWindow\.endedAt/.test(issue)), true);

  const captureMismatch = attestation("durable-soak", "2026-08-09T00:02:00.000Z");
  captureMismatch.evidenceCapturedAt = "2026-08-09T00:01:00.000Z";
  assert.equal(
    operatorAttestationIssues(captureMismatch, "durable-soak", durableBinding).some((issue: string) =>
      /must equal evidenceWindow\.endedAt/.test(issue)
    ),
    true
  );

  const restartOutside = attestation("durable-soak");
  restartOutside.evidenceWindow!.restartObservedAt =
    "2026-08-07T23:59:59.000Z";
  assert.equal(
    operatorAttestationIssues(
      restartOutside,
      "durable-soak",
      durableBinding
    ).some((issue: string) => /restartObservedAt must fall inside/.test(issue)),
    true
  );

  const futureWindow = attestation("durable-soak", "2027-01-01T00:00:00.000Z");
  futureWindow.evidenceCapturedAt = "2027-01-01T00:00:00.000Z";
  futureWindow.evidenceWindow = {
    startedAt: "2026-12-31T00:00:00.000Z",
    restartObservedAt: "2026-12-31T12:00:00.000Z",
    endedAt: "2027-01-01T00:00:00.000Z"
  };
  assert.equal(
    operatorAttestationIssues(futureWindow, "durable-soak", durableBinding).some((issue: string) =>
      /evidenceWindow\.endedAt .*future/.test(issue)
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

test("the attestation scaffold covers every release attestation without inventing claims", async () => {
  const {
    buildReleaseAttestationScaffold,
    operatorAttestationIssues
  } = await script("release-readiness-lib.mjs");
  const manifest = JSON.parse(
    readFileSync(path.join(process.cwd(), "RELEASE_READINESS.json"), "utf8")
  );
  const gateIds = [
    "durable-soak",
    "egress-backstop",
    "waf-ceilings",
    "log-retention",
    "container-image-licensing"
  ];
  for (const gateId of gateIds) {
    const gate = manifest.gates[gateId];
    const scaffold = buildReleaseAttestationScaffold(
      manifest,
      gateId,
      {
        candidateCommit: "a".repeat(40),
        ...(gateId === "egress-backstop"
          ? {
              collectionEnvironmentDigest: "b".repeat(64),
              collectionProducerCommitsDigest: "c".repeat(64)
            }
          : {})
      }
    );
    assert.deepEqual(
      Object.keys(scaffold.bindings),
      gate.requiredBindings
    );
    assert.deepEqual(
      scaffold.statements.map(
        (statement: { claimId: string; claim: string; true: boolean }) => ({
          id: statement.claimId,
          claim: statement.claim,
          true: statement.true
        })
      ),
      gate.requiredClaims.map(
        (claim: { id: string; claim: string }) => ({
          ...claim,
          true: false
        })
      )
    );
    assert.equal(
      operatorAttestationIssues(scaffold, gateId, {
        targetRelease: manifest.targetRelease,
        maxAgeDays: gate.maxAgeDays,
        now: NOW,
        requiredClaims: gate.requiredClaims,
        requiredBindings: gate.requiredBindings,
        minimumEvidenceHours: gate.minimumEvidenceHours
      }).length > 0,
      true,
      "a newly generated scaffold must remain non-passing"
    );
  }

  const egress = buildReleaseAttestationScaffold(
    manifest,
    "egress-backstop",
    {
      candidateCommit: "a".repeat(40),
      deploymentCommit: "d".repeat(40),
      networkPolicyDigest: "e".repeat(64),
      collectionEnvironmentDigest: "b".repeat(64),
      collectionProducerCommitsDigest: "c".repeat(64)
    },
    {
      evidenceCapturedAt: "2026-08-09T00:00:00.000Z",
      evidenceRefs: [
        `research/ops-evidence/egress-backstop.json#sha256:${"f".repeat(64)}`
      ]
    }
  );
  assert.equal(egress.bindings.candidateCommit, "a".repeat(40));
  assert.equal(
    egress.bindings.collectionEnvironmentDigest,
    "b".repeat(64)
  );
  assert.equal(
    egress.bindings.collectionProducerCommitsDigest,
    "c".repeat(64)
  );
  assert.equal(
    egress.bindings.networkPolicyDigest,
    "e".repeat(64)
  );
  assert.equal(
    egress.evidenceCapturedAt,
    "2026-08-09T00:00:00.000Z"
  );
  assert.deepEqual(
    egress.evidenceRefs,
    [
      `research/ops-evidence/egress-backstop.json#sha256:${"f".repeat(64)}`
    ]
  );

  for (const gateId of [
    "egress-backstop",
    "waf-ceilings",
    "log-retention",
    "container-image-licensing"
  ]) {
    const gate = manifest.gates[gateId];
    const expectedBindings = Object.fromEntries(
      gate.requiredBindings.map((name: string) => [
        name,
        name.endsWith("Commit")
          ? "a".repeat(40)
          : name.endsWith("Digest")
            ? "b".repeat(64)
            : name === "effectiveSourceObservedAt"
              ? "2026-08-09T00:00:00.000Z"
              : "canonical-value"
      ])
    );
    const evidenceRef =
      `research/ops-evidence/${gateId}.json#sha256:${"f".repeat(64)}`;
    const passing = buildReleaseAttestationScaffold(
      manifest,
      gateId,
      expectedBindings,
      {
        evidenceCapturedAt: "2026-08-09T00:00:00.000Z",
        evidenceRefs: [evidenceRef]
      }
    );
    passing.attestedBy = "Release operator";
    passing.attestedAt = "2026-08-09T00:01:00.000Z";
    for (const statement of passing.statements) statement.true = true;
    assert.deepEqual(
      operatorAttestationIssues(passing, gateId, {
        targetRelease: manifest.targetRelease,
        maxAgeDays: gate.maxAgeDays,
        now: NOW,
        requiredClaims: gate.requiredClaims,
        requiredBindings: gate.requiredBindings,
        expectedBindings,
        expectedEvidenceRefs: [evidenceRef]
      }),
      [],
      `${gateId} must have a satisfiable exact attestation contract once trusted provider capture exists`
    );
  }
});

test("durable target deviations require an exact candidate-bound named-human approval", { skip: repositoryHeadSkip }, async () => {
  const {
    buildDurableTargetDeviationApprovalScaffold,
    durableTargetDeviationApprovalProblems
  } = await script("release-readiness-lib.mjs");
  const candidateCommit = testGit(process.cwd(), ["rev-parse", "HEAD"]);
  const candidateMillis = Date.parse(
    testGit(process.cwd(), [
      "show",
      "-s",
      "--format=%cI",
      candidateCommit
    ])
  );
  const endedAt = new Date(
    candidateMillis - 3_600_000
  ).toISOString();
  const startedAt = new Date(
    Date.parse(endedAt) - 24 * 3_600_000
  ).toISOString();
  const restartObservedAt = new Date(
    Date.parse(startedAt) + 12 * 3_600_000
  ).toISOString();
  const expected = {
    rootDir: process.cwd(),
    candidateCommit,
    soakDeploymentCommit: "a".repeat(40),
    ledgerSha256: "b".repeat(64),
    evidenceWindow: {
      startedAt,
      restartObservedAt,
      endedAt
    },
    minimumEvidenceHours: 24,
    targetEvidenceHours: 168
  };
  const approval = {
    status: "approved",
    approverType: "named-human",
    approvedBy: "Release Evidence Reviewer",
    approvedAt: new Date(candidateMillis).toISOString(),
    reason:
      "The exact candidate met the hard minimum; release timing requires a reviewed deviation from the seven-day target.",
    candidateCommit,
    soakDeploymentCommit: expected.soakDeploymentCommit,
    ledgerSha256: expected.ledgerSha256,
    evidenceWindow: { ...expected.evidenceWindow },
    minimumEvidenceHours: 24,
    targetEvidenceHours: 168
  };
  assert.deepEqual(
    durableTargetDeviationApprovalProblems({
      approval,
      ...expected
    }),
    []
  );
  assert.match(
    durableTargetDeviationApprovalProblems({
      approval: null,
      ...expected
    }).join("; "),
    /requires an exact named-human/
  );
  assert.match(
    durableTargetDeviationApprovalProblems({
      approval: { ...approval, approvedBy: "automation" },
      ...expected
    }).join("; "),
    /named human approver/
  );
  assert.match(
    durableTargetDeviationApprovalProblems({
      approval: {
        ...approval,
        approvedAt: endedAt
      },
      ...expected
    }).join("; "),
    /approval is stale/
  );
  assert.match(
    durableTargetDeviationApprovalProblems({
      approval: {
        ...approval,
        ledgerSha256: "c".repeat(64)
      },
      ...expected
    }).join("; "),
    /does not bind the exact candidate, deployment, ledger, window/
  );
  assert.match(
    durableTargetDeviationApprovalProblems({
      approval: {
        ...approval,
        candidateCommit: "d".repeat(40),
        evidenceWindow: {
          ...approval.evidenceWindow,
          endedAt: new Date(
            Date.parse(approval.evidenceWindow.endedAt) - 1_000
          ).toISOString()
        }
      },
      ...expected
    }).join("; "),
    /does not bind the exact candidate, deployment, ledger, window/
  );
  const belowMinimum = {
    ...expected,
    evidenceWindow: {
      ...expected.evidenceWindow,
      startedAt: new Date(
        Date.parse(endedAt) - 23 * 3_600_000
      ).toISOString()
    }
  };
  assert.match(
    durableTargetDeviationApprovalProblems({
      approval,
      ...belowMinimum
    }).join("; "),
    /below the 24-hour hard minimum/
  );
  const targetWindow = {
    ...expected,
    evidenceWindow: {
      ...expected.evidenceWindow,
      startedAt: new Date(
        Date.parse(endedAt) - 168 * 3_600_000
      ).toISOString()
    }
  };
  assert.deepEqual(
    durableTargetDeviationApprovalProblems({
      approval: null,
      ...targetWindow
    }),
    []
  );
  assert.match(
    durableTargetDeviationApprovalProblems({
      approval,
      ...targetWindow
    }).join("; "),
    /must be null when the 168-hour target is met/
  );

  const scaffold =
    buildDurableTargetDeviationApprovalScaffold(expected);
  assert.match(scaffold.status, /^<required:/);
  assert.match(scaffold.approvedBy, /^<required:/);
  assert.equal(scaffold.candidateCommit, candidateCommit);
  assert.equal(scaffold.ledgerSha256, expected.ledgerSha256);
  assert.notEqual(scaffold.status, "approved");
});

test("measurement report chronology includes single, primary, and supporting runs", async () => {
  const { reportAcquisitionRuns } = await script("release-readiness-lib.mjs");
  const single = makePublicSingleReportV2R2();
  const singleRuns = reportAcquisitionRuns(single);
  assert.deepEqual(singleRuns.reasons, []);
  assert.deepEqual(
    singleRuns.runs.map((entry: { label: string }) => entry.label),
    ["run"]
  );

  const comparison = makeSupportingPairInterventionReportV2R2();
  const comparisonRuns = reportAcquisitionRuns(comparison);
  assert.deepEqual(comparisonRuns.reasons, []);
  assert.deepEqual(
    comparisonRuns.runs.map((entry: { label: string }) => entry.label),
    [
      "baseline",
      "variant",
      "supporting pair 1 baseline",
      "supporting pair 1 variant"
    ]
  );
});

test("hosted evidence cannot reuse a successful run from older workflow bytes", async () => {
  const {
    hostedSubjectFinalizationCommit,
    hostedEvidenceSourceTrustProblems
  } = await script("release-readiness-lib.mjs");
  const hosted = await script(
    "hosted-evidence-provenance-lib.mjs"
  );
  const root = mkdtempSync(path.join(tmpdir(), "hosted-workflow-trust-"));
  const workflowPath = ".github/workflows/durable-soak-restart.yml";
  try {
    mkdirSync(path.join(root, ".github", "workflows"), {
      recursive: true
    });
    writeFileSync(
      path.join(root, workflowPath),
      "name: Old weak producer\n"
    );
    for (const relativePath of
      hosted.hostedEvidenceCollectionContract("durable-soak")
        .sources.restart.trustedSourcePaths as string[]) {
      const absolutePath = path.join(
        root,
        ...relativePath.split("/")
      );
      mkdirSync(path.dirname(absolutePath), {
        recursive: true
      });
      writeFileSync(
        absolutePath,
        `${relativePath}: candidate-approved\n`
      );
    }
    testGit(root, ["init", "-q"]);
    testGit(root, ["config", "user.name", "Hosted Evidence Test"]);
    testGit(root, ["config", "user.email", "hosted@example.test"]);
    testGit(root, ["add", "."]);
    testGit(root, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "Old workflow"
    ]);
    const oldSource = testGit(root, ["rev-parse", "HEAD"]);

    const subjectBytes = '{"kind":"durable-soak"}\n';
    writeFileSync(path.join(root, "durable-subject.json"), subjectBytes);
    testGit(root, ["add", "durable-subject.json"]);
    testGit(root, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "Finalize durable subject"
    ]);
    const subjectCarrier = testGit(root, ["rev-parse", "HEAD"]);

    writeFileSync(
      path.join(root, workflowPath),
      "name: Candidate-approved producer\n"
    );
    testGit(root, ["add", workflowPath]);
    testGit(root, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "Approve workflow"
    ]);
    const candidateCommit = testGit(root, ["rev-parse", "HEAD"]);

    writeFileSync(path.join(root, "evidence.json"), "{}\n");
    testGit(root, ["add", "evidence.json"]);
    testGit(root, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "Carry evidence"
    ]);
    const carrierCommit = testGit(root, ["rev-parse", "HEAD"]);
    const context = {
      binding: {
        candidateCommit,
        carrierCommit,
        acceptedProducerCommits: [candidateCommit, carrierCommit]
      },
      module: null
    };
    assert.equal(
      hostedSubjectFinalizationCommit(
        root,
        candidateCommit,
        "durable-subject.json",
        createHash("sha256").update(subjectBytes).digest("hex")
      ),
      subjectCarrier,
      "the hosted subject commit is the commit containing exact subject bytes, not the earlier deployment source"
    );
    const source = {
      role: "restart",
      workflowPath,
      headSha: oldSource
    };
    assert.match(
      hostedEvidenceSourceTrustProblems(
        root,
        context,
        "durable-soak",
        oldSource,
        [source]
      ).join(" "),
      /workflow bytes that do not equal the candidate-approved/
    );
    assert.deepEqual(
      hostedEvidenceSourceTrustProblems(
        root,
        context,
        "durable-soak",
        candidateCommit,
        [{ ...source, headSha: candidateCommit }]
      ),
      []
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every durable soak source rejects stale producer or semantic-verifier bytes", async () => {
  const {
    hostedEvidenceSourceTrustProblems
  } = await script("release-readiness-lib.mjs");
  const hosted = await script(
    "hosted-evidence-provenance-lib.mjs"
  );
  const contract =
    hosted.hostedEvidenceCollectionContract("durable-soak");
  const cases = [
    {
      role: "monitor",
      changedPath: "scripts/durable-soak-ledger.mjs"
    },
    {
      role: "restart",
      changedPath:
        "scripts/durable-soak-restart-evidence.mjs"
    },
    {
      role: "exercises",
      changedPath:
        "scripts/durable-soak-exercise-evidence.mjs"
    }
  ] as const;
  for (const { role, changedPath } of cases) {
    const root = mkdtempSync(
      path.join(tmpdir(), `hosted-${role}-source-trust-`)
    );
    const sourceContract = contract.sources[role];
    const workflowPath = sourceContract.workflows[0];
    try {
      for (const relativePath of [
        workflowPath,
        ...sourceContract.trustedSourcePaths
      ]) {
        const absolutePath = path.join(
          root,
          ...relativePath.split("/")
        );
        mkdirSync(path.dirname(absolutePath), {
          recursive: true
        });
        writeFileSync(
          absolutePath,
          `${relativePath}: candidate-approved\n`
        );
      }
      testGit(root, ["init", "-q"]);
      testGit(root, [
        "config",
        "user.name",
        "Hosted Evidence Test"
      ]);
      testGit(root, [
        "config",
        "user.email",
        "hosted@example.test"
      ]);
      testGit(root, ["add", "."]);
      testGit(root, [
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        `Durable ${role} deployment`
      ]);
      const deploymentCommit = testGit(root, [
        "rev-parse",
        "HEAD"
      ]);

      writeFileSync(
        path.join(root, "candidate-marker"),
        "candidate\n"
      );
      testGit(root, ["add", "candidate-marker"]);
      testGit(root, [
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "Select matching candidate"
      ]);
      const matchingCandidate = testGit(root, [
        "rev-parse",
        "HEAD"
      ]);
      const source = {
        role,
        workflowPath,
        headSha: deploymentCommit
      };
      assert.deepEqual(
        hostedEvidenceSourceTrustProblems(
          root,
          {
            binding: {
              candidateCommit: matchingCandidate,
              carrierCommit: matchingCandidate,
              acceptedProducerCommits: [matchingCandidate]
            }
          },
          "durable-soak",
          deploymentCommit,
          [source]
        ),
        []
      );

      writeFileSync(
        path.join(root, ...changedPath.split("/")),
        "stale producer was replaced after the evidence run\n"
      );
      testGit(root, ["add", changedPath]);
      testGit(root, [
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        `Change ${role} producer`
      ]);
      const changedCandidate = testGit(root, [
        "rev-parse",
        "HEAD"
      ]);
      assert.match(
        hostedEvidenceSourceTrustProblems(
          root,
          {
            binding: {
              candidateCommit: changedCandidate,
              carrierCommit: changedCandidate,
              acceptedProducerCommits: [changedCandidate]
            }
          },
          "durable-soak",
          deploymentCommit,
          [source]
        ).join(" "),
        new RegExp(
          `producer bytes that do not equal the candidate-approved ${changedPath.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )}`
        )
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("durable soak hourly sources use the candidate-approved Production Health workflow", async () => {
  const {
    durableSoakNestedWorkflowTrustProblems
  } = await script("release-readiness-lib.mjs");
  const root = mkdtempSync(
    path.join(tmpdir(), "durable-soak-nested-workflow-trust-")
  );
  const workflowPath =
    ".github/workflows/production-health.yml";
  try {
    mkdirSync(path.join(root, ".github", "workflows"), {
      recursive: true
    });
    writeFileSync(
      path.join(root, workflowPath),
      "name: Candidate-approved hourly health\n"
    );
    testGit(root, ["init", "-q"]);
    testGit(root, ["config", "user.name", "Hosted Evidence Test"]);
    testGit(root, [
      "config",
      "user.email",
      "hosted@example.test"
    ]);
    testGit(root, ["add", workflowPath]);
    testGit(root, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "Durable deployment"
    ]);
    const deploymentCommit = testGit(root, [
      "rev-parse",
      "HEAD"
    ]);

    writeFileSync(path.join(root, "candidate-marker"), "candidate\n");
    testGit(root, ["add", "candidate-marker"]);
    testGit(root, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "Select candidate"
    ]);
    const matchingCandidate = testGit(root, [
      "rev-parse",
      "HEAD"
    ]);
    assert.deepEqual(
      durableSoakNestedWorkflowTrustProblems(
        root,
        matchingCandidate,
        deploymentCommit
      ),
      []
    );

    writeFileSync(
      path.join(root, workflowPath),
      "name: Changed after the soak\n"
    );
    testGit(root, ["add", workflowPath]);
    testGit(root, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "Change hourly health"
    ]);
    const changedCandidate = testGit(root, [
      "rev-parse",
      "HEAD"
    ]);
    assert.match(
      durableSoakNestedWorkflowTrustProblems(
        root,
        changedCandidate,
        deploymentCommit
      ).join(" "),
      /workflow bytes that do not equal the candidate-approved/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report and A/A producer identities must match the candidate-derived identity", async () => {
  const {
    aaMeasurementIdentityProblems,
    measurementIdentityRunProblems
  } = await script("release-readiness-lib.mjs");
  const report = makePublicSingleReportV2R2();
  const run = report.run;
  const reportIdentity = {
    value: {
      implementation: {
        detectorRegistryVersion: run.provenance.detectorRegistry.version,
        detectorRegistryDigest: run.provenance.detectorRegistry.digest,
        methodologyVersion: run.provenance.methodologyVersion,
        normalizationVersion: run.toolchain.normalizationVersion
      },
      catalogs: {
        trackerCatalogVersion: run.toolchain.trackerCatalog.version,
        trackerCatalogDigest: run.toolchain.trackerCatalog.digest,
        braveManifestDigest: run.toolchain.adblock!.manifestDigest,
        braveEngineVersion: run.toolchain.adblock!.engineVersion
      }
    }
  };
  assert.deepEqual(
    measurementIdentityRunProblems(reportIdentity, run),
    []
  );
  const staleReport = structuredClone(run);
  staleReport.toolchain.trackerCatalog.digest = "0".repeat(64);
  staleReport.provenance.detectorRegistry.version = "stale-registry";
  const reportIssues = measurementIdentityRunProblems(
    reportIdentity,
    staleReport
  ).join(" ");
  assert.match(reportIssues, /detector registry/);
  assert.match(reportIssues, /tracker catalog/);

  const ledger = await aaLedger();
  const producer =
    ledger.attempts[0].observation.arms.run.producerRuntime;
  const aaIdentity = {
    value: {
      implementation: {
        methodologyVersion: producer.methodologyVersion,
        detectorRegistryVersion: producer.detectorRegistry.version,
        detectorRegistryDigest: producer.detectorRegistry.digest
      }
    }
  };
  assert.deepEqual(
    aaMeasurementIdentityProblems(aaIdentity, ledger),
    []
  );
  const staleLedger = structuredClone(ledger);
  staleLedger.attempts[1].observation.arms.run.producerRuntime.methodologyVersion =
    "stale-methodology";
  assert.match(
    aaMeasurementIdentityProblems(aaIdentity, staleLedger).join(" "),
    /methodologyVersion/
  );
});

test("A/A target-frame bytes defeat a matching fabricated preregistration and ledger digest", async () => {
  const { aaTargetFrameDigestIssues } = await script(
    "release-readiness-lib.mjs"
  );
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-aa-frame-"));
  try {
    const targetFramePath =
      "research/aa-studies/fabricated/target-frame.json";
    mkdirSync(path.dirname(path.join(root, targetFramePath)), {
      recursive: true
    });
    writeFileSync(
      path.join(root, targetFramePath),
      `${JSON.stringify([
        { targetId: "real", url: "https://real.example/" }
      ])}\n`
    );
    const fabricated = "f".repeat(64);
    const issues = aaTargetFrameDigestIssues(
      root,
      targetFramePath,
      { sitesFile: targetFramePath, sitesFileDigest: fabricated },
      {
        sitesFile: targetFramePath,
        provenance: { sitesFileDigest: fabricated }
      }
    );
    assert.match(issues.join(" "), /exact study-local target-frame bytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence dated after its introduction commit cannot become green later", async () => {
  const { producerEvidenceProblems } = await script(
    "release-readiness-lib.mjs"
  );
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-causality-"));
  try {
    testGit(root, ["init", "-q"]);
    testGit(root, ["config", "user.name", "Causality Test"]);
    testGit(root, ["config", "user.email", "causality@example.test"]);
    writeFileSync(path.join(root, "candidate.txt"), "candidate\n");
    testGit(root, ["add", "candidate.txt"]);
    testGit(
      root,
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "candidate"],
      {
        GIT_AUTHOR_DATE: "2026-08-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-08-01T00:00:00Z"
      }
    );
    const producer = testGit(root, ["rev-parse", "HEAD"]);
    const evidencePath = "research/evidence.json";
    mkdirSync(path.join(root, "research"), { recursive: true });
    writeFileSync(path.join(root, evidencePath), "{}\n");
    testGit(root, ["add", evidencePath]);
    testGit(
      root,
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "evidence"],
      {
        GIT_AUTHOR_DATE: "2026-08-02T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-08-02T00:00:00Z"
      }
    );
    const carrier = testGit(root, ["rev-parse", "HEAD"]);
    const issues = producerEvidenceProblems(
      root,
      {
        binding: {
          candidateCommit: producer,
          carrierCommit: carrier,
          acceptedProducerCommits: [producer]
        }
      },
      evidencePath,
      producer,
      "2026-08-03T00:00:00.000Z"
    );
    assert.match(issues.join(" "), /must not follow its introduction commit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bound corpus derivation collapses two cycles for one site to the newest representative", async () => {
  const { deriveBoundCorpusCohort } = await script(
    "release-readiness-lib.mjs"
  );
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-corpus-"));
  try {
    const reportsDir = path.join(root, "public", "reports");
    mkdirSync(reportsDir, { recursive: true });
    const older = makePublicSingleReportV2R2();
    const subject = {
      origin: "https://duplicate-cycle-fixture.dev",
      registrableDomain: "duplicate-cycle-fixture.dev",
      routeShape: "/"
    };
    older.run.subject = {
      requested: subject,
      observed: { ...subject }
    };
    const newer = structuredClone(older);
    newer.run.startedAt = "2026-07-09T11:00:00.000Z";
    const olderId = "20260709-11111111111111111111111111111111";
    const newerId = "20260709-22222222222222222222222222222222";
    const olderPath = `public/reports/${olderId}.json`;
    const newerPath = `public/reports/${newerId}.json`;
    writeFileSync(path.join(root, ...olderPath.split("/")), JSON.stringify(older));
    writeFileSync(path.join(root, ...newerPath.split("/")), JSON.stringify(newer));
    const identity = corpusCohortIdentityForView(
      toReportView({ schemaVersion: 2, schemaRevision: 2, report: older })
    );
    const derived = deriveBoundCorpusCohort(
      root,
      {
        binding: {
          evidence: [olderPath, newerPath].map((evidencePath) => ({
            category: "featured-report",
            path: evidencePath
          }))
        }
      },
      identity.id
    );
    assert.deepEqual(derived.reasons, []);
    assert.equal(derived.sampleSize, 1);
    assert.equal(derived.latestRunAt, newer.run.startedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runner receipt that fails to parse cannot rename another receipt's carrier failure", async () => {
  const { evaluateReleaseReadiness } = await script("release-readiness-lib.mjs");
  const runnerReceiptLib = await script("runner-receipt-lib.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "sbl-readiness-runner-attribution-"));
  try {
    mkdirSync(path.join(root, "research", "runner-receipts"), { recursive: true });
    // Sorts ahead of both valid receipts and throws in the canonical parse, so
    // the parsed receipts and the enumerated file names can fall out of step.
    writeFileSync(
      path.join(root, "research", "runner-receipts", "0-noncanonical.json"),
      `${JSON.stringify(runnerReceipt(1), null, 2)}\n`
    );
    for (const runId of [1, 2]) {
      writeFileSync(
        path.join(root, "research", "runner-receipts", `${runId}.json`),
        runnerReceiptLib.serializeRunnerDestructionReceipt(runnerReceipt(runId))
      );
    }
    writeFileSync(
      path.join(root, "RELEASE_READINESS.json"),
      JSON.stringify({
        schemaVersion: 1,
        artifactKind: "site-behavior-release-readiness-manifest",
        targetRelease: "1.0.0",
        gates: {
          "measurement-candidate-binding": {
            kind: "measurement-candidate-binding",
            title: "binding",
            artifact: "research/measurement-candidate-binding.json"
          },
          "runner-cycles": {
            kind: "runner-receipts",
            title: "runner",
            directory: "research/runner-receipts",
            minimumReceipts: 2,
            expectedEnvironment:
              runnerReceiptLib.runnerDestructionEnvironmentTuple(
                runnerReceipt(1)
              ),
            maxAgeDays: 30
          }
        }
      })
    );
    const gate = evaluateReleaseReadiness(root, NOW).gates.find(
      (entry: { id: string }) => entry.id === "runner-cycles"
    )! as { status: string; reasons: string[] };
    assert.equal(gate.status, "fail");
    // Every carrier reason names the file whose receipt was actually checked,
    // and both parsed receipts get named.
    const carrierSubjects = [
      ...new Set(
        gate.reasons
          .filter((reason) => reason.includes("accepted measurement carrier commit"))
          .map((reason) => reason.split(" ")[0])
      )
    ].sort();
    assert.deepEqual(carrierSubjects, [
      "research/runner-receipts/1.json",
      "research/runner-receipts/2.json"
    ]);
    // The unparseable file is reported for the one defect it has, nothing else.
    const noncanonical = gate.reasons.filter((reason) => reason.includes("0-noncanonical"));
    assert.equal(noncanonical.length, 1);
    assert.match(noncanonical[0], /canonical receipt serialization/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a 0.x release does not demand a measurement binding it was never asked to produce", async () => {
  // release.yml passes the governance digest unconditionally, so every receipt
  // is schemaVersion 2. Its governance closure resolves BOTH the governance
  // receipt and research/measurement-candidate-binding.json at source.commit,
  // and a 0.x release produces neither: the workflow records
  // binding_sha256=not-required for those versions. Running the closure for
  // them failed the next release on artifacts that release never had.
  const {
    archivedReleaseGovernanceProblems,
    releaseRequiresMeasurementBinding
  } = await script("release-readiness-lib.mjs");

  assert.equal(releaseRequiresMeasurementBinding("1.0.0"), true);
  assert.equal(releaseRequiresMeasurementBinding("1.0.0-rc.1"), true);
  assert.equal(releaseRequiresMeasurementBinding("0.4.0"), false);
  assert.equal(releaseRequiresMeasurementBinding("0.5.0-rc.2"), false);
  assert.equal(releaseRequiresMeasurementBinding("1.0.1"), false);
  assert.equal(releaseRequiresMeasurementBinding(undefined), false);

  // Only the BINDING half is scoped. The governance receipt is still resolved
  // for both, which is what a hardened case asserts against a synthetic v0.3.0.
  //
  // Deliberately a synthetic commit AND a rootDir that is not a repository.
  // gitRead returns null for anything it cannot resolve, so both artefacts
  // report "unavailable at source.commit" either way, and the assertions below
  // hold identically with or without git. Using process.cwd() and the real HEAD
  // made this test require a checkout; the container build excludes .git, so it
  // passed locally and failed inside the image.
  const head = "d".repeat(40);
  const digest = "a".repeat(64);
  const nonRepository = mkdtempSync(path.join(tmpdir(), "sbl-no-git-"));

  const required = archivedReleaseGovernanceProblems(nonRepository, head, digest);
  assert.ok(
    required.some((problem: string) => /measurement-candidate-binding\.json is unavailable/.test(problem)),
    `a binding-requiring release must still report the binding gap, got: ${required.join("; ")}`
  );

  const notRequired = archivedReleaseGovernanceProblems(nonRepository, head, digest, {
    requiresMeasurementBinding: false
  });
  assert.ok(
    !notRequired.some((problem: string) => /measurement-candidate-binding\.json/.test(problem)),
    `a 0.x release must not be asked for a binding, got: ${notRequired.join("; ")}`
  );
  // ...but the governance receipt itself is still verified in both modes.
  for (const problems of [required, notRequired]) {
    assert.ok(
      problems.some((problem: string) => /governance receipt .* is unavailable at source\.commit/.test(problem)),
      "the governance receipt must be resolved regardless of binding policy"
    );
  }
  rmSync(nonRepository, { recursive: true, force: true });
});

test("the binding-required rule matches the release workflow that owns it", async () => {
  // One rule in two files is this repository's most expensive defect class, and
  // the workflow half is bash so it cannot be imported. Read its regex instead.
  const { releaseRequiresMeasurementBinding } = await script("release-readiness-lib.mjs");
  const workflow = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "release.yml"),
    "utf8"
  );
  assert.match(
    workflow,
    /\^1\\\.0\\\.0\(-rc\\\.\[1-9\]\[0-9\]\*\)\?\$/,
    "release.yml no longer classifies exact 1.0 the way releaseRequiresMeasurementBinding does"
  );
  assert.match(workflow, /binding_sha256=not-required/, "0.x must still record not-required");
  for (const version of ["1.0.0", "1.0.0-rc.7"]) {
    assert.equal(releaseRequiresMeasurementBinding(version), true, version);
  }
});
