// A case's attributable, tamper-evident history. Pure, with no Node builtin and no
// dependency, so it runs in a Worker and in the unit suite alike. Storage, the clock
// and the actor are passed in.
//
// One entry per command. An entry is canonical bytes addressed by their SHA-256,
// names its case and the entry before it by digest, holds who acted and the digests
// of the evidence it rests on, and is written create-only. The head names the newest
// entry and lives apart, behind a compare-and-swap. An append writes the entry and
// then swaps the head, so the swap is the whole commit point: a crash before it leaves
// an unreachable object and the command simply did not happen, and nothing can be
// torn. Reads walk back from the head and trust nothing they did not hash.
//
// DETECTED on open, each by its own typed refusal: an edited entry, an entry removed
// at any position (including the newest, since the head still names it), a changed or
// removed evidence object, an entry of another case (so a head moved to another case's
// entry is refused even when the two share a store), a wrong genesis or broken chain,
// time running backward, an owner entry past its token's expiry, and a missing or
// malformed head. A stale writer gets a typed conflict and changes nothing.
//
// NOT DETECTED: someone holding the Cloudflare account who rewrites log and head
// together. That includes moving only the head: back to an older entry of this case, back
// to genesis, which opens as an empty log, or to an orphan of this case that a crash or a
// lost race left behind, since those entries are genuine and an orphan is
// indistinguishable from the next command. It also
// includes copying another case's events into new entries that name this case, since
// the case id is only a field and the copy hashes as well as the original. Entries carry
// no signature, by the owner's decision, so nothing else in the system can tell.
//
// The binding to a case holds only between distinct ids. Two cases given one id in a
// shared store can still be spliced by a head write alone, so whatever mints case ids
// must keep them unique per store. Nothing here can.
//
// A head saved outside the account is the only defense beyond that: verifyAgainstSavedHead
// below re-walks the log and refuses one that no longer passes through that head. Given
// a SHA-256 that holds, the entries up to a head that passes are the ones saved. It says
// nothing about entries added after it. Nothing offers the download yet.
//
// Also not shown: that a person meant a command. An entry records what the Worker
// verified about the token on that request, and no more.
//
// A LATER BATCH must decide how a Durable Object gets an actor. isDerivedActor is
// membership of a set in one isolate, so an actor passed over RPC arrives as a plain
// object and is refused here. The DO has to verify the token itself, or receive a
// separately reviewed way in, and that choice should not be made by loosening this.

import { isAttemptId, isDerivedActor, type Actor } from "./actor";
import { bytesEqual, canonicalBytes, hasExactly, parseCanonical, sha256Hex, type CanonicalValue } from "./canonical-json";

/** Eight times the longest entry M1 wrote, 31 KB for an import. */
export const MAX_ENTRY_BYTES = 256 * 1024;
/**
 * WebCrypto digests one buffer at a time, and a Worker holds 128 MB, so one object
 * is bounded. A larger capture goes in parts, each its own object.
 */
export const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
/** What a log's head is before its first entry, and what that entry's `prev` must be. */
export const GENESIS_HEAD = "0".repeat(64);
/** A head is a digest, so a longer one is malformed whatever it holds. */
export const MAX_HEAD_CHARS = 64;

const ENTRY_VERSION = 1;
const DIGEST = /^[0-9a-f]{64}$/;
const EVENT_TYPE = /^[a-z][a-z0-9._-]{0,63}$/;
/** One label of lowercase letters, digits and hyphens, as a generated id or a short slug can be. */
const CASE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Why a bounded read found no usable object. Null is the third answer, for nothing there. */
export type UnreadableObject = "too-large" | "not-an-object";

