// A hand-written model of the shared-worker hold and the readout over it, with no
// dependency, explored by breadth-first search. lib/fv-worker-model.test.ts holds it to
// its properties and replays its traces through the real attacher thread.
//
// What it is. Every process below is restated here: the browser and the worker, the
// attacher's thread (sharedWorkerAttacherThread in lib/shared-worker-attacher.ts), the
// main-thread mirror (SharedWorkerVisitChannel), and the drain of the readout. Only the
// classification is not: a worker's term comes from the real kernels of
// lib/worker-fingerprint-realm.ts, which are passed in. A restatement can drift, so the
// test replays the model's traces through the real code and fails on any difference.
//
// What it says. For the inputs of its alphabet, under its bounds and under the named
// assumptions, at this commit, each property holds over every reachable state. It says
// nothing about whether Chromium behaves as the assumptions state: those stay measured.
//
// The ground truth is the world's own. RAN and RANU move only when the worker runs in the
// world's process, and no field the mirror or the classifier reads writes them, so a
// property that compares a term with them compares two independent things. The test holds
// that to a fold of the labels alone.
//
// What the replay of it cannot say. The kernels are the real ones on both sides, so replaying
// a trace compares production's classification with itself. That evidence is in
// lib/fv-worker-readout.test.ts, and restating the kernels a third time here would be its own
// defect. The @11 reference below has a second copy in that suite, and nothing binds the two.
//
// No time passes. A bound is an event that may fire anywhere, unless an assumption says
// otherwise.

/**
 * The switches, each of which only removes transitions. The first six are A1 to A5 of the
 * formal plan, with A5's two halves apart. `notA3` is A3's negation, since A3 says what the
 * environment may do and not what it never does: "needs notA3" means a property rests on a
 * detach never overtaking a session's events, which is the ordering study the plan left open.
 *
 * The last three are not axioms. None is in the plan. C1 is the latency the model found missing:
 * what the browser emitted before the freeze, and what the thread posted on hearing it, is
 * processed before the settle bound. D1 is its like for the readout's other wait: all of that is
 * processed before the page's frame tree answers. Neither is a fact of Chromium: in a review's
 * flood runs the thread's posts came 1.2 to 4.7 s after the call against a 500 ms bound, and the
 * frame tree answered ahead of them. Z restates the safety property's own premise: at the freeze,
 * the mirror has heard of every worker born and has its next word for every worker that has run.
 * It says nothing about a browser. It is here so the search can show the property has no other
 * way to fail.
 *
 * Discovery on the page's own connection is a free step here: it may come at any point, or not
 * before the readout ends. Production reads it after the frame tree, and counts a worker it found
 * with no report as `unattached`, which is unread, so the order of those two on that one connection
 * decides whether a worker lands in no term. No switch says that order.
 */
export const ASSUMPTIONS = ["A1", "A2", "notA3", "A4", "A5fifo", "A5bound", "C1", "D1", "Z"] as const;
export type Assumption = (typeof ASSUMPTIONS)[number];

const bit = (assumption: Assumption): number => 1 << ASSUMPTIONS.indexOf(assumption);
export const maskOf = (assumptions: readonly Assumption[]): number => assumptions.reduce((mask, assumption) => mask | bit(assumption), 0);
export const namesOf = (mask: number): Assumption[] => ASSUMPTIONS.filter((assumption) => (mask & bit(assumption)) !== 0);
/** A1 to A5 of the plan, the only switches the table is over. */
export const PLAN_AXIOMS = maskOf(["A1", "A2", "notA3", "A4", "A5fifo", "A5bound"]);

const A1 = bit("A1");
const A2 = bit("A2");
const NOT_A3 = bit("notA3");
const A4 = bit("A4");
const A5_FIFO = bit("A5fifo");
const A5_BOUND = bit("A5bound");
const C1 = bit("C1");
const D1 = bit("D1");
const Z = bit("Z");

/** One transition: what happened, what it costs in assumptions, and where it leads. */
export type Move = { label: string; blockedBy: number; next: number[] };

/** The graph of a world, with every transition any set of assumptions could allow. */
export type Graph = {
  keys: string[];
  labels: string[];
  /** For state i, its edges are firstEdge[i] up to firstEdge[i + 1]. */
  firstEdge: Int32Array;
  edgeTo: Int32Array;
  edgeLabel: Int32Array;
  edgeBlockedBy: Int32Array;
};

export const decode = (key: string): number[] => {
  const state = new Array<number>(key.length);
  for (let index = 0; index < key.length; index += 1) state[index] = key.charCodeAt(index);
  return state;
};
const encode = (state: readonly number[]): string => String.fromCharCode.apply(null, state as number[]);

/** Every state reachable from `initial`, and every transition between them. */
export function explore(initial: number[], successors: (state: number[]) => Move[]): Graph {
  const keys = [encode(initial)];
  const index = new Map<string, number>([[keys[0], 0]]);
  const labelIndex = new Map<string, number>();
  const labels: string[] = [];
  const firstEdge: number[] = [0];
  const edgeTo: number[] = [];
  const edgeLabel: number[] = [];
  const edgeBlockedBy: number[] = [];
  for (let at = 0; at < keys.length; at += 1) {
    for (const move of successors(decode(keys[at]))) {
      // A write past a state's end would grow the array without complaint and split the state in two.
      if (move.next.length !== initial.length) throw new Error(`A move left a state of ${move.next.length} fields, not ${initial.length}: ${move.label}`);
      const key = encode(move.next);
      let to = index.get(key);
      if (to === undefined) {
        to = keys.length;
        keys.push(key);
        index.set(key, to);
      }
      let label = labelIndex.get(move.label);
      if (label === undefined) {
        label = labels.length;
        labels.push(move.label);
        labelIndex.set(move.label, label);
      }
      edgeTo.push(to);
      edgeLabel.push(label);
      edgeBlockedBy.push(move.blockedBy);
    }
    firstEdge.push(edgeTo.length);
  }
  return { keys, labels, firstEdge: Int32Array.from(firstEdge), edgeTo: Int32Array.from(edgeTo), edgeLabel: Int32Array.from(edgeLabel), edgeBlockedBy: Int32Array.from(edgeBlockedBy) };
}

/** The states and edges a set of assumptions leaves reachable, by traversing the graph. */
export function reachable(graph: Graph, assumptions: number): { seen: Uint8Array; states: number; edges: number; parentEdge: Int32Array; parent: Int32Array } {
  const size = graph.keys.length;
  const seen = new Uint8Array(size);
  const parentEdge = new Int32Array(size).fill(-1);
  const parent = new Int32Array(size).fill(-1);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  queue[tail++] = 0;
  seen[0] = 1;
  let edges = 0;
  while (head < tail) {
    const at = queue[head++];
    for (let edge = graph.firstEdge[at]; edge < graph.firstEdge[at + 1]; edge += 1) {
      if ((graph.edgeBlockedBy[edge] & assumptions) !== 0) continue;
      edges += 1;
      const to = graph.edgeTo[edge];
      if (seen[to] === 0) {
        seen[to] = 1;
        parent[to] = at;
        parentEdge[to] = edge;
        queue[tail++] = to;
      }
    }
  }
  return { seen, states: tail, edges, parentEdge, parent };
}

/** The labels of the first path found to a state, from the search's own parents. */
export function pathTo(graph: Graph, reach: { parent: Int32Array; parentEdge: Int32Array }, state: number): string[] {
  const labels: string[] = [];
  for (let at = state; reach.parent[at] !== -1; at = reach.parent[at]) labels.push(graph.labels[graph.edgeLabel[reach.parentEdge[at]]]);
  return labels.reverse();
}

/** What the attacher's thread hears: its socket, its own bounds, and the main thread's barrier. */
export const threadHearsStep = (name: string): boolean => /^(hears|hold-bound|off-bound|thread-gets-barrier|barrier-bound|connection-closes|barrier-round-trip)/.test(name);
/** What the main thread hears: the port, discovery, the thread's death, and its own freeze and bound. */
export const mainHearsStep = (name: string): boolean => /^(mirror-hears|freeze|settle-bound|discovered|barrier-round-trip|thread-dies|documents-late|documents-answered)/.test(name);
/** What any real code hears. The rest happens in the browser alone. */
export const realCodeHearsStep = (name: string): boolean => threadHearsStep(name) || mainHearsStep(name);
export const threadOutput = (step: Step): string => `${step.posts.join()}/${step.sends.join()}`;
export const mainOutput = (step: Step): string => step.ended ?? "";
export const wholeOutput = (step: Step): string => `${threadOutput(step)}/${mainOutput(step)}`;

/** One step of a label: what happened, what the thread posted and sent, and whether the readout ended. */
export type Step = { name: string; posts: string[]; sends: string[]; ended: string | null };

/** A label is its steps, joined; each says what it posted and sent. */
export function stepsOf(label: string): Step[] {
  return label.split("&").map((text) => {
    const [body, ended] = text.split("#");
    const [name, posts, sends] = body.split("|");
    return { name, posts: posts ? posts.split(",") : [], sends: sends ? sends.split(",") : [], ended: ended ?? null };
  });
}

/** What the side hears, with no word of where in a queue it waited. */
const heard = (name: string): string => name.replace(/:@\d+$/, "");

export type InputEdge = { input: string; steps: Step[]; to: number };
/** What one side of the world hears, determinized: a state is the set of model states one sequence of inputs can leave. */
export type InputAutomaton = {
  /** The model states of each automaton state, closed over steps this side does not hear. */
  members: Int32Array[];
  edges: InputEdge[][];
};

/**
 * The world as one side hears it. The real code on that side is a function of what it hears,
 * so one sequence of inputs stands for every model trace that gives it that sequence. Two
 * transitions on one input that disagree on what comes out are a defect of the model, so
 * this refuses them.
 */
export function inputAutomaton(graph: Graph, assumptions: number, isInput: (name: string) => boolean, sameOutput: (step: Step) => string): InputAutomaton {
  const projected = graph.labels.map((label) => stepsOf(label).filter((step) => isInput(step.name)));
  const closure = (from: readonly number[]): Int32Array => {
    const seen = new Set<number>(from);
    const stack = [...from];
    while (stack.length > 0) {
      const at = stack.pop() as number;
      for (let edge = graph.firstEdge[at]; edge < graph.firstEdge[at + 1]; edge += 1) {
        if ((graph.edgeBlockedBy[edge] & assumptions) !== 0 || projected[graph.edgeLabel[edge]].length > 0) continue;
        const to = graph.edgeTo[edge];
        if (!seen.has(to)) {
          seen.add(to);
          stack.push(to);
        }
      }
    }
    return Int32Array.from(seen).sort();
  };
  const index = new Map<string, number>();
  const members: Int32Array[] = [];
  const edges: InputEdge[][] = [];
  const stateOf = (set: Int32Array): number => {
    const key = set.join(",");
    let id = index.get(key);
    if (id === undefined) {
      id = members.length;
      index.set(key, id);
      members.push(set);
      edges.push([]);
    }
    return id;
  };
  stateOf(closure([0]));
  for (let at = 0; at < members.length; at += 1) {
    const out = new Map<string, { steps: Step[]; output: string; tos: Set<number> }>();
    for (const member of members[at]) {
      for (let edge = graph.firstEdge[member]; edge < graph.firstEdge[member + 1]; edge += 1) {
        if ((graph.edgeBlockedBy[edge] & assumptions) !== 0) continue;
        const steps = projected[graph.edgeLabel[edge]];
        if (steps.length === 0) continue;
        const input = steps.map((step) => heard(step.name)).join(";");
        const output = steps.map(sameOutput).join(";");
        const known = out.get(input);
        if (known === undefined) out.set(input, { steps, output, tos: new Set([graph.edgeTo[edge]]) });
        else {
          if (known.output !== output) throw new Error(`The model is not a function of what this side hears: "${input}" gives "${known.output}" and "${output}".`);
          known.tos.add(graph.edgeTo[edge]);
        }
      }
    }
    for (const [input, { steps, tos }] of out) edges[at].push({ input, steps, to: stateOf(closure([...tos])) });
  }
  return { members, edges };
}

/** Every maximal sequence of inputs, and how many there are. A prefix is replayed on the way to its longest form. */
export function* inputSequences(automaton: InputAutomaton): Generator<InputEdge[]> {
  const path: InputEdge[] = [];
  function* walk(at: number): Generator<InputEdge[]> {
    if (automaton.edges[at].length === 0) {
      yield path.slice();
      return;
    }
    for (const edge of automaton.edges[at]) {
      path.push(edge);
      yield* walk(edge.to);
      path.pop();
    }
  }
  yield* walk(0);
}

export function countInputSequences(automaton: InputAutomaton): number {
  const counts = new Float64Array(automaton.members.length).fill(-1);
  const count = (at: number): number => {
    if (counts[at] >= 0) return counts[at];
    let total = automaton.edges[at].length === 0 ? 1 : 0;
    for (const edge of automaton.edges[at]) total += count(edge.to);
    counts[at] = total;
    return total;
  };
  return count(0);
}

/**
 * Sequences that together take every transition of the automaton at least once: walk from the
 * start, taking a transition not yet taken whenever there is one, and otherwise the one that
 * reaches an untaken transition soonest, until no transition is left untaken. From a state other
 * than the first, only the transitions reachable from it count, and each sequence starts there.
 */
