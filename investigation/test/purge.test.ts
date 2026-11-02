import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as machine from "../core/case-machine";
import { retentionOf, step, type MachineEvent, type MachineState } from "../core/case-machine";
import * as production from "../core/purge";
import { purgeStep, retentionTier, type PathState, type PurgeEvent, type PurgeManifest } from "../core/purge";
import { captureOf, confirmOf, controlMet, driven, finishOf, frozen, OWNER, planOf, runnerOf, startOf } from "./case-fixture";

/**
 * What the raw tier still holds, as a read. No purge route exists yet, so this is the rule
 * alone, and nothing here deletes anything. The domain is what the plan names: up to three
 * paths, each read as absent or as remaining, in every order to a stated depth, against a
 * plain map kept here.
 */

type PurgeModule = typeof production;
const variant = (...edits: SourceEdit[]) => loadVariant<PurgeModule>(require.resolve("../core/purge"), edits);

const PATH_ONE = "01".repeat(32);
const PATH_TWO = "02".repeat(32);
const PATH_THREE = "03".repeat(32);
const NOT_LISTED = "0f".repeat(32);

const SUMMARY = "SUMMARY_ONLY holds only with a manifest and every path on it absent, and an empty manifest has none that is not";

/** Every assignment of every length, so the read is held to the whole table and not to the paths a walk happened to reach. */
const checkEveryManifest = (module: PurgeModule) => {
  const states: readonly PathState[] = ["present", "absent", "remains"];
  let summaryOnly = 0;
  let total = 0;
  const paths = [PATH_ONE, PATH_TWO, PATH_THREE];
  const visit = (prefix: PurgeManifest, left: number): void => {
    const expected = prefix.every(({ state }) => state === "absent");
    const tier = module.retentionTier(prefix);
    holds(SUMMARY, tier === (expected ? "SUMMARY_ONLY" : "RAW_HELD"), () => ({ prefix, tier }));
    total += 1;
    if (expected) summaryOnly += 1;
    if (left === 0) return;
    for (const state of states) visit([...prefix, { path: paths[paths.length - left], state }], left - 1);
  };
  visit([], 3);
  // 1 + 3 + 9 + 27 manifests, and exactly one per length is all absent, the empty one among them.
  holds(SUMMARY, total === 40 && summaryOnly === 4, () => ({ total, summaryOnly }));
  // No manifest is not an empty one: nothing was listed, so nothing is known to be gone.
  holds(SUMMARY, module.retentionTier(null) === "RAW_HELD", () => "no manifest");
};

test("SUMMARY_ONLY, over every manifest of up to three paths", async () => {
  checkEveryManifest(production);
  assert.equal(retentionTier(null), "RAW_HELD");
  assert.equal(retentionTier([]), "SUMMARY_ONLY");
  await assertCaughtBy("a remaining path treated as purged", SUMMARY, () => checkEveryManifest(variant({ find: 'entry.state === "absent"', replace: 'entry.state !== "present"' })));
  await assertCaughtBy("an unchecked path treated as purged", SUMMARY, () => checkEveryManifest(variant({ find: 'entry.state === "absent"', replace: 'entry.state !== "remains"' })));
  await assertCaughtBy("one path absent being enough", SUMMARY, () => checkEveryManifest(variant({ find: "manifest.every((entry)", replace: "manifest.some((entry)" })));
  await assertCaughtBy("no manifest reading as purged", SUMMARY, () => checkEveryManifest(variant({ find: 'if (manifest === null)\n        return "RAW_HELD";', replace: 'if (manifest === null)\n        return "SUMMARY_ONLY";' })));
  await assertCaughtBy("an empty manifest reading as still held", SUMMARY, () => checkEveryManifest(variant({ find: 'if (manifest === null)\n        return "RAW_HELD";', replace: 'if (manifest === null || manifest.length === 0)\n        return "RAW_HELD";' })));
});

const WALK = "every order of purge events matches a plain map of what each path last read as";

const EVENTS: readonly PurgeEvent[] = [
  { type: "purge-manifest-recorded", paths: [PATH_ONE, PATH_TWO, PATH_THREE] },
  { type: "purge-manifest-recorded", paths: [] },
  { type: "purge-path-absent", path: PATH_ONE },
  { type: "purge-path-absent", path: PATH_TWO },
  { type: "purge-path-absent", path: PATH_THREE },
  { type: "purge-path-remains", path: PATH_ONE },
  { type: "purge-path-remains", path: PATH_TWO },
  { type: "purge-path-absent", path: NOT_LISTED },
  { type: "purge-path-remains", path: NOT_LISTED }
];

