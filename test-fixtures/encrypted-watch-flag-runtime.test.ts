import { DurableObject } from "cloudflare:workers";
import worker from "../cloudflare/container-worker";

// Real public Worker routing, with only the container-owning DO replaced by a
// recorder. Rollback recovery may look an existing watch up; every other DO
// method the creation path could reach is recorded too, so a regression shows
// up as an extra call rather than as a silently mocked success.
export class EncryptedWatchFlagHarness extends DurableObject {
  private calls: string[] = [];

  chargeEncryptedWatchReadRateLimit() {
    this.calls.push("chargeEncryptedWatchReadRateLimit");
    return { allowed: true };
  }

  findEncryptedWatch() {
    this.calls.push("findEncryptedWatch");
    return null;
  }

  peekPublicScanRateLimit() {
    this.calls.push("peekPublicScanRateLimit");
    return { allowed: true };
  }

  takeCalls() {
    const calls = this.calls;
    this.calls = [];
    return calls;
  }
}

const FLAG_HEADER = "x-harness-encrypted-watches";

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    const scanner = env.SCANNER as DurableObjectNamespace<EncryptedWatchFlagHarness>;
    if (new URL(request.url).pathname === "/__harness/calls") {
      // getContainer's default instance name.
      const calls = await scanner.get(scanner.idFromName("cf-singleton-container")).takeCalls();
      return Response.json(calls);
    }
    const flag = request.headers.get(FLAG_HEADER) ?? "0";
    const headers = new Headers(request.headers);
    headers.delete(FLAG_HEADER);
    return worker.fetch(new Request(request, { headers }), {
      SCANNER: env.SCANNER,
      SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN: "https://sitebehavior.org",
      SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS: "1",
      SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES: flag,
      TURNSTILE_SECRET_KEY: "fixture-no-siteverify-request-allowed"
    } as Parameters<typeof worker.fetch>[1], ctx);
  }
};
