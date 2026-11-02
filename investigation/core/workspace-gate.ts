// The only way into the private investigation workspace. Every request passes
// here, and only a verified identity reaches a route.
//
// Routes receive the identity as an argument, the assertion it was verified from as a
// second, and a request with its identity headers gone, so no route can read who is
// asking from anything a client sent. The assertion goes on as the string this gate
// verified, for a case service to verify again where an actor cannot follow: an actor is
// membership of a set in one isolate, and a Durable Object is another.
//
// Every request but a GET must also come from a page on this workspace's own origin. That
// is decided here, after the identity, so a write with no token, a forged one or a service
// token still answers 401 as everything else does, and no route can be added that skips it.
// The rule reads the Origin header and nothing else: it does not rest on what the Access
// cookie's SameSite setting does, which is undecided. The one exception is a HEAD of health,
// which the service token may send as W1 admits it, and which changes nothing. A request a browser
// marks as coming from another site is refused too, unless it navigates the top-level window here.

import { ACCESS_TOKEN_HEADER, verifyAccessToken, type AccessKeySet, type VerifiedIdentity } from "./access-token";
import { workspaceConfigFrom, type WorkspaceEnv } from "./workspace-config";
import { jsonResponse, refusalResponse as sharedRefusal } from "./workspace-response";

export type { WorkspaceEnv } from "./workspace-config";

export type WorkspaceRoutes = (request: Request, identity: VerifiedIdentity, assertion: string) => Response | Promise<Response>;

export type WorkspaceRuntime = {
  keySetFor: (issuer: string) => Pick<AccessKeySet, "keyFor">;
  now: () => number;
  /** The viewer's, or a test's own, to read what a route receives. With none, only health answers. */
  routes?: WorkspaceRoutes;
};

export const HEALTH_PATH = "/health";
const FULL_COMMIT = /^[0-9a-f]{40}$/;
/**
 * What a route may read of a request's headers. Everything else, identity included,
 * stops here. Origin is read by this gate and goes no further.
 */
const FORWARDED_HEADERS = ["accept", "accept-language", "content-length", "content-type", "if-none-match"] as const;

/** A refused request learns nothing of why. Built by workspace-response.ts, as every response the workspace makes is. */
function refusalResponse(status: 401 | 403 | 503): Response {
  return sharedRefusal(status);
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

/** A GET a browser marks as navigating the top-level window to this address. */
function isTopLevelNavigation(request: Request): boolean {
  const dest = request.headers.get("sec-fetch-dest");
  return request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate" && (dest === null || dest === "document");
}

function isHealthRead(request: Request): boolean {
  return new URL(request.url).pathname === HEALTH_PATH && (request.method === "GET" || request.method === "HEAD");
}

/** Health, for any route table that serves it: whether the deployment answers, whether it serves any case, and its build commit. */
export function healthResponse(request: Request, env: WorkspaceEnv, status: "deny-all" | "serving-cases" = "deny-all"): Response {
  if (!isHealthRead(request)) return jsonResponse(405, { error: "method-not-allowed" }, { allow: "GET, HEAD" });
  const commit = env.SITE_BEHAVIOR_LAB_BUILD_COMMIT;
  return jsonResponse(200, { status, commit: commit !== undefined && FULL_COMMIT.test(commit) ? commit : null });
}

function denyAllRoutes(env: WorkspaceEnv): WorkspaceRoutes {
  return (request) => {
    const { pathname } = new URL(request.url);
    if (pathname !== HEALTH_PATH) return jsonResponse(404, { error: "not-found" });
    return healthResponse(request, env);
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

  const assertion = request.headers.get(ACCESS_TOKEN_HEADER);
  const decision = await verifyAccessToken(assertion, config.policy, runtime.keySetFor(config.policy.issuer), runtime.now);
  if (!decision.ok) return refusalResponse(decision.refusal === "keys-unavailable" ? 503 : 401);

  // A service token proves only that the deployment answers: health, and nothing else.
  // Anywhere else it answers as a forged token does, so a refusal cannot tell them apart.
  if (decision.identity.kind === "health-service" && !isHealthRead(request)) return refusalResponse(401);

  // Anything but a GET from a page on another origin, or from one whose origin a browser will
  // not say, is refused whatever credential came with it. A missing Origin is refused too.
  if (request.method !== "GET" && !isHealthRead(request) && request.headers.get("origin") !== `https://${config.hostname}`) return refusalResponse(403);

  // A load from a page of another site, with the owner's credential riding along, is refused
  // unless it is a top-level GET navigation: a link the owner follows from elsewhere still works,
  // and so does Access sending them back here after a login, but an image, a script, a frame or a
  // fetch of a case page from another site gets nothing. A request no browser marked is let be.
  const site = request.headers.get("sec-fetch-site");
  if ((site === "cross-site" || site === "same-site") && !isTopLevelNavigation(request)) return refusalResponse(403);

  // Verification succeeded, so the header held a token, and this is the string it verified.
  return (runtime.routes ?? denyAllRoutes(env))(withoutInboundIdentity(request), decision.identity, assertion as string);
}
