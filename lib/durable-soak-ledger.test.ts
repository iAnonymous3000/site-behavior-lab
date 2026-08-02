// @ts-nocheck

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { pathToFileURL } from "node:url";

let ledger: any;
let collector: any;
const nativeImport = new Function(
  "specifier",
  "return import(specifier)"
) as (specifier: string) => Promise<any>;
before(async () => {
  ledger = await nativeImport(
    pathToFileURL(
      path.join(
        process.cwd(),
        "scripts",
        "durable-soak-ledger-lib.mjs"
      )
    ).href
  );
  collector = await nativeImport(
    pathToFileURL(
      path.join(
        process.cwd(),
        "scripts",
        "durable-soak-ledger.mjs"
      )
    ).href
  );
});

const DEPLOYMENT = "a".repeat(40);
const RESTART_RUN_ID = 88000001;
const RESTART_ARTIFACT_ID = 99000001;

function instant(epoch: number): string {
  return new Date(epoch).toISOString();
}

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(ledger.canonicalDurableSoakText(value), "utf8");
}

function fixtureArtifactInspector(
  archive: Buffer,
  requestedPaths: string[],
  policy: string
) {
  assert.equal(policy, "exact");
  const value = JSON.parse(archive.toString("utf8"));
  assert.deepEqual(
    Object.keys(value.members).sort(),
    [...ledger.DURABLE_SOAK_HEALTH_ARTIFACT_MEMBERS].sort()
  );
  return requestedPaths.map((memberPath) => ({
    path: memberPath,
    bytes: Buffer.from(value.members[memberPath], "base64")
  }));
}

function pageMembers(
  members: Map<string, Buffer>,
  prefix: string,
  key: string,
  values: unknown[]
): void {
  const total = values.length;
  for (let offset = 0, page = 1; offset < total; offset += 100, page += 1) {
    members.set(
      `${prefix}${String(page).padStart(3, "0")}.json`,
      bytes({
        total_count: total,
        [key]: values.slice(offset, offset + 100)
      })
    );
  }
  if (total === 0) {
    members.set(
      `${prefix}001.json`,
      bytes({ total_count: 0, [key]: [] })
    );
  }
}

function restartTuple(start: number, end: number) {
  const observed = start + Math.floor((end - start) / 2);
  return {
    workflowPath: ledger.DURABLE_SOAK_RESTART_WORKFLOW,
    runId: RESTART_RUN_ID,
    runAttempt: 1,
    headSha: DEPLOYMENT,
    startedAt: instant(observed - 60_000),
    completedAt: instant(observed + 8 * 60_000),
    restartObservedAt: instant(observed),
    artifact: {
      id: RESTART_ARTIFACT_ID,
      name:
        `site-behavior-durable-soak-restart-evidence-${RESTART_RUN_ID}-1`,
      sha256: "b".repeat(64)
    },
    recoverySha256: "c".repeat(64)
  };
}

