import {
  categorizeObservation,
  heldUrlKey,
  joinObservations,
  MAX_HELD_URL_CHARS,
  MAX_REQUESTED_CODE_URLS,
  MAX_STACK_FRAMES,
  observedRequest,
  RequestedCodeUrls,
  StackTally,
  type PublishedStack,
  type StackObservationCategory
} from "./call-stack-publisher";
import { isPublishedAddressShape } from "./connection-inspection-address";
import {
  isConnectionInspectionEvidence,
  MAX_INSPECTION_GROUPS,
  type ConnectionInspectionEvidence
} from "./connection-inspection-evidence";
import { redactUrlV2 } from "./redaction-v2";

/**
 * The server half of "Inspect this connection": a visit that keeps, in memory
 * and only when asked, the synchronous call-stack script URLs of the requests
 * to one published address, and turns them into the public evidence in
 * lib/connection-inspection-evidence.ts. Raw URLs, stacks and names never
 * leave this module: the evidence holds counts, published hosts and
 * published addresses only.
 *
 * PASSIVE BY CONSTRUCTION. The scanner feeds this from what it already
 * receives: the `Network.requestWillBeSent` events of the CDP session it opens
 * for request attribution (lib/request-initiator.ts), which carry Chromium's
 * synchronous initiator stack with no Debugger domain and no async stacks, and
 * the page's own request events it already counts. No session, command,
 * domain or browser behavior is added, and a visit that is not an inspection
 * keeps nothing new.
 *
 * WHAT IT COUNTS. Everything a stack names, and how the page's requests are
 * joined to the session's observations, is the one stack publisher's
 * (lib/call-stack-publisher.ts), which a check after scrolling shares. Here:
 *
 * - `matched` counts the page's own request events whose published address,
 *   query dropped, equals the inspected one. A dedicated worker's requests are
 *   among them: the page reports them, while the page's CDP session never
 *   observes them, so a worker-only connection does not read as one the visit
 *   never made.
 * - The session's observations of the same raw URLs (fragment dropped) are
 *   joined to those requests per URL, at most as many as the page reported,
 *   in arrival order. The rest of the page's requests are `unobserved`.
 *   CORS preflights are the browser's own requests, which the page never
 *   reports, so they are left out.
 * - A redirect hop carries the stack of the request that started the chain,
 *   so hops are counted apart and name no script.
 * - A request with no stack is counted apart. That is not evidence that no
 *   script was involved: Chromium 153 reports an image a script created, by
 *   `new Image()`, an appended element, a timer or another site's tag, as the
 *   parser's, with the document's URL and no stack, exactly as it reports an
 *   image in the HTML (lib/connection-inspection-fixture.test.ts pins it).
 * - A frame names its script only when the frame's URL equals a Script or
 *   Document request this session had observed by then, which a real script
 *   always is, since it was requested before it ran. A name a script gave
 *   itself with a sourceURL comment counts only when it equals such an
 *   address. Hosts are published through the report's hostname redaction and
 *   scripts through its URL redaction, query dropped.
 * - Every structure is bounded; a request the bounds keep from being broken
 *   down is counted in `notListed`, never dropped or moved to another count.
 *   A long raw URL is held by its digest, so it is still joined and still
 *   names its frames without the tables holding page-sized strings.
 */

/** Distinct raw URLs of matched requests tracked for the per-URL join. */
export const MAX_INSPECTION_TRACKED_URLS = 2_000;
/** Session observations of matched requests kept, across all URLs. */
export const MAX_INSPECTION_OBSERVATIONS = 2_000;
/** Distinct Script and Document request URLs kept for naming frames (the publisher's bound). */
export const MAX_INSPECTION_CODE_URLS = MAX_REQUESTED_CODE_URLS;
/** Frames read from one stack, innermost first (the publisher's bound). */
export const MAX_INSPECTION_STACK_FRAMES = MAX_STACK_FRAMES;
/** Raw URLs whose published-address comparison is cached. */
const MAX_MATCH_CACHE_ENTRIES = 8_000;

/**
 * The authoritative check on an inspected address: the shape a published
 * address has, and a fixed point of the redaction pass, so it is exactly an
 * address a report could publish. The scan gate refuses any other value.
 */
export function isInspectableAddress(value: unknown): value is string {
  return typeof value === "string" && isPublishedAddressShape(value) && redactUrlV2(value).value === value;
}

type TrackedRequestUrl = {
  pageRequests: number;
  observations: StackObservationCategory[];
  observationsDropped: number;
};

/** An inspection's groups are keyed by everything they publish: hosts and named scripts. */
function inspectionStackKey(stack: PublishedStack): string {
  return JSON.stringify([stack.hosts, stack.namedScripts]);
}

