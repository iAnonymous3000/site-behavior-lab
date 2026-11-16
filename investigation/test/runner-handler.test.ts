import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { assertPublicHttpUrlShape } from "../../lib/url-safety";
import { HANDLER_HOST, HANDLER_ORIGIN } from "../core/case-container";
import { isHandlerProps, readBounded, RUNNER_CALL_HEADER, runnerHandler } from "../core/runner-handler";

/**
 * The handler's pure parts in Node: how a body is bounded, which props are a start's, that what it
 * sends on is built from the props, that it keeps nothing between requests, that the address it is
 * registered at is one the scanner's own proxy refuses for a page by its shape, and that nothing in
 * the front Worker reaches it. Its behaviour on workerd, through the real binding, is in
 * case-container-workerd.test.ts.
 */

const ROOT = process.cwd();
const read = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");
const CASE = "c".repeat(32);
const ATTEMPT = "a".repeat(32);
const PROPS = { caseId: CASE, slot: "B1", attemptId: ATTEMPT };

const body = (text: string, headers: Record<string, string> = {}, stream = false): Request =>
  new Request("http://case-handler.internal/", {
    method: "POST",
    headers,
    body: stream ? new ReadableStream({ start: (controller) => (controller.enqueue(new TextEncoder().encode(text)), controller.close()) }) : text,
    ...(stream ? { duplex: "half" } : {})
  } as RequestInit);

test("a body is read no further than its cap: refused by its declared length unread, cut where it runs past, and held to what it declares", async () => {
  assert.equal(new TextDecoder().decode((await readBounded(body("0123456789"), 16, false)) as Uint8Array), "0123456789");
  assert.equal(await readBounded(body("0123456789", { "content-length": "10" }), 9, false), "too-large");
  assert.equal(await readBounded(body("0123456789", {}, true), 9, false), "too-large");
  assert.equal(await readBounded(body("0123456789", {}, true), 16, true), "length-required");
  assert.equal(await readBounded(body("0123456789", { "content-length": "4" }, true), 16, true), "length-mismatch");
  assert.equal(await readBounded(body("0123", { "content-length": "10" }, true), 16, true), "length-mismatch");
  assert.equal(new TextDecoder().decode((await readBounded(body("0123", { "content-length": "4" }, true), 4, true)) as Uint8Array), "0123");
});

test("only a start's props are props: a hosted case id, a slot and an attempt id, exactly", () => {
  assert.equal(isHandlerProps(PROPS), true);
  for (const props of [undefined, null, {}, { ...PROPS, actor: "owner" }, { ...PROPS, caseId: "case-one" }, { ...PROPS, slot: "B9" }, { ...PROPS, attemptId: "x" }, [CASE, "B1", ATTEMPT]]) {
    assert.equal(isHandlerProps(props), false, JSON.stringify(props));
  }
});

/** A case namespace that records each call the handler sends on, and answers it. */
function recordingCases() {
  const sent: { name: string; headers: Record<string, string>; body: string }[] = [];
  return {
    sent,
    env: {
      INVESTIGATION_CASES: {
        idFromName: (name: string) => name,
        get: (name: unknown) => ({
          fetch: async (_url: string, init: { headers: Record<string, string>; body: string | ReadableStream<Uint8Array> }) => {
            const text = typeof init.body === "string" ? init.body : await new Response(init.body).text();
            sent.push({ name: String(name), headers: init.headers, body: text });
            return Response.json({ ok: true, head: "h", seq: 1 });
          }
        })
      }
    }
  };
}

