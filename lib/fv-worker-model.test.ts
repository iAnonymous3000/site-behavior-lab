import assert from "node:assert/strict";
import { test } from "node:test";
import { DedicatedWorkerAttachSession } from "./devtools-worker-channel";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";
import {
  ASSUMPTIONS,
  DEDICATED_PROPERTIES,
  DedicatedWorkerModel,
  HOLD_WORLD,
  PLAN_AXIOMS,
  PROPERTIES,
  SMALL_WORLD,
  STREAM_WORLD,
  STREAM_WORLD_PREFIX,
  SharedWorkerModel,
  TWO_WORKER_WORLD,
  countInputSequences,
  dedicatedPropertyMask,
  explore,
  inputAutomaton,
  inputCover,
  inputSequences,
  mainHearsStep,
  mainOutput,
  maskOf,
  namesOf,
  pathTo,
  propertyMask,
  reachable,
  realCodeHearsStep,
  stepsOf,
  threadHearsStep,
  threadOutput,
  wholeOutput,
  judged,
  type Assumption,
  type DedicatedKernels,
  type DedicatedProperty,
  type Graph,
  type InputAutomaton,
  type InputEdge,
  type Kernels,
  type NamedCause,
  type NamedForm,
  type Property,
  type SharedWorld,
  type Step
} from "./fv-worker-model";
import { A_DETACH_LEAVES_THE_HOLD_BOUND_RUNNING, aRealTimerSetAndCleared, DedicatedReplay, MainSide, ThreadSide, WholeReplay, underReplayClock, type AttacherModule, type Modules, type ReplayClock } from "./fv-worker-model-replay";
import * as productionAttacher from "./shared-worker-attacher";
import * as productionRealm from "./worker-fingerprint-realm";

/**
 * F4: a model of the shared-worker hold and the readout over it, an axiom table, and
 * conformance by trace. The model is lib/fv-worker-model.ts and the replay
 * lib/fv-worker-model-replay.ts.
 *
 * THE CLAIM. For all event orders in each world's alphabet, under its bounds and under the
 * named axioms, at this commit, each property reads as the table says. No document may
 * shorten that. This does not show that Chromium behaves as A1 to A6 state, and it does not
 * measure anything: those stay measured, the amd64 hold rate among them. It says nothing
 * about how often any trace below happens on a real page.
 *
 * THE ORACLE. Whether a page statement ran comes from the world's process in the model. A fold
 * of the labels alone, below, holds that to being the world's on every state of every shared world:
 * nothing the mirror or the classifier reads moves it. Beside it, the world's own moves are held to
 * being the same in states that differ only in what the mirror, the readout and the port hold, before
 * the drain ends, in the hold and stream worlds. The model's thread, mirror and drain restate
 * production, which is what the replay is for, and the world's own process is the one thing nothing
 * here checks against a browser.
 *
 * WHAT THE REPLAY DOES NOT SHOW. A term comes from the real kernels on both sides of the replay,
 * so a passing replay here is no evidence about classification: it compares production with
 * itself. That evidence is in lib/fv-worker-readout.test.ts, by design, since a third restatement
 * of the kernels would be its own defect. What this suite shows of them is only what a term means
 * against the world's facts, under the table's axioms. The @11 reference here has a second copy
 * in that suite, and nothing binds the two.
 *
 * THE WORLDS. Hold: one worker, every step. Stream: one worker from its release on, with its
 * stream and every hop of the barrier. Two workers: under the bound in TWO_WORKER_WORLD, which
 * also fixes A1 and A5's order and has the frame tree answered by the drain's end. Dedicated: one
 * worker on the main thread's channel, the only world A4 can reach. Each world's graph holds
 * every transition any set of switches allows, each marked with the switches that forbid it, so
 * the table is a traversal of one graph per world.
 *
 * BOUNDS. Asserted below, each with a witness: which kinds of step a world has, how far each queue
 * can be overtaken, and how many reports wait on a port. In the hold world the port is overtaken
 * only before the freeze, and in the stream world before the drain ends. Past the drain, while the
 * readout waits for the frame tree, only what was on its way at the freeze moves, in order, with no
 * new act of the worker's, and the kinds that move there are a list written out by hand. The kinds
 * of step are held for presence only: where in a trace each can happen is not, beyond three walks
 * written out for narrowings a review tried.
 *
 * LEFT OUT, each by the model's own alphabet, with what catches it where something does: a second
 * readout (one leaves nothing behind but what the next would find, and a freeze can fall anywhere);
 * the page's documents and the credit rule, so a read lands `readable` and never `ownerUnscoped`
 * (CL7 walks those, and no hold moves them); the realm's own null, a gap the observer does not
 * produce, and an oversized emission (CL7, CL8a); the visit's own unregister, another context's
 * worker, and a lost page session, but for the pin below (lib/shared-worker-attacher.test.ts);
 * a command the browser refuses rather than answers, which takes the path of an install that
 * answered false; a worker born after the attacher's connection closed; the thread's exit, taken
 * as behind its last report; the time between the browser noticing a closed connection and the
 * main thread hearing it, on the dedicated channel, and its witness (CL7), and its frame tree, read
 * at once; a worker's stream once it is late or gone from the thread; order inside the commands
 * the model takes as one breath, so A1 is not held inside the debugger's enable and its breakpoint,
 * the binding and its evaluation, or the breakpoint's removal and the disable; and time, which
 * passes nowhere here. So these are not held here: a parsed worker gone within the ended-at-once
 * bound (lib/fv-worker-readout.test.ts, lib/shared-worker-attacher.test.ts), and the bound's own length
 * (lib/fv-worker-readout.test.ts alone);
 * the settle bound's length (lib/scanner-worker-fingerprint.test.ts); and `holdMs`
 * (lib/worker-fingerprint-realm.test.ts). The hold bound's default of 3 s and the command list a
 * visit may send have no other catcher, so each has a small direct test here.
 *
 * REPLAY. All of it is in one process: the thread's program over a stand-in socket, patched timers,
 * and the port as a queue here. The premise is that each side is a function of what it hears,
 * step by step, and `inputAutomaton` refuses a model of which that is false. That is a check of the
 * model, not of the code. At the level of frames it is false of the code: a review showed that the
 * same frames in one TCP write and in two move `released, open` to `open, released`, `installed` to
 * `late`, and `afterInstall=true` to `held=true`. The last two only move a worker toward unread.
 * The first had no hit in 1,248 real frozen trials there, local and on a noisy host, which draws
 * no rate. Under the premise, this is what replays:
 *
 * - The real thread hears every sequence it can hear in the hold world and the stream world, with
 *   no axiom assumed, compared at each step with the model's posts, sends and params. So every
 *   model trace of those worlds replays through the real thread, by what it hears.
 * - The real mirror and readout hear every sequence they can hear with A5's order assumed. With it
 *   not assumed there are far too many, and a set takes every transition of what they can hear:
 *   that bound selects the set. Their reports are worded here, since an order out of FIFO and the
 *   thread's death cannot come through the real transport, and the whole replay below holds that
 *   wording to the real thread's.
 * - Both at once, through `inProcessAttacherTransportForTests`, the mirror and the readout: a set of
 *   traces takes every transition of what all of it hears, under the plan's axioms with C1 and D1.
 * - Each word the model drops as ignored is delivered to the real thread at each state of what it
 *   hears, with A1 assumed, in the hold and stream worlds, and the trace goes on from there through
 *   every transition, since no trace above delivers one and the claim is "from this state on". A late
 *   worker's own stream is the exception: the thread forwards it, and the kernels read no stream of a
 *   late worker (CL8a).
 * - Two workers, under their bound: not every sequence, but a set taking every transition of each
 *   side's, and one trace to each finished state. The dedicated world: every sequence.
 *
 * A set that takes every transition stands for every trace only if the real code's next output
 * depends on nothing outside the automaton's state. What each replay asserts of itself, each check
 * with a self-test that it fires: it ran all it was handed; each but the dedicated one, that it took
 * every transition; the thread, that it compared what came out of every step; the main side, that it
 * heard every step and held the real mirror or landing to the model's word after every transition,
 * which is where it compares; the whole replay, both; the two-worker world, that it replayed every
 * landing it counted; and the dropped words, that each delivery planned reached the thread, by the
 * thread side's own count. Nothing under the replay's clock may set a real timer: one is caught as it
 * is made. Every bound goes through the clock, which reads what a trace sets, and the serial phase
 * starts only after the parallel one ends (scripts/unit-test-lanes.mjs), so the file stays in the
 * parallel lane. It takes about a minute and a half alone, and more on a busy Mac or beside other
 * copies, at about 1.3 GB, almost all of it these replays and the worlds' graphs, which are what the
 * row asks for.
 *
 * A MISMATCH fails the suite, and nothing changes until it is classified as model, harness,
 * adapter, implementation or an environment axiom, with the evidence recorded. The ones met
 * building this, none of them implementation:
 *
 * - Model. A barrier's answer past its bound posted a second reply. The real thread had
 *   deleted the command, as the first replay of "barrier-bound, then barrier-answer" showed.
 * - Model. A dedicated worker read with the channel closed at the freeze landed `readable`. The
 *   real readout has no frame trees then, and lands `ownerUnknown`.
 * - Model. A dedicated worker gone before the channel closed, with no record yet, landed
 *   `diedPaused`. The record the conclusion makes is lost with the channel, gone or not, and
 *   lands `channelLostAlive`. (The shared records ask `!worker.detached` too. The dedicated ones
 *   do not. Both read unread, so it moves no count here.)
 * - Model. A word dropped as ignored was not: a breakpoint's answer behind an early parse sends
 *   its probe even after the worker's detach. Found by delivering the dropped words.
 * - Harness. A reply's error text differs by why it failed, and the wording compared it.
 * - Model. A closed channel refuses every barrier still waiting, which answers it for a worker
 *   already gone, so past the drain it reads where the model called it cut off.
 * - Model and harness, found by review. The model ended the readout at the drain, where production
 *   classifies only after the frame tree it asked for at the call, and the replay's scripted frame
 *   tree answered at once, which hid that. A report on the port at the freeze does land, as a
 *   review showed on real Chromium (one worker 20 of 20, two workers 10 of 10, local, forced
 *   timing, no rate). Now the model waits and the frame tree answers when a trace says to.
 * - Harness, found by carrying the dropped words into the stream world. A probe's answer, delivered
 *   with no probe out, answered the barrier's request, since both ask the same thing. A probe's
 *   answer now goes only to the thread's own question.
 *
 * COUNTEREXAMPLES are at the end, pinned open as what happens and not as what should, each with
 * its classification and what would rule it out. None is fixed here: changing one moves report
 * meaning, which is the owner's call.
 */

const PRODUCTION_KERNELS = productionRealm as unknown as Kernels;
const modelPath = require.resolve("./fv-worker-model");
const PRODUCTION_MODULES: Modules = { attacher: productionAttacher, realm: productionRealm };

type Built = { world: SharedWorld; model: SharedWorkerModel; graph: Graph; verdicts: Int32Array; verdictsUnder: Map<number, number> };

const builtWorlds = new Map<string, Built>();

function build(world: SharedWorld, kernels: Kernels = PRODUCTION_KERNELS): Built {
  const model = new SharedWorkerModel(world, kernels);
  const graph = model.explore();
  return { world, model, graph, verdicts: Int32Array.from(graph.keys, (key) => model.verdictOf(key)), verdictsUnder: new Map() };
}

function built(world: SharedWorld): Built {
  let known = builtWorlds.get(world.name);
  if (!known) {
    known = build(world);
    builtWorlds.set(world.name, known);
  }
  return known;
}

let builtDedicated: { model: DedicatedWorkerModel; graph: Graph } | null = null;
function dedicated(): { model: DedicatedWorkerModel; graph: Graph } {
  if (builtDedicated === null) {
    const model = new DedicatedWorkerModel(productionRealm as unknown as DedicatedKernels);
    builtDedicated = { model, graph: model.explore() };
  }
  return builtDedicated;
}

/** Every subset of a mask, the empty one first. */
function subsetsOf(universe: number): number[] {
  const subsets: number[] = [];
  for (let subset = universe; ; subset = (subset - 1) & universe) {
    subsets.push(subset);
    if (subset === 0) break;
  }
  return subsets.reverse();
}

/** Every verdict bit any state reachable under these assumptions earns. */
function verdictUnder(known: Built, assumptions: number): number {
  const memo = known.verdictsUnder.get(assumptions);
  if (memo !== undefined) return memo;
  const { seen } = reachable(known.graph, assumptions);
  let verdict = 0;
  for (let state = 0; state < seen.length; state += 1) if (seen[state] === 1) verdict |= known.verdicts[state];
  known.verdictsUnder.set(assumptions, verdict);
  return verdict;
}

function smallestOf(holding: readonly number[]): string[][] {
  return holding.filter((set) => !holding.some((other) => other !== set && (other & set) === other)).map((set) => namesOf(set));
}

/** A property's smallest sets over some switches, across the given worlds. */
function smallestSets(worlds: readonly Built[], property: Property, universe: number): string[][] {
  const bit = propertyMask(property);
  return smallestOf(subsetsOf(universe).filter((subset) => worlds.every((known) => (verdictUnder(known, subset) & bit) === 0)));
}

/** A world's model over the kernels given, held to one property under the assumptions given. */
function checkModel(kernels: Kernels, world: SharedWorld, assumptions: readonly Assumption[], property: Property): void {
  const known = build(world, kernels);
  const bit = propertyMask(property);
  const reach = reachable(known.graph, maskOf(assumptions));
  for (let state = 0; state < reach.seen.length; state += 1) {
    if (reach.seen[state] === 1) holds(property, (known.verdicts[state] & bit) === 0, () => ({ assumptions, trace: pathTo(known.graph, reach, state), terms: known.model.termsOf(known.graph.keys[state]) }));
  }
}

// ---------------------------------------------------------------------------------------
// What each world has in it, and that nothing here is vacuous.
// ---------------------------------------------------------------------------------------

const PLAN_ALL: readonly Assumption[] = ["A1", "A2", "notA3", "A4", "A5fifo", "A5bound"];
const WITH_C1: readonly Assumption[] = [...PLAN_ALL, "C1"];
const WITH_D1: readonly Assumption[] = [...PLAN_ALL, "D1"];
const WITH_C1_D1: readonly Assumption[] = [...WITH_C1, "D1"];
const WITH_Z: readonly Assumption[] = [...WITH_C1_D1, "Z"];

/**
 * Change detectors, and no more: these only say the graph moved, and they cannot say whether it
 * moved rightly. The tests after them say what a world has in it.
 */
const STATE_COUNTS: Record<string, { everything: [number, number]; plan: [number, number]; planAndC1: [number, number]; planC1AndD1: [number, number]; andZ: [number, number] }> = {
  hold: { everything: [370_936, 1_952_372], plan: [35_628, 131_087], planAndC1: [30_568, 108_286], planC1AndD1: [30_553, 95_312], andZ: [10_377, 39_474] },
  stream: { everything: [6_865, 29_196], plan: [2_333, 8_065], planAndC1: [1_590, 5_412], planC1AndD1: [1_590, 5_404], andZ: [1_590, 5_404] },
  two: { everything: [200_736, 650_933], plan: [146_172, 428_226], planAndC1: [133_156, 331_019], planC1AndD1: [133_156, 331_019], andZ: [44_413, 123_339] },
  small: { everything: [2_301, 6_697], plan: [1_686, 4_226], planAndC1: [1_630, 3_677], planC1AndD1: [1_630, 3_677], andZ: [978, 2_297] }
};

test("the worlds reach exactly these states and transitions, under no assumption and under the plan's axioms", () => {
  for (const world of [HOLD_WORLD, STREAM_WORLD, TWO_WORKER_WORLD, SMALL_WORLD]) {
    const known = built(world);
    const counts = STATE_COUNTS[world.name];
    const under = (assumptions: readonly Assumption[]) => {
      const reach = reachable(known.graph, maskOf(assumptions));
      return [reach.states, reach.edges];
    };
    assert.deepEqual([known.graph.keys.length, known.graph.edgeTo.length], counts.everything, world.name);
    assert.deepEqual(under([]), counts.everything, world.name);
    assert.deepEqual(under(PLAN_ALL), counts.plan, world.name);
    assert.deepEqual(under(WITH_C1), counts.planAndC1, world.name);
    assert.deepEqual(under(WITH_C1_D1), counts.planC1AndD1, world.name);
    assert.deepEqual(under(WITH_Z), counts.andZ, world.name);
  }
  const { graph } = dedicated();
  assert.deepEqual([graph.keys.length, graph.edgeTo.length], DEDICATED_COUNT);
  assert.deepEqual([reachable(graph, maskOf(["A4"])).states, reachable(graph, maskOf(["A4"])).edges], DEDICATED_COUNT_UNDER_A4);
});

/** A step's kind: what it is, with no word of which worker or how far it overtook. */
const kindOf = (name: string): string =>
  name
    .replace(/:@\d+$/, "")
    .split(":")
    .filter((part) => !/^\d+$/.test(part))
    .join(":");

const kindsIn = (graph: Graph): string[] => [...new Set(graph.labels.flatMap((label) => stepsOf(label).map((step) => kindOf(step.name))))].sort();

