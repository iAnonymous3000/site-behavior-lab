import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

const DEPLOYMENT_COMMIT = "b".repeat(40);
const SOURCE_COMMIT = DEPLOYMENT_COMMIT;
const CONFIG_SHA = "c".repeat(64);
const NORMAL_JOB = `20260801-${"1".repeat(32)}`;
const NORMAL_REPORT = `20260801-${"2".repeat(32)}`;
const CANCEL_JOB = `20260801-${"3".repeat(32)}`;
const CANCEL_REPORT = `20260801-${"4".repeat(32)}`;
const REPORT_SHA = "e".repeat(64);

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function healthBytes() {
  return Buffer.from(
    JSON.stringify({
      deployment: DEPLOYMENT_COMMIT,
      status: "ok",
      warnings: [],
      checks: {
        durableJobs: {
          requested: true,
          enabled: true,
          readiness: "ready"
        }
      }
    })
  );
}

function healthPayload(deployment = DEPLOYMENT_COMMIT) {
  return {
    deployment,
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

function reportPayload(buildCommit = DEPLOYMENT_COMMIT) {
  return {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "single",
    share: {
      id: NORMAL_REPORT,
      jsonPath: `/api/reports/${NORMAL_REPORT}`
    },
    run: {
      subject: {
        requested: {
          origin: "https://www.iana.org"
        }
      },
      conditions: {
        gpc: true,
        consent: "observe",
        device: {
          kind: "desktop",
          viewport: {
            isMobile: false
          }
        }
      },
      provenance: {
        buildCommit
      }
    }
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function captureResponses(
  reportBuild = DEPLOYMENT_COMMIT,
  postHealthDeployment = DEPLOYMENT_COMMIT
) {
  const normalJob = {
    ok: true,
    status: "queued",
    jobId: NORMAL_JOB,
    reportId: NORMAL_REPORT,
    statusPath: `/api/scans/${NORMAL_JOB}`
  };
  const cancellationJob = {
    ok: true,
    status: "queued",
    jobId: CANCEL_JOB,
    reportId: CANCEL_REPORT,
    statusPath: `/api/scans/${CANCEL_JOB}`
  };
  const report = reportPayload(reportBuild);
  return [
    jsonResponse(healthPayload()),
    jsonResponse(normalJob, 202),
    jsonResponse(normalJob, 202),
    jsonResponse({ status: "succeeded", report }),
    jsonResponse({ status: "succeeded", report }),
    jsonResponse(report),
    jsonResponse(cancellationJob, 202),
    jsonResponse({
      ok: true,
      jobId: CANCEL_JOB,
      status: "cancelled"
    }),
    jsonResponse({
      ok: true,
      jobId: CANCEL_JOB,
      status: "cancelled"
    }),
    jsonResponse(healthPayload(postHealthDeployment))
  ];
}

function fixture() {
  const health = healthBytes();
  const postHealth = healthBytes();
  return {
    health,
    postHealth,
    evidence: {
      schemaVersion: 1,
      artifactKind:
        "site-behavior-durable-soak-exercise-evidence",
      sourceCommit: SOURCE_COMMIT,
      deploymentCommit: DEPLOYMENT_COMMIT,
      durableConfig: {
        path: "wrangler.container.jsonc",
        sha256: CONFIG_SHA
      },
      health: {
        observedAt: "2026-08-01T00:00:01.000Z",
        sha256: sha256(health)
      },
      postHealth: {
        observedAt: "2026-08-01T00:09:30.000Z",
        sha256: sha256(postHealth)
      },
      session: {
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:10:00.000Z"
      },
      behaviors: [
        {
          id: "normal-completion",
          observedAt: "2026-08-01T00:05:00.000Z",
          jobId: NORMAL_JOB,
          reportId: NORMAL_REPORT,
          reportSha256: REPORT_SHA
        },
        {
          id: "cancellation",
          observedAt: "2026-08-01T00:09:00.000Z",
          jobId: CANCEL_JOB,
          reportId: CANCEL_REPORT,
          status: "cancelled",
          responseSha256: "f".repeat(64)
        },
        {
          id: "completed-report-recovery",
          observedAt: "2026-08-01T00:06:00.000Z",
          jobId: NORMAL_JOB,
          reportId: NORMAL_REPORT,
          reportSha256: REPORT_SHA
        },
        {
          id: "duplicate-prevention",
          observedAt: "2026-08-01T00:01:00.000Z",
          jobId: NORMAL_JOB,
          reportId: NORMAL_REPORT,
          firstStatus: 202,
          replayStatus: 202,
          requestCommitmentSha256: "0".repeat(64)
        }
      ]
    }
  };
}

test("canonical exercise evidence proves the four non-restart behaviors on one deployment", async () => {
  const evidenceModule = await script(
    "durable-soak-exercise-evidence-lib.mjs"
  );
  const { evidence, health, postHealth } = fixture();
  const verified =
    evidenceModule.verifyDurableSoakExerciseEvidence(evidence, {
      expectedSourceCommit: SOURCE_COMMIT,
      expectedDeploymentCommit: DEPLOYMENT_COMMIT,
      expectedDurableConfigSha256: CONFIG_SHA,
      healthBytes: health,
      postHealthBytes: postHealth,
      window: {
        startedAt: "2026-07-31T23:00:00.000Z",
        endedAt: "2026-08-02T00:00:00.000Z"
      }
    });
  assert.deepEqual(verified.behaviorIds, [
    "normal-completion",
    "cancellation",
    "completed-report-recovery",
    "duplicate-prevention"
  ]);
  const serialized =
    evidenceModule.serializeDurableSoakExerciseEvidence(evidence);
  assert.deepEqual(
    evidenceModule.parseDurableSoakExerciseEvidence(serialized),
    evidence
  );
});

test("missing, reordered, substituted, and duplicate behavior claims fail closed", async () => {
  const evidenceModule = await script(
    "durable-soak-exercise-evidence-lib.mjs"
  );
  for (const mutate of [
    (value: ReturnType<typeof fixture>["evidence"]) => {
      value.behaviors.pop();
    },
    (value: ReturnType<typeof fixture>["evidence"]) => {
      [value.behaviors[0], value.behaviors[1]] = [
        value.behaviors[1],
        value.behaviors[0]
      ];
    },
    (value: ReturnType<typeof fixture>["evidence"]) => {
      value.behaviors[2].id = "restart-recovery";
    },
    (value: ReturnType<typeof fixture>["evidence"]) => {
      value.behaviors[3].id = "normal-completion";
    }
  ]) {
    const { evidence } = structuredClone(fixture());
    mutate(evidence);
    assert.throws(
      () =>
        evidenceModule.verifyDurableSoakExerciseEvidence(
          evidence
        ),
      /exactly the four|must be exactly|must contain exactly/
    );
  }
});

test("identity, digest, deployment, candidate, and retained-health mismatches fail", async () => {
  const evidenceModule = await script(
    "durable-soak-exercise-evidence-lib.mjs"
  );
  const mismatchCases = [
    {
      options: { expectedSourceCommit: "9".repeat(40) },
      pattern: /authenticated source commit/
    },
    {
      options: { expectedDeploymentCommit: "8".repeat(40) },
      pattern: /expected deployment/
    },
    {
      options: {
        expectedDurableConfigSha256: "7".repeat(64)
      },
      pattern: /candidate durable config/
    },
    {
      options: { healthBytes: Buffer.from('{"ok":false}') },
      pattern: /health digest/
    }
  ];
  for (const { options, pattern } of mismatchCases) {
    const { evidence } = fixture();
    assert.throws(
      () =>
        evidenceModule.verifyDurableSoakExerciseEvidence(
          evidence,
          options
        ),
      pattern
    );
  }
});

test("retained health rejects duplicate-key JSON instead of accepting last-key-wins ambiguity", async () => {
  const evidenceModule = await script(
    "durable-soak-exercise-evidence-lib.mjs"
  );
  const ambiguousHealth = Buffer.from(
    `{"deployment":"${DEPLOYMENT_COMMIT}","deployment":"${DEPLOYMENT_COMMIT}","status":"ok","warnings":[],"checks":{"durableJobs":{"requested":true,"enabled":true,"readiness":"ready"}}}`
  );
  const { evidence } = fixture();
  evidence.health.sha256 = sha256(ambiguousHealth);
  assert.throws(
    () =>
      evidenceModule.verifyDurableSoakExerciseEvidence(evidence, {
        healthBytes: ambiguousHealth
      }),
    /not valid strict JSON/
  );
});

test("replayed or cross-window sessions and cross-job reports fail", async () => {
  const evidenceModule = await script(
    "durable-soak-exercise-evidence-lib.mjs"
  );
  const { evidence } = fixture();
  const crossCandidate = structuredClone(evidence);
  crossCandidate.sourceCommit = "a".repeat(40);
  assert.throws(
    () =>
      evidenceModule.verifyDurableSoakExerciseEvidence(
        crossCandidate
      ),
    /exact durable deployment commit/
  );
  assert.throws(
    () =>
      evidenceModule.verifyDurableSoakExerciseEvidence(evidence, {
        window: {
          startedAt: "2026-08-01T01:00:00.000Z",
          endedAt: "2026-08-02T00:00:00.000Z"
        }
      }),
    /outside the authenticated soak window/
  );

  const crossJob = structuredClone(evidence);
  crossJob.behaviors[2].jobId = CANCEL_JOB;
  assert.throws(
    () =>
      evidenceModule.verifyDurableSoakExerciseEvidence(crossJob),
    /one exact job\/report identity/
  );

  const changedReport = structuredClone(evidence);
  changedReport.behaviors[2].reportSha256 = "1".repeat(64);
  assert.throws(
    () =>
      evidenceModule.verifyDurableSoakExerciseEvidence(
        changedReport
      ),
    /one exact job\/report identity/
  );

  const nonIdempotent = structuredClone(evidence);
  nonIdempotent.behaviors[3].replayStatus = 409;
  assert.throws(
    () =>
      evidenceModule.verifyDurableSoakExerciseEvidence(
        nonIdempotent
      ),
    /two accepted 202 admissions/
  );
});

test("exercise workflow captures live evidence and exposes no hand-authored evidence input", async () => {
  const cli = await script("durable-soak-exercise-evidence.mjs");
  assert.deepEqual(
    cli.parseOptions([
      "--capture",
      "--output-dir",
      "/tmp/sbl-durable-exercise",
      "--expected-deployment",
      DEPLOYMENT_COMMIT
    ]),
    {
      mode: "capture",
      outputDirectory: "/tmp/sbl-durable-exercise",
      expectedDeploymentCommit: DEPLOYMENT_COMMIT
    }
  );
  assert.throws(
    () =>
      cli.parseOptions([
        "--capture",
        "--output-dir",
        "/tmp/sbl",
        "--expected-deployment",
        `${DEPLOYMENT_COMMIT};touch /tmp/pwn`
      ]),
    /full lowercase Git commit/
  );

  const workflow = readFileSync(
    path.join(
      process.cwd(),
      ".github",
      "workflows",
      "durable-soak-exercises.yml"
    ),
    "utf8"
  );
  assert.match(
    workflow,
    /Exercise durable completion, cancellation, and recovery/
  );
  assert.match(
    workflow,
    /post-production-health\.json/
  );
  assert.match(
    workflow,
    /durable-soak-exercise-evidence\.mjs[\s\S]*--capture/
  );
  assert.match(
    workflow,
    /site-behavior-durable-soak-exercises-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  assert.doesNotMatch(
    workflow,
    /evidence_(?:json|path)|receipt_(?:json|path)/
  );
  assert.match(workflow, /runner\.environment/);
  assert.match(workflow, /retention-days: 90/);
});

test("live capture refuses report or post-cancellation health deployment drift", async () => {
  const cli = await script("durable-soak-exercise-evidence.mjs");
  const configuration = {
    baseUrl: "https://scan.sitebehavior.org",
    monitorToken: "t".repeat(32),
    sourceCommit: DEPLOYMENT_COMMIT,
    expectedDeploymentCommit: DEPLOYMENT_COMMIT,
    configBytes: Buffer.from(
      '{"vars":{"SITE_BEHAVIOR_LAB_DURABLE_JOBS": "1"}}'
    )
  };
  const capture = async (
    responses: Response[]
  ): Promise<unknown> => {
    let instant = Date.parse("2026-08-01T00:00:00.000Z");
    return cli.captureDurableSoakExercises(configuration, {
      fetch: async () => {
        const response = responses.shift();
        assert.ok(response, "mock response queue exhausted");
        return response;
      },
      now: () => {
        instant += 1_000;
        return instant;
      },
      wait: async () => undefined
    });
  };

  await assert.rejects(
    () => capture(captureResponses("9".repeat(40))),
    /expected deployment/
  );
  await assert.rejects(
    () =>
      capture(
        captureResponses(
          DEPLOYMENT_COMMIT,
          "8".repeat(40)
        )
      ),
    /post-exercise production health|exact deployment/
  );
});
