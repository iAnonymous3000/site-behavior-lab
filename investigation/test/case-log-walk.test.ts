import assert from "node:assert/strict";
import { before, test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import { runnerActorFrom, type Actor, type OwnerActor } from "../core/actor";
import * as productionLog from "../core/case-log";
import type { LogEvent, LogStores } from "../core/case-log";
import {
  ANOTHER_DIGEST,
  ATTEMPT_ONE,
  CASE_A,
  decode,
  encode,
  eventsTextOf,
  GENESIS,
  handEntryText,
  OWNER_ACTOR_TEXT,
  runnerActorText,
  sha256OfText,
  verifiedOwnerActor
} from "./log-fixture";
import * as productionMemory from "./memory-log-store";
import { copyOfStores, type MemoryStores } from "./memory-log-store";
import { NOW_MS } from "./token-fixture";

/**
 * Every order of a small set of commands, conflicts and crashes, held to a plain
 * model kept here. The model is a list of hand-written entry texts hashed with
 * node:crypto, so it shares nothing with the module it checks. After every prefix the
 * log is reopened from what was stored, and must be exactly the model.
 *
 * A crash here is a store operation that never returns, the in-memory form of a
 * process dying between two steps. The real SIGKILL is in fs-log-store-kill.test.ts.
 */

type LogModule = typeof productionLog;
type MemoryModule = typeof productionMemory;

const logVariant = (...edits: SourceEdit[]) => loadVariant<LogModule>(require.resolve("../core/case-log"), edits);
const memoryVariant = (...edits: SourceEdit[]) => loadVariant<MemoryModule>(require.resolve("./memory-log-store"), edits);

let owner: OwnerActor;
const runner = runnerActorFrom(ATTEMPT_ONE) as Actor;

before(async () => {
  owner = await verifiedOwnerActor();
});

const event = (type: string): LogEvent => ({ type, data: {} });

class Crash extends Error {}

type When = "before" | "after";
type Step = Readonly<{ operation: string; when: When }>;

/** The stores with every operation reported, before it runs and after it has taken effect. */
function observed(stores: MemoryStores, hook: (step: Step) => void | Promise<void>): LogStores {
  const around = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
    await hook({ operation, when: "before" });
    const result = await run();
    await hook({ operation, when: "after" });
    return result;
  };
  return {
    entries: {
      createOnly: (address, bytes) => around("entries.createOnly", () => stores.entries.createOnly(address, bytes)),
      read: (address, maxBytes) => around("entries.read", () => stores.entries.read(address, maxBytes))
    },
    evidence: {
      createOnly: (address, bytes) => around("evidence.createOnly", () => stores.evidence.createOnly(address, bytes)),
      read: (address, maxBytes) => around("evidence.read", () => stores.evidence.read(address, maxBytes))
    },
    head: {
      read: (maxChars) => around("head.read", () => stores.head.read(maxChars)),
      compareAndSwap: (expected, next) => around("head.compareAndSwap", () => stores.head.compareAndSwap(expected, next))
    }
  };
}

const crashAt = (operation: string, when: When) => (step: Step) => {
  if (step.operation === operation && step.when === when) throw new Crash(`${operation} ${when}`);
};

type ModelEntry = Readonly<{ text: string; digest: string }>;
type Model = readonly ModelEntry[];

const headOf = (model: Model): string => (model.length === 0 ? GENESIS : model[model.length - 1].digest);

function extended(model: Model, actorText: string, type: string, atMs: number, evidence: readonly string[] = []): Model {
  const text = handEntryText({ actorText, atMs, eventsText: eventsTextOf(type), evidence, prev: headOf(model), seq: model.length + 1 });
  return [...model, { text, digest: sha256OfText(text) }];
}

/** Reopen from what is stored, as a fresh process would, and compare it with the model, byte for byte. */
async function holdsToModel(module: LogModule, stores: MemoryStores, model: Model, input: () => unknown): Promise<void> {
  const property = "the state after reopen equals the model";
  const opened = await module.openLog(copyOfStores(stores), CASE_A);
  holds(property, opened.ok, () => ({ path: input(), opened }));
  assert.ok(opened.ok);
  holds(property, opened.log.head === headOf(model), () => ({ path: input(), head: opened.log.head, expected: headOf(model) }));
  holds(property, opened.log.entries.length === model.length, () => ({ path: input(), entries: opened.log.entries.length, expected: model.length }));
  for (const [index, { digest, text }] of model.entries()) {
    const stored = stores.entries.objects.get(digest);
    holds(property, stored !== undefined && decode(stored) === text, () => ({ path: input(), index, text }));
    holds(property, opened.log.entries[index].digest === digest, () => ({ path: input(), index }));
  }
}

