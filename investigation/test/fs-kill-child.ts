import * as nodeFs from "node:fs";
import path from "node:path";
import { loadVariant, type SourceEdit } from "../../lib/finite-check";
import { runnerActorFrom, type Actor } from "../core/actor";
import * as productionLog from "../core/case-log";
import * as productionStore from "../local/fs-log-store";
import type { FsOps } from "../local/fs-log-store";

/**
 * A real process doing a real append against the filesystem store, for
 * fs-log-store-kill.test.ts. It kills itself with SIGKILL at the step it is told, so
 * nothing runs after that point: no finally, no flush, no exit handler. The store has
 * no fault hook of its own. The kill lives in the file system calls handed to it, so
 * production code is what runs, and every call is a possible fault point.
 *
 * It prints each step it reaches, written straight to the descriptor, so the parent
 * can tell a kill at the intended step from a kill for any other reason.
 */

export type ChildPlan = Readonly<{
  scenario: "append" | "create" | "race" | "open";
  /** The step to die at, by index among the calls that change the disk. Null runs to the end and reports them. */
  killAt: number | null;
  when: "before" | "after" | "partial";
  caseId: string;
  /** For the race: how many commands this writer lands, and its attempt id. */
  commands?: number;
  writer?: string;
  /** Broken variants of production, for showing the parent's checks can fail. */
  logEdits?: readonly SourceEdit[];
  storeEdits?: readonly SourceEdit[];
  atMs: number;
  evidenceText: string;
  eventType: string;
}>;

const [root, planText] = process.argv.slice(2);
const plan = JSON.parse(planText) as ChildPlan;

const logModule = plan.logEdits === undefined ? productionLog : loadVariant<typeof productionLog>(require.resolve("../core/case-log"), plan.logEdits);
const storeModule = plan.storeEdits === undefined ? productionStore : loadVariant<typeof productionStore>(require.resolve("../local/fs-log-store"), plan.storeEdits);

const trace: string[] = [];
const descriptors = new Map<number, string>();
const label = (target: unknown): string => path.relative(root, String(target)).replace(/^tmp\/.*/, "tmp").replace(/[0-9a-f]{64}$/, "<digest>") || ".";

function report(line: string): void {
  nodeFs.writeSync(1, `${line}\n`);
}

function die(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL returned");
}

/** One call that changes the disk: dies before it or after it, if this is the chosen step. */
function step<T>(name: string, run: () => T): T {
  const index = trace.length;
  trace.push(name);
  if (plan.killAt === index && plan.when === "before") {
    report(`reached ${index} before ${name}`);
    die();
  }
  const result = run();
  if (plan.killAt === index && plan.when === "after") {
    report(`reached ${index} after ${name}`);
    die();
  }
  return result;
}

const ops: FsOps = {
  ...nodeFs,
  // A read opens with numeric flags and changes nothing, so it is no fault point. Dying
  // there is the same as dying before the next call that does change something.
  openSync: ((target: nodeFs.PathLike, flags: unknown, ...rest: never[]) => {
    if (typeof flags === "number") return nodeFs.openSync(target, flags);
    const handle = step(`open ${label(target)}`, () => (nodeFs.openSync as (...args: unknown[]) => number)(target, flags, ...rest));
    descriptors.set(handle, label(target));
    return handle;
  }) as FsOps["openSync"],
  writeSync: ((handle: number, buffer: Uint8Array, offset: number) => {
    const index = trace.length;
    if (plan.killAt === index && plan.when === "partial") {
      // Half the bytes reach the file, and the process dies in the middle of the write.
      const half = Math.floor((buffer.length - offset) / 2);
      nodeFs.writeSync(handle, buffer, offset, half);
      trace.push(`write ${descriptors.get(handle)}`);
      report(`reached ${index} partial write ${descriptors.get(handle)}`);
      die();
    }
    return step(`write ${descriptors.get(handle)}`, () => nodeFs.writeSync(handle, buffer, offset));
  }) as FsOps["writeSync"],
  fsyncSync: (handle) => step(`fsync ${descriptors.get(handle)}`, () => nodeFs.fsyncSync(handle)),
  closeSync: (handle) => {
    // A descriptor's number comes back after a close, so a read must not inherit a write's label.
    const name = descriptors.get(handle);
    descriptors.delete(handle);
    if (name !== undefined) step(`close ${name}`, () => nodeFs.closeSync(handle));
    else nodeFs.closeSync(handle);
  },
  linkSync: (from, to) => step(`link ${label(from)} ${label(to)}`, () => nodeFs.linkSync(from, to)),
  unlinkSync: (target) => step(`unlink ${label(target)}`, () => nodeFs.unlinkSync(target))
};

async function main(): Promise<void> {
  const stores = storeModule.fsLogStores(root, ops);
  const actor = runnerActorFrom(plan.writer ?? "a1".repeat(16)) as Actor;
  const { caseId } = plan;

  if (plan.scenario === "open") {
    report(JSON.stringify(await logModule.openLog(stores, caseId)));
    return;
  }

  if (plan.scenario === "create") {
    const created = await logModule.createLog(stores);
    report(JSON.stringify({ trace, created }));
    return;
  }

  if (plan.scenario === "race") {
    let conflicts = 0;
    for (let command = 0; command < (plan.commands ?? 0); ) {
      const opened = await logModule.openLog(stores, caseId);
      if (!opened.ok) throw new Error(`The log would not open: ${opened.refusal}`);
      const result = await logModule.appendCommand(stores, {
        caseId,
        actor,
        events: [{ type: plan.eventType, data: { command, writer: plan.writer ?? "" } }],
        evidence: [],
        expectedHead: opened.log.head,
        now: () => plan.atMs
      });
      if (result.ok) command += 1;
      else if (result.refusal === "conflict") conflicts += 1;
      else throw new Error(`The append was refused: ${result.refusal}`);
    }
    report(JSON.stringify({ conflicts }));
    return;
  }

  const put = await logModule.putEvidence(stores, new TextEncoder().encode(plan.evidenceText));
  if (!put.ok) throw new Error(`The evidence was refused: ${put.refusal}`);
  const opened = await logModule.openLog(stores, caseId);
  if (!opened.ok) throw new Error(`The log would not open: ${opened.refusal}`);
  const result = await logModule.appendCommand(stores, {
    caseId,
    actor,
    events: [{ type: plan.eventType, data: {} }],
    evidence: [put.digest],
    expectedHead: opened.log.head,
    now: () => plan.atMs
  });
  report(JSON.stringify({ trace, result }));
}

main().catch((error: unknown) => {
  nodeFs.writeSync(2, `${String(error)}\n`);
  process.exitCode = 1;
});
