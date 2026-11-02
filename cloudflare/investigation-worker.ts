/// <reference types="@cloudflare/workers-types" />

// Front Worker of the private investigation workspace. It holds no binding and has
// no route to it yet: wrangler.investigation.jsonc names no hostname, and nothing
// deploys it. It shares nothing with the public scanner, and no public entrypoint
// imports it (lib/runtime-boundaries.test.ts).
//
// The viewer's routes stand behind the gate, and no case service is configured here:
// nothing holds a case yet, since the Durable Object, its storage and its alarms are a
// later batch. So every case route answers 503, as a missing configuration does, and
// only health answers otherwise. investigation/test/workspace-entry-workerd.test.ts runs
// this entry's own bundle on workerd and holds that.
import { AccessKeySet } from "../investigation/core/access-token";
import { viewerRoutes } from "../investigation/core/viewer-routes";
import { handleWorkspaceRequest, type WorkspaceEnv } from "../investigation/core/workspace-gate";

const keySets = new Map<string, AccessKeySet>();

function keySetFor(issuer: string): AccessKeySet {
  let keySet = keySets.get(issuer);
  if (keySet === undefined) {
    keySet = new AccessKeySet(issuer, (url, init) => fetch(url, init), Date.now);
    keySets.set(issuer, keySet);
  }
  return keySet;
}

export default {
  fetch(request: Request, env: WorkspaceEnv): Promise<Response> {
    return handleWorkspaceRequest(request, env, { keySetFor, now: Date.now, routes: viewerRoutes({ env, service: null }) });
  }
};
