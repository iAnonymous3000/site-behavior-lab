import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DedicatedWorkerAttachSession,
  type AttachedWorker,
  type DevtoolsChannel,
  type DevtoolsEvent,
  type WorkerRealmInstaller
} from "./devtools-worker-channel";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";
import * as productionAttacher from "./shared-worker-attacher";
import type { AttachedSharedWorker, AttacherTransport, SharedWorkerHold, SharedWorkerVisitChannel } from "./shared-worker-attacher";
import * as productionRealm from "./worker-fingerprint-realm";
import type { WorkerFingerprintRealmReadout, WorkerRealmView } from "./worker-fingerprint-realm";

/**
 * CL8a, an exhaustive check of the readout's classifier: the pure kernels of
 * lib/worker-fingerprint-realm.ts, over the whole view domain.
 *
 * Domain, shared: hold (4), detached, detachedWhilePaused, lostWithChannel, install
 * outcome (4), attached after the freeze or not, lifetime (none, under the 10 ms bound,
 * at it, one past it) by endedUnreached, last word (none, open, open with an older closed
 * snapshot, closed with a snapshot, closed with the realm's own null), broken. Each view
 * that waits on the drain is walked against every view at the drain's end (hold,
 * detached, detachedWhilePaused, lostWithChannel, lifetime by endedUnreached), and each
 * that reads its stream against every slot, loss, break and credit. Domain, dedicated:
 * released, detached, detachedWhilePaused, lostWithChannel, install outcome (4), last
 * word (5), broken, owner (none, reading, unknown, shown current, its frame gone, its
 * loader replaced), frame trees read or not, slot (3), and loss and break at the drain's
 * end.
 *
 * Within that domain the properties hold for all inputs at this commit. Combinations
 * the mirror never produces, such as detachedWhilePaused on a released worker, are
 * walked too, which says nothing about whether one occurs. What this holds is the
 * classifier and the view it is given. Whether the view is true of the worker is the
 * model's question (F4), and whether Chromium behaves as the model says is a
 * measurement. That excluded means no page code ran is not checked here: "ran page
 * code" is not in the view. This part takes no axiom about a browser or a transport: its
 * only premise is that a view's fields are what the kernels are handed.
 *
 * CL7, below, runs the real readout over worlds built through the real session and the
 * real mirror, which is what holds the class to these kernels.
 */

type Kernels = Pick<
  typeof productionRealm,
  | "freezeDedicatedRealm"
  | "freezeSharedRealm"
  | "resolveSharedRealm"
  | "streamAtFreeze"
  | "dedicatedLandedTerm"
  | "sharedLandedTerm"
>;

type Install = WorkerRealmView["install"];
type LastWord = "none" | "open" | "open-after-closed" | "closed" | "closed-null";
type Lifetime = { lifetimeMs: number | null; endedUnreached: boolean };

const HOLDS: readonly SharedWorkerHold[] = ["pending", "held", "late", "released"];
const BOTH = [false, true] as const;
const INSTALLS: readonly Install[] = [null, "installed", "failed", "attached-late"];
const LAST_WORDS: readonly LastWord[] = ["none", "open", "open-after-closed", "closed", "closed-null"];
/** Spelled out. The reference and the worlds read it here, so that a bound moved in production shows against them. */
const BOUND = 10;
const UNDER_THE_BOUND = 5;
/** Two of these eight end at once by the real predicate: never reached, and gone within the bound. */
const LIFETIMES: readonly Lifetime[] = [null, UNDER_THE_BOUND, BOUND, BOUND + 1].flatMap((lifetimeMs) => BOTH.map((endedUnreached) => ({ lifetimeMs, endedUnreached })));
const SNAPSHOT = '{"snapshot":"at the freeze"}';
/** What a worker's last closed emission said before a task it has left open. Never its state at the freeze. */
const OLDER_SNAPSHOT = '{"snapshot":"before its last task"}';
const SLOTS: readonly (string | null)[] = [null, SNAPSHOT, "null"];
const MAIN = { frameId: "main", loaderId: "loader-1", securityOrigin: "http://site.test" };
const WORKER_URL = "http://site.test/w.js";

type SharedView = {
  hold: SharedWorkerHold;
  detached: boolean;
  detachedWhilePaused: boolean;
  lostWithChannel: boolean;
  install: Install;
  attachedAfterFreeze: boolean;
  lifetime: Lifetime;
  lastWord: LastWord;
  broken: boolean;
};