export function inputCover(automaton: InputAutomaton, start = 0): InputEdge[][] {
  const size = automaton.members.length;
  const taken = automaton.edges.map((edges) => new Uint8Array(edges.length));
  const reached = new Uint8Array(size);
  reached[start] = 1;
  const toVisit = [start];
  let left = 0;
  while (toVisit.length > 0) {
    for (const edge of automaton.edges[toVisit.pop() as number]) {
      left += 1;
      if (reached[edge.to] === 0) {
        reached[edge.to] = 1;
        toVisit.push(edge.to);
      }
    }
  }
  const sequences: InputEdge[][] = [];
  while (left > 0) {
    // Distance to the nearest untaken transition, over the automaton, which is a DAG.
    const distance = new Int32Array(size).fill(-1);
    const nearest = (at: number): number => {
      if (distance[at] !== -1) return distance[at];
      let best = 1 << 29;
      automaton.edges[at].forEach((edge, index) => {
        best = Math.min(best, taken[at][index] === 0 ? 0 : nearest(edge.to) + 1);
      });
      distance[at] = best;
      return best;
    };
    const path: InputEdge[] = [];
    let at = start;
    while (automaton.edges[at].length > 0) {
      let choice = -1;
      let score = 1 << 30;
      automaton.edges[at].forEach((edge, index) => {
        const here = taken[at][index] === 0 ? 0 : nearest(edge.to) + 1;
        if (here < score) {
          score = here;
          choice = index;
        }
      });
      if (taken[at][choice] === 0) {
        taken[at][choice] = 1;
        left -= 1;
      }
      path.push(automaton.edges[at][choice]);
      at = automaton.edges[at][choice].to;
    }
    sequences.push(path);
  }
  return sequences;
}

// ---------------------------------------------------------------------------------------
// The shared world's state: a flat array of small numbers, one block per worker.
// ---------------------------------------------------------------------------------------

const G_PHASE = 0;
const G_ENDED = 1;
const G_LOST = 2;
const PORT = 3;
const PORT_CAPACITY = 13;
const HEADER = PORT + PORT_CAPACITY;
const PORT_CAPACITY_TWO = 26;
const HEADER_TWO = PORT + PORT_CAPACITY_TWO;

/** The reports the two-worker world lets wait on the port at once. */
const REDUCED_PORT_BOUND = 4;

const BEFORE_FREEZE = 0;
const DRAINING = 1;
const DONE = 2;
/** The drain has ended and the readout waits for the page's frame trees, sent at the call. What is on its way still lands. */
const WAITING_FOR_TREES = 3;

// The world.
const PHASE = 0;
const WAITING = 1;
const DBG = 2;
const BP = 3;
const OBS = 4;
const RAN = 5;
const RANU = 6;
const OTHER = 7;
const EVAL = 8;
const ATTACH = 9;
const DETACH = 10;
const SEQ = 11;
const PAUSED_AGAIN = 12;
// The world at the freeze.
const RAN_F = 13;
const RANU_F = 14;
const SEQ_F = 15;
// The attacher's thread.
const HOLD = 16;
const GONE = 17;
const ACK = 18;
const EARLY = 19;
const PROBE = 20;
const CONC = 21;
const SCRIPTS = 22;
const AWAIT_X = 23;
// The mirror and the installer's record.
const KNOWN = 24;
const M_HOLD = 25;
const DET = 26;
const DWP = 27;
const UNREACHED = 28;
const QUICK = 29;
const INSTALL = 30;
const LOST = 31;
const M_SEQ = 32;
const M_WORD = 33;
const M_CLOSED = 34;
const BROKEN = 35;
const DISC = 36;
const DIED_AFTER = 37;
const REWROTE = 38;
const M_RELEASED = 39;
// The readout.
const FORM = 40;
const SLOT_ANSWERED = 41;
const SLOT_FREEZE_SEQ = 42;
const SLOT_SNAPSHOT = 43;
const BARRIER = 44;
const FORM_11 = 45;
// The session's two directions.
const COMMANDS = 46;
const COMMAND_CAPACITY = 8;
const EVENTS = COMMANDS + COMMAND_CAPACITY;
const EVENT_CAPACITY = 12;
const WORKER_SIZE = EVENTS + EVENT_CAPACITY;

// A worker's fields once the readout has ended, the only ones its verdict reads.
const D_TERM = 0;
const D_READ_SEQ = 1;
const D_VERDICT = 2;
const D_TRUTH = 3;
const D_SEQ_F = 4;
const D_MOVED = 5;
// D_TRUTH's bits: the world's own facts, read by nothing that classifies.
const T_RAN_AT_FREEZE = 1;
const T_RAN_UNOBSERVED_AT_FREEZE = 2;
const T_RAN_UNOBSERVED = 4;
const T_ATTACHER_LIVES = 8;

// PHASE.
const NOT_BORN = 0;
const START_HELD = 1;
const COMPILED = 2;
const AT_MAIN = 3;
const RUNNING = 4;
const PAUSED_ELSEWHERE = 5;
const WORLD_GONE = 6;
// HOLD and M_HOLD, the thread's words. NO_HOLD is the thread not having heard of it yet.
const NO_HOLD = 0;
const PENDING = 1;
const HELD = 2;
const LATE = 3;
const RELEASED = 4;
const HOLD_WORD = [null, "pending", "held", "late", "released"] as const;
// INSTALL.
const INSTALL_WORD = [null, "installed", "failed", "attached-late"] as const;
// M_WORD.
const WORD_NONE = 0;
const WORD_OPEN = 1;
const WORD_CLOSED = 2;
// ATTACH and DETACH.
const NONE_IN_FLIGHT = 0;
const IN_FLIGHT = 1;
const IN_FLIGHT_AT_FREEZE = 2;
// BARRIER: 0 none, on its way to the thread, sent to the worker, replied.
const BARRIER_TO_THREAD = 1;
const BARRIER_SENT = 2;
const BARRIER_REPLIED = 3;

// A session's commands. Each is one step for the browser, and stands for what the thread
// sends in one breath: arming is the debugger's enable and the breakpoint, the install is
// the binding and the evaluation, and turning the debugger off is the breakpoint's removal,
// once its id is known, and the disable.
const C_ARM = 1;
const C_RUN = 2;
const C_INSTALL = 3;
const C_OFF = 4;
const C_PROBE = 5;
const C_BARRIER = 6;
const COMMAND_NAME = ["", "arm", "run", "install", "off", "probe", "barrier"];

// What a session carries to the thread.
const E_PARSED = 1;
const E_ACK = 2;
const E_PAUSE_MAIN = 3;
const E_PAUSE_SCRIPT = 4;
const E_PAUSE_STATEMENT = 5;
const E_RESUMED = 6;
const E_FIRST = 7;
const E_INSTALL_OK = 8;
const E_INSTALL_BAD = 9;
const E_OFF = 10;
const E_PROBE = 11;
const E_BARRIER = 12;
const E_OPEN = 13;
const E_CLOSED = 14;
const EVENT_NAME = ["", "parsed", "ack", "pause-main", "pause-script", "pause-statement", "resumed", "first", "install-ok", "install-bad", "off-answer", "probe-answer", "barrier-answer", "open", "closed"];
const EMITTED_BEFORE_FREEZE = 64;

// What the port carries to the main thread.
const P_ATTACHED = 1;
const P_HELD = 2;
const P_INSTALLED_OK = 3;
const P_INSTALLED_BAD = 4;
const P_INSTALLED_NONE = 5;
const P_LATE = 6;
const P_RELEASED = 7;
const P_GONE_HELD = 8;
const P_GONE_AFTER_INSTALL = 9;
const P_GONE_UNREACHED_QUICK = 10;
const P_GONE_UNREACHED_LONG = 11;
const P_GONE_OTHER = 12;
const P_EVENT_FIRST = 13;
const P_EVENT_OPEN = 14;
const P_EVENT_CLOSED = 15;
const P_REPLY_OK = 16;
const P_REPLY_ERROR = 17;
const P_LOST = 18;
const PORT_NAME = ["", "attached", "held", "installed-ok", "installed-bad", "installed-none", "late", "released", "gone-held", "gone-after-install", "gone-unreached-quick", "gone-unreached-long", "gone-other", "event-first", "event-open", "event-closed", "reply-ok", "reply-error", "lost"];
const WORKER_STEP = 32;
const POSTED_BEFORE_FREEZE = 64;
const POSTED_FOR_EARLIER_NEWS = 128;
const PORT_ITEM = WORKER_STEP - 1;

/** The readout's kernels, the real ones or a variant's. */
export type Kernels = {
  freezeSharedRealm(record: never, options?: { attachedAfterFreeze?: boolean }): { state: string; reason?: string };
  resolveSharedRealm(realm: never): { state: string; reason?: string };
  streamAtFreeze(record: never): { state: string; snapshot?: string; reason?: string };
  sharedLandedTerm(resolved: never, documents: never): { term: string; snapshot: string | null };
};

const SITE_ORIGIN = "http://site.test";
export const MODEL_MAIN_DOCUMENT = { frameId: "main-frame", loaderId: "loader-1", securityOrigin: SITE_ORIGIN };
export const MODEL_WORKER_URL = `${SITE_ORIGIN}/worker.js`;
const DOCUMENTS = { loaders: new Map([[MODEL_MAIN_DOCUMENT.frameId, MODEL_MAIN_DOCUMENT.loaderId]]), main: MODEL_MAIN_DOCUMENT };
/** Its own in the model's snapshot text, so a read can say which emission it read. */
export const snapshotText = (seq: number): string => JSON.stringify({ seq });

/** Every term a worker the mirror heard of can land in, by what the readout says of it. */
const EXCLUDED_TERMS = new Set(["pausedAtReadout", "diedPaused"]);
const READ_TERMS = new Set(["readable", "ownerUnscoped"]);
const UNREAD_TERMS = new Set(["installFailed", "attachedLate", "unreached", "cutOff", "streamBroken", "channelLostAlive", "diedHeld"]);
export const WORKER_TERMS: readonly string[] = [...EXCLUDED_TERMS, ...UNREAD_TERMS, ...READ_TERMS, "endedAtOnce"];
const DEDICATED_ONLY_TERMS: readonly string[] = ["ownerReplaced", "ownerUnknown"];
const TERM_NOWHERE = 1;
const TERM_UNATTACHED = 2;
const TERM_CODES = ["", "nowhere", "unattached", ...WORKER_TERMS];
export const termOfCode = (code: number): string => TERM_CODES[code];

/** The properties, one verdict bit each. */
export const PROPERTIES = [
  "excluded-implies-no-page-code-before-the-freeze",
  "excluded-implies-no-unobserved-page-code-before-the-freeze",
  "read-implies-the-observer-preceded-every-statement",
  "a-read-state-is-no-older-than-the-freeze",
  "every-worker-the-readout-heard-of-lands-in-one-term",
  "a-worker-that-ran-before-the-freeze-lands-in-a-term",
  "at-12-only-moves-toward-unread"
] as const;
export type Property = (typeof PROPERTIES)[number];
export const propertyMask = (property: Property): number => 1 << PROPERTIES.indexOf(property);
const V_HEARD_LANDS = propertyMask("every-worker-the-readout-heard-of-lands-in-one-term");
const V_DIRECTION = propertyMask("at-12-only-moves-toward-unread");

/** The two instances of the search: every step of one worker, and two workers with each session's own steps run together. */
export type SharedWorld = {
  name: string;
  workers: 1 | 2;
  /** Steps taken as soon as they are enabled, in the order a quiet browser takes them, when the session's own order is not the question. */
  collapseSessions: boolean;
  /** The realm's stream past its first snapshot, and the barrier's every hop. */
  stream: boolean;
  /** The world starts with its worker already released, with its observer in, and the mirror current. */
  startReleased: boolean;
  /** Leaves out overtaking on the session and the port, a worker that started running, a stop after the main script, a failed install, and the thread's bounds and death. */
  reduced: boolean;
};

/** Every step of one worker, with the realm's stream past its first snapshot left out and the barrier one round trip. */
export const HOLD_WORLD: SharedWorld = { name: "hold", workers: 1, collapseSessions: false, stream: false, startReleased: false, reduced: false };
/** One worker from its release on, with its stream and every hop of the barrier. */
export const STREAM_WORLD: SharedWorld = { name: "stream", workers: 1, collapseSessions: false, stream: true, startReleased: true, reduced: false };
/**
 * Two workers, under this bound: A1 and A5's order are taken, so neither queue is overtaken; the
 * first worker has the reduced alphabet with each session's own steps run together; the second
 * runs a plain hold, with no other client, no end and no failed install; at most four reports
 * wait on the port at once; and the page's frame tree has answered by the drain's end. What it
 * adds to one worker is the order of the shared port, and a drain the other worker keeps open.
 */
export const TWO_WORKER_WORLD: SharedWorld = { name: "two", workers: 2, collapseSessions: true, stream: false, startReleased: false, reduced: true };
/** The two-worker world's first worker alone: small enough to rebuild for each variant of the kernels. */
export const SMALL_WORLD: SharedWorld = { name: "small", workers: 1, collapseSessions: true, stream: false, startReleased: false, reduced: true };

/** How the real code reaches where STREAM_WORLD starts. */
export const STREAM_WORLD_PREFIX: readonly string[] = [
  "hears:0:attach:waiting|0:attached:waiting|0:arm,0:run",
  "hears:0:ack||",
  "hears:0:parsed||",
  "hears:0:pause-main|0:held|0:install",
  "hears:0:first|0:event:first|",
  "hears:0:install-ok|0:installed:ok|0:off+remove",
  "hears:0:off-answer|0:released:on|",
  "mirror-hears:0:attached||",
  "mirror-hears:0:held||",
  "mirror-hears:0:event-first||",
  "mirror-hears:0:installed-ok||",
  "mirror-hears:0:released||"
];

type Context = { posts: string[]; sends: string[]; ended: string | null };
const newContext = (): Context => ({ posts: [], sends: [], ended: null });

/** The class of a worker's landing at fingerprint-observer@12, and what @11 would have said. */
type Before = { state: string; reason?: string };

