import { isPublishedAddressShape } from "./connection-inspection-address";
import { MAX_INSPECTION_GROUP_HOSTS, MAX_INSPECTION_GROUP_SCRIPTS } from "./connection-inspection-evidence";
import { isRecord } from "./guards";
import { redactHostnameV2, redactUrlV2 } from "./redaction-v2";
import { sha256Hex } from "./sha256";

/**
 * The one stack publisher: how a visit turns the synchronous call stacks
 * Chromium sends with `Network.requestWillBeSent` into published hosts, and
 * how it joins those observations to the requests the page itself reported.
 * "Inspect this connection" (lib/connection-inspection.ts) and a check after
 * scrolling (lib/scroll-check-stacks.ts) both publish through it, so the two
 * cannot come to disagree about what a stack names (build brief 2026-10-24,
 * section 1).
 *
 * SHARED LOGIC, NEVER SHARED STATE. Every structure here is owned by the
 * recorder that passes it in: each keeps its own set of requested scripts
 * and documents, its own stacks and its own counts, and stops recording at
 * its own boundary. Nothing in this module holds a value between calls.
 *
 * THE RULES, as the owner ruled them on 2026-10-22:
 * - a frame counts only when its URL equals a Script or Document request the
 *   same visit's session had observed by then, which a real script always
 *   is, since it was requested before it ran; a name a script gave itself
 *   with a sourceURL comment counts only when it equals such an address;
 * - a stack publishes at most four hosts, innermost first, through the
 *   report's own hostname redaction, consecutive repeats collapsed; an async
 *   parent is never followed;
 * - a redirect hop carries the stack of the request that started the chain,
 *   so it is counted apart and names no script; a request with no stack is
 *   counted apart, which does not show that no script was involved
 *   (lib/connection-inspection-fixture.test.ts pins why);
 * - a CORS preflight is the browser's own request, which the page never
 *   reports, so it joins nothing;
 * - the page's requests of one URL are joined, in arrival order, to the
 *   session's observations of that URL, at most as many as the page
 *   reported; a request the session never observed is `unobserved` (a
 *   dedicated worker's, which the page reports and its session never sees),
 *   and one whose observation a bound dropped is `notListed`.
 *
 * Never kept: function names, line or column numbers, script, frame or
 * request ids, frame names, stack depth. Server only: it reads the redaction
 * pass and its public-suffix list (lib/client-boundary.test.ts).
 */

/** Frames read from one stack, innermost first (Chromium's own cap is about this). */
export const MAX_STACK_FRAMES = 200;
/** Distinct Script and Document request URLs one recorder keeps for naming frames. */
export const MAX_REQUESTED_CODE_URLS = 4_000;
/**
 * A raw URL longer than this is held by its digest, never as itself, so a
 * recorder's tables stay small however long the page makes its URLs (up to
 * the 16,384 characters the redaction pass reads), and a long one is still
 * joined and still names its frames.
 */
export const MAX_HELD_URL_CHARS = 2_048;

/** How one observation is broken down. A group is keyed by what its stack publishes. */
export type StackObservationCategory =
  | "redirected"
  | "withoutStack"
  | "withoutNamedScript"
  | "notListed"
  | { group: string };

/** What a stack publishes: its hosts, and, for a recorder that names them, its scripts. */
export type PublishedStack = { hosts: string[]; namedScripts: string[] };

export type StackPublishing = {
  /**
   * Whether frames also name their scripts' published addresses. The check
   * after scrolling publishes hosts only (owner call 2, 2026-10-24), so it
   * computes none.
   */
  scripts: boolean;
  /**
   * The recorder's own cache of a frame's published host, by its held key.
   * The host is a function of the frame's URL alone, so a cache changes no
   * output; it spares a recorder that publishes many stacks from redacting
   * the same scripts' hosts again and again.
   */
  hostCache?: Map<string, string>;
};

const INSPECTION_PUBLISHING: StackPublishing = { scripts: true };

export function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * The key a raw URL is joined and matched by: the URL itself with its
 * fragment dropped, or that URL's digest when it is long. Two URLs share a
 * key exactly when they are the same URL.
 */
export function heldUrlKey(url: string): string {
  const key = withoutFragment(url);
  return key.length <= MAX_HELD_URL_CHARS ? key : `sha256:${sha256Hex(key)}`;
}

