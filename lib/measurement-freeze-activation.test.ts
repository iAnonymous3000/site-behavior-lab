import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, any>;
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ScriptExports>;

function script(name: string) {
  return nativeImport(
    pathToFileURL(path.join(process.cwd(), "scripts", name)).href
  );
}

const NOW = "2026-08-11T12:04:00.000Z";
const CANDIDATE = "a".repeat(40);
const RUN_ID = 30_700_000_001;
const RUN_ATTEMPT = 1;
const RUNNER_LABEL = "sbl-controlled-r2-ephemeral";
const REGION = "us-west";
const READJUDICATION_RECEIPT_SHA256 = "1".repeat(64);
const FEATURED_SITES_SHA256 = "2".repeat(64);
const FEATURED_TARGETS_SHA256 = "0".repeat(64);
const READJUDICATION_DISPOSITIONS_SHA256 = "3".repeat(64);

function validReadjudicationEvidence() {
  return {
    receiptPath: "research/ops-receipts/featured-readjudication.json",
    receiptSha256: READJUDICATION_RECEIPT_SHA256,
    verifiedAt: "2026-08-11T12:00:30.000Z",
    finalFeaturedSitesSha256: FEATURED_SITES_SHA256,
    finalFeaturedTargetsSha256: FEATURED_TARGETS_SHA256,
    dispositionsSha256: READJUDICATION_DISPOSITIONS_SHA256,
    cycles: [
      {
        date: "2026-08-03",
        runId: 30_600_000_003,
        runAttempt: 1,
        headSha: "1".repeat(40),
        runStartedAt: "2026-08-03T05:24:00.000Z",
        workflowSha256: "4".repeat(64),
        catalogSha256: "b".repeat(64),
        catalogTargetsSha256: FEATURED_TARGETS_SHA256,
        catalogVersion: 2,
        artifactId: 4_000_000_003,
        artifactName:
          "featured-readjudication-outcomes-30600000003-1",
        artifactSha256: "5".repeat(64),
        artifactCreatedAt: "2026-08-03T06:45:00.000Z",
        outcomesSha256: "6".repeat(64)
      },
      {
        date: "2026-08-10",
        runId: 30_600_000_010,
        runAttempt: 2,
        headSha: "7".repeat(40),
        runStartedAt: "2026-08-10T05:25:00.000Z",
        workflowSha256: "8".repeat(64),
        catalogSha256: "c".repeat(64),
        catalogTargetsSha256: FEATURED_TARGETS_SHA256,
        catalogVersion: 2,
        artifactId: 4_000_000_010,
        artifactName:
          "featured-readjudication-outcomes-30600000010-2",
        artifactSha256: "9".repeat(64),
        artifactCreatedAt: "2026-08-10T06:50:00.000Z",
        outcomesSha256: "a".repeat(64)
      }
    ]
  };
}

async function validReceipt() {
  const { buildMeasurementFreezeActivationReceipt } = await script(
    "measurement-freeze-activation-lib.mjs"
  );
  return buildMeasurementFreezeActivationReceipt({
    candidateSha: CANDIDATE,
    checkoutCommit: CANDIDATE,
    mainRefCommit: CANDIDATE,
    mainRefObservedAt: "2026-08-11T12:01:45.000Z",
    activationWorkflowSha256: "b".repeat(64),
    runHeadSha: CANDIDATE,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    runStartedAt: "2026-08-11T12:00:00.000Z",
    activatedAt: "2026-08-11T12:02:00.000Z",
    featuredWorkflowSha256: "c".repeat(64),
    reAdjudication: validReadjudicationEvidence(),
    configuration: {
      measurementFreeze: "1",
      runnerLabel: RUNNER_LABEL,
      scannerEgress: "controlled-self-hosted",
      scannerEgressRegion: REGION,
      featuredR2EgressAttested: "1"
    },
    controlledRunnerQueriedAt: "2026-08-11T12:01:00.000Z",
    controlledRunnerMatches: [
      {
        identitySha256: "d".repeat(64),
        nameSha256: "e".repeat(64),
        labelSetSha256: "f".repeat(64),
        status: "online",
        busy: false
      }
    ],
    proposalCheckedAt: "2026-08-11T12:01:30.000Z",
    proposalSnapshots: []
  });
}

