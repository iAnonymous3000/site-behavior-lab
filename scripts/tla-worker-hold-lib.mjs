// What the TLA+ worker-hold conformance suite and its export script share: a labeled graph, built
// from the hand-written model (lib/fv-worker-model.ts) or from what TLC prints for the
// specification (specs/worker-hold), and the digest that says whether two such graphs take the
// same steps.
//
// A label is a move's steps as the model words them, then the switches that forbid the move.
// The end of a readout adds one edge for each worker, which says what it landed as and the
// world's own facts about it. Two graphs with the same digest from their first states are
// bisimilar over those labels, unless two different digests collide: each takes exactly the
// label sequences the other takes, under every set of switches, and lands every worker the same
// way. A digest is SHA-256 cut to 128 bits, so the equality of two graphs is established by a
// truncated digest and not edge by edge. States are compared by what they can do and never by
// how either side holds them, so the two need not agree on a state's fields.

import { createHash } from "node:crypto";

/** The worlds the specification's configurations name, with the hand-written model's own names for them. */
export const WORLDS = {
  hold: { model: "HOLD_WORLD", constants: { WorkerCount: 1, CollapseSessions: false, Stream: false, StartReleased: false, Reduced: false } },
  stream: { model: "STREAM_WORLD", constants: { WorkerCount: 1, CollapseSessions: false, Stream: true, StartReleased: true, Reduced: false } },
  two: { model: "TWO_WORKER_WORLD", constants: { WorkerCount: 2, CollapseSessions: true, Stream: false, StartReleased: false, Reduced: true } },
  small: { model: "SMALL_WORLD", constants: { WorkerCount: 1, CollapseSessions: true, Stream: false, StartReleased: false, Reduced: true } }
};

export const SWITCHES = ["A1", "A2", "notA3", "A4", "A5fifo", "A5bound", "C1", "D1", "Z"];
export const PLAN_AXIOMS = ["A1", "A2", "notA3", "A4", "A5fifo", "A5bound"];

/** The rows, by the name each has in lib/fv-worker-model.ts, with the invariant that states each in WorkerHold.tla. */
export const ROWS = {
  "excluded-implies-no-page-code-before-the-freeze": "ExcludedRanNothing",
  "excluded-implies-no-unobserved-page-code-before-the-freeze": "ExcludedRanNothingUnobserved",
  "read-implies-the-observer-preceded-every-statement": "ReadHadItsObserver",
  "a-read-state-is-no-older-than-the-freeze": "ReadNoOlderThanTheFreeze",
  "every-worker-the-readout-heard-of-lands-in-one-term": "HeardLandsInOneTerm",
  "a-worker-that-ran-before-the-freeze-lands-in-a-term": "RanLandsInATerm"
};

// As WorkerHold.tla and the hand-written model name them. Nothing in the specification produces "diedPaused" or
// "ownerUnscoped": they are in the sets and no worker ever lands in either.
const EXCLUDED_TERMS = ["pausedAtReadout", "diedPaused"];
const READ_TERMS = ["readable", "ownerUnscoped"];
const UNREAD_TERMS = ["installFailed", "attachedLate", "unreached", "cutOff", "streamBroken", "channelLostAlive", "diedHeld"];
const WORKER_TERMS = [...EXCLUDED_TERMS, ...UNREAD_TERMS, ...READ_TERMS, "endedAtOnce"];

/**
 * The reachability companions of WorkerHold.tla, restated over one landed worker: each is true of
 * a worker whose landing makes the companion of that name false. A companion says that something
 * never happens, so it is reached, and TLC reports it violated, exactly where some worker lands
 * so. The export script holds this restatement to TLC's own verdict on every cell it runs.
 */
export const COMPANION_REACHED_BY = {
  NoWorkerExcluded: (landed) => EXCLUDED_TERMS.includes(landed.term),
  NoWorkerRanBeforeTheFreeze: (landed) => landed.ranAtFreeze,
  NoWorkerRanUnobservedBeforeTheFreeze: (landed) => landed.ranUnobservedAtFreeze,
  NoWorkerRead: (landed) => READ_TERMS.includes(landed.term),
  NoWorkerRanUnobserved: (landed) => landed.ranUnobserved,
  NoReadPastTheFirstSnapshot: (landed) => READ_TERMS.includes(landed.term) && landed.realmAtFreeze > 1,
  NoWorkerInANamedTerm: (landed) => WORKER_TERMS.includes(landed.term),
  NoWorkerRanWithTheAttacherAlive: (landed) => landed.ranAtFreeze && landed.attacherLives,
  NoWorkerNowhere: (landed) => landed.term === "nowhere"
};