const OPERATIONS = ["owner-appends", "runner-appends-with-evidence", "stale-writer", "lost-race", "crash-before-entry", "crash-after-entry", "crash-after-swap"] as const;
type Operation = (typeof OPERATIONS)[number];

type Walk = Readonly<{ log: LogModule; memory: MemoryModule; depth: number }>;

async function mustFail(run: () => Promise<unknown>, input: () => unknown): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Crash) return;
    throw error;
  }
  holds("a crash is not an answer", false, input);
}

/** One operation on these stores, and what the model says is true afterward. */
async function apply(module: LogModule, stores: MemoryStores, model: Model, operation: Operation, atMs: number, path: () => unknown): Promise<Model> {
  const now = () => atMs;
  const append = (via: LogStores, actor: Actor, type: string, expectedHead: string, evidence: readonly string[] = []) =>
    module.appendCommand(via, { caseId: CASE_A, actor, events: [event(type)], evidence, expectedHead, now });

  switch (operation) {
    case "owner-appends": {
      const result = await append(stores, owner, "by-owner", headOf(model));
      holds("a current writer's command commits", result.ok, () => ({ path: path(), result }));
      return extended(model, OWNER_ACTOR_TEXT, "by-owner", atMs);
    }
    case "runner-appends-with-evidence": {
      const objects = [`evidence at ${atMs}`, `more evidence at ${atMs}`];
      for (const text of objects) {
        const put = await module.putEvidence(stores, encode(text));
        holds("evidence is stored at the digest of its bytes", put.ok && put.digest === sha256OfText(text), () => ({ path: path(), put }));
      }
      const digests = objects.map(sha256OfText);
      const result = await append(stores, runner, "by-runner", headOf(model), digests);
      holds("a current writer's command commits", result.ok, () => ({ path: path(), result }));
      return extended(model, runnerActorText(ATTEMPT_ONE), "by-runner", atMs, digests);
    }
    case "stale-writer": {
      // The head before the newest entry, or one that never was when there is none.
      const stale = model.length === 0 ? ANOTHER_DIGEST : model.length === 1 ? GENESIS : model[model.length - 2].digest;
      const result = await append(stores, owner, "stale", stale);
      holds("a stale writer gets a typed conflict", !result.ok && result.refusal === "conflict", () => ({ path: path(), result }));
      return model;
    }
    case "lost-race": {
      // Another writer lands between this writer's entry and its swap. This writer's entry stays an orphan.
      let raced = false;
      const racing = observed(stores, async (step) => {
        if (!raced && step.operation === "head.compareAndSwap" && step.when === "before") {
          raced = true;
          const winner = await append(stores, runner, "race-winner", headOf(model));
          holds("the race's winner commits", winner.ok, () => ({ path: path(), winner }));
        }
      });
      const loser = await append(racing, owner, "race-loser", headOf(model));
      holds("a writer that loses the swap gets a typed conflict", !loser.ok && loser.refusal === "conflict", () => ({ path: path(), loser }));
      return extended(model, runnerActorText(ATTEMPT_ONE), "race-winner", atMs);
    }
    case "crash-before-entry":
      await mustFail(() => append(observed(stores, crashAt("entries.createOnly", "before")), owner, "crashed", headOf(model)), path);
      return model;
    case "crash-after-entry":
      await mustFail(() => append(observed(stores, crashAt("entries.createOnly", "after")), owner, "crashed", headOf(model)), path);
      return model;
    case "crash-after-swap":
      // The command happened, though its writer died before hearing so.
      await mustFail(() => append(observed(stores, crashAt("head.compareAndSwap", "after")), owner, "crashed-late", headOf(model)), path);
      return extended(model, OWNER_ACTOR_TEXT, "crashed-late", atMs);
  }
}

