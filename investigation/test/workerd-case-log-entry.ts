import { runnerActorFrom, type Actor } from "../core/actor";
import { appendCommand, createLog, openLog, putEvidence, type LogStores } from "../core/case-log";
import { canonicalBytes } from "../core/canonical-json";
import { plannedState, step } from "../core/case-machine";
import { openCase, runCommand } from "../core/case-store";
import { mintCaseId } from "../core/ids";
import { readExecutionJoin } from "../core/readings";
import { projectAttemptSummary } from "../core/summary-tier";
import { memoryStores } from "./memory-log-store";

/**
 * Bundled by case-log-workerd.test.ts and run on real workerd, the runtime the log is
 * written for. It answers with what the log did there, for the test to compare with
 * expected values written out on the other side.
 */

async function refusalOf(stores: LogStores, caseId: string): Promise<string> {
  const opened = await openLog(stores, caseId);
  return opened.ok ? "opened" : opened.refusal;
}

export default {
  async fetch(): Promise<Response> {
    const stores = memoryStores();
    await createLog(stores);
    const caseId = "case-a";
    const actor = runnerActorFrom("a1".repeat(16)) as Actor;
    const put = await putEvidence(stores, new TextEncoder().encode("first evidence"));
    if (!put.ok) throw new Error(put.refusal);
    const genesis = "0".repeat(64);
    const first = await appendCommand(stores, {
      caseId,
      actor,
      events: [{ type: "capture-recorded", data: { nested: { z: null, a: [1, "é"] }, count: 2 } }],
      evidence: [put.digest],
      expectedHead: genesis,
      now: () => 1793534401000
    });
    if (!first.ok) throw new Error(first.refusal);
    const stale = await appendCommand(stores, { caseId, actor, events: [{ type: "stale", data: {} }], evidence: [], expectedHead: genesis, now: () => 1 });
    const clean = await refusalOf(stores, caseId);
    const otherCase = await refusalOf(stores, "case-b");

    const edited = await stores.entries.read(first.digest, 1024);
    stores.entries.objects.set(first.digest, new TextEncoder().encode("edited"));
    const afterEdit = await refusalOf(stores, caseId);
    stores.entries.objects.set(first.digest, edited as Uint8Array<ArrayBuffer>);
    stores.evidence.objects.set(put.digest, new TextEncoder().encode("changed"));
    const afterChange = await refusalOf(stores, caseId);

    // The case code, where its URL parser, WebCrypto and random source are workerd's.
    const summary = await projectAttemptSummary(
      { attemptId: "a1".repeat(16), slot: "B1", arm: "baseline", phase: "usable" },
      {
        scripts: [
          { url: "https://user:secret@cdn.orchard-lane.example:8443/deep/path.js?q=1#f", text: "first();", ranges: [{ startOffset: 0, endOffset: 8, count: 1 }] },
          { url: "data:text/javascript,second()", text: "second();", ranges: [] },
          { url: "not a url", text: "third();", ranges: [] }
        ],
        requests: [{ url: "wss://stream.orchard-lane.example/socket?id=2" }, { url: "http://[::1]:8080/x" }],
        storage: [{ key: "k", value: "v" }],
        console: []
      }
    );
    const planned = plannedState({ slots: [{ slot: "B1", attemptId: "1b".repeat(16) }], controlRunId: "c0".repeat(16), configuration: "alder" });
    const frozen = planned.ok ? step(planned.state, { type: "plan-frozen", planDigest: "aa".repeat(32), by: { kind: "owner" } }) : planned;
    const noLog = memoryStores();
    await createLog(noLog);
    const empty = await openCase(noLog, mintCaseId());
    const refusedByActor = empty.ok ? await runCommand(noLog, empty.case, { actor, event: { type: "plan-frozen", data: { planDigest: "aa".repeat(32) } }, now: () => 1793534401000 }) : empty;
    const place = { attempt: "x", target: "t", frame: "f", loader: "l", script: { scriptId: "s", url: null, resourceStart: { line: 0, column: 0 }, digest: null } };
    const join = readExecutionJoin(
      { ...place, line: 2, column: 3, time: { clock: "page", ms: 5 } },
      { ...place, start: { line: 1, column: 0 }, end: { line: 2, column: 0 }, window: { clock: "page", startMs: 0, endMs: 9, uncertaintyMs: null } },
      { attempt: "x", scripts: [place.script] }
    );

    return Response.json({
      canonical: new TextDecoder().decode(canonicalBytes({ b: "\u{1f600}", a: "é" }) as Uint8Array),
      lone: canonicalBytes("\ud83d") === null,
      evidence: put.digest,
      digest: first.digest,
      stale: stale.ok ? "committed" : stale.refusal,
      clean,
      otherCase,
      afterEdit,
      afterChange,
      summary,
      machine: frozen.ok ? frozen.state.planDigest : frozen.refusal,
      mintedShape: /^[0-9a-f]{32}$/.test(mintCaseId()),
      refusedByActor: refusedByActor.ok ? "committed" : refusedByActor.refusal,
      join
    });
  }
};
