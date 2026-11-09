import { DurableObject } from "cloudflare:workers";
import worker from "../cloudflare/container-worker";
import { chargeAdmissionAttempt } from "../lib/admission-attempt-limit";
import { chargePublicScanRateLimit, type PublicScanRateLimitCharge } from "../lib/public-scan-rate-limit-store";

// Real public Worker routing and scan gate, with only the container-owning DO
// replaced. The DO runs the real attempt and quota ledgers on its own SQLite
// storage and stands in for the container: it accepts what the Worker forwards
// and records the headers the Node server would key that client on. Siteverify
// is answered by the test's outbound service, never by the network.
export class ScanAdmissionPathHarness extends DurableObject {
  private forwarded: Array<{ path: string; forwardedFor: string | null; realIp: string | null }> = [];

  chargeAdmissionAttempt({ clientHash }: { clientHash: string }) {
    return this.ctx.storage.transactionSync(() =>
      chargeAdmissionAttempt(this.ctx.storage.sql, clientHash, Date.now())
    );
  }

  chargePublicScanRateLimit(input: PublicScanRateLimitCharge) {
    return this.ctx.storage.transactionSync(() =>
      chargePublicScanRateLimit(this.ctx.storage.sql, input, Date.now())
    );
  }

  registerScanJob() {}

  override fetch(request: Request): Response {
    this.forwarded.push({
      path: new URL(request.url).pathname,
      forwardedFor: request.headers.get("x-forwarded-for"),
      realIp: request.headers.get("x-real-ip")
    });
    const sequence = this.forwarded.length.toString(16).padStart(31, "0");
    const jobId = `20260101-a${sequence}`;
    return Response.json(
      { ok: true, jobId, status: "queued", statusPath: `/api/scans/${jobId}`, reportId: `20260101-b${sequence}` },
      { status: 202 }
    );
  }

  harnessState() {
    const sql = this.ctx.storage.sql;
    const ledger = sql.exec("SELECT name FROM sqlite_master WHERE name = 'public_scan_rate_limits'").toArray();
    // One row per client and minute window: the tokens that client was charged.
    const clientMinuteCharges = ledger.length === 0
      ? []
      : sql
          .exec<{ used: number }>("SELECT used FROM public_scan_rate_limits WHERE bucket LIKE 'minute/%' ORDER BY used")
          .toArray()
          .map((row) => row.used);
    return { forwarded: this.forwarded, clientMinuteCharges };
  }
}

// Miniflare, like Cloudflare, always supplies cf-connecting-ip. A request
// carrying this header reaches the Worker without one, which is the only way
// to show what the Worker does when its edge named no client.
const NO_CLIENT_ADDRESS_HEADER = "x-harness-no-client-address";

export default {
  async fetch(incoming: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    const scanner = env.SCANNER as DurableObjectNamespace<ScanAdmissionPathHarness>;
    if (new URL(incoming.url).pathname === "/__harness/state") {
      // getContainer's default instance name.
      return Response.json(await scanner.get(scanner.idFromName("cf-singleton-container")).harnessState());
    }
    const headers = new Headers(incoming.headers);
    if (headers.has(NO_CLIENT_ADDRESS_HEADER)) headers.delete("cf-connecting-ip");
    headers.delete(NO_CLIENT_ADDRESS_HEADER);
    const request = new Request(incoming, { headers });
    return worker.fetch(request, {
      SCANNER: env.SCANNER,
      SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN: "https://sitebehavior.org",
      SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS: "1",
      SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE: "6",
      SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY: "120",
      TURNSTILE_SECRET_KEY: "fixture-secret-answered-by-the-test"
    } as Parameters<typeof worker.fetch>[1], ctx);
  }
};
