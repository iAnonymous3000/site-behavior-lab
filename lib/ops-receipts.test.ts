import assert from "node:assert/strict";
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
    receiptVersion: 1,
    actionsRunId: 30_600_000_001,
    actionsRunAttempt: 1,
    workflow: "scan-featured.yml",
    runnerLabel: "sbl-controlled-r2",
    recordedAt: "2026-08-03T08:00:00.000Z",
    provisioning: {
      provisionedAt: "2026-08-03T05:20:00.000Z",
      hostImageIdentity: "ami-0abc1234 sha256:deadbeef",
      singleUse: true,
      registration: {
        repository: "iAnonymous3000/site-behavior-lab",
        labels: ["sbl-controlled-r2"],
        ephemeral: true
      }
    },
    isolation: {
      cloudMetadataBlocked: true,
      controlPlaneCredentialsAbsent: true,
      persistentStateAbsent: true
    },
    egress: {
      declaredRegion: "us-east",
      natIdentity: "nat-0feedface",
      independentPolicyEnforced: true,
      blockedClasses: ["private", "link-local", "metadata"]
    },
    destruction: {
      destroyedAt: "2026-08-03T07:45:00.000Z",
      verifiedAbsentAt: "2026-08-03T07:50:00.000Z",
      method: "instance-terminate",
      verification: "cloud API describe-instances absence proof, run log line 118"
    },
    operator: {
      attestedBy: "iAnonymous3000",
      evidenceRefs: ["actions-run-30600000001-artifact:controlled-runner-evidence"]
    }
  };
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
});