type Model = Map<string, PathState> | null;

/** The plain model: no manifest, or a map of each listed path to what it last read as. */
function expect(model: Model, event: PurgeEvent, closed: boolean): Readonly<{ refusal: string }> | Readonly<{ next: Model }> {
  if (!closed) return { refusal: "case-open" };
  if (event.type === "purge-manifest-recorded") {
    if (model !== null) return { refusal: "manifest-already-recorded" };
    return { next: new Map(event.paths.map((name) => [name, "present"])) };
  }
  if (model === null || !model.has(event.path)) return { refusal: "no-such-path" };
  const state = event.type === "purge-path-absent" ? "absent" : "remains";
  if (model.get(event.path) === state) return { refusal: "path-status-unchanged" };
  return { next: new Map(model).set(event.path, state) };
}

const checkWalk = (module: PurgeModule, depth: number, closed = true): number => {
  let pairs = 0;
  const descend = (manifest: PurgeManifest | null, model: Model, left: number): void => {
    if (left === 0) return;
    for (const event of EVENTS) {
      pairs += 1;
      const answer = module.purgeStep(closed, manifest, event);
      const expected = expect(model, event, closed);
      if ("refusal" in expected) {
        holds(WALK, !answer.ok && answer.refusal === expected.refusal, () => ({ manifest, event, answer }));
        continue;
      }
      holds(WALK, answer.ok, () => ({ manifest, event, answer }));
      if (!answer.ok) continue;
      const nextModel = expected.next as Map<string, PathState>;
      holds(WALK, answer.manifest.length === nextModel.size && answer.manifest.every(({ path: name, state }) => nextModel.get(name) === state), () => ({ manifest, event, answer }));
      // The tier follows the listing, including when a path reads as back.
      const tier = module.retentionTier(answer.manifest);
      const allGone = [...nextModel.values()].every((state) => state === "absent");
      holds(WALK, tier === (allGone ? "SUMMARY_ONLY" : "RAW_HELD"), () => ({ answer, tier }));
      descend(answer.manifest, nextModel, left - 1);
    }
  };
  descend(null, null, depth);
  return pairs;
};

test("every order of purge events to depth 7, against a plain map", () => {
  // Eight tried at each node. Past the manifest a path moves only to a state it is not in, so the fan is what that leaves.
  assert.equal(checkWalk(production, 7), PURGE_WALK_PAIRS);
});

const PURGE_WALK_PAIRS = 6192;

test("a manifest is declared once, of distinct paths, and only a closed case has one", async () => {
  const closedOnly = (module: PurgeModule) => {
    for (const event of EVENTS) {
      const answer = module.purgeStep(false, [{ path: PATH_ONE, state: "present" }], event);
      holds(WALK, !answer.ok && answer.refusal === "case-open", () => ({ event, answer }));
    }
  };
  closedOnly(production);
  await assertCaughtBy("purging an open case", WALK, () => closedOnly(variant({ find: 'if (!closed)\n        return { ok: false, refusal: "case-open" };', replace: "" })));

  const malformed = "a manifest holds each path once, and whether it should list them is the fold's to say";
  const checkShape = (module: PurgeModule) => {
    for (const paths of [[PATH_ONE, PATH_ONE], [PATH_ONE, PATH_TWO, PATH_ONE]]) {
      const answer = module.purgeStep(true, null, { type: "purge-manifest-recorded", paths });
      holds(malformed, !answer.ok && answer.refusal === "manifest-malformed", () => ({ paths, answer }));
    }
    holds(malformed, module.purgeStep(true, null, { type: "purge-manifest-recorded", paths: [PATH_ONE, PATH_TWO] }).ok, () => "two distinct paths");
    // An empty one is a manifest: the path events find nothing on it, and a second is refused like any other.
    const empty = module.purgeStep(true, null, { type: "purge-manifest-recorded", paths: [] });
    holds(malformed, JSON.stringify(empty) === '{"ok":true,"manifest":[]}', () => empty);
    const again = module.purgeStep(true, [], { type: "purge-manifest-recorded", paths: [PATH_ONE] });
    holds(malformed, !again.ok && again.refusal === "manifest-already-recorded", () => again);
    const none = module.purgeStep(true, [], { type: "purge-path-absent", path: PATH_ONE });
    holds(malformed, !none.ok && none.refusal === "no-such-path", () => none);
  };
  checkShape(production);
  await assertCaughtBy("an empty manifest refused", malformed, () => checkShape(variant({ find: "if (new Set(event.paths).size !== event.paths.length)", replace: "if (event.paths.length === 0 || new Set(event.paths).size !== event.paths.length)" })));
  await assertCaughtBy("a repeated path accepted", malformed, () => checkShape(variant({ find: 'if (new Set(event.paths).size !== event.paths.length)\n                return { ok: false, refusal: "manifest-malformed" };', replace: "" })));
  await assertCaughtBy("an empty manifest taken as none, so a second can follow", malformed, () => checkShape(variant({ find: "if (manifest !== null)\n                return", replace: "if (manifest !== null && manifest.length > 0)\n                return" })));
});