/** Where the named trace's `late` was when the settle bound could fire. */
export type NamedCause = "late-posted-before-the-freeze" | "late-posted-after-the-freeze" | "resume-still-on-the-socket" | "connection-lost-on-the-port" | "thread-concluded-first" | "no-word-on-its-way";
export type NamedForm = "held" | "reaching" | "second-pass";
export type NamedTrace = { form: NamedForm; cause: NamedCause };

/** The fields the replay holds the real mirror to. */
export type MirrorView = { known: boolean; hold: string | null; detached: boolean; detachedWhilePaused: boolean; endedUnreached: boolean; install: string | null };

/** A worker when a readout ended: its term, and the world's own facts about it. */
export type LandedWorker = { term: string; readSeq: number; ranAtFreeze: boolean; ranUnobservedAtFreeze: boolean; ranUnobserved: boolean; attacherLives: boolean; realmAtFreeze: number; movedFromAt11: "no" | "toUnread" | "toStream" };

/** The verdict bits a landing earns, read from the world's facts alone. The classifier's own output is the term, and nothing else here reads it. */
export function judged(landed: LandedWorker): Property[] {
  const broken: Property[] = [];
  if (EXCLUDED_TERMS.has(landed.term)) {
    if (landed.ranAtFreeze) broken.push("excluded-implies-no-page-code-before-the-freeze");
    if (landed.ranUnobservedAtFreeze) broken.push("excluded-implies-no-unobserved-page-code-before-the-freeze");
  }
  if (READ_TERMS.has(landed.term)) {
    if (landed.ranUnobserved) broken.push("read-implies-the-observer-preceded-every-statement");
    if (landed.readSeq < (landed.realmAtFreeze === 2 ? 3 : landed.realmAtFreeze)) broken.push("a-read-state-is-no-older-than-the-freeze");
  }
  if (landed.term === "nowhere" && landed.ranAtFreeze && landed.attacherLives) broken.push("a-worker-that-ran-before-the-freeze-lands-in-a-term");
  return broken;
}

export class SharedWorkerModel {
  readonly world: SharedWorld;
  private readonly kernels: Kernels;
  private readonly header: number;
  private readonly portCapacity: number;
  private readonly forms: string[] = ["", "reaching", "held", "closed", "waiting"];
  private readonly formIndex = new Map<string, number>(this.forms.map((form, index) => [form, index]));
  private readonly termMemo = new Map<string, { term: number; readSeq: number; verdict: number; moved: number }>();
  private readonly formMemo = new Map<string, number>();

  constructor(world: SharedWorld, kernels: Kernels) {
    this.world = world;
    this.kernels = kernels;
    this.header = world.workers === 1 ? HEADER : HEADER_TWO;
    this.portCapacity = world.workers === 1 ? PORT_CAPACITY : PORT_CAPACITY_TWO;
  }

  initial(): number[] {
    const state = new Array<number>(this.header + WORKER_SIZE * this.world.workers).fill(0);
    if (this.world.startReleased) {
      const b = this.base(0);
      for (const [field, value] of [[PHASE, RUNNING], [OBS, 1], [RAN, 1], [SEQ, 1], [HOLD, RELEASED], [CONC, 1], [PAUSED_AGAIN, 1], [KNOWN, 1], [M_HOLD, RELEASED], [INSTALL, 1], [M_SEQ, 1], [M_WORD, WORD_CLOSED], [M_CLOSED, 1], [M_RELEASED, 1]]) state[b + field] = value;
    }
    return state;
  }

  explore(): Graph {
    return explore(this.initial(), (state) => this.successors(state));
  }

  private base(w: number): number {
    return this.header + WORKER_SIZE * w;
  }

  // ---- Queues ----------------------------------------------------------------------------

  private pushTo(state: number[], first: number, capacity: number, item: number): void {
    for (let slot = first; slot < first + capacity; slot += 1) {
      if (state[slot] === 0) {
        state[slot] = item;
        return;
      }
    }
    throw new Error(`A queue at ${first} outgrew its capacity of ${capacity}.`);
  }

  private removeFrom(state: number[], first: number, capacity: number, index: number): void {
    for (let slot = first + index; slot < first + capacity - 1; slot += 1) state[slot] = state[slot + 1];
    state[first + capacity - 1] = 0;
  }

  private command(state: number[], w: number, command: number, context: Context): void {
    const b = this.base(w);
    if (state[G_ENDED] === 1) return;
    context.sends.push(`${w}:${COMMAND_NAME[command]}${command === C_OFF && state[b + ACK] === 1 ? "+remove" : ""}`);
    // A command to a target that has gone reaches nothing.
    if (state[b + PHASE] === WORLD_GONE) return;
    this.pushTo(state, b + COMMANDS, COMMAND_CAPACITY, command);
  }

  private emit(state: number[], w: number, event: number): void {
    const b = this.base(w);
    this.pushTo(state, b + EVENTS, EVENT_CAPACITY, event);
  }

  private post(state: number[], w: number, item: number, detail: string, carried: number, context: Context): void {
    if (state[G_ENDED] === 1) return;
    context.posts.push(`${w}:${detail}`);
    this.pushTo(state, PORT, this.portCapacity, (item + w * WORKER_STEP) | carried);
  }

  // ---- The world's run ----------------------------------------------------------------------

  /** The worker's page code runs from here on. RAN and RANU are moved by nothing else. */
  private run(state: number[], b: number): void {
    state[b + PHASE] = RUNNING;
    if (state[G_PHASE] === BEFORE_FREEZE) state[b + RAN] = 1;
    if (state[b + OBS] === 0) state[b + RANU] = 1;
  }

  /** A release of any client: a start-up hold ends, or a pause ends, and the session hears unless told not to. */
  private release(state: number[], w: number, heard: boolean): void {
    const b = this.base(w);
    if (state[b + PHASE] === START_HELD) {
      state[b + PHASE] = COMPILED;
      if (state[b + DBG] === 1) this.emit(state, w, E_PARSED);
      return;
    }
    if (state[b + PHASE] === AT_MAIN || state[b + PHASE] === PAUSED_ELSEWHERE) {
      this.run(state, b);
      if (heard) this.emit(state, w, E_RESUMED);
    }
  }

  // ---- The attacher's thread, line by line from sharedWorkerAttacherThread ---------------------

  private markLate(state: number[], w: number, reason: string, debuggerOn: boolean, carried: number, context: Context): void {
    const b = this.base(w);
    if (state[b + HOLD] !== PENDING) return;
    state[b + HOLD] = LATE;
    this.post(state, w, P_LATE, `late:${reason}`, carried, context);
    if (debuggerOn) this.command(state, w, C_OFF, context);
  }

  private probeIfParsed(state: number[], w: number, context: Context): void {
    const b = this.base(w);
    if (state[b + HOLD] !== PENDING || state[b + EARLY] === 0 || state[b + ACK] === 0 || state[b + PROBE] === 1) return;
    state[b + PROBE] = 1;
    this.command(state, w, C_PROBE, context);
  }

  private breakHold(state: number[], w: number, carried: number, context: Context): void {
    const b = this.base(w);
    if (state[b + HOLD] !== HELD || state[b + CONC] === 1) return;
    state[b + HOLD] = LATE;
    this.post(state, w, P_LATE, "late:resumed-while-held", carried, context);
    this.command(state, w, C_OFF, context);
  }

  private conclude(state: number[], w: number, outcome: "ok" | "bad" | "none", carried: number, context: Context): void {
    const b = this.base(w);
    if (state[b + CONC] === 1 || state[b + HOLD] !== HELD) return;
    state[b + CONC] = 1;
    const item = outcome === "ok" ? P_INSTALLED_OK : outcome === "bad" ? P_INSTALLED_BAD : P_INSTALLED_NONE;
    this.post(state, w, item, `installed:${outcome}`, carried, context);
    state[b + AWAIT_X] = 1;
    this.command(state, w, C_OFF, context);
  }

  private threadHears(state: number[], w: number, event: number, carried: number, context: Context): void {
    const b = this.base(w);
    const inMap = state[b + GONE] === 0;
    switch (event) {
      case E_PARSED:
        if (!inMap) return;
        state[b + SCRIPTS] = 1;
        if (state[b + HOLD] === PENDING && state[b + ACK] === 0) {
          state[b + EARLY] = 1;
          this.probeIfParsed(state, w, context);
        }
        return;
      case E_ACK:
        state[b + ACK] = 1;
        this.probeIfParsed(state, w, context);
        return;
      case E_PAUSE_MAIN:
        if (!inMap || state[b + HOLD] !== PENDING) return;
        state[b + HOLD] = HELD;
        this.post(state, w, P_HELD, "held", carried, context);
        this.command(state, w, C_INSTALL, context);
        return;
      case E_PAUSE_SCRIPT:
        if (!inMap) return;
        this.markLate(state, w, "other-script", true, carried, context);
        return;
      case E_PAUSE_STATEMENT:
        if (!inMap) return;
        if (state[b + HOLD] === HELD) this.breakHold(state, w, carried, context);
        else this.markLate(state, w, "other-pause", true, carried, context);
        return;
      case E_RESUMED:
        if (inMap) this.breakHold(state, w, carried, context);
        return;
      case E_FIRST:
      case E_OPEN:
      case E_CLOSED:
        if (!inMap) return;
        this.post(state, w, event === E_FIRST ? P_EVENT_FIRST : event === E_OPEN ? P_EVENT_OPEN : P_EVENT_CLOSED, `event:${EVENT_NAME[event]}`, carried, context);
        return;
      case E_INSTALL_OK:
      case E_INSTALL_BAD:
        this.conclude(state, w, event === E_INSTALL_OK ? "ok" : "bad", carried, context);
        return;
      case E_OFF:
        if (state[b + AWAIT_X] === 1) {
          state[b + AWAIT_X] = 0;
          state[b + HOLD] = RELEASED;
          this.post(state, w, P_RELEASED, "released:on", carried, context);
        }
        return;
      case E_PROBE:
        this.markLate(state, w, "ran-before-breakpoint", true, carried, context);
        return;
      case E_BARRIER:
        // Past its bound the command is no longer waited for, so a late answer reaches nothing.
        if (state[b + BARRIER] !== BARRIER_SENT) return;
        state[b + BARRIER] = BARRIER_REPLIED;
        this.post(state, w, P_REPLY_OK, "reply:ok", carried, context);
        return;
      default:
        throw new Error(`No such event: ${event}`);
    }
  }

  private threadHearsAttach(state: number[], w: number, carried: number, context: Context): void {
    const b = this.base(w);
    state[b + ATTACH] = NONE_IN_FLIGHT;
    state[b + HOLD] = PENDING;
    this.post(state, w, P_ATTACHED, `attached:${state[b + WAITING] === 1 ? "waiting" : "running"}`, carried, context);
    if (state[b + WAITING] === 0) {
      this.markLate(state, w, "running-at-attach", false, carried, context);
      return;
    }
    this.command(state, w, C_ARM, context);
    this.command(state, w, C_RUN, context);
  }

  private threadHearsDetach(state: number[], w: number, lifetime: "quick" | "long", carried: number, context: Context): void {
    const b = this.base(w);
    state[b + DETACH] = NONE_IN_FLIGHT;
    state[b + GONE] = 1;
    const hold = state[b + HOLD];
    if (hold === HELD && state[b + CONC] === 0) this.post(state, w, P_GONE_HELD, "detached:held", carried, context);
    else if (hold === HELD) this.post(state, w, P_GONE_AFTER_INSTALL, "detached:after-install", carried, context);
    else if (hold === PENDING && state[b + SCRIPTS] === 0) this.post(state, w, lifetime === "quick" ? P_GONE_UNREACHED_QUICK : P_GONE_UNREACHED_LONG, `detached:unreached-${lifetime}`, carried, context);
    else this.post(state, w, P_GONE_OTHER, "detached:other", carried, context);
  }

  // ---- The mirror and the installer's record ---------------------------------------------------

  private answerBarrier(state: number[], b: number): void {
    if (this.forms[state[b + FORM]] !== "waiting" || state[b + SLOT_ANSWERED] === 1) return;
    state[b + SLOT_ANSWERED] = 1;
    if (state[b + M_WORD] === WORD_CLOSED && state[b + M_CLOSED] !== 0) state[b + SLOT_SNAPSHOT] = state[b + M_CLOSED];
    else state[b + SLOT_FREEZE_SEQ] = state[b + M_SEQ] + 1;
  }

  private receive(state: number[], b: number, sequence: number, closed: boolean): void {
    if (state[b + BROKEN] === 1 || state[b + LOST] === 1) return;
    if (sequence !== state[b + M_SEQ] + 1) {
      state[b + BROKEN] = 1;
      return;
    }
    state[b + M_SEQ] = sequence;
    state[b + M_WORD] = closed ? WORD_CLOSED : WORD_OPEN;
    if (!closed) return;
    state[b + M_CLOSED] = sequence;
    // The drain's end takes each slot off its record, so an emission past it fills none.
    if (state[G_PHASE] !== WAITING_FOR_TREES && this.forms[state[b + FORM]] === "waiting" && state[b + SLOT_SNAPSHOT] === 0 && state[b + SLOT_FREEZE_SEQ] !== 0 && sequence > state[b + SLOT_FREEZE_SEQ] - 1) state[b + SLOT_SNAPSHOT] = sequence;
  }

