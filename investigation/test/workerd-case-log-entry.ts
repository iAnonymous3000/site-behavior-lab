import { runnerActorFrom, type Actor } from "../core/actor";
import { appendCommand, createLog, openLog, putEvidence, type LogStores } from "../core/case-log";
import { canonicalBytes } from "../core/canonical-json";
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

    return Response.json({
      canonical: new TextDecoder().decode(canonicalBytes({ b: "\u{1f600}", a: "é" }) as Uint8Array),
      lone: canonicalBytes("\ud83d") === null,
      evidence: put.digest,
      digest: first.digest,
      stale: stale.ok ? "committed" : stale.refusal,
      clean,
      otherCase,
      afterEdit,
      afterChange
    });
  }
};