/**
 * The raw URLs of a stack's synchronous frames, innermost first, fragment
 * dropped, or null when Chromium sent no stack or an empty one. An async
 * parent is never followed: the scanner never raises the async stack depth,
 * so a live visit receives none.
 */
export function stackFrameUrls(stack: unknown): string[] | null {
  if (!isRecord(stack) || !Array.isArray(stack.callFrames) || stack.callFrames.length === 0) return null;
  return stack.callFrames
    .slice(0, MAX_STACK_FRAMES)
    .map((frame) => (isRecord(frame) && typeof frame.url === "string" ? withoutFragment(frame.url) : ""));
}

/**
 * The Script and Document addresses one visit requested, which alone name
 * frames. Each recorder owns its own set: Inspect's stops at its evidence
 * boundary, a check's keeps growing through its scroll window, and no two
 * recorders may ever share one.
 */
export class RequestedCodeUrls {
  private readonly keys = new Set<string>();
  private full = false;

  /**
   * Whether an address arrived past the bound: from then on a frame's script
   * may be one the visit requested and this set no longer holds, so a
   * recorder names nothing.
   */
  get overflowed(): boolean {
    return this.full;
  }

  note(key: string): void {
    if (this.keys.has(key)) return;
    if (this.keys.size >= MAX_REQUESTED_CODE_URLS) {
      this.full = true;
      return;
    }
    this.keys.add(key);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }
}

/** One observation, as a stack recorder reads it. */
export type ObservedRequest = {
  params: Record<string, unknown>;
  rawUrl: string;
  /** The raw URL's held key (heldUrlKey). */
  key: string;
  initiator: Record<string, unknown> | null;
  /** A script's or a document's request, whose address names frames. */
  code: boolean;
};

/**
 * One `Network.requestWillBeSent` payload, or null for one that names no
 * request and for a CORS preflight, the browser's own request, which the
 * page never reports and so has no request of the page's to join.
 */
export function observedRequest(params: unknown): ObservedRequest | null {
  if (!isRecord(params) || !isRecord(params.request)) return null;
  const rawUrl = params.request.url;
  if (typeof rawUrl !== "string" || !rawUrl) return null;
  const initiator = isRecord(params.initiator) ? params.initiator : null;
  if (initiator?.type === "preflight") return null;
  const key = heldUrlKey(rawUrl);
  // Every script and document address the visit requested names frames, a
  // redirect's next address included, since a script runs under the address
  // its response finally came from.
  return { params, rawUrl, key, initiator, code: params.type === "Script" || params.type === "Document" };
}

/**
 * How one observation is broken down, against the recorder's own requested
 * addresses as they stand when it arrives. A group's stack is kept in the
 * recorder's own map under the key `keyOf` gives it.
 */
export function categorizeObservation(
  observed: ObservedRequest,
  code: RequestedCodeUrls,
  stacks: Map<string, PublishedStack>,
  keyOf: (stack: PublishedStack) => string,
  publishing: StackPublishing = INSPECTION_PUBLISHING
): StackObservationCategory {
  // A redirect hop carries the initiator of the request that started the
  // chain, which asked for another address.
  if (isRecord(observed.params.redirectResponse)) return "redirected";
  const frames = stackFrameUrls(observed.initiator?.stack);
  if (frames === null) return "withoutStack";
  // Past this bound a frame's script may be one the visit requested and
  // the recorder no longer holds, so nothing is named from here on.
  if (code.overflowed) return "notListed";
  const published = publishedStack(frames, code, publishing);
  if (published === null) return "withoutNamedScript";
  const key = keyOf(published);
  if (!stacks.has(key)) stacks.set(key, published);
  return { group: key };
}

/**
 * The hosts and scripts a stack publishes: frames whose URL the visit
 * requested as a script or document, innermost first, until a fifth host.
 */
export function publishedStack(
  frames: string[],
  code: RequestedCodeUrls,
  publishing: StackPublishing = INSPECTION_PUBLISHING
): PublishedStack | null {
  const hosts: string[] = [];
  const namedScripts: string[] = [];
  for (const frameUrl of frames) {
    if (!frameUrl) continue;
    const key = heldUrlKey(frameUrl);
    if (!code.has(key)) continue;
    const host = cachedPublishedHost(frameUrl, key, publishing.hostCache);
    if (hosts.at(-1) !== host) {
      if (hosts.length === MAX_INSPECTION_GROUP_HOSTS) break;
      hosts.push(host);
    }
    if (!publishing.scripts) continue;
    const script = publishedScript(frameUrl);
    if (script !== null && !namedScripts.includes(script) && namedScripts.length < MAX_INSPECTION_GROUP_SCRIPTS) {
      namedScripts.push(script);
    }
  }
  return hosts.length === 0 ? null : { hosts, namedScripts };
}