function* sharedViews(): Generator<SharedView> {
  for (const hold of HOLDS) {
    for (const detached of BOTH) {
      for (const detachedWhilePaused of BOTH) {
        for (const lostWithChannel of BOTH) {
          for (const install of INSTALLS) {
            for (const attachedAfterFreeze of BOTH) {
              for (const lifetime of LIFETIMES) {
                for (const lastWord of LAST_WORDS) {
                  for (const broken of BOTH) {
                    yield { hold, detached, detachedWhilePaused, lostWithChannel, install, attachedAfterFreeze, lifetime, lastWord, broken };
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

function lastWordOf(lastWord: LastWord): Pick<WorkerRealmView, "lastWord" | "lastClosed"> {
  if (lastWord === "none") return { lastWord: null, lastClosed: null };
  if (lastWord === "open") return { lastWord: "open", lastClosed: null };
  if (lastWord === "open-after-closed") return { lastWord: "open", lastClosed: OLDER_SNAPSHOT };
  return { lastWord: "closed", lastClosed: lastWord === "closed" ? SNAPSHOT : "null" };
}

function sharedRecord(view: SharedView, credit: Credit = CREDITS[0]): WorkerRealmView {
  const worker: AttachedSharedWorker = {
    sessionId: "worker",
    kind: "shared",
    nested: false,
    arrivedOnSessionId: null,
    ownerFrameId: null,
    waitingForDebugger: true,
    released: view.hold === "released" || view.hold === "late",
    detached: view.detached,
    detachedWhilePaused: view.detachedWhilePaused,
    targetId: "worker-target",
    url: credit.url,
    hold: view.hold,
    lateReason: null,
    attachedAt: 0,
    lifetimeMs: view.lifetime.lifetimeMs,
    endedUnreached: view.lifetime.endedUnreached,
    creationDocument: credit.creation,
    holdMs: null,
    debuggerOffAtRelease: null
  };
  return { worker, install: view.install, owner: null, broken: view.broken, lostWithChannel: view.lostWithChannel, ...lastWordOf(view.lastWord) };
}

/** A view of the world, and whether the world says the worker is credited to the visit's main document. */
type Credit = {
  name: string;
  url: string;
  creation: AttachedSharedWorker["creationDocument"];
  documents: Parameters<typeof productionRealm.sharedLandedTerm>[1];
  credited: boolean;
};

const CREATED_IN_MAIN = { frameId: MAIN.frameId, loaderId: MAIN.loaderId, securityOrigin: MAIN.securityOrigin };
const AT_FREEZE = { loaders: new Map([[MAIN.frameId, MAIN.loaderId]]), main: MAIN };
const CREDITS: readonly Credit[] = [
  { name: "created in the main document, of its origin", url: WORKER_URL, creation: CREATED_IN_MAIN, documents: AT_FREEZE, credited: true },
  { name: "a blob of the main document's origin", url: "blob:http://site.test/1", creation: CREATED_IN_MAIN, documents: AT_FREEZE, credited: true },
  { name: "no creation document", url: WORKER_URL, creation: null, documents: AT_FREEZE, credited: false },
  { name: "created in a replaced document", url: WORKER_URL, creation: { ...CREATED_IN_MAIN, loaderId: "loader-0" }, documents: AT_FREEZE, credited: false },
  { name: "created in another frame", url: WORKER_URL, creation: { ...CREATED_IN_MAIN, frameId: "other" }, documents: AT_FREEZE, credited: false },
  { name: "a script of another origin", url: "http://other.test/w.js", creation: CREATED_IN_MAIN, documents: AT_FREEZE, credited: false },
  { name: "an opaque origin", url: "data:text/javascript,1", creation: CREATED_IN_MAIN, documents: AT_FREEZE, credited: false },
  {
    name: "an opaque main document and an opaque script",
    url: "data:text/javascript,1",
    creation: { ...CREATED_IN_MAIN, securityOrigin: "null" },
    documents: { loaders: AT_FREEZE.loaders, main: { ...MAIN, securityOrigin: "null" } },
    credited: false
  },
  { name: "an unreadable script address", url: "not an address", creation: CREATED_IN_MAIN, documents: AT_FREEZE, credited: false },
  { name: "no frame trees at the freeze", url: WORKER_URL, creation: CREATED_IN_MAIN, documents: null, credited: false },
  { name: "no main frame at the freeze", url: WORKER_URL, creation: CREATED_IN_MAIN, documents: { loaders: new Map(), main: null }, credited: false },
  { name: "no origin for the main frame", url: WORKER_URL, creation: CREATED_IN_MAIN, documents: { loaders: AT_FREEZE.loaders, main: { ...MAIN, securityOrigin: null } }, credited: false }
];

/** The readout's terms, as lib/worker-fingerprint-realm.ts documents each one. Restated: this catches a term moved between kinds, not a wrongly documented one. */
const SHARED_EXCLUDED = new Set(["pausedAtReadout", "diedPaused"]);
const SHARED_UNREAD = new Set(["installFailed", "attachedLate", "unreached", "cutOff", "streamBroken", "channelLostAlive", "diedHeld", "unattached"]);
const SHARED_READ = new Set(["readable", "ownerUnscoped"]);
const SHARED_WORKER_TERMS = [...SHARED_EXCLUDED, ...[...SHARED_UNREAD].filter((term) => term !== "unattached"), ...SHARED_READ, "endedAtOnce"];
const DEDICATED_EXCLUDED = new Set(["pausedAtReadout", "diedPaused", "ownerReplaced"]);
const DEDICATED_UNREAD = new Set(["installFailed", "attachedLate", "cutOff", "streamBroken", "channelLostAlive", "unattachedDedicated"]);
const DEDICATED_READ = new Set(["readable", "ownerUnknown"]);
const DEDICATED_WORKER_TERMS = [...DEDICATED_EXCLUDED, ...[...DEDICATED_UNREAD].filter((term) => term !== "unattachedDedicated"), ...DEDICATED_READ];

const END_MOVES: readonly (Pick<SharedView, "hold" | "detached" | "detachedWhilePaused" | "lostWithChannel"> & { lifetime: Lifetime })[] = HOLDS.flatMap((hold) =>
  BOTH.flatMap((detached) =>
    BOTH.flatMap((detachedWhilePaused) =>
      BOTH.flatMap((lostWithChannel) => LIFETIMES.map((lifetime) => ({ hold, detached, detachedWhilePaused, lostWithChannel, lifetime })))
    )
  )
);

type Before = { state: "excluded" | "unread"; reason: string } | { state: "ended-at-once" | "reaching" | "stream" };

/**
 * fingerprint-observer@11, the classifier before b3f740da, spelled out from `git show
 * b3f740da^:lib/worker-fingerprint-realm.ts`. It restates an old rule, so it catches
 * the code drifting from what @12 said it changed, not a wrong rule at @11.
 */
function freezeSharedAt11(view: SharedView): Before | { state: "held" } {
  if (view.lostWithChannel) return { state: "unread", reason: "channelLostAlive" };
  if (view.detachedWhilePaused) return { state: "excluded", reason: "diedPaused" };
  if (view.hold === "held") return { state: "held" };
  if (view.hold === "late") return { state: "unread", reason: "attachedLate" };
  if (view.hold === "pending") return view.detached ? goneUnreachedAt11(view) : { state: "reaching" };
  if (view.attachedAfterFreeze) return { state: "excluded", reason: "pausedAtReadout" };
  if (view.install !== "installed") return { state: "unread", reason: "installFailed" };
  return { state: "stream" };
}

function goneUnreachedAt11(view: Pick<SharedView, "detached" | "lifetime">): Before {
  const { lifetimeMs, endedUnreached } = view.lifetime;
  return view.detached && endedUnreached && lifetimeMs !== null && lifetimeMs <= BOUND ? { state: "ended-at-once" } : { state: "unread", reason: "unreached" };
}

function resolveReachingAt11(view: SharedView): Before | { state: "held" } {
  if (view.lostWithChannel) return { state: "unread", reason: "channelLostAlive" };
  if (view.hold === "held") return { state: "held" };
  if (view.hold === "released") return { state: "excluded", reason: "pausedAtReadout" };
  if (view.hold === "late") return { state: "unread", reason: "attachedLate" };
  return view.detached ? goneUnreachedAt11(view) : { state: "reaching" };
}

function resolveHeldAt11(view: SharedView): Before {
  if (view.hold === "late") return { state: "unread", reason: "attachedLate" };
  if (view.hold === "held" && view.lostWithChannel) return { state: "unread", reason: "channelLostAlive" };
  return { state: "excluded", reason: "pausedAtReadout" };
}

function sharedAt11(atFreeze: SharedView, atEnd: SharedView): Before {
  const frozen = freezeSharedAt11(atFreeze);
  const reached = frozen.state === "reaching" ? resolveReachingAt11(atEnd) : frozen;
  return reached.state === "held" ? resolveHeldAt11(atEnd) : reached;
}

/** What the kernels say before any stream is read: the same shape as the @11 reference. */
function sharedBeforeStream(kernels: Kernels, atFreeze: SharedView, atEnd: SharedView): Before {
  const frozen = kernels.freezeSharedRealm(sharedRecord(atFreeze), { attachedAfterFreeze: atFreeze.attachedAfterFreeze });
  if (frozen.state === "stream") return { state: "stream" };
  const resolved = kernels.resolveSharedRealm({ ...frozen, record: sharedRecord(atEnd) });
  if (resolved.state === "excluded" || resolved.state === "unread") return { state: resolved.state, reason: resolved.reason };
  if (resolved.state === "ended-at-once" || resolved.state === "reaching") return { state: resolved.state };
  throw new Error(`The kernels resolved a worker to ${resolved.state} before its stream.`);
}

const sameBefore = (left: Before, right: Before): boolean => left.state === right.state && ("reason" in left ? left.reason : null) === ("reason" in right ? right.reason : null);

type SharedTally = { members: number; movedToUnread: number; drainMembers: number; streamMembers: number };

/** The view that decides a worker's class: its view at the freeze, or at the drain's end if it waited on the drain. */
function checkSharedClassifier(kernels: Kernels): SharedTally {
  const tally: SharedTally = { members: 0, movedToUnread: 0, drainMembers: 0, streamMembers: 0 };
  for (const atFreeze of sharedViews()) {
    const frozen = kernels.freezeSharedRealm(sharedRecord(atFreeze), { attachedAfterFreeze: atFreeze.attachedAfterFreeze });
    const waitsOnDrain = frozen.state === "reaching" || frozen.state === "held";
    // One attached after the freeze is classified at the drain's end, so it has one view.
    const ends: readonly SharedView[] = waitsOnDrain && !atFreeze.attachedAfterFreeze ? END_MOVES.map((move) => ({ ...atFreeze, ...move })) : [atFreeze];
    for (const atEnd of ends) {
      tally.members += 1;
      if (waitsOnDrain) tally.drainMembers += 1;
      const input = () => ({ atFreeze, atEnd });
      const now = sharedBeforeStream(kernels, atFreeze, atEnd);
      const before = sharedAt11(atFreeze, atEnd);
      const deciding = waitsOnDrain ? atEnd : atFreeze;

      // Each of these reads the world's own facts and no rule of the classifier.
      holds("cl8a-a-shared-worker-gone-held-is-never-excluded", !(deciding.hold === "held" && deciding.detachedWhilePaused) || now.state === "unread", input);
      holds("cl8a-a-shared-worker-reached-late-is-unread", deciding.hold !== "late" || now.state === "unread", input);
      if (atFreeze.lostWithChannel) holds("cl8a-a-worker-the-channel-left-is-neither-excluded-nor-read", sameBefore(now, { state: "unread", reason: "channelLostAlive" }), input);
      if (deciding.hold === "held" && deciding.lostWithChannel) holds("cl8a-a-worker-the-channel-left-is-neither-excluded-nor-read", now.state === "unread", input);
      holds(
        "cl8a-only-an-installed-worker-released-at-the-freeze-is-read",
        now.state !== "stream" || (atFreeze.hold === "released" && atFreeze.install === "installed" && !atFreeze.attachedAfterFreeze && !atFreeze.detachedWhilePaused && !atFreeze.lostWithChannel),
        input
      );
      const { lifetimeMs, endedUnreached } = deciding.lifetime;
      holds(
        "cl8a-ended-at-once-only-if-never-reached-and-within-the-bound",
        now.state !== "ended-at-once" || (deciding.hold === "pending" && deciding.detached && endedUnreached && lifetimeMs !== null && lifetimeMs <= BOUND),
        input
      );
      if (atFreeze.hold === "pending" && deciding.hold === "pending" && deciding.detached && !deciding.detachedWhilePaused && !deciding.lostWithChannel) {
        holds("cl8a-gone-with-no-pause-is-unread-or-ended-at-once", now.state === "unread" || now.state === "ended-at-once", input);
      }

      // Against the reference. An exclusion may move; nothing else may, and nothing moves back.
      holds("cl8a-at-12-only-exclusions-move-and-only-toward-unread-or-the-stream", now.state === before.state || (before.state === "excluded" && (now.state === "unread" || now.state === "stream")), input);
      if (!sameBefore(now, before)) {
        holds("cl8a-at-12-only-a-worker-gone-held-moves", deciding.detachedWhilePaused && before.state === "excluded" && sameBefore(now, { state: "unread", reason: "diedHeld" }), input);
        tally.movedToUnread += 1;
      }
    }
  }
  return tally;
}

/**
 * The readout's own docblock: a worker excluded or unread at the call stays so,
 * whatever the drain shows, and so does one that ended at once. The main walk gives
 * these one view, so this gives each of them every end. Stream fields are held still:
 * no kernel reads them for a worker that has already landed.
 */
function checkSettledAtFreeze(kernels: Kernels): number {
  let cases = 0;
  for (const atFreeze of sharedViews()) {
    if (atFreeze.lastWord !== "none" || atFreeze.broken) continue;
    const frozen = kernels.freezeSharedRealm(sharedRecord(atFreeze), { attachedAfterFreeze: atFreeze.attachedAfterFreeze });
    if (frozen.state !== "excluded" && frozen.state !== "unread" && frozen.state !== "ended-at-once") continue;
    for (const move of END_MOVES) {
      cases += 1;
      const resolved = kernels.resolveSharedRealm({ ...frozen, record: sharedRecord({ ...atFreeze, ...move }) });
      const stays = resolved.state === frozen.state && ("reason" in resolved ? resolved.reason : null) === ("reason" in frozen ? frozen.reason : null);
      holds("cl8a-excluded-or-unread-at-the-freeze-stays-so", stays, () => ({ atFreeze, move }));
    }
  }
  return cases;
}

/** Every worker that reads its stream, with the slot, the loss, the break and the credit at the drain's end. */
function checkSharedStream(kernels: Kernels): number {
  let cases = 0;
  for (const lastWord of LAST_WORDS) {
    for (const brokenAtFreeze of BOTH) {
      for (const detached of BOTH) {
        for (const slot of SLOTS) {
          for (const lostAtEnd of BOTH) {
            for (const brokenAtEnd of BOTH) {
              for (const credit of CREDITS) {
                cases += 1;
                const atFreeze: SharedView = { hold: "released", detached, detachedWhilePaused: false, lostWithChannel: false, install: "installed", attachedAfterFreeze: false, lifetime: LIFETIMES[0], lastWord, broken: brokenAtFreeze };
                const atEnd = sharedRecord({ ...atFreeze, lostWithChannel: lostAtEnd, broken: brokenAtEnd }, credit);
                const input = () => ({ lastWord, brokenAtFreeze, detached, slot, lostAtEnd, brokenAtEnd, credit: credit.name });
                const landed = landStream(kernels, sharedRecord(atFreeze, credit), atEnd, slot, (realm) => kernels.sharedLandedTerm(kernels.resolveSharedRealm(realm), credit.documents));
                holds("cl8a-every-shared-view-lands-in-a-term-of-its-own", SHARED_WORKER_TERMS.includes(landed.term), input);

                // What the world handed the readout: a stream broken at the freeze, or else the text it holds.
                const closedAtFreeze = detached && (lastWord === "closed" || lastWord === "closed-null");
                const unreadableAtFreeze = brokenAtFreeze || lastWord === "none";
                const text = unreadableAtFreeze ? null : closedAtFreeze ? (lastWord === "closed" ? SNAPSHOT : "null") : slot;
                const whole = text !== null && text !== "null";
                holds("cl8a-a-snapshot-lands-only-with-a-reading-term", SHARED_READ.has(landed.term) === whole && (whole ? landed.snapshot === text : landed.snapshot === null), input);
                if (whole) holds("cl8a-a-shared-snapshot-is-credited-only-by-the-ownership-rule", (landed.term === "readable") === credit.credited, input);
                if (unreadableAtFreeze || text === "null") holds("cl8a-a-stream-with-nothing-whole-is-broken", landed.term === "streamBroken", input);
                else if (text === null) {
                  const expected = lostAtEnd ? "channelLostAlive" : brokenAtEnd ? "streamBroken" : "cutOff";
                  holds("cl8a-a-slot-left-empty-says-why", landed.term === expected, input);
                }
              }
            }
          }
        }
      }
    }
  }
  return cases;
}

/** A worker's stream at the freeze, then its slot and its record at the drain's end, as the class's freezeStream sets them up. */
function landStream<T>(
  kernels: Kernels,
  atFreeze: WorkerRealmView,
  atEnd: WorkerRealmView,
  slot: string | null,
  land: (realm: productionRealm.DedicatedFrozenRealm<WorkerRealmView> & productionRealm.SharedFrozenRealm<WorkerRealmView>) => T
): T {
  const stream = kernels.streamAtFreeze(atFreeze);
  if (stream.state === "gone-open" || stream.state === "running") {
    return land({ record: atEnd, state: "waiting", slot: { barrier: "answered", freezeSeq: 0, snapshot: slot } });
  }
  return land(stream.state === "closed" ? { ...stream, record: atEnd } : { record: atEnd, state: "unread", reason: "streamBroken" });
}

type DedicatedView = {
  released: boolean;
  detached: boolean;
  detachedWhilePaused: boolean;
  lostWithChannel: boolean;
  install: Install;
  lastWord: LastWord;
  broken: boolean;
};
type OwnerState = { name: string; owner: WorkerRealmView["owner"]; shownReplaced: boolean; shownCurrent: boolean };
const OWNER = { frameId: "frame", loaderId: "loader-1" };
const OWNERS: readonly OwnerState[] = [
  { name: "no read started", owner: null, shownReplaced: false, shownCurrent: false },
  { name: "reading", owner: "reading", shownReplaced: false, shownCurrent: false },
  { name: "no vouched answer", owner: "unknown", shownReplaced: false, shownCurrent: false },
  { name: "shown current", owner: OWNER, shownReplaced: false, shownCurrent: true },
  { name: "its frame gone", owner: { frameId: "gone", loaderId: "loader-1" }, shownReplaced: true, shownCurrent: false },
  { name: "its loader replaced", owner: { frameId: "frame", loaderId: "loader-0" }, shownReplaced: true, shownCurrent: false }
];
const LOADERS = new Map([["frame", "loader-1"]]);

function dedicatedRecord(view: DedicatedView, owner: OwnerState): WorkerRealmView {
  const worker: AttachedWorker = {
    sessionId: "worker",
    kind: "dedicated",
    nested: false,
    arrivedOnSessionId: "page",
    ownerFrameId: "frame",
    waitingForDebugger: true,
    released: view.released,
    detached: view.detached,
    detachedWhilePaused: view.detachedWhilePaused
  };
  return { worker, install: view.install, owner: owner.owner, broken: view.broken, lostWithChannel: view.lostWithChannel, ...lastWordOf(view.lastWord) };
}

/** fingerprint-observer@11's `freeze`, which @12 left alone, from the same commit as the shared reference. */
function freezeDedicatedAt11(view: DedicatedView): Before {
  if (view.lostWithChannel) return { state: "unread", reason: "channelLostAlive" };
  if (view.detachedWhilePaused) return { state: "excluded", reason: "diedPaused" };
  if (!view.released) return { state: "excluded", reason: "pausedAtReadout" };
  if (view.install === "attached-late") return { state: "unread", reason: "attachedLate" };
  if (view.install !== "installed") return { state: "unread", reason: "installFailed" };
  return { state: "stream" };
}

function checkDedicatedClassifier(kernels: Kernels): number {
  let cases = 0;
  for (const released of BOTH) {
    for (const detached of BOTH) {
      for (const detachedWhilePaused of BOTH) {
        for (const lostWithChannel of BOTH) {
          for (const install of INSTALLS) {
            for (const lastWord of LAST_WORDS) {
              for (const broken of BOTH) {
                for (const owner of OWNERS) {
                  for (const loaders of [LOADERS, null]) {
                    for (const slot of SLOTS) {
                      for (const lostAtEnd of BOTH) {
                        for (const brokenAtEnd of BOTH) {
                          cases += 1;
                          const view: DedicatedView = { released, detached, detachedWhilePaused, lostWithChannel, install, lastWord, broken };
                          const input = () => ({ view, owner: owner.name, loadersRead: loaders !== null, slot, lostAtEnd, brokenAtEnd });
                          const record = dedicatedRecord(view, owner);
                          const atEnd = { ...record, lostWithChannel: lostAtEnd, broken: brokenAtEnd };
                          const frozen = kernels.freezeDedicatedRealm(record);
                          const before = freezeDedicatedAt11(view);
                          holds("cl8a-the-dedicated-classifier-is-unchanged-since-11", sameBefore(frozen.state === "stream" ? { state: "stream" } : (frozen as Before), before), input);
                          const landed =
                            frozen.state === "stream"
                              ? landStream(kernels, record, atEnd, slot, (realm) => kernels.dedicatedLandedTerm(realm, loaders))
                              : kernels.dedicatedLandedTerm({ ...frozen, record: atEnd }, loaders);
                          holds("cl8a-every-dedicated-view-lands-in-a-term-of-its-own", DEDICATED_WORKER_TERMS.includes(landed.term), input);

                          // The world's own facts again, not the classifier's rule.
                          const shownReplaced = owner.shownReplaced && loaders !== null;
                          if (frozen.state === "excluded") holds("cl8a-excluded-at-the-freeze-stays-so", landed.term === frozen.reason, input);
                          else if (shownReplaced) holds("cl8a-a-worker-of-a-replaced-document-is-excluded-whatever-its-stream-says", landed.term === "ownerReplaced", input);
                          else if (frozen.state === "unread") holds("cl8a-excluded-or-unread-at-the-freeze-stays-so", landed.term === frozen.reason, input);
                          const installedAndReleased = released && install === "installed" && !detachedWhilePaused && !lostWithChannel;
                          if (DEDICATED_READ.has(landed.term)) holds("cl8a-only-an-installed-worker-released-at-the-freeze-is-read", installedAndReleased, input);
                          // What the world handed the readout, as for a shared worker: a stream broken at the freeze, or else the text it holds.
                          const closedAtFreeze = detached && (lastWord === "closed" || lastWord === "closed-null");
                          const unreadableAtFreeze = broken || lastWord === "none";
                          const text = unreadableAtFreeze ? null : closedAtFreeze ? (lastWord === "closed" ? SNAPSHOT : "null") : slot;
                          const whole = frozen.state === "stream" && !shownReplaced && text !== null && text !== "null";
                          holds("cl8a-a-snapshot-lands-only-with-a-reading-term", DEDICATED_READ.has(landed.term) === whole && (whole ? landed.snapshot === text : landed.snapshot === null), input);
                          if (landed.term === "readable") holds("cl8a-a-dedicated-worker-is-credited-only-to-an-owner-shown-current", owner.shownCurrent && loaders !== null, input);
                          if (landed.term === "ownerUnknown") holds("cl8a-an-owner-neither-current-nor-replaced-is-unscoped", !owner.shownCurrent || loaders === null, input);
                          if (owner.shownCurrent && loaders !== null) holds("cl8a-an-owner-neither-current-nor-replaced-is-unscoped", landed.term !== "ownerUnknown", input);
                          // A worker that waits on its slot, and whose slot stayed empty, says why.
                          const waits = !broken && lastWord !== "none" && !(detached && (lastWord === "closed" || lastWord === "closed-null"));
                          if (frozen.state === "stream" && !shownReplaced && waits && slot === null) {
                            holds("cl8a-a-slot-left-empty-says-why", landed.term === (lostAtEnd ? "channelLostAlive" : brokenAtEnd ? "streamBroken" : "cutOff"), input);
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return cases;
}

const PRODUCTION_KERNELS: Kernels = productionRealm;
const realmPath = require.resolve("./worker-fingerprint-realm");
const realmVariant = (...edits: SourceEdit[]) => loadVariant<typeof productionRealm>(realmPath, edits);

/** 20,480 views at the freeze; those that wait on the drain take its 256 ends, unless attached after the freeze. */
const SHARED_VIEWS = 20_480;
const END_MOVE_COUNT = 256;

// Where each kernel's lines are told apart in the emitted module: the same line opens more than one of them.
const FREEZE_DIED_HELD = 'if (worker.detachedWhilePaused)\n        return { record, state: "unread", reason: "diedHeld" };\n    // Held as far as';
const RESOLVE_DIED_HELD = 'if (worker.detachedWhilePaused)\n        return { record, state: "unread", reason: "diedHeld" };\n    return { record, state: "excluded", reason: "pausedAtReadout" };';
const RESOLVE_HELD_LATE = 'if (worker.hold === "late")\n        return { record, state: "unread", reason: "attachedLate" };\n    if (worker.hold === "held" && record.lostWithChannel)';
const FREEZE_SHARED_LATE = 'if (worker.hold === "late")\n        return { record, state: "unread", reason: "attachedLate" };\n    if (worker.hold === "pending") {';
const REACHING_LATE = 'if (worker.hold === "late")\n        return { record, state: "unread", reason: "attachedLate" };\n    if (worker.detached) {';
const HELD_AND_LOST = 'if (worker.hold === "held" && record.lostWithChannel)\n        return { record, state: "unread", reason: "channelLostAlive" };\n';
const SHARED_INSTALL_FAILED = 'if (options.attachedAfterFreeze)\n        return { record, state: "excluded", reason: "pausedAtReadout" };\n    if (record.install !== "installed")\n        return { record, state: "unread", reason: "installFailed" };';
const AFTER_FREEZE_RELEASED = 'if (options.attachedAfterFreeze)\n        return { record, state: "excluded", reason: "pausedAtReadout" };\n';
const REACHING_ENDED = 'if (worker.detached) {\n        return (0, shared_worker_attacher_1.sharedWorkerEndedAtOnce)(worker)';
const FREEZE_ENDED = "        // saw it run and its life fits the bound.\n            return (0, shared_worker_attacher_1.sharedWorkerEndedAtOnce)(worker)";

test("CL8a: the shared classifier holds over every view, and @12 moves only what it said it moved", () => {
  const tally = checkSharedClassifier(PRODUCTION_KERNELS);
  // Held and reaching views wait on the drain: 1,280 and 640 at the freeze, half of each attached after it.
  const waiting = 1_280 + 640;
  assert.equal(tally.drainMembers, waiting / 2 + (waiting / 2) * END_MOVE_COUNT);
  assert.equal(tally.members, SHARED_VIEWS - waiting + tally.drainMembers);
  // What moved from @11: gone held at the freeze with no loss (5,120 views); held at the freeze, not after it (640), then
  // gone held with no loss on 80 of the ends; reaching at the freeze, not after it (320), then the same on 16 of them.
  assert.equal(tally.movedToUnread, 5_120 + 640 * 80 + 320 * 16);
});

test("CL8a: a worker settled at the freeze stays settled, whatever the drain's end shows", () => {
  // Of the 2,048 views with no last word and no break: all but the held (128), the reaching (64) and those their stream decides (16), by the 256 ends.
  assert.equal(checkSettledAtFreeze(PRODUCTION_KERNELS), (2_048 - 128 - 64 - 16) * END_MOVE_COUNT);
});

test("CL8a: a shared worker's stream lands where the world's text says", () => {
  assert.equal(checkSharedStream(PRODUCTION_KERNELS), LAST_WORDS.length * 2 * 2 * SLOTS.length * 2 * 2 * CREDITS.length);
});

test("CL8a: the dedicated classifier holds over every view", () => {
  assert.equal(checkDedicatedClassifier(PRODUCTION_KERNELS), 2 * 2 * 2 * 2 * INSTALLS.length * LAST_WORDS.length * 2 * OWNERS.length * 2 * SLOTS.length * 2 * 2);
});

for (const [name, property, edits] of [
  [
    "shared diedHeld goes back to excluded, in both places, as @11 had it",
    "cl8a-a-shared-worker-gone-held-is-never-excluded",
    [
      { find: FREEZE_DIED_HELD, replace: 'if (worker.detachedWhilePaused)\n        return { record, state: "excluded", reason: "diedPaused" };\n    // Held as far as' },
      { find: RESOLVE_DIED_HELD, replace: 'return { record, state: "excluded", reason: "pausedAtReadout" };' }
    ]
  ],
  [
    "a worker gone held at the freeze is excluded",
    "cl8a-a-shared-worker-gone-held-is-never-excluded",
    [{ find: FREEZE_DIED_HELD, replace: 'if (worker.detachedWhilePaused)\n        return { record, state: "excluded", reason: "diedPaused" };\n    // Held as far as' }]
  ],
  ["a worker gone held during the drain is excluded", "cl8a-a-shared-worker-gone-held-is-never-excluded", [{ find: RESOLVE_DIED_HELD, replace: 'return { record, state: "excluded", reason: "pausedAtReadout" };' }]],
  ["a broken hold seen during the drain is excluded", "cl8a-a-shared-worker-reached-late-is-unread", [{ find: RESOLVE_HELD_LATE, replace: 'if (worker.hold === "held" && record.lostWithChannel)' }]],
  ["a worker reached late at the freeze falls through to its install", "cl8a-at-12-only-a-worker-gone-held-moves", [{ find: FREEZE_SHARED_LATE, replace: 'if (worker.hold === "pending") {' }]],
  ["a reaching worker's late first move is left reaching", "cl8a-a-shared-worker-reached-late-is-unread", [{ find: REACHING_LATE, replace: "if (worker.detached) {" }]],
  ["the loss of a channel during a hold excludes the worker, as @10 had it", "cl8a-a-worker-the-channel-left-is-neither-excluded-nor-read", [{ find: HELD_AND_LOST, replace: "" }]],
  [
    "a worker the channel left at the freeze is read on",
    "cl8a-a-worker-the-channel-left-is-neither-excluded-nor-read",
    [{ find: 'const worker = record.worker;\n    if (record.lostWithChannel)\n        return { record, state: "unread", reason: "channelLostAlive" };\n    // Gone held', replace: "const worker = record.worker;\n    // Gone held" }]
  ],
  ["a failed install is read from its stream", "cl8a-only-an-installed-worker-released-at-the-freeze-is-read", [{ find: SHARED_INSTALL_FAILED, replace: 'if (options.attachedAfterFreeze)\n        return { record, state: "excluded", reason: "pausedAtReadout" };' }]],
  ["a worker attached after the freeze goes on to its install and stream", "cl8a-at-12-only-a-worker-gone-held-moves", [{ find: AFTER_FREEZE_RELEASED, replace: "" }]],
  ["a worker attached after the freeze is read at once", "cl8a-only-an-installed-worker-released-at-the-freeze-is-read", [{ find: AFTER_FREEZE_RELEASED, replace: 'if (options.attachedAfterFreeze)\n        return { record, state: "stream" };\n' }]],
  ["a failed install is excluded", "cl8a-at-12-only-exclusions-move-and-only-toward-unread-or-the-stream", [{ find: SHARED_INSTALL_FAILED, replace: 'if (options.attachedAfterFreeze || record.install !== "installed")\n        return { record, state: "excluded", reason: "pausedAtReadout" };' }]],
  ["still held at the bound counts as unread", "cl8a-at-12-only-a-worker-gone-held-moves", [{ find: RESOLVE_DIED_HELD, replace: 'return { record, state: "unread", reason: worker.detachedWhilePaused ? "diedHeld" : "unreached" };' }]],
  [
    "a worker gone with no pause ended at once at the freeze, whatever its life",
    "cl8a-ended-at-once-only-if-never-reached-and-within-the-bound",
    [{ find: FREEZE_ENDED, replace: "        // saw it run and its life fits the bound.\n            return true" }]
  ],
  ["a reaching worker gone with no pause ended at once, whatever its life", "cl8a-ended-at-once-only-if-never-reached-and-within-the-bound", [{ find: REACHING_ENDED, replace: "if (worker.detached) {\n        return true" }]],
  ["the bound shrinks by one, at the freeze", "cl8a-at-12-only-exclusions-move-and-only-toward-unread-or-the-stream", [{ find: FREEZE_ENDED, replace: "        // saw it run and its life fits the bound.\n            return worker.detached && worker.endedUnreached && worker.lifetimeMs !== null && worker.lifetimeMs <= 9" }]],
  ["only a life of exactly the bound ends at once, by the drain's end", "cl8a-at-12-only-exclusions-move-and-only-toward-unread-or-the-stream", [{ find: REACHING_ENDED, replace: "if (worker.detached) {\n        return worker.detached && worker.endedUnreached && worker.lifetimeMs === 10" }]],
  ["a reaching worker gone with no pause is left reaching", "cl8a-gone-with-no-pause-is-unread-or-ended-at-once", [{ find: REACHING_ENDED, replace: 'if (worker.detached && worker.hold === "never") {\n        return (0, shared_worker_attacher_1.sharedWorkerEndedAtOnce)(worker)' }]]
] as ReadonlyArray<readonly [string, string, SourceEdit[]]>) {
  test(`CL8a catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkSharedClassifier(realmVariant(...edits)));
  });
}

for (const [name, property, edits] of [
  ["a worker excluded at the freeze is resolved again at the drain's end", "cl8a-excluded-or-unread-at-the-freeze-stays-so", [{ find: 'return reached.state === "held" ? resolveHeldRealm(reached.record) : reached;', replace: 'return reached.state === "held" || reached.state === "excluded" ? resolveHeldRealm(reached.record) : reached;' }]],
  ["a worker unread at the freeze is resolved again at the drain's end", "cl8a-excluded-or-unread-at-the-freeze-stays-so", [{ find: 'const reached = realm.state === "reaching" ? ', replace: 'const reached = realm.state === "reaching" || realm.state === "unread" ? ' }]],
  ["a worker that ended at once is resolved again at the drain's end", "cl8a-excluded-or-unread-at-the-freeze-stays-so", [{ find: 'const reached = realm.state === "reaching" ? ', replace: 'const reached = realm.state === "reaching" || realm.state === "ended-at-once" ? ' }]]
] as ReadonlyArray<readonly [string, string, SourceEdit[]]>) {
  test(`CL8a catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkSettledAtFreeze(realmVariant(...edits)));
  });
}

const LAST_SHARED_LINES = 'if (snapshot === "null")\n        return { term: "streamBroken", snapshot: null };\n    return sharedWorkerCredited(';
for (const [name, property, edits] of [
  ["a term the readout has no field for", "cl8a-every-shared-view-lands-in-a-term-of-its-own", [{ find: `return { term: resolved.record.broken ? "streamBroken" : "cutOff", snapshot: null };\n    }\n    ${LAST_SHARED_LINES}`, replace: `return { term: resolved.record.broken ? "streamBroken" : "gone", snapshot: null };\n    }\n    ${LAST_SHARED_LINES}` }]],
  ["the realm's own null is read as a snapshot", "cl8a-a-snapshot-lands-only-with-a-reading-term", [{ find: LAST_SHARED_LINES, replace: "return sharedWorkerCredited(" }]],
  ["every shared snapshot is credited", "cl8a-a-shared-snapshot-is-credited-only-by-the-ownership-rule", [{ find: "? { term: \"readable\", snapshot }\n        : { term: \"ownerUnscoped\", snapshot }", replace: '? { term: "readable", snapshot }\n        : { term: "readable", snapshot }' }]],
  ["no shared snapshot is credited", "cl8a-a-shared-snapshot-is-credited-only-by-the-ownership-rule", [{ find: "? { term: \"readable\", snapshot }\n        : { term: \"ownerUnscoped\", snapshot }", replace: '? { term: "ownerUnscoped", snapshot }\n        : { term: "ownerUnscoped", snapshot }' }]],
  ["credit ignores which document created the worker", "cl8a-a-shared-snapshot-is-credited-only-by-the-ownership-rule", [{ find: "if (created.frameId !== main.frameId || created.loaderId !== main.loaderId)\n        return false;\n", replace: "" }]],
  ["credit ignores the script's origin", "cl8a-a-shared-snapshot-is-credited-only-by-the-ownership-rule", [{ find: "return origin !== null && origin === main.securityOrigin;", replace: "return true;" }]],
  ["an opaque script is credited to an opaque main document", "cl8a-a-shared-snapshot-is-credited-only-by-the-ownership-rule", [{ find: 'return origin === "null" || origin === "" ? null : origin;', replace: "return origin;" }]],
  ["a stream broken at the freeze reads its last snapshot", "cl8a-a-stream-with-nothing-whole-is-broken", [{ find: 'if (record.broken || record.lastWord === null)\n        return { record, state: "unread", reason: "streamBroken" };\n', replace: 'if (record.lastWord === null)\n        return { record, state: "unread", reason: "streamBroken" };\n' }]],
  ["a gone worker's open last word is read at its older snapshot", "cl8a-a-snapshot-lands-only-with-a-reading-term", [{ find: 'if (record.lastWord === "closed" && record.lastClosed !== null) {\n        return { record, state: "closed", snapshot: record.lastClosed };', replace: 'if (record.lastClosed !== null) {\n        return { record, state: "closed", snapshot: record.lastClosed };' }]],
  ["a slot the channel's loss left empty reads as cut off", "cl8a-a-slot-left-empty-says-why", [{ find: 'if (resolved.record.lostWithChannel)\n            return { term: "channelLostAlive", snapshot: null };\n', replace: "" }]]
] as ReadonlyArray<readonly [string, string, SourceEdit[]]>) {
  test(`CL8a catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkSharedStream(realmVariant(...edits)));
  });
}

const DEDICATED_LOST = 'const worker = record.worker;\n    // A worker the closed channel left running cannot be read, held or not:\n    // Chromium resumed it when this client went away.\n    if (record.lostWithChannel)\n        return { record, state: "unread", reason: "channelLostAlive" };\n';
for (const [name, property, edits] of [
  ["a dedicated worker takes a shared worker's reason", "cl8a-the-dedicated-classifier-is-unchanged-since-11", [{ find: 'if (!worker.released)\n        return { record, state: "excluded", reason: "pausedAtReadout" };', replace: 'if (!worker.released)\n        return { record, state: "unread", reason: "unreached" };' }]],
  ["the channel's loss excludes a dedicated worker", "cl8a-the-dedicated-classifier-is-unchanged-since-11", [{ find: DEDICATED_LOST, replace: "const worker = record.worker;\n" }]],
  ["a dedicated partition's term the readout has no field for", "cl8a-every-dedicated-view-lands-in-a-term-of-its-own", [{ find: 'return { term: "ownerReplaced", snapshot: null };', replace: 'return { term: "unreached", snapshot: null };' }]],
  ["state before scope: an unread worker of a replaced document stays unread", "cl8a-a-worker-of-a-replaced-document-is-excluded-whatever-its-stream-says", [{ find: 'if (owner !== null && loaders !== null && loaders.get(owner.frameId) !== owner.loaderId) {', replace: 'if (realm.state !== "unread" && owner !== null && loaders !== null && loaders.get(owner.frameId) !== owner.loaderId) {' }]],
  ["only the frame's loader is compared, so a frame gone reads as current", "cl8a-a-worker-of-a-replaced-document-is-excluded-whatever-its-stream-says", [{ find: 'loaders.get(owner.frameId) !== owner.loaderId) {', replace: 'loaders.has(owner.frameId) && loaders.get(owner.frameId) !== owner.loaderId) {' }]],
  ["scope excludes a worker already excluded by another term", "cl8a-excluded-at-the-freeze-stays-so", [{ find: 'if (realm.state === "excluded")\n        return { term: realm.reason, snapshot: null };\n    const owner = typeof realm.record.owner === "object" ? realm.record.owner : null;\n', replace: 'const owner = typeof realm.record.owner === "object" ? realm.record.owner : null;\n    if (realm.state === "excluded" && !(owner !== null && loaders !== null && loaders.get(owner.frameId) !== owner.loaderId))\n        return { term: realm.reason, snapshot: null };\n' }]],
  ["an unread worker's reason is cut off instead", "cl8a-excluded-or-unread-at-the-freeze-stays-so", [{ find: 'if (realm.state === "unread")\n        return { term: realm.reason, snapshot: null };', replace: 'if (realm.state === "unread")\n        return { term: "cutOff", snapshot: null };' }]],
  ["a dedicated worker with no vouched owner is credited", "cl8a-a-dedicated-worker-is-credited-only-to-an-owner-shown-current", [{ find: 'if (owner === null || loaders === null)\n        return { term: "ownerUnknown", snapshot };\n', replace: "" }]],
  ["an owner shown current is unscoped anyway", "cl8a-an-owner-neither-current-nor-replaced-is-unscoped", [{ find: 'if (owner === null || loaders === null)\n        return { term: "ownerUnknown", snapshot };\n', replace: 'if (owner === null || loaders === null || loaders.size > 0)\n        return { term: "ownerUnknown", snapshot };\n' }]],
  ["frames that could not be read lose a whole snapshot as cut off", "cl8a-a-snapshot-lands-only-with-a-reading-term", [{ find: 'if (owner === null || loaders === null)\n        return { term: "ownerUnknown", snapshot };\n', replace: 'if (loaders === null)\n        return { term: "cutOff", snapshot: null };\n    if (owner === null)\n        return { term: "ownerUnknown", snapshot };\n' }]],
  ["no vouched owner loses a whole snapshot as cut off", "cl8a-a-snapshot-lands-only-with-a-reading-term", [{ find: 'if (owner === null || loaders === null)\n        return { term: "ownerUnknown", snapshot };\n', replace: 'if (owner === null)\n        return { term: "cutOff", snapshot: null };\n    if (loaders === null)\n        return { term: "ownerUnknown", snapshot };\n' }]],
  ["a slot the channel's loss left empty reads as cut off in the dedicated partition", "cl8a-a-slot-left-empty-says-why", [{ find: 'if (realm.record.lostWithChannel)\n            return { term: "channelLostAlive", snapshot: null };\n', replace: "" }]],
  ["the realm's own null is unscoped text", "cl8a-a-snapshot-lands-only-with-a-reading-term", [{ find: 'if (snapshot === "null")\n        return { term: "streamBroken", snapshot: null };\n    // A realm with', replace: "// A realm with" }]]
] as ReadonlyArray<readonly [string, string, SourceEdit[]]>) {
  test(`CL8a catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkDedicatedClassifier(realmVariant(...edits)));
  });
}

/**
 * CL7, a bounded check that every attached worker lands in exactly one term of the real
 * readout's diagnostics, the term its world says, and that the terms add up to what the
 * readout publishes.
 *
 * Domain, dedicated: one worker that starts paused, running, or held by an earlier
 * installer; whose install answers, answers with no first snapshot, answers false, throws
 * in the evaluation, fails, has its sink refused, has its stream break first, or never
 * answers; whose stream after that holds nothing more, an open task, a closed snapshot, a
 * gap or the realm's own null; that goes away never, before the freeze or in the drain;
 * whose barrier answers, never answers or fails; whose owner is current, replaced at the
 * freeze, in no frame of the tree, or read and then refused or never answered by the
 * worker's vouch. Each with the channel alive, lost before the freeze or in the drain, and
 * alive with frame trees that cannot be read. Then workers started by others, no channel
 * at all, witness counts past what attached, and more attached than the witness saw.
 *
 * Domain, shared: one worker on each path the thread can report (attached; gone with no
 * pause, under the bound, at it, past it or with a script seen; late, gone or not; held,
 * then late, gone, or installed by each outcome, then gone or released, then gone), and
 * the reports the mirror must ignore after late, cut at every step into what came before
 * the freeze and what came in the drain, with the channel alive, lost before the freeze or
 * lost at the drain's end. A worker whose install answered also takes each stream, barrier
 * and credit. Then the same stream with no document watched. Left out: a shared worker on
 * the dedicated channel, which installs nothing and stays out of these terms.
 *
 * Domain, the drain, at a bound that never expires: each thing the drain waits for, which
 * must keep it open until that arrives and end it when it does, and emissions that arrive
 * during it, which must not move a freeze point already passed.
 *
 * Axioms. A1: the attacher's thread is scripted, and reports what its onDetached reports
 * in the order it posted, so these messages can drift from the thread's: F4 replays traces
 * through the real one. A2: each scripted answer stands for the browser's, and arrives in
 * the turn it was sent unless a world holds it. A3: a detach reaches the session before
 * the installer, which is the real session's own code. The earlier installer holds until
 * told to, which the real GPC installer does not once its channel closes (see the pin).
 * Every answer is a promise already settled or one that never settles, so each case is
 * decided by order and never by how busy the machine is. Whether a browser ever produces
 * a path, and what a term says of a site, is a measurement.
 *
 * The expected terms restate the docblocks of the diagnostics and of `readout`, so they
 * catch the class drifting from those, not a wrong rule.
 *
 * Findings, each pinned below as what happens and not as what should: a dedicated worker
 * attached in the drain lands in no term, paused or running; the witness and the attached
 * count have nothing to join them, so an unwitnessed worker can mask a witnessed one; a
 * gap in the drain before a barrier's answer leaves the worker read at its older snapshot;
 * one an earlier installer still holds when the channel closes is counted as held.
 * `shared.diedPaused` stays 0 throughout: nothing has written it since
 * fingerprint-observer@12, and the field stays because dropping it changes the shape of the
 * diagnostics.
 */

type RealmModule = Pick<typeof productionRealm, "FingerprintWorkerRealmInstaller">;
type AttacherModule = Pick<typeof productionAttacher, "SharedWorkerAttacher">;
type Modules = { realm: RealmModule; attacher: AttacherModule };
type Installer = InstanceType<RealmModule["FingerprintWorkerRealmInstaller"]>;

const PRODUCTION_MODULES: Modules = { realm: productionRealm, attacher: productionAttacher };
const SITE_KEY = "site.test";
const CONTEXT = "context-a";
const ORIGIN = "http://site.test";

/** No world holds a worker this long, whatever else the machine is doing, so a pause never ends on its own here, and a drain given this as its bound ends only when it has what it waits for. */
const LONG_HOLD_MS = 3_600_000;

/** Everything scripted here answers with a promise already settled or one that never settles, so one turn of the loop delivers all that can arrive. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

type Sent = { method: string; sessionId?: string };

function scriptedChannel(respond: (command: Sent) => Record<string, unknown> | Promise<Record<string, unknown>> | Error) {
  const handlers: Array<(event: DevtoolsEvent) => void> = [];
  const closers: Array<() => void> = [];
  const channel: DevtoolsChannel = {
    async send(method, _params, sessionId) {
      const answer = await respond({ method, ...(sessionId ? { sessionId } : {}) });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    onEvent: (handler) => void handlers.push(handler),
    onClose: (handler) => void closers.push(handler),
    close() {}
  };
  return {
    channel,
    emit(event: DevtoolsEvent) {
      for (const handler of handlers) handler(event);
    },
    drop() {
      for (const closer of closers) closer();
    }
  };
}

function emission(installer: Installer, sessionId: string, sequence: number, word: "open" | "closed", snapshot?: string): DevtoolsEvent {
  const header = `${installer.capability}\n${sequence}\n${word}`;
  return { method: "Runtime.bindingCalled", sessionId, params: { name: installer.sinkName, payload: word === "closed" ? `${header}\n${snapshot}` : header } };
}

const tokenOf = (sessionId: string, sequence: number) => JSON.stringify({ worker: sessionId, sequence });

type DedicatedPlan = {
  start: "paused" | "running" | "held-by-an-earlier-installer";
  install: "answered" | "no-first-snapshot" | "false" | "threw" | "rejected" | "sink-refused" | "broken-first" | "unanswered";
  stream: "first-only" | "open" | "closed" | "gap" | "realm-null";
  gone: "no" | "before-the-freeze" | "in-the-drain";
  barrier: "answered" | "unanswered" | "rejected";
  owner: "current" | "replaced" | "no-such-frame" | "vouch-refused" | "vouch-unanswered";
};
type DedicatedMode = { channel: "alive" | "lost-before-the-freeze" | "lost-in-the-drain"; trees: "read" | "unreadable" };

const QUIET: DedicatedPlan = { start: "paused", install: "answered", stream: "first-only", gone: "no", barrier: "answered", owner: "current" };
const GONES: readonly DedicatedPlan["gone"][] = ["no", "before-the-freeze", "in-the-drain"];
const DEDICATED_OWNERS: readonly DedicatedPlan["owner"][] = ["current", "replaced", "no-such-frame", "vouch-refused", "vouch-unanswered"];
const FAILING_INSTALLS = ["no-first-snapshot", "false", "threw", "rejected", "sink-refused", "broken-first", "unanswered"] as const;

function dedicatedPlans(): DedicatedPlan[] {
  const plans: DedicatedPlan[] = [];
  for (const gone of GONES) {
    plans.push({ ...QUIET, start: "held-by-an-earlier-installer", gone });
    for (const owner of DEDICATED_OWNERS) {
      plans.push({ ...QUIET, start: "running", gone, owner });
      for (const install of FAILING_INSTALLS) plans.push({ ...QUIET, install, gone, owner });
      for (const stream of ["first-only", "open", "closed", "gap", "realm-null"] as const) {
        for (const barrier of ["answered", "unanswered", "rejected"] as const) plans.push({ ...QUIET, stream, gone, barrier, owner });
      }
    }
  }
  return plans;
}
const ALIVE: DedicatedMode = { channel: "alive", trees: "read" };
const DEDICATED_MODES: readonly DedicatedMode[] = [ALIVE, { channel: "alive", trees: "unreadable" }, { channel: "lost-before-the-freeze", trees: "read" }, { channel: "lost-in-the-drain", trees: "read" }];

/** Everything up to the freeze, with each later move left to the world. */
async function dedicatedBench(modules: Modules, plans: readonly DedicatedPlan[], mode: DedicatedMode, options: { nestedUnderFirst?: boolean } = {}) {
  const installer = new modules.realm.FingerprintWorkerRealmInstaller(SITE_KEY);
  const sessionIds = plans.map((_plan, index) => `dw-${index}`);
  const planOf = new Map(sessionIds.map((sessionId, index) => [sessionId, plans[index]]));
  const held = new Map<string, () => void>();
  const hold = (key: string) => new Promise<Record<string, unknown>>((resolve) => held.set(key, () => resolve({})));
  const emitted = new Set<string>();
  let reading = false;
  const scripted = scriptedChannel(({ method, sessionId }) => {
    const plan = sessionId ? planOf.get(sessionId) : undefined;
    if (method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (method === "Page.getFrameTree") {
      if (reading && mode.trees === "unreadable") return new Error("The frame trees could not be read.");
      const childFrames = sessionIds.map((id) => ({ frame: { id: `frame-${id}`, loaderId: reading && planOf.get(id)?.owner === "replaced" ? "loader-2" : "loader-1" } }));
      return { frameTree: { frame: { id: "main-frame", loaderId: "loader-1", securityOrigin: ORIGIN }, childFrames } };
    }
    // The owner's vouch before the readout, its barrier from then on.
    if (method === "Runtime.getIsolateId") {
      if (!reading) return plan?.owner === "vouch-refused" ? new Error("The worker gave no vouch.") : plan?.owner === "vouch-unanswered" ? hold(`vouch:${sessionId}`) : {};
      if (plan === undefined || plan.barrier === "answered") return {};
      return plan.barrier === "rejected" ? new Error("The barrier failed.") : hold(`barrier:${sessionId}`);
    }
    if (method === "Runtime.addBinding" && plan?.install === "sink-refused") return new Error("The sink could not be added.");
    if (method === "Runtime.evaluate" && plan && sessionId) {
      if (plan.install === "rejected") return new Error("The install failed.");
      if (plan.install === "unanswered") return hold(`install:${sessionId}`);
      if (plan.install !== "no-first-snapshot") sayClosed(sessionId, 1);
      if (plan.install === "broken-first") scripted.emit(emission(installer, sessionId, 9, "closed", tokenOf(sessionId, 9)));
      return { result: { value: plan.install !== "false" }, ...(plan.install === "threw" ? { exceptionDetails: { text: "It threw." } } : {}) };
    }
    return {};
  });
  const sayClosed = (sessionId: string, sequence: number) => {
    emitted.add(tokenOf(sessionId, sequence));
    scripted.emit(emission(installer, sessionId, sequence, "closed", tokenOf(sessionId, sequence)));
  };
  const earlier: WorkerRealmInstaller = {
    install: async (worker) => {
      if (planOf.get(worker.sessionId)?.start === "held-by-an-earlier-installer") await hold(`earlier:${worker.sessionId}`);
    },
    concluded() {}
  };
  const session = new DedicatedWorkerAttachSession(scripted.channel, [earlier, installer], { handshakeTimeoutMs: LONG_HOLD_MS });
  await session.attachToPage("page-target");
  const attach = (sessionId: string, plan: DedicatedPlan | undefined, arrivedOn = "page-session") => {
    if (plan !== undefined) planOf.set(sessionId, plan);
    scripted.emit({
      method: "Target.attachedToTarget",
      sessionId: arrivedOn,
      params: {
        sessionId,
        targetInfo: { type: "worker", targetId: `${sessionId}-target`, url: `${ORIGIN}/w.js`, parentFrameId: plan?.owner === "no-such-frame" ? "no-such-frame" : `frame-${sessionId}` },
        waitingForDebugger: plan?.start !== "running"
      }
    });
  };
  const detach = (sessionId: string) => scripted.emit({ method: "Target.detachedFromTarget", sessionId: "page-session", params: { sessionId } });
  const release = (key: string) => {
    held.get(key)?.();
    held.delete(key);
  };
  sessionIds.forEach((sessionId, index) => attach(sessionId, plans[index], options.nestedUnderFirst === true && index > 0 ? sessionIds[0] : "page-session"));
  await turn();
  sessionIds.forEach((sessionId, index) => {
    const plan = plans[index];
    if (plan.start !== "paused" || plan.install !== "answered") return;
    if (plan.stream === "open") scripted.emit(emission(installer, sessionId, 2, "open"));
    if (plan.stream === "gap") scripted.emit(emission(installer, sessionId, 9, "closed", tokenOf(sessionId, 9)));
    if (plan.stream === "realm-null") scripted.emit(emission(installer, sessionId, 2, "closed", "null"));
    if (plan.stream === "closed") sayClosed(sessionId, 2);
  });
  sessionIds.forEach((sessionId, index) => {
    if (plans[index].gone === "before-the-freeze") detach(sessionId);
  });
  if (mode.channel === "lost-before-the-freeze") scripted.drop();
  return {
    installer,
    session,
    scripted,
    sessionIds,
    emitted,
    attach,
    detach,
    sayClosed,
    release,
    read(witnessed: number, settleMs = 0) {
      reading = true;
      return installer.readout({ session, witness: { count: () => witnessed }, settleMs });
    },
    async releaseAll() {
      for (const key of [...held.keys()]) release(key);
      await turn();
    },
    close: () => session.close()
  };
}

async function dedicatedWorld(modules: Modules, plans: readonly DedicatedPlan[], mode: DedicatedMode, extra: { witnessed?: number; inTheDrain?: DedicatedPlan; readAgain?: boolean; nestedUnderFirst?: boolean } = {}) {
  const bench = await dedicatedBench(modules, plans, mode, extra);
  const pending = bench.read(extra.witnessed ?? plans.length);
  // In the drain: the readout froze at its call, and nothing has answered it yet.
  bench.sessionIds.forEach((sessionId, index) => {
    if (plans[index].gone === "in-the-drain") bench.detach(sessionId);
  });
  if (extra.inTheDrain !== undefined) bench.attach("late-0", extra.inTheDrain);
  if (mode.channel === "lost-in-the-drain") bench.scripted.drop();
  const readout = await pending;
  await bench.releaseAll();
  const again = extra.readAgain ? await bench.read(extra.witnessed ?? plans.length) : null;
  bench.close();
  return { readout, emitted: bench.emitted, again };
}

const sumOf = (record: Record<string, unknown>, terms: Iterable<string>) => [...terms].reduce((sum, term) => sum + (record[term] as number), 0);

/** What the readout publishes against its terms. The term lists restate the diagnostics' docblocks. */
function holdPublishedSums(readout: WorkerFingerprintRealmReadout, emitted: ReadonlySet<string>, input: () => unknown): void {
  const { diagnostics } = readout;
  const shared = diagnostics.sharedWorkers;
  const counts = [readout.unreadRealms, readout.sharedWorkersEndedAtOnce, ...Object.values(diagnostics).filter((value) => typeof value === "number"), ...Object.values(shared)] as number[];
  holds("cl7-no-count-goes-negative", counts.every((count) => count >= 0), input);
  holds("cl7-unread-realms-are-the-unread-terms", readout.unreadRealms === sumOf(diagnostics, DEDICATED_UNREAD) + sumOf(shared, SHARED_UNREAD), input);
  holds("cl7-ended-at-once-passes-through-apart", readout.sharedWorkersEndedAtOnce === shared.endedAtOnce, input);
  holds("cl7-read-snapshots-are-the-read-terms", readout.readableSnapshots.length === diagnostics.readable + shared.readable, input);
  holds("cl7-unscoped-snapshots-are-the-unscoped-terms", readout.unscopedSnapshots.length === diagnostics.ownerUnknown + shared.ownerUnscoped, input);
  const landed = [...readout.readableSnapshots, ...readout.unscopedSnapshots];
  holds("cl7-a-snapshot-lands-once-and-is-a-worker-s-own", new Set(landed).size === landed.length && landed.every((snapshot) => emitted.has(snapshot)), input);
  holds("cl7-nothing-writes-a-shared-diedpaused", shared.diedPaused === 0, input);
}

function termsOf(record: Record<string, unknown>, terms: readonly string[]): Map<string, number> {
  return new Map(terms.map((term) => [term, record[term] as number]));
}

function addTerms(total: Map<string, number>, part: ReadonlyMap<string, number>): void {
  for (const [term, count] of part) total.set(term, (total.get(term) ?? 0) + count);
}

const sameTerms = (left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>) => [...left].every(([term, count]) => right.get(term) === count);

type Landing = { term: string; snapshot: string | null };

/**
 * Where a dedicated worker lands, by hand, from the docblocks: at the freeze it is held or
 * gone held, or left by the channel; then a replaced owner excludes it whatever its stream
 * says; then its install; then what its stream says at its freeze point, which for a gone
 * worker is what it last said, and for a running one what it had said when the barrier
 * answered. A closed channel reads no frame trees. This restates those docblocks, so it
 * catches the class drifting from them, not a wrong rule.
 */
function dedicatedLanding(plan: DedicatedPlan, mode: DedicatedMode, sessionId: string): Landing {
  const none = (term: string): Landing => ({ term, snapshot: null });
  if (plan.start === "held-by-an-earlier-installer") return none("pausedAtReadout");
  const goneBefore = plan.gone === "before-the-freeze";
  const lostBefore = mode.channel === "lost-before-the-freeze";
  if (lostBefore && !goneBefore) return none("channelLostAlive");
  if (plan.start === "paused" && plan.install === "unanswered") return none(goneBefore ? "diedPaused" : "pausedAtReadout");
  const treesRead = mode.trees === "read" && !lostBefore;
  if (plan.owner === "replaced" && treesRead) return none("ownerReplaced");
  if (plan.start === "running") return none("attachedLate");
  if (plan.install !== "answered") return none("installFailed");
  if (plan.stream === "gap") return none("streamBroken");
  const slotLeftEmpty = none(mode.channel === "lost-in-the-drain" && plan.gone === "no" ? "channelLostAlive" : "cutOff");
  if (plan.stream === "open" || (plan.gone === "no" && plan.barrier !== "answered")) return slotLeftEmpty;
  if (plan.stream === "realm-null") return none("streamBroken");
  return { term: plan.owner === "current" && treesRead ? "readable" : "ownerUnknown", snapshot: tokenOf(sessionId, plan.stream === "closed" ? 2 : 1) };
}

function holdLanding(property: string, readout: WorkerFingerprintRealmReadout, terms: Record<string, unknown>, landing: Landing, carrying: string, input: () => unknown): void {
  const got = landing.term === "readable" ? readout.readableSnapshots : landing.term === carrying ? readout.unscopedSnapshots : [];
  holds(property, terms[landing.term] === 1 && JSON.stringify(got) === JSON.stringify(landing.snapshot === null ? [] : [landing.snapshot]), input);
}

async function checkDedicatedAccounting(modules: Modules): Promise<number> {
  let cases = 0;
  const plans = dedicatedPlans();
  const counted = [...DEDICATED_WORKER_TERMS, "unattachedDedicated"];
  for (const mode of DEDICATED_MODES) {
    const expected = new Map<string, number>(counted.map((term) => [term, 0]));
    for (const plan of plans) {
      cases += 1;
      const { readout, emitted } = await dedicatedWorld(modules, [plan], mode);
      const input = () => ({ plan, mode, diagnostics: readout.diagnostics });
      holds("cl7-every-dedicated-worker-lands-in-one-term", readout.diagnostics.attachedDedicated === 1 && sumOf(readout.diagnostics, DEDICATED_WORKER_TERMS) === 1, input);
      holds("cl7-a-witnessed-worker-never-attached-is-unattached", readout.diagnostics.unattachedDedicated === 0, input);
      holdPublishedSums(readout, emitted, input);
      const landing = dedicatedLanding(plan, mode, "dw-0");
      holdLanding("cl7-each-dedicated-worker-lands-where-its-world-says", readout, readout.diagnostics, landing, "ownerUnknown", input);
      expected.set(landing.term, (expected.get(landing.term) ?? 0) + 1);
    }
    cases += 1;
    const { readout, emitted } = await dedicatedWorld(modules, plans, mode);
    const input = () => ({ mode, expected: [...expected], together: [...termsOf(readout.diagnostics, counted)] });
    holds("cl7-the-whole-is-the-sum-of-its-parts", sameTerms(expected, termsOf(readout.diagnostics, counted)), input);
    holds("cl7-every-dedicated-worker-lands-in-one-term", readout.diagnostics.attachedDedicated === plans.length && sumOf(readout.diagnostics, DEDICATED_WORKER_TERMS) === plans.length, input);
    holdPublishedSums(readout, emitted, input);
  }
  return cases;
}

/** Worlds that are not one plan in one mode. */
async function checkDedicatedExtras(modules: Modules): Promise<number> {
  let cases = 0;
  // A worker started by another takes its parent's owner, however the parent's read ended.
  for (const [owner, term] of [["current", "readable"], ["replaced", "ownerReplaced"], ["no-such-frame", "ownerUnknown"], ["vouch-refused", "ownerUnknown"]] as const) {
    cases += 1;
    const { readout } = await dedicatedWorld(modules, [{ ...QUIET, owner }, QUIET], ALIVE, { nestedUnderFirst: true });
    const input = () => ({ owner, diagnostics: readout.diagnostics });
    holds("cl7-every-dedicated-worker-lands-in-one-term", readout.diagnostics.attachedNested === 1 && readout.diagnostics.attachedDedicated === 2 && sumOf(readout.diagnostics, DEDICATED_WORKER_TERMS) === 2, input);
    holds("cl7-a-nested-worker-takes-its-parent-s-owner", readout.diagnostics[term] === 2, input);
  }
  // No channel at all: every witnessed worker is unread.
  cases += 1;
  const noChannel = await new modules.realm.FingerprintWorkerRealmInstaller(SITE_KEY).readout({ session: null, witness: { count: () => 2 }, settleMs: 0 });
  holds("cl7-a-witnessed-worker-never-attached-is-unattached", noChannel.diagnostics.attachedDedicated === 0 && noChannel.diagnostics.unattachedDedicated === 2, () => noChannel.diagnostics);
  holdPublishedSums(noChannel, new Set(), () => noChannel.diagnostics);
  for (const neverAttached of [1, 2]) {
    cases += 1;
    const { readout, emitted } = await dedicatedWorld(modules, [QUIET], ALIVE, { witnessed: 1 + neverAttached });
    const input = () => ({ neverAttached, diagnostics: readout.diagnostics });
    holds("cl7-a-witnessed-worker-never-attached-is-unattached", readout.diagnostics.unattachedDedicated === neverAttached, input);
    holdPublishedSums(readout, emitted, input);
  }
  // More attached than the witness saw, in the drain and before it: no term and no sum goes below nothing.
  for (const world of [{ plans: [], inTheDrain: QUIET }, { plans: [QUIET], inTheDrain: undefined }] as const) {
    cases += 1;
    const { readout, emitted } = await dedicatedWorld(modules, world.plans, ALIVE, { witnessed: 0, inTheDrain: world.inTheDrain });
    const input = () => ({ world, diagnostics: readout.diagnostics });
    holdPublishedSums(readout, emitted, input);
  }
  return cases;
}

function watchEnd(pending: Promise<unknown>) {
  const seen = { ended: false };
  void pending.then(
    () => {
      seen.ended = true;
    },
    () => {
      seen.ended = true;
    }
  );
  return seen;
}

type DedicatedBench = Awaited<ReturnType<typeof dedicatedBench>>;

/** What the dedicated side of the drain waits for, at a bound that never expires. */
const DEDICATED_DRAINS: ReadonlyArray<{ name: string; plans: readonly DedicatedPlan[]; witnessed?: number; arrives: (bench: DedicatedBench) => void }> = [
  { name: "a witnessed worker not yet attached", plans: [], witnessed: 1, arrives: (bench) => bench.attach("late-0", QUIET) },
  { name: "a running worker's barrier", plans: [{ ...QUIET, barrier: "unanswered" }], arrives: (bench) => bench.release("barrier:dw-0") },
  { name: "an owner read in flight", plans: [{ ...QUIET, owner: "vouch-unanswered" }], arrives: (bench) => bench.release("vouch:dw-0") },
  { name: "the closed snapshot a running worker's open task owes", plans: [{ ...QUIET, stream: "open" }], arrives: (bench) => bench.sayClosed("dw-0", 3) },
  { name: "the closed snapshot a gone worker's open task owes", plans: [{ ...QUIET, stream: "open", gone: "before-the-freeze" }], arrives: (bench) => bench.sayClosed("dw-0", 3) },
  { name: "the second of two workers", plans: [QUIET, { ...QUIET, barrier: "unanswered" }], arrives: (bench) => bench.release("barrier:dw-1") },
  { name: "the first of two workers", plans: [{ ...QUIET, barrier: "unanswered" }, QUIET], arrives: (bench) => bench.release("barrier:dw-0") }
];

async function checkDedicatedDrain(modules: Modules): Promise<number> {
  let cases = 0;
  for (const world of DEDICATED_DRAINS) {
    cases += 1;
    const bench = await dedicatedBench(modules, world.plans, ALIVE);
    const pending = bench.read(world.witnessed ?? world.plans.length, LONG_HOLD_MS);
    const seen = watchEnd(pending);
    try {
      await turn();
      holds("cl7-the-drain-waits-for-what-it-names", !seen.ended, () => world.name);
      world.arrives(bench);
      await turn();
      holds("cl7-the-drain-ends-when-that-arrives", seen.ended, () => world.name);
    } finally {
      // A loss ends any drain still open, so no world leaves its bound's timer behind.
      bench.scripted.drop();
      await pending;
      await bench.releaseAll();
      bench.close();
    }
  }
  return cases;
}

/** Emissions that arrive in the drain, each world with the snapshots it must read. */
async function checkDedicatedEmissions(modules: Modules): Promise<number> {
  const worlds: ReadonlyArray<{ name: string; plans: readonly DedicatedPlan[]; moves: (bench: DedicatedBench) => Promise<void>; read: readonly string[]; term: string }> = [
    {
      name: "what a worker says past its answer, and its going, do not move its freeze point",
      plans: [QUIET, { ...QUIET, barrier: "unanswered" }],
      moves: async (bench) => {
        await turn();
        bench.sayClosed("dw-0", 2);
        bench.detach("dw-0");
        await turn();
        bench.release("barrier:dw-1");
      },
      read: [tokenOf("dw-0", 1), tokenOf("dw-1", 1)],
      term: "readable"
    },
    {
      name: "a closed snapshot a gone worker's open task owed fills its slot",
      plans: [{ ...QUIET, stream: "open", gone: "before-the-freeze" }],
      moves: async (bench) => bench.sayClosed("dw-0", 3),
      read: [tokenOf("dw-0", 3)],
      term: "readable"
    },
    {
      name: "a running worker's open task is read at its first closed snapshot past its answer, and no later",
      plans: [{ ...QUIET, stream: "open" }],
      moves: async (bench) => {
        await turn();
        bench.sayClosed("dw-0", 3);
        bench.sayClosed("dw-0", 4);
      },
      read: [tokenOf("dw-0", 3)],
      term: "readable"
    },
    {
      name: "what a worker said before its answer belongs to its freeze point, however late it arrives",
      plans: [{ ...QUIET, stream: "closed", barrier: "unanswered" }],
      moves: async (bench) => {
        await turn();
        bench.sayClosed("dw-0", 3);
        bench.release("barrier:dw-0");
      },
      read: [tokenOf("dw-0", 3)],
      term: "readable"
    },
    {
      name: "nothing is read from a worker past the channel's loss",
      plans: [{ ...QUIET, stream: "open" }],
      moves: async (bench) => {
        await turn();
        bench.scripted.drop();
        bench.sayClosed("dw-0", 3);
      },
      read: [],
      term: "channelLostAlive"
    }
  ];
  for (const world of worlds) {
    const bench = await dedicatedBench(modules, world.plans, ALIVE);
    const pending = bench.read(world.plans.length, LONG_HOLD_MS);
    try {
      await world.moves(bench);
      await turn();
    } finally {
      bench.scripted.drop();
    }
    const readout = await pending;
    await bench.releaseAll();
    bench.close();
    const input = () => ({ world: world.name, snapshots: readout.readableSnapshots, diagnostics: readout.diagnostics });
    holds("cl7-an-emission-in-the-drain-moves-no-freeze-point", JSON.stringify(readout.readableSnapshots) === JSON.stringify(world.read) && (readout.diagnostics as unknown as Record<string, number>)[world.term] === world.plans.length, input);
  }
  return worlds.length;
}

type SharedStep =
  | "attached"
  | "held"
  | "late"
  | "installed-answered"
  | "installed-false"
  | "installed-unanswered"
  | "released"
  | "gone"
  | "gone-under-the-bound"
  | "gone-past-the-bound"
  | "gone-with-a-script-seen";

const SHARED_PATHS: readonly (readonly SharedStep[])[] = [
  ["attached", "gone"],
  ["attached", "gone-under-the-bound"],
  ["attached", "gone-past-the-bound"],
  ["attached", "gone-with-a-script-seen"],
  ["attached", "late", "gone"],
  // Reports the mirror must ignore once a worker is late, whatever order they arrive in.
  ["attached", "late", "held"],
  ["attached", "late", "released"],
  ["attached", "held", "late", "gone"],
  ["attached", "held", "late", "released"],
  ["attached", "held", "gone"],
  ["attached", "held", "installed-answered", "gone"],
  ["attached", "held", "installed-answered", "released", "gone"],
  ["attached", "held", "installed-false", "gone"],
  ["attached", "held", "installed-false", "released", "gone"],
  ["attached", "held", "installed-unanswered", "gone"],
  ["attached", "held", "installed-unanswered", "released", "gone"]
];

type SharedPlan = {
  /** The steps before the freeze, and those in the drain. */
  before: readonly SharedStep[];
  during: readonly SharedStep[];
  stream: "first-only" | "open" | "closed" | "gap";
  barrier: "answered" | "unanswered";
  credited: boolean;
};
type SharedLoss = "no" | "before-the-freeze" | "at-the-drain-s-end";
const SHARED_LOSSES: readonly SharedLoss[] = ["no", "before-the-freeze", "at-the-drain-s-end"];
const QUIET_SHARED: SharedPlan = { before: [], during: [], stream: "first-only", barrier: "answered", credited: true };
const RELEASED: readonly SharedStep[] = ["attached", "held", "installed-answered", "released"];

/** Every cut of every prefix of a path: a worker can stop at any step, and the freeze can fall at any step before that. */
function sharedPlans(): SharedPlan[] {
  const seen = new Set<string>();
  const plans: SharedPlan[] = [];
  for (const path of SHARED_PATHS) {
    for (let length = 1; length <= path.length; length += 1) {
      const prefix = path.slice(0, length);
      for (let cut = 0; cut <= length; cut += 1) {
        const key = `${prefix.join()}|${cut}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const base = { before: prefix.slice(0, cut), during: prefix.slice(cut) };
        if (!prefix.includes("installed-answered")) {
          plans.push({ ...QUIET_SHARED, ...base });
          continue;
        }
        for (const stream of ["first-only", "open", "closed", "gap"] as const) {
          for (const barrier of ["answered", "unanswered"] as const) {
            for (const credited of BOTH) plans.push({ ...base, stream, barrier, credited });
          }
        }
      }
    }
  }
  return plans;
}

/** What the attacher's thread keeps for one worker, and from it the fields its onDetached reports. */
type ThreadWorker = { hold: SharedWorkerHold; installConcluded: boolean };

function threadDetached(step: SharedStep, worker: ThreadWorker) {
  // Restated from the thread's onDetached, which is serialized and cannot be imported; F4 replays the real one.
  return {
    type: "detached",
    lifetimeMs: step === "gone-past-the-bound" ? BOUND + 1 : step === "gone-under-the-bound" ? UNDER_THE_BOUND : BOUND,
    diedWhileHeld: worker.hold === "held" && !worker.installConcluded,
    diedAfterInstall: worker.hold === "held" && worker.installConcluded,
    endedUnreached: worker.hold === "pending" && step !== "gone-with-a-script-seen"
  };
}

/** The same worker as fingerprint-observer@11's mirror held it, which had no rewrite and took every detach while held as died held. */
type ViewAt11 = SharedView;

function applyAt11(view: ViewAt11, step: SharedStep, thread: ThreadWorker): ViewAt11 {
  switch (step) {
    case "attached":
      return view;
    case "held":
      return view.hold === "late" ? view : { ...view, hold: "held" };
    case "late":
      return { ...view, hold: "late", install: view.install ?? "attached-late" };
    case "installed-answered":
      return { ...view, install: view.install ?? "installed" };
    case "installed-false":
    case "installed-unanswered":
      return { ...view, install: view.install ?? "failed" };
    case "released":
      return view.hold === "late" ? view : { ...view, hold: "released" };
    default: {
      const detached = threadDetached(step, thread);
      return { ...view, detached: true, detachedWhilePaused: thread.hold === "held", lifetime: { lifetimeMs: detached.lifetimeMs, endedUnreached: detached.endedUnreached } };
    }
  }
}

function advanceThread(thread: ThreadWorker, step: SharedStep): void {
  if (thread.hold === "late") return;
  if (step === "held") thread.hold = "held";
  if (step === "late") thread.hold = "late";
  if (step === "released") thread.hold = "released";
  if (step.startsWith("installed")) thread.installConcluded = true;
}

const ANSWERED = (value: boolean) => [
  { status: "fulfilled", value: {} },
  { status: "fulfilled", value: { result: { value } } }
];

/** Everything up to the freeze on the shared side, the thread scripted through a fake transport, with each later move left to the world. */
async function sharedBench(modules: Modules, plans: readonly SharedPlan[], options: { discoveredNeverReported?: number; documentsWatched?: boolean } = {}) {
  const installer = new modules.realm.FingerprintWorkerRealmInstaller(SITE_KEY);
  const sessionIds = plans.map((_plan, index) => `sw-${index}`);
  const planOf = new Map(sessionIds.map((sessionId, index) => [sessionId, plans[index]]));
  const emitted = new Set<string>();
  const scripted = scriptedChannel(({ method }) => {
    if (method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: MAIN.frameId, loaderId: MAIN.loaderId, securityOrigin: ORIGIN } } };
    return {};
  });
  const session = new DedicatedWorkerAttachSession(scripted.channel, [installer], { handshakeTimeoutMs: LONG_HOLD_MS });
  await session.watchSharedWorkers(CONTEXT);
  await session.attachToPage("page-target");
  let toMain: (message: unknown) => void = () => undefined;
  const heldBarriers = new Map<string, unknown>();
  const transport: AttacherTransport = {
    postMessage(message) {
      const sent = message as Record<string, unknown>;
      if (sent.type === "register") toMain({ type: "registered", contextId: sent.contextId, documentsWatched: options.documentsWatched ?? true });
      if (sent.type !== "send") return;
      if (planOf.get(sent.sessionId as string)?.barrier === "answered") toMain({ type: "reply", requestId: sent.requestId, result: {} });
      else heldBarriers.set(sent.sessionId as string, sent.requestId);
    },
    onMessage(listener) {
      toMain = listener;
      queueMicrotask(() => listener({ type: "ready" }));
    },
    onExit() {},
    terminate() {}
  };
  const attacher = await modules.attacher.SharedWorkerAttacher.openOverTransportForTests(transport);
  const visit: SharedWorkerVisitChannel = await attacher.register({ browserContextId: CONTEXT, pageTargetId: "page-target", installCommands: installer.sharedWorkerInstallCommands() });
  installer.watchSharedWorkers(visit);
  const report = (message: Record<string, unknown>) => toMain({ contextId: CONTEXT, ...message });
  const threads = new Map(sessionIds.map((sessionId): [string, ThreadWorker] => [sessionId, { hold: "pending", installConcluded: false }]));
  const emit = (sessionId: string, event: DevtoolsEvent) => report({ type: "event", event: { ...event, sessionId } });
  const sayClosed = (sessionId: string, sequence: number) => {
    emitted.add(tokenOf(sessionId, sequence));
    emit(sessionId, emission(installer, sessionId, sequence, "closed", tokenOf(sessionId, sequence)));
  };
  const stream = (sessionId: string, plan: SharedPlan) => {
    if (plan.stream === "open") emit(sessionId, emission(installer, sessionId, 2, "open"));
    if (plan.stream === "gap") emit(sessionId, emission(installer, sessionId, 9, "closed", tokenOf(sessionId, 9)));
    if (plan.stream === "closed") sayClosed(sessionId, 2);
  };
  const step = (sessionId: string, move: SharedStep) => {
    const plan = planOf.get(sessionId) as SharedPlan;
    const thread = threads.get(sessionId) as ThreadWorker;
    if (move === "attached") {
      const url = plan.credited ? `${ORIGIN}/w.js` : "http://other.test/w.js";
      report({ type: "attached", sessionId, targetId: `${sessionId}-target`, url, waitingForDebugger: true, attachedAt: 0, creationDocument: CREATED_IN_MAIN });
    } else if (move === "held") report({ type: "held", sessionId });
    else if (move === "late") report({ type: "late", sessionId, reason: "resumed-while-held" });
    else if (move === "released") report({ type: "released", sessionId, holdMs: 1, debuggerOff: true });
    else if (move === "installed-unanswered") report({ type: "installed", sessionId, answers: null });
    else if (move === "installed-answered" || move === "installed-false") {
      sayClosed(sessionId, 1);
      report({ type: "installed", sessionId, answers: ANSWERED(move === "installed-answered") });
      if (move === "installed-answered") stream(sessionId, plan);
    } else report({ sessionId, ...threadDetached(move, thread) });
    advanceThread(thread, move);
  };
  const extraTargets = Array.from({ length: options.discoveredNeverReported ?? 0 }, (_value, index) => `never-reported-${index}`);
  for (const targetId of [...sessionIds.map((sessionId) => `${sessionId}-target`), ...extraTargets]) {
    scripted.emit({ method: "Target.targetCreated", params: { targetInfo: { type: "shared_worker", targetId, browserContextId: CONTEXT } } });
  }
  plans.forEach((plan, index) => plan.before.forEach((move) => step(sessionIds[index], move)));
  return {
    installer,
    sessionIds,
    emitted,
    step,
    sayClosed,
    report,
    lose: () => toMain({ type: "lost", reason: "The thread was lost." }),
    answerBarrier(sessionId: string) {
      toMain({ type: "reply", requestId: heldBarriers.get(sessionId), result: {} });
      heldBarriers.delete(sessionId);
    },
    read: (settleMs = 0) => installer.readout({ session, witness: { count: () => 0 }, settleMs }),
    close() {
      attacher.close();
      session.close();
    }
  };
}

async function sharedWorld(modules: Modules, plans: readonly SharedPlan[], loss: SharedLoss, extra: { discoveredNeverReported?: number; documentsWatched?: boolean } = {}) {
  const bench = await sharedBench(modules, plans, extra);
  if (loss === "before-the-freeze") bench.lose();
  const pending = bench.read();
  plans.forEach((plan, index) => plan.during.forEach((move) => bench.step(bench.sessionIds[index], move)));
  if (loss === "at-the-drain-s-end") bench.lose();
  const readout = await pending;
  bench.close();
  return { readout, emitted: bench.emitted };
}

const landedShared = (readout: WorkerFingerprintRealmReadout): string[] => SHARED_WORKER_TERMS.filter((term) => (readout.diagnostics.sharedWorkers as unknown as Record<string, number>)[term] > 0);
/** The terms a worker read from its stream can land in. */
const STREAM_TERMS = new Set(["readable", "ownerUnscoped", "cutOff", "streamBroken", "channelLostAlive"]);

type DirectionTally = { worlds: number; movedToUnread: number; movedToStream: number };

/** What @11 would have said of this world, by its mirror and its classifier. */
function sharedWorldAt11(plan: SharedPlan, loss: SharedLoss): Before | null {
  const steps = (moves: readonly SharedStep[], from: ViewAt11, thread: ThreadWorker) => moves.reduce((view, move) => {
    const next = applyAt11(view, move, thread);
    advanceThread(thread, move);
    return next;
  }, from);
  const start: ViewAt11 = { hold: "pending", detached: false, detachedWhilePaused: false, lostWithChannel: false, install: null, attachedAfterFreeze: plan.before.length === 0, lifetime: { lifetimeMs: null, endedUnreached: false }, lastWord: "none", broken: false };
  const thread: ThreadWorker = { hold: "pending", installConcluded: false };
  const before = steps(plan.before, start, thread);
  // What a loss leaves: the mirror hears nothing more, and every worker still attached is lost with it.
  if (loss === "before-the-freeze") {
    if (plan.before.length === 0) return null;
    const lost = { ...before, lostWithChannel: !before.detached };
    return sharedAt11(lost, lost);
  }
  const after = steps(plan.during, before, thread);
  const atEnd = loss === "at-the-drain-s-end" ? { ...after, lostWithChannel: !after.detached } : after;
  return plan.before.length === 0 ? sharedAt11(atEnd, atEnd) : sharedAt11(before, atEnd);
}

async function checkSharedAccounting(modules: Modules): Promise<number> {
  let cases = 0;
  const plans = sharedPlans();
  const counted = [...SHARED_WORKER_TERMS, "attached", "unattached", "discovered"];
  for (const loss of SHARED_LOSSES) {
    const alone = new Map<string, number>();
    for (const plan of plans) {
      cases += 1;
      const { readout, emitted } = await sharedWorld(modules, [plan], loss);
      const shared = readout.diagnostics.sharedWorkers;
      const input = () => ({ plan, loss, shared });
      const reported = plan.before.length > 0 || loss !== "before-the-freeze" ? 1 : 0;
      holds("cl7-every-shared-worker-the-attacher-reported-lands-in-one-term", shared.attached === reported && sumOf(shared, SHARED_WORKER_TERMS) === reported, input);
      holds("cl7-a-discovered-worker-is-attached-or-unattached", shared.discovered === 1 && shared.unattached === 1 - reported, input);
      holdPublishedSums(readout, emitted, input);
      addTerms(alone, termsOf(shared, counted));
    }
    cases += 1;
    const { readout, emitted } = await sharedWorld(modules, plans, loss);
    const shared = readout.diagnostics.sharedWorkers;
    const input = () => ({ loss, alone: [...alone], together: [...termsOf(shared, counted)] });
    holds("cl7-the-whole-is-the-sum-of-its-parts", sameTerms(alone, termsOf(shared, counted)), input);
    holdPublishedSums(readout, emitted, input);
  }
  for (const discoveredNeverReported of [1, 2]) {
    cases += 1;
    const { readout, emitted } = await sharedWorld(modules, [plans[0]], "no", { discoveredNeverReported });
    const shared = readout.diagnostics.sharedWorkers;
    const input = () => ({ discoveredNeverReported, shared });
    holds("cl7-a-discovered-worker-is-attached-or-unattached", shared.discovered === 1 + discoveredNeverReported && shared.attached === 1 && shared.unattached === discoveredNeverReported, input);
    holdPublishedSums(readout, emitted, input);
  }
  return cases;
}

type SharedBench = Awaited<ReturnType<typeof sharedBench>>;

/** What the shared side of the drain waits for, at a bound that never expires. `interim` moves are not yet what it waits for. */
const SHARED_DRAINS: ReadonlyArray<{ name: string; plans: readonly SharedPlan[]; interim?: (bench: SharedBench) => void; arrives: (bench: SharedBench) => void }> = [
  { name: "a discovered worker the attacher has not reported", plans: [QUIET_SHARED], arrives: (bench) => bench.step("sw-0", "attached") },
  { name: "a reaching worker's first move", plans: [{ ...QUIET_SHARED, before: ["attached"] }], arrives: (bench) => bench.step("sw-0", "late") },
  { name: "the next move of a reaching worker that was held", plans: [{ ...QUIET_SHARED, before: ["attached"] }], interim: (bench) => bench.step("sw-0", "held"), arrives: (bench) => bench.step("sw-0", "released") },
  { name: "a hold's release", plans: [{ ...QUIET_SHARED, before: ["attached", "held"] }], arrives: (bench) => bench.step("sw-0", "released") },
  { name: "a hold breaking", plans: [{ ...QUIET_SHARED, before: ["attached", "held"] }], arrives: (bench) => bench.step("sw-0", "late") },
  { name: "a held worker's going", plans: [{ ...QUIET_SHARED, before: ["attached", "held"] }], arrives: (bench) => bench.step("sw-0", "gone") },
  {
    name: "the next move of a worker attached in the drain and held",
    plans: [{ ...QUIET_SHARED, before: ["attached"] }, QUIET_SHARED],
    interim: (bench) => {
      bench.step("sw-1", "attached");
      bench.step("sw-1", "held");
      bench.step("sw-0", "late");
    },
    arrives: (bench) => bench.step("sw-1", "released")
  },
  { name: "a running worker's barrier", plans: [{ ...QUIET_SHARED, before: RELEASED, barrier: "unanswered" }], arrives: (bench) => bench.answerBarrier("sw-0") },
  { name: "the closed snapshot a running worker's open task owes", plans: [{ ...QUIET_SHARED, before: RELEASED, stream: "open" }], arrives: (bench) => bench.sayClosed("sw-0", 3) },
  { name: "the second of two workers", plans: [{ ...QUIET_SHARED, before: RELEASED }, { ...QUIET_SHARED, before: ["attached", "held"] }], arrives: (bench) => bench.step("sw-1", "released") },
  { name: "the first of two workers", plans: [{ ...QUIET_SHARED, before: ["attached", "held"] }, { ...QUIET_SHARED, before: RELEASED }], arrives: (bench) => bench.step("sw-0", "released") }
];

async function checkSharedDrain(modules: Modules): Promise<number> {
  let cases = 0;
  for (const world of SHARED_DRAINS) {
    cases += 1;
    const bench = await sharedBench(modules, world.plans);
    const pending = bench.read(LONG_HOLD_MS);
    const seen = watchEnd(pending);
    try {
      await turn();
      world.interim?.(bench);
      await turn();
      holds("cl7-the-drain-waits-for-what-it-names", !seen.ended, () => world.name);
      world.arrives(bench);
      await turn();
      holds("cl7-the-drain-ends-when-that-arrives", seen.ended, () => world.name);
    } finally {
      bench.lose();
      await pending;
      bench.close();
    }
  }
  return cases;
}

/** The same moves as a dedicated worker's, on a shared one: the class holds one slot and one barrier for both. */
async function checkSharedEmissions(modules: Modules): Promise<number> {
  const worlds: ReadonlyArray<{ name: string; plans: readonly SharedPlan[]; moves: (bench: SharedBench) => Promise<void>; read: readonly string[] }> = [
    {
      name: "what a worker says past its answer, and its going, do not move its freeze point",
      plans: [{ ...QUIET_SHARED, before: RELEASED }, { ...QUIET_SHARED, before: RELEASED, barrier: "unanswered" }],
      moves: async (bench) => {
        await turn();
        bench.sayClosed("sw-0", 2);
        bench.step("sw-0", "gone");
        await turn();
        bench.answerBarrier("sw-1");
      },
      read: [tokenOf("sw-0", 1), tokenOf("sw-1", 1)]
    },
    {
      name: "a closed snapshot a gone worker's open task owed fills its slot",
      plans: [{ ...QUIET_SHARED, before: [...RELEASED, "gone"], stream: "open" }],
      moves: async (bench) => bench.sayClosed("sw-0", 3),
      read: [tokenOf("sw-0", 3)]
    }
  ];
  for (const world of worlds) {
    const bench = await sharedBench(modules, world.plans);
    const pending = bench.read(LONG_HOLD_MS);
    try {
      await world.moves(bench);
      await turn();
    } finally {
      bench.lose();
    }
    const readout = await pending;
    bench.close();
    holds("cl7-an-emission-in-the-drain-moves-no-freeze-point", JSON.stringify(readout.readableSnapshots) === JSON.stringify(world.read), () => ({ world: world.name, snapshots: readout.readableSnapshots, diagnostics: readout.diagnostics }));
  }
  return worlds.length;
}

/**
 * A document read on a stream that missed a commit could be stale, so a worker attached on
 * one is credited to nothing, read in full or not: with commits never watched, and after
 * the page's session was lost. One attached before that loss keeps what it read.
 */
async function checkDocumentsWatched(modules: Modules): Promise<number> {
  const released = { ...QUIET_SHARED, before: RELEASED };
  const worlds: ReadonlyArray<{ name: string; documentsWatched: boolean; pageLost: "no" | "before-the-attach" | "after-the-attach"; term: string }> = [
    { name: "commits watched", documentsWatched: true, pageLost: "no", term: "readable" },
    { name: "commits never watched", documentsWatched: false, pageLost: "no", term: "ownerUnscoped" },
    { name: "the page's session lost before the attach", documentsWatched: true, pageLost: "before-the-attach", term: "ownerUnscoped" },
    { name: "the page's session lost after the attach", documentsWatched: true, pageLost: "after-the-attach", term: "readable" }
  ];
  for (const world of worlds) {
    const plan = world.pageLost === "before-the-attach" ? { ...released, before: [], during: [] } : released;
    const bench = await sharedBench(modules, [plan], { documentsWatched: world.documentsWatched });
    if (world.pageLost !== "no") bench.report({ type: "page-lost" });
    if (world.pageLost === "before-the-attach") RELEASED.forEach((move) => bench.step("sw-0", move));
    const readout = await bench.read();
    bench.close();
    const input = () => ({ world: world.name, shared: readout.diagnostics.sharedWorkers });
    holds("cl8a-a-document-read-on-a-stream-that-missed-a-commit-credits-nothing", (readout.diagnostics.sharedWorkers as unknown as Record<string, number>)[world.term] === 1, input);
  }
  return worlds.length;
}

/**
 * CL8a's direction check, through the real mirror and the real readout: the same
 * thread reports, read by the @11 reference and its mirror, and by this commit. The kernels' own
 * direction check above takes one view for both, and so cannot see the move to the
 * stream, which @12 made in the mirror.
 */
async function checkSharedDirection(modules: Modules): Promise<DirectionTally> {
  const tally: DirectionTally = { worlds: 0, movedToUnread: 0, movedToStream: 0 };
  for (const loss of SHARED_LOSSES) {
    for (const plan of sharedPlans()) {
      const before = sharedWorldAt11(plan, loss);
      if (before === null) continue;
      tally.worlds += 1;
      const { readout } = await sharedWorld(modules, [plan], loss);
      const terms = landedShared(readout);
      const term = terms[0];
      const input = () => ({ plan, loss, before, terms });
      holds("cl8a-the-real-readout-lands-each-worker-once", terms.length === 1, input);
      const moves = before.state === "excluded" && !SHARED_EXCLUDED.has(term);
      if (moves) {
        // A worker gone held with its install answered false is read as a released one is, and so is unread for its install.
        const toUnread = term === "diedHeld" || term === "installFailed";
        holds("cl8a-through-the-mirror-at-12-only-exclusions-move-and-only-toward-unread-or-the-stream", toUnread || STREAM_TERMS.has(term), input);
        if (toUnread) tally.movedToUnread += 1;
        else tally.movedToStream += 1;
      }
      const unmoved =
        before.state === "excluded"
          ? true
          : before.state === "unread"
            ? term === before.reason
            : before.state === "ended-at-once"
              ? term === "endedAtOnce"
              : before.state === "reaching"
                ? term === "unreached"
                : STREAM_TERMS.has(term);
      holds("cl8a-through-the-mirror-at-12-only-exclusions-move-and-only-toward-unread-or-the-stream", unmoved, input);

      // The world's own facts, read from the path and not from any rule of the readout.
      const heldAtGone = (moves_: readonly SharedStep[]) => {
        const at = moves_.indexOf("gone");
        return at > 0 && moves_[at - 1] === "held";
      };
      const answeredThenGone = (moves_: readonly SharedStep[]) => {
        const at = moves_.indexOf("gone");
        return at > 0 && moves_[at - 1] === "installed-answered";
      };
      // Attached in the drain, it was not yet paused at the freeze, so nothing it streamed is of the freeze.
      if (plan.before.length === 0) holds("cl8a-a-worker-attached-after-the-freeze-is-never-read", !["readable", "ownerUnscoped", "cutOff", "streamBroken"].includes(term), input);
      const everything = [...plan.before, ...plan.during];
      if (heldAtGone(everything) && loss !== "before-the-freeze") holds("cl8a-a-worker-gone-held-in-the-world-is-unread", term === "diedHeld", input);
      if (heldAtGone(plan.before)) holds("cl8a-a-worker-gone-held-in-the-world-is-unread", term === "diedHeld", input);
      if (answeredThenGone(plan.before)) {
        const whole = plan.stream === "first-only" || plan.stream === "closed";
        holds("cl8a-a-worker-gone-after-its-install-is-read-from-its-stream", STREAM_TERMS.has(term) && (!whole || SHARED_READ.has(term)), input);
      }
      if (loss === "no" && plan.before.includes("installed-answered") && (plan.before.includes("released") || plan.before.includes("gone"))) {
        const gone = plan.before.includes("gone") || plan.during.includes("gone");
        const whole = plan.stream === "first-only" || plan.stream === "closed";
        const expected = plan.stream === "gap" ? "streamBroken" : whole && (gone || plan.barrier === "answered") ? (plan.credited ? "readable" : "ownerUnscoped") : "cutOff";
        const got = expected === "readable" ? readout.readableSnapshots : expected === "ownerUnscoped" ? readout.unscopedSnapshots : [];
        holds("cl8a-the-real-readout-reads-each-stream-at-its-freeze", term === expected && JSON.stringify(got) === JSON.stringify(SHARED_READ.has(expected) ? [tokenOf("sw-0", plan.stream === "closed" ? 2 : 1)] : []), input);
      }
    }
  }
  return tally;
}

/** Each distinct prefix of a path by each cut: 50 with no install, 20 for each of the two installs that failed, and 20 by 16 streams, barriers and credits. */
const SHARED_PLAN_COUNT = 50 + 20 + 20 + 20 * 16;

test("CL7: every dedicated worker lands in one term of the real readout, the one its world says, and the terms add up", async () => {
  const plans = dedicatedPlans();
  assert.equal(plans.length, 3 * (1 + 5 * (1 + 7 + 15)));
  // Each mode's workers alone and all together.
  assert.equal(await checkDedicatedAccounting(PRODUCTION_MODULES), DEDICATED_MODES.length * (plans.length + 1));
  // 4 nested pairs, no channel, 2 witness counts and 2 worlds with more attached than witnessed.
  assert.equal(await checkDedicatedExtras(PRODUCTION_MODULES), 4 + 1 + 2 + 2);
});

test("CL7: every shared worker the attacher reported lands in one term of the real readout, and the terms add up", async () => {
  const plans = sharedPlans();
  assert.equal(plans.length, SHARED_PLAN_COUNT);
  assert.equal(await checkSharedAccounting(PRODUCTION_MODULES), SHARED_LOSSES.length * (plans.length + 1) + 2);
});

test("CL7: the drain waits for each thing it names and ends when that arrives, at a bound that never expires", async () => {
  assert.equal(await checkDedicatedDrain(PRODUCTION_MODULES), DEDICATED_DRAINS.length);
  assert.equal(await checkSharedDrain(PRODUCTION_MODULES), SHARED_DRAINS.length);
  assert.deepEqual([DEDICATED_DRAINS.length, SHARED_DRAINS.length], [7, 11]);
});

test("CL7: an emission in the drain moves no freeze point", async () => {
  assert.equal(await checkDedicatedEmissions(PRODUCTION_MODULES), 5);
  assert.equal(await checkSharedEmissions(PRODUCTION_MODULES), 2);
});

test("CL8a: a shared worker attached on a stream that missed a commit is credited to nothing", async () => {
  assert.equal(await checkDocumentsWatched(PRODUCTION_MODULES), 4);
});

test("CL8a: through the real mirror and readout, @12 moves @11's exclusions toward unread and toward the stream, and nothing else", async () => {
  const tally = await checkSharedDirection(PRODUCTION_MODULES);
  // Every plan by 3 losses, less the 86 attached in the drain that a loss before the freeze leaves unreported.
  // Toward the stream: gone after its install answered, before the freeze, by 16 streams, barriers and credits and 3 losses.
  // Toward unread: gone held with its install unanswered at each of 4 cuts (3 + 2 + 2 + 2 losses that leave a move), and gone
  // before the freeze after each of the 2 installs that failed, by 3 losses.
  assert.deepEqual(tally, { worlds: SHARED_PLAN_COUNT * 3 - 86, movedToUnread: 3 + 2 + 2 + 2 + 2 * 3, movedToStream: 16 * 3 });
});

/**
 * Open (CL7), pinned as what happens and not as what should. A dedicated worker attached
 * in the drain is in `attachedDedicated` and in no term: the freeze has passed, so it has no
 * frozen realm, and the count of workers held before the install was taken at the call.
 * Paused at its attach, the readout's docblock says it was still paused at the freeze, so it
 * is an exclusion with no term to say so, and only the diagnostics show that.
 * Already running at its attach, it reaches the published count: the same worker attached
 * before the call is `attachedLate` and one unread realm, and attached in the drain it is
 * no unread realm (`unreadRealms` feeds fingerprint-observer's attempted realms and
 * the scanner's incomplete family). Whether Chromium ever attaches a running worker in a
 * drain is not measured. "readout: the drain waits for the channel's attaches" in
 * lib/worker-fingerprint-realm.test.ts pins the paused form as an empty term list, so
 * either change is the owner's call.
 */
test("open (CL7): a dedicated worker attached in the drain lands in no term, paused or running", async () => {
  const paused = await dedicatedWorld(PRODUCTION_MODULES, [], ALIVE, { witnessed: 1, inTheDrain: QUIET });
  assert.deepEqual([paused.readout.diagnostics.attachedDedicated, sumOf(paused.readout.diagnostics, DEDICATED_WORKER_TERMS), paused.readout.diagnostics.unattachedDedicated, paused.readout.unreadRealms], [1, 0, 0, 0]);
  const running: DedicatedPlan = { ...QUIET, start: "running" };
  const inTheDrain = await dedicatedWorld(PRODUCTION_MODULES, [], ALIVE, { witnessed: 1, inTheDrain: running });
  assert.deepEqual([inTheDrain.readout.diagnostics.attachedDedicated, sumOf(inTheDrain.readout.diagnostics, DEDICATED_WORKER_TERMS), inTheDrain.readout.diagnostics.attachedLate, inTheDrain.readout.unreadRealms], [1, 0, 0, 0]);
  const beforeTheCall = await dedicatedWorld(PRODUCTION_MODULES, [running], ALIVE, { witnessed: 1 });
  assert.deepEqual([beforeTheCall.readout.diagnostics.attachedDedicated, sumOf(beforeTheCall.readout.diagnostics, DEDICATED_WORKER_TERMS), beforeTheCall.readout.diagnostics.attachedLate, beforeTheCall.readout.unreadRealms], [1, 1, 1, 1]);
});

/**
 * Open (CL7), pinned the same way, and this one reaches the published count. The witness
 * is a count, read at the call, and the unattached term subtracts the attached count read
 * after the drain, with nothing to join them by. So a worker the witness never saw, attached
 * before the freeze or in the drain, stands in for a witnessed worker that never attached:
 * that worker is one unread realm alone, and none beside it. Before the freeze, the world
 * cannot be told from one witnessed worker that attached. How often a witness and its
 * attaches disagree this way is not measured.
 */
test("open (CL7): an unwitnessed worker, attached before the freeze or in the drain, masks a witnessed worker that never attached", async () => {
  const counts = (readout: WorkerFingerprintRealmReadout) => [readout.diagnostics.attachedDedicated, readout.diagnostics.unattachedDedicated, readout.unreadRealms];
  const alone = await dedicatedWorld(PRODUCTION_MODULES, [], ALIVE, { witnessed: 1 });
  assert.deepEqual(counts(alone.readout), [0, 1, 1]);
  const inTheDrain = await dedicatedWorld(PRODUCTION_MODULES, [], ALIVE, { witnessed: 1, inTheDrain: QUIET });
  assert.deepEqual(counts(inTheDrain.readout), [1, 0, 0]);
  const beforeTheFreeze = await dedicatedWorld(PRODUCTION_MODULES, [QUIET], ALIVE, { witnessed: 1 });
  assert.deepEqual(counts(beforeTheFreeze.readout), [1, 0, 0]);
  assert.equal(beforeTheFreeze.readout.diagnostics.readable, 1);
});

/**
 * Open (CL7), pinned the same way. A gap breaks a stream. Before the call that is
 * `streamBroken` and one unread realm, as the term's docblock says. After the call and
 * before the barrier's answer, the answer still finds the last closed snapshot, and the
 * worker is read at it with no unread realm, where the readout's docblock says a worker is
 * never read at an older state. It needs a lost or oversized emission, which the observer
 * does not produce: the largest snapshot it writes is far under the bound, and its sequence
 * has no gap of its own. Whether a browser can lose one is not measured.
 */
test("open (CL7): a gap in the drain before the barrier's answer leaves the worker read at its older snapshot", async () => {
  const before = await dedicatedWorld(PRODUCTION_MODULES, [{ ...QUIET, stream: "gap" }], ALIVE);
  assert.deepEqual([before.readout.diagnostics.streamBroken, before.readout.diagnostics.readable, before.readout.unreadRealms], [1, 0, 1]);
  const bench = await dedicatedBench(PRODUCTION_MODULES, [{ ...QUIET, barrier: "unanswered" }], ALIVE);
  const pending = bench.read(1, LONG_HOLD_MS);
  await turn();
  bench.scripted.emit(emission(bench.installer, "dw-0", 9, "closed", tokenOf("dw-0", 9)));
  bench.release("barrier:dw-0");
  const readout = await pending;
  bench.close();
  assert.deepEqual([readout.diagnostics.streamBroken, readout.diagnostics.readable, readout.unreadRealms], [0, 1, 0]);
  assert.deepEqual(readout.readableSnapshots, [tokenOf("dw-0", 1)]);
});

/**
 * Open (CL8a), pinned the same way, in a form production does not reach. A closed channel
 * leaves every record's worker unread, but an earlier installer's hold (GPC, in its arm)
 * leaves this installer no record to mark lost, so the count of workers held before the
 * install takes the worker as held. The earlier installer here holds until told to, and the
 * real one does not. With the real GPC installer, session and channel over a fake socket, a
 * close rejects the one send it awaits (failAllPending in lib/devtools-worker-channel.ts),
 * so it reads excluded only within the close's own tick, and by a microtask later
 * `channelLostAlive` and one unread realm, as the second readout here shows. A readout cannot
 * start in that tick, so this is no finding about a saved report.
 */
test("open (CL8a): a dedicated worker an earlier installer still holds when the channel closes is excluded until its flow moves on", async () => {
  const plan: DedicatedPlan = { ...QUIET, start: "held-by-an-earlier-installer" };
  const { readout, again } = await dedicatedWorld(PRODUCTION_MODULES, [plan], { channel: "lost-before-the-freeze", trees: "read" }, { readAgain: true });
  assert.deepEqual([readout.diagnostics.pausedAtReadout, readout.diagnostics.channelLostAlive, readout.unreadRealms], [1, 0, 0]);
  assert.deepEqual([again?.diagnostics.pausedAtReadout, again?.diagnostics.channelLostAlive, again?.unreadRealms], [0, 1, 1]);
});

const accountingVariant = (...edits: SourceEdit[]): Modules => ({ realm: realmVariant(...edits), attacher: productionAttacher });
const mirrorVariant = (...edits: SourceEdit[]): Modules => ({
  realm: productionRealm,
  attacher: loadVariant<AttacherModule>(require.resolve("./shared-worker-attacher"), edits)
});

const DEDICATED_TERM_LINE = "diagnostics[landed.term] += 1;";
const SHARED_TERM_LINE = "shared[landed.term] += 1;";
const SECOND_PASS = "if (!frozenShared.has(record))\n                sharedRealms.push(this.freezeShared(record, { attachedAfterFreeze: true }));\n";
const READ_PUSH = 'if (landed.term === "readable")\n                readableSnapshots.push(landed.snapshot);\n            else if (landed.term === "ownerUnknown")';
const UNSCOPED_PUSH = 'else if (landed.term === "ownerUnknown")\n                unscopedSnapshots.push(landed.snapshot);';

for (const [name, property, edits] of [
  ["a dedicated term is counted twice", "cl7-every-dedicated-worker-lands-in-one-term", [{ find: DEDICATED_TERM_LINE, replace: "diagnostics[landed.term] += 2;" }]],
  ["a dedicated term is not counted", "cl7-every-dedicated-worker-lands-in-one-term", [{ find: DEDICATED_TERM_LINE, replace: 'if (landed.term !== "cutOff") diagnostics[landed.term] += 1;' }]],
  ["a worker an earlier installer holds is counted for nothing", "cl7-every-dedicated-worker-lands-in-one-term", [{ find: "pausedAtReadout: heldBeforeInstall,", replace: "pausedAtReadout: 0," }]],
  ["the unread count leaves out a worker cut off", "cl7-unread-realms-are-the-unread-terms", [{ find: "diagnostics.cutOff +\n", replace: "" }]],
  ["a read worker's snapshot is not published", "cl7-read-snapshots-are-the-read-terms", [{ find: READ_PUSH, replace: 'if (landed.term === "ownerUnknown")' }]],
  ["an unscoped worker's snapshot is not published", "cl7-unscoped-snapshots-are-the-unscoped-terms", [{ find: UNSCOPED_PUSH, replace: "" }]],
  ["a read worker publishes text it never emitted", "cl7-a-snapshot-lands-once-and-is-a-worker-s-own", [{ find: READ_PUSH, replace: 'if (landed.term === "readable")\n                readableSnapshots.push("{}");\n            else if (landed.term === "ownerUnknown")' }]],
  ["the partition stops at the first worker cut off", "cl7-the-whole-is-the-sum-of-its-parts", [{ find: DEDICATED_TERM_LINE, replace: 'diagnostics[landed.term] += 1;\n            if (landed.term === "cutOff")\n                break;' }]],
  ["a dedicated worker already running is installed into and read", "cl7-each-dedicated-worker-lands-where-its-world-says", [{ find: "if (!worker.waitingForDebugger) {", replace: "if (false) {" }]],
  ["a dedicated worker running at attach is taken as a failed install", "cl7-each-dedicated-worker-lands-where-its-world-says", [{ find: 'this.concludeWorker(worker, "attached-late");', replace: 'this.concludeWorker(worker, "failed");' }]],
  ["the channel's loss marks a worker already gone", "cl7-each-dedicated-worker-lands-where-its-world-says", [{ find: 'onChannelClosed() {\n        if (this.channelLost)\n            return;\n        this.channelLost = true;\n        // Every worker still attached keeps running (Chromium resumes a worker\n        // held for a client that went away), and nothing it emits can arrive now.\n        for (const record of this.records.values()) {\n            if (!record.worker.detached)\n                record.lostWithChannel = true;', replace: 'onChannelClosed() {\n        if (this.channelLost)\n            return;\n        this.channelLost = true;\n        for (const record of this.records.values()) {\n            record.lostWithChannel = true;' }]],
  ["an install counts with no first snapshot", "cl7-each-dedicated-worker-lands-where-its-world-says", [{ find: " && record.lastSeq >= 1", replace: "" }]],
  ["an install counts when the evaluation answered false", "cl7-each-dedicated-worker-lands-where-its-world-says", [{ find: "(result === null || result === void 0 ? void 0 : result.value) === true && ", replace: "" }]],
  ["an install counts when the evaluation threw", "cl7-each-dedicated-worker-lands-where-its-world-says", [{ find: "evaluated.value.exceptionDetails === undefined && ", replace: "" }]],
  ["an install counts when the sink was refused", "cl7-each-dedicated-worker-lands-where-its-world-says", [{ find: '(bound === null || bound === void 0 ? void 0 : bound.status) !== "fulfilled" || ', replace: "" }]],
  ["an install counts with its stream already broken", "cl7-each-dedicated-worker-lands-where-its-world-says", [{ find: " && !record.broken", replace: "" }]],
  ["an owner read needs no vouch from the worker", "cl7-each-dedicated-worker-lands-where-its-world-says", [{ find: 'return vouched ? { frameId: worker.ownerFrameId, loaderId } : "unknown";', replace: "return { frameId: worker.ownerFrameId, loaderId };" }]],
  ["frames that could not be read exclude every known owner", "cl7-each-dedicated-worker-lands-where-its-world-says", [{ find: "const loaders = documents === null ? null : documents.loaders;", replace: "const loaders = documents === null ? new Map() : documents.loaders;" }]],
 ] as ReadonlyArray<readonly [string, string, SourceEdit[]]>) {
  test(`CL7 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkDedicatedAccounting(accountingVariant(...edits)));
  });
}

for (const [name, property, edits] of [
  ["a witnessed worker never attached is dropped", "cl7-a-witnessed-worker-never-attached-is-unattached", [{ find: "unattachedDedicated: Math.max(0, observedDedicated - attachCounts.attachedDedicatedWorkerCount),", replace: "unattachedDedicated: 0," }]],
  ["the unread count leaves out a witnessed worker never attached", "cl7-unread-realms-are-the-unread-terms", [{ find: "diagnostics.unattachedDedicated +\n", replace: "" }]],
  ["the unattached term goes negative when more attached than the witness saw", "cl7-no-count-goes-negative", [{ find: "unattachedDedicated: Math.max(0, observedDedicated - attachCounts.attachedDedicatedWorkerCount),", replace: "unattachedDedicated: observedDedicated - attachCounts.attachedDedicatedWorkerCount," }]],
  ["a nested worker never takes its parent's owner", "cl7-a-nested-worker-takes-its-parent-s-owner", [{ find: 'return (_a = parent === null || parent === void 0 ? void 0 : parent.ownerRead) !== null && _a !== void 0 ? _a : "unknown";', replace: 'return "unknown";' }]]
] as ReadonlyArray<readonly [string, string, SourceEdit[]]>) {
  test(`CL7 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkDedicatedExtras(accountingVariant(...edits)));
  });
}

const AT_11_FREEZE = { find: FREEZE_DIED_HELD, replace: 'if (worker.detachedWhilePaused)\n        return { record, state: "excluded", reason: "diedPaused" };\n    // Held as far as' };
for (const [name, property, edits] of [
  ["a shared worker attached in the drain is dropped", "cl7-every-shared-worker-the-attacher-reported-lands-in-one-term", [{ find: SECOND_PASS, replace: "" }]],
  ["a shared term is counted twice", "cl7-every-shared-worker-the-attacher-reported-lands-in-one-term", [{ find: SHARED_TERM_LINE, replace: "shared[landed.term] += 2;" }]],
  ["a shared worker is not counted as attached", "cl7-every-shared-worker-the-attacher-reported-lands-in-one-term", [{ find: "shared.attached += 1;", replace: "" }]],
  ["a reported worker is not joined with the discovery witness", "cl7-a-discovered-worker-is-attached-or-unattached", [{ find: "reportedTargets.add(worker.targetId);", replace: "" }]],
  ["a discovered worker never reported is dropped", "cl7-a-discovered-worker-is-attached-or-unattached", [{ find: "shared.unattached += 1;", replace: "shared.unattached += 0;" }]],
  ["the unread count leaves out a worker gone held", "cl7-unread-realms-are-the-unread-terms", [{ find: "shared.diedHeld +\n", replace: "" }]],
  ["the unread count leaves out a worker never reached", "cl7-unread-realms-are-the-unread-terms", [{ find: "shared.unreached +\n", replace: "" }]],
  ["a worker that ended at once counts as unread", "cl7-unread-realms-are-the-unread-terms", [{ find: "shared.unattached,", replace: "shared.unattached + shared.endedAtOnce," }]],
  ["a worker that ended at once is not passed through", "cl7-ended-at-once-passes-through-apart", [{ find: "sharedWorkersEndedAtOnce: shared.endedAtOnce,", replace: "sharedWorkersEndedAtOnce: 0," }]],
  ["a shared diedPaused has a writer again", "cl7-nothing-writes-a-shared-diedpaused", [AT_11_FREEZE]],
  ["the shared partition stops at the first worker cut off", "cl7-the-whole-is-the-sum-of-its-parts", [{ find: SHARED_TERM_LINE, replace: 'shared[landed.term] += 1;\n            if (landed.term === "cutOff")\n                break;' }]]
] as ReadonlyArray<readonly [string, string, SourceEdit[]]>) {
  test(`CL7 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkSharedAccounting(accountingVariant(...edits)));
  });
}

const RUNNING_RETURN = 'if (stream.state !== "running")\n            return stream;\n';
const STREAM_VARIANTS: ReadonlyArray<readonly [string, SourceEdit]> = [
  ["a running worker is read at the host's view, with no barrier", { find: RUNNING_RETURN, replace: `if (stream.state === "running" && record.lastClosed !== null)\n            return { record, state: "closed", snapshot: record.lastClosed };\n        ${RUNNING_RETURN}` }],
  ["a gone worker's open task is taken as broken", { find: 'if (stream.state === "gone-open") {', replace: 'if (stream.state === "gone-open") {\n            return { record, state: "unread", reason: "streamBroken" };' }],
  ["a barrier's answer reads nothing", { find: 'if (record.lastWord === "closed" && record.lastClosed !== null)\n            slot.snapshot = record.lastClosed;\n        else\n            slot.freezeSeq = record.lastSeq;', replace: "slot.freezeSeq = record.lastSeq;" }]
];
for (const [name, edit] of STREAM_VARIANTS) {
  test(`CL7 catches a variant in the dedicated readout: ${name}`, async () => {
    await assertCaughtBy(name, "cl7-each-dedicated-worker-lands-where-its-world-says", () => checkDedicatedAccounting(accountingVariant(edit)));
  });
  test(`CL8a catches a variant in the shared readout: ${name}`, async () => {
    await assertCaughtBy(name, "cl8a-the-real-readout-reads-each-stream-at-its-freeze", () => checkSharedDirection(accountingVariant(edit)));
  });
}

for (const [name, property, edits] of [
  ["the drain does not wait for the witness's attaches", "cl7-the-drain-waits-for-what-it-names", [{ find: "if (session.attachCounts().attachedDedicatedWorkerCount < observedDedicated)", replace: "if (false)" }]],
  ["the drain ends when any dedicated worker settled", "cl7-the-drain-waits-for-what-it-names", [{ find: "return frozen.every(realmSettled);", replace: "return frozen.length === 0 || frozen.some(realmSettled);" }]],
  ["the drain does not wait for an owner read", "cl7-the-drain-waits-for-what-it-names", [{ find: 'realm.record.owner !== "reading" &&', replace: "true &&" }]],
  ["a closed emission in the drain fills no slot", "cl7-the-drain-ends-when-that-arrives", [{ find: "for (const slot of record.slots) {\n            if (slot.snapshot === null && slot.freezeSeq !== null && sequence > slot.freezeSeq)\n                slot.snapshot = snapshot;\n        }", replace: "" }]],
  ["a barrier's answer does not wake the drain", "cl7-the-drain-ends-when-that-arrives", [{ find: "slot.freezeSeq = record.lastSeq;\n        this.announceChange();", replace: "slot.freezeSeq = record.lastSeq;" }]]
] as ReadonlyArray<readonly [string, string, SourceEdit[]]>) {
  test(`CL7 catches a variant in the dedicated drain: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkDedicatedDrain(accountingVariant(...edits)));
  });
}

for (const [name, property, edits] of [
  ["the drain ends when any shared worker settled", "cl7-the-drain-waits-for-what-it-names", [{ find: "return sharedFrozen.every(sharedRealmSettled);", replace: "return sharedFrozen.length === 0 || sharedFrozen.some(sharedRealmSettled);" }]],
  ["the drain does not wait for a worker attached in it and held", "cl7-the-drain-waits-for-what-it-names", [{ find: "if (!frozenShared.has(record) && !this.heldSettled(record))", replace: "if (false)" }]],
  ["the drain does not wait for a reported worker the discovery saw", "cl7-the-drain-waits-for-what-it-names", [{ find: "if (!reported.has(targetId))\n                    return false;", replace: "if (false)\n                    return false;" }]],
  ["a released worker is not settled until it has also gone", "cl7-the-drain-ends-when-that-arrives", [{ find: 'return worker.hold !== "held" || worker.detached;', replace: 'return worker.hold !== "held" && worker.detached;' }]],
  ["a held worker's going does not settle it", "cl7-the-drain-ends-when-that-arrives", [{ find: 'return worker.hold !== "held" || worker.detached;', replace: 'return worker.hold !== "held";' }]]
] as ReadonlyArray<readonly [string, string, SourceEdit[]]>) {
  test(`CL7 catches a variant in the shared drain: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkSharedDrain(accountingVariant(...edits)));
  });
}

for (const [name, edits] of [
  ["a barrier answers more than once", [{ find: 'if (slot.barrier !== "pending")\n            return;\n', replace: "" }]],
  ["a gone worker's slot can never fill", [{ find: 'barrier: "answered", freezeSeq: record.lastSeq, snapshot: null', replace: 'barrier: "answered", freezeSeq: null, snapshot: null' }]],
  ["a slot takes every closed snapshot past its freeze point", [{ find: "if (slot.snapshot === null && slot.freezeSeq !== null && sequence > slot.freezeSeq)", replace: "if (slot.freezeSeq !== null && sequence > slot.freezeSeq)" }]],
  ["emissions are read past the channel's loss", [{ find: "if (record.broken || record.lostWithChannel)", replace: "if (record.broken)" }]],
  ["a barrier reads an older snapshot behind what the worker said before it", [{ find: 'if (record.lastWord === "closed" && record.lastClosed !== null)\n            slot.snapshot = record.lastClosed;\n        else\n            slot.freezeSeq = record.lastSeq;', replace: 'slot.snapshot = tokenAtCall(record);' }, { find: "class FingerprintWorkerRealmInstaller {", replace: 'const tokenAtCall = (record) => JSON.stringify({ worker: record.worker.sessionId, sequence: 1 });\nclass FingerprintWorkerRealmInstaller {' }]]
] as ReadonlyArray<readonly [string, SourceEdit[]]>) {
  test(`CL7 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, "cl7-an-emission-in-the-drain-moves-no-freeze-point", () => checkDedicatedEmissions(accountingVariant(...edits)));
  });
}

const MIRROR_REWRITE = 'if (message.diedAfterInstall === true && worker.hold === "held") {';
test("CL8a catches a variant: a creation document read on a stream that missed a commit is kept", async () => {
  await assertCaughtBy("a creation document read on a stream that missed a commit is kept", "cl8a-a-document-read-on-a-stream-that-missed-a-commit-credits-nothing", () =>
    checkDocumentsWatched(mirrorVariant({ find: "creation && this.watchesDocuments() ? Object.assign({}, creation) : null", replace: "creation ? Object.assign({}, creation) : null" }))
  );
});
for (const [name, property, modules] of [
  ["shared diedHeld goes back to excluded in the readout", "cl8a-a-worker-gone-held-in-the-world-is-unread", () => accountingVariant(AT_11_FREEZE, { find: RESOLVE_DIED_HELD, replace: 'return { record, state: "excluded", reason: "pausedAtReadout" };' })],
  ["the mirror no longer says a worker died held", "cl8a-a-worker-gone-held-in-the-world-is-unread", () => mirrorVariant({ find: "worker.detachedWhilePaused = message.diedWhileHeld === true;", replace: "worker.detachedWhilePaused = false;" })],
  ["the mirror no longer reads a worker gone after its install as released", "cl8a-a-worker-gone-after-its-install-is-read-from-its-stream", () => mirrorVariant({ find: MIRROR_REWRITE, replace: "if (false) {" })],
  ["the mirror reads a worker gone with its install unanswered as released", "cl8a-a-worker-gone-held-in-the-world-is-unread", () => mirrorVariant({ find: MIRROR_REWRITE, replace: 'if (worker.hold === "held") {' })],
  ["late is not terminal in the mirror", "cl8a-through-the-mirror-at-12-only-exclusions-move-and-only-toward-unread-or-the-stream", () => mirrorVariant({ find: 'if (worker.hold === "late" && (message.type === "held" || message.type === "installed" || message.type === "released")) {', replace: "if (false) {" })],
  ["one worker lands in two terms", "cl8a-the-real-readout-lands-each-worker-once", () => accountingVariant({ find: SHARED_TERM_LINE, replace: 'shared[landed.term] += 1;\n            if (landed.term === "unreached")\n                shared.diedHeld += 1;' })],
  ["the class forgets a worker attached in the drain came after the freeze", "cl8a-a-worker-attached-after-the-freeze-is-never-read", () => accountingVariant({ find: "this.freezeShared(record, { attachedAfterFreeze: true })", replace: "this.freezeShared(record)" })],
  ["a worker gone after its install is lost to the stream by an unread term", "cl8a-through-the-mirror-at-12-only-exclusions-move-and-only-toward-unread-or-the-stream", () => accountingVariant({ find: SHARED_INSTALL_FAILED, replace: 'if (options.attachedAfterFreeze)\n        return { record, state: "excluded", reason: "pausedAtReadout" };\n    if (worker.detached)\n        return { record, state: "unread", reason: "unreached" };\n    if (record.install !== "installed")\n        return { record, state: "unread", reason: "installFailed" };' })],
  ["a released worker's stream is never read", "cl8a-through-the-mirror-at-12-only-exclusions-move-and-only-toward-unread-or-the-stream", () => accountingVariant({ find: SHARED_INSTALL_FAILED, replace: 'if (options.attachedAfterFreeze || (record.install === "installed" && !worker.detached))\n        return { record, state: "excluded", reason: "pausedAtReadout" };\n    if (record.install !== "installed")\n        return { record, state: "unread", reason: "installFailed" };' })]
] as ReadonlyArray<readonly [string, string, () => Modules]>) {
  test(`CL8a catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkSharedDirection(modules()));
  });
}