  private loseChannel(state: number[]): void {
    state[G_LOST] = 1;
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      if (state[b + KNOWN] === 1 && state[b + DET] === 0) state[b + LOST] = 1;
      // A barrier still waiting is refused with the channel, which answers it for a worker already gone.
      if (state[b + DET] === 1) this.answerBarrier(state, b);
    }
  }

  private mirrorHears(state: number[], raw: number): void {
    const code = raw & PORT_ITEM;
    if (code === P_LOST) {
      if (state[G_LOST] === 0) this.loseChannel(state);
      return;
    }
    if (state[G_LOST] === 1) return;
    const w = (raw & WORKER_STEP) === 0 ? 0 : 1;
    const b = this.base(w);
    if (code === P_ATTACHED) {
      if (state[b + KNOWN] === 1) return;
      state[b + KNOWN] = 1;
      state[b + M_HOLD] = PENDING;
      return;
    }
    // A report ahead of its worker's attach reaches nothing: the mirror has no such worker.
    if (state[b + KNOWN] === 0) return;
    const late = state[b + M_HOLD] === LATE;
    switch (code) {
      case P_HELD:
        if (!late) state[b + M_HOLD] = HELD;
        return;
      case P_INSTALLED_OK:
        if (late) return;
        if (state[b + INSTALL] === 0) state[b + INSTALL] = state[b + M_SEQ] >= 1 && state[b + BROKEN] === 0 ? 1 : 2;
        return;
      case P_INSTALLED_BAD:
      case P_INSTALLED_NONE:
        if (late) return;
        if (state[b + INSTALL] === 0) state[b + INSTALL] = 2;
        return;
      case P_LATE:
        if (late) return;
        state[b + M_HOLD] = LATE;
        if (state[b + INSTALL] === 0) state[b + INSTALL] = 3;
        return;
      case P_RELEASED:
        if (late) return;
        state[b + M_HOLD] = RELEASED;
        state[b + M_RELEASED] = 1;
        return;
      case P_GONE_HELD:
      case P_GONE_AFTER_INSTALL:
      case P_GONE_UNREACHED_QUICK:
      case P_GONE_UNREACHED_LONG:
      case P_GONE_OTHER:
        state[b + DET] = 1;
        state[b + DWP] = code === P_GONE_HELD ? 1 : 0;
        state[b + UNREACHED] = code === P_GONE_UNREACHED_QUICK || code === P_GONE_UNREACHED_LONG ? 1 : 0;
        state[b + QUICK] = code === P_GONE_UNREACHED_QUICK ? 1 : 0;
        if (code === P_GONE_AFTER_INSTALL) {
          state[b + DIED_AFTER] = 1;
          if (state[b + M_HOLD] === HELD) {
            state[b + M_HOLD] = RELEASED;
            state[b + REWROTE] = 1;
          }
        }
        // Only a slot still on the record: past the drain, its own answer alone can fill it.
        if (state[G_PHASE] !== WAITING_FOR_TREES) this.answerBarrier(state, b);
        return;
      case P_EVENT_FIRST:
        this.receive(state, b, 1, true);
        return;
      case P_EVENT_OPEN:
        this.receive(state, b, 2, false);
        return;
      case P_EVENT_CLOSED:
        this.receive(state, b, 3, true);
        return;
      case P_REPLY_OK:
        this.answerBarrier(state, b);
        return;
      case P_REPLY_ERROR:
        if (state[b + DET] === 1) this.answerBarrier(state, b);
        return;
      default:
        throw new Error(`No such report: ${code}`);
    }
  }

  // ---- The readout ---------------------------------------------------------------------------

  /** A worker's record as the kernels read it. Fields the kernels never read for a shared worker are constants. */
  private view(state: readonly number[], b: number): unknown {
    const hold = HOLD_WORD[state[b + M_HOLD]] ?? "pending";
    const word = state[b + M_WORD];
    const closed = state[b + M_CLOSED];
    return {
      worker: {
        sessionId: "worker",
        kind: "shared",
        nested: false,
        arrivedOnSessionId: null,
        ownerFrameId: null,
        waitingForDebugger: true,
        released: hold === "released" || hold === "late",
        detached: state[b + DET] === 1,
        detachedWhilePaused: state[b + DWP] === 1,
        targetId: "worker-target",
        url: MODEL_WORKER_URL,
        hold,
        lateReason: null,
        attachedAt: 0,
        lifetimeMs: state[b + DET] === 1 ? (state[b + QUICK] === 1 ? 1 : 1_000) : null,
        endedUnreached: state[b + UNREACHED] === 1,
        creationDocument: { ...MODEL_MAIN_DOCUMENT },
        holdMs: null,
        debuggerOffAtRelease: null
      },
      install: INSTALL_WORD[state[b + INSTALL]],
      owner: null,
      lastWord: word === WORD_NONE ? null : word === WORD_OPEN ? "open" : "closed",
      lastClosed: closed === 0 ? null : snapshotText(closed),
      broken: state[b + BROKEN] === 1,
      lostWithChannel: state[b + LOST] === 1
    };
  }

  private viewKey(state: readonly number[], b: number): string {
    return [M_HOLD, DET, DWP, QUICK, UNREACHED, INSTALL, LOST, M_WORD, M_CLOSED, BROKEN].map((field) => state[b + field]).join("");
  }

  private formCode(form: string): number {
    let code = this.formIndex.get(form);
    if (code === undefined) {
      code = this.forms.length;
      this.forms.push(form);
      this.formIndex.set(form, code);
    }
    return code;
  }

  /** The form the freeze gives a worker, by the real kernels, and the first half of what @11 would have said. */
  private freezeWorker(state: number[], w: number): void {
    const b = this.base(w);
    const key = this.viewKey(state, b);
    let code = this.formMemo.get(key);
    if (code === undefined) {
      const view = this.view(state, b) as never;
      const frozen = this.kernels.freezeSharedRealm(view);
      if (frozen.state === "stream") {
        const stream = this.kernels.streamAtFreeze(view);
        if (stream.state === "unread") code = this.formCode(`unread:${stream.reason}`);
        else if (stream.state === "closed") code = this.formCode("closed");
        else code = this.formCode(stream.state === "gone-open" ? "gone-open" : "waiting");
      } else code = this.formCode(frozen.state === "excluded" || frozen.state === "unread" ? `${frozen.state}:${frozen.reason}` : frozen.state);
      this.formMemo.set(key, code);
    }
    const form = this.forms[code];
    if (form === "closed") {
      state[b + FORM] = code;
      state[b + SLOT_SNAPSHOT] = state[b + M_CLOSED];
    } else if (form === "gone-open") {
      state[b + FORM] = this.formCode("waiting");
      state[b + SLOT_ANSWERED] = 1;
      state[b + SLOT_FREEZE_SEQ] = state[b + M_SEQ] + 1;
    } else {
      state[b + FORM] = code;
      if (form === "waiting" && state[G_LOST] === 0) state[b + BARRIER] = BARRIER_TO_THREAD;
    }
    state[b + FORM_11] = this.formCode(formAt11(state, b));
  }

  private heldSettled(state: readonly number[], b: number): boolean {
    return state[b + M_HOLD] !== HELD || state[b + DET] === 1;
  }

  /** drain's own test, restated: visit lost, or every discovered worker reported and every frozen one settled. */
  private drained(state: readonly number[]): boolean {
    if (state[G_LOST] === 1) return true;
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      if (state[b + DISC] === 1 && state[b + KNOWN] === 0) return false;
      if (state[b + KNOWN] === 0) continue;
      const form = this.forms[state[b + FORM]];
      if (form === "") {
        if (!this.heldSettled(state, b)) return false;
      } else if (form === "held") {
        if (!this.heldSettled(state, b)) return false;
      } else if (form === "reaching") {
        if (state[b + LOST] === 1) continue;
        const hold = state[b + M_HOLD];
        if (hold === HELD) {
          if (!this.heldSettled(state, b)) return false;
        } else if (hold === PENDING && state[b + DET] === 0) return false;
      } else if (form === "waiting") {
        if (state[b + SLOT_SNAPSHOT] === 0 && state[b + BROKEN] === 0 && state[b + LOST] === 0) return false;
      }
    }
    return true;
  }

  /** The term a worker lands in by the real kernels, and what the world says of that. */
  private land(state: readonly number[], b: number): { term: number; readSeq: number; verdict: number; moved: number } {
    if (state[b + KNOWN] === 0) {
      if (state[b + DISC] === 1) return { term: TERM_UNATTACHED, readSeq: 0, verdict: 0, moved: 0 };
      // Lost with the channel, its attach can reach no one, which the property does not count: an open pin says what happens.
      return { term: TERM_NOWHERE, readSeq: 0, verdict: 0, moved: 0 };
    }
    const key = `${this.viewKey(state, b)}:${[FORM, SLOT_ANSWERED, SLOT_FREEZE_SEQ, SLOT_SNAPSHOT, FORM_11, DIED_AFTER, REWROTE, M_RELEASED].map((field) => state[b + field]).join(",")}`;
    const memo = this.termMemo.get(key);
    if (memo) return memo;
    const view = this.view(state, b) as never;
    const form = this.forms[state[b + FORM]];
    let realm: unknown;
    if (form === "") realm = { ...(this.kernels.freezeSharedRealm(view, { attachedAfterFreeze: true }) as object), record: view };
    else if (form === "closed") realm = { record: view, state: "closed", snapshot: snapshotText(state[b + SLOT_SNAPSHOT]) };
    else if (form === "waiting") realm = { record: view, state: "waiting", slot: { barrier: state[b + SLOT_ANSWERED] === 1 ? "answered" : "pending", freezeSeq: state[b + SLOT_FREEZE_SEQ] === 0 ? null : state[b + SLOT_FREEZE_SEQ] - 1, snapshot: state[b + SLOT_SNAPSHOT] === 0 ? null : snapshotText(state[b + SLOT_SNAPSHOT]) } };
    else if (form === "reaching" || form === "held") realm = { record: view, state: form };
    else if (form === "ended-at-once") realm = { record: view, state: form };
    else {
      const [frozenState, reason] = form.split(":");
      realm = { record: view, state: frozenState, reason };
    }
    const resolved = this.kernels.resolveSharedRealm(realm as never);
    const landed = this.kernels.sharedLandedTerm(resolved as never, DOCUMENTS as never);
    const term = TERM_CODES.indexOf(landed.term);
    const readSeq = landed.snapshot === null ? 0 : (JSON.parse(landed.snapshot) as { seq: number }).seq;
    let verdict = 0;
    if (term < 3) verdict |= V_HEARD_LANDS;
    const now = formNow(form, resolved);
    const before = landedAt11(state, b, this.forms[state[b + FORM_11]]);
    const moved = before.state === "excluded" && now.state === "unread" ? 1 : before.state === "excluded" && now.state === "stream" ? 2 : 0;
    if (now.state !== before.state && !(before.state === "excluded" && (now.state === "unread" || now.state === "stream"))) verdict |= V_DIRECTION;
    const result = { term, readSeq, verdict, moved };
    this.termMemo.set(key, result);
    return result;
  }

  /** The end of a readout: every worker's term, and the verdict bits. A finished state keeps nothing else. */
  private finish(state: number[]): number[] {
    const done = new Array<number>(state.length).fill(0);
    done[G_PHASE] = DONE;
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      const landed = this.land(state, b);
      done[b + D_TERM] = landed.term;
      done[b + D_READ_SEQ] = landed.readSeq;
      done[b + D_VERDICT] = landed.verdict;
      done[b + D_TRUTH] = (state[b + RAN_F] === 1 ? T_RAN_AT_FREEZE : 0) | (state[b + RANU_F] === 1 ? T_RAN_UNOBSERVED_AT_FREEZE : 0) | (state[b + RANU] === 1 ? T_RAN_UNOBSERVED : 0) | (state[G_ENDED] === 0 ? T_ATTACHER_LIVES : 0);
      done[b + D_SEQ_F] = state[b + SEQ_F];
      done[b + D_MOVED] = landed.moved;
    }
    return done;
  }

  /** The terms of a finished state, for the replay to hold the real readout to, and the world's own facts, to judge it by. */
  termsOf(key: string): LandedWorker[] {
    const state = decode(key);
    return Array.from({ length: this.world.workers }, (_unused, w) => {
      const b = this.base(w);
      const truth = state[b + D_TRUTH];
      return { term: TERM_CODES[state[b + D_TERM]], readSeq: state[b + D_READ_SEQ], ranAtFreeze: (truth & T_RAN_AT_FREEZE) !== 0, ranUnobservedAtFreeze: (truth & T_RAN_UNOBSERVED_AT_FREEZE) !== 0, ranUnobserved: (truth & T_RAN_UNOBSERVED) !== 0, attacherLives: (truth & T_ATTACHER_LIVES) !== 0, realmAtFreeze: state[b + D_SEQ_F], movedFromAt11: state[b + D_MOVED] === 1 ? "toUnread" : state[b + D_MOVED] === 2 ? "toStream" : "no" };
    });
  }

  /** The verdict bits of a state: nothing until it has finished. Most are read from the world's facts by `judged`. */
  verdictOf(key: string): number {
    const state = decode(key);
    if (state[G_PHASE] !== DONE) return 0;
    let verdict = 0;
    for (let w = 0; w < this.world.workers; w += 1) verdict |= state[this.base(w) + D_VERDICT];
    for (const landed of this.termsOf(key)) for (const property of judged(landed)) verdict |= propertyMask(property);
    return verdict;
  }

  isFinished(key: string): boolean {
    return key.charCodeAt(G_PHASE) === DONE;
  }

  /** The fields the replay holds the real mirror to. */
  mirrorOf(key: string, w: number): MirrorView {
    const state = decode(key);
    const b = this.base(w);
    return { known: state[b + KNOWN] === 1, hold: HOLD_WORD[state[b + M_HOLD]], detached: state[b + DET] === 1, detachedWhilePaused: state[b + DWP] === 1, endedUnreached: state[b + UNREACHED] === 1, install: INSTALL_WORD[state[b + INSTALL]] };
  }

  /**
   * The named trace, read off a state whose readout has not ended: a worker that ran with no
   * observer before the freeze, which the mirror does not yet call late, by how the freeze found
   * it and where the word that would say so is. Whether it is excluded is for the landing to say.
   */
  namedTraceAt(key: string, w: number): NamedTrace | null {
    const state = decode(key);
    if (state[G_PHASE] !== DRAINING && state[G_PHASE] !== WAITING_FOR_TREES) return null;
    const b = this.base(w);
    if (state[b + RANU_F] !== 1 || state[b + DET] === 1 || state[G_LOST] === 1 || state[b + M_HOLD] === LATE) return null;
    const frozen = this.forms[state[b + FORM]];
    const form = frozen === "held" ? "held" : frozen === "reaching" ? "reaching" : frozen === "" ? "second-pass" : null;
    if (form === null) return null;
    return { form, cause: this.namedCause(state, b) };
  }

  private namedCause(state: readonly number[], b: number): NamedCause {
    for (let slot = PORT; slot < PORT + this.portCapacity; slot += 1) {
      if ((state[slot] & PORT_ITEM) === P_LATE) return (state[slot] & POSTED_BEFORE_FREEZE) !== 0 ? "late-posted-before-the-freeze" : "late-posted-after-the-freeze";
    }
    for (let slot = b + EVENTS; slot < b + EVENTS + EVENT_CAPACITY; slot += 1) {
      if ((state[slot] & ~EMITTED_BEFORE_FREEZE) === E_RESUMED) return "resume-still-on-the-socket";
    }
    for (let slot = PORT; slot < PORT + this.portCapacity; slot += 1) if ((state[slot] & PORT_ITEM) === P_LOST) return "connection-lost-on-the-port";
    if (state[b + CONC] === 1) return "thread-concluded-first";
    return "no-word-on-its-way";
  }

  /** How many reports wait on the port in a state. */
  reportsWaitingAt(key: string): number {
    const state = decode(key);
    if (state[G_PHASE] === DONE) return 0;
    let waiting = 0;
    for (let slot = PORT; slot < PORT + this.portCapacity && state[slot] !== 0; slot += 1) waiting += 1;
    return waiting;
  }

  /** The world's facts as the model holds them in a state, for the test's own fold to agree with. */
  groundTruthOf(key: string): { ran: boolean; ranUnobserved: boolean; ranAtFreeze: boolean; ranUnobservedAtFreeze: boolean }[] {
    const state = decode(key);
    if (state[G_PHASE] === DONE) return this.termsOf(key).map(({ ranAtFreeze, ranUnobservedAtFreeze, ranUnobserved }) => ({ ran: ranAtFreeze, ranUnobserved, ranAtFreeze, ranUnobservedAtFreeze }));
    return Array.from({ length: this.world.workers }, (_unused, w) => {
      const b = this.base(w);
      return { ran: state[b + RAN] === 1, ranUnobserved: state[b + RANU] === 1, ranAtFreeze: state[b + RAN_F] === 1, ranUnobservedAtFreeze: state[b + RANU_F] === 1 };
    });
  }

  /** Where the readout is in a state: before the call, in its drain, waiting for the frame tree past the drain, or ended. */
  phaseOf(key: string): "before-freeze" | "draining" | "waiting-for-trees" | "done" {
    const phase = decode(key)[G_PHASE];
    return phase === BEFORE_FREEZE ? "before-freeze" : phase === DRAINING ? "draining" : phase === WAITING_FOR_TREES ? "waiting-for-trees" : "done";
  }

  /**
   * A state with what the mirror, the installer's record and the readout hold left out, and with them
   * the port and the lost connection, which only the main thread reads: what the world's own moves
   * may depend on. The test holds those moves to being the same in every state that agrees on this.
   */
  worldAndThreadViewOf(key: string): string {
    const state = decode(key);
    const kept: number[] = [state[G_PHASE], state[G_ENDED]];
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      for (let field = 0; field < WORKER_SIZE; field += 1) if (field < KNOWN || field > FORM_11 || field === BARRIER) kept.push(state[b + field]);
    }
    return kept.join();
  }

  /** The thread's own fields in a state: what it can make of a word from here on. */
  threadFieldsOf(key: string, w: number): string {
    const state = decode(key);
    const b = this.base(w);
    return [state[G_ENDED], ...[HOLD, GONE, ACK, EARLY, PROBE, CONC, SCRIPTS, AWAIT_X].map((field) => state[b + field])].join();
  }

  /** A worker attached after the freeze, released by the mirror's word, that ran before it: the drain's second pass reads it as having run nothing. */
  ranButAttachedAfterTheFreeze(key: string, w: number): boolean {
    const state = decode(key);
    const b = this.base(w);
    return state[G_PHASE] === DRAINING && state[b + KNOWN] === 1 && this.forms[state[b + FORM]] === "" && state[b + M_HOLD] === RELEASED && state[b + RAN_F] === 1;
  }

  // ---- Moves ---------------------------------------------------------------------------------

  /** A connection that closes with something on its socket from before the freeze loses that, which C1 and D1 each say does not happen. */
  private closingDropsNews(state: readonly number[]): boolean {
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      if (state[b + ATTACH] === IN_FLIGHT_AT_FREEZE || state[b + DETACH] === IN_FLIGHT_AT_FREEZE) return true;
      for (let slot = b + EVENTS; slot < b + EVENTS + EVENT_CAPACITY && state[slot] !== 0; slot += 1) if ((state[slot] & EMITTED_BEFORE_FREEZE) !== 0) return true;
    }
    return false;
  }

  /** D1's test: the frame tree may answer only behind what the browser emitted before the freeze, and what the thread posted on it. */
  private treesBlockedBy(state: readonly number[]): number {
    for (let slot = PORT; slot < PORT + this.portCapacity && state[slot] !== 0; slot += 1) {
      if ((state[slot] & (POSTED_BEFORE_FREEZE | POSTED_FOR_EARLIER_NEWS)) !== 0) return D1;
    }
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      if (state[b + ATTACH] === IN_FLIGHT_AT_FREEZE || state[b + DETACH] === IN_FLIGHT_AT_FREEZE) return D1;
      for (let slot = b + EVENTS; slot < b + EVENTS + EVENT_CAPACITY && state[slot] !== 0; slot += 1) if ((state[slot] & EMITTED_BEFORE_FREEZE) !== 0) return D1;
    }
    return 0;
  }

  /**
   * The drain has ended, by what it waited for or by its bound. `readout` then awaits the frame
   * trees it asked for at the call, and classifies only after that, so what crosses the port in
   * that wait still lands. The trees may have answered already, and the readout ends now, or not,
   * and it waits. The model tells the two apart only for what the browser emitted before the
   * freeze: anything later can say nothing of the freeze, so the wait ends with that in.
   */
  private drainEnded(state: number[], label: string, blockedBy: number, context: Context, how: "drain" | "bound"): Move[] {
    const ended = { ...context, ended: how };
    // The reduced worlds take the trees as answered ahead, which is their own bound, so D1 has nothing there to forbid.
    if (this.world.reduced) return [this.settled(this.finish(state), label, blockedBy, ended)];
    const moves = [this.settled(this.finish(state), label, blockedBy | this.treesBlockedBy(state), ended)];
    if (this.treesBlockedBy(state) !== 0) {
      const next = state.slice();
      next[G_PHASE] = WAITING_FOR_TREES;
      const move = this.settled(next, label, blockedBy, { ...context, ended: `${how}-waits` });
      moves.push({ ...move, label: `documents-late||&${move.label}` });
    }
    return moves;
  }

  /** A step the main thread hears: the drain may end on it. */
  private mainMoved(next: number[], label: string, blockedBy: number, context: Context): Move[] {
    if (next[G_PHASE] === DRAINING && this.drained(next)) return this.drainEnded(next, label, blockedBy, context, "drain");
    return [this.settled(next, label, blockedBy, context)];
  }

  /** Whether the thread would make nothing of this word, from this state on whatever comes. The test delivers each to the real one. */
  private ignored(state: readonly number[], b: number, event: number): boolean {
    const late = state[b + HOLD] === LATE;
    const concluded = state[b + CONC] === 1;
    const gone = state[b + GONE] === 1;
    const aSessionsOwnWord = event === E_PARSED || event === E_ACK || event === E_PAUSE_MAIN || event === E_PAUSE_SCRIPT || event === E_PAUSE_STATEMENT || event === E_RESUMED;
    // Answers are heard by the promise that asked, whatever became of the worker: a breakpoint's answer behind an early parse still sends its probe.
    if (gone && event === E_ACK && state[b + HOLD] === PENDING && state[b + EARLY] === 1 && state[b + PROBE] === 0) return false;
    return (
      (late && event !== E_BARRIER) ||
      (concluded && (aSessionsOwnWord || event === E_INSTALL_OK || event === E_INSTALL_BAD || event === E_PROBE)) ||
      (concluded && event === E_OFF && state[b + AWAIT_X] === 0) ||
      (gone && (aSessionsOwnWord || event === E_FIRST || event === E_OPEN || event === E_CLOSED))
    );
  }

  /** Every word the model would drop in this state, and whether the thread would forward it as a late worker's own stream. */
  wordsIgnoredAt(key: string, w: number): { word: string; forwarded: boolean }[] {
    const state = decode(key);
    const b = this.base(w);
    const words: { word: string; forwarded: boolean }[] = [];
    for (let event = E_PARSED; event <= E_CLOSED; event += 1) {
      if (state[G_PHASE] === DONE || !this.ignored(state, b, event)) continue;
      words.push({ word: EVENT_NAME[event], forwarded: state[G_ENDED] === 0 && state[b + HOLD] === LATE && state[b + GONE] === 0 && (event === E_FIRST || event === E_OPEN || event === E_CLOSED) });
    }
    return words;
  }

  /** Drops what can no longer matter, so that states that differ only in that are one state. */
  private normalize(state: number[]): void {
    if (state[G_PHASE] === DONE) return;
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      const hold = state[b + HOLD];
      const late = hold === LATE;
      const concluded = state[b + CONC] === 1;
      const gone = state[b + GONE] === 1;
      if (state[b + KNOWN] === 1) state[b + DISC] = 0;
      if (hold !== NO_HOLD) state[b + WAITING] = 0;
      if (state[G_PHASE] !== BEFORE_FREEZE) state[b + RAN] = 0;
      if (hold !== PENDING && hold !== NO_HOLD) {
        state[b + EARLY] = 0;
        state[b + PROBE] = 0;
        state[b + SCRIPTS] = 0;
      }
      if (late || concluded) {
        state[b + EVAL] = 0;
        state[b + ACK] = 0;
        state[b + PAUSED_AGAIN] = 1;
      }
      if (gone) state[b + PAUSED_AGAIN] = 1;
      // The session's words the thread would ignore, from this state on whatever comes.
      let kept = b + EVENTS;
      for (let slot = b + EVENTS; slot < b + EVENTS + EVENT_CAPACITY; slot += 1) {
        const raw = state[slot];
        if (raw === 0) break;
        if (!this.ignored(state, b, raw & ~EMITTED_BEFORE_FREEZE)) {
          state[kept] = raw;
          kept += 1;
        }
      }
      for (let slot = kept; slot < b + EVENTS + EVENT_CAPACITY; slot += 1) state[slot] = 0;
      const phase = state[b + PHASE];
      if (phase === WORLD_GONE) {
        state[b + DBG] = 0;
        state[b + BP] = 0;
        state[b + OBS] = 0;
        state[b + OTHER] = 0;
        state[b + PAUSED_AGAIN] = 0;
      }
      // Past the drain the worker itself does nothing more, and only a barrier still lands.
      if (state[G_PHASE] === WAITING_FOR_TREES) {
        if (phase !== NOT_BORN) state[b + PHASE] = RUNNING;
        for (const field of [DBG, BP, OBS, OTHER, EVAL, PAUSED_AGAIN, SEQ]) state[b + field] = 0;
        let keptCommand = b + COMMANDS;
        for (let slot = b + COMMANDS; slot < b + COMMANDS + COMMAND_CAPACITY; slot += 1) {
          const command = state[slot];
          state[slot] = 0;
          if (command === C_BARRIER) {
            state[keptCommand] = command;
            keptCommand += 1;
          }
        }
        continue;
      }
      if (phase === RUNNING && state[b + PAUSED_AGAIN] === 1) {
        if (!this.world.stream) state[b + OBS] = 0;
        state[b + DBG] = 0;
        state[b + BP] = 0;
        state[b + OTHER] = 0;
      }
    }
  }

  private step(label: string, context: Context): string {
    return `${label}|${context.posts.join(",")}|${context.sends.join(",")}${context.ended === null ? "" : `#${context.ended}`}`;
  }

  /** One move, and, when a session's own order is not the question, the steps that follow it at once. */
  private settled(next: number[], label: string, blockedBy: number, context: Context): Move {
    let state = next;
    let labels = this.step(label, context);
    let blocked = blockedBy;
    this.normalize(state);
    if (this.world.collapseSessions && state[G_PHASE] !== DONE) {
      for (let again = this.eagerStep(state); again !== null; again = this.eagerStep(state)) {
        state = again.next;
        this.normalize(state);
        labels = `${labels}&${again.label}`;
        blocked |= again.blockedBy;
      }
    }
    return { label: labels, blockedBy: blocked, next: state };
  }

  /**
   * The first step that needs no interleaving when a session's own order is not the question: a command
   * landing, or a parse, an ack or a snapshot heard. The second worker of the two-worker world goes further:
   * it runs a plain hold, and only the thread's hearing of its pause, its install's answer and its release
   * are moves, so that what it posts can interleave with the first worker's.
   */
  private eagerStep(state: number[]): Move | null {
    if (state[G_ENDED] === 1) return null;
    const pastTheDrain = state[G_PHASE] === WAITING_FOR_TREES;
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      const phase = state[b + PHASE];
      const plain = w === 1;
      if (pastTheDrain) {
        const event = state[b + EVENTS] & ~EMITTED_BEFORE_FREEZE;
        if (state[b + ATTACH] === NONE_IN_FLIGHT && (event === E_PARSED || event === E_ACK || event === E_FIRST || event === E_PROBE)) return this.eventHeard(state, w, 0);
        continue;
      }
      if (plain && phase === COMPILED && state[b + BP] === 1) {
        const next = state.slice();
        next[b + PHASE] = AT_MAIN;
        this.emit(next, w, E_PAUSE_MAIN);
        return { label: this.step(`reaches-main:${w}:paused`, newContext()), blockedBy: 0, next };
      }
      if (state[b + COMMANDS] !== 0 && phase !== WORLD_GONE) {
        const command = state[b + COMMANDS];
        const paused = phase === AT_MAIN || phase === PAUSED_ELSEWHERE;
        // The install's outcome is a choice, and turning the debugger off is the moment a worker runs, so each stays a move of its own.
        if (plain) return this.commandLands(state, w, 0, command === C_INSTALL && paused ? "ok" : "");
        if (command !== C_OFF && !(command === C_INSTALL && paused)) return this.commandLands(state, w, 0, "");
      }
      const event = state[b + EVENTS] & ~EMITTED_BEFORE_FREEZE;
      if (state[b + ATTACH] === NONE_IN_FLIGHT && (event === E_PARSED || event === E_ACK || event === E_FIRST || event === E_PROBE)) return this.eventHeard(state, w, 0);
    }
    return null;
  }

  private commandLands(state: number[], w: number, index: number, variant: string): Move {
    const next = state.slice();
    const b = this.base(w);
    const command = next[b + COMMANDS + index];
    this.removeFrom(next, b + COMMANDS, COMMAND_CAPACITY, index);
    const context = newContext();
    const phase = next[b + PHASE];
    let blockedBy = index > 0 ? A1 : 0;
    switch (command) {
      case C_ARM:
        next[b + DBG] = 1;
        next[b + BP] = 1;
        // A script already compiled is replayed when the debugger comes on, ahead of the breakpoint's answer.
        if (phase === COMPILED || phase === RUNNING || phase === PAUSED_ELSEWHERE) this.emit(next, w, E_PARSED);
        this.emit(next, w, E_ACK);
        break;
      case C_RUN:
        if (variant === "unheard") blockedBy |= A2;
        this.release(next, w, variant !== "unheard");
        break;
      case C_INSTALL:
        if (phase === AT_MAIN || phase === PAUSED_ELSEWHERE) {
          if (variant === "ok") {
            next[b + OBS] = 1;
            next[b + SEQ] = 1;
            this.emit(next, w, E_FIRST);
            this.emit(next, w, E_INSTALL_OK);
          } else this.emit(next, w, E_INSTALL_BAD);
        } else next[b + EVAL] = 1;
        break;
      case C_OFF:
        next[b + DBG] = 0;
        next[b + BP] = 0;
        if (phase === AT_MAIN || phase === PAUSED_ELSEWHERE) {
          this.run(next, b);
          this.emit(next, w, E_RESUMED);
        }
        this.emit(next, w, E_OFF);
        break;
      case C_PROBE:
        this.emit(next, w, E_PROBE);
        break;
      case C_BARRIER:
        this.emit(next, w, E_BARRIER);
        break;
      default:
        throw new Error(`No such command: ${command}`);
    }
    return { label: this.step(`lands:${w}:${COMMAND_NAME[command]}${variant === "" ? "" : `:${variant}`}${index > 0 ? `:@${index}` : ""}`, context), blockedBy, next };
  }

  private eventHeard(state: number[], w: number, index: number): Move {
    const next = state.slice();
    const b = this.base(w);
    const raw = next[b + EVENTS + index];
    this.removeFrom(next, b + EVENTS, EVENT_CAPACITY, index);
    const context = newContext();
    this.threadHears(next, w, raw & ~EMITTED_BEFORE_FREEZE, (raw & EMITTED_BEFORE_FREEZE) !== 0 ? POSTED_FOR_EARLIER_NEWS : 0, context);
    return { label: this.step(`hears:${w}:${EVENT_NAME[raw & ~EMITTED_BEFORE_FREEZE]}${index > 0 ? `:@${index}` : ""}`, context), blockedBy: index > 0 ? A1 : 0, next };
  }

  /** Z's test: the mirror has heard of every worker born, and has its next word for every worker that has run. */
  private isCurrent(state: readonly number[]): boolean {
    if (state[G_LOST] === 1) return true;
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      if (state[b + PHASE] === NOT_BORN) continue;
      if (state[b + KNOWN] === 0) return false;
      if (state[b + RAN] === 1 && state[b + M_HOLD] !== LATE && state[b + M_HOLD] !== RELEASED && state[b + DET] === 0) return false;
    }
    return true;
  }

  private freeze(state: number[]): Move[] {
    const next = state.slice();
    const context = newContext();
    const blockedBy = this.isCurrent(state) ? 0 : Z;
    next[G_PHASE] = DRAINING;
    for (let slot = PORT; slot < PORT + this.portCapacity && next[slot] !== 0; slot += 1) next[slot] |= POSTED_BEFORE_FREEZE;
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      next[b + RAN_F] = next[b + RAN];
      next[b + RANU_F] = next[b + RANU];
      next[b + SEQ_F] = next[b + SEQ];
      if (next[b + ATTACH] === IN_FLIGHT) next[b + ATTACH] = IN_FLIGHT_AT_FREEZE;
      if (next[b + DETACH] === IN_FLIGHT) next[b + DETACH] = IN_FLIGHT_AT_FREEZE;
      for (let slot = b + EVENTS; slot < b + EVENTS + EVENT_CAPACITY && next[slot] !== 0; slot += 1) next[slot] |= EMITTED_BEFORE_FREEZE;
      if (next[b + KNOWN] === 1) this.freezeWorker(next, w);
    }
    return this.mainMoved(next, "freeze", blockedBy, context);
  }

  private boundBlockedBy(state: readonly number[]): number {
    let blockedBy = 0;
    for (let slot = PORT; slot < PORT + this.portCapacity && state[slot] !== 0; slot += 1) {
      if ((state[slot] & POSTED_BEFORE_FREEZE) !== 0) blockedBy |= A5_BOUND;
      if ((state[slot] & POSTED_FOR_EARLIER_NEWS) !== 0) blockedBy |= C1;
    }
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      if (state[b + ATTACH] === IN_FLIGHT_AT_FREEZE || state[b + DETACH] === IN_FLIGHT_AT_FREEZE) blockedBy |= C1;
      for (let slot = b + EVENTS; slot < b + EVENTS + EVENT_CAPACITY && state[slot] !== 0; slot += 1) if ((state[slot] & EMITTED_BEFORE_FREEZE) !== 0) blockedBy |= C1;
    }
    return blockedBy;
  }

  successors(state: number[]): Move[] {
    const moves: Move[] = [];
    if (state[G_PHASE] === DONE) return moves;
    const { workers, collapseSessions, stream, reduced } = this.world;
    // Past the drain, only what was on its way at the freeze moves, in order. A worker's later run says nothing of the freeze.
    const pastTheDrain = state[G_PHASE] === WAITING_FOR_TREES;
    if (pastTheDrain && this.treesBlockedBy(state) === 0) {
      const context = newContext();
      context.ended = "documents";
      return [this.settled(this.finish(state), "documents-answered", 0, context)];
    }
    for (let w = 0; w < workers; w += 1) {
      const b = this.base(w);
      const phase = state[b + PHASE];
      // A worker born after the attacher's connection closed can be seen by discovery alone, and is left out.
      if (phase === NOT_BORN && state[G_ENDED] === 0 && !pastTheDrain) {
        for (const waiting of reduced ? [1] : [1, 0]) {
          const next = state.slice();
          next[b + PHASE] = waiting === 1 ? START_HELD : RUNNING;
          next[b + WAITING] = waiting;
          next[b + ATTACH] = IN_FLIGHT;
          next[b + PAUSED_AGAIN] = waiting === 1 ? 0 : 1;
          if (waiting === 0) {
            if (state[G_PHASE] === BEFORE_FREEZE) next[b + RAN] = 1;
            next[b + RANU] = 1;
          }
          moves.push(this.settled(next, `born:${w}:${waiting === 1 ? "waiting" : "running"}`, 0, newContext()));
        }
      }
      if (phase !== NOT_BORN && state[G_ENDED] === 0) {
        const plain = w === 1;
        // A start-up hold that does not hold, which A4 says never happens. For a shared worker it leads where another
        // client's release does, and another client's release always can, so A4 can change nothing here: the test asserts that.
        if (!pastTheDrain && !reduced && state[b + OTHER] === 0 && phase === START_HELD) {
          const next = state.slice();
          next[b + OTHER] = 1;
          this.release(next, w, true);
          moves.push(this.settled(next, `starts-unreleased:${w}`, A4, newContext()));
        }
        // Another client's release, once.
        if (!pastTheDrain && !plain && state[b + OTHER] === 0 && ((phase === START_HELD && !reduced) || phase === AT_MAIN || phase === PAUSED_ELSEWHERE)) {
          const next = state.slice();
          next[b + OTHER] = 1;
          this.release(next, w, true);
          moves.push(this.settled(next, `other-release:${w}`, 0, newContext()));
          if (phase !== START_HELD && !reduced) {
            const silent = state.slice();
            silent[b + OTHER] = 1;
            this.release(silent, w, false);
            moves.push(this.settled(silent, `other-release-unheard:${w}`, A2, newContext()));
          }
        }
        if (!pastTheDrain && phase === COMPILED) {
          const next = state.slice();
          if (next[b + BP] === 1) {
            next[b + PHASE] = AT_MAIN;
            this.emit(next, w, E_PAUSE_MAIN);
            moves.push(this.settled(next, `reaches-main:${w}:paused`, 0, newContext()));
            if (!reduced) {
              const dependency = state.slice();
              dependency[b + PHASE] = PAUSED_ELSEWHERE;
              this.emit(dependency, w, E_PAUSE_SCRIPT);
              moves.push(this.settled(dependency, `reaches-dependency:${w}`, 0, newContext()));
            }
          } else {
            this.run(next, b);
            moves.push(this.settled(next, `reaches-main:${w}:ran`, 0, newContext()));
          }
        }
        // A running worker with the debugger on can stop at a statement, or at a later script with the breakpoint set, once.
        if (!pastTheDrain && !reduced && phase === RUNNING && state[b + DBG] === 1 && state[b + PAUSED_AGAIN] === 0) {
          const next = state.slice();
          next[b + PAUSED_AGAIN] = 1;
          next[b + PHASE] = PAUSED_ELSEWHERE;
          this.emit(next, w, E_PAUSE_STATEMENT);
          moves.push(this.settled(next, `stops-at-statement:${w}`, 0, newContext()));
          if (state[b + BP] === 1) {
            const script = state.slice();
            script[b + PAUSED_AGAIN] = 1;
            script[b + PHASE] = PAUSED_ELSEWHERE;
            this.emit(script, w, E_PAUSE_SCRIPT);
            moves.push(this.settled(script, `stops-at-script:${w}`, 0, newContext()));
          }
        }
        // An install that reached a running worker evaluates at its next task or pause.
        if (!pastTheDrain && state[b + EVAL] === 1 && (phase === RUNNING || phase === PAUSED_ELSEWHERE)) {
          const next = state.slice();
          next[b + EVAL] = 0;
          next[b + OBS] = 1;
          next[b + SEQ] = 1;
          this.emit(next, w, E_FIRST);
          this.emit(next, w, E_INSTALL_OK);
          moves.push(this.settled(next, `evaluates-late:${w}:ok`, 0, newContext()));
          const bad = state.slice();
          bad[b + EVAL] = 0;
          this.emit(bad, w, E_INSTALL_BAD);
          moves.push(this.settled(bad, `evaluates-late:${w}:bad`, 0, newContext()));
        }
        // The realm's own stream, a task and its close, once the observer is in. A late worker's stream is read by nothing.
        if (!pastTheDrain && stream && phase === RUNNING && state[b + OBS] === 1 && (state[b + SEQ] === 1 || state[b + SEQ] === 2) && state[b + HOLD] !== LATE) {
          const next = state.slice();
          next[b + SEQ] = state[b + SEQ] + 1;
          this.emit(next, w, next[b + SEQ] === 2 ? E_OPEN : E_CLOSED);
          moves.push(this.settled(next, `emits:${w}:${next[b + SEQ] === 2 ? "open" : "closed"}`, 0, newContext()));
        }
        if (!pastTheDrain && !plain && phase !== WORLD_GONE) {
          const next = state.slice();
          next[b + PHASE] = WORLD_GONE;
          next[b + EVAL] = 0;
          for (let slot = b + COMMANDS; slot < b + COMMANDS + COMMAND_CAPACITY; slot += 1) next[slot] = 0;
          next[b + DETACH] = IN_FLIGHT;
          moves.push(this.settled(next, `ends:${w}`, 0, newContext()));
        }
        // The browser takes a session's commands in order, unless A1 is not assumed.
        if (phase !== WORLD_GONE) {
          for (let index = 0; index < (reduced || pastTheDrain ? 1 : COMMAND_CAPACITY) && state[b + COMMANDS + index] !== 0; index += 1) {
            const command = state[b + COMMANDS + index];
            const paused = phase === AT_MAIN || phase === PAUSED_ELSEWHERE;
            if (pastTheDrain && command !== C_BARRIER) continue;
            if (collapseSessions && command !== C_OFF && !(command === C_INSTALL && paused)) continue;
            const variants = command === C_INSTALL && paused ? (reduced ? ["ok"] : ["ok", "bad"]) : command === C_RUN && paused ? (reduced ? [""] : ["", "unheard"]) : [""];
            for (const variant of variants) {
              const move = this.commandLands(state, w, index, variant);
              moves.push(this.moved(move));
            }
          }
        }
        // The thread hears its socket. The attach comes first, and the detach from any point if a detach can overtake.
        if (state[b + ATTACH] !== NONE_IN_FLIGHT) {
          const next = state.slice();
          const context = newContext();
          this.threadHearsAttach(next, w, state[b + ATTACH] === IN_FLIGHT_AT_FREEZE ? POSTED_FOR_EARLIER_NEWS : 0, context);
          moves.push(this.settled(next, `hears:${w}:attach:${state[b + WAITING] === 1 ? "waiting" : "running"}`, 0, context));
        } else {
          for (let index = 0; index < (reduced || pastTheDrain ? 1 : EVENT_CAPACITY) && state[b + EVENTS + index] !== 0; index += 1) {
            const event = state[b + EVENTS + index] & ~EMITTED_BEFORE_FREEZE;
            if (collapseSessions && (event === E_PARSED || event === E_ACK || event === E_FIRST || event === E_PROBE)) continue;
            moves.push(this.moved(this.eventHeard(state, w, index)));
          }
          if (state[b + DETACH] !== NONE_IN_FLIGHT) {
            const blockedBy = state[b + EVENTS] !== 0 ? NOT_A3 : 0;
            const carried = state[b + DETACH] === IN_FLIGHT_AT_FREEZE ? POSTED_FOR_EARLIER_NEWS : 0;
            const unreached = state[b + HOLD] === PENDING && state[b + SCRIPTS] === 0;
            for (const lifetime of unreached && !reduced ? (["quick", "long"] as const) : (["long"] as const)) {
              const next = state.slice();
              const context = newContext();
              this.threadHearsDetach(next, w, lifetime, carried, context);
              moves.push(this.settled(next, `hears:${w}:detach:${lifetime}`, blockedBy, context));
            }
          }
        }
        // The thread's own bounds.
        if (!pastTheDrain && !reduced && state[b + HOLD] === HELD && state[b + CONC] === 0 && state[b + GONE] === 0) {
          const next = state.slice();
          const context = newContext();
          this.conclude(next, w, "none", 0, context);
          moves.push(this.settled(next, `hold-bound:${w}`, 0, context));
        }
        if (!pastTheDrain && !reduced && state[b + AWAIT_X] === 1) {
          const next = state.slice();
          const context = newContext();
          next[b + AWAIT_X] = 0;
          next[b + HOLD] = RELEASED;
          this.post(next, w, P_RELEASED, "released:off", 0, context);
          moves.push(this.settled(next, `off-bound:${w}`, 0, context));
        }
        // The barrier's way to the thread and, unanswered, its bound.
        if (stream && state[b + BARRIER] === BARRIER_TO_THREAD) {
          const next = state.slice();
          const context = newContext();
          if (next[b + GONE] === 1) {
            next[b + BARRIER] = BARRIER_REPLIED;
            this.post(next, w, P_REPLY_ERROR, "reply:error", 0, context);
          } else {
            next[b + BARRIER] = BARRIER_SENT;
            this.command(next, w, C_BARRIER, context);
          }
          moves.push(this.settled(next, `thread-gets-barrier:${w}`, 0, context));
        }
        if (!pastTheDrain && stream && state[b + BARRIER] === BARRIER_SENT) {
          const next = state.slice();
          const context = newContext();
          next[b + BARRIER] = BARRIER_REPLIED;
          this.post(next, w, P_REPLY_ERROR, "reply:error", 0, context);
          moves.push(this.settled(next, `barrier-bound:${w}`, 0, context));
        }
        // With no stream to read past, the barrier is one round trip, behind everything the port holds.
        if (!stream && state[b + BARRIER] === BARRIER_TO_THREAD && state[b + GONE] === 0 && phase !== WORLD_GONE && state[PORT] === 0) {
          const next = state.slice();
          const context = newContext();
          next[b + BARRIER] = BARRIER_REPLIED;
          this.answerBarrier(next, b);
          moves.push(...this.mainMoved(next, `barrier-round-trip:${w}`, 0, context));
        }
      }
      // Discovery on the page's channel, which is not the attacher's. Once the mirror knows the worker it changes nothing.
      if (!reduced && phase !== NOT_BORN && state[b + DISC] === 0 && state[b + KNOWN] === 0) {
        const next = state.slice();
        const context = newContext();
        next[b + DISC] = 1;
        moves.push(...this.mainMoved(next, `discovered:${w}`, 0, context));
      }
    }
    // The port, in order, unless A5's first half is not assumed.
    for (let index = 0; index < (reduced || pastTheDrain || (!stream && state[G_PHASE] !== BEFORE_FREEZE) ? 1 : this.portCapacity) && state[PORT + index] !== 0; index += 1) {
      const next = state.slice();
      const raw = next[PORT + index];
      this.removeFrom(next, PORT, this.portCapacity, index);
      const context = newContext();
      this.mirrorHears(next, raw);
      const w = (raw & WORKER_STEP) === 0 ? 0 : 1;
      moves.push(...this.mainMoved(next, `mirror-hears:${w}:${PORT_NAME[raw & PORT_ITEM]}${index > 0 ? `:@${index}` : ""}`, index > 0 ? A5_FIFO : 0, context));
    }
    // The connection closes, and the thread reports it last. Or the thread dies, and nothing queued arrives.
    if (state[G_ENDED] === 0 && !pastTheDrain) {
      const closed = state.slice();
      const context = newContext();
      this.post(closed, 0, P_LOST, "lost", 0, context);
      this.endThread(closed);
      moves.push(this.settled(closed, "connection-closes", this.closingDropsNews(state) ? C1 | D1 : 0, context));
      if (!reduced) {
        const died = state.slice();
        this.endThread(died);
        for (let slot = PORT; slot < PORT + this.portCapacity; slot += 1) died[slot] = 0;
        if (died[G_LOST] === 0) this.loseChannel(died);
        const diedContext = newContext();
        moves.push(...this.mainMoved(died, "thread-dies", 0, diedContext));
      }
    }
    if (state[G_PHASE] === BEFORE_FREEZE) moves.push(...this.freeze(state));
    if (state[G_PHASE] === DRAINING) moves.push(...this.drainEnded(state, "settle-bound", this.boundBlockedBy(state), newContext(), "bound"));
    if (pastTheDrain) {
      const context = newContext();
      context.ended = "documents";
      moves.push(this.settled(this.finish(state), "documents-answered", this.treesBlockedBy(state), context));
    }
    // The two-worker world's bound: no more than this many reports waiting on the port, which is what its own count rests on.
    if (reduced) return moves.filter((move) => move.next[G_PHASE] === DONE || move.next[PORT + REDUCED_PORT_BOUND] === 0);
    return moves;
  }

  /** A step already built, with what follows it. */
  private moved(move: Move): Move {
    let state = move.next;
    let labels = move.label;
    let blocked = move.blockedBy;
    this.normalize(state);
    if (this.world.collapseSessions && state[G_PHASE] !== DONE) {
      for (let again = this.eagerStep(state); again !== null; again = this.eagerStep(state)) {
        state = again.next;
        this.normalize(state);
        labels = `${labels}&${again.label}`;
        blocked |= again.blockedBy;
      }
    }
    return { label: labels, blockedBy: blocked, next: state };
  }

  private endThread(state: number[]): void {
    state[G_ENDED] = 1;
    for (let w = 0; w < this.world.workers; w += 1) {
      const b = this.base(w);
      for (let slot = b + COMMANDS; slot < b + COMMANDS + COMMAND_CAPACITY; slot += 1) state[slot] = 0;
      for (let slot = b + EVENTS; slot < b + EVENTS + EVENT_CAPACITY; slot += 1) state[slot] = 0;
      state[b + ATTACH] = NONE_IN_FLIGHT;
      state[b + DETACH] = NONE_IN_FLIGHT;
      state[b + DBG] = 0;
      state[b + BP] = 0;
      state[b + EVAL] = 0;
      // Chromium resumes a worker held for a client that went away.
      const phase = state[b + PHASE];
      if (phase === START_HELD || phase === COMPILED || phase === AT_MAIN || phase === PAUSED_ELSEWHERE) this.run(state, b);
    }
  }
}