function rawFixture({
  hours = 24,
  omitHour = null as number | null,
  skippedStepHour = null as number | null,
  failedHour = null as number | null,
  includeShallow = true
} = {}) {
  const members = new Map<string, Buffer>();
  const start = Date.parse("2026-08-01T00:00:00.000Z");
  const runs: any[] = [];
  for (let hour = 0; hour <= hours; hour += 1) {
    if (hour === omitHour) continue;
    const runId = 70000000 + hour;
    const runStart = start + hour * 3_600_000;
    const runEnd = runStart + 5 * 60_000;
    const run = {
      id: runId,
      run_attempt: 1,
      repository: {
        full_name: "iAnonymous3000/site-behavior-lab"
      },
      path: ledger.DURABLE_SOAK_HEALTH_WORKFLOW,
      event: "schedule",
      head_branch: "main",
      head_sha: DEPLOYMENT,
      display_title: ledger.DURABLE_SOAK_DEEP_RUN_NAME,
      status: "completed",
      conclusion: hour === failedHour ? "failure" : "success",
      created_at: instant(runStart),
      run_started_at: instant(runStart),
      updated_at: instant(runEnd)
    };
    runs.push(run);
    const steps = ledger.DURABLE_SOAK_REQUIRED_STEPS.map(
      (name: string, index: number) => ({
        name,
        number: index + 1,
        status: "completed",
        conclusion:
          hour === skippedStepHour && index === 3
            ? "skipped"
            : "success",
        started_at:
          hour === skippedStepHour && index === 3
            ? null
            : instant(runStart + (index + 1) * 20_000),
        completed_at:
          hour === skippedStepHour && index === 3
            ? null
            : instant(runStart + (index + 1) * 20_000 + 10_000)
      })
    );
    pageMembers(
      members,
      `raw/runs/${runId}/attempt-001-jobs-page-`,
      "jobs",
      [
        {
          id: 80000000 + hour,
          run_id: runId,
          run_attempt: 1,
          head_sha: DEPLOYMENT,
          name: ledger.DURABLE_SOAK_HEALTH_JOB,
          status: "completed",
          conclusion: hour === failedHour ? "failure" : "success",
          started_at: instant(runStart),
          completed_at: instant(runEnd),
          steps
        }
      ]
    );
    const healthBytes = bytes({
      ok: true,
      status: "ok",
      scansAvailable: true,
      warnings: [],
      deployment: DEPLOYMENT,
      timestamp: instant(runStart + 2 * 60_000),
      checks: {
        durableJobs: {
          requested: true,
          enabled: true,
          readiness: "ready"
        }
      }
    });
    const archiveBytes = bytes({
      members: Object.fromEntries(
        ledger.DURABLE_SOAK_HEALTH_ARTIFACT_MEMBERS.map(
          (memberPath: string) => [
            memberPath,
            (
              memberPath === "production-health.json"
                ? healthBytes
                : bytes({ fixture: memberPath })
            ).toString("base64")
          ]
        )
      )
    });
    const artifactId = 90000000 + hour;
    const artifact = {
      id: artifactId,
      name:
        `site-behavior-production-health-evidence-${runId}-1`,
      digest: `sha256:${ledger.sha256DurableSoak(archiveBytes)}`,
      expired: false,
      size_in_bytes: archiveBytes.byteLength,
      workflow_run: { id: runId, head_sha: DEPLOYMENT }
    };
    pageMembers(
      members,
      `raw/runs/${runId}/artifacts-page-`,
      "artifacts",
      [artifact]
    );
    members.set(
      `raw/runs/${runId}/artifacts/${artifactId}.zip`,
      archiveBytes
    );
    members.set(
      `samples/${runId}-001/production-health.json`,
      healthBytes
    );
  }

  if (includeShallow) {
    const runId = 79999999;
    const runStart = start + 30 * 60_000;
    const runEnd = runStart + 2 * 60_000;
    const shallow = {
      id: runId,
      run_attempt: 1,
      repository: {
        full_name: "iAnonymous3000/site-behavior-lab"
      },
      path: ledger.DURABLE_SOAK_HEALTH_WORKFLOW,
      event: "schedule",
      head_branch: "main",
      head_sha: DEPLOYMENT,
      display_title: ledger.DURABLE_SOAK_SHALLOW_RUN_NAME,
      status: "completed",
      conclusion: "success",
      created_at: instant(runStart),
      run_started_at: instant(runStart),
      updated_at: instant(runEnd)
    };
    runs.push(shallow);
  }

  runs.sort(
    (left, right) =>
      Date.parse(left.created_at) - Date.parse(right.created_at)
  );
  pageMembers(
    members,
    "raw/workflow-runs-page-",
    "workflow_runs",
    runs
  );
  const query = {
    startedAt: instant(start),
    endedAt: instant(start + hours * 3_600_000 + 10 * 60_000)
  };
  return {
    members,
    query,
    restart: restartTuple(
      start,
      start + hours * 3_600_000
    ),
    recordedAt: instant(
      start + hours * 3_600_000 + 20 * 60_000
    )
  };
}

