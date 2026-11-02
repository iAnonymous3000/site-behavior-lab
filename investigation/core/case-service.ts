// The narrow seam between the viewer and wherever cases live. Today an in-process service
// over the log's stores answers it. A Durable Object can later sit behind the same three
// calls, since each takes plain data and gives plain data back.
//
// Each call takes the Access assertion the gate verified, as the raw token, and verifies it
// again here with the same verifier and the same policy. An actor cannot be handed across:
// actor.ts derives one by membership of a set in one isolate, and a Durable Object is another
// isolate. So the actor is derived here, from this verification, and never leaves. Nor does a
// folded case: what goes back is a structured copy of its data, so the registration case-store.ts
// keeps on the object it folded stays on this side, and nothing a caller holds can be sent back
// to runCommand.
//
// Writes are claims and nothing else: a fact, an assertion, an interpretation, a supersede, a
// retraction and a reaffirm. Every other event the log can hold is refused here by type, before a
// case is opened, so a later caller of this seam cannot drive the machine through it. There is
// no approve, publish or export call.
//
// A write names the head its writer viewed. A case whose head has moved since is refused as a
// conflict, with the current case handed back, and nothing is written: so a reaffirm can bind
// only fact versions its writer saw. The log's own compare-and-swap still stands behind that,
// for a write that lands between this open and the append.

import { verifyAccessToken, type AccessKeySet, type AccessPolicy } from "./access-token";
import { ownerActorFrom, type OwnerActor } from "./actor";
import type { EvidenceSeen, LogEvent, LogStores } from "./case-log";
import { openCase, runCommand, type CaseState, type CommandRefusal, type OpenCase, type OpenCaseResult } from "./case-store";

/** The only events this seam writes. A test holds that every other type the log knows is refused. */
export const CLAIM_EVENT_TYPES: readonly string[] = ["fact-recorded", "fact-superseded", "fact-retracted", "assertion-recorded", "assertion-retracted", "interpretation-recorded", "interpretation-reaffirmed"];

/** How many bytes of an evidence object one page shows. */
export const EVIDENCE_PAGE_BYTES = 32 * 1024;

/** A case as plain data: what the log folded to, at the head it was folded at. */
export type CaseView = Readonly<{ caseId: string; head: string; seq: number; state: CaseState | null }>;

export type AccessAnswer = Readonly<{ ok: false; refusal: "access-refused" | "unavailable" }>;
export type CaseRefusal = Readonly<{ ok: false; refusal: Extract<OpenCaseResult, { ok: false }>["refusal"]; at: string | null }>;

export type OpenAnswer = Readonly<{ ok: true; case: CaseView }> | AccessAnswer | CaseRefusal;

export type ClaimAnswer =
  | Readonly<{ ok: true; case: CaseView }>
  | AccessAnswer
  | CaseRefusal
  | Readonly<{ ok: false; refusal: "not-a-claim" }>
  | Readonly<{ ok: false; refusal: "conflict"; case: CaseView }>
  | Readonly<{ ok: false; refusal: Exclude<CommandRefusal, "conflict">; at: string | null; case: CaseView }>;

/**
 * One page of an evidence object, as text decoded from its bytes. Offsets are bytes. A page ends
 * before a character its last bytes would cut, when it can, so only a page that starts inside a
 * character, or one at the end of bytes that are cut short, holds part of one: those bytes are
 * handed back on their own, for a reader to show as bytes, and the text holds whole characters.
 */
export type EvidencePage = Readonly<{
  digest: string;
  offset: number;
  end: number;
  total: number;
  /** Where the page before this one starts, or null for the first page. From an offset no page starts at, the page that holds it. */
  previous: number | null;
  /** Continuation bytes at the start, up to three. */
  leadingBytes: readonly number[];
  /** Whether the page before ends with the lead of a character these leading bytes complete. False for the first page, or for stray bytes that finish nothing. */
  leadingEndsCharacter: boolean;
  text: string;
  /** Bytes at the end that begin a character the page does not hold. */
  trailingBytes: readonly number[];
  /** Whether the whole object is UTF-8. False means each bad sequence in the text shows as a replacement character. */
  validUtf8: boolean;
}>;

