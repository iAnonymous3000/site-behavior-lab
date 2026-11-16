// The stand-in handler, in the fixture entry only (G-6, answer 4): inside the container, on loopback,
// it takes the runner's three calls in the case object's own shapes and writes each one to a file.
// Those files are the recorded outputs.
//
// What it does, and no more:
// - runner-token {caseId, attemptId}: the first answer carries the token with the case's head and seq
//   and nothing else (S-3, O-1). A second request is refused and revokes the token (D-8, A-3).
// - runner {caseId, token, viewedHead, event}: a write on a stale head is refused as a conflict that
//   hands back the current head; an accepted write answers the new head and seq (O-1). Only the
//   runner's nine events pass (case-runner.ts's list); after the outcome only a cleanup event does.
//   Every event is read with core's decodeEvent and the reading is recorded with it.
// - runner-object {caseId, token, body}: the bytes stored in a file named by their sha256, answered
//   with that digest (O-2). The object's real side (the cap, create-only, the token rule) is S5e's.
// - Anything else that reaches it (a page's request, say) is recorded by method, path and host only.
// Each call's fields are exactly case-host.ts's for that call. The token is the plan's canary, read
// from the image: nothing here draws a random value. It is never written to any file; a call records
// only whether its token matched.
import http from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** case-host.ts's RUNNER_CALL_FIELDS, and O-2's runner-object. A text test holds the first two to case-host.ts. */
export const CALL_FIELDS = Object.freeze({
  "runner-token": ["attemptId", "call", "caseId"],
  runner: ["call", "caseId", "event", "token", "viewedHead"],
  "runner-object": ["body", "call", "caseId", "token"]
});
const BODY_CAP = 48 * 1024 * 1024;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function startStandIn({ port, outDir, plan, core }) {
  const { decodeEvent, RUNNER_EVENT_TYPES, CLEANUP_EVENT_TYPES } = core;
  mkdirSync(`${outDir}/objects`, { recursive: true });
  const callsFile = `${outDir}/calls.jsonl`;
  const requestsFile = `${outDir}/requests.jsonl`;
  writeFileSync(callsFile, "");
  writeFileSync(requestsFile, "");
  const s = plan.standin;
  const state = { handed: false, revoked: false, head: sha256(`stand-in genesis ${plan.caseId}`), seq: 0, writes: 0, outcome: false };
  let n = 0;
  const record = (entry) => appendFileSync(callsFile, JSON.stringify({ n: ++n, t: new Date().toISOString(), ...entry }) + "\n");
  const advance = (what) => { state.seq += 1; state.head = sha256(`${state.head}\n${what}`); };

  const answerFor = (call) => {
    const keys = Object.keys(call).sort();
    const wanted = CALL_FIELDS[call.call];
    if (!wanted || keys.length !== wanted.length || !keys.every((k, i) => k === wanted[i])) return [400, { ok: false, refusal: "malformed-call" }];
    if (call.caseId !== plan.caseId) return [200, { ok: false, refusal: "no-such-attempt" }];
    if (call.call === "runner-token") {
      if (call.attemptId !== plan.attemptId || s.refuseToken === true) return [200, { ok: false, refusal: "no-such-attempt" }];
      if (state.revoked) return [200, { ok: false, refusal: "token-revoked" }];
      if (state.handed) { state.revoked = true; return [200, { ok: false, refusal: "token-already-handed" }]; }
      state.handed = true;
      return [200, { ok: true, token: s.token, head: state.head, seq: state.seq }];
    }
    if (state.revoked || call.token !== s.token) return [200, { ok: false, refusal: "token-refused", at: null, head: null }];
    if (call.call === "runner-object") {
      if (typeof call.body !== "string") return [400, { ok: false, refusal: "malformed-call" }];
      const bytes = Buffer.from(call.body, "base64");
      const digest = sha256(bytes);
      writeFileSync(`${outDir}/objects/${digest}`, bytes);
      return [200, { ok: true, digest }];
    }
    const event = call.event;
    if (!RUNNER_EVENT_TYPES.includes(event?.type)) return [200, { ok: false, refusal: "not-a-runner-event", at: null, head: state.head }];
    if (state.outcome && !CLEANUP_EVENT_TYPES.includes(event.type)) return [200, { ok: false, refusal: "attempt-ended", at: null, head: state.head }];
    // O-1's stale head: an owner write lands just before the runner's write number ownerWriteBefore.
    state.writes += 1;
    if (state.writes === s.ownerWriteBefore) { advance("an owner write the stand-in makes"); record({ call: "owner-write", head: state.head, seq: state.seq }); }
    if (call.viewedHead !== state.head) return [200, { ok: false, refusal: "conflict", at: null, head: state.head }];
    const decoded = decodeEvent(event);
    if (!decoded.ok) return [200, { ok: false, refusal: decoded.refusal, at: decoded.at, head: state.head }];
    if (event.type === "attempt-finished") state.outcome = true;
    advance(JSON.stringify(event));
    return [200, { ok: true, head: state.head, seq: state.seq }];
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (d) => { size += d.length; if (size <= BODY_CAP) chunks.push(d); });
    req.on("end", () => {
      let call = null;
      if (req.method === "POST" && req.url === "/" && size <= BODY_CAP) { try { call = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {} }
      if (call === null || typeof call !== "object" || typeof call.call !== "string") {
        appendFileSync(requestsFile, JSON.stringify({ t: new Date().toISOString(), method: String(req.method).slice(0, 10), path: String(req.url).slice(0, 200), host: String(req.headers.host ?? "").slice(0, 100) }) + "\n");
        res.writeHead(404).end();
        return;
      }
      const viewedHead = call.viewedHead;
      const [status, answer] = answerFor(call);
      const kept = { call: String(call.call).slice(0, 20), fields: Object.keys(call).sort(), status, tokenMatched: "token" in call ? call.token === s.token : null, viewedHead: typeof viewedHead === "string" ? viewedHead : null };
      if (call.call === "runner" && call.event && typeof call.event === "object") { kept.event = call.event; const d = decodeEvent(call.event); kept.decoded = d.ok ? "ok" : `${d.refusal}:${d.at}`; }
      if (call.call === "runner-object") kept.bytes = typeof call.body === "string" ? Buffer.from(call.body, "base64").length : null;
      kept.answer = answer.ok && "token" in answer ? { ok: true, tokenHanded: true, head: answer.head, seq: answer.seq } : answer;
      record(kept);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state })));
}