test("what the handler sends on is built from the props: a call naming another case, slot or attempt is refused and reaches no case", async () => {
  const cases = recordingCases();
  const token = "b".repeat(64);
  const event = { type: "capture-began", data: { slot: "B1" } };
  const sent = await runnerHandler(body(JSON.stringify({ call: "runner", caseId: CASE, token, viewedHead: "h", event })), cases.env, PROPS);
  assert.equal(sent.status, 200);
  assert.deepEqual(cases.sent.map(({ name, headers, body: text }) => [name, headers[RUNNER_CALL_HEADER], JSON.parse(text)]), [[CASE, "runner", { call: "runner", caseId: CASE, token, viewedHead: "h", event }]]);
  await runnerHandler(body(JSON.stringify({ call: "runner-token", caseId: CASE, attemptId: ATTEMPT })), cases.env, PROPS);
  assert.deepEqual(JSON.parse(cases.sent[1].body), { call: "runner-token", caseId: CASE, attemptId: ATTEMPT });
  const before = cases.sent.length;
  for (const [label, call] of [
    ["another case", { call: "runner-token", caseId: "d".repeat(32), attemptId: ATTEMPT }],
    ["another attempt", { call: "runner-token", caseId: CASE, attemptId: "e".repeat(32) }],
    ["another slot", { call: "runner", caseId: CASE, token, viewedHead: "h", event: { type: "capture-began", data: { slot: "I1" } } }],
    ["another slot in a row", { call: "runner", caseId: CASE, token, viewedHead: "h", event: { type: "evidence-recorded", data: { row: { slot: "I1" } } } }],
    ["an actor beside the call", { call: "runner", caseId: CASE, token, viewedHead: "h", event, actor: "owner" }],
    ["an unknown call", { call: "runner-object", caseId: CASE, token, body: "" }]
  ] as const) {
    const answer = await runnerHandler(body(JSON.stringify(call)), cases.env, PROPS);
    assert.equal(answer.status, 400, label);
  }
  assert.equal(cases.sent.length, before);
  // No props, or not a start's, and nothing is sent on either.
  for (const props of [undefined, {}, { ...PROPS, attemptId: "x" }]) assert.equal((await runnerHandler(body(JSON.stringify({ call: "runner-token", caseId: CASE, attemptId: ATTEMPT })), cases.env, props)).status, 400);
  assert.equal(cases.sent.length, before);
});

test("the handler keeps nothing between requests: no binding at its top level is reassigned or holds a collection", () => {
  const source = read("investigation/core/runner-handler.ts");
  const file = ts.createSourceFile("runner-handler.ts", source, ts.ScriptTarget.Latest);
  const kept: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) kept.push(statement.getText(file).slice(0, 60));
    for (const declaration of statement.declarationList.declarations) {
      const initial = declaration.initializer?.getText(file) ?? "";
      if (/^new (Map|Set|WeakMap|Array)\b|^\[\]$/.test(initial)) kept.push(declaration.name.getText(file));
    }
  }
  assert.deepEqual(kept, []);
});

test("the handler's address is one the scanner's own proxy refuses for a page by its shape, before any lookup", () => {
  assert.equal(HANDLER_ORIGIN, `http://${HANDLER_HOST}`);
  assert.throws(() => assertPublicHttpUrlShape(new URL(HANDLER_ORIGIN)), /Local and private network targets are blocked/);
  // A check that would pass a public name: the same check lets one through.
  assert.doesNotThrow(() => assertPublicHttpUrlShape(new URL("http://example.com/")));
});

test("no route of the front Worker reaches the handler: only a case object's start builds its binding", () => {
  const entry = read("cloudflare/investigation-worker.ts");
  // The default export's fetch names neither the handler nor the platform's exports.
  const front = entry.slice(entry.indexOf("export default {"));
  assert.ok(front.length > 0 && front.includes("handleWorkspaceRequest"));
  assert.doesNotMatch(front, /InvestigationRunnerHandler|runnerHandler|exports/);
  // The handler's binding is built in the case object's constructor and nowhere else in the entry.
  assert.equal([...entry.matchAll(/\.InvestigationRunnerHandler\b/g)].length, 1);
  const built = entry.indexOf(".InvestigationRunnerHandler");
  assert.ok(built > entry.indexOf("export class InvestigationCase {") && built < entry.indexOf("export class InvestigationCaseIndex {"));
  // The viewer, its pages and the gate never name the handler, a start's props or a runner call's header.
  for (const file of ["investigation/core/viewer-routes.ts", "investigation/core/viewer-pages.ts", "investigation/core/workspace-gate.ts"]) {
    assert.doesNotMatch(read(file), /runner-handler|runnerHandler|handlerFor|x-runner-|\.exports\b/, file);
  }
  // In core, only the case object and its container's module build or take the binding.
  const handlerFor = ["case-host.ts", "case-container.ts"];
  for (const file of ["case-host.ts", "case-container.ts", "case-service.ts", "case-runner.ts", "case-supervision.ts", "viewer-routes.ts"]) {
    assert.equal(/handlerFor/.test(read(`investigation/core/${file}`)), handlerFor.includes(file), file);
  }
});
