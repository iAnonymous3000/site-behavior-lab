import { putEvidence } from "../core/case-log";
import { CASES_BINDING, hostWorld, OBJECTS_BINDING, type HostWorld } from "./case-host-fixture";
import { actorsFor, CASE_SCRIPT, logEvent, risingClock, runScript, type ScriptCommand } from "./case-fixture";
import { memoryStores } from "./memory-log-store";
import { ownerActorAt } from "./viewer-fixture";

/**
 * A measurement, not a suite: what one open of a hosted case costs on local workerd as the
 * case grows, by wall clock from this process. Run by hand, after a compile:
 *
 *   node .investigation-test-dist/investigation/test/case-host-open-cost.js
 *
 * Each case is built in this process by the real store, on the fixture's script with extra
 * rows, then placed in the local bucket under its prefix with its head set through the test
 * entry's own call. The host then opens it as it opens any case: it walks every entry from the
 * bucket and reads and hashes every object every entry names. Nothing here deploys, and no
 * number it prints is a measurement of the hosted service.
 */

const ENTRY = "investigation/test/workerd-case-host-entry.ts";
const MIB = 1024 * 1024;

type Shape = Readonly<{ label: string; rows: number; objectBytes: number; distinctObjects: boolean }>;

const SHAPES: readonly Shape[] = [
  { label: "the fixture's opening stretch, no extra row", rows: 0, objectBytes: 0, distinctObjects: false },
  { label: "250 rows naming one 1 KiB object", rows: 250, objectBytes: 1024, distinctObjects: false },
  { label: "1000 rows naming one 1 KiB object", rows: 1000, objectBytes: 1024, distinctObjects: false },
  { label: "1 row naming a 32 MiB object", rows: 1, objectBytes: 32 * MIB, distinctObjects: true },
  { label: "4 rows, each its own 32 MiB object", rows: 4, objectBytes: 32 * MIB, distinctObjects: true },
  { label: "8 rows, each its own 32 MiB object", rows: 8, objectBytes: 32 * MIB, distinctObjects: true }
];

function objectOf(bytes: number, index: number): Uint8Array {
  const object = new Uint8Array(bytes);
  // Not all zeros, and different for each index, so each is its own object at its own digest.
  for (let at = 0; at < bytes; at += 4096) object[at] = (at / 4096 + index) & 0xff;
  if (bytes > 0) object[0] = index & 0xff;
  return object;
}

async function place(world: HostWorld, caseId: string, shape: Shape): Promise<Readonly<{ entries: number; evidenceBytes: number }>> {
  const stores = memoryStores();
  const nowMs = Date.now();
  const owner = await ownerActorAt(world.signing, nowMs);
  const opening = CASE_SCRIPT.findIndex(({ event }) => event.type === "evidence-recorded" && (event.data.row as { id: string }).id === "row-b1-network");
  const rows: ScriptCommand[] = [];
  let hashed = 0;
  for (let index = 0; index < shape.rows; index += 1) {
    const put = await putEvidence(stores, objectOf(shape.objectBytes, shape.distinctObjects ? index : 0));
    if (!put.ok) throw new Error(`An object was refused: ${put.refusal}`);
    hashed += shape.objectBytes;
    rows.push({ as: "B1", event: logEvent("evidence-recorded", { row: { id: `row-b1-extra-${index}`, slot: "B1", instrument: "inspect", state: "present", window: { clock: "harness", startMs: 60, endMs: 880 }, limits: ["main-frame-only"], digest: put.digest, observation: null } }) });
  }
  await runScript({ stores, caseId, actorOf: actorsFor(owner), now: risingClock(nowMs - 3_600_000), commands: [...CASE_SCRIPT.slice(0, opening + 1), ...rows] });
  const bucket = await world.miniflare.getR2Bucket(OBJECTS_BINDING);
  for (const [digest, bytes] of stores.entries.objects) await bucket.put(`cases/${caseId}/entries/${digest}`, bytes);
  for (const [digest, bytes] of stores.evidence.objects) await bucket.put(`cases/${caseId}/evidence/${digest}`, bytes);
  const seeded = await world.direct(CASES_BINDING, caseId, { call: "test-seed-head", head: stores.head.value });
  if (seeded.answer.ok !== true) throw new Error("The head was not set");
  return { entries: stores.entries.objects.size, evidenceBytes: hashed };
}

async function timed(run: () => Promise<Readonly<{ answer: Record<string, unknown> }>>): Promise<number> {
  const started = performance.now();
  const { answer } = await run();
  const elapsed = performance.now() - started;
  if (answer.ok !== true) throw new Error(`The call was refused: ${JSON.stringify(answer).slice(0, 200)}`);
  return elapsed;
}

async function main(): Promise<void> {
  const world = await hostWorld(ENTRY, "workerd-case-host-entry.js");
  try {
    const results: Record<string, unknown>[] = [];
    for (const [index, shape] of SHAPES.entries()) {
      const caseId = (index + 1).toString(16).padStart(32, "0");
      const placed = await place(world, caseId, shape);
      const open = () => world.direct(CASES_BINDING, caseId, { call: "open", assertion: world.ownerToken, caseId });
      // The first call starts the object and may fetch the team's keys, so it is timed apart.
      const first = await timed(open);
      const opens: number[] = [];
      for (let run = 0; run < 5; run += 1) opens.push(await timed(open));
      opens.sort((left, right) => left - right);
      results.push({ shape: shape.label, entries: placed.entries, evidenceMiBHashedPerOpen: placed.evidenceBytes / MIB, firstOpenMs: Math.round(first), openMsMin: Math.round(opens[0]), openMsMedian: Math.round(opens[2]), openMsMax: Math.round(opens[4]) });
    }
    console.log(JSON.stringify({ node: process.version, measuredAt: new Date().toISOString(), results }, null, 2));
  } finally {
    await world.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
