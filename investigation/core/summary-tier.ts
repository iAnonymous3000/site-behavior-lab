// The summary tier: what may be kept of an attempt once its raw tier is gone, and all that
// a later reader of a summary can see. It is built field by field from an allow-list, so
// script text, query values, fragments, storage values and console text have nowhere to go,
// and then the result is held to a shape validator with exact keys, so that a mistake in
// the projection refuses rather than leaks.
//
// A path is stored as a digest, because a path can carry an email, and the public redaction
// is out of this folder's reach by the boundary. A digest of a short path can be guessed by
// anyone who can guess the path, so it hides a path from a reader, not from a determined one.
//
// A refusal names a field of this shape, never a value, so what a capture held cannot
// reach an error. This takes a capture's plain fields and no tool's own output: an adapter
// is a later batch. The claim is that these canaries and shapes do not reach a summary, not
// that nothing sensitive could. An origin is kept as a URL parser spells it, and a host can
// carry whatever a site put in it, so a value a site wrote into a subdomain reaches a summary.
// There is no filter for that, and a test pins it. Owner-written text is not part of a summary.
//
// A range's count of 0 is kept as the capture gave it, beside the attempt's phase. The phase tells
// a walled, an incomplete and a failed, timed-out or cancelled attempt apart, and that is all it
// tells. A 0 limited by partial coverage, unresolved cleanup, function-only granularity, a window
// that did not close, scope or arriving late reads the same as a clean one here. No field says so,
// by decision: a reader of a 0 in a summary does not have those, and a test pins that.

import { isDigest } from "./case-log";
import { hasExactly, sha256Hex } from "./canonical-json";
import { OUTCOMES, SLOT_NAMES, type Arm, type AttemptPhase, type SlotName } from "./case-machine";

/** Raw fields a capture may hold. Anything not read below is not read. */
export type RawCapture = Readonly<{
  scripts: readonly Readonly<{ url: string; text: string; ranges: readonly Readonly<{ startOffset: number; endOffset: number; count: number }>[] }>[];
  requests: readonly Readonly<{ url: string }>[];
  storage: readonly Readonly<{ key: string; value: string }>[];
  console: readonly Readonly<{ text: string }>[];
}>;

export type SummaryScript = Readonly<{
  origin: string | null;
  pathDigest: string | null;
  textDigest: string;
  length: number;
  ranges: readonly Readonly<{ startOffset: number; endOffset: number; count: number }>[];
}>;

export type AttemptSummary = Readonly<{
  v: 1;
  attemptId: string;
  slot: SlotName;
  arm: Arm;
  phase: AttemptPhase;
  scripts: readonly SummaryScript[];
  requestCount: number;
  requestOrigins: readonly Readonly<{ origin: string; count: number }>[];
  storageKeyCount: number;
  consoleMessageCount: number;
}>;

export type SummaryResult = Readonly<{ ok: true; summary: AttemptSummary }> | Readonly<{ ok: false; refusal: "capture-malformed" | "summary-shape"; at: string }>;