function completeFixture(options = {}) {
  const fixture = rawFixture(options);
  const derived = ledger.deriveDurableSoakLedger({
    ...fixture,
    artifactZipInspector: fixtureArtifactInspector
  });
  fixture.members.set(
    ledger.DURABLE_SOAK_LEDGER_FILE,
    canonicalBytes(derived)
  );
  const manifest =
    ledger.buildDurableSoakSourceDigestManifest(fixture.members);
  fixture.members.set(
    ledger.DURABLE_SOAK_SOURCE_DIGESTS_FILE,
    canonicalBytes(manifest)
  );
  return { ...fixture, derived };
}

function rebuildSourceManifest(members: Map<string, Buffer>): void {
  members.delete(ledger.DURABLE_SOAK_SOURCE_DIGESTS_FILE);
  members.set(
    ledger.DURABLE_SOAK_SOURCE_DIGESTS_FILE,
    canonicalBytes(
      ledger.buildDurableSoakSourceDigestManifest(members)
    )
  );
}

function mutateJson(
  members: Map<string, Buffer>,
  memberPath: string,
  mutate: (value: any) => void
): void {
  const value = JSON.parse(members.get(memberPath)!.toString("utf8"));
  mutate(value);
  members.set(memberPath, bytes(value));
}

test("hourly ledger rederives a complete 24-hour soak and ignores only source-named shallow lanes", () => {
  const fixture = completeFixture();
  const verified = ledger.verifyDurableSoakLedgerMembers(
    fixture.members,
    {
      expectedRestart: fixture.restart,
      artifactZipInspector: fixtureArtifactInspector
    }
  );
  assert.equal(verified.sampleCount, 25);
  assert.equal(verified.observedSeconds, 24 * 3_600 + 5 * 60);
  assert.equal(verified.targetAchieved, false);
  assert.equal(
    verified.deploymentCommit,
    DEPLOYMENT
  );
});

test("source lane names and the Jobs marker must independently prove a deep sample", () => {
  const unknownName = rawFixture({ includeShallow: false });
  mutateJson(
    unknownName.members,
    "raw/workflow-runs-page-001.json",
    (value) => {
      value.workflow_runs[0].display_title =
        "production-health/deep-hourly-v2";
    }
  );
  assert.throws(
    () =>
      ledger.deriveDurableSoakLedger({
        ...unknownName,
        artifactZipInspector: fixtureArtifactInspector
      }),
    /outside the exact scheduled production-health query/
  );

  const skippedMarker = rawFixture({ includeShallow: false });
  mutateJson(
    skippedMarker.members,
    "raw/runs/70000008/attempt-001-jobs-page-001.json",
    (value) => {
      const marker = value.jobs[0].steps.find(
        (step: any) =>
          step.name === ledger.DURABLE_SOAK_MARKER_STEP
      );
      marker.conclusion = "skipped";
      marker.started_at = null;
      marker.completed_at = null;
    }
  );
  assert.throws(
    () =>
      ledger.deriveDurableSoakLedger({
        ...skippedMarker,
        artifactZipInspector: fixtureArtifactInspector
      }),
    /must execute one successful completed step/
  );
});

test("the reviewed seven-day target is derived rather than asserted", () => {
  const fixture = completeFixture({
    hours: ledger.DURABLE_SOAK_TARGET_HOURS,
    includeShallow: false
  });
  const verified = ledger.verifyDurableSoakLedgerMembers(
    fixture.members,
    {
      expectedRestart: fixture.restart,
      artifactZipInspector: fixtureArtifactInspector
    }
  );
  assert.equal(verified.sampleCount, 169);
  assert.equal(verified.targetAchieved, true);
});

