import { DURABLE_SCAN_JOB_ADMISSION_TIMEOUT_MS } from "./durable-scan-job-edge-wiring";
import { DEFAULT_DURABLE_SCAN_JOB_PUMP_BUDGET } from "./durable-scan-job-pump-controller";

/**
 * Bounds how far the container's clock may move a durable job's timestamps.
 *
 * Node mints `admittedAt` during preparation, and the Durable Object stores it
 * as the job's `createdAt`, from which the job deadline and purge horizon are
 * derived, and as a watch run's admission time. The DO's clock is the one that
 * later reads them. A container clock running behind cut a job's deadline short
 * before it could run. One running ahead stretched retention past its policy,
 * and for a job linked to a watch it could record an admission later than the
 * job's own terminal time on the DO's clock. The watch-history copy refuses
 * that pair by throwing, and it runs inside the purge pass that every admission
 * and read performs first, so the one row rolled back every later pass.
 *
 * The value cannot be re-minted on the DO's clock: it is sealed into the
 * encrypted payload and its additional data before the commit transaction
 * opens, and the edge compares the committed `createdAt` against its own copy
 * of the preparation. So the DO checks it on its own clock, inside the commit
 * transaction, and refuses one outside this bound.
 */

/**
 * How far ahead of the DO's clock a Node timestamp may be for a job with no
 * linked watch. There the lead only stretches the deadline and the purge
 * horizon, by at most this much. A watch-linked admission passes a lead of 0:
 * a job cannot reach a terminal state before it is committed, so an admission
 * no later than the commit is never later than the terminal time either.
 */
export const DURABLE_ADMITTED_AT_MAX_LEAD_MS = 1_000;

/**
 * How far behind the DO's clock a Node timestamp may be. An honest one is only
 * as old as the preparation that minted it: a public admission is bounded by
 * its admission deadline and a scheduled watch run by the pump callback's wall
 * time. The lead is added to cover clock skew in this direction as well.
 */
export const DURABLE_ADMITTED_AT_MAX_AGE_MS =
  Math.max(DURABLE_SCAN_JOB_ADMISSION_TIMEOUT_MS, DEFAULT_DURABLE_SCAN_JOB_PUMP_BUDGET.wallTimeMs) +
  DURABLE_ADMITTED_AT_MAX_LEAD_MS;

export class DurableAdmittedAtSkewError extends Error {
  constructor(readonly skewMs: number) {
    super("The durable admission timestamp is outside the clock-skew bound.");
    this.name = "DurableAdmittedAtSkewError";
  }
}

/**
 * Callers MUST pass the DO's own `Date.now()` from inside the transaction that
 * commits the job, so the check and the commit read the same clock. `skewMs` is
 * positive when Node was ahead; it carries no target or identifier.
 */
export function assertDurableAdmittedAtWithinSkew(
  admittedAt: number,
  now: number,
  maxLeadMs: number = DURABLE_ADMITTED_AT_MAX_LEAD_MS
): void {
  if (
    !Number.isSafeInteger(admittedAt) ||
    admittedAt < 0 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(maxLeadMs) ||
    maxLeadMs < 0 ||
    maxLeadMs > DURABLE_ADMITTED_AT_MAX_LEAD_MS
  ) {
    throw new DurableAdmittedAtSkewError(Number.NaN);
  }
  const skewMs = admittedAt - now;
  if (skewMs > maxLeadMs || -skewMs > DURABLE_ADMITTED_AT_MAX_AGE_MS) {
    throw new DurableAdmittedAtSkewError(skewMs);
  }
}