for (const [name, depth, edits] of [
  ["a manifest recorded twice", 2, [{ find: 'if (manifest !== null)\n                return { ok: false, refusal: "manifest-already-recorded" };', replace: "" }]],
  ["a path not on the manifest accepted", 2, [{ find: 'if (entry === undefined)\n        return { ok: false, refusal: "no-such-path" };', replace: "if (entry === undefined)\n        return { ok: true, manifest };" }]],
  ["a repeat of a path's status accepted", 3, [{ find: 'if (entry.state === state)\n        return { ok: false, refusal: "path-status-unchanged" };', replace: "" }]],
  ["absent and remains swapped", 2, [{ find: 'return withPath(manifest, event.path, "remains");', replace: 'return withPath(manifest, event.path, "absent");' }]],
  ["absent changing every path", 3, [{ find: "candidate.path === path ? { path, state } : candidate", replace: "({ path: candidate.path, state })" }]],
  ["absent for good", 4, [{ find: "candidate.path === path ? { path, state } : candidate", replace: 'candidate.path === path ? { path, state: candidate.state === "absent" ? "absent" : state } : candidate' }]],
  ["a path starting as absent", 1, [{ find: 'event.paths.map((path) => ({ path, state: "present" }))', replace: 'event.paths.map((path) => ({ path, state: "absent" }))' }]]
] as const) {
  test(`the walk catches ${name}`, async () => {
    await assertCaughtBy(name, WALK, () => checkWalk(variant(...(edits as readonly SourceEdit[])), depth));
  });
}

test("the reducer's signature is the closed flag, the manifest and the event, and its answer reads nothing else", () => {
  // The separate exploration rests on this, so widening it must fail here.
  assert.equal(purgeStep.length, 3);
  const source = readFileSync(path.join(process.cwd(), "investigation/core/purge.ts"), "utf8");
  const file = ts.createSourceFile("purge.ts", source, ts.ScriptTarget.Latest, true);
  let parameters: string[] | null = null;
  ts.forEachChild(file, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "purgeStep") parameters = node.parameters.map((parameter) => parameter.getText());
  });
  assert.deepEqual(parameters, ["closed: boolean", "manifest: PurgeManifest | null", "event: PurgeEvent"]);
  checkSlice(machine);
});

const SLICE = "a purge reads the closed flag and the manifest, and nothing else of a closed case";