export type EvidenceAnswer =
  | Readonly<{ ok: true; page: EvidencePage }>
  | AccessAnswer
  | CaseRefusal
  | Readonly<{ ok: false; refusal: "not-named-by-this-case" | "offset-past-end" }>;

export type CaseService = Readonly<{
  open(assertion: string, caseId: string): Promise<OpenAnswer>;
  evidence(assertion: string, caseId: string, digest: string, offset: number): Promise<EvidenceAnswer>;
  claim(assertion: string, caseId: string, viewedHead: string, event: LogEvent): Promise<ClaimAnswer>;
}>;

export type CaseServiceWorld = Readonly<{
  policy: AccessPolicy;
  keySetFor: (issuer: string) => Pick<AccessKeySet, "keyFor">;
  now: () => number;
  /** The stores holding this case's log, or null when none does, which reads as a log never created. */
  storesFor: (caseId: string) => LogStores | null;
}>;

const NO_LOG: CaseRefusal = Object.freeze({ ok: false, refusal: "head-missing", at: null });

/** A plain copy, so nothing this side registered goes with it. */
function viewOf(opened: OpenCase): CaseView {
  return structuredClone({ caseId: opened.caseId, head: opened.head, seq: opened.seq, state: opened.state });
}

/** Every object the log names: what rows name, what the case keeps, and what a control named. */
function digestsOfCase(state: CaseState | null): ReadonlySet<string> {
  if (state === null) return new Set();
  return new Set([...state.record.rows.flatMap(({ digest }) => (digest === null ? [] : [digest])), ...state.keptObjects, ...state.controlObjects]);
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** How many bytes the character a lead byte begins takes, or 1 for a byte that begins none. */
function sequenceLength(byte: number): number {
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  if (byte >= 0xe0) return byte <= 0xef ? 3 : 1;
  return byte >= 0xc2 ? 2 : 1;
}

/**
 * Where the page starting here ends: a full page, backed off a character it would cut, at most the
 * three bytes a UTF-8 sequence can trail by. A page is far longer than three bytes, so a page always
 * ends past where it starts.
 */
function pageEnd(bytes: Uint8Array, start: number): number {
  let end = Math.min(bytes.length, start + EVIDENCE_PAGE_BYTES);
  for (let back = 0; back < 3 && end < bytes.length && isContinuationByte(bytes[end]); back += 1) end -= 1;
  return end;
}

/** Whether these bytes are UTF-8, read a slice at a time so no string of the whole object is ever built. */
function isUtf8(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    for (let at = 0; at < bytes.length; at += EVIDENCE_PAGE_BYTES) decoder.decode(bytes.subarray(at, at + EVIDENCE_PAGE_BYTES), { stream: true });
    decoder.decode();
    return true;
  } catch {
    return false;
  }
}

/** Whether the bytes before `offset` begin a character that exactly `lead` continuation bytes from `offset` finish. */
function endsCharacter(bytes: Uint8Array, offset: number, lead: number): boolean {
  if (lead === 0) return false;
  for (let back = 1; back <= 3 && offset - back >= 0; back += 1) {
    const byte = bytes[offset - back];
    if (isContinuationByte(byte)) continue;
    return sequenceLength(byte) === back + lead;
  }
  return false;
}

function pageOf(digest: string, bytes: Uint8Array, offset: number): EvidencePage {
  const total = bytes.length;
  const end = pageEnd(bytes, offset);
  // Pages run from the start, each from the end of the one before, so the one before this is found the same way.
  let previous: number | null = null;
  for (let at = 0; at < offset; at = pageEnd(bytes, at)) previous = at;
  let lead = 0;
  while (lead < 3 && offset + lead < end && isContinuationByte(bytes[offset + lead])) lead += 1;
  // A character begun in the page's last bytes and not finished there.
  let trail = 0;
  for (let back = 1; back <= 3 && end - back >= offset + lead; back += 1) {
    const byte = bytes[end - back];
    if (isContinuationByte(byte)) continue;
    if (sequenceLength(byte) > back) trail = back;
    break;
  }
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes.subarray(offset + lead, end - trail));
  return {
    digest,
    offset,
    end,
    total,
    previous,
    leadingBytes: [...bytes.subarray(offset, offset + lead)],
    leadingEndsCharacter: endsCharacter(bytes, offset, lead),
    text,
    trailingBytes: [...bytes.subarray(end - trail, end)],
    validUtf8: isUtf8(bytes)
  };
}