/**
 * What each row needs before it has anything to judge: every companion listed for it must be
 * reached, in the world and under the switches the row is listed as holding in. The first of a
 * row's companions is the row's subject (a worker lands the way the row speaks of); the second,
 * where there is one, is the fact that would break it. For F4-AGE the second is a read of a realm
 * that was past its first snapshot at the freeze: with one snapshot to read and no older one, the
 * row cannot tell a right read from a wrong one. A row with a companion that is never reached
 * holds whatever the protocol does, and is not listed there.
 */
export const COMPANIONS = {
  "excluded-implies-no-page-code-before-the-freeze": ["NoWorkerExcluded", "NoWorkerRanBeforeTheFreeze"],
  "excluded-implies-no-unobserved-page-code-before-the-freeze": ["NoWorkerExcluded", "NoWorkerRanUnobservedBeforeTheFreeze"],
  "read-implies-the-observer-preceded-every-statement": ["NoWorkerRead", "NoWorkerRanUnobserved"],
  "a-read-state-is-no-older-than-the-freeze": ["NoWorkerRead", "NoReadPastTheFirstSnapshot"],
  "every-worker-the-readout-heard-of-lands-in-one-term": ["NoWorkerInANamedTerm"],
  "a-worker-that-ran-before-the-freeze-lands-in-a-term": ["NoWorkerRanWithTheAttacherAlive", "NoWorkerNowhere"]
};

/** The companions a list of rows needs, each once, in the order the rows name them. */
export const companionsOf = (rows) => [...new Set(rows.flatMap((row) => COMPANIONS[row]))];

/**
 * Where a row has nothing to judge, by world: some companion of it is reached under no set of
 * switches there. The suite holds each entry to the hand-written model's own graph, and holds that
 * no other row in any world is so. README.md says the same in sentences.
 */
export const NOT_JUDGED = {
  hold: ["a-read-state-is-no-older-than-the-freeze"],
  stream: [
    "excluded-implies-no-page-code-before-the-freeze",
    "excluded-implies-no-unobserved-page-code-before-the-freeze",
    "read-implies-the-observer-preceded-every-statement",
    "a-worker-that-ran-before-the-freeze-lands-in-a-term"
  ],
  two: ["a-read-state-is-no-older-than-the-freeze"],
  small: ["a-read-state-is-no-older-than-the-freeze"]
};

const blockedText = (names) => [...names].sort().join(",");

/** A label of the specification: its steps as TLC printed them, in the model's wording. */
export function specLabel(steps, blocked) {
  const text = steps
    .map(({ name, posts, sends, ended }) => `${name.join(":")}|${posts.map((post) => post.join(":")).join(",")}|${sends.map((send) => send.join(":")).join(",")}${ended === "" ? "" : `#${ended}`}`)
    .join("&");
  return `${text} /${blockedText(blocked)}`;
}

export const modelLabel = (label, blockedNames) => `${label} /${blockedText(blockedNames)}`;

/** What a worker landed as, and the world's facts about it, as an edge's label. The model's word on @11 is left out: the specification does not state that row. */
export const landedLabel = (worker, { term, readSeq, ranAtFreeze, ranUnobservedAtFreeze, ranUnobserved, attacherLives, realmAtFreeze }) =>
  `landed:${worker}:${term},${readSeq},${Number(ranAtFreeze)},${Number(ranUnobservedAtFreeze)},${Number(ranUnobserved)},${Number(attacherLives)},${realmAtFreeze}`;

/** A graph under construction: node 0 is the first state, and the last node made by `sink` takes the landing edges. */
export function newGraph() {
  const edges = [[]];
  let sinkNode = -1;
  return {
    edges,
    node() {
      edges.push([]);
      return edges.length - 1;
    },
    edge(from, label, to) {
      edges[from].push([label, to]);
    },
    sink() {
      if (sinkNode < 0) {
        edges.push([]);
        sinkNode = edges.length - 1;
      }
      return sinkNode;
    }
  };
}

/** The hand-written model's whole graph of a world, with nothing assumed. `module` is the compiled lib/fv-worker-model. */
export function modelGraph(module, model, explored) {
  const graph = newGraph();
  for (let state = 1; state < explored.keys.length; state += 1) graph.node();
  for (let state = 0; state < explored.keys.length; state += 1) {
    for (let edge = explored.firstEdge[state]; edge < explored.firstEdge[state + 1]; edge += 1) {
      graph.edge(state, modelLabel(explored.labels[explored.edgeLabel[edge]], module.namesOf(explored.edgeBlockedBy[edge])), explored.edgeTo[edge]);
    }
    if (model.isFinished(explored.keys[state])) model.termsOf(explored.keys[state]).forEach((landed, worker) => graph.edge(state, landedLabel(worker, landed), graph.sink()));
  }
  return graph;
}

/**
 * Each node's digest: SHA-256 over its edges, each a label and the digest of where it leads,
 * sorted. Two nodes with one digest take the same labels to nodes with one digest, all the way
 * down. A cycle has no such digest, and throws: both graphs here only ever move forward.
 */
export function digests(graph) {
  const size = graph.edges.length;
  const digest = new Array(size).fill(null);
  const state = new Uint8Array(size);
  for (let root = 0; root < size; root += 1) {
    if (state[root] === 2) continue;
    const stack = [[root, 0]];
    state[root] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const [node, at] = top;
      if (at < graph.edges[node].length) {
        top[1] += 1;
        const to = graph.edges[node][at][1];
        if (state[to] === 1) throw new Error("The graph has a cycle, so its states have no digest of this kind");
        if (state[to] === 0) {
          state[to] = 1;
          stack.push([to, 0]);
        }
        continue;
      }
      const lines = [...new Set(graph.edges[node].map(([label, to]) => `${label}\u0000${digest[to]}`))].sort();
      digest[node] = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex").slice(0, 32);
      state[node] = 2;
      stack.pop();
    }
  }
  return digest;
}

