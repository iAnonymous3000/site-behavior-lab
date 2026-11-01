// The only way into the private investigation workspace. Every request passes
// here, and only a verified identity reaches a route.
//
// Nothing has a route yet but health: the workspace is deny-all, and no case,
// capture or evidence code exists behind it. Routes receive the identity as an
// argument and a request with its identity headers gone, so no route can read
// who is asking from anything a client sent.

import { ACCESS_TOKEN_HEADER, verifyAccessToken, type AccessKeySet, type VerifiedIdentity } from "./access-token";
import { workspaceConfigFrom, type WorkspaceEnv } from "./workspace-config";

export type { WorkspaceEnv } from "./workspace-config";

export type WorkspaceRoutes = (request: Request, identity: VerifiedIdentity) => Response | Promise<Response>;

export type WorkspaceRuntime = {
  keySetFor: (issuer: string) => Pick<AccessKeySet, "keyFor">;
  now: () => number;
  /** Tests name their own, to read what a route receives. */
  routes?: WorkspaceRoutes;
};

const HEALTH_PATH = "/health";
const FULL_COMMIT = /^[0-9a-f]{40}$/;
/**
 * What a route may read of a request's headers. Everything else, identity included,
 * stops here. A later state-changing route will need origin and sec-fetch-site added.
 */
const FORWARDED_HEADERS = ["accept", "accept-language", "content-length", "content-type", "if-none-match"] as const;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });
}

/** A refused request learns nothing of why, not even that its token was genuine. Only an outage answers differently. */
function refusalResponse(status: 401 | 503): Response {
  return jsonResponse(status, { error: status === 503 ? "unavailable" : "access-refused" });
}

/** Built from parts, not copied, so nothing the platform attached to the request comes along either. */
function withoutInboundIdentity(request: Request): Request {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, redirect: "manual" };
  // GET and HEAD have no body to pass on. A client can still declare one, and workerd
  // then hands over a stream that its own Request constructor refuses for these methods.
  if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(request.url, init);
}

function isHealthRead(request: Request): boolean {
  return new URL(request.url).pathname === HEALTH_PATH && (request.method === "GET" || request.method === "HEAD");
}

function denyAllRoutes(env: WorkspaceEnv): WorkspaceRoutes {
  return (request) => {
    const { pathname } = new URL(request.url);
    if (pathname !== HEALTH_PATH) return jsonResponse(404, { error: "not-found" });
    if (!isHealthRead(request)) return jsonResponse(405, { error: "method-not-allowed" }, { allow: "GET, HEAD" });
    const commit = env.SITE_BEHAVIOR_LAB_BUILD_COMMIT;
    return jsonResponse(200, { status: "deny-all", commit: commit !== undefined && FULL_COMMIT.test(commit) ? commit : null });
  };
}

export async function handleWorkspaceRequest(request: Request, env: WorkspaceEnv, runtime: WorkspaceRuntime): Promise<Response> {
  const config = workspaceConfigFrom(env);
  if (config === null) return refusalResponse(503);

  // A workers.dev, preview or other alias stays refused even if the platform's
  // configuration drifts, and so does anything not over https. Checked first, so such a
  // request fetches no key and answers exactly as one with no token does, whatever it carries.
  const { protocol, host } = new URL(request.url);
  if (protocol !== "https:" || host !== config.hostname) return refusalResponse(401);

  const decision = await verifyAccessToken(
    request.headers.get(ACCESS_TOKEN_HEADER),
    config.policy,
    runtime.keySetFor(config.policy.issuer),
    runtime.now
  );
  if (!decision.ok) return refusalResponse(decision.refusal === "keys-unavailable" ? 503 : 401);

  // A service token proves only that the deployment answers: health, and nothing else.
  // Anywhere else it answers as a forged token does, so a refusal cannot tell them apart.
  if (decision.identity.kind === "health-service" && !isHealthRead(request)) return refusalResponse(401);

  return (runtime.routes ?? denyAllRoutes(env))(withoutInboundIdentity(request), decision.identity);
}
