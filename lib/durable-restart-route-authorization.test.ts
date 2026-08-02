import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDurableRestartControlAuthorization
} from "./durable-restart-control-auth";
import {
  authorizeDurableRestartRoute,
  executeDurableRestartRoute,
  type DurableRestartRouteAuthorizationInput
} from "./durable-restart-route-authorization";
import type { ScanAdmissionStoreKey } from "./scan-admission-store";

const GITHUB_RUN_ID = "30653749957";
const JOB_ID = "20260801-00000000000000000000000000000001";
const OTHER_JOB_ID =
  "20260801-00000000000000000000000000000002";
const REPORT_ID =
  "20260801-00000000000000000000000000010001";
const OTHER_REPORT_ID =
  "20260801-00000000000000000000000000010002";
const MONITOR_TOKEN =
  "production-monitor-token-that-is-distinct-and-long";
const RESTART_TOKEN =
  "durable-restart-token-that-is-distinct-and-long";
const COLLIDING_SECRET =
  "configured-secret-that-cannot-authorize-a-restart";
const ADMISSION_KEY: ScanAdmissionStoreKey = Object.freeze({
  capabilityHash: new Uint8Array(32).buffer,
  requestCommitment: "A".repeat(43)
});

test("the destructive restart route authorizes only the complete exact binding", async (t) => {
  const valid = await validInput();
  const authorized = await authorizeDurableRestartRoute(valid);
  assert.ok(authorized);
  assert.equal(authorized.admissionKey, ADMISSION_KEY);
  assert.deepEqual(
    {
      githubRunId: authorized.githubRunId,
      jobId: authorized.jobId,
      reportId: authorized.reportId
    },
    {
      githubRunId: GITHUB_RUN_ID,
      jobId: JOB_ID,
      reportId: REPORT_ID
    }
  );

  await t.test("an invalid monitor bearer refuses", async () => {
    assert.equal(
      await authorizeDurableRestartRoute({
        ...valid,
        suppliedMonitorToken:
          "different-monitor-token-that-is-still-well-formed"
      }),
      null
    );
  });

  await t.test("an invalid HMAC refuses", async () => {
    assert.equal(
      await authorizeDurableRestartRoute({
        ...valid,
        restartAuthorization:
          "hmac-sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      }),
      null
    );
  });

  await t.test("a missing admission binding refuses", async () => {
    assert.equal(
      await authorizeDurableRestartRoute({
        ...valid,
        admissionKey: null
      }),
      null
    );
  });

  await t.test("a wrong job binding refuses", async () => {
    assert.equal(
      await authorizeDurableRestartRoute({
        ...valid,
        jobId: OTHER_JOB_ID
      }),
      null
    );
  });

  await t.test("a wrong report binding refuses", async () => {
    assert.equal(
      await authorizeDurableRestartRoute({
        ...valid,
        reportId: OTHER_REPORT_ID
      }),
      null
    );
  });

  await t.test("a restart-secret collision refuses", async () => {
    const colliding = await validInput({
      expectedRestartToken: COLLIDING_SECRET,
      secretCollisionCandidates: [COLLIDING_SECRET]
    });
    assert.equal(
      await authorizeDurableRestartRoute(colliding),
      null
    );
  });
});

test("route orchestration never calls the destructive RPC for invalid or cross-bound requests", async () => {
  const cases = [
    {
      label: "invalid monitor",
      input: await validInput({
        suppliedMonitorToken:
          "different-monitor-token-that-is-still-well-formed"
      })
    },
    {
      label: "missing admission",
      input: await validInput({ admissionKey: null })
    },
    {
      label: "secret collision",
      input: await validInput({
        expectedRestartToken: COLLIDING_SECRET,
        secretCollisionCandidates: [COLLIDING_SECRET]
      })
    },
    {
      label: "valid-HMAC wrong job",
      input: await validInput({ jobId: OTHER_JOB_ID })
    },
    {
      label: "valid-HMAC wrong report",
      input: await validInput({ reportId: OTHER_REPORT_ID })
    }
  ];

  for (const { label, input } of cases) {
    let destroyCalls = 0;
    const result = await executeDurableRestartRoute(input, {
      admissionMatches: async (authorization) =>
        authorization.jobId === JOB_ID &&
        authorization.reportId === REPORT_ID,
      destroyRuntime: async () => {
        destroyCalls += 1;
        return {
          status: "completed" as const,
          snapshot: { ok: true }
        };
      }
    });
    assert.equal(result.status, "not-found", label);
    assert.equal(destroyCalls, 0, label);
  }

  let destroyCalls = 0;
  const valid = await executeDurableRestartRoute(
    await validInput(),
    {
      admissionMatches: async () => true,
      destroyRuntime: async () => {
        destroyCalls += 1;
        return {
          status: "completed" as const,
          snapshot: { ok: true }
        };
      }
    }
  );
  assert.deepEqual(valid, {
    status: "completed",
    snapshot: { ok: true }
  });
  assert.equal(destroyCalls, 1);
});

async function validInput(
  overrides: Partial<DurableRestartRouteAuthorizationInput> = {}
): Promise<DurableRestartRouteAuthorizationInput> {
  const expectedRestartToken =
    typeof overrides.expectedRestartToken === "string"
      ? overrides.expectedRestartToken
      : RESTART_TOKEN;
  const githubRunId =
    typeof overrides.githubRunId === "string"
      ? overrides.githubRunId
      : GITHUB_RUN_ID;
  const jobId =
    typeof overrides.jobId === "string"
      ? overrides.jobId
      : JOB_ID;
  const reportId =
    typeof overrides.reportId === "string"
      ? overrides.reportId
      : REPORT_ID;
  const binding = {
    githubRunId,
    jobId,
    reportId
  };
  return {
    expectedMonitorToken: MONITOR_TOKEN,
    suppliedMonitorToken: MONITOR_TOKEN,
    expectedRestartToken,
    secretCollisionCandidates: [COLLIDING_SECRET],
    ...binding,
    restartAuthorization:
      await createDurableRestartControlAuthorization(
        expectedRestartToken,
        binding
      ),
    admissionKey: ADMISSION_KEY,
    ...overrides
  };
}