test("a skipped deep step, failed delivered run, or material cadence gap refuses", () => {
  assert.throws(
    () =>
      ledger.deriveDurableSoakLedger(
        {
          ...rawFixture({ skippedStepHour: 8 }),
          artifactZipInspector: fixtureArtifactInspector
        }
      ),
    /must execute one successful completed step/
  );
  assert.throws(
    () =>
      ledger.deriveDurableSoakLedger(
        {
          ...rawFixture({ failedHour: 8 }),
          artifactZipInspector: fixtureArtifactInspector
        }
      ),
    /did not complete successfully/
  );
  assert.throws(
    () =>
      ledger.deriveDurableSoakLedger(
        {
          ...rawFixture({ omitHour: 8 }),
          artifactZipInspector: fixtureArtifactInspector
        }
      ),
    /material gap/
  );
});

test("an unrelated restart or unenumerated raw member cannot be relabeled into the soak", () => {
  const fixture = completeFixture();
  assert.throws(
    () =>
      ledger.verifyDurableSoakLedgerMembers(fixture.members, {
        expectedRestart: {
          ...fixture.restart,
          runId: fixture.restart.runId + 1
        },
        artifactZipInspector: fixtureArtifactInspector
      }),
    /restart (?:artifact name does not bind|does not match)/
  );
  const extra = new Map(fixture.members);
  extra.set("raw/runs/123/attempt-001.json", bytes({ id: 123 }));
  assert.throws(
    () =>
      ledger.verifyDurableSoakLedgerMembers(extra, {
        artifactZipInspector: fixtureArtifactInspector
      }),
    /source digest manifest is not set-equal/
  );
});

test("artifact ZIP digest and copied health bytes remain offline-recomputable", () => {
  const fixture = completeFixture();
  const runId = 70000008;
  const artifactId = 90000008;
  const archivePath =
    `raw/runs/${runId}/artifacts/${artifactId}.zip`;
  const healthPath =
    `samples/${runId}-001/production-health.json`;

  const tamperedZip = new Map(fixture.members);
  const changedArchive = Buffer.from(tamperedZip.get(archivePath)!);
  changedArchive[changedArchive.length - 2] ^= 1;
  tamperedZip.set(archivePath, changedArchive);
  rebuildSourceManifest(tamperedZip);
  assert.throws(
    () =>
      ledger.verifyDurableSoakLedgerMembers(tamperedZip, {
        artifactZipInspector: fixtureArtifactInspector
      }),
    /raw ZIP does not match GitHub metadata/
  );

  const copiedDrift = new Map(fixture.members);
  const changedHealth = JSON.parse(
    copiedDrift.get(healthPath)!.toString("utf8")
  );
  changedHealth.timestamp = "2026-08-01T08:02:01.000Z";
  copiedDrift.set(healthPath, bytes(changedHealth));
  rebuildSourceManifest(copiedDrift);
  assert.throws(
    () =>
      ledger.verifyDurableSoakLedgerMembers(copiedDrift, {
        artifactZipInspector: fixtureArtifactInspector
      }),
    /copied health bytes do not equal/
  );
});