// ---------------------------------------------------------------------------------------
// fingerprint-observer@11, for the direction property. Spelled out, as lib/fv-worker-readout.test.ts
// spells it, from `git show b3f740da^:lib/worker-fingerprint-realm.ts`. It restates an old rule,
// so it catches the code drifting from what @12 said it changed, not a wrong rule at @11.
// ---------------------------------------------------------------------------------------

function holdAt11(state: readonly number[], b: number): number {
  // @11's mirror had no rewrite: gone after its install answered, it stayed held until a release came.
  return state[b + REWROTE] === 1 && state[b + M_RELEASED] === 0 ? HELD : state[b + M_HOLD];
}

function goneAt11(state: readonly number[], b: number): Before {
  return state[b + DET] === 1 && state[b + UNREACHED] === 1 && state[b + QUICK] === 1 ? { state: "ended-at-once" } : { state: "unread", reason: "unreached" };
}

/** What @11's freeze said. Its dwp took every detach while held as died paused. */
function formAt11(state: readonly number[], b: number): string {
  if (state[b + LOST] === 1) return "unread:channelLostAlive";
  if (state[b + DWP] === 1 || state[b + DIED_AFTER] === 1) return "excluded:diedPaused";
  const hold = holdAt11(state, b);
  if (hold === HELD) return "held";
  if (hold === LATE) return "unread:attachedLate";
  if (hold === PENDING) {
    if (state[b + DET] === 0) return "reaching";
    const gone = goneAt11(state, b);
    return gone.state === "ended-at-once" ? "ended-at-once" : "unread:unreached";
  }
  if (state[b + INSTALL] !== 1) return "unread:installFailed";
  return "stream";
}