const THE_MIRROR_HEARS = ["attached", "held", "installed-ok", "installed-bad", "installed-none", "late", "released", "gone-held", "gone-after-install", "gone-unreached-quick", "gone-unreached-long", "gone-other", "event-first", "lost"];
const EVERY_HOLD_STEP = [
  "barrier-round-trip",
  "born:running",
  "born:waiting",
  "connection-closes",
  "discovered",
  "documents-answered",
  "documents-late",
  "ends",
  "evaluates-late:bad",
  "evaluates-late:ok",
  "freeze",
  "hears:ack",
  "hears:attach:running",
  "hears:attach:waiting",
  "hears:detach:long",
  "hears:detach:quick",
  "hears:first",
  "hears:install-bad",
  "hears:install-ok",
  "hears:off-answer",
  "hears:parsed",
  "hears:pause-main",
  "hears:pause-script",
  "hears:pause-statement",
  "hears:probe-answer",
  "hears:resumed",
  "hold-bound",
  "lands:arm",
  "lands:install",
  "lands:install:bad",
  "lands:install:ok",
  "lands:off",
  "lands:probe",
  "lands:run",
  "lands:run:unheard",
  ...THE_MIRROR_HEARS.map((report) => `mirror-hears:${report}`),
  "off-bound",
  "other-release",
  "other-release-unheard",
  "reaches-dependency",
  "reaches-main:paused",
  "reaches-main:ran",
  "settle-bound",
  "starts-unreleased",
  "stops-at-script",
  "stops-at-statement",
  "thread-dies"
].sort();
const EVERY_STREAM_STEP = [
  "barrier-bound",
  "connection-closes",
  "documents-answered",
  "documents-late",
  "emits:closed",
  "emits:open",
  "ends",
  "freeze",
  "hears:barrier-answer",
  "hears:closed",
  "hears:detach:long",
  "hears:open",
  "lands:barrier",
  "mirror-hears:event-closed",
  "mirror-hears:event-open",
  "mirror-hears:gone-other",
  "mirror-hears:lost",
  "mirror-hears:reply-error",
  "mirror-hears:reply-ok",
  "settle-bound",
  "thread-dies",
  "thread-gets-barrier"
].sort();
const EVERY_TWO_WORKER_STEP = [
  "barrier-round-trip",
  "born:waiting",
  "connection-closes",
  "ends",
  "evaluates-late:bad",
  "evaluates-late:ok",
  "freeze",
  "hears:ack",
  "hears:attach:waiting",
  "hears:detach:long",
  "hears:first",
  "hears:install-bad",
  "hears:install-ok",
  "hears:off-answer",
  "hears:parsed",
  "hears:pause-main",
  "hears:resumed",
  "lands:arm",
  "lands:install",
  "lands:install:ok",
  "lands:off",
  "lands:run",
  "mirror-hears:attached",
  "mirror-hears:event-first",
  "mirror-hears:gone-after-install",
  "mirror-hears:gone-held",
  "mirror-hears:gone-other",
  "mirror-hears:gone-unreached-long",
  "mirror-hears:held",
  "mirror-hears:installed-bad",
  "mirror-hears:installed-ok",
  "mirror-hears:late",
  "mirror-hears:lost",
  "mirror-hears:released",
  "other-release",
  "reaches-main:paused",
  "settle-bound"
].sort();
const EVERY_DEDICATED_STEP = ["arm-answered", "barrier-answered", "born:running", "born:waiting", "channel-closes", "ends", "freeze", "hears-attach:running", "hears-attach:waiting", "hears-detach", "install-answered:bad", "install-answered:ok", "pause-bound", "resume-lands", "runs-while-held", "settle-bound"].sort();

test("each world has exactly these kinds of step, written out by hand and not read off the model", () => {
  assert.deepEqual(kindsIn(built(HOLD_WORLD).graph), EVERY_HOLD_STEP);
  assert.deepEqual(kindsIn(built(STREAM_WORLD).graph), EVERY_STREAM_STEP);
  assert.deepEqual(kindsIn(built(TWO_WORKER_WORLD).graph), EVERY_TWO_WORKER_STEP);
  assert.deepEqual(kindsIn(dedicated().graph), EVERY_DEDICATED_STEP);
});

/** How far past the head of its queue each kind of step ever reaches. */
function overtakingIn(graph: Graph): Record<string, number> {
  const furthest: Record<string, number> = { hears: 0, lands: 0, "mirror-hears": 0 };
  for (const label of graph.labels) {
    for (const { name } of stepsOf(label)) {
      const at = /:@(\d+)$/.exec(name);
      if (at) furthest[name.split(":")[0]] = Math.max(furthest[name.split(":")[0]], Number(at[1]));
    }
  }
  return furthest;
}

test("each queue can be overtaken this far and no further, and only with its axiom off", () => {
  // A session holds a worker's own words behind each other. Its commands are few: arming, its release, an install and turning off.
  assert.deepEqual(overtakingIn(built(HOLD_WORLD).graph), HOLD_OVERTAKING);
  assert.deepEqual(overtakingIn(built(STREAM_WORLD).graph), STREAM_OVERTAKING);
  assert.deepEqual(overtakingIn(built(TWO_WORKER_WORLD).graph), { hears: 0, lands: 0, "mirror-hears": 0 });
  const everyOvertaking = (known: Built, prefix: string, axiom: Assumption) => {
    const { graph } = known;
    for (let edge = 0; edge < graph.edgeTo.length; edge += 1) {
      const [first] = stepsOf(graph.labels[graph.edgeLabel[edge]]);
      if (first.name.startsWith(prefix) && /:@\d+$/.test(first.name)) assert.ok((graph.edgeBlockedBy[edge] & maskOf([axiom])) !== 0, first.name);
    }
  };
  everyOvertaking(built(HOLD_WORLD), "hears:", "A1");
  everyOvertaking(built(HOLD_WORLD), "lands:", "A1");
  everyOvertaking(built(HOLD_WORLD), "mirror-hears:", "A5fifo");
  // Where each world's port is overtaken, by the readout's phase, and what moves past the drain at all.
  for (const [world, overtakenIn, pastTheDrain] of [
    [HOLD_WORLD, ["before-freeze"], PAST_THE_DRAIN_IN_THE_HOLD_WORLD],
    [STREAM_WORLD, ["before-freeze", "draining"], PAST_THE_DRAIN_IN_THE_STREAM_WORLD]
  ] as const) {
    const { model, graph } = built(world);
    const phases = new Set<string>();
    const kinds = new Set<string>();
    for (let state = 0; state < graph.keys.length; state += 1) {
      const phase = model.phaseOf(graph.keys[state]);
      for (let edge = graph.firstEdge[state]; edge < graph.firstEdge[state + 1]; edge += 1) {
        const steps = stepsOf(graph.labels[graph.edgeLabel[edge]]);
        if (steps[0].name.startsWith("mirror-hears:") && /:@\d+$/.test(steps[0].name)) phases.add(phase);
        if (phase === "waiting-for-trees") for (const step of steps) kinds.add(kindOf(step.name));
      }
    }
    assert.deepEqual([...phases].sort(), overtakenIn, `${world.name}: the port is overtaken in these phases`);
    assert.deepEqual([...kinds].sort(), [...pastTheDrain].sort(), `${world.name}: past the drain`);
  }
});

/**
 * What moves past the drain, written out by hand: no new act of the worker's or the thread's own, only
 * what was on its way at the freeze. In the hold world: what the thread hears of what the browser emitted
 * before the freeze, what crosses the port, a barrier's round trip, the frame tree's answer, and
 * discovery on the page's own channel, which the model leaves free (see the pins on a worker in no term).
 */
const PAST_THE_DRAIN_IN_THE_HOLD_WORLD = [
  "barrier-round-trip",
  "discovered",
  "documents-answered",
  ...["ack", "attach:running", "attach:waiting", "detach:long", "detach:quick", "first", "install-bad", "install-ok", "off-answer", "parsed", "pause-main", "pause-script", "pause-statement", "probe-answer", "resumed"].map((word) => `hears:${word}`),
  ...THE_MIRROR_HEARS.map((report) => `mirror-hears:${report}`)
];
/** In the stream world, the same, and the barrier the readout sent at the call: its way to the worker and its landing there. */
const PAST_THE_DRAIN_IN_THE_STREAM_WORLD = [
  "documents-answered",
  "hears:barrier-answer",
  "hears:closed",
  "hears:detach:long",
  "hears:open",
  "lands:barrier",
  "mirror-hears:event-closed",
  "mirror-hears:event-open",
  "mirror-hears:gone-other",
  "mirror-hears:lost",
  "mirror-hears:reply-error",
  "mirror-hears:reply-ok",
  "thread-gets-barrier"
];

test("each narrowing a kind of step could hide is a transition: an install evaluated at a statement's pause, a quick life after the breakpoint's answer, a dependency's pause with no other client", () => {
  const known = built(HOLD_WORLD);
  walk(known, PLAN_ALL, ["born:0:waiting||", ATTACH, "lands:0:arm||", "other-release:0||", "reaches-main:0:paused||", "lands:0:run||", "hears:0:ack||", "hears:0:parsed||", "hears:0:pause-main|0:held|0:install", "lands:0:install||", "stops-at-statement:0||", "evaluates-late:0:ok||"]);
  walk(known, PLAN_ALL, ["born:0:waiting||", ATTACH, "lands:0:arm||", "ends:0||", "hears:0:ack||", "hears:0:detach:quick|0:detached:unreached-quick|"]);
  walk(known, PLAN_ALL, ["born:0:waiting||", ATTACH, "lands:0:arm||", "lands:0:run||", "reaches-dependency:0||"]);
});

test("at most four reports wait on the port in the two-worker world, and four do", () => {
  const known = built(TWO_WORKER_WORLD);
  let most = 0;
  for (const key of known.graph.keys) most = Math.max(most, known.model.reportsWaitingAt(key));
  assert.equal(most, 4);
});

test("every world reaches each term it is meant to, and no state short of a finished readout is stuck under any assumptions", () => {
  const terms = (known: Built, assumptions: number) => {
    const { seen } = reachable(known.graph, assumptions);
    const landed = new Set<string>();
    for (let state = 0; state < seen.length; state += 1) {
      if (seen[state] === 1 && known.model.isFinished(known.graph.keys[state])) for (const { term } of known.model.termsOf(known.graph.keys[state])) landed.add(term);
    }
    return [...landed].sort();
  };
  const everyHoldTerm = ["attachedLate", "channelLostAlive", "cutOff", "diedHeld", "endedAtOnce", "installFailed", "nowhere", "pausedAtReadout", "readable", "unattached", "unreached"];
  assert.deepEqual(terms(built(HOLD_WORLD), 0), everyHoldTerm);
  assert.deepEqual(terms(built(HOLD_WORLD), maskOf(PLAN_ALL)), everyHoldTerm);
  assert.deepEqual(terms(built(STREAM_WORLD), 0), ["channelLostAlive", "cutOff", "readable", "streamBroken"]);
  assert.deepEqual(terms(built(TWO_WORKER_WORLD), 0), ["attachedLate", "channelLostAlive", "cutOff", "diedHeld", "nowhere", "pausedAtReadout", "readable", "unreached"]);
  // Each set that matters, in each world: a state with no move left would make a property pass by never getting there.
  for (const world of [HOLD_WORLD, STREAM_WORLD, TWO_WORKER_WORLD]) {
    const known = built(world);
    for (const assumptions of [[], PLAN_ALL, WITH_C1, WITH_D1, WITH_C1_D1, WITH_Z]) {
      const mask = maskOf(assumptions);
      const { seen } = reachable(known.graph, mask);
      for (let state = 0; state < seen.length; state += 1) {
        if (seen[state] === 0 || known.model.isFinished(known.graph.keys[state])) continue;
        let moves = 0;
        for (let edge = known.graph.firstEdge[state]; edge < known.graph.firstEdge[state + 1]; edge += 1) if ((known.graph.edgeBlockedBy[edge] & mask) === 0) moves += 1;
        assert.ok(moves > 0, `${world.name} is stuck under ${assumptions.join()} at ${state}: ${known.graph.keys[state].length}`);
      }
    }
  }
});

test("both workers land in the two-worker world", () => {
  const known = built(TWO_WORKER_WORLD);
  const byWorker = [new Set<string>(), new Set<string>()];
  for (const key of known.graph.keys) {
    if (known.model.isFinished(key)) known.model.termsOf(key).forEach(({ term }, w) => byWorker[w].add(term));
  }
  assert.deepEqual([...byWorker[0]].sort(), ["attachedLate", "channelLostAlive", "cutOff", "diedHeld", "nowhere", "pausedAtReadout", "readable", "unreached"]);
  assert.deepEqual([...byWorker[1]].sort(), ["channelLostAlive", "cutOff", "nowhere", "pausedAtReadout", "readable", "unreached"]);
});

/**
 * The world's own facts, folded over the labels and nothing else. It reads no mirror, no thread and
 * no term, and it restates only the worker's own process: a release lets it go, a pause stops it, the
 * observer goes in when the install lands or evaluates. If the model's ground truth ever came to
 * read what the classifier reads, the two would part on some reachable state.
 */
type WorkerFacts = { phase: "unborn" | "held" | "compiled" | "paused" | "running" | "gone"; observer: boolean; ran: boolean; ranUnobserved: boolean; ranAtFreeze: boolean; ranUnobservedAtFreeze: boolean };

const factsAtStart = (world: SharedWorld): WorkerFacts => (world.startReleased ? { phase: "running", observer: true, ran: true, ranUnobserved: false, ranAtFreeze: false, ranUnobservedAtFreeze: false } : { phase: "unborn", observer: false, ran: false, ranUnobserved: false, ranAtFreeze: false, ranUnobservedAtFreeze: false });

function foldFacts(facts: readonly WorkerFacts[], frozen: boolean, step: Step): { facts: WorkerFacts[]; frozen: boolean } {
  const next = facts.map((worker) => ({ ...worker }));
  const run = (worker: WorkerFacts) => {
    worker.phase = "running";
    if (!frozen) worker.ran = true;
    if (!worker.observer) worker.ranUnobserved = true;
  };
  const release = (worker: WorkerFacts) => {
    if (worker.phase === "held") worker.phase = "compiled";
    else if (worker.phase === "paused") run(worker);
  };
  const parts = step.name.split(":");
  const worker = next[Number(parts[1])];
  switch (parts[0]) {
    case "freeze":
      for (const each of next) {
        each.ranAtFreeze = each.ran;
        each.ranUnobservedAtFreeze = each.ranUnobserved;
      }
      return { facts: next, frozen: true };
    case "connection-closes":
    case "thread-dies":
      for (const each of next) if (each.phase === "held" || each.phase === "compiled" || each.phase === "paused") run(each);
      break;
    case "born":
      if (parts[2] === "waiting") worker.phase = "held";
      else run(worker);
      break;
    case "other-release":
    case "other-release-unheard":
    case "starts-unreleased":
      release(worker);
      break;
    case "reaches-main":
      if (parts[2] === "paused") worker.phase = "paused";
      else run(worker);
      break;
    case "reaches-dependency":
    case "stops-at-statement":
    case "stops-at-script":
      worker.phase = "paused";
      break;
    case "evaluates-late":
      if (parts[2] === "ok") worker.observer = true;
      break;
    case "ends":
      worker.phase = "gone";
      break;
    case "lands":
      if (parts[2] === "run") release(worker);
      if (parts[2] === "install" && parts[3] === "ok") worker.observer = true;
      if (parts[2] === "off" && worker.phase === "paused") run(worker);
      break;
    default:
      break;
  }
  return { facts: next, frozen };
}

type GroundTruth = ReturnType<SharedWorkerModel["groundTruthOf"]>;

/** Folds every trace the assumptions leave open, and returns how many states of the graph it met. */
function checkTheFactsAreTheWorlds(known: Built, assumptions: number, truthOf: (key: string) => GroundTruth = (key) => known.model.groundTruthOf(key)): number {
  const stepsByLabel = known.graph.labels.map(stepsOf);
  const seen = new Set<string>();
  const statesMet = new Uint8Array(known.graph.keys.length);
  const startFacts = Array.from({ length: known.world.workers }, () => factsAtStart(known.world));
  const stack: { state: number; facts: WorkerFacts[]; frozen: boolean }[] = [{ state: 0, facts: startFacts, frozen: false }];
  let visited = 0;
  while (stack.length > 0) {
    const { state, facts, frozen } = stack.pop() as (typeof stack)[number];
    const memo = `${state}|${facts.map((worker) => [worker.phase === "gone" || worker.phase === "running" ? worker.phase : `${worker.phase}${worker.observer}`, worker.ran, worker.ranUnobserved, worker.ranAtFreeze, worker.ranUnobservedAtFreeze].join()).join()}|${frozen}`;
    if (seen.has(memo)) continue;
    seen.add(memo);
    if (statesMet[state] === 0) visited += 1;
    statesMet[state] = 1;
    const key = known.graph.keys[state];
    truthOf(key).forEach((truth, w) => {
      const fold = facts[w];
      const sameFreeze = truth.ranAtFreeze === fold.ranAtFreeze && truth.ranUnobservedAtFreeze === fold.ranUnobservedAtFreeze;
      const sameRun = truth.ranUnobserved === fold.ranUnobserved && (frozen || truth.ran === fold.ran);
      holds("the-ground-truth-is-the-world-s-own", sameFreeze && sameRun, () => ({ truth, fold, world: known.world.name, worker: w }));
    });
    for (let edge = known.graph.firstEdge[state]; edge < known.graph.firstEdge[state + 1]; edge += 1) {
      if ((known.graph.edgeBlockedBy[edge] & assumptions) !== 0) continue;
      let after = { facts, frozen };
      for (const step of stepsByLabel[known.graph.edgeLabel[edge]]) after = foldFacts(after.facts, after.frozen, step);
      stack.push({ state: known.graph.edgeTo[edge], facts: after.facts, frozen: after.frozen });
    }
  }
  return visited;
}

test("the ground truth is the world's own: a fold of the labels alone agrees with the model on every state of every shared world", () => {
  // With no assumption, so every state of each graph is met, by every trace to it.
  for (const world of [HOLD_WORLD, STREAM_WORLD, TWO_WORKER_WORLD, SMALL_WORLD]) {
    const known = built(world);
    assert.equal(checkTheFactsAreTheWorlds(known, 0), known.graph.keys.length, world.name);
  }
});

test("the fold fires: a model that forgets at the freeze that its worker ran unobserved parts from it", async () => {
  const known = built(SMALL_WORLD);
  const forgetful = (key: string) => known.model.groundTruthOf(key).map((truth) => ({ ...truth, ranUnobservedAtFreeze: false }));
  await assertCaughtBy("forgets the unobserved run at the freeze", "the-ground-truth-is-the-world-s-own", () => checkTheFactsAreTheWorlds(known, 0, forgetful));
});

