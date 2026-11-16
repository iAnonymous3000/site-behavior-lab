// The handler a runner reaches its case through. The case object registers it for each start of a
// container, as the one address that container's requests to the case go to, with the case, the
// slot and the attempt that start was for as its props. The handler acts for those and nothing
// else: a call that names another case, slot or attempt is refused, and what it sends on is built
// from the props, never from the call.
//
// It holds nothing between requests: no token, no answer, no count. A presented token is read from
// the call and passed through once to the case object, which alone keeps the token's digest, decides
// what the token may write, and derives the runner's actor inside itself. The handler never answers
// for the object; it hands back the object's answer, and its own refusals are single words.
//
// Every body is bounded twice, here and again in the object: by its declared length first, when it
// has one, and then by counting while it is read, so a body past its cap is refused without being
// read in full. A token request may be 1 KiB, an event an entry's bound, an object the evidence
// bound. An object's bytes are the body itself, with the call's name, the case and the token in
// headers and, if the runner gives one, the digest it expects, which the object only compares with
// the digest it computes (ruling Q-2, F-2).
//
// Nothing in the front Worker reaches it: no route forwards to it, and the only code that builds
// its binding is the case object's start. The page's own traffic leaves the same container, so a
// request from the page can reach this handler too; it carries no token, so it writes nothing.
//
// NOT CLAIMED: how the platform routes a container's request to the address, or that a page's
// request cannot reach it at all. Both wait for a hosted run.

import { isAttemptId } from "./actor";
import { MAX_ENTRY_BYTES, MAX_EVIDENCE_BYTES } from "./case-log";
import { SLOT_NAMES } from "./case-machine";
import type { HandlerProps } from "./case-container";
import { jsonResponse } from "./workspace-response";

/** The headers a runner call carries to the case object, and an object's call carries from the runner. */
export const RUNNER_CALL_HEADER = "x-runner-call";
export const RUNNER_CASE_HEADER = "x-runner-case";
export const RUNNER_TOKEN_HEADER = "x-runner-token";
export const RUNNER_DIGEST_HEADER = "x-runner-digest";

/** The most bytes each runner call's body may hold. */
export const RUNNER_CALL_CAPS: Readonly<Record<string, number>> = Object.freeze({ "runner-token": 1024, runner: MAX_ENTRY_BYTES, "runner-object": MAX_EVIDENCE_BYTES });

/** The fields of each JSON call, and no others: the object's own lists. */
const JSON_CALL_FIELDS: Readonly<Record<string, readonly string[]>> = { "runner-token": ["attemptId", "call", "caseId"], runner: ["call", "caseId", "event", "token", "viewedHead"] };

/** The largest answer of the object's the handler hands back. Every answer of a runner call is a few hundred bytes. */
const ANSWER_CAP = 64 * 1024;
/** Never fetched from the network: a Durable Object's stub takes a URL and reads none of it here. */
const OBJECT_CALL_URL = "https://case-host.invalid/call";
const HOSTED_CASE_ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const refused = (status: number, refusal: string): Response => jsonResponse(status, { ok: false, refusal });

/** Whether these are a start's props: exactly a hosted case id, a slot and an attempt id. */
export function isHandlerProps(value: unknown): value is HandlerProps {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const { caseId, slot, attemptId } = value as Partial<HandlerProps>;
  return keys.join(",") === "attemptId,caseId,slot" && typeof caseId === "string" && HOSTED_CASE_ID.test(caseId) && (SLOT_NAMES as readonly unknown[]).includes(slot) && isAttemptId(attemptId);
}

/** A body's declared length, or null when it has none that reads as a length. */
export function declaredLength(request: Request): number | null {
  const header = request.headers.get("content-length");
  if (header === null || !/^(0|[1-9][0-9]{0,15})$/.test(header)) return null;
  const length = Number(header);
  return Number.isSafeInteger(length) ? length : null;
}

async function cancel(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // Nothing more is read either way.
  }
}

/**
 * The body's bytes, read no further than the cap. A declared length past the cap is refused before
 * any byte is read; a body that runs past the cap is cut there and refused. When exact, the body must
 * declare its length and hold exactly that many bytes.
 */
export async function readBounded(request: Request, cap: number, exact: boolean): Promise<Uint8Array<ArrayBuffer> | "too-large" | "length-required" | "length-mismatch"> {
  const declared = declaredLength(request);
  if (exact && declared === null) {
    await cancel(request);
    return "length-required";
  }
  if (declared !== null && declared > cap) {
    await cancel(request);
    return "too-large";
  }
  const limit = declared ?? cap;
  const held = new Uint8Array(limit);
  let filled = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (filled + value.byteLength > limit) {
          await reader.cancel();
          return declared === null ? "too-large" : "length-mismatch";
        }
        held.set(value, filled);
        filled += value.byteLength;
      }
    } catch {
      return "length-mismatch";
    }
  }
  if (declared !== null && filled !== declared) return "length-mismatch";
  return held.slice(0, filled);
}

const BOUND_REFUSALS: Readonly<Record<string, [number, string]>> = { "too-large": [413, "body-too-large"], "length-required": [411, "length-required"], "length-mismatch": [400, "body-length-mismatch"] };