function landedAt11(state: readonly number[], b: number, frozen: string): Before {
  if (frozen === "") {
    // Attached after the freeze, by @11's second pass.
    const lost = state[b + LOST] === 1;
    if (lost) return { state: "unread", reason: "channelLostAlive" };
    if (state[b + DWP] === 1 || state[b + DIED_AFTER] === 1) return { state: "excluded", reason: "diedPaused" };
    const hold = holdAt11(state, b);
    if (hold === HELD) return resolveHeldAt11(state, b);
    if (hold === LATE) return { state: "unread", reason: "attachedLate" };
    if (hold === PENDING) return state[b + DET] === 1 ? goneAt11(state, b) : { state: "reaching" };
    return { state: "excluded", reason: "pausedAtReadout" };
  }
  if (frozen === "reaching") {
    if (state[b + LOST] === 1) return { state: "unread", reason: "channelLostAlive" };
    const hold = holdAt11(state, b);
    if (hold === HELD) return resolveHeldAt11(state, b);
    if (hold === RELEASED) return { state: "excluded", reason: "pausedAtReadout" };
    if (hold === LATE) return { state: "unread", reason: "attachedLate" };
    return state[b + DET] === 1 ? goneAt11(state, b) : { state: "reaching" };
  }
  if (frozen === "held") return resolveHeldAt11(state, b);
  if (frozen === "stream") return { state: "stream" };
  if (frozen === "ended-at-once") return { state: "ended-at-once" };
  const [settled, reason] = frozen.split(":");
  return { state: settled, reason };
}

