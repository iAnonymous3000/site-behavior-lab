import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  assertDurableAdmittedAtWithinSkew,
  DURABLE_ADMITTED_AT_MAX_AGE_MS,
  DURABLE_ADMITTED_AT_MAX_LEAD_MS,
  DurableAdmittedAtSkewError
} from "./durable-admission-clock";
import { DURABLE_SCAN_JOB_ADMISSION_TIMEOUT_MS } from "./durable-scan-job-edge-wiring";
import { DEFAULT_DURABLE_SCAN_JOB_PUMP_BUDGET } from "./durable-scan-job-pump-controller";
import { assertOrdered, requireIndex, sliceToNext } from "./source-markers";

const WORKER = "cloudflare/container-worker.ts";
const worker = readFileSync(path.join(process.cwd(), "cloudflare", "container-worker.ts"), "utf8");
const NOW = 1_800_000_000_000;

function skewOf(run: () => void): number | null {
  try {
    run();
    return null;
  } catch (error) {
    assert.ok(error instanceof DurableAdmittedAtSkewError);
    return error.skewMs;
  }
}

test("a Node admission time is accepted only within the skew bound of this clock", () => {
  // An honest timestamp is at most as old as the preparation that minted it.
  assert.ok(DURABLE_ADMITTED_AT_MAX_AGE_MS > DURABLE_SCAN_JOB_ADMISSION_TIMEOUT_MS);
  assert.ok(DURABLE_ADMITTED_AT_MAX_AGE_MS > DEFAULT_DURABLE_SCAN_JOB_PUMP_BUDGET.wallTimeMs);

  for (const admittedAt of [NOW, NOW - DURABLE_ADMITTED_AT_MAX_AGE_MS, NOW + DURABLE_ADMITTED_AT_MAX_LEAD_MS]) {
    assert.equal(skewOf(() => assertDurableAdmittedAtWithinSkew(admittedAt, NOW)), null);
  }
  assert.equal(
    skewOf(() => assertDurableAdmittedAtWithinSkew(NOW - DURABLE_ADMITTED_AT_MAX_AGE_MS - 1, NOW)),
    -DURABLE_ADMITTED_AT_MAX_AGE_MS - 1
  );
  assert.equal(
    skewOf(() => assertDurableAdmittedAtWithinSkew(NOW + DURABLE_ADMITTED_AT_MAX_LEAD_MS + 1, NOW)),
    DURABLE_ADMITTED_AT_MAX_LEAD_MS + 1
  );
  // The recorded consequence: a container clock hours off in either direction
  // used to become the job's createdAt, and with it the deadline and purge.
  const hour = 60 * 60 * 1_000;
  assert.equal(skewOf(() => assertDurableAdmittedAtWithinSkew(NOW + 3 * hour, NOW)), 3 * hour);
  assert.equal(skewOf(() => assertDurableAdmittedAtWithinSkew(NOW - 3 * hour, NOW)), -3 * hour);
});

test("a watch-linked admission allows no lead at all", () => {
  // A watch records the admission time and later refuses a terminal time
  // before it. The DO commits the job before it can end, so an admission no
  // later than the commit can never be later than the end.
  assert.equal(skewOf(() => assertDurableAdmittedAtWithinSkew(NOW, NOW, 0)), null);
  assert.equal(skewOf(() => assertDurableAdmittedAtWithinSkew(NOW + 1, NOW, 0)), 1);
  assert.equal(skewOf(() => assertDurableAdmittedAtWithinSkew(NOW - DURABLE_ADMITTED_AT_MAX_AGE_MS, NOW, 0)), null);
  // A caller may narrow the lead, never widen it.
  assert.ok(Number.isNaN(skewOf(() => assertDurableAdmittedAtWithinSkew(NOW, NOW, DURABLE_ADMITTED_AT_MAX_LEAD_MS + 1))));
});

test("malformed timestamps are refused rather than compared", () => {
  for (const [admittedAt, now] of [
    [Number.NaN, NOW],
    [NOW, Number.NaN],
    [-1, NOW],
    [NOW, -1],
    [1.5, NOW],
    [Number.MAX_SAFE_INTEGER + 2, NOW]
  ]) {
    assert.ok(Number.isNaN(skewOf(() => assertDurableAdmittedAtWithinSkew(admittedAt, now))));
  }
});

test("every durable admission checks the Node timestamp on this Durable Object's clock before it commits", () => {
  // Three sites seal a Node-minted admittedAt into a job. A fourth must be
  // added here, with its own check, before this count may change.
  assert.equal(worker.split("createDurableScanJobAdmission(durableKey, {").length - 1, 2);
  assert.equal(worker.split("createDurableScanJobAdmission(key, {").length - 1, 1);

  // Public admission: in the preflight only after an honest retry has been
  // recovered, and again inside the charged operation so a refusal rolls the
  // charge back and a recovered commit never reaches it.
  const admit = sliceToNext(worker, "async admitDurablePreparation(", "findDurableJob(jobId: string)", WORKER);
  const publicCheck = "assertDurableAdmittedAtWithinSkew(preparation.payload.admittedAt, now);";
  assertOrdered(admit, ["if (existing) {", publicCheck, "preflightDurableScanJobAdmission("], WORKER);
  const publicCommit = admit.slice(requireIndex(admit, "commitIdempotentScanAdmission(", WORKER));
  assertOrdered(publicCommit, ["() => {", publicCheck, "admitDurableScanJob("], WORKER);
  assert.equal(admit.split("if (error instanceof DurableAdmittedAtSkewError) return refuseDurableAdmittedAtSkew(error);").length - 1, 2);

  // Watch creation: the same two places, with no lead.
  const watch = sliceToNext(
    worker,
    "async admitEncryptedWatchPreparation(",
    "findEncryptedWatch(watchId: string",
    WORKER
  );
  const watchCheck = "assertDurableAdmittedAtWithinSkew(preparation.payload.admittedAt, now, 0);";
  assertOrdered(watch, [watchCheck, "preflightDurableScanJobAdmission(", "peekPublicScanRateLimitInStore("], WORKER);
  const watchCommit = watch.slice(requireIndex(watch, "commitPublicScanRateLimitedOperation(", WORKER));
  assertOrdered(watchCommit, ["() => {", watchCheck, "admitDurableScanJob("], WORKER);
  assert.equal(watch.split("if (error instanceof DurableAdmittedAtSkewError) return refuseDurableAdmittedAtSkew(error);").length - 1, 2);

  // Scheduled watch run: inside its single commit transaction, with no lead.
  const run = sliceToNext(worker, "const committedAt = Date.now();", "private async failEncryptedWatchClaim(", WORKER);
  assertOrdered(
    run,
    ["assertDurableAdmittedAtWithinSkew(preparation.payload.admittedAt, committedAt, 0);", "admitDurableScanJob("],
    WORKER
  );
});

test("a skew refusal is an ordinary refusal whose log carries no target", () => {
  const refuse = sliceToNext(worker, "function refuseDurableAdmittedAtSkew(", "function assertDurableAdmissionCommitActive(", WORKER);
  assert.match(refuse, /return \{ status: "refused" \};/);
  assert.match(refuse, /error\.skewMs/);
  assert.doesNotMatch(refuse, /preparation|payload|url|jobId|reportId/i);
});