/** Objects addressed by the digest of their bytes. Never overwritten, and only a purge may remove one. */
export type ObjectStore = {
  /** Store these bytes if the address is free. "exists" leaves what is there untouched, whatever it holds. */
  createOnly(address: string, bytes: Uint8Array): Promise<"created" | "exists">;
  /**
   * The bytes at this address, or null for nothing. A store must find out that an
   * object is past `maxBytes` without holding it, and answer "too-large". Something
   * at the address that cannot be an object, such as a directory, is "not-an-object".
   */
  read(address: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | UnreadableObject | null>;
};

/** The one mutable value in a log. It must not live beside the objects it protects. */
export type HeadStore = {
  /**
   * The head as stored, or null when this log was never created. A stored value is not
   * trusted to be well formed. One past `maxChars` must not be held, and reads as "".
   */
  read(maxChars: number): Promise<string | null>;
  /** Replace the head only if it still reads `expected`, atomically. False changes nothing. */
  compareAndSwap(expected: string | null, next: string): Promise<boolean>;
};

export type LogStores = Readonly<{ entries: ObjectStore; evidence: ObjectStore; head: HeadStore }>;

/** Data is kept as given and never read for attribution: who acted is the entry's actor, and only that. */
export type LogEvent = Readonly<{ type: string; data: { readonly [key: string]: CanonicalValue } }>;

/** The same data as an Actor, read back from an entry. The log would refuse it as one: see isDerivedActor. */
export type StoredActor = Actor;

export type LogEntry = Readonly<{
  v: typeof ENTRY_VERSION;
  /** The case this entry belongs to. Part of the digest, so two cases' first commands never share an entry. */
  case: string;
  seq: number;
  prev: string;
  atMs: number;
  actor: StoredActor;
  events: readonly LogEvent[];
  /** Digests of the evidence objects this command rests on. */
  evidence: readonly string[];
}>;

export type OpenLog = Readonly<{
  head: string;
  /** Oldest first, each with the address it was read from and hashed against. */
  entries: readonly Readonly<{ digest: string; entry: LogEntry }>[];
}>;

export type OpenRefusal =
  | "malformed-case-id"
  | "head-missing"
  | "head-malformed"
  | "entry-missing"
  | "entry-edited"
  | "entry-malformed"
  | "entry-too-large"
  | "wrong-case"
  | "wrong-genesis"
  | "broken-chain"
  | "time-went-backward"
  | "actor-expired"
  | "evidence-missing"
  | "evidence-changed"
  | "evidence-too-large";

export type OpenResult = Readonly<{ ok: true; log: OpenLog }> | Readonly<{ ok: false; refusal: OpenRefusal; at: string | null }>;

export type AppendRefusal =
  | OpenRefusal
  | "conflict"
  | "not-an-actor"
  | "malformed-command"
  | "object-collision";

export type AppendResult =
  | Readonly<{ ok: true; digest: string; entry: LogEntry }>
  | Readonly<{ ok: false; refusal: AppendRefusal; at: string | null }>;

/** A command as a caller gives it. There is no name in it: who acted is the actor, and only the actor. */
export type AppendCommand = Readonly<{
  caseId: string;
  actor: Actor;
  events: readonly LogEvent[];
  evidence: readonly string[];
  /** The head the caller read. Required: a command nobody checked against the log is not a command. */
  expectedHead: string;
  now: () => number;
}>;

type Refused<R> = Readonly<{ ok: false; refusal: R; at: string | null }>;

function refuse<R extends string>(refusal: R, at: string | null = null): Refused<R> {
  return { ok: false, refusal, at };
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

export function isCaseId(value: unknown): value is string {
  return typeof value === "string" && CASE_ID.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Everything checked here came through parseCanonical, so a number is already a safe integer. */
function isCount(value: unknown, least: number): value is number {
  return typeof value === "number" && value >= least;
}

function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isStoredActor(value: unknown): value is StoredActor {
  if (!isPlainRecord(value)) return false;
  if (value.kind === "owner") {
    return (
      hasExactly(value, ["kind", "iss", "sub", "email", "iat", "exp"]) &&
      isFilledString(value.iss) &&
      isFilledString(value.sub) &&
      isFilledString(value.email) &&
      isCount(value.iat, 0) &&
      isCount(value.exp, 0)
    );
  }
  return value.kind === "system:runner" && hasExactly(value, ["kind", "attemptId"]) && isAttemptId(value.attemptId);
}

function isLogEvent(value: unknown): value is LogEvent {
  return (
    isPlainRecord(value) &&
    hasExactly(value, ["type", "data"]) &&
    typeof value.type === "string" &&
    EVENT_TYPE.test(value.type) &&
    isPlainRecord(value.data)
  );
}

/** What a log entry must look like, for what is about to be written and for what was read, alike. */
function isLogEntry(value: unknown): value is LogEntry {
  return (
    isPlainRecord(value) &&
    hasExactly(value, ["v", "case", "seq", "prev", "atMs", "actor", "events", "evidence"]) &&
    value.v === ENTRY_VERSION &&
    isCaseId(value.case) &&
    isCount(value.seq, 1) &&
    isDigest(value.prev) &&
    isCount(value.atMs, 0) &&
    isStoredActor(value.actor) &&
    Array.isArray(value.events) &&
    value.events.length > 0 &&
    value.events.every(isLogEvent) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isDigest)
  );
}

/** An owner's command belongs inside the token that vouches for it. The verifier refuses a token at `exp`, so this does too. */
function isPastActorExpiry(entry: LogEntry): boolean {
  return entry.actor.kind === "owner" && entry.atMs >= entry.actor.exp * 1000;
}

type ChainWalk = Readonly<{ ok: true; log: OpenLog }> | Refused<OpenRefusal>;

/**
 * A store's answer, as bytes only this module holds. A store is asked to keep to the
 * bound, and this holds it to that, whichever store it is. Everything after this awaits
 * while the store still has what it returned, so what is hashed and what is then parsed
 * must be one copy, taken once, or a store could change the second after the first.
 */
async function readOwn(store: ObjectStore, address: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | UnreadableObject | null> {
  const answer = await store.read(address, maxBytes);
  if (answer === null || typeof answer === "string") return answer;
  // A plain copy, whatever came back: a view from another realm is no instance of this
  // one's Uint8Array, and a subclass or a proxy can answer any length it likes.
  const own = new Uint8Array(answer).slice();
  return own.length > maxBytes ? "too-large" : own;
}

/** Back from the head to genesis. Every object is hashed against its address before anything in it is read. */
async function walkChain(stores: LogStores, caseId: string): Promise<ChainWalk> {
  if (!isCaseId(caseId)) return refuse("malformed-case-id");
  const head = await stores.head.read(MAX_HEAD_CHARS);
  if (head === null) return refuse("head-missing");
  if (!isDigest(head)) return refuse("head-malformed");

  const entries: { digest: string; entry: LogEntry }[] = [];
  let cursor = head;
  let later: LogEntry | null = null;
  while (cursor !== GENESIS_HEAD) {
    const bytes: Uint8Array<ArrayBuffer> | UnreadableObject | null = await readOwn(stores.entries, cursor, MAX_ENTRY_BYTES);
    if (bytes === null) return refuse("entry-missing", cursor);
    if (bytes === "too-large") return refuse("entry-too-large", cursor);
    if (bytes === "not-an-object") return refuse("entry-edited", cursor);
    if ((await sha256Hex(bytes)) !== cursor) return refuse("entry-edited", cursor);
    const entry: CanonicalValue = parseCanonical(bytes);
    if (!isLogEntry(entry)) return refuse("entry-malformed", cursor);
    if (entry.case !== caseId) return refuse("wrong-case", cursor);
    if (later !== null && entry.seq !== later.seq - 1) return refuse("broken-chain", cursor);
    if ((entry.seq === 1) !== (entry.prev === GENESIS_HEAD)) return refuse("wrong-genesis", cursor);
    if (later !== null && entry.atMs > later.atMs) return refuse("time-went-backward", cursor);
    if (isPastActorExpiry(entry)) return refuse("actor-expired", cursor);
    entries.push({ digest: cursor, entry });
    later = entry;
    cursor = entry.prev;
  }
  return { ok: true, log: { head, entries: entries.reverse() } };
}

/** Null when the object at this digest is there and holds these bytes, or the refusal an open would give. */
async function checkEvidence(stores: LogStores, digest: string): Promise<Refused<OpenRefusal> | null> {
  const bytes = await readOwn(stores.evidence, digest, MAX_EVIDENCE_BYTES);
  if (bytes === null) return refuse("evidence-missing", digest);
  if (bytes === "too-large") return refuse("evidence-too-large", digest);
  if (bytes === "not-an-object") return refuse("evidence-changed", digest);
  if ((await sha256Hex(bytes)) !== digest) return refuse("evidence-changed", digest);
  return null;
}

/** Start a log, once. Until this runs the head is absent, and an absent head never reads as an empty log. */
export async function createLog(stores: LogStores): Promise<Readonly<{ ok: true }> | Refused<"log-exists">> {
  return (await stores.head.compareAndSwap(null, GENESIS_HEAD)) ? { ok: true } : refuse("log-exists");
}

/** This case's whole log from its head, with every entry and evidence object checked, or the first thing wrong with it. */
export async function openLog(stores: LogStores, caseId: string): Promise<OpenResult> {
  const walk = await walkChain(stores, caseId);
  if (!walk.ok) return walk;
  for (const { entry } of walk.log.entries) {
    for (const digest of entry.evidence) {
      const refusal = await checkEvidence(stores, digest);
      if (refusal !== null) return refusal;
    }
  }
  return walk;
}

/** Store one evidence object, ahead of the command that will name it. Unnamed, it changes nothing about any log. */
export async function putEvidence(
  stores: LogStores,
  bytes: Uint8Array
): Promise<Readonly<{ ok: true; digest: string }> | Refused<"evidence-too-large" | "object-collision">> {
  if (bytes.length > MAX_EVIDENCE_BYTES) return refuse("evidence-too-large");
  // The awaits below yield, and the caller still holds its buffer. What is hashed and what is stored must be one thing.
  const own = new Uint8Array(bytes);
  const digest = await sha256Hex(own);
  if (!(await createVerified(stores.evidence, digest, own))) return refuse("object-collision", digest);
  return { ok: true, digest };
}

/**
 * Create the object, or find it already there, as a retry after a crash will. What
 * is there must be these bytes: otherwise the head would come to name an address
 * holding something else, and every later open would refuse the log.
 */
async function createVerified(store: ObjectStore, digest: string, bytes: Uint8Array): Promise<boolean> {
  if ((await store.createOnly(digest, bytes)) === "created") return true;
  const there = await readOwn(store, digest, bytes.length);
  return there instanceof Uint8Array && bytesEqual(there, bytes);
}

/** The bytes these fields would write, read as open will read them, or why they cannot be written anywhere. */
function preparedEntry(fields: unknown): Readonly<{ ok: true; bytes: Uint8Array<ArrayBuffer>; entry: LogEntry }> | Refused<"malformed-command" | "entry-too-large" | "actor-expired"> {
  const bytes = canonicalBytes(fields);
  if (bytes === null) return refuse("malformed-command");
  if (bytes.length > MAX_ENTRY_BYTES) return refuse("entry-too-large");
  // The bytes about to be written, read as open will read them, so a command can
  // never brick its log and nothing a caller holds can differ from what was checked.
  const entry = parseCanonical(bytes);
  if (!isLogEntry(entry)) return refuse("malformed-command");
  if (isPastActorExpiry(entry)) return refuse("actor-expired");
  return { ok: true, bytes, entry };
}

/**
 * What appendCommand would refuse this command for as a new log's first entry, at a time the
 * caller has already read, from an actor the caller has already checked is derived. Only what the
 * stores answer when it writes is left out. It writes nothing, so a caller can hear no before
 * there is a log to leave behind.
 */
export async function checkFirstEntry(stores: LogStores, { caseId, actor, events, evidence }: Pick<AppendCommand, "caseId" | "actor" | "events" | "evidence">, atMs: unknown): Promise<Refused<AppendRefusal> | null> {
  const prepared = preparedEntry({ v: ENTRY_VERSION, case: caseId, seq: 1, prev: GENESIS_HEAD, atMs, actor, events, evidence });
  if (!prepared.ok) return prepared;
  for (const digest of prepared.entry.evidence) {
    const refusal = await checkEvidence(stores, digest);
    if (refusal !== null) return refusal;
  }
  return null;
}

/**
 * Commit one command, or refuse it having changed nothing a reader can see. An orphan
 * may be left behind, which no reader reaches. If this rejects because a store failed,
 * the command may or may not have happened: reopen to find out.
 *
 * A clock that stepped back is refused rather than recorded, so the times in a log only
 * rise. The command can simply be tried again once the clock has caught up.
 *
 * The chain is walked but evidence already in the log is not read again, because a
 * command should not cost a re-hash of every capture. Opening checks all of it, and
 * what this command names is checked here.
 */
export async function appendCommand(stores: LogStores, command: AppendCommand): Promise<AppendResult> {
  const { caseId, actor, events, evidence, expectedHead, now } = command;
  if (!isDerivedActor(actor)) return refuse("not-an-actor");

  const walk = await walkChain(stores, caseId);
  if (!walk.ok) return walk;
  const { head, entries } = walk.log;
  if (head !== expectedHead) return refuse("conflict");

  const prepared = preparedEntry({ v: ENTRY_VERSION, case: caseId, seq: entries.length + 1, prev: head, atMs: now(), actor, events, evidence });
  if (!prepared.ok) return prepared;
  const { bytes, entry } = prepared;
  if (entries.length > 0 && entry.atMs < entries[entries.length - 1].entry.atMs) return refuse("time-went-backward");

  for (const digest of entry.evidence) {
    const refusal = await checkEvidence(stores, digest);
    if (refusal !== null) return refusal;
  }

  const digest = await sha256Hex(bytes);
  if (!(await createVerified(stores.entries, digest, bytes))) return refuse("object-collision", digest);
  // The commit point. Everything before it is unreachable until this succeeds.
  if (!(await stores.head.compareAndSwap(head, digest))) return refuse("conflict");
  return { ok: true, digest, entry };
}

export type SavedHeadRefusal = "saved-head-malformed" | "saved-head-not-on-chain";

/**
 * Whether this case's log still passes through a head saved earlier and kept outside
 * the account. It takes no one's word for the log: it walks and hashes what the stores
 * hold, as opening does, and writes nothing, so a person's own copy of a log can stand
 * behind the same read interface. The log may have grown past that head. One rewritten
 * to leave it out, or rolled back before it, is refused, even though it opens clean. See
 * the note at the top.
 */
export async function verifyAgainstSavedHead(
  stores: LogStores,
  caseId: string,
  savedHead: unknown
): Promise<Readonly<{ ok: true }> | Refused<SavedHeadRefusal | OpenRefusal>> {
  if (!isDigest(savedHead)) return refuse("saved-head-malformed");
  const opened = await openLog(stores, caseId);
  if (!opened.ok) return opened;
  if (savedHead === GENESIS_HEAD) return { ok: true };
  return opened.log.entries.some(({ digest }) => digest === savedHead) ? { ok: true } : refuse("saved-head-not-on-chain");
}
