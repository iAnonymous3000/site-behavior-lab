import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, any>;
const nativeImport = new Function(
  "specifier",
  "return import(specifier)"
) as (specifier: string) => Promise<ScriptExports>;

function script(name: string) {
  return nativeImport(
    pathToFileURL(path.join(process.cwd(), "scripts", name)).href
  );
}

const CLI = path.join(
  process.cwd(),
  "scripts",
  "durable-soak-restart-evidence.mjs"
);
const WORKFLOW = path.join(
  process.cwd(),
  ".github",
  "workflows",
  "durable-soak-restart.yml"
);
const EDGE = path.join(
  process.cwd(),
  "cloudflare",
  "container-worker.ts"
);
const HOSTED_EVIDENCE_DOC = path.join(
  process.cwd(),
  "docs",
  "hosted-evidence-provenance.md"
);
const RESTART_AUTH = path.join(
  process.cwd(),
  "lib",
  "durable-restart-control-auth.ts"
);
const RESTART_STORE = path.join(
  process.cwd(),
  "lib",
  "durable-restart-control-store.ts"
);
const COMMIT = "a".repeat(40);
const JOB_ID = `20260801-${"1".repeat(32)}`;
const REPORT_ID = `20260801-${"2".repeat(32)}`;
const PRE_REF = `sha256:${"3".repeat(64)}`;
const POST_REF = `sha256:${"4".repeat(64)}`;

function health() {
  return {
    deployment: COMMIT,
    status: "ok",
    warnings: [],
    checks: {
      durableJobs: {
        requested: true,
        enabled: true,
        readiness: "ready"
      }
    }
  };
}

function runtime(
  runtimeIdentityRef: string,
  instanceId: string,
  observedAt: string,
  instanceCreatedAt: string,
  providerObservationSha256: string
) {
  return {
    applicationId: "123e4567-e89b-42d3-a456-426614174000",
    applicationVersion: 7,
    instanceId,
    instanceVersion: 7,
    instanceCreatedAt,
    observedAt,
    runtimeIdentityRef,
    providerObservationSha256
  };
}

function jobSnapshot(
  state: string,
  attemptCount: number,
  finishedAt: string | null
) {
  return {
    schemaVersion: 1,
    artifactKind:
      "site-behavior-durable-restart-job-snapshot",
    jobId: JOB_ID,
    reportId: REPORT_ID,
    state,
    createdAt: "2026-08-01T00:01:00.000Z",
    finishedAt,
    attemptCount,
    leaseGeneration: attemptCount
  };
}

function report() {
  return {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "single",
    share: {
      id: REPORT_ID,
      jsonPath: `/api/reports/${REPORT_ID}`
    },
    run: {
      startedAt: "2026-08-01T00:01:30.000Z",
      subject: {
        requested: {
          origin: "https://www.iana.org",
          registrableDomain: "iana.org",
          routeShape: "/{seg}/{seg}"
        },
        observed: {
          origin: "https://www.iana.org",
          registrableDomain: "iana.org",
          routeShape: "/{seg}/{seg}"
        }
      },
      conditions: {
        gpc: true,
        consent: "observe",
        device: {
          kind: "desktop",
          viewport: { isMobile: false }
        }
      },
      summary: { durationMs: 1_000 }
    }
  };
}

