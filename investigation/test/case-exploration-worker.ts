import { parentPort } from "node:worker_threads";
import { Counterexample } from "../../lib/finite-check";
import { checkMachineRange, prepareMachine, sharedReaders, walkFoldSetup, walkMachineSetup, type FoldSetup, type MachineSetup } from "./case-exploration-walk";

/**
 * A worker thread for case-exploration.test.ts. It takes one job at a time and answers with what
 * the same function gives in the main thread: a range of the six-slot walk's states held to every
 * per-state property, or a whole small walk, a fold walk or a variant's. A counterexample comes
 * back as its property and input, and the suite raises it again under that name, so a variant
 * caught here is caught by name. Every answer carries its job's id and exactly one of a value, a
 * failure or an error; a clean range's value is the range, the count of states it checked and
 * their digest.
 */

export type Job =
  | Readonly<{ id: number; kind: "machine-range"; setup: MachineSetup; keys: SharedArrayBuffer; shadows: SharedArrayBuffer; width: number; from: number; to: number }>
  | Readonly<{ id: number; kind: "machine-walk"; setup: MachineSetup }>
  | Readonly<{ id: number; kind: "fold-walk"; setup: FoldSetup }>;

export type Answer = Readonly<{ id: number; value?: unknown; failure?: Readonly<{ index: number; property: string; input: unknown }>; error?: string }>;

const port = parentPort;
if (port === null) throw new Error("case-exploration-worker runs only as a worker thread");
const prepared = new Map<string, ReturnType<typeof prepareMachine>>();

port.on("message", (job: Job) => {
  let answer: Answer;
  try {
    if (job.kind === "machine-range") {
      const key = JSON.stringify(job.setup);
      let made = prepared.get(key);
      if (made === undefined) {
        made = prepareMachine(job.setup);
        prepared.set(key, made);
      }
      const { keyAt, shadowAt } = sharedReaders(job.keys, job.shadows, job.width);
      const result = checkMachineRange(made, keyAt, shadowAt, job.from, job.to);
      // A clean range says which range it was, how many of its states the loop held to every property, and the digest of those states.
      answer = result.failure === null ? { id: job.id, value: { from: job.from, to: job.to, checked: result.checked, digest: result.digest } } : { id: job.id, failure: result.failure };
    } else if (job.kind === "machine-walk") {
      answer = { id: job.id, value: walkMachineSetup(job.setup) };
    } else {
      answer = { id: job.id, value: walkFoldSetup(job.setup) };
    }
  } catch (error) {
    answer = error instanceof Counterexample ? { id: job.id, failure: { index: -1, property: error.property, input: error.input } } : { id: job.id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  try {
    port.postMessage(answer);
  } catch (error) {
    port.postMessage({ id: job.id, error: `the answer could not be sent: ${String(error)}` });
  }
});