export class ConnectionInspectionRecorder {
  readonly address: string;
  private frozen = false;
  private broken = false;
  private matched = 0;
  private untrackedPageRequests = 0;
  private keptObservations = 0;
  private readonly tracked = new Map<string, TrackedRequestUrl>();
  private readonly codeUrls = new RequestedCodeUrls();
  private readonly stacks = new Map<string, PublishedStack>();
  private readonly matchCache = new Map<string, boolean>();

  constructor(address: string) {
    if (!isInspectableAddress(address)) {
      throw new TypeError("An inspected address must be a published address with no query.");
    }
    this.address = address;
  }

  /**
   * One request the page reported (Playwright's page "request" event), from
   * before the visit navigates until the evidence boundary.
   */
  notePageRequest(url: string): void {
    if (this.frozen || this.broken) return;
    try {
      if (!this.matches(url)) return;
      this.matched += 1;
      const entry = this.trackedEntry(heldUrlKey(url));
      if (entry) entry.pageRequests += 1;
      else this.untrackedPageRequests += 1;
    } catch {
      this.broken = true;
    }
  }

  /** One `Network.requestWillBeSent` payload from the page's own CDP session. */
  observe(params: unknown): void {
    if (this.frozen || this.broken) return;
    try {
      this.observeUnchecked(params);
    } catch {
      this.broken = true;
    }
  }

  /** Stop recording: the visit's evidence boundary, where its request count retires. */
  freeze(): void {
    this.frozen = true;
  }

  /**
   * The public evidence, or null when recording itself failed, in which case
   * the immediate result carries no inspection rather than wrong counts. It
   * never throws and never hands out a shape the readers' validator refuses,
   * so an inspection can cost the visit its panel, never its report.
   */
  evidence(): ConnectionInspectionEvidence | null {
    this.freeze();
    if (this.broken) return null;
    try {
      const evidence = this.buildEvidence();
      return isConnectionInspectionEvidence(evidence) ? evidence : null;
    } catch {
      return null;
    }
  }

  private buildEvidence(): ConnectionInspectionEvidence {
    const tally = new StackTally();
    tally.notListed = this.untrackedPageRequests;
    for (const entry of this.tracked.values()) {
      joinObservations(tally, entry.pageRequests, entry.observations, entry.observationsDropped);
    }
    const ranked = tally.rankedGroups(this.stacks).map(({ count, stack }) => ({
      count,
      hosts: [...stack.hosts],
      namedScripts: [...stack.namedScripts]
    }));
    let notListed = tally.notListed;
    for (const group of ranked.slice(MAX_INSPECTION_GROUPS)) notListed += group.count;
    return {
      address: this.address,
      matched: this.matched,
      groups: ranked.slice(0, MAX_INSPECTION_GROUPS),
      redirected: tally.redirected,
      withoutStack: tally.withoutStack,
      withoutNamedScript: tally.withoutNamedScript,
      notListed,
      unobserved: tally.unobserved
    };
  }

  private observeUnchecked(params: unknown): void {
    const observed = observedRequest(params);
    if (observed === null) return;
    if (observed.code) this.codeUrls.note(observed.key);
    if (!this.matches(observed.rawUrl)) return;
    const entry = this.trackedEntry(observed.key);
    // An untracked URL's page requests are counted as not listed.
    if (!entry) return;
    if (this.keptObservations >= MAX_INSPECTION_OBSERVATIONS) {
      entry.observationsDropped += 1;
      return;
    }
    this.keptObservations += 1;
    entry.observations.push(categorizeObservation(observed, this.codeUrls, this.stacks, inspectionStackKey));
  }

  private trackedEntry(key: string): TrackedRequestUrl | null {
    const existing = this.tracked.get(key);
    if (existing) return existing;
    if (this.tracked.size >= MAX_INSPECTION_TRACKED_URLS) return null;
    const created: TrackedRequestUrl = { pageRequests: 0, observations: [], observationsDropped: 0 };
    this.tracked.set(key, created);
    return created;
  }

  private matches(rawUrl: string): boolean {
    const cached = this.matchCache.get(rawUrl);
    if (cached !== undefined) return cached;
    const matched = redactUrlV2(rawUrl).value === this.address;
    // Only short URLs are cached, so the cache holds no page-sized strings.
    if (rawUrl.length <= MAX_HELD_URL_CHARS && this.matchCache.size < MAX_MATCH_CACHE_ENTRIES) {
      this.matchCache.set(rawUrl, matched);
    }
    return matched;
  }
}
