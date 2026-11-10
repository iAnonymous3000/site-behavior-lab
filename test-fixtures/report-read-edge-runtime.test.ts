import { DurableObject } from "cloudflare:workers";
import worker, { ScannerContainer } from "../cloudflare/container-worker";
import type { PublicReportReadQuota } from "../lib/report-read-edge";

// Real public Worker routing and report-read gate, with only the
// container-owning DO replaced. The DO runs the real read-quota ledger on its
// own SQLite storage, through the production Durable Object's own charge
// method, and stands in for the container: it records every request the
// Worker forwards and answers it with a fixed status.
//
// The ledger is charged at one fixed instant. The quotas are fixed minute
// windows, and a test that counts to a cap must not depend on where in a real
// minute it happens to run or on how fast the machine is.
const HARNESS_NOW = 60_001;
//
// Two scan jobs exist so the Worker's own reads of a saved report can be seen.
// A status poll for the first finds a finished durable job; a poll for the
// second finds nothing in the container and then a registration. Either way
// the Worker goes on to read that job's report from the container itself.
const HARNESS_DURABLE_JOB_ID = `20260101-${"a".repeat(32)}`;
const HARNESS_DURABLE_JOB_REPORT_ID = `20260101-${"b".repeat(32)}`;
const HARNESS_REGISTERED_JOB_ID = `20260101-${"c".repeat(32)}`;
const HARNESS_REGISTERED_JOB_REPORT_ID = `20260101-${"d".repeat(32)}`;

export class ReportReadEdgeHarness extends DurableObject {
  private forwarded: Array<{ method: string; path: string }> = [];
  private limiterBroken = false;

  // The production class's method, run on this object. It needs nothing of a
  // container: only `this.ctx.storage`, which every SQLite Durable Object has.
  // A copy of its body stood here once, and then nothing held the production
  // method itself: it could stop handing the quota to the store, which charges
  // every JSON and PDF read to the page buckets, and no test noticed. The
  // method is synchronous, so the clock is pinned only for its own duration.
  chargeReportReadRateLimit(input: { clientHash: string; quota?: PublicReportReadQuota }) {
    if (this.limiterBroken) throw new Error("the harness limiter is switched off");
    const realNow = Date.now;
    Date.now = () => HARNESS_NOW;
    try {
      return ScannerContainer.prototype.chargeReportReadRateLimit.call(this as unknown as ScannerContainer, input);
    } finally {
      Date.now = realNow;
    }
  }

  /** The job-status poll's own budget is not under test; every poll is allowed. */
  chargeAndFindDurableJob({ jobId }: { clientHash: string; jobId: string }) {
    const now = Date.now();
    return {
      charge: { allowed: true as const },
      snapshot:
        jobId === HARNESS_DURABLE_JOB_ID
          ? {
              jobId,
              reportId: HARNESS_DURABLE_JOB_REPORT_ID,
              state: "succeeded" as const,
              createdAt: now - 60_000,
              deadlineAt: now + 60_000,
              purgeAt: now + 3_600_000,
              totalRuns: 1 as const,
              attemptCount: 1,
              leaseGeneration: 1,
              completedRuns: 1,
              leaseExpiresAt: null,
              publicationManifest: null,
              terminalReason: null,
              finishedAt: now - 1_000,
              updatedAt: now - 1_000
            }
          : null
    };
  }

  findRegisteredScanJob(jobId: string) {
    return jobId === HARNESS_REGISTERED_JOB_ID
      ? { jobId, reportId: HARNESS_REGISTERED_JOB_REPORT_ID, totalRuns: 1 as const, createdAt: Date.now() - 60_000 }
      : null;
  }

  override fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    this.forwarded.push({ method: request.method, path });
    // The container holds no job and no report: a status poll falls through to
    // the registry, and a report read answers as Node does for a missing one.
    if (path.startsWith("/api/scans/") || path.startsWith("/api/reports/")) {
      return Response.json({ ok: false, error: "Not found." }, { status: 404 });
    }
    return Response.json({ ok: true });
  }

  breakLimiter() {
    this.limiterBroken = true;
  }

  harnessState() {
    const sql = this.ctx.storage.sql;
    const ledger = sql.exec("SELECT name FROM sqlite_master WHERE name = 'public_scan_rate_limits'").toArray();
    const limits = ledger.length === 0
      ? []
      : sql
          .exec<{ bucket: string; used: number }>("SELECT bucket, used FROM public_scan_rate_limits ORDER BY bucket")
          .toArray()
          .map((row) => ({ bucket: row.bucket, used: row.used }));
    return {
      forwarded: this.forwarded,
      limits,
      jobs: {
        durable: { jobId: HARNESS_DURABLE_JOB_ID, reportId: HARNESS_DURABLE_JOB_REPORT_ID },
        registered: { jobId: HARNESS_REGISTERED_JOB_ID, reportId: HARNESS_REGISTERED_JOB_REPORT_ID }
      }
    };
  }
}

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    const scanner = env.SCANNER as DurableObjectNamespace<ReportReadEdgeHarness>;
    // getContainer's default instance name.
    const harness = scanner.get(scanner.idFromName("cf-singleton-container"));
    const { pathname } = new URL(request.url);
    if (pathname === "/__harness/state") return Response.json(await harness.harnessState());
    if (pathname === "/__harness/break-limiter") {
      await harness.breakLimiter();
      return new Response(null, { status: 204 });
    }
    // The call a Worker one release older makes while a deployment replaces
    // it: a client hash and no quota.
    if (pathname === "/__harness/charge-as-older-worker") {
      return Response.json(await harness.chargeReportReadRateLimit({ clientHash: "0".repeat(64) }));
    }
    return worker.fetch(request, {
      SCANNER: env.SCANNER,
      SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN: "https://sitebehavior.org",
      SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS: "1",
      TURNSTILE_SECRET_KEY: "fixture-no-siteverify-request-allowed"
    } as Parameters<typeof worker.fetch>[1], ctx);
  }
};