/** The world's own moves: what happens in the browser alone, by the kind of a label's first step. */
const WORLD_MOVE = /^(born|other-release|other-release-unheard|starts-unreleased|lands|reaches-main|reaches-dependency|stops-at-statement|stops-at-script|evaluates-late|emits|ends)$/;

/**
 * The fold above holds what the world's facts are. This holds what the world may do: in every state
 * before the drain ends, the world's moves are the same as in every other state that differs only in
 * what the mirror, the installer's record, the readout, the port or the lost connection hold. A world
 * that read the classifier's side would part on some pair. Returns the groups met.
 *
 * Two places are left out, each for a bound it states. Past the drain, what still moves is what was on
 * its way at the freeze, which is the readout's wait to decide, and the next test holds those kinds to
 * a list. And the two-worker world cuts any move that would leave more than four reports on the port,
 * so its world reads the port by construction, which this would report as a part (738 states).
 */
function checkTheWorldsMovesAreItsOwn(known: Built): number {
  const firstSteps = known.graph.labels.map((label) => stepsOf(label)[0].name);
  const byView = new Map<string, string>();
  for (let state = 0; state < known.graph.keys.length; state += 1) {
    const key = known.graph.keys[state];
    if (known.model.isFinished(key) || known.model.phaseOf(key) === "waiting-for-trees") continue;
    const moves = new Set<string>();
    for (let edge = known.graph.firstEdge[state]; edge < known.graph.firstEdge[state + 1]; edge += 1) {
      const first = firstSteps[known.graph.edgeLabel[edge]];
      if (WORLD_MOVE.test(first.split(":")[0])) moves.add(first);
    }
    const view = known.model.worldAndThreadViewOf(key);
    const these = [...moves].sort().join(" ");
    const before = byView.get(view);
    if (before === undefined) byView.set(view, these);
    else holds("the-world-s-moves-read-nothing-the-classifier-reads", before === these, () => ({ world: known.world.name, one: before, other: these, state }));
  }
  return byView.size;
}

test("the world's moves are its own: before the drain ends, states that differ only in what the mirror, the readout and the port hold have the same world moves", () => {
  for (const world of [HOLD_WORLD, STREAM_WORLD]) assert.ok(checkTheWorldsMovesAreItsOwn(built(world)) > 0, world.name);
});

test("the world-move check fires: a worker that may end only while the mirror does not say held is caught", async () => {
  const variant = loadVariant<typeof import("./fv-worker-model")>(modelPath, [{ find: "if (!pastTheDrain && !plain && phase !== WORLD_GONE) {", replace: "if (state[b + M_HOLD] !== HELD && !pastTheDrain && !plain && phase !== WORLD_GONE) {" }]);
  const model = new variant.SharedWorkerModel(variant.SMALL_WORLD, PRODUCTION_KERNELS);
  const known: Built = { world: variant.SMALL_WORLD, model: model as unknown as SharedWorkerModel, graph: model.explore(), verdicts: new Int32Array(0), verdictsUnder: new Map() };
  await assertCaughtBy("ends only while not held, by the mirror", "the-world-s-moves-read-nothing-the-classifier-reads", () => checkTheWorldsMovesAreItsOwn(known));
});

test("the direction property has moves to judge: a worker gone held moves to unread, and one gone after its install to its stream", () => {
  const known = built(HOLD_WORLD);
  const landing = (labels: readonly string[]) => {
    const { keys } = walk(known, PLAN_ALL, labels);
    return known.model.termsOf(keys[keys.length - 1])[0];
  };
  const goneHeld = landing([...QUIET_START, "ends:0||", "hears:0:detach:long|0:detached:held|", "mirror-hears:0:attached||", "mirror-hears:0:held||", "mirror-hears:0:gone-held||", "freeze||#drain"]);
  assert.deepEqual([goneHeld.term, goneHeld.movedFromAt11], ["diedHeld", "toUnread"]);
  const goneAfter = landing([...QUIET_START, "lands:0:install:ok||", "hears:0:first|0:event:first|", "hears:0:install-ok|0:installed:ok|0:off+remove", "ends:0||", "hears:0:detach:long|0:detached:after-install|", ...MIRROR_SEES_HELD, "mirror-hears:0:event-first||", "mirror-hears:0:installed-ok||", "mirror-hears:0:gone-after-install||", "freeze||#drain"]);
  assert.deepEqual([goneAfter.term, goneAfter.movedFromAt11], ["readable", "toStream"]);
  // Gone after its install with its release heard as well: @11 still said died paused of it.
  const goneThenReleased = landing([...QUIET_START, "lands:0:install:ok||", "hears:0:first|0:event:first|", "hears:0:install-ok|0:installed:ok|0:off+remove", "ends:0||", "hears:0:detach:long|0:detached:after-install|", "off-bound:0|0:released:off|", ...MIRROR_SEES_HELD, "mirror-hears:0:event-first||", "mirror-hears:0:installed-ok||", "mirror-hears:0:gone-after-install||", "mirror-hears:0:released||", "freeze||#drain"]);
  assert.deepEqual([goneThenReleased.term, goneThenReleased.movedFromAt11], ["readable", "toStream"]);
  const quiet = landing([...QUIET_START, "lands:0:install:ok||", "hears:0:first|0:event:first|", "hears:0:install-ok|0:installed:ok|0:off+remove", "lands:0:off||", "hears:0:off-answer|0:released:on|", ...MIRROR_SEES_HELD, "mirror-hears:0:event-first||", "mirror-hears:0:installed-ok||", "mirror-hears:0:released||", "freeze||", "barrier-round-trip:0||#drain"]);
  assert.deepEqual([quiet.term, quiet.movedFromAt11], ["readable", "no"]);
});

test("the two a held worker could stop at are in the world: a statement with no observer in, and a later script", () => {
  const known = built(HOLD_WORLD);
  const stopped = walk(known, ["A1", "A2", "notA3", "A4", "A5fifo", "A5bound"], [...QUIET_START, "other-release:0||", "stops-at-statement:0||"]);
  assert.equal(stopped.labels.length, QUIET_START.length + 2);
  walk(known, ["A1", "A2", "notA3", "A4", "A5fifo", "A5bound"], [...QUIET_START, "other-release:0||", "stops-at-script:0||"]);
});

// A graph small enough to say by hand what the search and the automaton must make of it.
const SMALL_GRAPH_LABELS = ["a|p|", "b|q|", "x||", "c|r|", "a|other|"];
const smallGraph = (labels: readonly number[][]): Graph => {
  const firstEdge = [0];
  const edgeTo: number[] = [];
  const edgeLabel: number[] = [];
  for (const edges of labels) {
    for (let index = 0; index < edges.length; index += 2) {
      edgeLabel.push(edges[index]);
      edgeTo.push(edges[index + 1]);
    }
    firstEdge.push(edgeTo.length);
  }
  return { keys: labels.map((_edges, state) => String(state)), labels: SMALL_GRAPH_LABELS, firstEdge: Int32Array.from(firstEdge), edgeTo: Int32Array.from(edgeTo), edgeLabel: Int32Array.from(edgeLabel), edgeBlockedBy: new Int32Array(edgeTo.length) };
};
const hearsNoX = (name: string) => name !== "x";

test("a set of assumptions blocks a transition if any one of its axioms forbids it", () => {
  const graph = smallGraph([[0, 1, 1, 2], [], []]);
  const blockedBoth = { ...graph, edgeBlockedBy: Int32Array.from([maskOf(["A1", "A2"]), 0]) };
  assert.equal(reachable(blockedBoth, maskOf(["A1"])).states, 2);
  assert.equal(reachable(blockedBoth, maskOf(["A2"])).states, 2);
  assert.equal(reachable(blockedBoth, maskOf(["A4"])).states, 3);
  assert.equal(reachable(blockedBoth, 0).states, 3);
});

/** Every transition of an automaton was replayed, or the replay does not stand for what it says. */
function assertTookEveryTransition(automaton: InputAutomaton, taken: ReadonlySet<InputEdge>): void {
  let transitions = 0;
  for (const edges of automaton.edges) {
    for (const edge of edges) {
      transitions += 1;
      holds("replay-every-transition-was-taken", taken.has(edge), () => ({ input: edge.input, to: edge.to }));
    }
  }
  assert.ok(transitions > 0);
}

/** A replay ran all it was handed, measured against the list and not against a count kept here, which only notices a change. */
function assertRanAllItWasHanded(ran: number, handed: number, what: string): void {
  holds("replay-every-sequence-it-was-handed-ran", ran === handed, () => ({ ran, handed, what }));
}

/** The thread side compared what came out of every step of a trace. */
function assertComparedEveryStep(compared: number, expected: number, input: () => unknown): void {
  holds("replay-every-step-was-compared", compared === expected, () => ({ compared, expected, trace: input() }));
}

/** Every step reached the side that hears it. A count of steps heard says nothing was compared, so the next check goes with it. */
function assertHeardEveryStep(heard: number, expected: number, input: () => unknown): void {
  holds("replay-every-step-was-heard", heard === expected, () => ({ heard, expected, trace: input() }));
}

/** The real mirror or the real landing was held to the model's word after every transition: the main side compares per transition. */
function assertCheckedEveryTransition(checked: number, expected: number, input: () => unknown): void {
  holds("replay-every-transition-was-checked", checked === expected, () => ({ checked, expected, trace: input() }));
}

/** Every finished state counted was replayed to its landing, and the landing checked. */
function assertReplayedEveryLanding(replayed: number, landings: number): void {
  holds("replay-every-landing-was-replayed", replayed === landings, () => ({ replayed, landings }));
}

test("each check a replay leans on fires when what it counts falls short, and passes when nothing does", async () => {
  const automaton = inputAutomaton(smallGraph([[0, 1], []]), 0, hearsNoX, threadOutput);
  const bySelfTest = () => "a self-test";
  await assertCaughtBy("a transition never taken", "replay-every-transition-was-taken", () => assertTookEveryTransition(automaton, new Set()));
  await assertCaughtBy("a sequence handed and not run", "replay-every-sequence-it-was-handed-ran", () => assertRanAllItWasHanded(1, 2, "a self-test"));
  await assertCaughtBy("a step not compared", "replay-every-step-was-compared", () => assertComparedEveryStep(1, 2, bySelfTest));
  await assertCaughtBy("a step not heard", "replay-every-step-was-heard", () => assertHeardEveryStep(1, 2, bySelfTest));
  await assertCaughtBy("a transition not checked", "replay-every-transition-was-checked", () => assertCheckedEveryTransition(1, 2, bySelfTest));
  await assertCaughtBy("a landing counted and not replayed", "replay-every-landing-was-replayed", () => assertReplayedEveryLanding(1, 2));
  await assertCaughtBy("a word planned and not delivered", "replay-every-dropped-word-was-delivered", () => assertDeliveredEveryDroppedWord(1, 2, "a self-test"));
  // Made and cleared at once, so it would never fire: it is caught as it is made.
  await assertCaughtBy("a real timer under the replay", "replay-sets-no-real-timer", () => underReplayClock(async () => aRealTimerSetAndCleared()));
  assertTookEveryTransition(automaton, new Set(automaton.edges.flat()));
  assertRanAllItWasHanded(2, 2, "a self-test");
  assertComparedEveryStep(2, 2, bySelfTest);
  assertHeardEveryStep(2, 2, bySelfTest);
  assertCheckedEveryTransition(2, 2, bySelfTest);
  assertReplayedEveryLanding(2, 2);
  assertDeliveredEveryDroppedWord(2, 2, "a self-test");
  await underReplayClock(async () => undefined);
});

test("the input automaton closes over what a side does not hear, and counts and covers what it does", () => {
  // From the start: a or b; x then a from the second, heard as a; c from both ends of a.
  const graph = smallGraph([[0, 1, 1, 2, 2, 3], [3, 5], [3, 5], [0, 1], [], []]);
  const automaton = inputAutomaton(graph, 0, hearsNoX, threadOutput);
  // a, then c; or a, then c through x; or b, then c: a, b, a-c, b-c and two ends with nothing left.
  assert.deepEqual(automaton.edges[0].map((edge) => edge.input).sort(), ["a", "b"]);
  assert.equal(countInputSequences(automaton), 2);
  assert.deepEqual([...inputSequences(automaton)].map((sequence) => sequence.map((edge) => edge.input).join()).sort(), ["a,c", "b,c"]);
  assertTookEveryTransition(automaton, new Set(inputCover(automaton).flat()));
});

test("the input automaton refuses a model that is not a function of what a side hears", () => {
  const graph = smallGraph([[0, 1, 4, 2], [], []]);
  assert.throws(() => inputAutomaton(graph, 0, hearsNoX, threadOutput), /not a function of what this side hears/);
  assert.doesNotThrow(() => inputAutomaton(graph, 0, hearsNoX, mainOutput));
});

test("the search refuses a move that leaves a state of another size, which would split one state in two", () => {
  assert.throws(() => explore([0, 0], (state) => (state[0] === 0 ? [{ label: "grows", blockedBy: 0, next: [1, 0, 0] }] : [])), /left a state of 3 fields/);
  assert.equal(explore([0], (state) => (state[0] < 3 ? [{ label: "next", blockedBy: 0, next: [state[0] + 1] }] : [])).keys.length, 4);
});

// ---------------------------------------------------------------------------------------
// The table: each property, and the smallest sets of A1 to A5 it holds under.
// ---------------------------------------------------------------------------------------

type TableRow = { property: Property; plan: string[][]; byWorld: Record<"hold" | "stream" | "two", string[][]> };

/**
 * The deliverable, as asserted data. `plan` is the smallest sets of the plan's axioms under which
 * the property holds in every shared world, and an empty list means no set does: it holds under
 * none of the 64. `notA3` is A3's negation, so a property that lists it rests on a detach never
 * overtaking, which is the plan's open ordering study and its note on A3: such a worker could read
 * whole while missing its final snapshot.
 *
 * What it can and cannot say. `byWorld` says which world holds each row. The read rows are decided
 * in one world each, the observer's in the hold world and the read's age in the stream world. The
 * three rows that hold under no set fail in the hold world and the two-worker world alike, so a
 * change in the second alone is hidden by the first: only the first of them has a witness there. A
 * row that holds under no set cannot get worse, so the table does not move if the code weakens
 * further under it: the pins do. The heard-lands row cannot fail in the model, whose kernels return
 * one term, and it has force only in the replay's sums of the real readout. The mass replays judge
 * the real code by `keptUnder`, which comes from the model's own verdict.
 */
const TABLE: readonly TableRow[] = [
  { property: "excluded-implies-no-page-code-before-the-freeze", plan: [], byWorld: { hold: [], stream: [[]], two: [] } },
  { property: "excluded-implies-no-unobserved-page-code-before-the-freeze", plan: [], byWorld: { hold: [], stream: [[]], two: [] } },
  { property: "read-implies-the-observer-preceded-every-statement", plan: [["A1", "A2"]], byWorld: { hold: [["A1", "A2"]], stream: [[]], two: [[]] } },
  { property: "a-read-state-is-no-older-than-the-freeze", plan: [["A1", "notA3", "A5fifo"]], byWorld: { hold: [[]], stream: [["A1", "notA3", "A5fifo"]], two: [[]] } },
  { property: "every-worker-the-readout-heard-of-lands-in-one-term", plan: [[]], byWorld: { hold: [[]], stream: [[]], two: [[]] } },
  { property: "a-worker-that-ran-before-the-freeze-lands-in-a-term", plan: [], byWorld: { hold: [], stream: [[]], two: [] } },
  { property: "at-12-only-moves-toward-unread", plan: [[]], byWorld: { hold: [[]], stream: [[]], two: [[]] } }
];

const SHARED_WORLDS = () => [built(HOLD_WORLD), built(STREAM_WORLD), built(TWO_WORKER_WORLD)];

test("the axiom table: every property under each subset of the plan's axioms, the smallest sets it needs, and which world holds it", () => {
  assert.deepEqual(TABLE.map(({ property }) => property), [...PROPERTIES]);
  assert.equal(subsetsOf(PLAN_AXIOMS).length, 64);
  for (const { property, plan, byWorld } of TABLE) {
    assert.deepEqual(smallestSets(SHARED_WORLDS(), property, PLAN_AXIOMS), plan, property);
    assert.deepEqual(smallestSets([built(HOLD_WORLD)], property, PLAN_AXIOMS), byWorld.hold, `${property} in the hold world`);
    assert.deepEqual(smallestSets([built(STREAM_WORLD)], property, PLAN_AXIOMS), byWorld.stream, `${property} in the stream world`);
    assert.deepEqual(smallestSets([built(TWO_WORKER_WORLD)], property, PLAN_AXIOMS), byWorld.two, `${property} in the two-worker world`);
  }
});

test("an assumption only ever removes behavior: a property that holds under a set holds under every larger one", () => {
  for (const known of SHARED_WORLDS()) {
    const verdicts = new Map(subsetsOf(PLAN_AXIOMS).map((subset) => [subset, verdictUnder(known, subset)]));
    for (const [smaller, verdict] of verdicts) {
      for (const [larger, other] of verdicts) {
        if ((smaller & larger) === smaller) assert.equal(other & ~verdict, 0, `${known.world.name}: ${namesOf(larger).join()} broke what ${namesOf(smaller).join()} kept`);
      }
    }
  }
});

test("A4 changes nothing for a shared worker: each transition it forbids has a twin no axiom forbids, so the plan's word on the shared exclusion stands", () => {
  const A4 = maskOf(["A4"]);
  for (const known of SHARED_WORLDS()) {
    for (const subset of subsetsOf(PLAN_AXIOMS & ~A4)) assert.equal(verdictUnder(known, subset), verdictUnder(known, subset | A4), namesOf(subset).join());
  }
  // One such transition per worker that can take it, so the switch is not empty.
  const held = built(HOLD_WORLD);
  let forbidden = 0;
  for (let edge = 0; edge < held.graph.edgeBlockedBy.length; edge += 1) {
    if ((held.graph.edgeBlockedBy[edge] & A4) === 0) continue;
    forbidden += 1;
    assert.match(held.graph.labels[held.graph.edgeLabel[edge]], /^starts-unreleased:0/);
  }
  assert.ok(forbidden > 0);
});