async function walk({ log, memory, depth }: Walk): Promise<number> {
  const root = memory.memoryStores();
  await log.createLog(root);
  await holdsToModel(log, root, [], () => "the empty log");
  let visited = 1;
  const descend = async (stores: MemoryStores, model: Model, path: readonly Operation[]): Promise<void> => {
    if (path.length === depth) return;
    for (const operation of OPERATIONS) {
      const next = path.concat(operation);
      // An independent copy, so each branch starts from the same stored state.
      const branch = memory.copyOfStores(stores);
      const nextModel = await apply(log, branch, model, operation, NOW_MS + path.length * 1000, () => next);
      await holdsToModel(log, branch, nextModel, () => next);
      visited += 1;
      await descend(branch, nextModel, next);
    }
  };
  await descend(root, [], []);
  return visited;
}

const nodesFor = (depth: number): number => Array.from({ length: depth + 1 }, (_, level) => OPERATIONS.length ** level).reduce((sum, count) => sum + count, 0);

test("every order of up to five commands, conflicts and crashes reopens to the model", async () => {
  const visited = await walk({ log: productionLog, memory: productionMemory, depth: 5 });
  assert.equal(visited, 19_608, "the walk covers the 7^1 to 7^5 orders and the empty log, and no fewer");
  assert.equal(nodesFor(5), 19_608);
});

for (const [name, property, edits] of [
  [
    "the swap before the entry, so a crash leaves the head naming nothing",
    "the state after reopen equals the model",
    [
      {
        find: 'if (!(await createVerified(stores.entries, digest, bytes)))\n        return refuse("object-collision", digest);\n    // The commit point. Everything before it is unreachable until this succeeds.\n    if (!(await stores.head.compareAndSwap(head, digest)))\n        return refuse("conflict");',
        replace: 'if (!(await stores.head.compareAndSwap(head, digest)))\n        return refuse("conflict");\n    if (!(await createVerified(stores.entries, digest, bytes)))\n        return refuse("object-collision", digest);'
      }
    ]
  ],
  [
    "the swap's outcome ignored",
    "a writer that loses the swap gets a typed conflict",
    [{ find: 'if (!(await stores.head.compareAndSwap(head, digest)))\n        return refuse("conflict");', replace: "await stores.head.compareAndSwap(head, digest);" }]
  ],
  [
    "the stale head check gone",
    "a stale writer gets a typed conflict",
    [{ find: 'if (head !== expectedHead)\n        return refuse("conflict");', replace: "" }]
  ],
  [
    "the sequence taken from a fixed start",
    "the state after reopen equals the model",
    [{ find: "seq: entries.length + 1,", replace: "seq: 1," }]
  ],
  [
    "each entry chained from genesis",
    "the state after reopen equals the model",
    [{ find: "prev: head, atMs: now()", replace: "prev: exports.GENESIS_HEAD, atMs: now()" }]
  ]
] as const) {
  test(`the walk catches ${name}`, async () => {
    await assertCaughtBy(name, property, () => walk({ log: logVariant(...edits), memory: productionMemory, depth: 3 }));
  });
}

test("the walk catches a store whose compare-and-swap does not compare", async () => {
  // A stale writer's early check still answers, so only the lost race can see this.
  await assertCaughtBy("the store's compare", "a writer that loses the swap gets a typed conflict", () =>
    walk({
      log: productionLog,
      memory: memoryVariant({ find: "if (this.value !== expected)\n            return false;", replace: "" }),
      depth: 3
    })
  );
});

// A crash at every step of one append, with the evidence it names, spelled out in order.

const APPEND_STEPS = [
  "evidence.createOnly",
  "evidence.createOnly",
  "head.read",
  "entries.read",
  "entries.read",
  "evidence.read",
  "evidence.read",
  "entries.createOnly",
  "head.compareAndSwap"
] as const;

const ATTEMPT_AT = NOW_MS + 5000;
const ATTEMPT_EVIDENCE = ["the attempt's evidence", "the attempt's other evidence"];