const ATTEMPT_ID = /^[0-9a-f]{32}$/;
/** An origin as a URL parser spells one: a scheme, a host with no user, path or query, and maybe a port. */
const ORIGIN = /^(?:https?|wss?):\/\/(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$/;
const PHASES: readonly string[] = ["planned", "starting", "capturing", "finalizing", ...OUTCOMES, "not_started"];
const SUMMARY_KEYS = ["v", "attemptId", "slot", "arm", "phase", "scripts", "requestCount", "requestOrigins", "storageKeyCount", "consoleMessageCount"];
const SCRIPT_KEYS = ["origin", "pathDigest", "textDigest", "length", "ranges"];
const RANGE_KEYS = ["startOffset", "endOffset", "count"];
const ORIGIN_COUNT_KEYS = ["origin", "count"];

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOrigin(value: unknown): value is string {
  return typeof value === "string" && ORIGIN.test(value);
}

function isRange(value: unknown): boolean {
  return isPlain(value) && hasExactly(value, RANGE_KEYS) && isCount(value.startOffset) && isCount(value.endOffset) && isCount(value.count);
}

function isSummaryScript(value: unknown): boolean {
  return (
    isPlain(value) &&
    hasExactly(value, SCRIPT_KEYS) &&
    (value.origin === null || isOrigin(value.origin)) &&
    (value.pathDigest === null || isDigest(value.pathDigest)) &&
    isDigest(value.textDigest) &&
    isCount(value.length) &&
    Array.isArray(value.ranges) &&
    value.ranges.every(isRange)
  );
}

/** Whether this is a summary and nothing else: exact keys at every level, and every string held to a shape. An origin's shape still lets a host say what a site made it say. */
export function isAttemptSummary(value: unknown): value is AttemptSummary {
  return (
    isPlain(value) &&
    hasExactly(value, SUMMARY_KEYS) &&
    value.v === 1 &&
    typeof value.attemptId === "string" &&
    ATTEMPT_ID.test(value.attemptId) &&
    (SLOT_NAMES as readonly unknown[]).includes(value.slot) &&
    (value.arm === "baseline" || value.arm === "instrumented") &&
    PHASES.includes(value.phase as string) &&
    Array.isArray(value.scripts) &&
    value.scripts.every(isSummaryScript) &&
    isCount(value.requestCount) &&
    Array.isArray(value.requestOrigins) &&
    value.requestOrigins.every((entry) => isPlain(entry) && hasExactly(entry, ORIGIN_COUNT_KEYS) && isOrigin(entry.origin) && isCount(entry.count)) &&
    isCount(value.storageKeyCount) &&
    isCount(value.consoleMessageCount)
  );
}

/** Scheme, host and port, or null for a URL with no usable origin, such as a data: URL. Never the user, path or query. */
function originOf(parsed: URL | null): string | null {
  if (parsed === null || parsed.origin === "null") return null;
  return isOrigin(parsed.origin) ? parsed.origin : null;
}

function parsedUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

async function digestOfText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

function isCaptureList(value: unknown): value is readonly Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isPlain);
}

/** A capture's shape, field by field. What fails is named, and what it held is not. */
function captureProblem(raw: RawCapture): string | null {
  if (!isPlain(raw)) return "capture";
  if (!isCaptureList(raw.scripts)) return "scripts";
  for (const script of raw.scripts as readonly Record<string, unknown>[]) {
    if (typeof script.url !== "string") return "scripts.url";
    if (typeof script.text !== "string") return "scripts.text";
    if (!isCaptureList(script.ranges)) return "scripts.ranges";
  }
  if (!isCaptureList(raw.requests)) return "requests";
  for (const request of raw.requests as readonly Record<string, unknown>[]) {
    if (typeof request.url !== "string") return "requests.url";
  }
  if (!Array.isArray(raw.storage)) return "storage";
  if (!Array.isArray(raw.console)) return "console";
  return null;
}

export type SummaryAttempt = Readonly<{ attemptId: string; slot: SlotName; arm: Arm; phase: AttemptPhase }>;

/** Project one attempt's capture onto the allow-list, or refuse. Nothing else leaves here. */
export async function projectAttemptSummary(attempt: SummaryAttempt, raw: RawCapture): Promise<SummaryResult> {
  if (!isPlain(attempt)) return { ok: false, refusal: "capture-malformed", at: "attempt" };
  const problem = captureProblem(raw);
  if (problem !== null) return { ok: false, refusal: "capture-malformed", at: problem };

  const scripts: SummaryScript[] = [];
  for (const script of raw.scripts) {
    const parsed = parsedUrl(script.url);
    scripts.push({
      origin: originOf(parsed),
      pathDigest: parsed === null ? null : await digestOfText(parsed.pathname),
      textDigest: await digestOfText(script.text),
      length: script.text.length,
      ranges: script.ranges.map(({ startOffset, endOffset, count }) => ({ startOffset, endOffset, count }))
    });
  }

  const originCounts = new Map<string, number>();
  for (const request of raw.requests) {
    const origin = originOf(parsedUrl(request.url));
    if (origin !== null) originCounts.set(origin, (originCounts.get(origin) ?? 0) + 1);
  }

  const summary = {
    v: 1,
    attemptId: attempt.attemptId,
    slot: attempt.slot,
    arm: attempt.arm,
    phase: attempt.phase,
    scripts,
    requestCount: raw.requests.length,
    requestOrigins: [...originCounts.keys()].sort().map((origin) => ({ origin, count: originCounts.get(origin) as number })),
    storageKeyCount: raw.storage.length,
    consoleMessageCount: raw.console.length
  };
  return isAttemptSummary(summary) ? { ok: true, summary } : { ok: false, refusal: "summary-shape", at: "summary" };
}