test("the dedicated world is where A4 acts: a worker held at its attach and excluded ran nothing, under A4 and only under A4", () => {
  const { model, graph } = dedicated();
  const verdict = (assumptions: readonly Assumption[]) => {
    const { seen } = reachable(graph, maskOf(assumptions));
    let found = 0;
    for (let state = 0; state < seen.length; state += 1) if (seen[state] === 1) found |= model.verdictOf(graph.keys[state]);
    return DEDICATED_PROPERTIES.filter((property) => (found & dedicatedPropertyMask(property)) !== 0);
  };
  assert.deepEqual(verdict([]), DEDICATED_PROPERTIES);
  assert.deepEqual(verdict(["A4"]), ["a-dedicated-worker-excluded-ran-no-page-code-before-the-freeze"]);
  // No other axiom has a transition here to remove, so nothing else is in its smallest set.
  for (let edge = 0; edge < graph.edgeBlockedBy.length; edge += 1) assert.ok(graph.edgeBlockedBy[edge] === 0 || graph.edgeBlockedBy[edge] === maskOf(["A4"]));
});

// ---------------------------------------------------------------------------------------
// Beyond A1 to A6: what the table's empty rows would take. Neither switch is an axiom.
// ---------------------------------------------------------------------------------------

test("beyond the plan's axioms: C1, D1 and Z are not axioms, and each says only what it says", () => {
  const worlds = SHARED_WORLDS();
  const keeps = (property: Property, assumptions: readonly Assumption[]) => worlds.every((known) => (verdictUnder(known, maskOf(assumptions)) & propertyMask(property)) === 0);
  // Measuring latency cannot close the safety rows: with both latencies assumed on top of every axiom, they still fail.
  for (const property of ["excluded-implies-no-page-code-before-the-freeze", "excluded-implies-no-unobserved-page-code-before-the-freeze"] as const) assert.equal(keeps(property, WITH_C1_D1), false, property);
  // In the model, a worker that ran lands in a term once the frame tree answers behind what the browser emitted before the freeze: D1
  // closes the row, but only in the hold and stream worlds, which wait for the tree. The two-worker world takes it as answered, so its
  // own trace stays, and over every world only Z closes it. D1 is not what the real order rests on: that is the page connection's
  // discovery ahead of its tree answer, which the model leaves free, and the lost page channel is outside the model.
  const waitingWorlds = [built(HOLD_WORLD), built(STREAM_WORLD)];
  const keepsWhereTheTreeIsWaitedFor = (assumptions: readonly Assumption[]) => waitingWorlds.every((known) => (verdictUnder(known, maskOf(assumptions)) & propertyMask("a-worker-that-ran-before-the-freeze-lands-in-a-term")) === 0);
  assert.equal(keepsWhereTheTreeIsWaitedFor(WITH_C1), false);
  assert.equal(keepsWhereTheTreeIsWaitedFor(["D1"]), true);
  // Z restates the safety property's premise, so that these hold is no evidence for them. It shows the empty rows have no
  // other way to fail: with the mirror current at the freeze, and the port in order, nothing else breaks them.
  const everySwitch = maskOf(ASSUMPTIONS.filter((assumption) => assumption !== "A4"));
  for (const property of ["excluded-implies-no-page-code-before-the-freeze", "excluded-implies-no-unobserved-page-code-before-the-freeze"] as const) assert.deepEqual(smallestSets(worlds, property, everySwitch), [["A5fifo", "Z"]], property);
  assert.deepEqual(smallestSets(worlds, "a-worker-that-ran-before-the-freeze-lands-in-a-term", everySwitch), [["Z"]]);
  assert.deepEqual(smallestSets(waitingWorlds, "a-worker-that-ran-before-the-freeze-lands-in-a-term", everySwitch), [["D1"], ["Z"]]);
});

// ---------------------------------------------------------------------------------------
// The trace to look for: held at the freeze and still at the bound, having run unobserved.
// ---------------------------------------------------------------------------------------

/** Where the readout can end on the named trace, excluding the worker, by how the freeze found it and where the word that would say so was. */
function namedForms(known: Built, assumptions: readonly Assumption[]): string[] {
  const mask = maskOf(assumptions);
  const found = new Set<string>();
  const { seen } = reachable(known.graph, mask);
  for (let state = 0; state < seen.length; state += 1) {
    if (seen[state] === 0) continue;
    const named = known.model.namedTraceAt(known.graph.keys[state], 0);
    if (named === null) continue;
    for (let edge = known.graph.firstEdge[state]; edge < known.graph.firstEdge[state + 1]; edge += 1) {
      if ((known.graph.edgeBlockedBy[edge] & mask) !== 0) continue;
      const to = known.graph.keys[known.graph.edgeTo[edge]];
      if (known.model.isFinished(to) && known.model.termsOf(to)[0].term === "pausedAtReadout") found.add(`${named.form}:${named.cause}`);
    }
  }
  return [...found].sort();
}

function namedWitness(known: Built, assumptions: readonly Assumption[], form: NamedForm, cause: NamedCause): TracedPath {
  const mask = maskOf(assumptions);
  const reach = reachable(known.graph, mask);
  for (let state = 0; state < reach.seen.length; state += 1) {
    if (reach.seen[state] === 0) continue;
    const named = known.model.namedTraceAt(known.graph.keys[state], 0);
    if (named === null || named.form !== form || named.cause !== cause) continue;
    for (let edge = known.graph.firstEdge[state]; edge < known.graph.firstEdge[state + 1]; edge += 1) {
      const to = known.graph.keys[known.graph.edgeTo[edge]];
      if ((known.graph.edgeBlockedBy[edge] & mask) !== 0 || !known.model.isFinished(to) || known.model.termsOf(to)[0].term !== "pausedAtReadout") continue;
      const traced = keysAndLabelsTo(known, reach, state);
      return { labels: [...traced.labels, known.graph.labels[known.graph.edgeLabel[edge]]], keys: [...traced.keys, to] };
    }
  }
  throw new Error(`No witness of ${form}, ${cause} under ${assumptions.join()}`);
}

const each = (forms: readonly NamedForm[], causes: readonly NamedCause[]): string[] => forms.flatMap((form) => causes.map((cause) => `${form}:${cause}`));
const ALL_FORMS: readonly NamedForm[] = ["held", "reaching", "second-pass"];

test("the named trace is reachable, frozen as held, as reaching, and by the second pass, and A5's latency half closes one of its causes in two of those forms", () => {
  const known = built(HOLD_WORLD);
  const noLatencyHalf = each(ALL_FORMS, ["late-posted-before-the-freeze", "late-posted-after-the-freeze", "resume-still-on-the-socket", "connection-lost-on-the-port", "thread-concluded-first"]);
  assert.deepEqual(namedForms(known, ["A1", "A2", "notA3", "A4", "A5fifo"]), [...noLatencyHalf].sort());
  // With it, a late posted before the freeze goes, for a worker the readout waited on. The second pass waits on nothing it has not heard of,
  // so its form stays: the frame tree answers between `held` and `late`, both on the port. Whether Node hands over a port's waiting
  // messages in one callback, which would rule that out, was not read, and that form was not sampled on Chromium.
  const withIt = noLatencyHalf.filter((form) => form !== "held:late-posted-before-the-freeze" && form !== "reaching:late-posted-before-the-freeze");
  assert.deepEqual(namedForms(known, PLAN_ALL), [...withIt].sort());
  // C1 closes the late posted after the freeze and the resume on the socket, again only where the readout waited.
  const andC1 = withIt.filter((form) => !["held:late-posted-after-the-freeze", "reaching:late-posted-after-the-freeze", "held:resume-still-on-the-socket", "reaching:resume-still-on-the-socket"].includes(form));
  assert.deepEqual(namedForms(known, WITH_C1), [...andC1].sort());
  // D1 closes every form with a word on its way from before the freeze.
  const stay = each(ALL_FORMS, ["connection-lost-on-the-port", "thread-concluded-first"]).sort();
  assert.deepEqual(namedForms(known, WITH_D1), stay);
  // What neither closes: the thread concluded first, so no late is ever posted, with or without a connection closing after the freeze.
  assert.deepEqual(namedForms(known, WITH_C1_D1), stay);
});

// ---------------------------------------------------------------------------------------
// Replay.
// ---------------------------------------------------------------------------------------

const automata = new Map<string, InputAutomaton>();
/** What one side hears in a world's graph: built once, since several checks replay the same one. */
function heardBy(known: Built, assumptions: number, side: "thread" | "main"): InputAutomaton {
  const key = `${known.world.name}:${assumptions}:${side}`;
  let automaton = automata.get(key);
  if (!automaton) {
    automaton = side === "thread" ? inputAutomaton(known.graph, assumptions, threadHearsStep, threadOutput) : inputAutomaton(known.graph, assumptions, mainHearsStep, mainOutput);
    automata.set(key, automaton);
  }
  return automaton;
}

const prefixSteps = (world: SharedWorld, hears: (name: string) => boolean): Step[] => (world.startReleased ? STREAM_WORLD_PREFIX.flatMap(stepsOf).filter((step) => hears(step.name)) : []);

/**
 * What one step adds to the whole replay's two counts: a step of the browser alone reaches nothing, a
 * barrier's round trip is compared twice by the thread and its reply heard once by the main thread,
 * and every other step reaches one side once.
 */
const reachesInWhole = (step: Step): number => (!realCodeHearsStep(step.name) ? 0 : step.name.startsWith("barrier-round-trip") ? 3 : 1);

const stepsIn = (sequence: readonly InputEdge[], steps: (step: Step) => number = () => 1): number => sequence.reduce((sum, edge) => sum + edge.steps.reduce((inEdge, step) => inEdge + steps(step), 0), 0);

async function threadHearsSequence(clock: ReplayClock, attacher: AttacherModule, world: SharedWorld, sequence: readonly InputEdge[], input: () => unknown, taken: Set<InputEdge>): Promise<void> {
  const thread = new ThreadSide(clock, attacher, { sinkName: "sink", capability: "capability" });
  try {
    await thread.open();
    await thread.registerAlone();
    thread.holdPort();
    for (const step of prefixSteps(world, threadHearsStep)) await thread.hear(step, input);
    for (const edge of sequence) {
      for (const step of edge.steps) {
        if (step.name.startsWith("barrier-round-trip")) await thread.barrierRoundTrip(Number(step.name.split(":")[1]), input);
        else await thread.hear(step, input);
      }
      taken.add(edge);
    }
    // Each step's output was compared, the last among them: a barrier's round trip is compared twice.
    const expected = prefixSteps(world, threadHearsStep).length + stepsIn(sequence, (step) => (step.name.startsWith("barrier-round-trip") ? 2 : 1));
    assertComparedEveryStep(thread.compared, expected, input);
  } finally {
    thread.close();
  }
}

/** Every sequence or a cover, each through the real thread alone. Returns how many it replayed, and what it took is in `taken`. */
async function replayThread(attacher: AttacherModule, world: SharedWorld, sequences: Iterable<readonly InputEdge[]>, taken: Set<InputEdge> = new Set()): Promise<number> {
  let replayed = 0;
  await underReplayClock(async (clock) => {
    for (const sequence of sequences) {
      replayed += 1;
      await threadHearsSequence(clock, attacher, world, sequence, () => ({ world: world.name, sequence: sequence.map((edge) => edge.input) }), taken);
    }
  });
  return replayed;
}

const finishedLandings = (known: Built, members: Int32Array) => {
  const landings = new Map<string, ReturnType<SharedWorkerModel["termsOf"]>>();
  for (const member of members) {
    const landing = known.model.termsOf(known.graph.keys[member]);
    landings.set(JSON.stringify(landing), landing);
  }
  return [...landings.values()];
};

/** Holds a main side to the automaton's word after one edge. */
function checkMain(main: MainSide, known: Built, automaton: InputAutomaton, edge: InputEdge, mustHold: ReadonlySet<Property>, input: () => unknown): void {
  const members = automaton.members[edge.to];
  const key = known.graph.keys[members[0]];
  if (known.model.isFinished(key)) main.checkLanding(finishedLandings(known, members), mustHold, input);
  else {
    main.checkMirror(Array.from({ length: known.world.workers }, (_unused, w) => known.model.mirrorOf(key, w)), input);
    main.checkEnded(false, input);
  }
}

async function replayMain(modules: Modules, known: Built, automaton: InputAutomaton, sequences: Iterable<readonly InputEdge[]>, mustHold: ReadonlySet<Property>, taken: Set<InputEdge> = new Set()): Promise<number> {
  let replayed = 0;
  await underReplayClock(async (clock) => {
    for (const sequence of sequences) {
      replayed += 1;
      const input = () => ({ world: known.world.name, sequence: sequence.map((edge) => edge.input) });
      const main = new MainSide(clock, modules.realm, known.world.workers);
      try {
        main.treesComeLate = sequence.some((edge) => edge.input.includes("documents-late"));
        await main.open(modules.attacher, main.aloneTransport(), null);
        for (const step of prefixSteps(known.world, mainHearsStep)) await main.hearAlone(step);
        for (const edge of sequence) {
          for (const step of edge.steps) await main.hearAlone(step);
          checkMain(main, known, automaton, edge, mustHold, input);
          taken.add(edge);
        }
        assertHeardEveryStep(main.heard, prefixSteps(known.world, mainHearsStep).length + stepsIn(sequence), input);
        assertCheckedEveryTransition(main.checked, sequence.length, input);
      } finally {
        main.close();
      }
    }
  });
  return replayed;
}

async function replayWhole(modules: Modules, known: Built, automaton: InputAutomaton, sequences: Iterable<readonly InputEdge[]>, mustHold: ReadonlySet<Property>, taken: Set<InputEdge> = new Set()): Promise<number> {
  let replayed = 0;
  await underReplayClock(async (clock) => {
    for (const sequence of sequences) {
      replayed += 1;
      const input = () => ({ world: known.world.name, sequence: sequence.map((edge) => edge.input) });
      const whole = await WholeReplay.open(clock, modules, known.world.workers);
      try {
        whole.main.treesComeLate = sequence.some((edge) => edge.input.includes("documents-late"));
        for (const step of prefixSteps(known.world, realCodeHearsStep)) await whole.step(step, input);
        for (const edge of sequence) {
          for (const step of edge.steps) await whole.step(step, input);
          checkMain(whole.main, known, automaton, edge, mustHold, input);
          taken.add(edge);
        }
        assertHeardEveryStep(whole.thread.compared + whole.main.heard, prefixSteps(known.world, realCodeHearsStep).length + stepsIn(sequence, reachesInWhole), input);
        assertCheckedEveryTransition(whole.main.checked, sequence.length, input);
      } finally {
        whole.close();
      }
    }
  });
  return replayed;
}

/** The properties a world keeps under a set of axioms: what a replay under that set must find true of the real code too. */
function keptUnder(known: Built, assumptions: number): Set<Property> {
  const verdict = verdictUnder(known, assumptions);
  return new Set(PROPERTIES.filter((property) => (verdict & propertyMask(property)) === 0));
}

test("replay: the real thread hears every sequence it can hear in the hold world, with no axiom assumed, and posts and sends what the model says", async () => {
  const known = built(HOLD_WORLD);
  const automaton = heardBy(known, 0, "thread");
  const taken = new Set<InputEdge>();
  assert.equal(countInputSequences(automaton), THREAD_SEQUENCES.hold);
  assertRanAllItWasHanded(await replayThread(productionAttacher, HOLD_WORLD, inputSequences(automaton), taken), countInputSequences(automaton), "the thread, hold");
  assertTookEveryTransition(automaton, taken);
});

test("replay: the real thread hears every sequence it can hear from a worker's release on, with no axiom assumed", async () => {
  const known = built(STREAM_WORLD);
  const automaton = inputAutomaton(known.graph, 0, threadHearsStep, threadOutput);
  const taken = new Set<InputEdge>();
  assert.equal(countInputSequences(automaton), THREAD_SEQUENCES.stream);
  assertRanAllItWasHanded(await replayThread(productionAttacher, STREAM_WORLD, inputSequences(automaton), taken), countInputSequences(automaton), "the thread, stream");
  assertTookEveryTransition(automaton, taken);
});

test("replay: the real mirror and readout hear every sequence they can hear with the port in order, and land where the model says", async () => {
  for (const world of [HOLD_WORLD, STREAM_WORLD]) {
    const known = built(world);
    const mask = maskOf(["A5fifo"]);
    const automaton = heardBy(known, mask, "main");
    const taken = new Set<InputEdge>();
    assert.equal(countInputSequences(automaton), MAIN_SEQUENCES[world.name], world.name);
    assertRanAllItWasHanded(await replayMain(PRODUCTION_MODULES, known, automaton, inputSequences(automaton), keptUnder(known, mask), taken), countInputSequences(automaton), `the main side in order, ${world.name}`);
    assertTookEveryTransition(automaton, taken);
  }
});

test("replay: with the port out of order and the thread dead, the real mirror and readout take every transition of what they can hear", async () => {
  for (const world of [HOLD_WORLD, STREAM_WORLD]) {
    const known = built(world);
    const automaton = heardBy(known, 0, "main");
    const cover = inputCover(automaton);
    const taken = new Set<InputEdge>();
    assert.deepEqual([countInputSequences(automaton), cover.length], MAIN_COVER[world.name], world.name);
    assertRanAllItWasHanded(await replayMain(PRODUCTION_MODULES, known, automaton, cover, keptUnder(known, 0), taken), cover.length, `the main side out of order, ${world.name}`);
    assertTookEveryTransition(automaton, taken);
  }
});

