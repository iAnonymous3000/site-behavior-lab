import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { publicR2ReportsReadiness, REQUIRE_EGRESS_REGION_ENV } from "./runtime-scan-report";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, (...args: any[]) => any>;
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ScriptExports>;

function script(name: string) {
  return nativeImport(pathToFileURL(path.join(process.cwd(), "scripts", name)).href);
}

const RUNNER_RECEIPT_VALIDATOR = path.join(
  process.cwd(),
  "scripts",
  "verify-runner-destruction-receipt.mjs"
);

const READY_ENV = {
  SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: "1",
  SITE_BEHAVIOR_LAB_BUILD_COMMIT: "a".repeat(40),
  SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "1"
} as NodeJS.ProcessEnv;

test("egress-region readiness stays opt-in and fails closed once required", () => {
  assert.equal(publicR2ReportsReadiness({ ...READY_ENV }).status, "enabled");
  assert.equal(
    publicR2ReportsReadiness({ ...READY_ENV, [REQUIRE_EGRESS_REGION_ENV]: "1" }).status,
    "misconfigured"
  );
  const explicit = publicR2ReportsReadiness({
    ...READY_ENV,
    [REQUIRE_EGRESS_REGION_ENV]: "1",
    SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION: "us-east"
  });
  assert.equal(explicit.status, "enabled", explicit.issues.join(" "));
  const placement = publicR2ReportsReadiness({
    ...READY_ENV,
    [REQUIRE_EGRESS_REGION_ENV]: "1",
    CLOUDFLARE_REGION: "wnam",
    CLOUDFLARE_LOCATION: "sea",
    CLOUDFLARE_COUNTRY_A2: "US"
  });
  assert.equal(placement.status, "enabled", placement.issues.join(" "));
});