async function captureFixture(
  overrides: {
    postRuntime?: ReturnType<typeof runtime>;
    terminalAttemptCount?: number;
    restartTransientReads?: number;
    postRuntimeTransientReads?: number;
  } = {}
) {
  const {
    captureDurableRestartEvidence
  } = await script("durable-soak-restart-evidence-lib.mjs");
  const pre = runtime(
    PRE_REF,
    "provider-instance-before",
    "2026-08-01T00:00:00.000Z",
    "2026-07-31T23:55:00.000Z",
    "5".repeat(64)
  );
  const post =
    overrides.postRuntime ??
    runtime(
      POST_REF,
      "provider-instance-after",
      "2026-08-01T00:05:00.000Z",
      "2026-08-01T00:04:30.000Z",
      "6".repeat(64)
    );
  const jobReads = [
    jobSnapshot("leased", 1, null),
    jobSnapshot(
      "succeeded",
      overrides.terminalAttemptCount ?? 2,
      "2026-08-01T00:09:00.000Z"
    )
  ];
  const now = [
    "2026-08-01T00:02:00.000Z",
    "2026-08-01T00:10:00.000Z"
  ];
  const events: string[] = [];
  let restartTransientReads =
    overrides.restartTransientReads ?? 0;
  let postRuntimeTransientReads =
    overrides.postRuntimeTransientReads ?? 0;
  const reportValue = report();
  const reportBytes = Buffer.from(
    JSON.stringify(reportValue),
    "utf8"
  );
  const evidence = await captureDurableRestartEvidence(
    {
      expectedCommit: COMMIT,
      admission: {
        body: { fixed: true },
        headers: { capability: "private" }
      },
      leasePolls: 2,
      restartPolls: 3,
      completionPolls: 2,
      pollIntervalMs: 1,
      leasePollIntervalMs: 1
    },
    {
      readHealth: async () => health(),
      readRuntime: async () => {
        if (
          events.includes("restart") &&
          postRuntimeTransientReads > 0
        ) {
          postRuntimeTransientReads -= 1;
          events.push("runtime:transient");
          return null;
        }
        const value = events.includes("restart") ? post : pre;
        events.push(`runtime:${value.runtimeIdentityRef}`);
        return value;
      },
      submitScan: async () => {
        events.push("submit");
        return {
          ok: true,
          jobId: JOB_ID,
          reportId: REPORT_ID,
          status: "queued",
          statusPath: `/api/scans/${JOB_ID}`
        };
      },
      readJobEvidence: async () => {
        const value = jobReads.shift();
        assert.ok(value);
        events.push(`job:${value.state}:${value.attemptCount}`);
        return value;
      },
      restartRuntime: async (
        _admission: unknown,
        _expectedJob: unknown,
        leased: unknown
      ) => {
        events.push("restart");
        if (restartTransientReads > 0) {
          restartTransientReads -= 1;
          return null;
        }
        return leased;
      },
      readReport: async () => ({
        bytes: reportBytes,
        value: reportValue
      }),
      wait: async () => undefined,
      now: () => {
        const value = now.shift();
        assert.ok(value);
        return value;
      }
    }
  );
  return { evidence, events };
}

test("capture binds a real runtime transition to one fenced second-attempt report identity", async () => {
  const {
    DURABLE_RESTART_EVIDENCE_FILES,
    parseDurableRestartEvidence,
    serializeDurableRestartEvidence,
    verifyDurableRestartEvidenceSet
  } = await script("durable-soak-restart-evidence-lib.mjs");
  const { evidence, events } = await captureFixture();
  assert.deepEqual(
    Object.keys(evidence).sort(),
    [...DURABLE_RESTART_EVIDENCE_FILES]
  );
  assert.ok(
    events.indexOf("job:leased:1") <
      events.indexOf("restart")
  );
  assert.ok(
    events.indexOf("restart") <
      events.indexOf("job:succeeded:2")
  );
  assert.equal(
    evidence["pre-health.json"].runtimeIdentityRef,
    PRE_REF
  );
  assert.equal(
    evidence["post-health.json"].runtimeIdentityRef,
    POST_REF
  );
  assert.equal(
    evidence["restart-evidence.json"].preRuntimeIdentityRef,
    PRE_REF
  );
  assert.equal(
    evidence["restart-evidence.json"].postRuntimeIdentityRef,
    POST_REF
  );
  assert.equal(
    evidence["queued-work-recovery.json"].preRestartJob
      .attemptCount,
    1
  );
  assert.equal(
    evidence["queued-work-recovery.json"].terminalJob
      .attemptCount,
    2
  );
  assert.equal(
    evidence["queued-work-recovery.json"].publicationIdentity
      .reportId,
    REPORT_ID
  );
  assert.equal(
    Object.hasOwn(
      evidence["queued-work-recovery.json"],
      "publishedExactlyOnce"
    ),
    false
  );
  const serialized = new Map<string, Buffer>();
  for (const name of DURABLE_RESTART_EVIDENCE_FILES) {
    const kind = name.slice(0, -".json".length);
    const bytes = Buffer.from(
      serializeDurableRestartEvidence(evidence[name], kind),
      "utf8"
    );
    serialized.set(name, bytes);
    assert.deepEqual(
      parseDurableRestartEvidence(bytes, kind),
      evidence[name]
    );
  }
  const result = verifyDurableRestartEvidenceSet({
    preHealth: evidence["pre-health.json"],
    postHealth: evidence["post-health.json"],
    recovery: evidence["queued-work-recovery.json"],
    restart: evidence["restart-evidence.json"],
    recoverySha256: (
      await script("operator-evidence-common.mjs")
    ).sha256Bytes(
      serialized.get("queued-work-recovery.json")
    )
  });
  assert.equal(result.deploymentCommit, COMMIT);
  assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/);

  const publicWire = Buffer.concat(
    [...serialized.values()]
  ).toString("utf8");
  assert.doesNotMatch(
    publicWire,
    /provider-instance-before|provider-instance-after/
  );
  assert.doesNotMatch(
    publicWire,
    /applicationId|instanceId|instanceCreatedAt|location/
  );
  assert.doesNotMatch(
    publicWire,
    /runtimeIdentity":|preRuntimeIdentity":|postRuntimeIdentity":/
  );
});