test("replay: through the real thread, its in-process transport, the real mirror and the real readout, a set of traces takes every transition of what all of it hears", async () => {
  for (const world of [HOLD_WORLD, STREAM_WORLD]) {
    const known = built(world);
    const mask = maskOf(WITH_C1_D1);
    const automaton = inputAutomaton(known.graph, mask, realCodeHearsStep, wholeOutput);
    const cover = inputCover(automaton);
    const taken = new Set<InputEdge>();
    assert.equal(cover.length, WHOLE_COVER[world.name], world.name);
    assertRanAllItWasHanded(await replayWhole(PRODUCTION_MODULES, known, automaton, cover, keptUnder(known, mask), taken), cover.length, `both at once, ${world.name}`);
    assertTookEveryTransition(automaton, taken);
  }
});

test("replay: the two-worker world, each side by every transition of what it hears, and both at once to every landing", async () => {
  const known = built(TWO_WORKER_WORLD);
  const threadAutomaton = inputAutomaton(known.graph, 0, threadHearsStep, threadOutput);
  const mainAutomaton = inputAutomaton(known.graph, 0, mainHearsStep, mainOutput);
  const threadCover = inputCover(threadAutomaton);
  const mainCover = inputCover(mainAutomaton);
  assert.deepEqual([threadCover.length, mainCover.length], TWO_WORKER_COVERS);
  const threadTook = new Set<InputEdge>();
  const mainTook = new Set<InputEdge>();
  assertRanAllItWasHanded(await replayThread(productionAttacher, TWO_WORKER_WORLD, threadCover, threadTook), threadCover.length, "the thread, two workers");
  assertRanAllItWasHanded(await replayMain(PRODUCTION_MODULES, known, mainAutomaton, mainCover, keptUnder(known, 0), mainTook), mainCover.length, "the main side, two workers");
  assertTookEveryTransition(threadAutomaton, threadTook);
  assertTookEveryTransition(mainAutomaton, mainTook);
  // Both at once, by the first trace to each finished state: every pair of terms and facts the world can end in.
  const reach = reachable(known.graph, 0);
  let landings = 0;
  let replayedLandings = 0;
  await underReplayClock(async (clock) => {
    for (let state = 0; state < reach.seen.length; state += 1) {
      if (!known.model.isFinished(known.graph.keys[state])) continue;
      landings += 1;
      replayedLandings += await replayPath(clock, PRODUCTION_MODULES, known, keysAndLabelsTo(known, reach, state), keptUnder(known, 0));
    }
  });
  assertReplayedEveryLanding(replayedLandings, landings);
  assert.equal(landings, TWO_WORKER_LANDINGS);
});

test("replay: the real session, installer and readout hear every sequence of the dedicated world", async () => {
  const { model, graph } = dedicated();
  const hears = (name: string) => !/^(born|runs-while-held|ends|resume-lands)/.test(name);
  const automaton = inputAutomaton(graph, 0, hears, (step) => step.ended ?? "");
  assert.equal(countInputSequences(automaton), DEDICATED_SEQUENCES);
  assertRanAllItWasHanded(await replayDedicated(productionRealm, model, graph, automaton, new Set()), countInputSequences(automaton), "the dedicated world");
  // Under A4, a worker held at its attach is judged by the world's facts too.
  const underA4 = inputAutomaton(graph, maskOf(["A4"]), hears, (step) => step.ended ?? "");
  assertRanAllItWasHanded(await replayDedicated(productionRealm, model, graph, underA4, new Set(["a-dedicated-worker-held-at-its-attach-and-excluded-ran-no-page-code-before-the-freeze", "a-dedicated-worker-read-had-the-observer-before-every-statement"])), countInputSequences(underA4), "the dedicated world under A4");
});

async function replayDedicated(realm: Modules["realm"], model: DedicatedWorkerModel, graph: Graph, automaton: InputAutomaton, mustHold: ReadonlySet<DedicatedProperty>, sessionClass: typeof DedicatedWorkerAttachSession = DedicatedWorkerAttachSession): Promise<number> {
  let replayed = 0;
  await underReplayClock(async (clock) => {
    for (const sequence of inputSequences(automaton)) {
      replayed += 1;
      const input = () => sequence.map((edge) => edge.input);
      const replay = new DedicatedReplay(clock, realm, sessionClass);
      try {
        await replay.open();
        for (const edge of sequence) {
          for (const step of edge.steps) await replay.step(step.name);
          const members = automaton.members[edge.to];
          const key = graph.keys[members[0]];
          if (model.isFinished(key)) replay.checkLanding(model.termOf(key) as string, Array.from(members, (member) => model.truthOf(graph.keys[member])), mustHold, input);
          else replay.check(model.sessionOf(key), input);
        }
      } finally {
        replay.close();
      }
    }
  });
  return replayed;
}

const THREAD_SEQUENCES: Record<string, number> = { hold: 10_671, stream: 223 };
const MAIN_SEQUENCES: Record<string, number> = { hold: 3_611, stream: 353 };
const MAIN_COVER: Record<string, [number, number]> = { hold: [1_289_494, 14_755], stream: [737, 433] };
const WHOLE_COVER: Record<string, number> = { hold: 10_514, stream: 955 };
const TWO_WORKER_COVERS: [number, number] = [3_830, 4_142];
const TWO_WORKER_LANDINGS = 834;
const DEDICATED_SEQUENCES = 61;
const DEDICATED_COUNT: [number, number] = [161, 359];
const DEDICATED_COUNT_UNDER_A4: [number, number] = [124, 245];
const EVERY_DROPPED_WORD = ["ack", "closed", "first", "install-bad", "install-ok", "off-answer", "open", "parsed", "pause-main", "pause-script", "pause-statement", "probe-answer", "resumed"];
const HOLD_OVERTAKING = { hears: 5, lands: 3, "mirror-hears": 6 };
const STREAM_OVERTAKING = { hears: 2, lands: 0, "mirror-hears": 4 };

// ---------------------------------------------------------------------------------------
// One trace at a time: the witnesses, the pins and the scenario the thread's variants run.
// ---------------------------------------------------------------------------------------

type TracedPath = { labels: readonly string[]; keys: readonly string[] };

function keysAndLabelsTo(known: Built, reach: ReturnType<typeof reachable>, state: number): TracedPath {
  const keys: string[] = [];
  for (let at = state; at !== -1; at = reach.parent[at]) keys.push(known.graph.keys[at]);
  return { labels: pathTo(known.graph, reach, state), keys: keys.reverse() };
}

/** A trace written out, held to being one: each label must be a transition the assumptions leave open. */
function walk(known: Built, assumptions: readonly Assumption[], labels: readonly string[]): TracedPath {
  const index = new Map(known.graph.keys.map((key, state) => [key, state]));
  let at = 0;
  const keys = [known.graph.keys[0]];
  for (const label of labels) {
    let next = -1;
    for (let edge = known.graph.firstEdge[at]; edge < known.graph.firstEdge[at + 1]; edge += 1) {
      if (known.graph.labels[known.graph.edgeLabel[edge]] === label && (known.graph.edgeBlockedBy[edge] & maskOf(assumptions)) === 0) next = known.graph.edgeTo[edge];
    }
    assert.notEqual(next, -1, `"${label}" is no transition here under ${assumptions.join()}: ${JSON.stringify(labels)}`);
    at = next;
    keys.push(known.graph.keys[at]);
  }
  assert.equal(index.get(keys[keys.length - 1]), at);
  return { labels, keys };
}

/** One trace through the whole real path. Returns how many landings it checked: one if it ends with the readout, and none otherwise. */
async function replayPath(clock: ReplayClock, modules: Modules, known: Built, path: TracedPath, mustHold: ReadonlySet<Property>): Promise<number> {
  const input = () => path.labels;
  const whole = await WholeReplay.open(clock, modules, known.world.workers);
  try {
    whole.main.treesComeLate = path.labels.some((label) => label.includes("documents-late"));
    for (const step of prefixSteps(known.world, realCodeHearsStep)) await whole.step(step, input);
    for (let index = 0; index < path.labels.length; index += 1) {
      for (const step of stepsOf(path.labels[index])) await whole.step(step, input);
      const key = path.keys[index + 1];
      if (known.model.isFinished(key)) whole.main.checkLanding([known.model.termsOf(key)], mustHold, input);
      else {
        whole.main.checkMirror(Array.from({ length: known.world.workers }, (_unused, w) => known.model.mirrorOf(key, w)), input);
        whole.main.checkEnded(false, input);
      }
    }
    assertCheckedEveryTransition(whole.main.checked, path.labels.length, input);
    return whole.main.landingsChecked;
  } finally {
    whole.close();
  }
}

/** The first trace to a state that breaks a property under the assumptions given. */
function witness(known: Built, assumptions: readonly Assumption[], property: Property): TracedPath {
  const reach = reachable(known.graph, maskOf(assumptions));
  const bit = propertyMask(property);
  for (let state = 0; state < reach.seen.length; state += 1) {
    if (reach.seen[state] === 1 && (known.verdicts[state] & bit) !== 0) return keysAndLabelsTo(known, reach, state);
  }
  throw new Error(`Nothing breaks ${property} under ${assumptions.join()}`);
}

const without = (assumption: Assumption): Assumption[] => PLAN_ALL.filter((name) => name !== assumption);

/**
 * Each row's need, shown of the real code: with every other axiom assumed, the model's first
 * trace to a break goes through the thread's program, the mirror and the readout, lands where the
 * model says, and is judged broken by the world's facts.
 */
const WITNESSES: readonly { world: SharedWorld; assumptions: readonly Assumption[]; property: Property }[] = [
  { world: HOLD_WORLD, assumptions: PLAN_ALL, property: "excluded-implies-no-page-code-before-the-freeze" },
  { world: HOLD_WORLD, assumptions: PLAN_ALL, property: "excluded-implies-no-unobserved-page-code-before-the-freeze" },
  { world: HOLD_WORLD, assumptions: PLAN_ALL, property: "a-worker-that-ran-before-the-freeze-lands-in-a-term" },
  { world: HOLD_WORLD, assumptions: without("A1"), property: "read-implies-the-observer-preceded-every-statement" },
  { world: HOLD_WORLD, assumptions: without("A2"), property: "read-implies-the-observer-preceded-every-statement" },
  { world: STREAM_WORLD, assumptions: without("A1"), property: "a-read-state-is-no-older-than-the-freeze" },
  { world: STREAM_WORLD, assumptions: without("notA3"), property: "a-read-state-is-no-older-than-the-freeze" },
  { world: STREAM_WORLD, assumptions: without("A5fifo"), property: "a-read-state-is-no-older-than-the-freeze" },
  { world: TWO_WORKER_WORLD, assumptions: PLAN_ALL, property: "excluded-implies-no-page-code-before-the-freeze" }
];

for (const { world, assumptions, property } of WITNESSES) {
  test(`the table's need, of the real code: ${property} in the ${world.name} world, under ${assumptions.join(" ")}`, async () => {
    const known = built(world);
    const path = witness(known, assumptions, property);
    await assertCaughtBy(`${world.name} under ${assumptions.join()}`, property, () => underReplayClock((clock) => replayPath(clock, PRODUCTION_MODULES, known, path, new Set([property]))));
  });
}

// Each of the named trace's forms, of the real code, by the first trace to it. Excluded all, though each ran unobserved.
for (const [form, cause, assumptions] of [
  ["held", "late-posted-before-the-freeze", ["A1", "A2", "notA3", "A4", "A5fifo"]],
  ["held", "late-posted-after-the-freeze", PLAN_ALL],
  ["held", "resume-still-on-the-socket", PLAN_ALL],
  ["held", "connection-lost-on-the-port", PLAN_ALL],
  ["held", "thread-concluded-first", WITH_C1_D1],
  ["reaching", "resume-still-on-the-socket", PLAN_ALL],
  ["reaching", "thread-concluded-first", WITH_C1_D1],
  ["second-pass", "resume-still-on-the-socket", PLAN_ALL],
  ["second-pass", "thread-concluded-first", WITH_C1_D1]
] as const) {
  test(`the named trace frozen as ${form}, with ${cause}, goes through the real code: the real readout excludes a worker that ran unobserved`, async () => {
    const known = built(HOLD_WORLD);
    const found = namedWitness(known, assumptions, form, cause);
    assert.equal(known.model.termsOf(found.keys[found.keys.length - 1])[0].term, "pausedAtReadout");
    await assertCaughtBy(`${form}, ${cause}`, "excluded-implies-no-unobserved-page-code-before-the-freeze", () => underReplayClock((clock) => replayPath(clock, PRODUCTION_MODULES, known, found, new Set<Property>(["excluded-implies-no-unobserved-page-code-before-the-freeze"]))));
  });
}

// ---------------------------------------------------------------------------------------
// Counterexamples, pinned open as what happens and not as what should.
//
// Each trace below is a model trace under the axioms it names, walked here transition by
// transition, and goes through the thread's program and the real mirror and readout, in one
// process, over a stand-in socket and patched timers with the port a queue here, which land
// where the model says. Each is judged by the world's facts.
//
// Classification is per pin. An environment axiom means the real code does what the model says
// and only something about the browser or the transport would rule the trace out: `rests` names
// that thing, none of it is in A1 to A6 unless it says so, and each is its own measurement. How
// often a real page does any of this is not measured, on any host. Implementation means no
// such thing exists: the rule is false of the trace under any latency, so measuring latency
// cannot close it. A review reproduced the excluded forms on real Chromium with a local fixture:
// under forced timing, and with no stall and the loop turning, the call at a beacon left the worker
// excluded with its beacon run before the freeze in 2 of 40 runs on macOS and 5 of 40 on Linux.
// Those are counts from selected timing, and they draw no rate.
//
// What a saved report shows. The term is saved nowhere. What a report shows of an excluded worker,
// or one in no term, is that it is no unread realm: no worker-realm line and no censoring for it.
// What becomes of its calls depends on the read. At the last read (lib/scanner.ts, the final state
// read) they are dropped. At the passive read, a later read still takes them, in the phase that is
// current then: the consent-interaction phase begins whenever the visit's budget allows, with a
// banner or not (lib/scanner.ts), so they are credited to it, which is misattribution. A review's
// full visits with no banner gave them phaseId 1 against 0 in 3 of 3. Only with the budget gone
// and no phase begun did nothing change (2 of 2). Whether
// a recorded call falls in the window depends on how far from the release it is: the window is the
// disable's answer on its way back and one port hop, or the same for a resume, so a statement can
// fit in it with no stall at all, and a slower call may need one. Nothing here shows that any of
// this has reached a report. Changing any of it moves what a term means, so it is an epoch decision
// for the owner, and none is changed here. The docblocks that say otherwise, "Released, or still
// held at the bound, it ran nothing before the freeze" and "Paused at its main script after the
// freeze: it ran nothing before it", stay as they are for the same reason.
// ---------------------------------------------------------------------------------------

const ATTACH = "hears:0:attach:waiting|0:attached:waiting|0:arm,0:run";
const QUIET_START = ["born:0:waiting||", ATTACH, "lands:0:arm||", "lands:0:run||", "reaches-main:0:paused||", "hears:0:ack||", "hears:0:parsed||", "hears:0:pause-main|0:held|0:install"];
const THE_THREAD_S_OWN_RELEASE_REACHES_A_PAUSE = ["born:0:waiting||", "other-release:0||", ATTACH, "lands:0:arm||", "reaches-main:0:paused||", "lands:0:run||", "hears:0:parsed||", "hears:0:ack||0:probe", "hears:0:pause-main|0:held|0:install"];
const MIRROR_SEES_HELD = ["mirror-hears:0:attached||", "mirror-hears:0:held||"];
const INSTALLED_AND_OFF = ["lands:0:install:ok||", "hears:0:first|0:event:first|", "hears:0:install-ok|0:installed:ok|0:off+remove", "lands:0:off||"];
const REPORTS_OF_AN_ORDINARY_HOLD = ["mirror-hears:0:event-first||", "mirror-hears:0:installed-ok||"];
const EXCLUDED_THOUGH_IT_RAN: Property[] = ["excluded-implies-no-page-code-before-the-freeze"];
const EXCLUDED_THOUGH_IT_RAN_UNOBSERVED: Property[] = ["excluded-implies-no-page-code-before-the-freeze", "excluded-implies-no-unobserved-page-code-before-the-freeze"];

type Pin = {
  name: string;
  kind: "implementation" | "environment axiom";
  /** What would rule it out. */
  rests: string;
  /** Under these, the same trace is no transition at all: the switch is what rules it out. */
  closedBy?: readonly Assumption[];
  assumptions: readonly Assumption[];
  labels: readonly string[];
  term: string;
  broken: Property[];
};