test("changed deployment, incomplete pages, and uncovered boundaries refuse", () => {
  const changedDeployment = completeFixture();
  const runId = 70000008;
  const artifactId = 90000008;
  const healthPath =
    `samples/${runId}-001/production-health.json`;
  const archivePath =
    `raw/runs/${runId}/artifacts/${artifactId}.zip`;
  const health = JSON.parse(
    changedDeployment.members.get(healthPath)!.toString("utf8")
  );
  health.deployment = "d".repeat(40);
  const healthBytes = bytes(health);
  changedDeployment.members.set(healthPath, healthBytes);
  const archive = JSON.parse(
    changedDeployment.members.get(archivePath)!.toString("utf8")
  );
  archive.members["production-health.json"] =
    healthBytes.toString("base64");
  const archiveBytes = bytes(archive);
  changedDeployment.members.set(archivePath, archiveBytes);
  const archiveDigest = ledger.sha256DurableSoak(archiveBytes);
  mutateJson(
    changedDeployment.members,
    `raw/runs/${runId}/artifacts-page-001.json`,
    (value) => {
      value.artifacts[0].digest = `sha256:${archiveDigest}`;
      value.artifacts[0].size_in_bytes = archiveBytes.byteLength;
    }
  );
  rebuildSourceManifest(changedDeployment.members);
  assert.throws(
    () =>
      ledger.verifyDurableSoakLedgerMembers(
        changedDeployment.members,
        { artifactZipInspector: fixtureArtifactInspector }
      ),
    /not a clean durable-enabled/
  );

  const truncated = completeFixture();
  mutateJson(
    truncated.members,
    "raw/workflow-runs-page-001.json",
    (value) => {
      value.total_count += 1;
    }
  );
  rebuildSourceManifest(truncated.members);
  assert.throws(
    () =>
      ledger.verifyDurableSoakLedgerMembers(truncated.members, {
        artifactZipInspector: fixtureArtifactInspector
      }),
    /not set-complete/
  );

  const boundary = rawFixture();
  boundary.query.startedAt = instant(
    Date.parse(boundary.query.startedAt) - 2 * 3_600_000
  );
  assert.throws(
    () =>
      ledger.deriveDurableSoakLedger({
        ...boundary,
        artifactZipInspector: fixtureArtifactInspector
      }),
    /query boundaries.*material uncovered gap/
  );
});

test("ledger and digest-manifest bytes are canonical, not merely parseable", () => {
  const noncanonicalLedger = completeFixture();
  const ledgerValue = JSON.parse(
    noncanonicalLedger.members
      .get(ledger.DURABLE_SOAK_LEDGER_FILE)!
      .toString("utf8")
  );
  noncanonicalLedger.members.set(
    ledger.DURABLE_SOAK_LEDGER_FILE,
    Buffer.from(`${JSON.stringify(ledgerValue)}\n`)
  );
  rebuildSourceManifest(noncanonicalLedger.members);
  assert.throws(
    () =>
      ledger.verifyDurableSoakLedgerMembers(
        noncanonicalLedger.members,
        { artifactZipInspector: fixtureArtifactInspector }
      ),
    /ledger is not canonical/
  );

  const noncanonicalManifest = completeFixture();
  const manifestValue = JSON.parse(
    noncanonicalManifest.members
      .get(ledger.DURABLE_SOAK_SOURCE_DIGESTS_FILE)!
      .toString("utf8")
  );
  noncanonicalManifest.members.set(
    ledger.DURABLE_SOAK_SOURCE_DIGESTS_FILE,
    Buffer.from(`${JSON.stringify(manifestValue)}\n`)
  );
  assert.throws(
    () =>
      ledger.verifyDurableSoakLedgerMembers(
        noncanonicalManifest.members,
        { artifactZipInspector: fixtureArtifactInspector }
      ),
    /source digests is not canonical/
  );
});

test("a successful rerun cannot hide its failed earlier deep attempt", () => {
  const fixture = rawFixture();
  const runId = 70000008;
  const jobsOnePath =
    `raw/runs/${runId}/attempt-001-jobs-page-001.json`;
  const jobsOne = JSON.parse(
    fixture.members.get(jobsOnePath)!.toString("utf8")
  );
  mutateJson(
    fixture.members,
    "raw/workflow-runs-page-001.json",
    (value) => {
      const listed = value.workflow_runs.find(
        (run: any) => run.id === runId
      );
      listed.run_attempt = 2;
    }
  );
  jobsOne.jobs[0].status = "completed";
  jobsOne.jobs[0].conclusion = "failure";
  fixture.members.set(jobsOnePath, bytes(jobsOne));
  fixture.members.set(
    `raw/runs/${runId}/attempt-002-jobs-page-001.json`,
    bytes({
      ...jobsOne,
      jobs: [
        {
          ...jobsOne.jobs[0],
          id: jobsOne.jobs[0].id + 1,
          run_attempt: 2,
          conclusion: "success"
        }
      ]
    })
  );
  assert.throws(
    () =>
      ledger.deriveDurableSoakLedger({
        ...fixture,
        artifactZipInspector: fixtureArtifactInspector
      }),
    /attempt 1 .*did not complete successfully/
  );
});