test("capture refuses unchanged runtime identity and a one-attempt completion", async () => {
  const {
    serializeDurableRestartEvidence
  } = await script("durable-soak-restart-evidence-lib.mjs");
  const unchanged = runtime(
    PRE_REF,
    "provider-instance-before",
    "2026-08-01T00:05:00.000Z",
    "2026-07-31T23:55:00.000Z",
    "7".repeat(64)
  );
  await assert.rejects(
    captureFixture({ postRuntime: unchanged }),
    /distinct running singleton/
  );
  await assert.rejects(
    captureFixture({
      postRuntime: runtime(
        POST_REF,
        "provider-instance-after",
        "2026-08-01T00:05:00.000Z",
        "2026-08-01T00:00:00.000Z",
        "7".repeat(64)
      )
    }),
    /predates the restart command/
  );
  await assert.rejects(
    captureFixture({ terminalAttemptCount: 1 }),
    /second fenced attempt/
  );
  await assert.rejects(
    captureFixture({ restartTransientReads: 5 }),
    /bounded exact-request retries/
  );
  const { evidence } = await captureFixture();
  assert.throws(
    () =>
      serializeDurableRestartEvidence(
        {
          ...evidence["queued-work-recovery.json"],
          terminalJob: {
            ...evidence["queued-work-recovery.json"]
              .terminalJob,
            attemptCount: 1,
            leaseGeneration: 1
          }
        },
        "queued-work-recovery"
      ),
    /second-generation publication identity/
  );
});

test("capture retries the exact destroy request and transient post-destroy provider reads", async () => {
  const { evidence, events } = await captureFixture({
    restartTransientReads: 1,
    postRuntimeTransientReads: 1
  });
  assert.equal(
    events.filter((event) => event === "restart").length,
    2
  );
  assert.equal(
    events.filter((event) => event === "runtime:transient")
      .length,
    1
  );
  assert.equal(
    evidence["queued-work-recovery.json"].terminalJob
      .leaseGeneration,
    2
  );
});

test("Cloudflare provider normalization hashes sensitive runtime identity", async () => {
  const {
    DurableRestartProviderUnavailableError,
    normalizeCloudflareRuntimeObservation,
    selectCloudflareContainerApplication
  } = await script("durable-soak-restart-evidence-lib.mjs");
  const applications = [
    {
      name: "unrelated-account-application",
      instances: 99
    },
    {
      id: "123e4567-e89b-42d3-a456-426614174000",
      name: "site-behavior-lab-scanner",
      state: "active",
      instances: 1,
      image: "registry.cloudflare.com/private/image@sha256:secret",
      version: 7,
      updated_at: "2026-08-01T00:00:00Z",
      created_at: "2026-07-01T00:00:00Z"
    }
  ];
  const application =
    selectCloudflareContainerApplication(applications);
  assert.throws(
    () =>
      selectCloudflareContainerApplication([
        { ...applications[1], state: "provisioning" }
      ]),
    DurableRestartProviderUnavailableError
  );
  assert.throws(
    () =>
      selectCloudflareContainerApplication([
        { ...applications[1], instances: "one" }
      ]),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof DurableRestartProviderUnavailableError)
  );
  const observation = normalizeCloudflareRuntimeObservation({
    application,
    instances: [
      {
        id: "sensitive-provider-instance-id",
        name: "cf-singleton-container",
        state: "running",
        location: "sfo06",
        version: 7,
        created: "2026-08-01T00:00:30Z"
      }
    ],
    sourceSha256: "8".repeat(64),
    capturedAt: "2026-08-01T00:01:00.000Z"
  });
  assert.equal(
    observation.instanceId,
    "sensitive-provider-instance-id"
  );
  assert.match(
    observation.runtimeIdentityRef,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.doesNotMatch(
    JSON.stringify({
      runtimeIdentityRef: observation.runtimeIdentityRef,
      providerObservationSha256:
        observation.providerObservationSha256
    }),
    /sensitive-provider-instance-id|sfo06|registry\.cloudflare/
  );

  assert.throws(
    () =>
      selectCloudflareContainerApplication([
        ...applications,
        { ...applications[1] }
      ]),
    /exactly one/
  );
  assert.throws(
    () =>
      normalizeCloudflareRuntimeObservation({
        application,
        instances: [
          {
            id: "instance-one",
            name: "cf-singleton-container",
            state: "running",
            location: "sfo06",
            version: 7,
            created: "2026-08-01T00:00:30Z"
          },
          {
            id: "instance-two",
            name: "cf-singleton-container",
            state: "running",
            location: "sfo06",
            version: 7,
            created: "2026-08-01T00:00:31Z"
          }
        ],
        sourceSha256: "8".repeat(64),
        capturedAt: "2026-08-01T00:01:00.000Z"
      }),
    /more than one running production singleton/
  );
});