const PINS: readonly Pin[] = [
  {
    // No other client and no bound. The worker runs with its observer, and the mirror hears of it one hop later, before the bound.
    name: "an ordinary hold whose release is one hop from the mirror at the freeze, frozen as held, is excluded though it ran, with its observer in",
    kind: "implementation",
    rests: "nothing: every report arrives before the bound and before the frame tree",
    assumptions: WITH_C1_D1,
    labels: [...QUIET_START, ...INSTALLED_AND_OFF, ...MIRROR_SEES_HELD, ...REPORTS_OF_AN_ORDINARY_HOLD, "freeze||", "hears:0:off-answer|0:released:on|", "mirror-hears:0:released||#drain"],
    term: "pausedAtReadout",
    broken: EXCLUDED_THOUGH_IT_RAN
  },
  {
    // The same with the mirror a word further behind: "reaching" takes a release as coming after the call.
    name: "the same, frozen as reaching, with only its attach heard at the freeze",
    kind: "implementation",
    rests: "nothing, as above",
    assumptions: WITH_C1_D1,
    labels: [...QUIET_START, ...INSTALLED_AND_OFF, "mirror-hears:0:attached||", "freeze||", "hears:0:off-answer|0:released:on|", "mirror-hears:0:held||", ...REPORTS_OF_AN_ORDINARY_HOLD, "mirror-hears:0:released||#drain"],
    term: "pausedAtReadout",
    broken: EXCLUDED_THOUGH_IT_RAN
  },
  {
    // The second pass needs no second worker: the drain ends at the call, and every report crosses while the readout waits for the frame tree.
    name: "the same, read by the second pass, with every report on the port at the freeze",
    kind: "implementation",
    rests: "nothing, as above",
    assumptions: WITH_C1_D1,
    labels: [...QUIET_START, ...INSTALLED_AND_OFF, "hears:0:off-answer|0:released:on|", "documents-late||&freeze||#drain-waits", ...MIRROR_SEES_HELD, ...REPORTS_OF_AN_ORDINARY_HOLD, "mirror-hears:0:released||", "documents-answered||#documents"],
    term: "pausedAtReadout",
    broken: EXCLUDED_THOUGH_IT_RAN
  },
  {
    // Row 2 has this form too, so measuring latency cannot close it: an install that failed leaves no observer, and its release reads the same.
    name: "a failed install in the same window is excluded though the worker ran with no observer",
    kind: "implementation",
    rests: "nothing, as above",
    assumptions: WITH_C1_D1,
    labels: [...QUIET_START, "lands:0:install:bad||", "hears:0:install-bad|0:installed:bad|0:off+remove", "lands:0:off||", ...MIRROR_SEES_HELD, "mirror-hears:0:installed-bad||", "freeze||", "hears:0:off-answer|0:released:on|", "mirror-hears:0:released||#drain"],
    term: "pausedAtReadout",
    broken: EXCLUDED_THOUGH_IT_RAN_UNOBSERVED
  },
  {
    // The form the plan looked for.
    name: "held at the freeze and at the bound, with its late on the port, is excluded though it ran unobserved",
    kind: "environment axiom",
    rests: "A5's latency half: a message posted before the freeze is processed before the bound",
    closedBy: PLAN_ALL,
    assumptions: ["A1", "A2", "notA3", "A4", "A5fifo"],
    labels: [...QUIET_START, "other-release:0||", "hears:0:resumed|0:late:resumed-while-held|0:off+remove", ...MIRROR_SEES_HELD, "freeze||", "settle-bound||#bound"],
    term: "pausedAtReadout",
    broken: EXCLUDED_THOUGH_IT_RAN_UNOBSERVED
  },
  {
    // Posted after the freeze, so A5's latency half has nothing to say.
    name: "held at the freeze and at the bound, with its late posted after the freeze, is excluded though it ran unobserved",
    kind: "environment axiom",
    rests: "C1: from the socket to the port's far end, for what the browser emitted before the freeze, within the bound. Not in A1 to A6",
    closedBy: WITH_C1,
    assumptions: PLAN_ALL,
    labels: [...THE_THREAD_S_OWN_RELEASE_REACHES_A_PAUSE, ...MIRROR_SEES_HELD, "freeze||", "hears:0:resumed|0:late:resumed-while-held|0:off+remove", "settle-bound||#bound"],
    term: "pausedAtReadout",
    broken: EXCLUDED_THOUGH_IT_RAN_UNOBSERVED
  },
  {
    // The form the plan did not expect: nothing is on the port at the freeze, so A5's latency half has nothing to say.
    name: "held at the freeze and at the bound, with its resume still on the thread's socket, is excluded though it ran unobserved",
    kind: "environment axiom",
    rests: "C1, as above",
    closedBy: WITH_C1,
    assumptions: PLAN_ALL,
    labels: [...THE_THREAD_S_OWN_RELEASE_REACHES_A_PAUSE, ...MIRROR_SEES_HELD, "freeze||", "settle-bound||#bound"],
    term: "pausedAtReadout",
    broken: EXCLUDED_THOUGH_IT_RAN_UNOBSERVED
  },
  {
    // No late is ever posted: a resume behind the thread's own conclusion is taken for the hold's end, and the install never answered.
    name: "held at the freeze, its hold's bound fires before the resume is heard, and it is excluded though it ran unobserved",
    kind: "environment axiom",
    rests: "the thread hears a session's event within its hold bound. In this trace the resume is behind the pause that set the bound, so this needs a resume at least 3 s on the socket. Not in A1 to A6",
    assumptions: WITH_C1_D1,
    labels: [...THE_THREAD_S_OWN_RELEASE_REACHES_A_PAUSE, ...MIRROR_SEES_HELD, "freeze||", "hold-bound:0|0:installed:none|0:off+remove", "settle-bound||#bound"],
    term: "pausedAtReadout",
    broken: EXCLUDED_THOUGH_IT_RAN_UNOBSERVED
  },
  {
    // The resume goes down with the connection, and the report of that is posted after the freeze, so A5's latency half has nothing to say.
    name: "held at the freeze, the connection closes behind it with the resume on its socket, and it is excluded though it ran unobserved",
    kind: "environment axiom",
    rests: "C1 read as one bound on the socket and the port together: the connection does not close on what the browser emitted before the freeze. Not in A1 to A6",
    closedBy: WITH_C1,
    assumptions: PLAN_ALL,
    labels: [...THE_THREAD_S_OWN_RELEASE_REACHES_A_PAUSE, ...MIRROR_SEES_HELD, "freeze||", "connection-closes|0:lost|", "settle-bound||#bound"],
    term: "pausedAtReadout",
    broken: EXCLUDED_THOUGH_IT_RAN_UNOBSERVED
  },
  {
    // Empty in the model's alphabet, where discovery is a free step that this trace never takes. Production reads the page connection's
    // discovery after the frame tree, and a worker it found with no report lands `unattached`, unread. So in no term needs the frame tree
    // ahead of a report on the port and ahead of the discovery, on the page's own connection. A review never saw that order on Chromium,
    // macOS and Linux arm64: the tree ahead of a report already on the port 0 of 1,114, and with the worker run before the call, the
    // discovery ahead of the tree 519 of 519 and no term 0. Ordering inside Chromium was run there, not read. D1 closes the trace in the
    // model, but D1 speaks of the thread's posts, and in the review's flood runs the tree beat exactly those with nothing in no term.
    name: "a worker that ran, whose attach is on the port when the frame tree answers, lands in no term",
    kind: "environment axiom",
    rests: "the page's connection delivers its discovery of the worker ahead of its answer to the frame tree, one order on one connection, never seen otherwise in a review's runs. Not in A1 to A6",
    closedBy: WITH_D1,
    assumptions: PLAN_ALL,
    labels: ["born:0:waiting||", "other-release:0||", "reaches-main:0:ran||", ATTACH, "freeze||#drain"],
    term: "nowhere",
    broken: ["a-worker-that-ran-before-the-freeze-lands-in-a-term"]
  },
  {
    // Outside the property's domain, which asks only while the attacher lives. Pinned for what happens.
    name: "a worker whose attach went down with the connection, which ran when Chromium let it, lands in no term",
    kind: "environment axiom",
    rests: "discovery reaches the page's channel before the frame tree answers, and stands for it as unattached",
    assumptions: PLAN_ALL,
    labels: ["born:0:waiting||", "connection-closes|0:lost|", "freeze||#drain"],
    term: "nowhere",
    broken: []
  }
];

for (const { name, kind, rests, closedBy, assumptions, labels, term, broken } of PINS) {
  test(`open (F4, ${kind}): ${name}, which rests on ${rests}`, async () => {
    const known = built(HOLD_WORLD);
    if (closedBy) assert.throws(() => walk(known, closedBy, labels), /no transition/);
    const path = walk(known, assumptions, labels);
    const landing = known.model.termsOf(path.keys[path.keys.length - 1])[0];
    assert.equal(landing.term, term);
    assert.deepEqual(judged(landing), broken);
    // The real code, held to the model's landing, with no property required of it.
    await underReplayClock((clock) => replayPath(clock, PRODUCTION_MODULES, known, path, new Set()));
    for (const property of broken) await assertCaughtBy(name, property, () => underReplayClock((clock) => replayPath(clock, PRODUCTION_MODULES, known, path, new Set([property]))));
  });
}

test("the named trace asks that the worker ran unobserved: an ordinary hold, which ran with its observer in, is not it, and the same with its install failed is", () => {
  const known = built(HOLD_WORLD);
  const lastBeforeLanding = (pin: Pin) => {
    const { keys } = walk(known, pin.assumptions, pin.labels);
    return keys[keys.length - 2];
  };
  const [ordinary, , , failedInstall] = PINS;
  assert.equal(known.model.namedTraceAt(lastBeforeLanding(ordinary), 0), null);
  assert.deepEqual(known.model.namedTraceAt(lastBeforeLanding(failedInstall), 0), { form: "held", cause: "thread-concluded-first" });
});

/**
 * Open (A3), pinned the same way, and the plan's own note: if a detach can overtake a resume it
 * can overtake a last emission, and such a worker reads whole while missing what it emitted last.
 * Implementation resting on an environment axiom: fingerprint-observer@12 reads a gone worker from
 * its stream. Whether a detach overtakes is the plan's ordering study, not measured. It can reach
 * a saved report, as a read that is short of the worker's last task.
 */
test("open (A3): a worker whose detach overtakes its last emission is read at the snapshot before it", async () => {
  const known = built(STREAM_WORLD);
  const labels = ["emits:0:open||", "ends:0||", "hears:0:detach:long|0:detached:other|", "mirror-hears:0:gone-other||", "freeze||#drain"];
  const path = walk(known, without("notA3"), labels);
  const landing = known.model.termsOf(path.keys[path.keys.length - 1])[0];
  assert.deepEqual([landing.term, landing.readSeq, landing.realmAtFreeze], ["readable", 1, 2]);
  await assertCaughtBy("the detach first", "a-read-state-is-no-older-than-the-freeze", () => underReplayClock((clock) => replayPath(clock, PRODUCTION_MODULES, known, path, new Set<Property>(["a-read-state-is-no-older-than-the-freeze"]))));
  // The same order with no overtaking is no transition at all.
  assert.throws(() => walk(known, PLAN_ALL, labels), /no transition/);
});

/**
 * Open (F4, environment axiom), and the other way a report lands in no term, through the real code.
 * With the page's channel lost at the freeze, `currentFrameTrees` comes back at once as none, so the
 * readout classifies in the call's own microtasks, and a report on the port never lands. Outside the
 * model: it has no lost page channel. By reading: a worker lands in no term only if the readout
 * classifies before its report crosses and before the page's connection has delivered its discovery,
 * and it classifies only behind the frame trees, so this, the frame tree answering ahead of both
 * (above), and a report that never comes because the thread or its connection went down, are the
 * ways. The one a review saw on Chromium is this one, 20 of 20. A session that never was comes with
 * no shared visit (lib/scanner.ts), so no report to lose.
 */
test("open (F4, environment axiom): with the page's channel lost at the freeze, a worker that ran, with its attach on the port, lands in no term", async () => {
  await underReplayClock(async (clock) => {
    const whole = await WholeReplay.open(clock, PRODUCTION_MODULES, 1);
    try {
      await whole.thread.hearFreely("hears:0:attach:waiting");
      assert.equal(whole.thread.port.length, 1);
      whole.main.closeThePageChannel();
      await whole.main.freeze();
      const landed = whole.main.landed();
      assert.ok(landed, "the readout waits for nothing with no page to read");
      assert.deepEqual([landed.diagnostics.sharedWorkers.attached, landed.diagnostics.sharedWorkers.unattached, landed.unreadRealms], [0, 0, 0]);
      assert.equal(whole.thread.port.length, 1, "its report never crossed");
    } finally {
      whole.close();
    }
  });
});

/**
 * Open (F4, implementation), the second pass again, with another worker holding the drain open, and
 * the plainest form of it: the drain ends on what it waited for, with the attacher alive. Its docblock
 * says "whatever it did came after the call, unless it was not held at its main script". Under C1 and
 * D1 too, so no latency bound closes it: the reports do arrive before the bound.
 */
test("open (F4, implementation): attached after the freeze by the mirror's clock, released, and excluded, though it ran before the freeze, with another worker's drain open", async () => {
  const known = built(TWO_WORKER_WORLD);
  const reach = reachable(known.graph, maskOf(WITH_C1_D1));
  let found: TracedPath | null = null;
  for (let state = 0; state < reach.seen.length && found === null; state += 1) {
    if (reach.seen[state] === 0 || !known.model.ranButAttachedAfterTheFreeze(known.graph.keys[state], 0)) continue;
    for (let edge = known.graph.firstEdge[state]; edge < known.graph.firstEdge[state + 1]; edge += 1) {
      const key = known.graph.keys[known.graph.edgeTo[edge]];
      const label = known.graph.labels[known.graph.edgeLabel[edge]];
      if ((known.graph.edgeBlockedBy[edge] & maskOf(WITH_C1_D1)) !== 0 || !known.model.isFinished(key) || !label.endsWith("#drain")) continue;
      const [landing] = known.model.termsOf(key);
      if (landing.term !== "pausedAtReadout" || !landing.attacherLives) continue;
      const to = keysAndLabelsTo(known, reach, state);
      found = { labels: [...to.labels, label], keys: [...to.keys, key] };
      break;
    }
  }
  assert.notEqual(found, null, "the world has no such trace, ending by the drain with the attacher alive");
  const path = found as TracedPath;
  await assertCaughtBy("attached after the freeze", "excluded-implies-no-page-code-before-the-freeze", () => underReplayClock((clock) => replayPath(clock, PRODUCTION_MODULES, known, path, new Set<Property>(["excluded-implies-no-page-code-before-the-freeze"]))));
});

/**
 * Open (dedicated), implementation. The readout counts an attached worker with no record as held,
 * and the channel takes a detach before its resume as dying paused, and neither reads
 * `waitingForDebugger`: A4 speaks of a held worker, and this one was already running when it
 * attached. The window is the recursion's arming, one round trip, and the second form is final:
 * gone in that window, it is excluded at every later readout. It can reach a saved report as a
 * worker that is no unread realm. How often a dedicated worker attaches already running is not
 * measured. "Already running when it attached" reads `attachedLate` in the terms' docblock, so
 * the change is one word of evidence and an epoch: the owner's call.
 */
test("open (dedicated): a worker already running when it attached is excluded inside the arming's round trip", async () => {
  const { model, graph } = dedicated();
  const pinned = [
    { steps: ["born:running", "hears-attach:running", "freeze"], term: "pausedAtReadout" },
    { steps: ["born:running", "ends", "hears-attach:running", "hears-detach", "arm-answered", "freeze"], term: "diedPaused" }
  ];
  for (const { steps, term } of pinned) {
    let at = 0;
    for (const name of steps) {
      let next = -1;
      for (let edge = graph.firstEdge[at]; edge < graph.firstEdge[at + 1]; edge += 1) {
        if (graph.labels[graph.edgeLabel[edge]].split("|")[0] === name && (graph.edgeBlockedBy[edge] & maskOf(["A4"])) === 0) next = graph.edgeTo[edge];
      }
      assert.notEqual(next, -1, name);
      at = next;
    }
    assert.equal(model.termOf(graph.keys[at]), term);
    await assertCaughtBy(term, "a-dedicated-worker-excluded-ran-no-page-code-before-the-freeze", () =>
      underReplayClock(async (clock) => {
        const replay = new DedicatedReplay(clock, productionRealm);
        try {
          await replay.open();
          for (const name of steps) if (!/^(born|ends)/.test(name)) await replay.step(name);
          replay.checkLanding(term, [model.truthOf(graph.keys[at])], new Set<DedicatedProperty>(["a-dedicated-worker-excluded-ran-no-page-code-before-the-freeze"]), () => steps);
        } finally {
          replay.close();
        }
      })
    );
  }
});

// ---------------------------------------------------------------------------------------
// Variants, each caught under its name. Production passes each of these checks above.
// ---------------------------------------------------------------------------------------

const realmPath = require.resolve("./worker-fingerprint-realm");
const attacherPath = require.resolve("./shared-worker-attacher");
const channelPath = require.resolve("./devtools-worker-channel");
const realmVariant = (edits: readonly SourceEdit[]) => loadVariant<typeof productionRealm>(realmPath, edits);
const attacherVariant = (edits: readonly SourceEdit[]) => loadVariant<typeof productionAttacher>(attacherPath, edits);

const FREEZE_DIED_HELD: SourceEdit = { find: 'if (worker.detachedWhilePaused)\n        return { record, state: "unread", reason: "diedHeld" };\n    // Held as far as', replace: 'if (worker.detachedWhilePaused)\n        return { record, state: "excluded", reason: "pausedAtReadout" };\n    // Held as far as' };
const RESOLVE_DIED_HELD: SourceEdit = { find: 'if (worker.detachedWhilePaused)\n        return { record, state: "unread", reason: "diedHeld" };\n    return { record, state: "excluded", reason: "pausedAtReadout" };', replace: 'return { record, state: "excluded", reason: "pausedAtReadout" };' };
const FREEZE_LOST: SourceEdit = { find: 'if (record.lostWithChannel)\n        return { record, state: "unread", reason: "channelLostAlive" };\n    // Gone held with', replace: "// Gone held with" };
const REACHING_LOST: SourceEdit = { find: 'if (record.lostWithChannel)\n        return { record, state: "unread", reason: "channelLostAlive" };\n    // Paused at its main script after', replace: "// Paused at its main script after" };
const HELD_LOST: SourceEdit = { find: 'if (worker.hold === "held" && record.lostWithChannel)\n        return { record, state: "unread", reason: "channelLostAlive" };\n', replace: "" };