/** What the suite pins of a graph: its first state's digest, how many states it has once those that take the same steps are one, and its sizes as built. */
export function summary(graph, digest = digests(graph)) {
  let edges = 0;
  for (const out of graph.edges) edges += out.length;
  return { digest: digest[0], classes: new Set(digest).size, nodes: graph.edges.length, edges };
}

/** The labels that reach the first pair of states at which two graphs part, and what each can do there that the other cannot. Null when they do not part. */
export function firstDifference(left, right, leftDigest = digests(left), rightDigest = digests(right)) {
  if (leftDigest[0] === rightDigest[0]) return null;
  let a = 0;
  let b = 0;
  const path = [];
  for (;;) {
    const ours = new Map(left.edges[a].map(([label, to]) => [label, to]));
    const theirs = new Map(right.edges[b].map(([label, to]) => [label, to]));
    const onlyLeft = [...ours.keys()].filter((label) => !theirs.has(label)).sort();
    const onlyRight = [...theirs.keys()].filter((label) => !ours.has(label)).sort();
    if (onlyLeft.length > 0 || onlyRight.length > 0) return { path, onlyLeft, onlyRight };
    const next = [...ours.keys()].sort().find((label) => leftDigest[ours.get(label)] !== rightDigest[theirs.get(label)]);
    if (next === undefined) return { path, onlyLeft: ["a state that takes one label two ways"], onlyRight: [] };
    path.push(next);
    a = ours.get(next);
    b = theirs.get(next);
  }
}

/** Every label of a graph with how often it occurs, for a count of the kinds of step. */
export function labelCounts(graph) {
  const counts = new Map();
  for (const out of graph.edges) for (const [label] of out) counts.set(label, (counts.get(label) ?? 0) + 1);
  return counts;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The rows that fail under a set of switches, from what TLC found with the switches a path used
 * carried along: a row fails under a set exactly when some state broke it on a path that used no
 * switch of the set. `violations` maps a row to the sets of switches such paths broke.
 */
export function failsUnder(violations, row, assumed) {
  return (violations[row] ?? []).some((used) => used.every((name) => !assumed.includes(name)));
}

/** The smallest subsets of `axioms` a row holds under, in the hand-written suite's shape: [] when it holds under none, [[]] when it needs none. */
export function smallestSets(violations, row, axioms) {
  const holding = [];
  for (let mask = 0; mask < 1 << axioms.length; mask += 1) {
    const assumed = axioms.filter((_name, at) => (mask & (1 << at)) !== 0);
    if (!failsUnder(violations, row, assumed)) holding.push(assumed);
  }
  return holding.filter((set) => !holding.some((other) => other.length < set.length && other.every((name) => set.includes(name)))).sort((x, y) => x.length - y.length || x.join().localeCompare(y.join()));
}
