import { R2_DELETE_CANARY_PREFIX, runR2DeleteCanary, type R2DeleteCanaryBucket } from "../lib/r2-delete-canary";

type Env = {
  REPORTS: R2Bucket;
  SITE_BEHAVIOR_LAB_R2_DELETE_CANARY_TOKEN?: string;
};

const MIN_TOKEN_LENGTH = 32;

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") {
      return json({ ok: false, error: "Use authenticated POST /run." }, 405, { allow: "POST" });
    }

    if (!(await authorized(request, env.SITE_BEHAVIOR_LAB_R2_DELETE_CANARY_TOKEN))) {
      return json({ ok: false, error: "Unauthorized." }, 401, { "www-authenticate": "Bearer" });
    }

    try {
      const result = await runR2DeleteCanary(env.REPORTS as unknown as R2DeleteCanaryBucket);
      return json({
        ok: true,
        status: "passed",
        scope: "r2-write-read-delete",
        keyPrefix: result.keyPrefix,
        created: result.created,
        readBack: result.readBack,
        deleted: result.deleted
      });
    } catch (error) {
      // The private Worker log retains bounded operator diagnostics. The
      // response never reveals object keys, credentials, or bucket contents.
      console.error("R2 delete canary failed", safeError(error));
      return json({
        ok: false,
        status: "failed",
        scope: "r2-write-read-delete",
        keyPrefix: R2_DELETE_CANARY_PREFIX
      }, 500);
    }
  }
};

export default worker;

async function authorized(request: Request, configuredToken: string | undefined): Promise<boolean> {
  const expected = configuredToken?.trim() ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const presented = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (expected.length < MIN_TOKEN_LENGTH || presented.length < MIN_TOKEN_LENGTH) return false;

  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(presented))
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function json(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown failure";
}
