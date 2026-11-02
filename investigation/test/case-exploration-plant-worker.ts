import { parentPort, workerData } from "node:worker_threads";
import type { Answer, Job } from "./case-exploration-worker";

/**
 * The suite's worker with one fault planted, for the self-tests in case-exploration.test.ts that
 * hold the pool and the range checks to failing on it, quickly and with a message that names it.
 * workerData.plant picks the fault: "empty" answers every job with its id alone; "wrong-id" answers
 * under another job's id; "stray" sends an empty answer before each real one; "short" checks every
 * range one state short; "exit" ends the thread, with no error, on its first range; "forge" answers
 * every range after the first as fully checked without checking it; "shared-write" overwrites every
 * range after the first, in shared memory, with state 0's key and shadow, and then checks it
 * honestly. It installs the fault and then loads the real worker, unchanged.
 */

const port = parentPort;
if (port === null) throw new Error("case-exploration-plant-worker runs only as a worker thread");
const plant = (workerData as Readonly<{ plant?: string }> | null)?.plant;
const send = port.postMessage.bind(port);

if (plant === "empty") {
  port.postMessage = (answer: Answer) => send({ id: answer.id });
} else if (plant === "wrong-id") {
  port.postMessage = (answer: Answer) => send({ ...answer, id: answer.id + 1000 });
} else if (plant === "stray") {
  port.postMessage = (answer: Answer) => {
    send({ id: answer.id, value: null });
    send(answer);
  };
} else if (plant === "short") {
  // The worker reads checkMachineRange off the module at each call, so this stands in for it there.
  const walk = require("./case-exploration-walk") as { checkMachineRange: (typeof import("./case-exploration-walk"))["checkMachineRange"] };
  const whole = walk.checkMachineRange;
  walk.checkMachineRange = (p, keyAt, shadowAt, from, to) => whole(p, keyAt, shadowAt, from, Math.max(from, to - 1));
} else if (plant === "forge") {
  const walk = require("./case-exploration-walk") as { checkMachineRange: (typeof import("./case-exploration-walk"))["checkMachineRange"] };
  const honest = walk.checkMachineRange;
  // The count forged as whole, and no digest, since nothing was read.
  walk.checkMachineRange = (p, keyAt, shadowAt, from, to) => (from === 0 ? honest(p, keyAt, shadowAt, from, to) : ({ checked: to - from, failure: null } as ReturnType<typeof honest>));
} else if (plant === "shared-write") {
  // Registered before the real worker's listener, so the range is written over before it is read.
  port.on("message", (job: Job) => {
    if (job.kind !== "machine-range" || job.from === 0) return;
    const codes = new Uint16Array(job.keys);
    const packed = new Uint16Array(job.shadows);
    for (let index = job.from; index < job.to; index += 1) {
      codes.copyWithin(index * job.width, 0, job.width);
      packed[index] = packed[0];
    }
  });
} else if (plant === "exit") {
  // Registered before the real worker's listener, so it runs first and the job is never answered.
  port.on("message", (job: Job) => {
    if (job.kind === "machine-range") process.exit(0);
  });
} else {
  throw new Error(`case-exploration-plant-worker has no plant named ${String(plant)}`);
}

require("./case-exploration-worker");