test("workflow is pinned, least-privileged, bounded, and uploads only canonical members", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(
    workflow,
    /^name: Durable Soak Restart$/m
  );
  assert.match(
    workflow,
    /name: Restart runtime and prove queued work recovery/
  );
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /environment: release-evidence/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(
    workflow,
    /actions\/checkout@[0-9a-f]{40}/
  );
  assert.match(
    workflow,
    /actions\/setup-node@[0-9a-f]{40}/
  );
  assert.match(
    workflow,
    /actions\/upload-artifact@[0-9a-f]{40}/
  );
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm run build:schema/);
  assert.match(
    workflow,
    /CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CLOUDFLARE_ACCOUNT_ID \}\}/
  );
  assert.match(
    workflow,
    /DURABLE_RESTART_CONTROL_TOKEN: \$\{\{ secrets\.DURABLE_RESTART_CONTROL_TOKEN \}\}/
  );
  assert.match(
    workflow,
    /DURABLE_RESTART_GITHUB_RUN_ID: \$\{\{ github\.run_id \}\}/
  );
  assert.match(
    workflow,
    /DURABLE_RESTART_PROVIDER_API_TOKEN: \$\{\{ secrets\.DURABLE_RESTART_PROVIDER_API_TOKEN \}\}/
  );
  assert.match(
    workflow,
    /SCAN_BASE_URL: https:\/\/scan\.sitebehavior\.org/
  );
  assert.match(
    workflow,
    /site-behavior-durable-soak-restart-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  for (const name of [
    "post-health.json",
    "pre-health.json",
    "queued-work-recovery.json",
    "restart-evidence.json"
  ]) {
    assert.equal(
      workflow.match(new RegExp(name.replace(".", "\\."), "g"))
        ?.length,
      1,
      name
    );
  }
  assert.doesNotMatch(workflow, /pull_request_target|contents: write/);
  assert.doesNotMatch(workflow, /containers ssh|authorized_keys/);
  const operations = readFileSync(HOSTED_EVIDENCE_DOC, "utf8");
  assert.match(operations, /DURABLE_RESTART_PROVIDER_API_TOKEN/);
  assert.match(operations, /Containers Read/);
  assert.match(operations, /Do not grant Containers Edit\/Write/);
});

