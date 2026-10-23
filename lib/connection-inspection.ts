import { isPublishedAddressShape } from "./connection-inspection-address";
import {
  isConnectionInspectionEvidence,
  MAX_INSPECTION_GROUPS,
  MAX_INSPECTION_GROUP_HOSTS,
  MAX_INSPECTION_GROUP_SCRIPTS,
  type ConnectionInspectionEvidence,
  type ConnectionInspectionGroup
} from "./connection-inspection-evidence";
import { isRecord } from "./guards";
import { redactHostnameV2, redactUrlV2 } from "./redaction-v2";
import { sha256Hex } from "./sha256";

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
 * WHAT IT COUNTS.
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
/** Distinct Script and Document request URLs kept for naming frames. */
export const MAX_INSPECTION_CODE_URLS = 4_000;
/** Frames read from one stack, innermost first (Chromium's own cap is about this). */
export const MAX_INSPECTION_STACK_FRAMES = 200;
/** Raw URLs whose published-address comparison is cached. */
const MAX_MATCH_CACHE_ENTRIES = 8_000;
/**
 * A raw URL longer than this is held by its digest, never as itself, so the
 * tables above stay small however long the page makes its URLs (up to the
 * 16,384 characters the redaction pass reads), and a long one is still
 * joined and still names its frames.
 */
const MAX_HELD_URL_CHARS = 2_048;

/**
 * The authoritative check on an inspected address: the shape a published
 * address has, and a fixed point of the redaction pass, so it is exactly an
 * address a report could publish. The scan gate refuses any other value.
 */
export function isInspectableAddress(value: unknown): value is string {
  return typeof value === "string" && isPublishedAddressShape(value) && redactUrlV2(value).value === value;
}

type ObservationCategory =
  | "redirected"
  | "withoutStack"
  | "withoutNamedScript"
  | "notListed"
  | { group: string };

type TrackedRequestUrl = {
  pageRequests: number;
  observations: ObservationCategory[];
  observationsDropped: number;
};

type PublishedStack = Pick<ConnectionInspectionGroup, "hosts" | "namedScripts">;

function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * The key a raw URL is joined and matched by: the URL itself with its
 * fragment dropped, or that URL's digest when it is long. Two URLs share a
 * key exactly when they are the same URL.
 */
function heldUrlKey(url: string): string {
  const key = withoutFragment(url);
  return key.length <= MAX_HELD_URL_CHARS ? key : `sha256:${sha256Hex(key)}`;
}

/**
 * The raw URLs of a stack's synchronous frames, innermost first, fragment
 * dropped, or null when Chromium sent no stack or an empty one. An async
 * parent is never followed: the scanner never raises the async stack depth,
 * so a live visit receives none.
 */
function stackFrameUrls(stack: unknown): string[] | null {
  if (!isRecord(stack) || !Array.isArray(stack.callFrames) || stack.callFrames.length === 0) return null;
  return stack.callFrames
    .slice(0, MAX_INSPECTION_STACK_FRAMES)
    .map((frame) => (isRecord(frame) && typeof frame.url === "string" ? withoutFragment(frame.url) : ""));
}