/** The kernels' own variants, each against the model, under a set where production keeps the property. */
const KERNEL_VARIANTS: readonly { name: string; property: Property; world: SharedWorld; assumptions: readonly Assumption[]; edits: readonly SourceEdit[] }[] = [
  { name: "the @11 shared rule is restored: a worker gone held is excluded", property: "excluded-implies-no-page-code-before-the-freeze", world: SMALL_WORLD, assumptions: ["Z"], edits: [FREEZE_DIED_HELD, RESOLVE_DIED_HELD] },
  { name: "lostWithChannel is ignored: a worker the closed channel left running reads as held", property: "excluded-implies-no-page-code-before-the-freeze", world: SMALL_WORLD, assumptions: ["Z"], edits: [FREEZE_LOST, REACHING_LOST, HELD_LOST] },
  { name: "a worker the mirror knows is late is excluded", property: "excluded-implies-no-unobserved-page-code-before-the-freeze", world: SMALL_WORLD, assumptions: ["Z"], edits: [{ find: 'if (worker.hold === "late")\n        return { record, state: "unread", reason: "attachedLate" };\n    if (worker.hold === "pending") {', replace: 'if (worker.hold === "late")\n        return { record, state: "excluded", reason: "pausedAtReadout" };\n    if (worker.hold === "pending") {' }] },
  { name: "a running worker's last word at the call is its state, with no barrier", property: "a-read-state-is-no-older-than-the-freeze", world: STREAM_WORLD, assumptions: ["A1", "notA3", "A5fifo"], edits: [{ find: 'if (!record.worker.detached)\n        return { record, state: "running" };\n', replace: "" }] },
  { name: "a worker gone with no pause, past the bound, is read as ended at once", property: "at-12-only-moves-toward-unread", world: SMALL_WORLD, assumptions: [], edits: [{ find: '// saw it run and its life fits the bound.\n            return (0, shared_worker_attacher_1.sharedWorkerEndedAtOnce)(worker)\n                ? { record, state: "ended-at-once" }\n                : { record, state: "unread", reason: "unreached" };', replace: '// saw it run and its life fits the bound.\n            return { record, state: "ended-at-once" };' }] }
];

for (const { name, property, world, assumptions, edits } of KERNEL_VARIANTS) {
  test(`the model catches a variant of the kernels: ${name}`, async () => {
    checkModel(PRODUCTION_KERNELS, world, assumptions, property);
    await assertCaughtBy(name, property, () => checkModel(realmVariant(edits) as unknown as Kernels, world, assumptions, property));
  });
}

test("the @11 rule, in the real readout, is caught by the world's facts on a worker that ran and went away held", async () => {
  const known = built(HOLD_WORLD);
  const assumptions: Assumption[] = ["A5fifo", "Z"];
  const reach = reachable(known.graph, maskOf(assumptions));
  let found = -1;
  for (let state = 0; state < reach.seen.length && found === -1; state += 1) {
    if (reach.seen[state] === 0 || !known.model.isFinished(known.graph.keys[state])) continue;
    const [landing] = known.model.termsOf(known.graph.keys[state]);
    if (landing.term === "diedHeld" && landing.ranAtFreeze) found = state;
  }
  assert.notEqual(found, -1, "the world has no such trace");
  const path = keysAndLabelsTo(known, reach, found);
  const property: Property = "excluded-implies-no-page-code-before-the-freeze";
  await underReplayClock((clock) => replayPath(clock, PRODUCTION_MODULES, known, path, new Set([property])));
  const variant: Modules = { attacher: productionAttacher, realm: realmVariant([FREEZE_DIED_HELD, RESOLVE_DIED_HELD]) };
  await assertCaughtBy("the @11 rule", property, () => underReplayClock((clock) => replayPath(clock, variant, known, path, new Set([property]))));
});

test("what the @11 rule rests on: in the small world, only on no detach overtaking; in the hold world, on A1 and A2 too, where @12 needs neither", () => {
  const variant = realmVariant([FREEZE_DIED_HELD, RESOLVE_DIED_HELD]) as unknown as Kernels;
  checkModel(variant, SMALL_WORLD, ["Z", "notA3"], "excluded-implies-no-page-code-before-the-freeze");
  const universe = maskOf(["A1", "A2", "notA3", "A5fifo", "Z"]);
  assert.deepEqual(smallestSets([build(HOLD_WORLD, variant)], "excluded-implies-no-page-code-before-the-freeze", universe), [["A1", "A2", "notA3", "A5fifo", "Z"]]);
  assert.deepEqual(smallestSets([built(HOLD_WORLD)], "excluded-implies-no-page-code-before-the-freeze", universe), [["A5fifo", "Z"]]);
});

/** The thread's own variants: the edit is in the bytes the thread runs, and the sequences it hears go through it. */
const NO_LATE_ON_A_BROKEN_HOLD: readonly SourceEdit[] = [{ find: 'post({ type: "late", contextId: worker.contextId, sessionId: worker.sessionId, reason: "resumed-while-held" });', replace: "" }];
const NO_RESUME_BREAKS_A_HOLD: readonly SourceEdit[] = [{ find: 'if (worker.hold !== "held" || worker.installConcluded)', replace: "if (true)" }];
const THREAD_VARIANTS: readonly { name: string; property: string; edits: readonly SourceEdit[] }[] = [
  { name: "a broken hold's late is never posted", property: "replay-the-thread-posts-what-the-model-says", edits: NO_LATE_ON_A_BROKEN_HOLD },
  { name: "a late first pause is never posted", property: "replay-the-thread-posts-what-the-model-says", edits: [{ find: 'post({ type: "late", contextId: worker.contextId, sessionId: worker.sessionId, reason });', replace: "" }] },
  { name: "a resume breaks no hold at all", property: "replay-the-thread-posts-what-the-model-says", edits: NO_RESUME_BREAKS_A_HOLD },
  { name: "@11's thread: every detach while held is died held", property: "replay-the-thread-posts-what-the-model-says", edits: [{ find: 'diedWhileHeld: worker.hold === "held" && !worker.installConcluded,', replace: 'diedWhileHeld: worker.hold === "held",' }, { find: 'diedAfterInstall: worker.hold === "held" && worker.installConcluded,', replace: "diedAfterInstall: false," }] },
  { name: "a script seen does not stop a worker reading as never reached", property: "replay-the-thread-posts-what-the-model-says", edits: [{ find: 'endedUnreached: worker.hold === "pending" && worker.scripts.size === 0', replace: 'endedUnreached: worker.hold === "pending"' }] },
  { name: "the release goes out before the breakpoint", property: "replay-the-thread-sends-what-the-model-says", edits: [{ find: 'setBreakpoint();\n        send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);', replace: 'send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);\n        setBreakpoint();' }] },
  { name: "a parse ahead of the breakpoint's answer sends no probe", property: "replay-the-thread-sends-what-the-model-says", edits: [{ find: 'send("Runtime.getIsolateId", {}, worker.sessionId).then(() => markLate(worker, "ran-before-breakpoint", true), () => undefined);', replace: "" }] }
];

for (const { name, property, edits } of THREAD_VARIANTS) {
  test(`the replay catches a variant of the thread: ${name}`, async () => {
    const known = built(HOLD_WORLD);
    const automaton = heardBy(known, maskOf(["A1"]), "thread");
    const variant = attacherVariant(edits);
    await assertCaughtBy(name, property, () => replayThread(variant, HOLD_WORLD, inputSequences(automaton)));
  });
}

/** A run of edges heard by the real thread alone: a barrier's round trip by the worker its step names, and every other step by its word. */
async function threadHearsEdges(thread: ThreadSide, edges: readonly InputEdge[], input: () => unknown): Promise<void> {
  for (const edge of edges) {
    for (const step of edge.steps) {
      if (step.name.startsWith("barrier-round-trip")) await thread.barrierRoundTrip(Number(step.name.split(":")[1]), input);
      else await thread.hear(step, input);
    }
  }
}

type Delivery = { route: readonly InputEdge[]; word: string; forwarded: boolean; wayOn: readonly InputEdge[] };

/**
 * Every delivery the check owes, planned before any is made: each word the model drops at each
 * state of what the thread hears, then every way on that a cover from that state takes, so that
 * every transition from there on follows the word in some delivery. A state stands for its
 * members, which share the thread's fields, and a finished one has dropped them.
 */
function droppedWordPlan(known: Built, automaton: InputAutomaton): Delivery[] {
  const routes = new Map<number, InputEdge[]>([[0, []]]);
  for (const [state, route] of routes) for (const edge of automaton.edges[state]) if (!routes.has(edge.to)) routes.set(edge.to, [...route, edge]);
  const plan: Delivery[] = [];
  for (const [state, route] of routes) {
    const member = automaton.members[state].find((candidate) => !known.model.isFinished(known.graph.keys[candidate]));
    if (member === undefined) continue;
    const cover = inputCover(automaton, state);
    for (const { word, forwarded } of known.model.wordsIgnoredAt(known.graph.keys[member], 0)) {
      for (const wayOn of cover.length > 0 ? cover : [[]]) plan.push({ route, word, forwarded, wayOn });
    }
  }
  return plan;
}

/** Every delivery planned reached the real thread: counted by the thread side, not by the loop that made them. */
function assertDeliveredEveryDroppedWord(delivered: number, planned: number, world: string): void {
  holds("replay-every-dropped-word-was-delivered", delivered === planned, () => ({ delivered, planned, world }));
}

/**
 * The model drops a word the thread would make nothing of, from that state on whatever comes,
 * which is what keeps it small, so no trace above delivers one. Here each is delivered to the real
 * thread at each state of what it hears, with A1 assumed. Nothing may come out, and the trace goes
 * on through every transition from that state, its later outputs compared, so that a word that
 * changed what the thread keeps shows wherever it would. A late worker's own stream is the
 * exception the thread has: it forwards it. Returns the words that reached the thread.
 */
async function checkDroppedWords(attacher: AttacherModule, worlds: readonly SharedWorld[] = [HOLD_WORLD]): Promise<Set<string>> {
  const heardWords = new Set<string>();
  for (const world of worlds) {
    const known = built(world);
    const plan = droppedWordPlan(known, heardBy(known, maskOf(["A1"]), "thread"));
    let delivered = 0;
    await underReplayClock(async (clock) => {
      for (const { route, word, forwarded, wayOn } of plan) {
        const input = () => ({ world: world.name, word, route: route.map((edge) => edge.input), wayOn: wayOn.map((edge) => edge.input) });
        const thread = new ThreadSide(clock, attacher, { sinkName: "sink", capability: "capability" });
        try {
          await thread.open();
          await thread.registerAlone();
          thread.holdPort();
          for (const step of prefixSteps(world, threadHearsStep)) await thread.hear(step, input);
          await threadHearsEdges(thread, route, input);
          await thread.hearDroppedWord(0, word, forwarded ? [`0:event:${word}`] : [], input);
          await threadHearsEdges(thread, wayOn, input);
          delivered += thread.droppedWordsHeard.length;
          for (const heard of thread.droppedWordsHeard) heardWords.add(heard);
        } finally {
          thread.close();
        }
      }
    });
    assertDeliveredEveryDroppedWord(delivered, plan.length, world.name);
  }
  return heardWords;
}

test("replay: each word the model drops, the real thread makes nothing of, from that state on through every transition, in the hold and stream worlds", async () => {
  const delivered = await checkDroppedWords(productionAttacher, [HOLD_WORLD, STREAM_WORLD]);
  for (const word of EVERY_DROPPED_WORD) holds("replay-every-dropped-word-was-delivered", delivered.has(word), () => ({ word, delivered: [...delivered].sort() }));
  // And no word the list here does not name: a new one has to be looked at.
  assert.deepEqual([...delivered].sort(), EVERY_DROPPED_WORD);
});

test("the replay catches a variant of the thread: a resume, or a pause at a statement, behind the install's answers breaks the hold", async () => {
  const variant = attacherVariant([{ find: 'if (worker.hold !== "held" || worker.installConcluded)', replace: 'if (worker.hold !== "held")' }]);
  await assertCaughtBy("behind the answers", "replay-the-thread-posts-what-the-model-says", () => checkDroppedWords(variant));
});

const A_RESUME_BEHIND_THE_ANSWERS = 'if (method === "Debugger.resumed") {';

// Each of these changes nothing at the step that delivers the word, and something later, some only several steps on.
for (const [name, edits] of [
  ["a resume behind the install's answers quietly forgets them, so a detach after it reads as gone held", [{ find: A_RESUME_BEHIND_THE_ANSWERS, replace: 'if (method === "Debugger.resumed" && worker.installConcluded) {\n            worker.installConcluded = false;\n            return;\n        }\n        if (method === "Debugger.resumed") {' }]],
  ["a pause on a late worker quietly returns it to pending, so a detach after it reads as never reached", [{ find: '// Only the first pause decides. A pause after a late classification is\n            // resumed by the debugger going off.\n            if (worker.hold !== "pending")\n                return;', replace: '// Only the first pause decides. A pause after a late classification is\n            // resumed by the debugger going off.\n            if (worker.hold === "late") {\n                worker.hold = "pending";\n                return;\n            }\n            if (worker.hold !== "pending")\n                return;' }]],
  [
    "a resume behind the install's answers quietly makes the release say the debugger stayed on, which only the disable's answer shows",
    [
      { find: A_RESUME_BEHIND_THE_ANSWERS, replace: 'if (method === "Debugger.resumed" && worker.installConcluded) {\n            worker.sawResume = true;\n            return;\n        }\n        if (method === "Debugger.resumed") {' },
      { find: "holdMs: clock() - pausedAt,\n                    debuggerOff\n", replace: "holdMs: clock() - pausedAt,\n                    debuggerOff: debuggerOff && !worker.sawResume\n" }
    ]
  ],
  [
    // The wrong state is read only by a detach after the release, two steps on from the word, so a continuation of one step passes it.
    "a resume behind the install's answers is quietly kept, and a detach after the release then reads as gone after its install",
    [
      { find: A_RESUME_BEHIND_THE_ANSWERS, replace: 'if (method === "Debugger.resumed" && worker.installConcluded && worker.hold === "held") {\n            worker.sawResume = true;\n            return;\n        }\n        if (method === "Debugger.resumed") {' },
      { find: 'diedAfterInstall: worker.hold === "held" && worker.installConcluded,', replace: 'diedAfterInstall: (worker.hold === "held" && worker.installConcluded) || (worker.hold === "released" && worker.sawResume === true),' }
    ]
  ],
  [
    "a resume behind the install's answers quietly stops the worker's stream, which only its next emission shows",
    [
      { find: A_RESUME_BEHIND_THE_ANSWERS, replace: 'if (method === "Debugger.resumed" && worker.installConcluded) {\n            worker.muted = true;\n            return;\n        }\n        if (method === "Debugger.resumed") {' },
      { find: 'if (method === "Runtime.bindingCalled") {', replace: 'if (method === "Runtime.bindingCalled" && worker.muted !== true) {' }
    ]
  ]
] as const) {
  test(`the replay catches a variant of the thread by going on past a dropped word: ${name}`, async () => {
    const variant = attacherVariant(edits);
    await assertCaughtBy(name, "replay-the-thread-posts-what-the-model-says", () => checkDroppedWords(variant));
  });
}

test("the replay catches a variant of the thread: a pause at a statement after the install's answers breaks the hold", async () => {
  const variant = attacherVariant([{ find: 'if (worker.hold === "held" && params.reason !== "instrumentation") {', replace: 'if (worker.hold === "held" && params.reason !== "instrumentation") {\n                worker.installConcluded = false;' }]);
  await assertCaughtBy("a statement after the answers", "replay-the-thread-posts-what-the-model-says", () => checkDroppedWords(variant));
});

/** Words the model's alphabet has no room for, and bounds it has no clock for, through the real thread by hand. */
async function byHand(attacher: AttacherModule, run: (thread: ThreadSide, input: () => unknown) => Promise<void>, options: { theThreadsOwnBounds?: boolean } = {}): Promise<void> {
  await underReplayClock(async (clock) => {
    const thread = new ThreadSide(clock, attacher, { sinkName: "sink", capability: "capability" }, options);
    try {
      await thread.open();
      await thread.registerAlone();
      thread.holdPort();
      await run(thread, () => "by hand");
    } finally {
      thread.close();
    }
  });
}

const heard = (word: string, posts: string[] = [], sends: string[] = []): Step => ({ name: `hears:0:${word}`, posts, sends, ended: null });
const ATTACHED = heard("attach:waiting", ["0:attached:waiting"], ["0:arm", "0:run"]);

const HAND_STATED: readonly { name: string; property: string; run: (thread: ThreadSide, input: () => unknown) => Promise<void>; edits: readonly SourceEdit[] }[] = [
  {
    name: "a parse of another script ahead of the breakpoint's answer sends no probe",
    property: "replay-the-thread-sends-what-the-model-says",
    run: async (thread, input) => {
      await thread.hear(ATTACHED, input);
      await thread.hear(heard("parsed-another-script"), input);
      await thread.hear(heard("ack"), input);
    },
    edits: [{ find: 'if (url === worker.url && worker.hold === "pending" && !worker.breakpointAcknowledged) {', replace: 'if (worker.hold === "pending" && !worker.breakpointAcknowledged) {' }]
  },
  {
    name: "a pause that names only its script is found by the script's parse, and held",
    property: "replay-the-thread-posts-what-the-model-says",
    run: async (thread, input) => {
      await thread.hear(ATTACHED, input);
      await thread.hear(heard("ack"), input);
      await thread.hear(heard("parsed"), input);
      await thread.hear(heard("pause-main-naming-only-its-script", ["0:held"], ["0:install"]), input);
    },
    edits: [{ find: 'typeof pauseData.url === "string" ? pauseData.url : scriptId !== null ? worker.scripts.get(scriptId) : undefined;', replace: 'typeof pauseData.url === "string" ? pauseData.url : undefined;' }]
  },
  {
    name: "a detach cancels the hold's bound, so it fires on nothing",
    property: "replay-the-thread-posts-what-the-model-says",
    run: async (thread, input) => {
      await thread.hear(ATTACHED, input);
      await thread.hear(heard("ack"), input);
      await thread.hear(heard("parsed"), input);
      await thread.hear(heard("pause-main", ["0:held"], ["0:install"]), input);
      await thread.hear(heard("detach:long", ["0:detached:held"]), input);
      await thread.fireTheHoldBound(0, input);
    },
    edits: [A_DETACH_LEAVES_THE_HOLD_BOUND_RUNNING]
  },
  {
    // Also a dropped word at a state the check above reaches; stated here so that no way of choosing states can lose it.
    name: "an install's answer behind a broken hold posts nothing: the hold was already found late",
    property: "replay-the-thread-posts-what-the-model-says",
    run: async (thread, input) => {
      await thread.hear(ATTACHED, input);
      await thread.hear(heard("ack"), input);
      await thread.hear(heard("parsed"), input);
      await thread.hear(heard("pause-main", ["0:held"], ["0:install"]), input);
      await thread.hear(heard("resumed", ["0:late:resumed-while-held"], ["0:off+remove"]), input);
      await thread.hearDroppedWord(0, "install-ok", [], input);
    },
    edits: [{ find: 'if (concluded || worker.hold !== "held")\n                return;', replace: "if (concluded)\n                return;" }]
  },
  {
    name: "a visit may ask a worker for its barrier and for nothing else",
    property: "replay-the-thread-sends-what-the-model-says",
    run: async (thread, input) => {
      await thread.hear(ATTACHED, input);
      await thread.asksForAnotherCommand(0, input);
    },
    edits: [{ find: 'if (!worker || worker.contextId !== contextId || method !== "Runtime.getIsolateId") {', replace: "if (!worker || worker.contextId !== contextId) {" }]
  }
];

