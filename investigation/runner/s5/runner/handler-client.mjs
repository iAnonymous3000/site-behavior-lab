// The runner's three calls to whoever holds its case: the token hand-out, a write, and storing one
// bundled object. JSON over HTTP, the same shapes the case object takes (S5b's runner-token and
// runner, investigation/core/case-host.ts) and the shape O-2 fixed for runner-object. Each call
// carries exactly its own fields. In fixture mode the other end is the stand-in inside the
// container; in production it is the handler a later part builds.
//
// The token is never in an error, a progress line or a return value other than the hand-out's own:
// every failure here is reported by the call's name and a status or refusal word only.

const CALL_MS = 30_000;
const ANSWER_CAP = 64 * 1024;

export function handlerClient(origin) {
  const post = async (call) => {
    let response;
    try {
      response = await fetch(`${origin}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(call),
        signal: AbortSignal.timeout(CALL_MS)
      });
    } catch (error) {
      return { ok: false, refusal: "unreachable", at: String(error?.name ?? "error").slice(0, 40), head: null };
    }
    const text = await response.text();
    if (text.length > ANSWER_CAP) return { ok: false, refusal: "answer-too-large", at: null, head: null };
    let answer;
    try { answer = JSON.parse(text); } catch { return { ok: false, refusal: "answer-not-json", at: String(response.status), head: null }; }
    if (response.status !== 200 && answer?.ok !== false) return { ok: false, refusal: "malformed-call", at: String(response.status), head: null };
    return answer;
  };
  return {
    /** runner-token {caseId, attemptId}: the first answer carries the token with the case's head and seq. */
    token: (caseId, attemptId) => post({ call: "runner-token", caseId, attemptId }),
    /** runner {caseId, token, viewedHead, event}: the answer carries the new head and seq, or a refusal. */
    write: (caseId, token, viewedHead, event) => post({ call: "runner", caseId, token, viewedHead, event }),
    /** runner-object {caseId, token, body}: the bytes in base64; the answer is the object's sha256 digest, or a refusal. */
    object: (caseId, token, bytes) => post({ call: "runner-object", caseId, token, body: Buffer.from(bytes).toString("base64") })
  };
}
