// What a case's Durable Object keeps so that a runner can speak for one attempt and nothing else:
// the runner's own list of events, the rule for when a token may still write, and a table of each
// attempt's token digest and of what has happened to that attempt's runner.
//
// A runner holds one token, for one attempt. The object mints it through ids.ts when the runner
// first asks, while the attempt runs, hands it over once and keeps only its SHA-256 digest. A second
// request for the same attempt's token is refused (ruling D-8, A-3): the object flags the attempt
// with the reason, revokes its token for every event and asks for its runner to be stopped. Whoever
// asked first holds the token, and the object cannot tell which of the two callers is the runner.
// The object has no actor of its own, so it writes no event for this. The owner's next signed
// reconcile ends the attempt as failed with its cleanup unconfirmed, an outcome the machine already
// has. Until then the log still reads the attempt as running.
//
// Two more records end a token (A-2): the stop, which the alarm asks for when an attempt's deadline
// comes due, and the destroy record, which case-container.ts writes once a destroy of the attempt's
// container has resolved. They are separate because the owner's environment-destroyed rests on the
// second (D-5). A second stop, or a second destroy record, of the
// same attempt finds the first and is done, as case-supervision.ts asks of whatever fills its seam.
//
// The token itself is never stored, logged or put in an answer but the one that hands it over. A
// presented token is hashed and its digest compared with every digest the table holds, in full,
// without stopping at the first difference or the first match. NOT CLAIMED: that the first caller
// is the runner. That rests on the runner asking before it starts the browser. The handler that
// forwards its calls (runner-handler.ts) reaches this object only for the attempt it was registered
// for, and cannot tell a runner from anything else in the same container.

import { isAttemptId } from "./actor";
import { sha256Hex } from "./canonical-json";
import type { HostStorage } from "./case-host-stores";
import { mintRunnerToken } from "./ids";
import { isOutcome, SLOT_NAMES, type AttemptState, type MachineState, type SlotName } from "./case-machine";

/**
 * The only events a runner writes. The owner's events, a control, a changed configuration, a claim,
 * a reconstructed source and everything about a purge are not here. environment-destroyed is the
 * owner's (ruling D-5) and control-recorded waits for a control run (D-6), so neither is here. The
 * two cleanup events are on the owner's list too: the machine takes them from either.
 */
export const RUNNER_EVENT_TYPES: readonly string[] = ["attempt-start-retried", "capture-began", "capture-finished", "attempt-finished", "evidence-recorded", "instrument-recorded", "source-recorded", "cleanup-confirmed", "cleanup-unconfirmed"];

/** The runner's events an attempt may still write once it has an outcome, while its cleanup is pending. */
export const CLEANUP_EVENT_TYPES: readonly string[] = ["cleanup-confirmed", "cleanup-unconfirmed"];

/**
 * The most evidence rows one attempt may name, and the most instrument records it may write, each
 * counted by the object from the case's own state.
 * One bundled object per instrument output, one row each (G-4). A default, not a ruling (C-2): the
 * in-container runner may show it wrong.
 */
export const MAX_RUNNER_ROWS_PER_ATTEMPT = 32;

/** A token is 32 bytes from the platform's random source, minted by ids.ts, as lowercase hex. Anything else is refused before it is hashed. */
const TOKEN = /^[0-9a-f]{64}$/;

/** Whom a token speaks for, and which of the records that end it this attempt has. */
export type TokenHolder = Readonly<{ slot: SlotName; attemptId: string; stopped: boolean; destroyed: boolean; requestedTwice: boolean }>;

/** Why the runner of a slot can no longer write, or never started, as the owner's status answer shows it. Never the token. */
export type RunnerFlag = Readonly<{ slot: SlotName; reason: "token-requested-twice" | "container-start-failed" | "container-destroy-failed" }>;

export type HandOut = Readonly<{ ok: true; token: string }> | Readonly<{ ok: false; refusal: "token-already-handed" | "token-revoked" }>;

/** Why a token may not write this event now, or null when it may. */
export type TokenRefusal = "token-refused" | "attempt-ended";

/** Closes the owner reaches. A close as completed comes only from an attempt's own outcome, and leaves that attempt's cleanup window open. */
const OWNER_CLOSES: readonly (string | null)[] = ["cancelled", "deadline", "baseline_not_met"];