for (const { name, property, run, edits } of HAND_STATED) {
  test(`by hand, through the real thread: ${name}`, async () => {
    await byHand(productionAttacher, run);
    await assertCaughtBy(name, property, () => byHand(attacherVariant(edits), run));
  });
}

test("by hand, through the real thread: a hold's bound is 3 seconds when nothing else is asked", async () => {
  await byHand(
    productionAttacher,
    async (thread, input) => {
      await thread.hear(ATTACHED, input);
      await thread.hear(heard("ack"), input);
      await thread.hear(heard("parsed"), input);
      await thread.hear(heard("pause-main", ["0:held"], ["0:install"]), input);
      // In seconds: the claim is its order, and nothing here reads a millisecond of it.
      assert.equal(Math.round((thread.holdBoundLength(0) as number) / 1_000), 3);
    },
    { theThreadsOwnBounds: true }
  );
});

/**
 * The same thread variants, judged by the world and not by the model's word, so that what they
 * break is named: the whole real path, with a broken hold scripted, a resume ahead of the install's
 * late answer. The worker ran with no observer, as the world says. Production reads it unread.
 */
async function brokenHold(modules: Modules, mustHold: Property): Promise<void> {
  await underReplayClock(async (clock) => {
    const whole = await WholeReplay.open(clock, modules, 1);
    try {
      for (const name of ["hears:0:attach:waiting", "hears:0:ack", "hears:0:parsed", "hears:0:pause-main", "hears:0:resumed", "hears:0:first", "hears:0:install-ok", "hears:0:off-answer"]) await whole.thread.hearFreely(name);
      await whole.crossEverything();
      await whole.main.freeze();
      // A worker the variant let the mirror take as released is read: its barrier goes there and back.
      if (whole.thread.barrierRequests.length > 0) {
        await whole.thread.barrierRoundTrip(0, () => "a broken hold");
        await whole.crossEverything();
      }
      await whole.main.settleBound();
      whole.main.checkLanding([[{ term: "attachedLate", readSeq: 0, ranAtFreeze: true, ranUnobservedAtFreeze: true, ranUnobserved: true, attacherLives: true, realmAtFreeze: 1, movedFromAt11: "no" }]], new Set([mustHold]), () => "a broken hold");
    } finally {
      whole.close();
    }
  });
}

test("the world's facts catch a thread that drops a broken hold's late, as a worker excluded though it ran unobserved", async () => {
  await brokenHold(PRODUCTION_MODULES, "excluded-implies-no-unobserved-page-code-before-the-freeze");
  const variant: Modules = { attacher: attacherVariant(NO_LATE_ON_A_BROKEN_HOLD), realm: productionRealm };
  await assertCaughtBy("the late is dropped", "excluded-implies-no-unobserved-page-code-before-the-freeze", () => brokenHold(variant, "excluded-implies-no-unobserved-page-code-before-the-freeze"));
});

test("the world's facts catch a thread that takes no resume for a broken hold, as a worker read though it ran unobserved", async () => {
  await brokenHold(PRODUCTION_MODULES, "read-implies-the-observer-preceded-every-statement");
  const variant: Modules = { attacher: attacherVariant(NO_RESUME_BREAKS_A_HOLD), realm: productionRealm };
  await assertCaughtBy("no resume breaks a hold", "read-implies-the-observer-preceded-every-statement", () => brokenHold(variant, "read-implies-the-observer-preceded-every-statement"));
});

/** A worker running when it attached, whose late the mirror has heard: it ran before the freeze, and the world says so. */
async function ranAndLate(modules: Modules): Promise<void> {
  await underReplayClock(async (clock) => {
    const whole = await WholeReplay.open(clock, modules, 1);
    try {
      await whole.thread.hearFreely("hears:0:attach:running");
      await whole.crossEverything();
      await whole.main.freeze();
      whole.main.checkLanding([[{ term: "attachedLate", readSeq: 0, ranAtFreeze: true, ranUnobservedAtFreeze: true, ranUnobserved: true, attacherLives: true, realmAtFreeze: 0, movedFromAt11: "no" }]], new Set<Property>(["a-worker-that-ran-before-the-freeze-lands-in-a-term"]), () => "a worker running at its attach");
    } finally {
      whole.close();
    }
  });
}

test("the world's facts catch a readout that lands a worker in no term, as one that ran before the freeze", async () => {
  await ranAndLate(PRODUCTION_MODULES);
  const variant: Modules = { attacher: productionAttacher, realm: realmVariant([{ find: "shared[landed.term] += 1;", replace: 'if (landed.term !== "attachedLate") shared[landed.term] += 1;' }]) };
  await assertCaughtBy("a late worker lands in no term", "a-worker-that-ran-before-the-freeze-lands-in-a-term", () => ranAndLate(variant));
});

async function mainUnder(modules: Modules, world: SharedWorld, assumptions: readonly Assumption[]): Promise<void> {
  const known = built(world);
  const mask = maskOf(assumptions);
  const automaton = heardBy(known, mask, "main");
  await replayMain(modules, known, automaton, inputSequences(automaton), keptUnder(known, mask));
}

/** That production passes the check a variant is held to, once for each check. */
const controlled = new Set<string>();
async function productionPassesMainUnder(world: SharedWorld, assumptions: readonly Assumption[]): Promise<void> {
  const key = `${world.name}:${assumptions.join()}`;
  if (controlled.has(key)) return;
  await mainUnder(PRODUCTION_MODULES, world, assumptions);
  controlled.add(key);
}

const MIRROR_REWRITE: SourceEdit = { find: 'if (message.diedAfterInstall === true && worker.hold === "held") {', replace: "if (false) {" };
const LATE_TERMINAL: SourceEdit = { find: 'if (worker.hold === "late" && (message.type === "held" || message.type === "installed" || message.type === "released")) {', replace: "if (false) {" };

/** The mirror's and the readout's own variants, against what the main thread hears. */
const MAIN_VARIANTS: readonly { name: string; property: string; world: SharedWorld; assumptions: readonly Assumption[]; attacher?: readonly SourceEdit[]; realm?: readonly SourceEdit[] }[] = [
  { name: "a worker the mirror knows is late is excluded, in the real readout, judged by the world's facts", property: "excluded-implies-no-page-code-before-the-freeze", world: HOLD_WORLD, assumptions: ["A5fifo", "Z"], realm: [{ find: 'if (worker.hold === "late")\n        return { record, state: "unread", reason: "attachedLate" };\n    if (worker.hold === "pending") {', replace: 'if (worker.hold === "late")\n        return { record, state: "excluded", reason: "pausedAtReadout" };\n    if (worker.hold === "pending") {' }] },
  { name: "an install's answer counts with no first snapshot behind it", property: "replay-the-install-counts-what-the-model-says", world: HOLD_WORLD, assumptions: ["A5fifo"], realm: [{ find: "record.lastSeq >= 1 && !record.broken", replace: "!record.broken" }] },
  { name: "the mirror does not rewrite a worker gone after its install", property: "replay-the-mirror-holds-what-the-model-says", world: HOLD_WORLD, assumptions: ["A5fifo"], attacher: [MIRROR_REWRITE] },
  { name: "the mirror forgets a detach while held", property: "replay-the-mirror-holds-what-the-model-says", world: HOLD_WORLD, assumptions: ["A5fifo"], attacher: [{ find: "worker.detachedWhilePaused = message.diedWhileHeld === true;", replace: "worker.detachedWhilePaused = false;" }] },
  { name: "the mirror forgets a worker never reached", property: "replay-the-mirror-holds-what-the-model-says", world: HOLD_WORLD, assumptions: ["A5fifo"], attacher: [{ find: "worker.endedUnreached = message.endedUnreached === true;", replace: "worker.endedUnreached = false;" }] },
  { name: "a held worker does not wait for its next move", property: "replay-the-drain-ends-where-the-model-says", world: HOLD_WORLD, assumptions: ["A5fifo"], realm: [{ find: 'if (realm.state === "held")\n                return this.heldSettled(realm.record);', replace: 'if (realm.state === "held")\n                return true;' }] },
  { name: "a reaching worker does not wait for its first move", property: "replay-the-drain-ends-where-the-model-says", world: HOLD_WORLD, assumptions: ["A5fifo"], realm: [{ find: 'if (reached.state === "reaching")\n                return false;', replace: 'if (reached.state === "reaching")\n                return true;' }] },
  { name: "a discovered worker the attacher never reported is not waited for", property: "replay-the-drain-ends-where-the-model-says", world: HOLD_WORLD, assumptions: ["A5fifo"], realm: [{ find: "if (!reported.has(targetId))\n                    return false;", replace: "if (!reported.has(targetId))\n                    continue;" }] },
  { name: "a late worker lands in another unread term", property: "replay-the-real-readout-lands-where-the-model-says", world: HOLD_WORLD, assumptions: ["A5fifo"], realm: [{ find: 'if (worker.hold === "late")\n        return { record, state: "unread", reason: "attachedLate" };\n    if (worker.hold === "pending") {', replace: 'if (worker.hold === "late")\n        return { record, state: "unread", reason: "unreached" };\n    if (worker.hold === "pending") {' }] },
  { name: "a read worker publishes text it never emitted", property: "replay-the-real-readout-lands-where-the-model-says", world: HOLD_WORLD, assumptions: ["A5fifo"], realm: [{ find: 'if (landed.term === "readable")\n                readableSnapshots.push(landed.snapshot);\n            else if (landed.term === "ownerUnscoped")', replace: 'if (landed.term === "readable")\n                readableSnapshots.push(JSON.stringify({ seq: 1, other: true }));\n            else if (landed.term === "ownerUnscoped")' }] },
  { name: "a worker gone held is no unread realm", property: "replay-the-real-readout-lands-where-the-model-says", world: HOLD_WORLD, assumptions: ["A5fifo"], realm: [{ find: "shared.diedHeld +\n", replace: "" }] },
  { name: "a worker's term is counted twice", property: "every-worker-the-readout-heard-of-lands-in-one-term", world: HOLD_WORLD, assumptions: ["A5fifo"], realm: [{ find: "shared[landed.term] += 1;", replace: "shared[landed.term] += 2;" }] },
  { name: "a late worker lands in no term", property: "every-worker-the-readout-heard-of-lands-in-one-term", world: HOLD_WORLD, assumptions: ["A5fifo"], realm: [{ find: "shared[landed.term] += 1;", replace: 'if (landed.term !== "attachedLate") shared[landed.term] += 1;' }] },
  { name: "a barrier that finds a task open takes the snapshot before it", property: "a-read-state-is-no-older-than-the-freeze", world: STREAM_WORLD, assumptions: ["A1", "notA3", "A5fifo"], realm: [{ find: 'if (record.lastWord === "closed" && record.lastClosed !== null)\n            slot.snapshot = record.lastClosed;', replace: "if (record.lastClosed !== null)\n            slot.snapshot = record.lastClosed;" }] }
];

for (const { name, property, world, assumptions, attacher, realm } of MAIN_VARIANTS) {
  test(`the replay catches a variant of the main thread: ${name}`, async () => {
    const modules: Modules = { attacher: attacher ? attacherVariant(attacher) : productionAttacher, realm: realm ? realmVariant(realm) : productionRealm };
    await productionPassesMainUnder(world, assumptions);
    await assertCaughtBy(name, property, () => mainUnder(modules, world, assumptions));
  });
}

test("the replay catches a variant of the main thread: late is not terminal, once the port is out of order", async () => {
  const known = built(HOLD_WORLD);
  const automaton = heardBy(known, 0, "main");
  const variant: Modules = { attacher: attacherVariant([LATE_TERMINAL]), realm: productionRealm };
  await assertCaughtBy("late is not terminal", "replay-the-mirror-holds-what-the-model-says", () => replayMain(variant, known, automaton, inputCover(automaton), new Set()));
});

test("the whole replay catches a variant of the thread: a report that says more than the main side's own replay words", async () => {
  const known = built(HOLD_WORLD);
  const variant: Modules = { attacher: attacherVariant([{ find: 'post({ type: "held", contextId: worker.contextId, sessionId: worker.sessionId });', replace: 'post({ type: "held", contextId: worker.contextId, sessionId: worker.sessionId, heldAt: 1 });' }]), realm: productionRealm };
  const path = walk(known, PLAN_ALL, [...QUIET_START, ...MIRROR_SEES_HELD, "freeze||", "settle-bound||#bound"]);
  await underReplayClock((clock) => replayPath(clock, PRODUCTION_MODULES, known, path, new Set()));
  await assertCaughtBy("a report says more", "replay-the-port-carries-what-the-model-says", () => underReplayClock((clock) => replayPath(clock, variant, known, path, new Set())));
});

const DEDICATED_HEARS = (name: string) => !/^(born|runs-while-held|ends|resume-lands)/.test(name);

/** The dedicated model over the kernels given, held to one property under the axioms given. */
function checkDedicatedModel(kernels: DedicatedKernels, assumptions: readonly Assumption[], property: DedicatedProperty): void {
  const model = new DedicatedWorkerModel(kernels);
  const graph = model.explore();
  const reach = reachable(graph, maskOf(assumptions));
  for (let state = 0; state < reach.seen.length; state += 1) {
    if (reach.seen[state] === 1) holds(property, (model.verdictOf(graph.keys[state]) & dedicatedPropertyMask(property)) === 0, () => ({ assumptions, trace: pathTo(graph, reach, state) }));
  }
}

test("the model catches a variant of the dedicated kernel: a released worker is excluded", async () => {
  const property: DedicatedProperty = "a-dedicated-worker-held-at-its-attach-and-excluded-ran-no-page-code-before-the-freeze";
  checkDedicatedModel(productionRealm as unknown as DedicatedKernels, ["A4"], property);
  const variant = realmVariant([{ find: 'if (!worker.released)\n        return { record, state: "excluded", reason: "pausedAtReadout" };\n    if (record.install === "attached-late")', replace: 'if (record.install !== "attached-late")\n        return { record, state: "excluded", reason: "pausedAtReadout" };\n    if (record.install === "attached-late")' }]);
  await assertCaughtBy("a released worker is excluded", property, () => checkDedicatedModel(variant as unknown as DedicatedKernels, ["A4"], property));
});

/**
 * A worker the pause bound concluded, which runs with no observer, and whose install answers only then.
 * The world says it ran unobserved. Production keeps it failed and unread.
 */
async function lateAnswerAfterThePauseBound(realm: Modules["realm"]): Promise<void> {
  await underReplayClock(async (clock) => {
    const replay = new DedicatedReplay(clock, realm);
    const steps = ["hears-attach:waiting", "arm-answered", "pause-bound", "install-answered:ok", "freeze", "barrier-answered"];
    try {
      await replay.open();
      for (const name of steps) await replay.step(name);
      replay.checkLanding("installFailed", [{ ranAtFreeze: true, ranUnobserved: true, heldAtAttach: true }], new Set<DedicatedProperty>(["a-dedicated-worker-read-had-the-observer-before-every-statement"]), () => steps);
    } finally {
      replay.close();
    }
  });
}

test("the world's facts catch a dedicated install whose late answer upgrades a worker the pause bound concluded, as a read of one that ran unobserved", async () => {
  await lateAnswerAfterThePauseBound(productionRealm);
  const variant = realmVariant([{ find: "concludeWorker(worker, install) {\n        if (this.settledWorkers.has(worker))\n            return;", replace: "concludeWorker(worker, install) {" }]);
  await assertCaughtBy("a late answer upgrades", "a-dedicated-worker-read-had-the-observer-before-every-statement", () => lateAnswerAfterThePauseBound(variant));
});

test("the replay catches a variant of the dedicated readout: an install's late answer upgrades a worker the pause bound concluded", async () => {
  const { model, graph } = dedicated();
  const automaton = inputAutomaton(graph, maskOf(["A4"]), DEDICATED_HEARS, (step) => step.ended ?? "");
  const variant = realmVariant([{ find: "concludeWorker(worker, install) {\n        if (this.settledWorkers.has(worker))\n            return;", replace: "concludeWorker(worker, install) {" }]);
  await assertCaughtBy("a late answer upgrades", "replay-the-session-holds-what-the-model-says", () => replayDedicated(variant, model, graph, automaton, new Set()));
});

test("the replay catches a variant of the dedicated channel: a detach before the resume is not taken as dying paused", async () => {
  const { model, graph } = dedicated();
  const automaton = inputAutomaton(graph, maskOf(["A4"]), DEDICATED_HEARS, (step) => step.ended ?? "");
  const variant = loadVariant<{ DedicatedWorkerAttachSession: typeof DedicatedWorkerAttachSession }>(channelPath, [{ find: "worker.detachedWhilePaused = !worker.released;", replace: "worker.detachedWhilePaused = false;" }]);
  await assertCaughtBy("no dying paused", "replay-the-real-readout-lands-where-the-model-says", () => replayDedicated(productionRealm, model, graph, automaton, new Set(), variant.DedicatedWorkerAttachSession));
});