function validReceipt() {
  return {
    kind: "site-behavior-controlled-runner-destruction-receipt",
    receiptVersion: 3,
    actionsRunId: 30_600_000_001,
    actionsRunAttempt: 1,
    workflow: "scan-featured.yml",
    runnerLabelRef:
      "sha256:6786aaad2225cf8b2d9659dc71941110c1db9ff797ed417e6aaf6da85215f609",
    recordedAt: "2026-08-03T08:00:00.000Z",
    provisioning: {
      provisionedAt: "2026-08-03T05:20:00.000Z",
      hostImageIdentityRef:
        "sha256:213c97ea41074671d75ed417e1fae3d93ec608562d7bd89a3e6d3197cbcd8bec",
      singleUse: true,
      registration: {
        repository: "iAnonymous3000/site-behavior-lab",
        labelRefs: [
          "sha256:6786aaad2225cf8b2d9659dc71941110c1db9ff797ed417e6aaf6da85215f609"
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
      collectionDate: "2026-08-03",
      job: {
        id: 90_600_000_001,
        name: "Populate Featured Gallery",
        startedAt: "2026-08-03T05:23:00.000Z",
        completedAt: "2026-08-03T07:40:00.000Z",
        url: "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000001/job/90600000001"
      },
      artifact: {
        id: 8_760_000_001,
        name: "site-behavior-featured-publication-30600000001-1",
        sha256: "b".repeat(64),
        url: "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000001/artifacts/8760000001"
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
        "sha256:ffe7c4ef96c80086ec086bdc71002e0d6d777011827bbf9ddd3ea6b9be0bca90",
      independentPolicyEnforced: true,
      blockedClasses: ["private", "link-local", "metadata"]
    },
    destruction: {
      destroyedAt: "2026-08-03T07:45:00.000Z",
      verifiedAbsentAt: "2026-08-03T07:50:00.000Z",
      method: "instance-terminate",
      verification: `sha256:${"e".repeat(64)}`
    },
    destructionEvidence: {
      workflow: ".github/workflows/runner-destruction-evidence.yml",
      runId: 30_700_000_001,
      runAttempt: 1,
      headSha: "a".repeat(40),
      conclusion: "success",
      job: {
        id: 90_700_000_001,
        name: "Read back provider destruction and absence",
        startedAt: "2026-08-03T07:51:00.000Z",
        completedAt: "2026-08-03T07:55:00.000Z",
        url: "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30700000001/job/90700000001"
      },
      artifact: {
        id: 8_770_000_001,
        name: "site-behavior-runner-destruction-evidence-30700000001-1",
        sha256: "c".repeat(64),
        url: "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30700000001/artifacts/8770000001"
      },
      readback: {
        path: "destruction-evidence.json",
        sha256: "e".repeat(64)
      }
    },
    operator: {
      attestedBy: "iAnonymous3000",
      evidenceRefs: [
        {
          kind: "github-actions-run-evidence",
          actionsRunId: 30_600_000_001,
          runUrl:
            "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000001",
          artifactName: "site-behavior-featured-publication-30600000001-1",
          artifactRef:
            "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000001/artifacts/8760000001",
          artifactSha256: "b".repeat(64)
        },
        {
          kind: "github-actions-run-evidence",
          actionsRunId: 30_700_000_001,
          runUrl:
            "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30700000001",
          artifactName:
            "site-behavior-runner-destruction-evidence-30700000001-1",
          artifactRef:
            "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30700000001/artifacts/8770000001",
          artifactSha256: "c".repeat(64)
        }
      ]
    }
  };
}

function bindRunnerReceiptToRun(
  receipt: ReturnType<typeof validReceipt>,
  actionsRunId: number
): void {
  const delta = actionsRunId - receipt.actionsRunId;
  receipt.actionsRunId = actionsRunId;
  receipt.runEvidence.job.url =
    `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${actionsRunId}/job/${receipt.runEvidence.job.id}`;
  receipt.runEvidence.artifact.name =
    `site-behavior-featured-publication-${actionsRunId}-${receipt.actionsRunAttempt}`;
  receipt.runEvidence.artifact.url =
    `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${actionsRunId}/artifacts/${receipt.runEvidence.artifact.id}`;
  receipt.operator.evidenceRefs[0].actionsRunId = actionsRunId;
  receipt.operator.evidenceRefs[0].runUrl =
    `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${actionsRunId}`;
  receipt.operator.evidenceRefs[0].artifactName =
    receipt.runEvidence.artifact.name;
  receipt.operator.evidenceRefs[0].artifactRef =
    receipt.runEvidence.artifact.url;
  receipt.destructionEvidence.runId += delta;
  receipt.destructionEvidence.job.id += delta;
  receipt.destructionEvidence.job.url =
    `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${receipt.destructionEvidence.runId}/job/${receipt.destructionEvidence.job.id}`;
  receipt.destructionEvidence.artifact.id += delta;
  receipt.destructionEvidence.artifact.name =
    `site-behavior-runner-destruction-evidence-${receipt.destructionEvidence.runId}-${receipt.destructionEvidence.runAttempt}`;
  receipt.destructionEvidence.artifact.url =
    `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${receipt.destructionEvidence.runId}/artifacts/${receipt.destructionEvidence.artifact.id}`;
  receipt.operator.evidenceRefs[1].actionsRunId =
    receipt.destructionEvidence.runId;
  receipt.operator.evidenceRefs[1].runUrl =
    `https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/${receipt.destructionEvidence.runId}`;
  receipt.operator.evidenceRefs[1].artifactName =
    receipt.destructionEvidence.artifact.name;
  receipt.operator.evidenceRefs[1].artifactRef =
    receipt.destructionEvidence.artifact.url;
}

function validLaterReceipt(): ReturnType<typeof validReceipt> {
  const receipt = structuredClone(validReceipt());
  bindRunnerReceiptToRun(receipt, receipt.actionsRunId + 1);
  receipt.runEvidence.collectionDate = "2026-08-10";
  receipt.runEvidence.job.startedAt = "2026-08-10T05:23:00.000Z";
  receipt.runEvidence.job.completedAt = "2026-08-10T07:40:00.000Z";
  receipt.operator.evidenceRefs[0].artifactSha256 = "d".repeat(64);
  receipt.runEvidence.artifact.sha256 = "d".repeat(64);
  receipt.provisioning.provisionedAt = "2026-08-10T05:20:00.000Z";
  receipt.destruction.destroyedAt = "2026-08-10T07:45:00.000Z";
  receipt.destruction.verifiedAbsentAt = "2026-08-10T07:50:00.000Z";
  receipt.destruction.verification = `sha256:${"1".repeat(64)}`;
  receipt.destructionEvidence.job.startedAt = "2026-08-10T07:51:00.000Z";
  receipt.destructionEvidence.job.completedAt = "2026-08-10T07:55:00.000Z";
  receipt.destructionEvidence.artifact.sha256 = "f".repeat(64);
  receipt.destructionEvidence.readback.sha256 = "1".repeat(64);
  receipt.operator.evidenceRefs[1].artifactSha256 = "f".repeat(64);
  receipt.recordedAt = "2026-08-10T08:00:00.000Z";
  return receipt;
}

test("a complete destruction receipt verifies and gains a canonical digest", async () => {
  const { verifyRunnerDestructionReceipt } = await script("runner-receipt-lib.mjs");
  const result = verifyRunnerDestructionReceipt(validReceipt());
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.match(result.receiptDigest, /^[0-9a-f]{64}$/);
});

test("boolean evidence gates must be literally true and timelines must be ordered", async () => {
  const { runnerDestructionReceiptIssues } = await script("runner-receipt-lib.mjs");

  const softened = validReceipt();
  (softened.isolation as Record<string, unknown>).cloudMetadataBlocked = "yes";
  assert.equal(
    runnerDestructionReceiptIssues(softened).some((issue: string) => /cloudMetadataBlocked/.test(issue)),
    true
  );

  const reversed = validReceipt();
  reversed.destruction.verifiedAbsentAt = "2026-08-03T07:00:00.000Z";
  assert.equal(
    runnerDestructionReceiptIssues(reversed).some((issue: string) => /must not precede/.test(issue)),
    true
  );

  const reused = validReceipt();
  reused.provisioning.registration.ephemeral = false as never;
  assert.equal(
    runnerDestructionReceiptIssues(reused).some((issue: string) => /ephemeral/.test(issue)),
    true
  );
});

test("runner identity and successful r2 run evidence are exact and cross-bound", async () => {
  const { runnerDestructionReceiptIssues } = await script("runner-receipt-lib.mjs");
  const rejects = (receipt: ReturnType<typeof validReceipt>, pattern: RegExp) => {
    assert.equal(
      runnerDestructionReceiptIssues(receipt).some((issue: string) => pattern.test(issue)),
      true,
      `expected ${pattern} in ${runnerDestructionReceiptIssues(receipt).join("; ")}`
    );
  };

  const wrongRepository = structuredClone(validReceipt());
  wrongRepository.provisioning.registration.repository = "somewhere/else";
  rejects(wrongRepository, /registration\.repository must be exactly/);

  const wrongWorkflow = structuredClone(validReceipt());
  wrongWorkflow.workflow = "scan.yml";
  rejects(wrongWorkflow, /workflow must be exactly scan-featured\.yml/);

  const mismatchedLabel = structuredClone(validReceipt());
  mismatchedLabel.provisioning.registration.labelRefs = [
    `sha256:${"0".repeat(64)}`
  ];
  rejects(mismatchedLabel, /labelRefs must include runnerLabelRef/);

  const rawIdentityLeak = structuredClone(validReceipt()) as unknown as {
    runnerLabel?: string;
    runnerLabelRef?: string;
  };
  rawIdentityLeak.runnerLabel = "private-runner-label";
  delete rawIdentityLeak.runnerLabelRef;
  assert.match(
    runnerDestructionReceiptIssues(rawIdentityLeak).join(" "),
    /runnerLabelRef|must contain exactly/
  );

  const missingRunEvidence = structuredClone(validReceipt()) as unknown as Record<string, unknown>;
  delete missingRunEvidence.runEvidence;
  rejects(
    missingRunEvidence as unknown as ReturnType<typeof validReceipt>,
    /runEvidence block is required/
  );

  for (const [field, value, pattern] of [
    ["conclusion", "neutral", /conclusion must be exactly success/],
    ["reportMode", "v1", /reportMode must be exactly r2/],
    ["acquisition", "public-api", /acquisition must be exactly ci-workflow/],
    ["headSha", "not-a-commit", /headSha must be a full lowercase Git commit/],
    ["catalog", "public/other.json", /catalog must name one committed featured collection catalog/]
  ] as const) {
    const invalid = structuredClone(validReceipt());
    invalid.runEvidence[field] = value;
    rejects(invalid, pattern);
  }

  const wrongJobRef = structuredClone(validReceipt());
  wrongJobRef.runEvidence.job.url =
    "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/99/job/90600000001";
  rejects(wrongJobRef, /job\.url must bind the exact repository/);

  const wrongArtifactName = structuredClone(validReceipt());
  wrongArtifactName.runEvidence.artifact.name = "site-behavior-featured-publication-30600000002-1";
  rejects(wrongArtifactName, /artifact\.name must bind the exact Actions run id and attempt/);

  const wrongArtifactRef = structuredClone(validReceipt());
  wrongArtifactRef.runEvidence.artifact.url =
    "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000001/artifacts/7";
  rejects(wrongArtifactRef, /artifact\.url must bind the exact repository/);

  const wrongArtifactDigest = structuredClone(validReceipt());
  wrongArtifactDigest.runEvidence.artifact.sha256 = "not-a-digest";
  rejects(wrongArtifactDigest, /artifact\.sha256 must be a lowercase sha256 digest/);
});

test("runner receipts reject unknown fields and require canonical run-bound evidence artifacts", async () => {
  const { runnerDestructionReceiptIssues } = await script("runner-receipt-lib.mjs");
  const rejects = (receipt: ReturnType<typeof validReceipt>, pattern: RegExp) => {
    const issues = runnerDestructionReceiptIssues(receipt);
    assert.equal(
      issues.some((issue: string) => pattern.test(issue)),
      true,
      `expected ${pattern} in ${issues.join("; ")}`
    );
  };

  const unknownRoot = structuredClone(validReceipt()) as ReturnType<typeof validReceipt> & {
    accessToken?: string;
  };
  unknownRoot.accessToken = "must-not-be-committed";
  rejects(unknownRoot, /receipt must contain exactly/);

  const arbitraryEvidence = structuredClone(validReceipt());
  arbitraryEvidence.operator.evidenceRefs = [
    "run-30600000001",
    "run-30700000001"
  ] as never;
  rejects(arbitraryEvidence, /evidenceRefs\[0\] must be an object/);

  const wrongRun = structuredClone(validReceipt());
  wrongRun.operator.evidenceRefs[0].actionsRunId += 1;
  wrongRun.operator.evidenceRefs[0].runUrl =
    "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000002";
  rejects(wrongRun, /actionsRunId must match the collection or hosted destruction run id/);

  const movingArtifact = structuredClone(validReceipt());
  movingArtifact.operator.evidenceRefs[0].artifactSha256 = "not-a-digest";
  rejects(movingArtifact, /artifactSha256 must be a lowercase sha256/);

  const duplicateArtifact = structuredClone(validReceipt());
  duplicateArtifact.operator.evidenceRefs.push(
    structuredClone(duplicateArtifact.operator.evidenceRefs[0])
  );
  rejects(
    duplicateArtifact,
    /must contain exactly the collection and hosted destruction artifacts/
  );

  const detachedCollection = structuredClone(validReceipt());
  detachedCollection.operator.evidenceRefs[0].artifactSha256 = "2".repeat(64);
  rejects(detachedCollection, /must bind the exact collection artifact/);
});

test("the complete provisioning, job, destruction, absence, and recording timeline is ordered", async () => {
  const { runnerDestructionReceiptIssues } = await script("runner-receipt-lib.mjs");
  const rejects = (receipt: ReturnType<typeof validReceipt>, pattern: RegExp) => {
    assert.equal(
      runnerDestructionReceiptIssues(receipt).some((issue: string) => pattern.test(issue)),
      true,
      `expected ${pattern} in ${runnerDestructionReceiptIssues(receipt).join("; ")}`
    );
  };

  const provisionedLate = structuredClone(validReceipt());
  provisionedLate.provisioning.provisionedAt = "2026-08-03T05:24:00.000Z";
  rejects(provisionedLate, /provisionedAt must not be after/);

  const nonCanonicalRecording = structuredClone(validReceipt());
  nonCanonicalRecording.recordedAt = "2026-08-03";
  rejects(nonCanonicalRecording, /recordedAt must be an ISO 8601 timestamp/);

  const impossibleRecording = structuredClone(validReceipt());
  impossibleRecording.recordedAt = "2026-02-31T08:00:00.000Z";
  rejects(impossibleRecording, /recordedAt must be an ISO 8601 timestamp/);

  const completedBeforeStart = structuredClone(validReceipt());
  completedBeforeStart.runEvidence.job.completedAt = "2026-08-03T05:22:00.000Z";
  rejects(completedBeforeStart, /job\.completedAt must be after/);

  const wrongCollectionDate = structuredClone(validReceipt());
  wrongCollectionDate.runEvidence.collectionDate = "2026-08-04";
  rejects(wrongCollectionDate, /collectionDate must equal the UTC date/);

  const impossibleCollectionDate = structuredClone(validReceipt());
  impossibleCollectionDate.runEvidence.collectionDate = "2026-99-99";
  rejects(impossibleCollectionDate, /collectionDate must be a real YYYY-MM-DD UTC date/);

  const destroyedBeforeCompletion = structuredClone(validReceipt());
  destroyedBeforeCompletion.destruction.destroyedAt = "2026-08-03T07:39:00.000Z";
  rejects(destroyedBeforeCompletion, /destroyedAt must be after runEvidence\.job\.completedAt/);

  const recordedBeforeAbsence = structuredClone(validReceipt());
  recordedBeforeAbsence.recordedAt = recordedBeforeAbsence.destruction.verifiedAbsentAt;
  rejects(recordedBeforeAbsence, /recordedAt must be after destruction\.verifiedAbsentAt/);
});

test("a verified receipt set requires distinct UTC collection dates", async () => {
  const {
    runnerDestructionReceiptSetIssues,
    verifyRunnerDestructionReceipt
  } = await script("runner-receipt-lib.mjs");
  const first = validReceipt();
  const duplicateDate = structuredClone(validReceipt());
  bindRunnerReceiptToRun(duplicateDate, duplicateDate.actionsRunId + 1);
  duplicateDate.operator.evidenceRefs[0].artifactSha256 = "d".repeat(64);
  duplicateDate.runEvidence.artifact.sha256 = "d".repeat(64);
  assert.match(
    runnerDestructionReceiptSetIssues([first, duplicateDate]).join(" "),
    /collectionDate 2026-08-03 duplicates/
  );

  const later = validLaterReceipt();
  assert.equal(verifyRunnerDestructionReceipt(later).ok, true);
  assert.deepEqual(runnerDestructionReceiptSetIssues([first, later]), []);
});

test("runner receipt sets bind a compatible environment, candidate, epoch, and freshness window", async () => {
  const {
    runnerDestructionEnvironmentDigest,
    runnerDestructionReceiptSetIssues,
    verifyRunnerDestructionReceiptSet
  } = await script("runner-receipt-lib.mjs");
  const first = validReceipt();
  const later = validLaterReceipt();
  const now = Date.parse("2026-08-11T00:00:00.000Z");
  const options = {
    expectedCandidateCommit: "a".repeat(40),
    expectedEnvironmentDigest: runnerDestructionEnvironmentDigest(first),
    epochStartedAt: "2026-08-01T00:00:00.000Z",
    now,
    maxAgeDays: 30
  };

  assert.match(
    runnerDestructionReceiptSetIssues([first], options).join(" "),
    /at least two controlled cycles/
  );
  const verified = verifyRunnerDestructionReceiptSet([first, later], options);
  assert.equal(verified.ok, true, verified.issues.join("; "));
  assert.match(verified.environmentDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(verified.sourceCommits, ["a".repeat(40)]);
  assert.equal(verified.earliestCollectionAt, first.runEvidence.job.startedAt);
  assert.equal(verified.latestRecordedAt, later.recordedAt);

  const environmentDrift = structuredClone(later);
  environmentDrift.egress.natIdentityRef =
    "sha256:5b59d1e92464c5fbc0a1bf9f8afc9c901a1ffe7d2283511894e767e5e933c0b9";
  assert.match(
    runnerDestructionReceiptSetIssues([first, environmentDrift], options).join(" "),
    /environment tuple/
  );
  assert.match(
    runnerDestructionReceiptSetIssues([first, later], {
      ...options,
      expectedEnvironmentDigest: "0".repeat(64)
    }).join(" "),
    /does not match expectedEnvironmentDigest/
  );

  assert.match(
    runnerDestructionReceiptSetIssues([first, later], {
      ...options,
      expectedCandidateCommit: "b".repeat(40)
    }).join(" "),
    /does not match expectedCandidateCommit/
  );
  assert.match(
    runnerDestructionReceiptSetIssues([first, later], {
      ...options,
      epochStartedAt: "2026-08-04T00:00:00.000Z"
    }).join(" "),
    /began before epochStartedAt/
  );
  assert.match(
    runnerDestructionReceiptSetIssues([first, later], {
      ...options,
      now: Date.parse("2026-08-09T00:00:00.000Z")
    }).join(" "),
    /recordedAt is in the future/
  );
  assert.match(
    runnerDestructionReceiptSetIssues([first, later], {
      ...options,
      now: Date.parse("2026-09-15T00:00:00.000Z"),
      maxAgeDays: 30
    }).join(" "),
    /recordedAt is older than 30 days/
  );
});

test("runner receipt CLI rejects noncanonical and duplicate-key bytes and prints the verified environment digest", async () => {
  const { serializeRunnerDestructionReceipt } = await script(
    "runner-receipt-lib.mjs"
  );
  const directory = mkdtempSync(path.join(tmpdir(), "sbl-runner-receipts-"));
  try {
    const malformedPath = path.join(directory, "malformed.json");
    writeFileSync(malformedPath, "{not-json}\n");
    const malformed = spawnSync(process.execPath, [RUNNER_RECEIPT_VALIDATOR, malformedPath], {
      encoding: "utf8"
    });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stdout, /FAIL .*malformed\.json/);
    assert.doesNotMatch(malformed.stderr, /SyntaxError|at JSON\.parse/);

    const noncanonicalPath = path.join(directory, "noncanonical.json");
    writeFileSync(
      noncanonicalPath,
      `${JSON.stringify(validReceipt(), null, 2)}\n`
    );
    const noncanonical = spawnSync(
      process.execPath,
      [RUNNER_RECEIPT_VALIDATOR, noncanonicalPath],
      { encoding: "utf8" }
    );
    assert.equal(noncanonical.status, 1);
    assert.match(
      noncanonical.stdout,
      /must use the exact canonical receipt serialization/
    );

    const canonicalFirst = serializeRunnerDestructionReceipt(validReceipt());
    const duplicateKeyPath = path.join(directory, "duplicate-key.json");
    writeFileSync(
      duplicateKeyPath,
      canonicalFirst.replace(
        /^\{/,
        '{"kind":"hidden-alternate-value",'
      )
    );
    const duplicateKey = spawnSync(
      process.execPath,
      [RUNNER_RECEIPT_VALIDATOR, duplicateKeyPath],
      { encoding: "utf8" }
    );
    assert.equal(duplicateKey.status, 1);
    assert.match(
      duplicateKey.stdout,
      /must use the exact canonical receipt serialization/
    );

    const invalidUtf8Path = path.join(directory, "invalid-utf8.json");
    writeFileSync(invalidUtf8Path, Buffer.from([0xff]));
    const invalidUtf8 = spawnSync(
      process.execPath,
      [RUNNER_RECEIPT_VALIDATOR, invalidUtf8Path],
      { encoding: "utf8" }
    );
    assert.equal(invalidUtf8.status, 1);
    assert.match(invalidUtf8.stdout, /must contain valid UTF-8/);

    rmSync(noncanonicalPath);
    rmSync(duplicateKeyPath);
    rmSync(invalidUtf8Path);
    writeFileSync(path.join(directory, "first.json"), canonicalFirst);
    writeFileSync(
      path.join(directory, "later.json"),
      serializeRunnerDestructionReceipt(validLaterReceipt())
    );
    rmSync(malformedPath);
    const valid = spawnSync(process.execPath, [RUNNER_RECEIPT_VALIDATOR, directory], {
      encoding: "utf8"
    });
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    assert.match(valid.stdout, /2\/2 receipts individually verified; receipt set verified/);
    assert.match(valid.stdout, /environment sha256:[0-9a-f]{64}/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the lifecycle validator flags the exact observed defect: 7-day and 8-day rules racing", async () => {
  const { validateReportsLifecycleRules } = await script("r2-lifecycle-lib.mjs");
  const day = 86_400;

  const conflicting = validateReportsLifecycleRules([
    {
      id: "reports-retention-backstop-8d",
      enabled: true,
      conditions: { prefix: "reports/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 8 * day } }
    },
    {
      id: "stale-7d-rule",
      enabled: true,
      conditions: { prefix: "reports/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 7 * day } }
    }
  ]);
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.violations.some((violation: string) => /2 enabled deletion rules/.test(violation)), true);
  assert.equal(conflicting.violations.some((violation: string) => /7 days/.test(violation)), true);

  const healthy = validateReportsLifecycleRules([
    {
      id: "reports-retention-backstop-8d",
      enabled: true,
      conditions: { prefix: "reports/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 8 * day } }
    },
    {
      id: "multipart-abort",
      enabled: true,
      conditions: { prefix: "" },
      abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: day } }
    },
    {
      id: "v2-shadow-drain",
      enabled: true,
      conditions: { prefix: "v2-shadow/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * day } }
    }
  ]);
  assert.equal(healthy.ok, true, healthy.violations.join("; "));
  assert.deepEqual(healthy.observed.map((rule: { id: string }) => rule.id), [
    "reports-retention-backstop-8d"
  ]);

  const missing = validateReportsLifecycleRules([]);
  assert.equal(missing.ok, false);
  assert.equal(missing.violations.some((violation: string) => /no enabled reports\//.test(violation)), true);

  const blanket = validateReportsLifecycleRules([
    {
      id: "delete-everything-fast",
      enabled: true,
      conditions: { prefix: "" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 2 * day } }
    }
  ]);
  assert.equal(blanket.ok, false, "an all-objects deletion rule shorter than the backstop must fail");

  for (const prefix of ["reports/tmp/", "report", ""]) {
    const intersecting = validateReportsLifecycleRules([
      {
        id: "reports-retention-backstop-8d",
        enabled: true,
        conditions: { prefix: "reports/" },
        deleteObjectsTransition: {
          condition: { type: "Age", maxAge: 8 * day }
        }
      },
      {
        id: `intersecting-${prefix || "bucket-wide"}`,
        enabled: true,
        conditions: { prefix },
        deleteObjectsTransition: {
          condition: { type: "Age", maxAge: 30 * day }
        }
      }
    ]);
    assert.equal(
      intersecting.ok,
      false,
      `${JSON.stringify(prefix)} must not share deletion authority over reports/`
    );
    assert.match(
      intersecting.violations.join(" "),
      /intersects reports\//
    );
  }

  const childOnly = validateReportsLifecycleRules([
    {
      id: "child-is-not-the-backstop",
      enabled: true,
      conditions: { prefix: "reports/tmp/" },
      deleteObjectsTransition: {
        condition: { type: "Age", maxAge: 8 * day }
      }
    }
  ]);
  assert.equal(childOnly.ok, false);
  assert.match(
    childOnly.violations.join(" "),
    /exact reports\/ prefix/
  );
});

test("the lifecycle receipt authenticates exact source bytes and every derived field", async () => {
  const {
    buildR2LifecycleReadbackReceipt,
    validateR2LifecycleReadbackReceipt
  } = await script("r2-lifecycle-lib.mjs");
  const sourceBytes = `${JSON.stringify({
    success: true,
    result: {
      rules: [
        {
          id: "reports-retention-backstop-8d",
          enabled: true,
          conditions: { prefix: "reports/" },
          deleteObjectsTransition: {
            condition: { type: "Age", maxAge: 8 * 86_400 }
          }
        }
      ]
    },
    errors: [],
    messages: []
  })}\n`;
  const receipt = buildR2LifecycleReadbackReceipt({
    bucket: "site-behavior-lab-reports",
    source: "cloudflare-api",
    recordedAt: "2026-08-01T12:00:00.000Z",
    sourceBytes
  });
  const verdict = validateR2LifecycleReadbackReceipt(receipt);
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.equal(receipt.ok, true);
  assert.match(verdict.bindings.sourceArtifactDigest, /^[0-9a-f]{64}$/);
  assert.match(verdict.bindings.receiptDigest, /^[0-9a-f]{64}$/);

  const forgedRules = structuredClone(receipt);
  forgedRules.rules = [];
  assert.match(
    validateR2LifecycleReadbackReceipt(forgedRules).problems.join(" "),
    /authenticated source bytes/
  );

  const forgedVerdict = structuredClone(receipt);
  forgedVerdict.ok = false;
  assert.match(
    validateR2LifecycleReadbackReceipt(forgedVerdict).problems.join(" "),
    /ok must exactly match/
  );

  const forgedSource = structuredClone(receipt);
  forgedSource.sourceArtifact.data = Buffer.from("{}\n").toString("base64");
  assert.match(
    validateR2LifecycleReadbackReceipt(forgedSource).problems.join(" "),
    /byteLength|digest|cannot be verified/
  );

  const forgedDigest = structuredClone(receipt);
  forgedDigest.receiptDigest = "f".repeat(64);
  assert.match(
    validateR2LifecycleReadbackReceipt(forgedDigest).problems.join(" "),
    /bind the exact canonical receipt/
  );
});

test("the lifecycle capture uses an exact local CLI and bounded no-redirect atomic I/O", () => {
  const source = readFileSync(
    path.join(process.cwd(), "scripts", "r2-lifecycle-readback.mjs"),
    "utf8"
  );
  assert.doesNotMatch(source, /execFileSync\(\s*["']npx["']/);
  assert.match(
    source,
    /node_modules["'],\s*["']\.bin["'],\s*["']wrangler["']/
  );
  assert.match(source, /timeout:\s*OPERATION_TIMEOUT_MS/);
  assert.match(source, /maxBuffer:\s*R2_LIFECYCLE_SOURCE_MAX_BYTES/);
  assert.match(source, /withHttpOperationDeadline/);
  assert.match(source, /redirect:\s*["']error["']/);
  assert.match(source, /writeExclusiveAtomic/);
});

test("the hosted lifecycle workflow captures the live API receipt under the pinned provenance contract", () => {
  const workflow = readFileSync(
    path.join(
      process.cwd(),
      ".github",
      "workflows",
      "r2-lifecycle-evidence.yml"
    ),
    "utf8"
  );
  assert.match(workflow, /^name: R2 Lifecycle Evidence$/m);
  assert.match(workflow, /name: Read back production R2 lifecycle/);
  assert.match(
    workflow,
    /github\.repository == 'iAnonymous3000\/site-behavior-lab'[\s\S]*github\.ref == 'refs\/heads\/main'/
  );
  assert.match(workflow, /environment: release-evidence/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(
    workflow,
    /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_R2_LIFECYCLE_READ_TOKEN \}\}/
  );
  assert.match(
    workflow,
    /node scripts\/r2-lifecycle-readback\.mjs \\\n\s+hosted-r2-lifecycle-evidence\/receipt\.json/
  );
  assert.match(
    workflow,
    /name: site-behavior-r2-lifecycle-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  assert.match(
    workflow,
    /path: hosted-r2-lifecycle-evidence\/receipt\.json/
  );
  assert.doesNotMatch(workflow, /--from-wrangler|npx\s+wrangler/);
  for (const action of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
    assert.match(
      action[1],
      /^[^@]+@[0-9a-f]{40}$/,
      `workflow action is not SHA-pinned: ${action[1]}`
    );
  }
});