test("the reviewed eight-day REST projection leaves enforced App-token headroom", () => {
  const projected = collector.projectedDurableSoakRestRequests({
    workflowPageCount: 10,
    deepRunCount: 193,
    deepAttemptCount: 200
  });
  assert.equal(projected, 607);
  assert.equal(
    projected,
    collector.DURABLE_SOAK_MAXIMUM_PROJECTED_REST_REQUESTS
  );
  assert.ok(projected < collector.DURABLE_SOAK_REST_REQUEST_CAP);
  assert.ok(
    collector.DURABLE_SOAK_REST_REQUEST_CAP <
      collector.DURABLE_SOAK_GITHUB_APP_PRIMARY_LIMIT
  );

  const budget = collector.createDurableSoakRequestBudget();
  for (
    let request = 0;
    request < collector.DURABLE_SOAK_REST_REQUEST_CAP;
    request += 1
  ) {
    budget.take(`fixture request ${request + 1}`);
  }
  assert.equal(
    budget.used,
    collector.DURABLE_SOAK_REST_REQUEST_CAP
  );
  assert.throws(
    () => budget.take("overflow fixture"),
    /request cap 750 would be exceeded/
  );
  assert.throws(
    () =>
      collector.projectedDurableSoakRestRequests({
        workflowPageCount: 10,
        deepRunCount: 194,
        deepAttemptCount: 200
      }),
    /deepRunCount must be/
  );
});

test("workflows pin exact lane names and an Actions-read App token with no native-token fallback", () => {
  const productionHealth = readFileSync(
    path.join(
      process.cwd(),
      ".github/workflows/production-health.yml"
    ),
    "utf8"
  );
  assert.match(
    productionHealth,
    /run-name:[\s\S]*production-health\/deep-hourly-v1[\s\S]*production-health\/shallow-quarter-hour-v1/
  );
  assert.match(
    productionHealth,
    /github\.event\.schedule == '7 \* \* \* \*'/
  );

  const monitor = readFileSync(
    path.join(
      process.cwd(),
      ".github/workflows/durable-soak-monitor.yml"
    ),
    "utf8"
  );
  assert.match(
    monitor,
    /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3\.2\.0/
  );
  assert.match(
    monitor,
    /client-id: \$\{\{ vars\.RUNNER_READ_APP_CLIENT_ID \}\}/
  );
  assert.match(
    monitor,
    /private-key: \$\{\{ secrets\.RUNNER_READ_APP_PRIVATE_KEY \}\}/
  );
  assert.match(monitor, /repositories: site-behavior-lab/);
  assert.match(monitor, /permission-actions: read/);
  assert.match(
    monitor,
    /GH_TOKEN: \$\{\{ steps\.actions_read_token\.outputs\.token \}\}/
  );
  assert.doesNotMatch(monitor, /\$\{\{ github\.token \}\}/);
  assert.doesNotMatch(monitor, /GITHUB_TOKEN:/);

  const collectorSource = readFileSync(
    path.join(
      process.cwd(),
      "scripts/durable-soak-ledger.mjs"
    ),
    "utf8"
  );
  assert.match(
    collectorSource,
    /DURABLE_SOAK_REST_REQUEST_CAP = 750/
  );
  assert.doesNotMatch(
    collectorSource,
    /actions\/artifacts\/\$\{artifact\.id\}(?!\/zip)/
  );
  assert.doesNotMatch(collectorSource, /metadataBytes/);
});