/**
 * The one rule for whether a token may write an event (rulings C-1 and A-1). Every event is refused
 * after a stop, after the destroy record, after a second request for the token, and after a close by
 * cancel, by deadline or by baseline not met. While the attempt runs, every runner event passes to
 * the machine. Once it has an outcome, only a cleanup event passes, and only while its cleanup is
 * pending. A close as completed is reached by an outcome, so it falls under that last rule.
 */
export function tokenRefusalFor(holder: TokenHolder, machine: MachineState, attempt: AttemptState, eventType: string): TokenRefusal | null {
  if (holder.stopped || holder.destroyed || holder.requestedTwice) return "token-refused";
  if (OWNER_CLOSES.includes(machine.closedBy)) return "token-refused";
  if (!isOutcome(attempt.phase)) return null;
  return CLEANUP_EVENT_TYPES.includes(eventType) && attempt.cleanup === "pending" ? null : "attempt-ended";
}

export type RunnerCredentials = Readonly<{
  /** Mint this attempt's token and keep its digest, or refuse: a second request flags the attempt and revokes its token. */
  handOut(slot: SlotName, attemptId: string): Promise<HandOut>;
  /** Whom this token speaks for, or null for anything the table does not hold. */
  holderOf(token: unknown): Promise<TokenHolder | null>;
  /** Record that this slot's runner was stopped. A second stop finds it recorded and is done. */
  recordStop(slot: SlotName): void;
  /** Record that this slot's environment was destroyed. A second record finds the first and is done. */
  recordDestroyed(slot: SlotName): void;
  /** Whether this slot's environment has a destroy record. The owner's environment-destroyed rests on it (D-5). */
  isDestroyed(slot: SlotName): boolean;
  /** The attempts flagged for a second request, for the owner's status answer. */
  flags(): readonly RunnerFlag[];
}>;

async function digestOf(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

/** Whether two digests are equal, read to the end whatever the first difference. */
function sameDigest(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) difference |= (left.charCodeAt(index) | 0) ^ (right.charCodeAt(index) | 0);
  return difference === 0;
}

const isSlot = (value: unknown): value is SlotName => (SLOT_NAMES as readonly unknown[]).includes(value);

export function runnerCredentialsOver(storage: HostStorage, now: () => number): RunnerCredentials {
  const { sql } = storage;
  sql.exec("CREATE TABLE IF NOT EXISTS runner_tokens (slot TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, digest TEXT NOT NULL, handed_at_ms INTEGER NOT NULL)").toArray();
  sql.exec("CREATE TABLE IF NOT EXISTS runner_records (slot TEXT PRIMARY KEY, stopped_at_ms INTEGER, destroyed_at_ms INTEGER, requested_twice_at_ms INTEGER)").toArray();

  /** Set one record of a slot, once. The first time stands, so a second stop or destroy record changes nothing. */
  const record = (slot: SlotName, column: "stopped_at_ms" | "destroyed_at_ms" | "requested_twice_at_ms", atMs: number): void => {
    sql.exec("INSERT INTO runner_records (slot) VALUES (?) ON CONFLICT (slot) DO NOTHING", slot).toArray();
    sql.exec(`UPDATE runner_records SET ${column} = ? WHERE slot = ? AND ${column} IS NULL`, atMs, slot).toArray();
  };
  const recordsOf = (slot: string): Readonly<{ stopped: boolean; destroyed: boolean; requestedTwice: boolean }> => {
    const [row] = sql.exec("SELECT stopped_at_ms, destroyed_at_ms, requested_twice_at_ms FROM runner_records WHERE slot = ?", slot).toArray();
    return { stopped: row !== undefined && row.stopped_at_ms !== null, destroyed: row !== undefined && row.destroyed_at_ms !== null, requestedTwice: row !== undefined && row.requested_twice_at_ms !== null };
  };

  return {
    async handOut(slot, attemptId) {
      const token = mintRunnerToken();
      const digest = await digestOf(token);
      const atMs = now();
      // Whether a token was handed and the hand-out itself are one synchronous step, so two requests cannot both be first.
      return storage.transactionSync<HandOut>(() => {
        const records = recordsOf(slot);
        if (records.stopped || records.destroyed || records.requestedTwice) return { ok: false, refusal: "token-revoked" };
        if (sql.exec("SELECT slot FROM runner_tokens WHERE slot = ?", slot).toArray().length > 0) {
          record(slot, "requested_twice_at_ms", atMs);
          return { ok: false, refusal: "token-already-handed" };
        }
        sql.exec("INSERT INTO runner_tokens (slot, attempt_id, digest, handed_at_ms) VALUES (?, ?, ?, ?)", slot, attemptId, digest, atMs).toArray();
        return { ok: true, token };
      });
    },

    async holderOf(token) {
      if (typeof token !== "string" || !TOKEN.test(token)) return null;
      const presented = await digestOf(token);
      let found: Record<string, unknown> | null = null;
      // Every row is compared in full, so neither a match nor a difference ends the reading early.
      for (const row of sql.exec("SELECT slot, attempt_id, digest FROM runner_tokens ORDER BY slot").toArray()) {
        if (sameDigest(String(row.digest), presented) && found === null) found = row;
      }
      if (found === null || !isSlot(found.slot) || !isAttemptId(found.attempt_id)) return null;
      return { slot: found.slot, attemptId: found.attempt_id, ...recordsOf(found.slot) };
    },

    recordStop(slot) {
      record(slot, "stopped_at_ms", now());
    },

    recordDestroyed(slot) {
      record(slot, "destroyed_at_ms", now());
    },

    isDestroyed(slot) {
      return recordsOf(slot).destroyed;
    },

    flags() {
      return sql
        .exec("SELECT slot FROM runner_records WHERE requested_twice_at_ms IS NOT NULL ORDER BY slot")
        .toArray()
        .flatMap(({ slot }) => (isSlot(slot) ? [{ slot, reason: "token-requested-twice" as const }] : []));
    }
  };
}