/** The slot an event of the runner's names: inside the row for a row, in its data otherwise. */
function slotNamedBy(event: unknown): unknown {
  const data = (event as { data?: unknown } | null)?.data;
  if (typeof data !== "object" || data === null) return undefined;
  if ((event as { type?: unknown }).type === "evidence-recorded") {
    const row = (data as { row?: unknown }).row;
    return typeof row === "object" && row !== null ? (row as { slot?: unknown }).slot : undefined;
  }
  return (data as { slot?: unknown }).slot;
}

type CaseStub = { fetch(input: string, init: { method: string; headers: Record<string, string>; body: string | ReadableStream<Uint8Array> }): Promise<Response> };
type CaseNamespace = { idFromName(name: string): unknown; get(id: unknown): CaseStub };

function isCaseNamespace(value: unknown): value is CaseNamespace {
  const namespace = value as Partial<CaseNamespace> | null;
  return typeof namespace === "object" && namespace !== null && typeof namespace.idFromName === "function" && typeof namespace.get === "function";
}

/** The object's answer, handed back as it gave it, within the answer cap. */
async function handedBack(response: Response): Promise<Response> {
  const text = await response.text();
  if (text.length > ANSWER_CAP) return refused(502, "answer-too-large");
  return new Response(text, { status: response.status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** One request from the container the object registered this handler for, with that start's props. */
export async function runnerHandler(request: Request, env: Readonly<{ INVESTIGATION_CASES?: unknown }>, props: unknown): Promise<Response> {
  if (!isHandlerProps(props) || request.method !== "POST") {
    await cancel(request);
    return refused(400, "malformed-call");
  }
  const cases = env.INVESTIGATION_CASES;
  if (!isCaseNamespace(cases)) {
    await cancel(request);
    return refused(503, "unavailable");
  }
  const stub = cases.get(cases.idFromName(props.caseId));

  if (request.headers.get(RUNNER_CALL_HEADER) === "runner-object") {
    const declared = declaredLength(request);
    if (declared === null) {
      await cancel(request);
      return refused(411, "length-required");
    }
    if (declared > RUNNER_CALL_CAPS["runner-object"]) {
      await cancel(request);
      return refused(413, "body-too-large");
    }
    const token = request.headers.get(RUNNER_TOKEN_HEADER);
    const digest = request.headers.get(RUNNER_DIGEST_HEADER);
    if (request.headers.get(RUNNER_CASE_HEADER) !== props.caseId || token === null || (digest !== null && !DIGEST.test(digest)) || request.body === null) {
      await cancel(request);
      return refused(400, request.headers.get(RUNNER_CASE_HEADER) !== props.caseId ? "not-this-attempt" : "malformed-call");
    }
    // Passed on as it arrives, never held whole here, and cut where it runs past what it declared.
    let seen = 0;
    const counted = request.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > declared) controller.error(new Error("past the declared length"));
          else controller.enqueue(chunk);
        }
      })
    );
    const headers: Record<string, string> = { [RUNNER_CALL_HEADER]: "runner-object", [RUNNER_CASE_HEADER]: props.caseId, [RUNNER_TOKEN_HEADER]: token, "content-length": String(declared), "content-type": "application/octet-stream" };
    if (digest !== null) headers[RUNNER_DIGEST_HEADER] = digest;
    try {
      return await handedBack(await stub.fetch(OBJECT_CALL_URL, { method: "POST", headers, body: counted }));
    } catch {
      return refused(503, "unavailable");
    }
  }

  const bytes = await readBounded(request, RUNNER_CALL_CAPS.runner, false);
  if (typeof bytes === "string") return refused(...BOUND_REFUSALS[bytes]);
  let call: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refused(400, "malformed-call");
    call = parsed as Record<string, unknown>;
  } catch {
    return refused(400, "malformed-call");
  }
  const name = call.call;
  const wanted = typeof name === "string" && Object.hasOwn(JSON_CALL_FIELDS, name) ? JSON_CALL_FIELDS[name] : null;
  if (wanted === null || Object.keys(call).sort().join(",") !== wanted.join(",")) return refused(400, "malformed-call");
  if (bytes.byteLength > RUNNER_CALL_CAPS[name as string]) return refused(413, "body-too-large");
  // Whom the call is for comes from the props. A call that names anyone else is refused, not corrected.
  if (call.caseId !== props.caseId) return refused(400, "not-this-attempt");
  let forward: Record<string, unknown>;
  if (name === "runner-token") {
    if (call.attemptId !== props.attemptId) return refused(400, "not-this-attempt");
    forward = { call: name, caseId: props.caseId, attemptId: props.attemptId };
  } else {
    const slot = slotNamedBy(call.event);
    if (slot !== undefined && slot !== props.slot) return refused(400, "not-this-attempt");
    forward = { call: name, caseId: props.caseId, token: call.token, viewedHead: call.viewedHead, event: call.event };
  }
  try {
    return await handedBack(await stub.fetch(OBJECT_CALL_URL, { method: "POST", headers: { [RUNNER_CALL_HEADER]: name as string, "content-type": "application/json" }, body: JSON.stringify(forward) }));
  } catch {
    return refused(503, "unavailable");
  }
}