function expectedOptions() {
  return {
    now: NOW,
    expectedRepository: "iAnonymous3000/site-behavior-lab",
    expectedCandidateSha: CANDIDATE,
    expectedRunId: RUN_ID,
    expectedRunAttempt: RUN_ATTEMPT,
    expectedActivationWorkflowSha256: "b".repeat(64),
    expectedFeaturedWorkflowSha256: "c".repeat(64),
    expectedReAdjudicationReceiptSha256:
      READJUDICATION_RECEIPT_SHA256,
    expectedFeaturedSitesSha256: FEATURED_SITES_SHA256,
    expectedFeaturedTargetsSha256: FEATURED_TARGETS_SHA256,
    expectedReAdjudicationDispositionsSha256:
      READJUDICATION_DISPOSITIONS_SHA256,
    expectedMeasurementFreeze: "1",
    expectedRunnerLabel: RUNNER_LABEL,
    expectedScannerEgress: "controlled-self-hosted",
    expectedScannerEgressRegion: REGION,
    expectedFeaturedR2EgressAttested: "1"
  };
}

test("a canonical activation receipt verifies without exposing the runner label or region", async () => {
  const {
    measurementFreezeReceiptText,
    parseAndVerifyMeasurementFreezeActivationReceipt,
    verifyMeasurementFreezeActivationReceipt
  } = await script("measurement-freeze-activation-lib.mjs");
  const receipt = await validReceipt();
  const result = verifyMeasurementFreezeActivationReceipt(
    receipt,
    expectedOptions()
  );
  assert.equal(result.ok, true, result.issues.join("; "));
  assert.match(result.receiptSha256, /^[0-9a-f]{64}$/);

  const text = measurementFreezeReceiptText(receipt);
  assert.notEqual(
    text,
    `${JSON.stringify(receipt, null, 2)}\n`,
    "schema insertion order must not masquerade as canonical key order"
  );
  assert.equal(
    parseAndVerifyMeasurementFreezeActivationReceipt(text, expectedOptions()).ok,
    true
  );
  assert.equal(text.includes(RUNNER_LABEL), false);
  assert.equal(text.includes(REGION), false);
  assert.match(receipt.safeConfiguration.runnerLabelSha256, /^[0-9a-f]{64}$/);
  assert.match(
    receipt.safeConfiguration.scannerEgressRegionSha256,
    /^[0-9a-f]{64}$/
  );
  assert.equal(receipt.controlledRunner.onlineMatches.length, 1);
  assert.equal(receipt.receiptVersion, 2);
  assert.deepEqual(
    receipt.reAdjudication.cycles.map(
      (cycle: Record<string, unknown>) => cycle.date
    ),
    ["2026-08-03", "2026-08-10"]
  );
  assert.equal(
    receipt.claims.includes(
      "august-featured-readjudication-live-artifacts-verified"
    ),
    true
  );
  assert.equal(
    receipt.handoff.archivePath,
    "research/ops-receipts/measurement-freeze-activation.json"
  );
});

test("capture ordering validates at activation rather than the earlier proposal snapshot", async () => {
  const { verifyMeasurementFreezeActivationReceipt } = await script(
    "measurement-freeze-activation-lib.mjs"
  );
  const receipt = await validReceipt();
  assert.ok(
    Date.parse(receipt.proposalGuard.checkedAt) <
      Date.parse(receipt.candidate.mainRefObservedAt)
  );
  assert.ok(
    Date.parse(receipt.candidate.mainRefObservedAt) <
      Date.parse(receipt.activation.activatedAt)
  );
  const result = verifyMeasurementFreezeActivationReceipt(receipt, {
    ...expectedOptions(),
    now: receipt.activation.activatedAt
  });
  assert.equal(result.ok, true, result.issues.join("; "));
});

