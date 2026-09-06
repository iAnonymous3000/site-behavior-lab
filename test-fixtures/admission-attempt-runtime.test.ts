import { DurableObject } from "cloudflare:workers";
import worker from "../cloudflare/container-worker";
import { chargeAdmissionAttempt } from "../lib/admission-attempt-limit";

// Real public Worker routing, with only the container-owning DO replaced. The
// harness has no browser, containerFetch or Siteverify implementation: an
// unexpected crossing fails rather than silently returning a mocked success.
export class AdmissionAttemptHarness extends DurableObject {
  chargeAdmissionAttempt({ clientHash }: { clientHash: string }) {
    return this.ctx.storage.transactionSync(() =>
      chargeAdmissionAttempt(this.ctx.storage.sql, clientHash, Date.now())
    );
  }
}

export default {
  fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    return worker.fetch(request, {
      SCANNER: env.SCANNER,
      SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN: "https://sitebehavior.org",
      SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS: "1",
      TURNSTILE_SECRET_KEY: "fixture-no-siteverify-request-allowed"
    } as Parameters<typeof worker.fetch>[1], ctx);
  }
};