async function seededStores(module: LogModule): Promise<{ stores: MemoryStores; model: Model }> {
  const stores = productionMemory.memoryStores();
  await module.createLog(stores);
  await module.appendCommand(stores, { caseId: CASE_A, actor: owner, events: [event("first")], evidence: [], expectedHead: GENESIS, now: () => NOW_MS });
  const first = extended([], OWNER_ACTOR_TEXT, "first", NOW_MS);
  await module.appendCommand(stores, { caseId: CASE_A, actor: runner, events: [event("second")], evidence: [], expectedHead: headOf(first), now: () => NOW_MS + 1000 });
  return { stores, model: extended(first, runnerActorText(ATTEMPT_ONE), "second", NOW_MS + 1000) };
}

async function attempt(module: LogModule, via: LogStores, expectedHead: string): Promise<productionLog.AppendResult> {
  const digests: string[] = [];
  for (const text of ATTEMPT_EVIDENCE) {
    const put = await module.putEvidence(via, encode(text));
    assert.ok(put.ok);
    digests.push(put.digest);
  }
  return module.appendCommand(via, { caseId: CASE_A, actor: owner, events: [event("attempted")], evidence: digests, expectedHead, now: () => ATTEMPT_AT });
}

const checkEveryStep = async (module: LogModule) => {
  const { stores: seeded, model } = await seededStores(module);
  const after = extended(model, OWNER_ACTOR_TEXT, "attempted", ATTEMPT_AT, ATTEMPT_EVIDENCE.map(sha256OfText));

  // The clean run names the steps, and they are held to the order written above.
  const seen: string[] = [];
  const clean = copyOfStores(seeded);
  const result = await attempt(module, observed(clean, (step) => void (step.when === "before" && seen.push(step.operation))), headOf(model));
  holds("the clean run commits", result.ok, () => result);
  holds("an append's steps are the stated ones, in order, with the swap last", JSON.stringify(seen) === JSON.stringify(APPEND_STEPS), () => seen);
  await holdsToModel(module, clean, after, () => "the clean run");

  for (const [index, operation] of seen.entries()) {
    for (const when of ["before", "after"] as const) {
      const input = () => ({ index, operation, when });
      const stores = copyOfStores(seeded);
      let occurrence = -1;
      const crashing = observed(stores, (step) => {
        if (step.when === "before") occurrence += 1;
        if (occurrence === index && step.when === when) throw new Crash(`${index} ${when}`);
      });
      await mustFail(() => attempt(module, crashing, headOf(model)), input);

      // The command happened only if the swap itself took effect.
      const applied = operation === "head.compareAndSwap" && when === "after";
      await holdsToModel(module, stores, applied ? after : model, input);

      // The next try with the same page's head: it lands exactly once.
      const retry = await attempt(module, stores, headOf(model));
      if (applied) {
        holds("a command that happened is not applied twice", !retry.ok && retry.refusal === "conflict", () => ({ input: input(), retry }));
      } else {
        holds("the next try after a crash works", retry.ok, () => ({ input: input(), retry }));
      }
      await holdsToModel(module, stores, after, input);
    }
  }
};

test("a crash at every step of an append reopens to before or after, and the next try lands exactly once", async () => {
  await checkEveryStep(productionLog);
});

test("the crash walk catches the swap coming first, and an append that stops checking what it names", async () => {
  await assertCaughtBy("the swap first", "an append's steps are the stated ones, in order, with the swap last", () =>
    checkEveryStep(
      logVariant({
        find: 'if (!(await createVerified(stores.entries, digest, bytes)))\n        return refuse("object-collision", digest);\n    // The commit point. Everything before it is unreachable until this succeeds.\n    if (!(await stores.head.compareAndSwap(head, digest)))\n        return refuse("conflict");',
        replace: 'if (!(await stores.head.compareAndSwap(head, digest)))\n        return refuse("conflict");\n    if (!(await createVerified(stores.entries, digest, bytes)))\n        return refuse("object-collision", digest);'
      })
    )
  );
  await assertCaughtBy("the evidence check dropped from the append", "an append's steps are the stated ones, in order, with the swap last", () =>
    checkEveryStep(
      logVariant({
        find: "for (const digest of entry.evidence) {\n        const refusal = await checkEvidence(stores, digest);\n        if (refusal !== null)\n            return refusal;\n    }\n    const digest = await",
        replace: "const digest = await"
      })
    )
  );
});