/**
 * The most objects one attempt's runner may store, and their bytes in all, counted by the object from
 * its own storage (F-3). A runner can store an object no row ever names, so rows alone do not bound
 * what an attempt costs the bucket. Defaults, not rulings, like the row bound (L-a): the row bound
 * and a small slack, and four objects at the size cap.
 */
export const MAX_RUNNER_OBJECTS_PER_ATTEMPT = MAX_RUNNER_ROWS_PER_ATTEMPT + 8;
export const MAX_RUNNER_OBJECT_BYTES_PER_ATTEMPT = 128 * 1024 * 1024;

export type ObjectAdmission = "new" | "again" | "object-bound";

export type RunnerObjects = Readonly<{
  /** Whether this slot may store one more object of this digest and size: again for a digest it stored before, which counts once. */
  admit(slot: SlotName, digest: string, bytes: number): ObjectAdmission;
  /** Count a stored object for this slot. A digest already counted is not counted twice. */
  count(slot: SlotName, digest: string, bytes: number): void;
}>;

/**
 * Each object a runner stored, by slot. An object stored and never named by a row stays in the
 * bucket, named by nothing, as an abandoned create's do; this table lists it so a later purge can
 * find it. Nothing here removes one.
 */
export function runnerObjectsOver(storage: HostStorage, now: () => number): RunnerObjects {
  const { sql } = storage;
  sql.exec("CREATE TABLE IF NOT EXISTS runner_objects (slot TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (slot, digest))").toArray();
  return {
    admit(slot, digest, bytes) {
      if (sql.exec("SELECT digest FROM runner_objects WHERE slot = ? AND digest = ?", slot, digest).toArray().length > 0) return "again";
      const [{ held, total }] = sql.exec("SELECT count(*) AS held, coalesce(sum(bytes), 0) AS total FROM runner_objects WHERE slot = ?", slot).toArray();
      if (Number(held) >= MAX_RUNNER_OBJECTS_PER_ATTEMPT || Number(total) + bytes > MAX_RUNNER_OBJECT_BYTES_PER_ATTEMPT) return "object-bound";
      return "new";
    },
    count(slot, digest, bytes) {
      sql.exec("INSERT INTO runner_objects (slot, digest, bytes, at_ms) VALUES (?, ?, ?, ?) ON CONFLICT (slot, digest) DO NOTHING", slot, digest, bytes, now()).toArray();
    }
  };
}