function resolveHeldAt11(state: readonly number[], b: number): Before {
  const hold = holdAt11(state, b);
  if (hold === LATE) return { state: "unread", reason: "attachedLate" };
  if (hold === HELD && state[b + LOST] === 1) return { state: "unread", reason: "channelLostAlive" };
  return { state: "excluded", reason: "pausedAtReadout" };
}

/** What the kernels say before the stream is read, in the reference's shape. */
function formNow(form: string, resolved: { state: string; reason?: string }): Before {
  if (form === "closed" || form === "waiting" || form === "unread:streamBroken") return { state: "stream" };
  return resolved.state === "excluded" || resolved.state === "unread" ? { state: resolved.state, reason: resolved.reason } : { state: resolved.state };
}


// ---------------------------------------------------------------------------------------
// One dedicated worker: A4's own world. The session and the installer run on the main thread,
// so there is no port and no lag: the channel's own resume decides what the readout reads.
// ---------------------------------------------------------------------------------------

// The world.
const DW_PHASE = 0;
const DW_OBS = 1;
const DW_RAN = 2;
const DW_RANU = 3;
const DW_WAITING = 4;
const DW_ATTACH = 5;
const DW_DETACH = 6;
const DW_RESUME = 7;
const DW_INSTALL_FLIGHT = 8;
const DW_RAN_F = 9;
// The session and the installer.
const DW_STAGE = 10;
const DW_RELEASED = 11;
const DW_DETACHED = 12;
const DW_DWP = 13;
const DW_INSTALL = 14;
const DW_LOST = 15;
const DW_CHANNEL_LOST = 16;
// The readout.
const DW_READOUT = 17;
const DW_FORM = 18;
const DW_BARRIER = 19;
/** The channel was gone at the freeze, so the frame trees could not be read. */
const DW_NO_TREES = 20;
const DW_SIZE = 21;

const DW_NOT_BORN = 0;
const DW_HELD = 1;
const DW_RUNNING = 2;
const DW_GONE = 3;
// DW_STAGE: 0 unheard, the recursion being armed, the install in flight, concluded.
const DW_UNHEARD = 0;
const DW_ARMING = 1;
const DW_INSTALLING = 2;
const DW_CONCLUDED = 3;
const DW_FORMS = ["", "excluded:pausedAtReadout", "excluded:diedPaused", "unread:channelLostAlive", "unread:attachedLate", "unread:installFailed", "unread:streamBroken", "closed", "waiting", "held-before-install"];