export class ConnectionInspectionRecorder {
  readonly address: string;
  private frozen = false;
  private broken = false;
  private matched = 0;
  private untrackedPageRequests = 0;
  private keptObservations = 0;
  private codeUrlsOverflowed = false;
  private readonly tracked = new Map<string, TrackedRequestUrl>();
  private readonly codeUrls = new Set<string>();
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
    const groupCounts = new Map<string, number>();
    let redirected = 0;
    let withoutStack = 0;
    let withoutNamedScript = 0;
    let notListed = this.untrackedPageRequests;
    let unobserved = 0;
    for (const entry of this.tracked.values()) {
      const joined = Math.min(entry.pageRequests, entry.observations.length);
      for (const category of entry.observations.slice(0, joined)) {
        if (category === "redirected") redirected += 1;
        else if (category === "withoutStack") withoutStack += 1;
        else if (category === "withoutNamedScript") withoutNamedScript += 1;
        else if (category === "notListed") notListed += 1;
        else groupCounts.set(category.group, (groupCounts.get(category.group) ?? 0) + 1);
      }
      const missing = entry.pageRequests - joined;
      const dropped = Math.min(missing, entry.observationsDropped);
      notListed += dropped;
      unobserved += missing - dropped;
    }
    const ranked = [...groupCounts.entries()]
      .sort(([leftKey, leftCount], [rightKey, rightCount]) =>
        rightCount - leftCount || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0)
      )
      .map(([key, count]) => {
        const stack = this.stacks.get(key);
        if (!stack) throw new Error("An inspection group lost its published stack.");
        return { count, hosts: [...stack.hosts], namedScripts: [...stack.namedScripts] };
      });
    for (const group of ranked.slice(MAX_INSPECTION_GROUPS)) notListed += group.count;
    return {
      address: this.address,
      matched: this.matched,
      groups: ranked.slice(0, MAX_INSPECTION_GROUPS),
      redirected,
      withoutStack,
      withoutNamedScript,
      notListed,
      unobserved
    };
  }

  private observeUnchecked(params: unknown): void {
    if (!isRecord(params) || !isRecord(params.request)) return;
    const rawUrl = params.request.url;
    if (typeof rawUrl !== "string" || !rawUrl) return;
    const initiator = isRecord(params.initiator) ? params.initiator : null;
    // A CORS preflight is the browser's own request, which the page never
    // reports, so it has no request of the page's to join.
    if (initiator?.type === "preflight") return;
    const key = heldUrlKey(rawUrl);
    // Every script and document address the visit requested names frames,
    // a redirect's next address included, since a script runs under the
    // address its response finally came from.
    if (params.type === "Script" || params.type === "Document") this.noteCodeUrl(key);
    if (!this.matches(rawUrl)) return;
    const entry = this.trackedEntry(key);
    // An untracked URL's page requests are counted as not listed.
    if (!entry) return;
    if (this.keptObservations >= MAX_INSPECTION_OBSERVATIONS) {
      entry.observationsDropped += 1;
      return;
    }
    this.keptObservations += 1;
    entry.observations.push(this.categorize(params, initiator));
  }

  private categorize(params: Record<string, unknown>, initiator: Record<string, unknown> | null): ObservationCategory {
    // A redirect hop carries the initiator of the request that started the
    // chain, which asked for another address.
    if (isRecord(params.redirectResponse)) return "redirected";
    const frames = stackFrameUrls(initiator?.stack);
    if (frames === null) return "withoutStack";
    // Past this bound a frame's script may be one the visit requested and
    // this recorder no longer holds, so nothing is named from here on.
    if (this.codeUrlsOverflowed) return "notListed";
    const published = this.publishedStack(frames);
    if (published === null) return "withoutNamedScript";
    const key = JSON.stringify([published.hosts, published.namedScripts]);
    if (!this.stacks.has(key)) this.stacks.set(key, published);
    return { group: key };
  }

  /**
   * The hosts and scripts a stack publishes: frames whose URL the visit
   * requested as a script or document, innermost first, until a fifth host.
   */
  private publishedStack(frames: string[]): PublishedStack | null {
    const hosts: string[] = [];
    const namedScripts: string[] = [];
    for (const frameUrl of frames) {
      if (!frameUrl || !this.codeUrls.has(heldUrlKey(frameUrl))) continue;
      const host = publishedHost(frameUrl);
      if (hosts.at(-1) !== host) {
        if (hosts.length === MAX_INSPECTION_GROUP_HOSTS) break;
        hosts.push(host);
      }
      const script = publishedScript(frameUrl);
      if (script !== null && !namedScripts.includes(script) && namedScripts.length < MAX_INSPECTION_GROUP_SCRIPTS) {
        namedScripts.push(script);
      }
    }
    return hosts.length === 0 ? null : { hosts, namedScripts };
  }

  private noteCodeUrl(key: string): void {
    if (this.codeUrls.has(key)) return;
    if (this.codeUrls.size >= MAX_INSPECTION_CODE_URLS) {
      this.codeUrlsOverflowed = true;
      return;
    }
    this.codeUrls.add(key);
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

/** A frame's host, through the report's own hostname redaction. */
function publishedHost(frameUrl: string): string {
  let hostname: string;
  try {
    hostname = new URL(frameUrl).hostname;
  } catch {
    return redactHostnameV2("").value;
  }
  return redactHostnameV2(hostname).value;
}

/** A frame's script address as a report would publish it, query dropped, or null for none. */
function publishedScript(frameUrl: string): string | null {
  const published = redactUrlV2(frameUrl).value;
  return isPublishedAddressShape(published) ? published : null;
}
