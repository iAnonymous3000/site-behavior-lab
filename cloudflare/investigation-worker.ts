/// <reference types="@cloudflare/workers-types" />

// Front Worker of the private investigation workspace, and the two Durable Object classes
// its cases live in. It has no route to it yet: wrangler.investigation.jsonc names no
// hostname, and nothing deploys it. It shares nothing with the public scanner, and no public
// entrypoint imports it (lib/runtime-boundaries.test.ts).
//
// The viewer's routes stand behind the gate. They get a case service only when the
// workspace's configuration and all three bindings are there: the case objects, the object
// that lists them, and the private bucket. With any of them missing every case route answers
// 503, as a missing configuration does, and only health answers otherwise.
// investigation/test/workspace-entry-workerd.test.ts runs this entry's own bundle on workerd
// with no binding and holds that, and investigation/test/case-host-workerd.test.ts runs it
// with all three.
//
// Each class below only hands its storage, its name and its environment to
// investigation/core/case-host.ts, which holds everything an object does. Every call an
// object takes verifies the Access assertion again, inside the object, except a runner's two
// calls, which carry the attempt's token instead and which no route here sends. A case's alarm
// holds no assertion, and writes nothing to a case's log: it flags a deadline that came due and
// records the runner's stop, which revokes that attempt's token. No container exists yet, so
// nothing more is stopped.
import { AccessKeySet } from "../investigation/core/access-token";
import { caseIndexObject, caseObject, hostedCasesFrom, type CaseHostObject, type HostEnv, type HostObject } from "../investigation/core/case-host";
import { viewerRoutes } from "../investigation/core/viewer-routes";
import { handleWorkspaceRequest } from "../investigation/core/workspace-gate";

const keySets = new Map<string, AccessKeySet>();

function keySetFor(issuer: string): AccessKeySet {
  let keySet = keySets.get(issuer);
  if (keySet === undefined) {
    keySet = new AccessKeySet(issuer, (url, init) => fetch(url, init), Date.now);
    keySets.set(issuer, keySet);
  }
  return keySet;
}

/** One case, as its single writer, and the alarm that watches its deadlines. */
export class InvestigationCase {
  private readonly answer: CaseHostObject;

  constructor(state: DurableObjectState, env: HostEnv) {
    this.answer = caseObject({ name: state.id.name, storage: state.storage, env, keySetFor, now: Date.now });
  }

  fetch(request: Request): Promise<Response> {
    return this.answer(request);
  }

  /** Flags a deadline that came due, in the object's own storage. It writes nothing to the case's log. */
  alarm(): Promise<void> {
    return this.answer.alarm();
  }
}

/** The list of this namespace's cases. */
export class InvestigationCaseIndex {
  private readonly answer: HostObject;

  constructor(state: DurableObjectState, env: HostEnv) {
    this.answer = caseIndexObject({ name: state.id.name, storage: state.storage, env, keySetFor, now: Date.now });
  }

  fetch(request: Request): Promise<Response> {
    return this.answer(request);
  }
}

export default {
  fetch(request: Request, env: HostEnv): Promise<Response> {
    const hosted = hostedCasesFrom(env);
    return handleWorkspaceRequest(request, env, { keySetFor, now: Date.now, routes: viewerRoutes({ env, service: hosted?.service ?? null, directory: hosted?.directory ?? null, commands: hosted?.commands ?? null }) });
  }
};