/** What a recorder's joined requests come to: a count per group key, and every other count. */
export class StackTally {
  readonly groupCounts = new Map<string, number>();
  redirected = 0;
  withoutStack = 0;
  withoutNamedScript = 0;
  notListed = 0;
  unobserved = 0;

  add(category: StackObservationCategory): void {
    if (category === "redirected") this.redirected += 1;
    else if (category === "withoutStack") this.withoutStack += 1;
    else if (category === "withoutNamedScript") this.withoutNamedScript += 1;
    else if (category === "notListed") this.notListed += 1;
    else this.groupCounts.set(category.group, (this.groupCounts.get(category.group) ?? 0) + 1);
  }

  /** Groups by count, largest first, then by key, each with the stack the recorder kept for it. */
  rankedGroups(stacks: ReadonlyMap<string, PublishedStack>): Array<{ count: number; stack: PublishedStack }> {
    return [...this.groupCounts.entries()]
      .sort(([leftKey, leftCount], [rightKey, rightCount]) =>
        rightCount - leftCount || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0)
      )
      .map(([key, count]) => {
        const stack = stacks.get(key);
        if (!stack) throw new Error("A call-stack group lost its published stack.");
        return { count, stack };
      });
  }
}

/**
 * Join one URL's page requests, in arrival order, to the session's
 * observations of that URL, in arrival order: the n-th request takes the
 * n-th observation, and observations beyond the page's own count join
 * nothing. Of the requests left over, as many as the recorder's bound
 * dropped observations of are not listed, and the rest the session never
 * observed. Only the requests `counted` names are broken down; the others
 * still take their observations, so a request the recorder does not count
 * never hands its stack to a later one.
 *
 * Arrival order pairs the two streams only while they hold the same
 * requests. When the URL has more requests than the session observed, some
 * came from where the page's session cannot see, a dedicated worker, and
 * nothing says which: a worker's request can arrive first and take a page
 * request's observation. If every request is broken down, that cannot change
 * a count. If only some are, a counted request could take an uncounted one's
 * stack, so none of the URL's counted requests takes any, and each is
 * unobserved.
 */
export function joinObservations(
  tally: StackTally,
  pageRequests: number,
  observations: readonly StackObservationCategory[],
  observationsDropped: number,
  counted: (index: number) => boolean = () => true
): void {
  const joined = Math.min(pageRequests, observations.length);
  const dropped = Math.min(pageRequests - joined, observationsDropped);
  if (pageRequests > joined + dropped) {
    let countedRequests = 0;
    for (let index = 0; index < pageRequests; index += 1) if (counted(index)) countedRequests += 1;
    if (countedRequests > 0 && countedRequests < pageRequests) {
      tally.unobserved += countedRequests;
      return;
    }
  }
  for (let index = 0; index < pageRequests; index += 1) {
    if (!counted(index)) continue;
    if (index < joined) tally.add(observations[index]);
    else if (index < joined + dropped) tally.notListed += 1;
    else tally.unobserved += 1;
  }
}

/** A frame's host, through the report's own hostname redaction. */
export function publishedHost(frameUrl: string): string {
  let hostname: string;
  try {
    hostname = new URL(frameUrl).hostname;
  } catch {
    return redactHostnameV2("").value;
  }
  return redactHostnameV2(hostname).value;
}

function cachedPublishedHost(frameUrl: string, key: string, cache: Map<string, string> | undefined): string {
  if (!cache) return publishedHost(frameUrl);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const host = publishedHost(frameUrl);
  // Only requested script and document addresses reach here, so the cache is
  // bounded by the same count the recorder's requested set is.
  if (cache.size < MAX_REQUESTED_CODE_URLS) cache.set(key, host);
  return host;
}

/** A frame's script address as a report would publish it, query dropped, or null for none. */
export function publishedScript(frameUrl: string): string | null {
  const published = redactUrlV2(frameUrl).value;
  return isPublishedAddressShape(published) ? published : null;
}