/** Closed cases that differ in everything a purge could read, each closed its own way. */
const closedStates = (module: typeof machine): readonly (readonly [string, MachineState])[] => [
  ["cancelled before anything", driven(module, SLICE, planOf("B1", "I1"), { type: "case-cancelled", by: OWNER })],
  ["cancelled after a visit", driven(module, SLICE, planOf("B1", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"), confirmOf("B1"), { type: "case-cancelled", by: OWNER })],
  ["cancelled with cleanup open", driven(module, SLICE, planOf("B1", "I1"), frozen, controlMet(), startOf("B1"), { type: "case-cancelled", by: OWNER })],
  ["exploratory, on an exception", driven(module, SLICE, planOf("B1", "I1"), frozen, { type: "exception-recorded", slot: "B1", by: OWNER }, startOf("B1"), { type: "case-cancelled", by: OWNER })],
  ["completed", driven(module, SLICE, planOf("B1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"), confirmOf("B1"))],
  ["a case deadline", driven(module, SLICE, planOf("B1", "I1"), frozen, { type: "case-deadline", by: OWNER })],
  ["baseline not met", driven(module, SLICE, planOf("B1", "I1"), frozen, controlMet(), startOf("B1"), ...captureOf("B1"), finishOf("B1"), confirmOf("B1"), { type: "baseline-rule-recorded", result: "not_met", by: OWNER })]
];

const EVENT_LIST = [
  { type: "purge-path-absent", path: PATH_ONE },
  { type: "purge-manifest-recorded", paths: [PATH_ONE, PATH_TWO] },
  { type: "purge-manifest-recorded", paths: [PATH_THREE] },
  { type: "purge-path-absent", path: NOT_LISTED },
  { type: "purge-path-absent", path: PATH_ONE },
  { type: "purge-path-absent", path: PATH_ONE },
  { type: "purge-path-remains", path: PATH_ONE },
  { type: "purge-path-absent", path: PATH_TWO },
  { type: "purge-path-absent", path: PATH_ONE }
] as const;

/** What those events come to, spelled from the rule, on a closed case of any history. */
const SLICE_ANSWERS = [
  "no-such-path",
  [PATH_ONE, "present", PATH_TWO, "present"],
  "manifest-already-recorded",
  "no-such-path",
  [PATH_ONE, "absent", PATH_TWO, "present"],
  "path-status-unchanged",
  [PATH_ONE, "remains", PATH_TWO, "present"],
  [PATH_ONE, "remains", PATH_TWO, "absent"],
  [PATH_ONE, "absent", PATH_TWO, "absent"]
];

const checkSlice = (module: typeof machine) => {
  const closures = new Set<string>();
  const marks = new Set<boolean>();
  for (const [name, closed] of closedStates(module)) {
    holds(SLICE, closed.closedBy !== null, () => ({ name, closed }));
    closures.add(closed.closedBy as string);
    marks.add(closed.exploratory);
    let state = closed;
    EVENT_LIST.forEach((event, index) => {
      const answer = module.step(state, { ...event, by: OWNER } as MachineEvent);
      const seen = answer.ok ? (answer.state.purge as PurgeManifest).flatMap((entry) => [entry.path, entry.state]) : answer.refusal;
      holds(SLICE, JSON.stringify(seen) === JSON.stringify(SLICE_ANSWERS[index]), () => ({ name, index, event, seen }));
      if (!answer.ok) return;
      // Nothing but the manifest moved: not the mark, not the closure, not an attempt.
      holds(SLICE, JSON.stringify({ ...answer.state, purge: null }) === JSON.stringify({ ...closed, purge: null }), () => ({ name, index, state: answer.state }));
      state = answer.state;
    });
    holds(SLICE, module.retentionOf(state) === "SUMMARY_ONLY", () => ({ name, state }));
    // No manifest yet reads as held, however it closed, and an empty one as nothing held.
    holds(SLICE, module.retentionOf(closed) === "RAW_HELD", () => ({ name, closed }));
    const empty = module.step(closed, { type: "purge-manifest-recorded", paths: [], by: OWNER });
    holds(SLICE, empty.ok && module.retentionOf(empty.state) === "SUMMARY_ONLY", () => ({ name, empty }));
  }
  // The states really did differ: each closure, and both values of the mark.
  holds(SLICE, [...closures].sort().join() === "baseline_not_met,cancelled,completed,deadline", () => [...closures]);
  holds(SLICE, marks.size === 2, () => [...marks]);
};

test("a purge answers the same on every closed case, however it closed and whatever it held", async () => {
  checkSlice(machine);
  const broken = (...edits: SourceEdit[]) => () => checkSlice(loadVariant<typeof machine>(require.resolve("../core/case-machine"), edits));
  await assertCaughtBy("a purge needing a cancelled case", SLICE, broken({ find: "(0, purge_1.purgeStep)(state.closedBy !== null, state.purge, event)", replace: '(0, purge_1.purgeStep)(state.closedBy === "cancelled", state.purge, event)' }));
  await assertCaughtBy("a purge needing nothing pending", SLICE, broken({ find: "(0, purge_1.purgeStep)(state.closedBy !== null, state.purge, event)", replace: "(0, purge_1.purgeStep)(isTerminal(state), state.purge, event)" }));
  await assertCaughtBy("a purge refused on an exploratory case", SLICE, broken({ find: "(0, purge_1.purgeStep)(state.closedBy !== null, state.purge, event)", replace: "(0, purge_1.purgeStep)(state.closedBy !== null && !state.exploratory, state.purge, event)" }));
  await assertCaughtBy("a purge clearing the exploratory mark", SLICE, broken({ find: "accept(Object.assign(Object.assign({}, state), { purge: result.manifest }))", replace: "accept(Object.assign(Object.assign({}, state), { purge: result.manifest, exploratory: false }))" }));
});

test("through the machine a purge is the owner's: a variant that lets anyone is caught", async () => {
  const property = "a purge event is the owner's";
  const check = (module: typeof machine) => {
    const closedState = driven(module, property, planOf("B1"), { type: "case-cancelled", by: OWNER });
    const answer = module.step(closedState, { type: "purge-manifest-recorded", paths: [PATH_ONE, PATH_TWO], by: runnerOf("B1") });
    holds(property, !answer.ok && answer.refusal === "owner-only", () => answer);
  };
  check(machine);
  const variantMachine = loadVariant<typeof machine>(require.resolve("../core/case-machine"), [{ find: 'function purgeEvent(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: "function purgeEvent(state, event) {" }]);
  await assertCaughtBy("a purge from anyone", property, () => check(variantMachine));
  const closedFlag = loadVariant<typeof machine>(require.resolve("../core/case-machine"), [{ find: "(0, purge_1.purgeStep)(state.closedBy !== null, state.purge, event)", replace: "(0, purge_1.purgeStep)(true, state.purge, event)" }]);
  const open = driven(closedFlag, "the path runs", planOf("B1"), frozen);
  assert.deepEqual(step(driven(machine, "the path runs", planOf("B1"), frozen), { type: "purge-manifest-recorded", paths: [PATH_ONE], by: OWNER }), { ok: false, refusal: "case-open" });
  assert.equal(closedFlag.step(open, { type: "purge-manifest-recorded", paths: [PATH_ONE], by: OWNER }).ok, true, "this is what that test holds off");
});

test("through the machine a purge is the owner's, needs a closed case, and leaves evidence and attempts alone", () => {
  const open = driven(machine, "the path runs", planOf("B1", "I1"), frozen, controlMet(), startOf("B1"), { type: "evidence-recorded", slot: "B1", id: "row-kept", by: runnerOf("B1") });
  const manifest: MachineEvent = { type: "purge-manifest-recorded", paths: [PATH_ONE, PATH_TWO], by: OWNER };
  const asked = step(open, manifest);
  assert.deepEqual(asked, { ok: false, refusal: "case-open" });
  const closedAnswer = step(open, { type: "case-cancelled", by: OWNER });
  assert.ok(closedAnswer.ok);
  const closed = closedAnswer.state;
  assert.deepEqual(step(closed, { ...manifest, by: runnerOf("B1") }), { ok: false, refusal: "owner-only" });
  const listed = step(closed, manifest);
  assert.ok(listed.ok);
  const firstGone = step(listed.state, { type: "purge-path-absent", path: PATH_ONE, by: OWNER });
  assert.ok(firstGone.ok);
  const stillThere = retentionOf(firstGone.state);
  assert.equal(stillThere, "RAW_HELD", "one of two paths gone is not all of them");
  const secondGone = step(firstGone.state, { type: "purge-path-absent", path: PATH_TWO, by: OWNER });
  assert.ok(secondGone.ok);
  assert.equal(retentionOf(secondGone.state), "SUMMARY_ONLY");
  assert.deepEqual(step(secondGone.state, { type: "purge-path-absent", path: PATH_TWO, by: OWNER }), { ok: false, refusal: "path-status-unchanged" }, "a repeat of a status has nothing to say, so no event leaves a state where it was");
  assert.deepEqual(secondGone.state.attempts, closed.attempts, "purging touches no attempt and no evidence id");
  assert.deepEqual(secondGone.state.attempts[0].evidence, ["row-kept"]);
  assert.deepEqual(step(secondGone.state, { type: "purge-path-remains", path: NOT_LISTED, by: OWNER }), { ok: false, refusal: "no-such-path" });
  const back = step(secondGone.state, { type: "purge-path-remains", path: PATH_ONE, by: OWNER });
  assert.ok(back.ok);
  assert.equal(retentionOf(back.state), "RAW_HELD", "a later listing that finds it takes SUMMARY_ONLY back");
  // What remains: a path can read absent, remains and absent again, so a purge state can return. Only the capture events cannot.
  const again = step(back.state, { type: "purge-path-absent", path: PATH_ONE, by: OWNER });
  assert.ok(again.ok);
  assert.deepEqual(again.state, secondGone.state);
});