test("receipt bytes, fields, identity, timestamps, and run references fail closed", async () => {
  const {
    measurementFreezeActivationReceiptIssues,
    parseAndVerifyMeasurementFreezeActivationReceipt
  } = await script("measurement-freeze-activation-lib.mjs");
  const receipt = await validReceipt();
  const compact = JSON.stringify(receipt);
  assert.equal(
    parseAndVerifyMeasurementFreezeActivationReceipt(
      compact,
      expectedOptions()
    ).issues.some((issue: string) => /canonical two-space JSON/.test(issue)),
    true
  );

  const rejects = async (
    mutate: (candidate: Record<string, any>) => void,
    pattern: RegExp
  ) => {
    const candidate = structuredClone(await validReceipt());
    mutate(candidate);
    const issues = measurementFreezeActivationReceiptIssues(
      candidate,
      expectedOptions()
    );
    assert.equal(
      issues.some((issue: string) => pattern.test(issue)),
      true,
      `expected ${pattern} in ${issues.join("; ")}`
    );
  };

  await rejects((candidate) => {
    candidate.verdict = "ready";
  }, /receipt must contain exactly/);
  await rejects((candidate) => {
    candidate.safeConfiguration.passed = true;
  }, /safeConfiguration must contain exactly/);
  await rejects((candidate) => {
    candidate.reAdjudication.liveVerified = true;
  }, /reAdjudication must contain exactly/);
  await rejects((candidate) => {
    candidate.reAdjudication.cycles[1].runId =
      candidate.reAdjudication.cycles[0].runId;
  }, /runId must be distinct/);
  await rejects((candidate) => {
    candidate.reAdjudication.cycles[0].artifactName =
      "featured-readjudication-outcomes-latest";
  }, /artifactName must bind/);
  await rejects((candidate) => {
    candidate.reAdjudication.cycles[1].catalogTargetsSha256 =
      "e".repeat(64);
  }, /one identical fixed-domain target identity/);
  await rejects((candidate) => {
    candidate.reAdjudication.finalFeaturedTargetsSha256 =
      "e".repeat(64);
  }, /does not match the validator's expected value/);
  await rejects((candidate) => {
    candidate.reAdjudication.cycles[0].runStartedAt =
      "2026-08-04T05:24:00.000Z";
  }, /must fall on 2026-08-03/);
  await rejects((candidate) => {
    candidate.reAdjudication.receiptSha256 = "f".repeat(64);
  }, /receiptSha256 does not match/);
  await rejects((candidate) => {
    candidate.reAdjudication.verifiedAt = "2026-08-11T12:01:10.000Z";
  }, /controlledRunner observation must follow/);
  await rejects((candidate) => {
    candidate.candidate.mainRefCommit = "e".repeat(40);
  }, /must match exactly/);
  await rejects((candidate) => {
    candidate.activation.runUrl =
      "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/99";
  }, /runUrl must bind/);
  await rejects((candidate) => {
    candidate.handoff.artifactName = "measurement-freeze-activation-latest";
  }, /artifactName must bind/);
  await rejects((candidate) => {
    candidate.activation.activatedAt = "2026-08-11T12:05:00.000Z";
  }, /must not be in the future/);
  await rejects((candidate) => {
    candidate.proposalGuard.snapshotSha256 = "f".repeat(64);
  }, /snapshotSha256 does not match/);
  await rejects((candidate) => {
    candidate.controlledRunner.onlineMatches = [];
  }, /must contain 1 through 100/);
  await rejects((candidate) => {
    candidate.controlledRunner.onlineMatches[0].hostName = "do-not-publish";
  }, /onlineMatches\[0\] must contain exactly/);
  await rejects((candidate) => {
    candidate.candidate.mainRefObservedAt = "2026-08-11T12:01:20.000Z";
  }, /main ref must be re-read after/);
  await rejects((candidate) => {
    candidate.activation.activatedAt = "2026-08-11T12:01:40.000Z";
  }, /must not precede the main-ref observation/);
});

test("any open automation or Dependabot proposal is refused, even before its checks turn green", async () => {
  const { measurementFreezeActivationReceiptIssues, sha256Hex } = await script(
    "measurement-freeze-activation-lib.mjs"
  );
  const receipt = await validReceipt();
  receipt.proposalGuard.snapshots = [
    {
      number: 41,
      headRef: "automation/pending-before-freeze",
      headSha: "d".repeat(40)
    }
  ];
  receipt.proposalGuard.snapshotSha256 = sha256Hex(
    JSON.stringify(receipt.proposalGuard.snapshots)
  );
  const issues = measurementFreezeActivationReceiptIssues(
    receipt,
    expectedOptions()
  );
  assert.equal(
    issues.some((issue: string) => /must be empty/.test(issue)),
    true,
    issues.join("; ")
  );
});

test("live configuration and external expected identities are independently rebound", async () => {
  const { measurementFreezeActivationReceiptIssues } = await script(
    "measurement-freeze-activation-lib.mjs"
  );
  const receipt = await validReceipt();
  const wrongCandidate = measurementFreezeActivationReceiptIssues(receipt, {
    ...expectedOptions(),
    expectedCandidateSha: "f".repeat(40)
  });
  assert.equal(
    wrongCandidate.some((issue: string) =>
      /candidate\.commit does not match/.test(issue)
    ),
    true
  );

  const wrongRunner = measurementFreezeActivationReceiptIssues(receipt, {
    ...expectedOptions(),
    expectedRunnerLabel: "a-different-controlled-runner"
  });
  assert.equal(
    wrongRunner.some((issue: string) => /runnerLabelSha256 does not match/.test(issue)),
    true
  );

  const wrongRun = measurementFreezeActivationReceiptIssues(receipt, {
    ...expectedOptions(),
    expectedRunId: RUN_ID + 1
  });
  assert.equal(
    wrongRun.some((issue: string) => /activation\.runId does not match/.test(issue)),
    true
  );
});

test("configuration refuses missing, generic, unknown, or non-r2 values", async () => {
  const { safeMeasurementFreezeConfiguration } = await script(
    "measurement-freeze-activation-lib.mjs"
  );
  const base = {
    measurementFreeze: "1",
    runnerLabel: RUNNER_LABEL,
    scannerEgress: "controlled-self-hosted",
    scannerEgressRegion: REGION,
    featuredR2EgressAttested: "1"
  };
  for (const [field, value, pattern] of [
    ["measurementFreeze", "0", /MEASUREMENT_FREEZE/],
    ["runnerLabel", "self-hosted", /custom controlled-runner/],
    ["scannerEgress", "github-actions-ubuntu", /controlled-self-hosted/],
    ["scannerEgressRegion", "unknown", /SCANNER_EGRESS_REGION/],
    ["featuredR2EgressAttested", "yes", /EGRESS_ATTESTED/]
  ] as const) {
    assert.throws(
      () => safeMeasurementFreezeConfiguration({ ...base, [field]: value }),
      pattern
    );
  }
});

test("the featured workflow digest is backed by the controlled-r2 contract", async () => {
  const { featuredControlledR2WorkflowIssues } = await script(
    "measurement-freeze-activation-lib.mjs"
  );
  const source = readFileSync(
    path.join(process.cwd(), ".github/workflows/scan-featured.yml"),
    "utf8"
  );
  assert.deepEqual(featuredControlledR2WorkflowIssues(source), []);
  assert.equal(
    featuredControlledR2WorkflowIssues(
      source.replace(
        "(vars.FEATURED_RUNNER_LABEL && 'r2' || 'v1')",
        "'v1'"
      )
    ).some((issue: string) => /FEATURED_RUNNER_LABEL/.test(issue)),
    true
  );
});

test("the validator CLI accepts only canonical receipts", async () => {
  const { measurementFreezeReceiptText, sha256Hex } = await script(
    "measurement-freeze-activation-lib.mjs"
  );
  const {
    buildFeaturedReadjudicationCycle,
    buildFeaturedReadjudicationReceipt,
    canonicalFeaturedReadjudicationText,
    FEATURED_READJUDICATION_DOMAINS,
    featuredReadjudicationDispositionsSha256,
    featuredReadjudicationOutcomesSha256
  } = await script("featured-readjudication-lib.mjs");
  const directory = mkdtempSync(
    path.join(tmpdir(), "sbl-measurement-freeze-")
  );
  try {
    const canonicalPath = path.join(directory, "canonical.json");
    const compactPath = path.join(directory, "compact.json");
    const featuredSitesFixture = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "public/featured-sites.json"),
        "utf8"
      )
    );
    for (const site of featuredSitesFixture.sites) {
      delete site.scanAvailability;
    }
    const featuredSitesBytes = Buffer.from(
      `${JSON.stringify(featuredSitesFixture, null, 2)}\n`,
      "utf8"
    );
    const scanResults = FEATURED_READJUDICATION_DOMAINS.map(
      (domain: string, index: number) => ({
        domain,
        status: "available",
        reportId: `20260803-${index.toString(16).padStart(32, "0")}`,
        attemptCount: 1
      })
    );
    const cycleInputs = validReadjudicationEvidence().cycles;
    const cycles = cycleInputs.map(
      (binding: Record<string, any>, index: number) =>
        buildFeaturedReadjudicationCycle({
          repository: "iAnonymous3000/site-behavior-lab",
          workflow: ".github/workflows/scan-featured.yml",
          runId: binding.runId,
          runAttempt: binding.runAttempt,
          headSha: binding.headSha,
          event: "schedule",
          schedule: "23 5 * * 1",
          catalogPath: "public/featured-sites.json",
          catalogBytes: featuredSitesBytes,
          summary: {
            scanResults: scanResults.map(
              (entry: Record<string, unknown>) => ({
                ...entry,
                reportId: String(entry.reportId).replace(
                  "20260803",
                  index === 0 ? "20260803" : "20260810"
                )
              })
            )
          }
        })
    );
    const aggregate = buildFeaturedReadjudicationReceipt({
      cycles: cycles.map((cycle: Record<string, any>, index: number) => ({
        cycle,
        artifactId: cycleInputs[index].artifactId,
        artifactName: cycleInputs[index].artifactName,
        artifactSha256: cycleInputs[index].artifactSha256
      })),
      featuredSitesBytes
    });
    const aggregateText = canonicalFeaturedReadjudicationText(aggregate);
    const aggregatePath = path.join(
      directory,
      "research/ops-receipts/featured-readjudication.json"
    );
    const featuredPath = path.join(
      directory,
      "public/featured-sites.json"
    );
    mkdirSync(path.dirname(aggregatePath), { recursive: true });
    mkdirSync(path.dirname(featuredPath), { recursive: true });
    writeFileSync(aggregatePath, aggregateText);
    writeFileSync(featuredPath, featuredSitesBytes);
    const receipt = await validReceipt();
    receipt.reAdjudication.receiptSha256 = sha256Hex(aggregateText);
    receipt.reAdjudication.finalFeaturedSitesSha256 =
      sha256Hex(featuredSitesBytes);
    receipt.reAdjudication.finalFeaturedTargetsSha256 =
      aggregate.finalFeaturedSites.targetsSha256;
    receipt.reAdjudication.dispositionsSha256 =
      featuredReadjudicationDispositionsSha256(aggregate);
    for (const [index, cycle] of cycles.entries()) {
      receipt.reAdjudication.cycles[index].catalogSha256 =
        cycle.catalog.sha256;
      receipt.reAdjudication.cycles[index].catalogTargetsSha256 =
        cycle.catalog.targetsSha256;
      receipt.reAdjudication.cycles[index].catalogVersion =
        cycle.catalog.version;
      receipt.reAdjudication.cycles[index].outcomesSha256 =
        featuredReadjudicationOutcomesSha256(cycle);
    }
    writeFileSync(canonicalPath, measurementFreezeReceiptText(receipt));
    writeFileSync(compactPath, JSON.stringify(receipt));
    const env = { ...process.env };
    delete env.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE;
    delete env.FEATURED_RUNNER_LABEL;
    delete env.SCANNER_EGRESS;
    delete env.SCANNER_EGRESS_REGION;
    delete env.FEATURED_R2_EGRESS_ATTESTED;
    const validator = path.join(
      process.cwd(),
      "scripts/validate-measurement-freeze-activation-receipt.mjs"
    );

    const valid = spawnSync(
      process.execPath,
      [
        validator,
        "--receipt",
        canonicalPath,
        "--candidate",
        CANDIDATE,
        "--run-id",
        String(RUN_ID),
        "--run-attempt",
        String(RUN_ATTEMPT),
        "--readjudication-receipt",
        "research/ops-receipts/featured-readjudication.json",
        "--featured-sites",
        "public/featured-sites.json",
        "--now",
        NOW
      ],
      { cwd: directory, env, encoding: "utf8" }
    );
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    assert.match(valid.stdout, /PASS measurement-freeze activation receipt/);

    const invalid = spawnSync(
      process.execPath,
      [
        validator,
        "--receipt",
        compactPath,
        "--readjudication-receipt",
        "research/ops-receipts/featured-readjudication.json",
        "--featured-sites",
        "public/featured-sites.json",
        "--now",
        NOW
      ],
      { cwd: directory, env, encoding: "utf8" }
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /canonical two-space JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the activation workflow is manual, read-only, pinned, ordered, and append-only", () => {
  const workflow = readFileSync(
    path.join(
      process.cwd(),
      ".github/workflows/activate-measurement-freeze.yml"
    ),
    "utf8"
  );
  assert.match(workflow, /^on:\n {2}workflow_dispatch:$/m);
  for (const forbidden of [
    "push",
    "pull_request",
    "pull_request_target",
    "workflow_run",
    "schedule",
    "repository_dispatch"
  ]) {
    assert.doesNotMatch(workflow, new RegExp(`^ {2}${forbidden}:`, "m"));
  }
  assert.match(
    workflow,
    /^permissions:\n {2}contents: read\n {2}pull-requests: read\n {2}actions: read$/m
  );
  assert.doesNotMatch(workflow, /^\s+\w[\w-]*:\s+write$/m);
  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/
  );
  assert.match(
    workflow,
    /actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444/
  );
  assert.match(
    workflow,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/
  );
  assert.match(
    workflow,
    /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/
  );
  assert.match(workflow, /client-id: \$\{\{ vars\.RUNNER_READ_APP_CLIENT_ID \}\}/);
  assert.doesNotMatch(workflow, /\bapp-id:/);
  assert.match(workflow, /permission-administration: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /\[\[ "\$GITHUB_REF" == "refs\/heads\/main" \]\]/);
  assert.match(workflow, /\[\[ "\$DECLARED_CANDIDATE" == "\$GITHUB_SHA" \]\]/);
  for (const variable of [
    "SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE",
    "FEATURED_RUNNER_LABEL",
    "SCANNER_EGRESS",
    "SCANNER_EGRESS_REGION",
    "FEATURED_R2_EGRESS_ATTESTED"
  ]) {
    assert.match(workflow, new RegExp(`vars\\.${variable}`));
  }
  const capture = workflow.indexOf(
    "- name: Capture the read-only activation evidence"
  );
  const validate = workflow.indexOf(
    "- name: Independently validate the canonical receipt"
  );
  const upload = workflow.indexOf(
    "- name: Preserve the append-only activation receipt"
  );
  assert.ok(capture > 0 && capture < validate && validate < upload);
  assert.doesNotMatch(workflow, /\bnpm (?:ci|install|run)\b|node_modules|uses: \.\//);
  const captureBlock = workflow.slice(capture, validate);
  assert.match(captureBlock, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    captureBlock,
    /RUNNER_READ_TOKEN: \$\{\{ steps\.runner_read_token\.outputs\.token \|\| github\.token \}\}/
  );
  assert.doesNotMatch(
    workflow.slice(validate),
    /^\s+(?:GITHUB_TOKEN|RUNNER_READ_TOKEN):/m
  );
  assert.match(
    workflow,
    /name: measurement-freeze-activation-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  assert.match(workflow, /retention-days: 90/);
  assert.match(
    workflow,
    /--readjudication-receipt "research\/ops-receipts\/featured-readjudication\.json"/
  );
  assert.match(
    workflow,
    /--featured-sites "public\/featured-sites\.json"/
  );
});

test("capture code requires an online labeled runner, a zero-open set, then re-reads main before activation", () => {
  const capture = readFileSync(
    path.join(
      process.cwd(),
      "scripts/capture-measurement-freeze-activation.mjs"
    ),
    "utf8"
  );
  assert.match(capture, /git\/ref\/heads\/\$\{MEASUREMENT_FREEZE_DEFAULT_BRANCH\}/);
  assert.match(capture, /pulls\?state=open&base=\$\{MEASUREMENT_FREEZE_DEFAULT_BRANCH\}/);
  assert.match(capture, /actions\/runners\?per_page=100&page=\$\{page\}/);
  assert.match(capture, /runner\?\.status === "online"/);
  assert.match(capture, /labels\.includes\("self-hosted"\)/);
  assert.match(capture, /labels\.includes\(runnerLabel\)/);
  assert.match(capture, /proposalSnapshots\.length !== 0/);
  assert.match(capture, /actions\/artifacts\/\$\{artifactId\}\/zip/);
  assert.match(capture, /extractFeaturedReadjudicationArtifactZip/);
  assert.match(capture, /historicalFeaturedWorkflow/);
  assert.match(
    capture,
    /historicalRepositoryFile\(\s*FEATURED_READJUDICATION_CATALOG,\s*cycleRun\.head_sha/
  );
  assert.match(
    capture,
    /historicalCatalog\.targetsSha256 !== boundCycle\.catalog\.targetsSha256/
  );
  assert.match(capture, /apiArtifactDigest !== boundCycle\.artifact\.sha256/);
  assert.match(capture, /archiveSha256 !== boundCycle\.artifact\.sha256/);
  assert.match(capture, /redirect: "error"/);
  assert.match(capture, /signal: AbortSignal\.timeout\(30_000\)/);
  assert.match(
    capture,
    /readBoundedMeasurementFreezeResponseBytes/
  );
  assert.match(capture, /from "\.\/measurement-freeze-artifact-lib\.mjs"/);
  assert.doesNotMatch(capture, /\bchunks\.push\(|\bconst chunks\s*=\s*\[\]/);
  assert.match(capture, /TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.doesNotMatch(capture, /response\.json\(\)/);
  assert.doesNotMatch(capture, /check-runs/);
  const finalProposalSnapshot = capture.indexOf(
    "const proposalSnapshots = await matchingOpenPullRequests()"
  );
  const finalMainRead = capture.indexOf("const mainRef = await api(", finalProposalSnapshot);
  const activation = capture.indexOf("const activatedAt = new Date().toISOString()", finalMainRead);
  const freshness = capture.indexOf(
    "featuredReadjudicationActivationFreshnessIssues(",
    activation
  );
  assert.ok(finalProposalSnapshot > 0 && finalProposalSnapshot < finalMainRead);
  assert.ok(finalMainRead < activation);
  assert.ok(activation < freshness);
  assert.match(capture, /now: activatedAt/);
  assert.doesNotMatch(capture, /now: proposalCheckedAt/);
  assert.match(capture, /writeFileSync\(output,[\s\S]*flag: "wx"/);
});
