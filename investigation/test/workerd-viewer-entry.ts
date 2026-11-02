import { AccessKeySet } from "../core/access-token";
import type { LogStores } from "../core/case-log";
import { caseServiceOver, type CaseService } from "../core/case-service";
import { viewerRoutes } from "../core/viewer-routes";
import { workspaceConfigFrom } from "../core/workspace-config";
import { handleWorkspaceRequest, type WorkspaceEnv } from "../core/workspace-gate";
import { acrossABoundary, storesFromDump, type StoresDump } from "./memory-case-world";

/**
 * The workspace as the browser test runs it on real workerd: the production gate and viewer,
 * with a memory-backed case service where the production entry has none. The cases arrive as a
 * binding, built in Node by the real store, and the service answers across a structured copy,
 * as a Durable Object would. Nothing here deploys.
 */

type Env = WorkspaceEnv & { VIEWER_CASES: readonly StoresDump[] };

const keySets = new Map<string, AccessKeySet>();

function keySetFor(issuer: string): AccessKeySet {
  let keySet = keySets.get(issuer);
  if (keySet === undefined) {
    keySet = new AccessKeySet(issuer, (url, init) => fetch(url, init), Date.now);
    keySets.set(issuer, keySet);
  }
  return keySet;
}

let service: CaseService | null = null;

/** Built once per isolate, so a write one request makes is there for the next. */
function serviceFor(env: Env): CaseService | null {
  if (service !== null) return service;
  const config = workspaceConfigFrom(env);
  if (config === null) return null;
  const cases = new Map<string, LogStores>(env.VIEWER_CASES.map((dump) => [dump.caseId, storesFromDump(dump)] as const));
  service = acrossABoundary(caseServiceOver({ policy: config.policy, keySetFor, now: Date.now, storesFor: (caseId) => cases.get(caseId) ?? null }));
  return service;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleWorkspaceRequest(request, env, { keySetFor, now: Date.now, routes: viewerRoutes({ env, service: serviceFor(env) }) });
  }
};