test("capture CLI is fail-closed and the edge exposes only request-bound restart state", () => {
  const cli = readFileSync(CLI, "utf8");
  assert.match(
    cli,
    /node_modules", "wrangler"[\s\S]*"bin", "wrangler\.js"/
  );
  assert.match(
    cli,
    /\/restart-runtime/
  );
  assert.match(cli, /shell: false/);
  assert.match(cli, /DURABLE_RESTART_CONTROL_TOKEN/);
  assert.match(
    cli,
    /x-site-behavior-lab-durable-restart-authorization/
  );
  assert.match(cli, /x-site-behavior-lab-durable-restart-run-id/);
  assert.match(cli, /createDurableRestartControlAuthorization/);
  assert.match(
    cli,
    /RETRYABLE_PROVIDER_DESTROY_STATUSES/
  );
  assert.doesNotMatch(cli, /containers",\s*"ssh"|\/usr\/bin\/script/);
  assert.doesNotMatch(
    cli,
    /console\.(?:log|error)\([^)]*(?:stdout|stderr|apiToken|instanceId)/
  );

  const edge = readFileSync(EDGE, "utf8");
  assert.match(
    edge,
    /readDurableRestartEvidence\(input:[\s\S]*findScanAdmission\([\s\S]*admission\.jobId !== input\.jobId[\s\S]*admission\.reportId !== input\.reportId/
  );
  assert.match(
    edge,
    /handleDurableRestartEvidenceRequest[\s\S]*isProductionSyntheticMonitorToken[\s\S]*scanAdmissionStoreKeyFromRecoveryHeaders/
  );
  assert.match(
    edge,
    /DURABLE_RESTART_REPORT_ID_HEADER[\s\S]*headers\.delete\(DURABLE_RESTART_REPORT_ID_HEADER\)/
  );
  assert.match(
    edge,
    /destroyDurableRuntimeForEvidence[\s\S]*githubRunId[\s\S]*beginDurableRestartControl[\s\S]*await this\.destroy\(\)/
  );
  assert.match(edge, /executeDurableRestartRoute/);
  assert.match(
    edge,
    /result\.status === "pending"[\s\S]*privateControlResponse\(503\)/
  );
  const restartAuth = readFileSync(RESTART_AUTH, "utf8");
  assert.match(restartAuth, /site-behavior-lab\/durable-restart-control\/v1/);
  assert.match(restartAuth, /crypto\.subtle\.verify/);
  const restartStore = readFileSync(RESTART_STORE, "utf8");
  assert.match(restartStore, /github_run_id TEXT PRIMARY KEY/);
  assert.match(restartStore, /DURABLE_RESTART_CONTROL_RETENTION_MS/);
  assert.match(restartStore, /status IN \('requested','completed'\)/);
  assert.match(restartStore, /INSERT INTO durable_restart_evidence_controls/);
  assert.match(restartStore, /status = 'completed'/);
  assert.match(
    restartStore,
    /snapshot\.state !== "leased"[\s\S]*snapshot\.attemptCount !== 1[\s\S]*snapshot\.leaseGeneration !== 1/
  );
  for (const secret of [
    "SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN",
    "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN",
    "SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY",
    "SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN",
    "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN",
    "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID",
    "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY",
    "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_KEY",
    "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_PREVIOUS_KEY",
    "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_ACCESS_TOKEN",
    "TURNSTILE_SECRET_KEY"
  ]) {
    assert.match(edge, new RegExp(secret));
  }
  assert.ok(
    (
      edge.match(
        /headers\.delete\(DURABLE_RESTART_AUTHORIZATION_HEADER\)/g
      ) ?? []
    ).length >= 2
  );
  assert.ok(
    (
      edge.match(
        /headers\.delete\(DURABLE_RESTART_RUN_ID_HEADER\)/g
      ) ?? []
    ).length >= 2
  );
  const method = edge.slice(
    edge.indexOf("  readDurableRestartEvidence(input:"),
    edge.indexOf(
      "  /**\n   * Charge the poll's read budget",
      edge.indexOf("  readDurableRestartEvidence(input:")
    )
  );
  const snapshotMapper = edge.slice(
    edge.indexOf("function durableRestartEvidenceSnapshot("),
    edge.indexOf(
      "type DurableScanJobCancellationResult",
      edge.indexOf("function durableRestartEvidenceSnapshot(")
    )
  );
  assert.match(
    snapshotMapper,
    /attemptCount: snapshot\.attemptCount/
  );
  assert.match(
    snapshotMapper,
    /leaseGeneration: snapshot\.leaseGeneration/
  );
  assert.doesNotMatch(
    `${snapshotMapper}\n${method}`,
    /leaseExpiresAt:|publicationManifest:|terminalReason:|payload/
  );

  const directory = mkdtempSync(
    path.join(tmpdir(), "sbl-durable-restart-refusal-")
  );
  const output = path.join(directory, "must-not-exist");
  try {
    const result = spawnSync(
      process.execPath,
      [CLI, "--capture", "--output-dir", output],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          HOME: process.env.HOME ?? "",
          PATH: process.env.PATH ?? ""
        }
      }
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /DURABLE_RESTART_PROVIDER_KIND/
    );
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI verifier accepts only the canonical four-file evidence set", async () => {
  const {
    DURABLE_RESTART_EVIDENCE_FILES,
    serializeDurableRestartEvidence
  } = await script("durable-soak-restart-evidence-lib.mjs");
  const { evidence } = await captureFixture();
  const directory = mkdtempSync(
    path.join(tmpdir(), "sbl-durable-restart-verify-")
  );
  try {
    for (const name of DURABLE_RESTART_EVIDENCE_FILES) {
      writeFileSync(
        path.join(directory, name),
        serializeDurableRestartEvidence(
          evidence[name],
          name.slice(0, -".json".length)
        )
      );
    }
    const accepted = spawnSync(
      process.execPath,
      [CLI, "--verify", "--directory", directory],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /"ok":true/);

    mkdirSync(path.join(directory, "unexpected"));
    const refused = spawnSync(
      process.execPath,
      [CLI, "--verify", "--directory", directory],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /exactly the four canonical/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