function isClaimEvent(event: unknown): event is LogEvent {
  return typeof event === "object" && event !== null && CLAIM_EVENT_TYPES.includes((event as { type?: unknown }).type as string);
}

/** The in-process service over the log's stores. */
export function caseServiceOver(world: CaseServiceWorld): CaseService {
  /** The owner's actor from this assertion, verified here, or why there is none. */
  async function ownerFrom(assertion: unknown): Promise<OwnerActor | AccessAnswer> {
    const decision = await verifyAccessToken(typeof assertion === "string" ? assertion : null, world.policy, world.keySetFor(world.policy.issuer), world.now);
    if (!decision.ok) return { ok: false, refusal: decision.refusal === "keys-unavailable" ? "unavailable" : "access-refused" };
    // A service token's identity gives no actor, so it reaches no case.
    return ownerActorFrom(decision.identity) ?? { ok: false, refusal: "access-refused" };
  }

  async function opened(caseId: string, seen: EvidenceSeen | null = null): Promise<Readonly<{ ok: true; stores: LogStores; case: OpenCase }> | CaseRefusal> {
    const stores = world.storesFor(caseId);
    if (stores === null) return NO_LOG;
    const result = await openCase(stores, caseId, seen);
    return result.ok ? { ok: true, stores, case: result.case } : { ok: false, refusal: result.refusal, at: result.at };
  }

  return {
    async open(assertion, caseId) {
      const owner = await ownerFrom(assertion);
      if ("ok" in owner) return owner;
      const result = await opened(caseId);
      return result.ok ? { ok: true, case: viewOf(result.case) } : result;
    },

    async evidence(assertion, caseId, digest, offset) {
      const owner = await ownerFrom(assertion);
      if ("ok" in owner) return owner;
      // Opening the case reads and hashes every object its log names, once for each entry that
      // names it, this one included. The bytes the last of those reads hashed are the ones shown,
      // so the page itself reads and hashes nothing again.
      let bytes: Uint8Array | null = null;
      const result = await opened(caseId, (named, held) => {
        if (named === digest) bytes = held;
      });
      if (!result.ok) return result;
      // Only what this case's log names. One evidence store can serve several cases, so
      // anything wider would read another case's bytes through this one.
      if (!digestsOfCase(result.case.state).has(digest) || bytes === null) return { ok: false, refusal: "not-named-by-this-case" };
      const held: Uint8Array = bytes;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > held.length || (offset === held.length && offset > 0)) return { ok: false, refusal: "offset-past-end" };
      return { ok: true, page: pageOf(digest, held, offset) };
    },

    async claim(assertion, caseId, viewedHead, event) {
      const owner = await ownerFrom(assertion);
      if ("ok" in owner) return owner;
      if (!isClaimEvent(event)) return { ok: false, refusal: "not-a-claim" };
      const result = await opened(caseId);
      if (!result.ok) return result;
      // The head the writer viewed must still be the head. Otherwise what they read is not
      // what they would be writing against, and nothing is written.
      if (result.case.head !== viewedHead) return { ok: false, refusal: "conflict", case: viewOf(result.case) };
      const written = await runCommand(result.stores, result.case, { actor: owner, event, now: world.now });
      if (written.ok) return { ok: true, case: viewOf(written.case) };
      if (written.refusal === "conflict") {
        const current = await opened(caseId);
        return current.ok ? { ok: false, refusal: "conflict", case: viewOf(current.case) } : current;
      }
      return { ok: false, refusal: written.refusal, at: written.at, case: viewOf(result.case) };
    }
  };
}