/** The dedicated readout's kernels, the real ones or a variant's. */
export type DedicatedKernels = {
  freezeDedicatedRealm(record: never): { state: string; reason?: string };
  streamAtFreeze(record: never): { state: string; reason?: string };
  dedicatedLandedTerm(realm: never, loaders: ReadonlyMap<string, string> | null): { term: string; snapshot: string | null };
};

export const DEDICATED_PROPERTIES = ["a-dedicated-worker-held-at-its-attach-and-excluded-ran-no-page-code-before-the-freeze", "a-dedicated-worker-read-had-the-observer-before-every-statement", "a-dedicated-worker-excluded-ran-no-page-code-before-the-freeze"] as const;
export type DedicatedProperty = (typeof DEDICATED_PROPERTIES)[number];
export const dedicatedPropertyMask = (property: DedicatedProperty): number => 1 << DEDICATED_PROPERTIES.indexOf(property);
/** What the world says of a dedicated worker, for the replay to judge the real readout by. */
export function judgedDedicated(term: string, truth: { ranAtFreeze: boolean; ranUnobserved: boolean; heldAtAttach: boolean }): DedicatedProperty[] {
  const broken: DedicatedProperty[] = [];
  if ((term === "pausedAtReadout" || term === "diedPaused") && truth.ranAtFreeze) {
    broken.push("a-dedicated-worker-excluded-ran-no-page-code-before-the-freeze");
    if (truth.heldAtAttach) broken.push("a-dedicated-worker-held-at-its-attach-and-excluded-ran-no-page-code-before-the-freeze");
  }
  if ((term === "readable" || term === "ownerUnknown") && truth.ranUnobserved) broken.push("a-dedicated-worker-read-had-the-observer-before-every-statement");
  return broken;
}
const OWNER_FRAME = "owner-frame";
const OWNER_LOADER = "owner-loader";

export class DedicatedWorkerModel {
  private readonly kernels: DedicatedKernels;

  constructor(kernels: DedicatedKernels) {
    this.kernels = kernels;
  }

  explore(): Graph {
    return explore(new Array<number>(DW_SIZE).fill(0), (state) => this.successors(state));
  }

  private view(state: readonly number[]): unknown {
    const installed = state[DW_INSTALL] === 1;
    return {
      worker: { sessionId: "dw-0", kind: "dedicated", nested: false, arrivedOnSessionId: "page", ownerFrameId: OWNER_FRAME, waitingForDebugger: state[DW_WAITING] === 1, released: state[DW_RELEASED] === 1, detached: state[DW_DETACHED] === 1, detachedWhilePaused: state[DW_DWP] === 1 },
      install: INSTALL_WORD[state[DW_INSTALL]],
      owner: { frameId: OWNER_FRAME, loaderId: OWNER_LOADER },
      lastWord: installed ? "closed" : null,
      lastClosed: installed ? snapshotText(1) : null,
      broken: false,
      lostWithChannel: state[DW_LOST] === 1
    };
  }

  private freeze(state: number[]): void {
    // An attached worker with no record yet is still held by the recursion's arming: the readout counts it held.
    if (state[DW_STAGE] === DW_ARMING) {
      state[DW_FORM] = DW_FORMS.indexOf("held-before-install");
      return;
    }
    if (state[DW_STAGE] === DW_UNHEARD) return;
    const view = this.view(state) as never;
    const frozen = this.kernels.freezeDedicatedRealm(view);
    if (frozen.state !== "stream") {
      state[DW_FORM] = DW_FORMS.indexOf(`${frozen.state}:${frozen.reason}`);
      return;
    }
    const stream = this.kernels.streamAtFreeze(view);
    if (stream.state === "unread") state[DW_FORM] = DW_FORMS.indexOf("unread:streamBroken");
    else if (stream.state === "closed") state[DW_FORM] = DW_FORMS.indexOf("closed");
    else {
      state[DW_FORM] = DW_FORMS.indexOf("waiting");
      state[DW_BARRIER] = state[DW_CHANNEL_LOST] === 1 ? 0 : 1;
    }
  }

  private drained(state: readonly number[]): boolean {
    if (state[DW_CHANNEL_LOST] === 1) return true;
    const form = DW_FORMS[state[DW_FORM]];
    return form !== "waiting" || state[DW_BARRIER] === 2 || state[DW_LOST] === 1;
  }

  private finish(state: readonly number[]): number[] {
    const done = new Array<number>(DW_SIZE).fill(0);
    done[DW_READOUT] = DONE;
    const form = DW_FORMS[state[DW_FORM]];
    if (form === "") {
      done[DW_FORM] = 0;
    } else if (form === "held-before-install") {
      done[DW_FORM] = WORKER_TERMS.indexOf("pausedAtReadout") + 1;
    } else {
      const view = this.view(state);
      const realm =
        form === "closed" ? { record: view, state: "closed", snapshot: snapshotText(1) } : form === "waiting" ? { record: view, state: "waiting", slot: { barrier: state[DW_BARRIER] === 2 ? "answered" : "pending", freezeSeq: null, snapshot: state[DW_BARRIER] === 2 ? snapshotText(1) : null } } : { record: view, state: form.split(":")[0], reason: form.split(":")[1] };
      const landed = this.kernels.dedicatedLandedTerm(realm as never, state[DW_NO_TREES] === 1 ? null : new Map([[OWNER_FRAME, OWNER_LOADER]]));
      done[DW_FORM] = [...WORKER_TERMS, ...DEDICATED_ONLY_TERMS].indexOf(landed.term) + 1;
    }
    done[DW_RAN_F] = state[DW_RAN_F];
    done[DW_RANU] = state[DW_RANU];
    done[DW_WAITING] = state[DW_WAITING];
    return done;
  }

  termOf(key: string): string | null {
    const state = decode(key);
    if (state[DW_READOUT] !== DONE) return null;
    return state[DW_FORM] === 0 ? "nowhere" : [...WORKER_TERMS, ...DEDICATED_ONLY_TERMS][state[DW_FORM] - 1];
  }

  truthOf(key: string): { ranAtFreeze: boolean; ranUnobserved: boolean; heldAtAttach: boolean } {
    const state = decode(key);
    return { ranAtFreeze: state[DW_RAN_F] === 1, ranUnobserved: state[DW_RANU] === 1, heldAtAttach: state[DW_WAITING] === 1 };
  }

  verdictOf(key: string): number {
    const term = this.termOf(key);
    if (term === null) return 0;
    return judgedDedicated(term, this.truthOf(key)).reduce((verdict, property) => verdict | dedicatedPropertyMask(property), 0);
  }

  isFinished(key: string): boolean {
    return key.charCodeAt(DW_READOUT) === DONE;
  }

  /** The fields the replay holds the real session and installer to. */
  sessionOf(key: string): { attached: number; installed: number; failed: number; resumed: boolean; ended: boolean } {
    const state = decode(key);
    return { attached: state[DW_STAGE] === DW_UNHEARD ? 0 : 1, installed: state[DW_INSTALL] === 1 ? 1 : 0, failed: state[DW_INSTALL] === 2 || state[DW_INSTALL] === 3 ? 1 : 0, resumed: state[DW_RELEASED] === 1, ended: state[DW_READOUT] === DONE };
  }

  private run(state: number[]): void {
    state[DW_PHASE] = DW_RUNNING;
    if (state[DW_READOUT] === BEFORE_FREEZE) state[DW_RAN] = 1;
    if (state[DW_OBS] === 0) state[DW_RANU] = 1;
  }

  private release(state: number[]): void {
    if (state[DW_RELEASED] === 1) return;
    state[DW_RELEASED] = 1;
    state[DW_RESUME] = 1;
  }

  private conclude(state: number[], install: number): void {
    if (state[DW_INSTALL] === 0) state[DW_INSTALL] = install;
    if (state[DW_STAGE] !== DW_CONCLUDED) state[DW_STAGE] = DW_CONCLUDED;
    this.release(state);
  }

  private afterMain(state: number[], step: string): Move {
    const done = state[DW_READOUT] === DRAINING && this.drained(state);
    return { label: `${step}||${done ? "#drain" : ""}`, blockedBy: 0, next: done ? this.finish(state) : state };
  }

  successors(state: number[]): Move[] {
    const moves: Move[] = [];
    if (state[DW_READOUT] === DONE) return moves;
    const phase = state[DW_PHASE];
    const lost = state[DW_CHANNEL_LOST] === 1;
    const push = (mutate: (next: number[]) => void, step: string, blockedBy = 0) => {
      const next = state.slice();
      mutate(next);
      moves.push({ label: `${step}||`, blockedBy, next });
    };
    if (phase === DW_NOT_BORN && !lost) {
      push((next) => {
        next[DW_PHASE] = DW_HELD;
        next[DW_WAITING] = 1;
        next[DW_ATTACH] = 1;
      }, "born:waiting");
      push((next) => {
        next[DW_ATTACH] = 1;
        next[DW_WAITING] = 0;
        this.run(next);
      }, "born:running");
    }
    // A held worker that runs anyway, which A4 says never happens.
    if (phase === DW_HELD) push((next) => this.run(next), "runs-while-held", A4);
    if (phase === DW_HELD || phase === DW_RUNNING) {
      push((next) => {
        next[DW_PHASE] = DW_GONE;
        next[DW_DETACH] = 1;
        next[DW_RESUME] = 0;
        next[DW_INSTALL_FLIGHT] = 0;
      }, "ends");
    }
    if (state[DW_RESUME] === 1 && phase !== DW_GONE) {
      push((next) => {
        next[DW_RESUME] = 0;
        if (next[DW_PHASE] === DW_HELD) this.run(next);
      }, "resume-lands");
    }
    if (!lost) {
      if (state[DW_ATTACH] === 1) {
        moves.push(this.afterMainMove(state, (next) => {
          next[DW_ATTACH] = 0;
          next[DW_STAGE] = DW_ARMING;
        }, `hears-attach:${state[DW_WAITING] === 1 ? "waiting" : "running"}`));
      } else if (state[DW_DETACH] === 1) {
        moves.push(this.afterMainMove(state, (next) => {
          next[DW_DETACH] = 0;
          next[DW_DETACHED] = 1;
          next[DW_DWP] = next[DW_RELEASED] === 1 ? 0 : 1;
          // A detach answers a barrier still waiting.
          if (next[DW_BARRIER] === 1) next[DW_BARRIER] = 2;
        }, "hears-detach"));
      }
      if (state[DW_STAGE] === DW_ARMING) {
        moves.push(this.afterMainMove(state, (next) => {
          if (next[DW_WAITING] === 0) {
            next[DW_INSTALL] = 3;
            next[DW_STAGE] = DW_CONCLUDED;
            this.release(next);
          } else {
            next[DW_STAGE] = DW_INSTALLING;
            next[DW_INSTALL_FLIGHT] = next[DW_PHASE] === DW_GONE ? 0 : 1;
          }
        }, "arm-answered"));
      }
      if (state[DW_INSTALL_FLIGHT] === 1) {
        for (const outcome of ["ok", "bad"]) {
          moves.push(this.afterMainMove(state, (next) => {
            next[DW_INSTALL_FLIGHT] = 0;
            if (outcome === "ok") next[DW_OBS] = 1;
            this.conclude(next, outcome === "ok" ? 1 : 2);
          }, `install-answered:${outcome}`));
        }
      }
      // The channel's pause bound: every installer hears the conclusion before the resume goes out.
      if ((state[DW_STAGE] === DW_ARMING || state[DW_STAGE] === DW_INSTALLING) && state[DW_RELEASED] === 0) {
        moves.push(this.afterMainMove(state, (next) => {
          next[DW_INSTALL] = next[DW_INSTALL] === 0 ? 2 : next[DW_INSTALL];
          this.release(next);
          next[DW_STAGE] = DW_CONCLUDED;
        }, "pause-bound"));
      }
      if (state[DW_READOUT] === DRAINING && state[DW_BARRIER] === 1 && state[DW_DETACHED] === 0) {
        moves.push(this.afterMainMove(state, (next) => {
          next[DW_BARRIER] = 2;
        }, "barrier-answered"));
      }
      moves.push(this.afterMainMove(state, (next) => {
        next[DW_CHANNEL_LOST] = 1;
        // A record made after the channel closed is lost with it, gone or not: the installer asks only whether the channel lives.
        if (next[DW_STAGE] === DW_ARMING || (next[DW_STAGE] !== DW_UNHEARD && next[DW_DETACHED] === 0)) next[DW_LOST] = 1;
        // Every send still waiting is refused, so the flow runs to its end: the worker is concluded, as failed if nothing answered.
        if (next[DW_STAGE] !== DW_UNHEARD && next[DW_STAGE] !== DW_CONCLUDED) {
          next[DW_STAGE] = DW_CONCLUDED;
          if (next[DW_INSTALL] === 0) next[DW_INSTALL] = 2;
          next[DW_RELEASED] = 1;
        }
        next[DW_ATTACH] = 0;
        next[DW_DETACH] = 0;
        next[DW_RESUME] = 0;
        next[DW_INSTALL_FLIGHT] = 0;
        // Chromium resumes a worker held for a client that went away.
        if (next[DW_PHASE] === DW_HELD) this.run(next);
      }, "channel-closes"));
    }
    if (state[DW_READOUT] === BEFORE_FREEZE) {
      moves.push(this.afterMainMove(state, (next) => {
        next[DW_READOUT] = DRAINING;
        next[DW_RAN_F] = next[DW_RAN];
        next[DW_NO_TREES] = next[DW_CHANNEL_LOST];
        this.freeze(next);
      }, "freeze"));
    }
    if (state[DW_READOUT] === DRAINING) moves.push({ label: "settle-bound||#bound", blockedBy: 0, next: this.finish(state) });
    return moves;
  }

  private afterMainMove(state: number[], mutate: (next: number[]) => void, step: string): Move {
    const next = state.slice();
    mutate(next);
    return this.afterMain(next, step);
  }
}
