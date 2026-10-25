import { analyticsBeaconFormat, type AnalyticsBeaconBody } from "./analytics-events";
import { isThirdParty, partyKey } from "./domain-utils";
import { redactHostnameV2 } from "./redaction-v2";
import { scrollCheckWindowEvents, type ScrollCheckEventRequest } from "./scroll-check-events";
import {
  isScrollCheckEvidence,
  MAX_SCROLL_CHECK_LISTED_HOSTS,
  MAX_SCROLL_CHECK_SCREENS,
  SCROLL_CHECK_INCOMPLETE_REASONS,
  type ScrollCheckEvidence,
  type ScrollCheckIncompleteReason,
  type ScrollCheckOutcome,
  type ScrollCheckScrollWindow,
  type ScrollCheckWindow,
  type ScrollCheckWindowEvents
} from "./scroll-check-evidence";
import type { ScrollCheckListedRequests, ScrollCheckStackRecorder, ScrollCheckStackRequest } from "./scroll-check-stacks";

/**
 * The server half of "Check after scrolling" (build brief approved
 * 2026-10-23): after an ordinary single scan has built its whole result, the
 * same open page is left to settle, watched for 10 seconds with no input, then
 * scrolled by script for 10 seconds, and the third-party hosts it first
 * contacted in each window are published through the report's own hostname
 * redaction. Raw hostnames and times never leave this module.
 *
 * THE INVARIANT. The check acts only after the visit's envelope is built
 * (lib/scanner.ts), so nothing here can reach the ordinary result. Before
 * that the recorder below is a passive listener on the page's request
 * events: it keeps hostnames and times in memory, never throws into the
 * visit, and asks the browser for nothing.
 *
 * THE FIRST-CONTACT RULE, in the report's own terms:
 * - third party: isThirdParty(<the report's first-party hostname>, host);
 * - already contacted: the page asked for the raw hostname before the
 *   window, from navigation start on, whether or not the scanner let that
 *   request through;
 * - first contacted in a window: the page's first request to the host started
 *   inside the window and the scanner sent it. A first request the scanner
 *   refused is not listed and marks the result incomplete.
 * Raw hostnames are compared; a host is published as the report publishes a
 * request log's host, and grouped by site (partyKey).
 *
 * CALL STACKS (build brief 2026-10-24). With a stack recorder
 * (lib/scroll-check-stacks.ts), each host the scroll window lists also gets
 * the call-stack hosts of the requests this recorder counted for it. Which
 * requests those are is decided here alone, by the rule above and this
 * recorder's clock; the stack recorder only joins the session's observations
 * to them.
 *
 * ANALYTICS EVENTS (build brief 2026-10-25). With a body reader in its facts
 * (the scanner's own bounded helper), each window also carries the GA4 and
 * Adobe Analytics events its page sent (lib/scroll-check-events.ts). Which
 * requests count is decided here, by the same window and decision rules: a
 * request that started inside the window, that the scanner sent, that is
 * neither the page's own navigation nor a redirect hop, and whose address is
 * in a decoded format, the site's own hosts included. A body is read only for
 * those, when the check builds its evidence, and never kept.
 *
 * ANSWERS (build brief 2026-10-25, part A). A request counts only once its
 * host answered: a Playwright `response` arrived for it, at any status, and a
 * failure after that does not undo it. The scanner feeds this recorder its
 * page's `response` and `requestfailed` events from the moment the check
 * begins (runScrollCheckPhase, lib/scanner.ts), after the envelope, so no
 * listener added for this exists during the ordinary visit. A host is listed
 * when its first request started in the window and the scanner sent it, and
 * one of its requests in that window was answered; the lists, the request
 * counts, the call-stack join and the analytics events count answered
 * requests only. Each window counts, in `unanswered`, the requests it would
 * otherwise have counted that got no answer before the evidence was built.
 * After its windows, the check waits, within its existing settle, for an
 * answer or a failure for every request the scanner sent in them. A failure's
 * error text is never read.
 */

/** The check's fixed parameters (the measurement's, 2026-10-23). */
export type ScrollCheckTiming = {
  /** The check waits until this long after the navigation began. */
  settleAfterNavigationMs: number;
  /** The window with no input. */
  controlWindowMs: number;
  /** The scroll window, padded to this length whatever the scroll does. */
  scrollWindowMs: number;
  /** The dwell after each step. */
  stepDwellMs: number;
  /** The dwell at the deepest point, before the jump back to the top. */
  deepestDwellMs: number;
  /** The whole check phase, settle included, from the moment it begins. */
  phaseDeadlineMs: number;
};

export const SCROLL_CHECK_TIMING: Readonly<ScrollCheckTiming> = Object.freeze({
  settleAfterNavigationMs: 25_000,
  controlWindowMs: 10_500,
  scrollWindowMs: 10_500,
  stepDwellMs: 1_000,
  deepestDwellMs: 2_000,
  phaseDeadlineMs: 45_000
});

/**
 * Routed requests the check may make once the visit's envelope is built
 * (owner call 5). The visit's own 1,000-request budget is never touched
 * after that point; the proxy's per-visit traffic and byte budgets stay
 * shared.
 */
export const SCROLL_CHECK_REQUEST_ALLOWANCE = 500;
/** Distinct hostnames the recorder keeps, from navigation start. */
export const MAX_SCROLL_CHECK_HOSTS = 5_000;
/** Requests started inside the windows the recorder keeps. */
export const MAX_SCROLL_CHECK_WINDOW_REQUESTS = 5_000;
/** The window's bottom counts as the page's end within this many pixels. */
export const SCROLL_CHECK_END_SLACK_PX = 2;
/**
 * The longest the check waits, after its windows, for the scanner's routing
 * decisions and then for an answer or a failure for each request the scanner
 * sent in them: one bound for both (owner call 1, 2026-10-25).
 */
export const SCROLL_CHECK_ROUTE_SETTLE_MS = 5_000;
/**
 * The deadline never falls before the fixed sequence's own end plus this
 * margin. The sequence is anchored to the navigation's start (it ends 46 s
 * after it at the production timing), the 45 s budget to the moment the
 * check began, so a single scan that ended within about a second of its
 * navigation would otherwise have its last scroll moments cut by its own
 * budget. The budget still bounds a page that stops answering.
 */
export const SCROLL_CHECK_DEADLINE_MARGIN_MS = 2_000;
/**
 * How long before the scroll window opens a check's call-stack recorder
 * (lib/scroll-check-stacks.ts) starts keeping the session's observations.
 * The session's observation of a request usually arrives a few milliseconds
 * before the page's own event for it, which is what decides the window, so
 * keeping from the window's opening alone would lose the observations of
 * requests made at that moment.
 */
export const SCROLL_CHECK_STACK_LEAD_MS = 1_000;

/**
 * When the check stops, whatever it is doing: its 45 s budget from the moment
 * it began, but never before its fixed sequence, run on time from that
 * moment, has ended (SCROLL_CHECK_DEADLINE_MARGIN_MS).
 */
export function scrollCheckDeadline(timing: ScrollCheckTiming, navigationStartedAt: number, startedAt: number): number {
  const controlStart = Math.max(startedAt, navigationStartedAt + timing.settleAfterNavigationMs);
  const sequenceEnd = controlStart + timing.controlWindowMs + timing.scrollWindowMs;
  return Math.max(startedAt + timing.phaseDeadlineMs, sequenceEnd + SCROLL_CHECK_DEADLINE_MARGIN_MS);
}

/** A timing the check can run: the scroll window holds every step and the deepest dwell. */
export function isRunnableScrollCheckTiming(timing: ScrollCheckTiming): boolean {
  const values = Object.values(timing);
  return (
    values.every((value) => Number.isSafeInteger(value) && value > 0) &&
    timing.scrollWindowMs >= MAX_SCROLL_CHECK_SCREENS * timing.stepDwellMs + timing.deepestDwellMs
  );
}

/** The scanner's decision on one routed request, as the page route made it. */
export type ScrollCheckRouteDecision = "sent" | "refused" | "allowance";

type WindowKind = "control" | "scroll";

/** A window on the recorder's clock: requests that started at or after `start` and before `end`. */
type Interval = { start: number; end: number };

type WindowEntry<RequestT> = {
  request: RequestT;
  host: string;
  at: number;
  /** A main-frame navigation: the page's own document, never a host it contacted. */
  navigation: boolean;
  /** A redirect hop, which the page route never sees: it follows a request the scanner sent. */
  redirected: boolean;
};

export type ScrollCheckRequestFacts<RequestT> = {
  url(request: RequestT): string;
  redirected(request: RequestT): boolean;
  mainFrameNavigation(request: RequestT): boolean;
  /**
   * The request's body, through the scanner's own bounded helper
   * (safeRequestPostDataWithCoverage, lib/scanner.ts). Called only for a
   * request in a decoded analytics format, when the check builds its
   * evidence. Without it, the check decodes no analytics events.
   */
  postData?(request: RequestT): AnalyticsBeaconBody;
};

/** Each window's requests that count for its analytics events, null for a window that did not run. */
export type ScrollCheckEventRequests = {
  control: ScrollCheckEventRequest[] | null;
  scroll: ScrollCheckEventRequest[] | null;
};

/**
 * The visit's whole host history, from before navigation to the end of the
 * check: every request the page asked for, refused ones included. Passive:
 * it reads only the request objects the page's own events hand it.
 */
export class ScrollCheckRecorder<RequestT extends object> {
  private readonly firstSeen = new Map<string, number>();
  private readonly firstEntries = new Map<string, WindowEntry<RequestT>>();
  private readonly entries: WindowEntry<RequestT>[] = [];
  private readonly decisions = new WeakMap<RequestT, ScrollCheckRouteDecision>();
  /** Requests a response arrived for, at any status: the host answered. */
  private readonly answered = new WeakSet<RequestT>();
  /** Requests that failed. Kept only to end the settle's wait early, since a failure is final. */
  private readonly failed = new WeakSet<RequestT>();
  /** When each request recorded in a window started. */
  private readonly entryAt = new WeakMap<RequestT, number>();
  /** While the settle waits: its windows, the sent requests in them with neither, and what to call once none is left. */
  private waiting: { intervals: ReadonlyArray<Interval>; requests: Set<RequestT>; settled: () => void } | null = null;
  private window: WindowKind | null = null;
  private frozen = false;
  private boundReached = false;

  constructor(
    private readonly facts: ScrollCheckRequestFacts<RequestT>,
    private readonly now: () => number = Date.now,
    private readonly maxHosts = MAX_SCROLL_CHECK_HOSTS,
    private readonly maxWindowRequests = MAX_SCROLL_CHECK_WINDOW_REQUESTS
  ) {}

  /** One request the page asked for (Playwright's page "request" event). */
  readonly noteRequest = (request: RequestT): void => {
    if (this.frozen) return;
    try {
      const host = requestHostname(this.facts.url(request));
      if (host === null) return;
      const at = this.now();
      let first = false;
      if (!this.firstSeen.has(host)) {
        if (this.firstSeen.size >= this.maxHosts) {
          this.boundReached = true;
        } else {
          this.firstSeen.set(host, at);
          first = true;
        }
      }
      if (this.window === null) return;
      if (this.entries.length >= this.maxWindowRequests) {
        this.boundReached = true;
        return;
      }
      const entry: WindowEntry<RequestT> = {
        request,
        host,
        at,
        navigation: this.facts.mainFrameNavigation(request),
        redirected: this.facts.redirected(request)
      };
      this.entries.push(entry);
      this.entryAt.set(request, at);
      if (first) this.firstEntries.set(host, entry);
    } catch {
      // A request this recorder could not read is a request it lost.
      this.boundReached = true;
    }
  };

  /**
   * The page route's decision on one request, fed from the scanner's own
   * route handler. Taken after the freeze too: a request that started inside
   * a window can be decided while the check settles its routes.
   */
  noteRouted(request: RequestT, decision: ScrollCheckRouteDecision): void {
    this.decisions.set(request, decision);
    // A route decided while the settle waits for answers is waited for too.
    const waiting = this.waiting;
    if (decision === "sent" && waiting !== null && this.awaitable(request, waiting.intervals)) waiting.requests.add(request);
  }

  /**
   * A response arrived for one request (the page's "response" event), at any
   * status. Taken after the freeze too: a request that started inside a
   * window can be answered while the check settles.
   */
  readonly noteAnswered = (request: RequestT): void => {
    try {
      this.answered.add(request);
      this.settle(request);
    } catch {
      // A request this recorder could not note stays unanswered.
    }
  };

  /**
   * One request failed (the page's "requestfailed" event). It only ends the
   * settle's wait for that request early: a failure after a response does
   * not undo the answer, and a failure's error text is never read.
   */
  readonly noteFailed = (request: RequestT): void => {
    try {
      this.failed.add(request);
      this.settle(request);
    } catch {
      // Nothing to undo: the request is simply still waited for.
    }
  };

  /**
   * Calls `settled` once every request the scanner sent that started inside
   * one of these windows (a redirect hop counts as sent) has an answer or a
   * failure: at once when none is waiting. Returns a function that stops the
   * wait. Only one wait is held at a time.
   */
  whenAnswered(intervals: ReadonlyArray<Interval>, settled: () => void): () => void {
    const requests = new Set<RequestT>();
    for (const entry of this.entries) {
      const sent = entry.redirected || this.decisions.get(entry.request) === "sent";
      if (sent && this.awaitable(entry.request, intervals)) requests.add(entry.request);
    }
    if (requests.size === 0) {
      this.waiting = null;
      settled();
      return () => undefined;
    }
    const waiting = { intervals, requests, settled };
    this.waiting = waiting;
    return () => {
      if (this.waiting === waiting) this.waiting = null;
    };
  }

  /** A request that started inside one of these windows and has neither an answer nor a failure. */
  private awaitable(request: RequestT, intervals: ReadonlyArray<Interval>): boolean {
    if (this.answered.has(request) || this.failed.has(request)) return false;
    const at = this.entryAt.get(request);
    return at !== undefined && intervals.some((interval) => at >= interval.start && at < interval.end);
  }

  private settle(request: RequestT): void {
    const waiting = this.waiting;
    if (waiting === null || !waiting.requests.delete(request) || waiting.requests.size > 0) return;
    this.waiting = null;
    waiting.settled();
  }

  /** Requests from here on belong to this window, until the next one opens or the recorder freezes. */
  openWindow(kind: WindowKind): void {
    if (!this.frozen) this.window = kind;
  }

  /** Requests that start after this are not counted. */
  freeze(): void {
    this.frozen = true;
    this.window = null;
  }

  /**
   * The third-party lists of each window that ran to its end, and what cut
   * collection in them. With `scrollRequests`, also, for the call-stack join
   * (lib/scroll-check-stacks.ts), each host the scroll window lists, in its
   * listed order, with every request its raw hosts made in that window, in
   * arrival order, and whether the window counted it: decided here, by this
   * window's own rule and clock, and nowhere else. With a body reader in its
   * facts, also, for the analytics events (lib/scroll-check-events.ts), each
   * window's requests that count for them, in arrival order, by the same rule
   * and clock.
   *
   * A request counts only when the scanner sent it and its host answered it.
   * A host is listed when its first request started in the window and the
   * scanner sent it, and one of its requests in the window was answered,
   * which need not be the first: a failed first try followed by a good retry
   * still lists it.
   */
  windows(input: {
    firstPartyHostname: string;
    control: Interval | null;
    scroll: Interval | null;
    scrollRequests?: boolean;
  }): {
    control: ScrollCheckWindow | null;
    scroll: ScrollCheckScrollWindow | null;
    reasons: Set<ScrollCheckIncompleteReason>;
    scrollRequests?: ScrollCheckListedRequests[];
    events?: ScrollCheckEventRequests;
  } {
    const reasons = new Set<ScrollCheckIncompleteReason>();
    if (this.boundReached && (input.control || input.scroll)) reasons.add("host-bound");
    const facts = this.facts;
    const window = (interval: Interval, collect: boolean) => {
      // Each raw host first contacted here, in the order its first request
      // arrived: whether that first request was one the window could count
      // (sent, third party, not the page's own navigation), and whether one
      // of its requests here was counted.
      const firstContactedRaw = new Map<string, { firstSent: boolean; counted: boolean }>();
      // For the call-stack join: every request of each raw host here, counted
      // or not, in arrival order.
      const requestsOf = new Map<string, ScrollCheckStackRequest[]>();
      // For the analytics events: sent and answered, never the page's own
      // navigation or a redirect hop, in a decoded format, the site's own
      // hosts included.
      const eventRequests: ScrollCheckEventRequest[] = [];
      let requests = 0;
      let knownHostRequests = 0;
      let unanswered = 0;
      for (const entry of this.entries) {
        if (entry.at < interval.start || entry.at >= interval.end) continue;
        const decision = entry.redirected ? "sent" : this.decisions.get(entry.request) ?? null;
        if (decision === "allowance") reasons.add("check-allowance");
        else if (decision !== "sent") reasons.add("refused");
        const sent = decision === "sent";
        const answered = sent && this.answered.has(entry.request);
        const url = facts.url(entry.request);
        const beacon = facts.postData !== undefined && sent && !entry.navigation && !entry.redirected && analyticsBeaconFormat(url) !== null;
        if (beacon && answered) {
          const request = entry.request;
          eventRequests.push({ host: entry.host, url, body: () => facts.postData?.(request) ?? UNREAD_BODY });
        }
        // Counted but for the answer: sent, third party, not the navigation.
        const countable = sent && !entry.navigation && isThirdParty(input.firstPartyHostname, entry.host);
        // Each request the window would otherwise have counted, once.
        if (!answered && (countable || beacon)) unanswered += 1;
        const counted = countable && answered;
        if (collect) {
          const own = requestsOf.get(entry.host) ?? [];
          own.push({ url, counted });
          requestsOf.set(entry.host, own);
        }
        if (counted) requests += 1;
        const firstAt = this.firstSeen.get(entry.host);
        if (firstAt === undefined) continue;
        if (firstAt < interval.start) {
          if (counted) knownHostRequests += 1;
          continue;
        }
        let raw = firstContactedRaw.get(entry.host);
        if (raw === undefined) {
          // The host's very first request, if the window holds it.
          if (this.firstEntries.get(entry.host) !== entry) continue;
          raw = { firstSent: countable, counted: false };
          firstContactedRaw.set(entry.host, raw);
        }
        if (counted) raw.counted = true;
      }
      const firstContacted = new Map<string, Set<string>>();
      // The raw hosts each listed host stands for: those whose first request
      // here put it on the list, and no other.
      const rawHostsOf = new Map<string, Set<string>>();
      for (const [host, raw] of firstContactedRaw) {
        if (!raw.firstSent || !raw.counted) continue;
        const published = redactHostnameV2(host).value;
        const site = redactHostnameV2(partyKey(host)).value;
        const hosts = firstContacted.get(site) ?? new Set<string>();
        hosts.add(published);
        firstContacted.set(site, hosts);
        const raws = rawHostsOf.get(published) ?? new Set<string>();
        raws.add(host);
        rawHostsOf.set(published, raws);
      }
      const listed = listedHosts(firstContacted);
      // The join pairs requests per URL, and a URL names one raw host, whose
      // requests are listed in arrival order already.
      const listedRequests = collect
        ? listed.hosts
            .flatMap((group) => group.hosts)
            .map((host) => ({ host, requests: [...(rawHostsOf.get(host) ?? [])].flatMap((raw) => requestsOf.get(raw) ?? []) }))
        : null;
      // Carried only when above 0.
      const noAnswer = unanswered > 0 ? { unanswered } : {};
      return { listed, requests, knownHostRequests, noAnswer, listedRequests, eventRequests };
    };
    const controlRun = input.control ? window(input.control, false) : null;
    const scroll = input.scroll ? window(input.scroll, input.scrollRequests === true) : null;
    return {
      control: controlRun ? { ...controlRun.listed, requests: controlRun.requests, ...controlRun.noAnswer } : null,
      scroll: scroll ? { ...scroll.listed, requests: scroll.requests, knownHostRequests: scroll.knownHostRequests, ...scroll.noAnswer } : null,
      reasons,
      ...(scroll?.listedRequests ? { scrollRequests: scroll.listedRequests } : {}),
      ...(facts.postData !== undefined
        ? { events: { control: controlRun ? controlRun.eventRequests : null, scroll: scroll ? scroll.eventRequests : null } }
        : {})
    };
  }
}

/** What a body reader that could not answer stands for. */
const UNREAD_BODY: AnalyticsBeaconBody = Object.freeze({ value: null, truncated: false, unreadable: true });

/** The raw hostname of an http(s) request URL, or null for any other: how the check reads every request's host. */
export function requestHostname(url: string): string | null {
  if (!/^https?:/i.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : null;
  } catch {
    return null;
  }
}

/** Sites with the most hosts first, then by name; hosts in name order; at most twenty in all. */
function listedHosts(bySite: Map<string, Set<string>>): Pick<ScrollCheckWindow, "hosts" | "hostCount" | "siteCount"> {
  const sites = [...bySite.entries()]
    .map(([site, hosts]) => ({ site, hosts: [...hosts].sort(compareText) }))
    .sort((left, right) => right.hosts.length - left.hosts.length || compareText(left.site, right.site));
  const hosts: ScrollCheckWindow["hosts"] = [];
  let remaining = MAX_SCROLL_CHECK_LISTED_HOSTS;
  for (const entry of sites) {
    if (remaining === 0) break;
    const listed = entry.hosts.slice(0, remaining);
    remaining -= listed.length;
    hosts.push({ site: entry.site, hosts: listed });
  }
  return {
    hosts,
    hostCount: sites.reduce((sum, entry) => sum + entry.hosts.length, 0),
    siteCount: sites.length
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Where the page stands, from the bounded collector's captured accessors. */
export type ScrollState = {
  /** The scrolling element's scroll position. */
  top: number;
  /** The document's scroll height. */
  height: number;
  /** The window's height. */
  viewport: number;
  /** The root or the body has overflow-y hidden or clip, or the body is position: fixed. */
  locked: boolean;
};

/** The collector's scroll state wire, or null for anything else. */
export function parseScrollState(wire: unknown): ScrollState | null {
  if (typeof wire !== "string" || wire.length === 0 || wire.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(wire);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { top, height, viewport, locked } = parsed as Record<string, unknown>;
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!finite(top) || !finite(height) || !finite(viewport) || viewport === 0 || typeof locked !== "boolean") return null;
  return { top, height, viewport, locked };
}

/** The page as the check uses it: its address, and the bounded collector's two scroll calls. */
export type ScrollCheckPage = {
  url(): string;
  scrollState(): Promise<ScrollState | null>;
  /** Set the scrolling element's position; false when the collector could not. */
  scrollTo(top: number): Promise<boolean>;
};

export type ScrollCheckRun<RequestT extends object> = {
  recorder: ScrollCheckRecorder<RequestT>;
  /**
   * The check's call-stack recorder (lib/scroll-check-stacks.ts), fed by the
   * scanner's attribution session; without it, the check runs exactly as it
   * did before call stacks, and its evidence carries none.
   */
  stacks?: ScrollCheckStackRecorder;
  page: ScrollCheckPage;
  timing: ScrollCheckTiming;
  /** Read immediately before the visit's navigation began. */
  navigationStartedAt: number;
  /** When the check phase began: the moment the visit's envelope was built. */
  startedAt: number;
  /**
   * The load gate the consent click and the typing probe use: the page
   * subject was valid (no HTTP error, no suspected challenge or soft block, a
   * verified subject) and the page was still on its site.
   */
  subjectAvailable: boolean;
  firstPartyHostname: string;
  /** Whether an address is still on the visit's site (sameScanSubjectUrl). */
  sameSubject(url: string): boolean;
  /** When the main frame first left the site during the check, if it did. */
  leftSiteAt(): number | null;
  /** The visit's own request budget had refused requests before the check began. */
  visitBudgetUsedUp: boolean;
  /** Requests the scan proxy's per-visit budgets have refused or cut so far. */
  proxyLossCount(): number;
  /** Wait, at most this long, for the scanner's routing decisions on requests in flight. */
  settleRoutes(maxMs: number): Promise<void>;
  now(): number;
  /**
   * Wait `ms`. Rejects as soon as the visit is cancelled, and resolves early,
   * with its timer cleared, once `stop` aborts.
   */
  sleep(ms: number, stop?: AbortSignal): Promise<void>;
  /**
   * Once its window without input has run, make the check throw, or make its
   * next page call never answer so its deadline ends it, in scanner
   * integration tests only.
   */
  faultForTests?: "throw" | "hang";
};

class ScrollCheckStop extends Error {
  constructor(readonly outcome: "left-site" | "cut-short") {
    super(`The check stopped: ${outcome}.`);
  }
}

/** Evidence that always validates: a check that stopped before any window ran to its end. */
const CUT_SHORT_EVIDENCE: ScrollCheckEvidence = Object.freeze({
  outcome: "cut-short",
  screens: 0,
  control: null,
  scroll: null,
  incomplete: [],
  addressChanged: false
}) as ScrollCheckEvidence;

/**
 * Run the check on the page the single scan left open, and return its
 * evidence. It never throws: an error, its own deadline or a cancellation
 * ends as an outcome inside the evidence, and the evidence it returns always
 * validates.
 */
export async function runScrollCheck<RequestT extends object>(run: ScrollCheckRun<RequestT>): Promise<ScrollCheckEvidence> {
  if (!run.subjectAvailable) {
    run.recorder.freeze();
    run.stacks?.freeze();
    return { outcome: "not-run", screens: 0, control: null, scroll: null, incomplete: [], addressChanged: false };
  }
  const progress: {
    outcome: ScrollCheckOutcome | null;
    screens: number;
    control: { start: number; end: number } | null;
    scroll: { start: number; end: number } | null;
    addressChanged: boolean;
  } = { outcome: null, screens: 0, control: null, scroll: null, addressChanged: false };
  const proxyLossBefore = safeCount(run.proxyLossCount);
  const deadline = scrollCheckDeadline(run.timing, run.navigationStartedAt, run.startedAt);
  try {
    if (!isRunnableScrollCheckTiming(run.timing)) throw new ScrollCheckStop("cut-short");
    await sequence(run, progress, deadline);
  } catch (error) {
    // A page call that failed because the page was leaving its site (its
    // document gone mid-read) is that page leaving, not the check failing.
    progress.outcome = error instanceof ScrollCheckStop ? error.outcome : leftSite(run) ? "left-site" : "cut-short";
  }
  run.recorder.freeze();
  run.stacks?.windowEnded();
  await settle(
    run,
    [progress.control, progress.scroll].filter((interval): interval is Interval => interval !== null),
    deadline
  );
  try {
    const windows = run.recorder.windows({
      firstPartyHostname: run.firstPartyHostname,
      control: progress.control,
      scroll: progress.scroll,
      ...(run.stacks ? { scrollRequests: true } : {})
    });
    const reasons = windows.reasons;
    if (run.visitBudgetUsedUp) reasons.add("visit-budget");
    if (safeCount(run.proxyLossCount) > proxyLossBefore) reasons.add("proxy-budget");
    const evidence: ScrollCheckEvidence = {
      outcome: progress.outcome ?? "cut-short",
      screens: progress.screens,
      control: windows.control,
      scroll: progress.screens > 0 ? windows.scroll : null,
      incomplete: SCROLL_CHECK_INCOMPLETE_REASONS.filter((reason) => reasons.has(reason)),
      addressChanged: progress.screens > 0 && progress.addressChanged
    };
    if (!isScrollCheckEvidence(evidence)) {
      run.stacks?.freeze();
      return CUT_SHORT_EVIDENCE;
    }
    return withAnalyticsEvents(withCallStacks(evidence, run.stacks, windows.scrollRequests), windows.events, run.firstPartyHostname);
  } catch {
    run.stacks?.freeze();
    return CUT_SHORT_EVIDENCE;
  }
}

/**
 * The settle after the windows (owner call 1, 2026-10-25). Under one bound,
 * at most 5 seconds and within the deadline, it waits for the scanner's
 * routing decisions in flight, then for an answer or a failure for every
 * request the scanner sent in the windows the check reports, and it ends as
 * soon as everything is in. What is still pending then counts as it stands:
 * a route undecided as not followed, a request unanswered as no answer. It
 * never throws.
 */
async function settle<RequestT extends object>(run: ScrollCheckRun<RequestT>, windows: Interval[], deadline: number): Promise<void> {
  const until = run.now() + Math.max(250, Math.min(SCROLL_CHECK_ROUTE_SETTLE_MS, deadline - run.now()));
  try {
    await run.settleRoutes(until - run.now());
  } catch {
    // Decisions still pending count as not followed; the windows say so.
  }
  const remaining = until - run.now();
  if (remaining <= 0 || windows.length === 0) return;
  const answered = new AbortController();
  let stopWaiting = (): void => undefined;
  try {
    stopWaiting = run.recorder.whenAnswered(windows, () => answered.abort());
    await run.sleep(remaining, answered.signal);
  } catch {
    // A cancellation ends the wait; the evidence holds what arrived.
  } finally {
    stopWaiting();
    answered.abort();
  }
}

/**
 * The evidence with each window's analytics events, validated again with
 * them; without them when the check reads no bodies, no window received an
 * event or left one unread, or they would not validate. They can cost a check
 * its events, never anything else. It never throws.
 */
function withAnalyticsEvents(
  evidence: ScrollCheckEvidence,
  requests: ScrollCheckEventRequests | undefined,
  firstPartyHostname: string
): ScrollCheckEvidence {
  if (requests === undefined) return evidence;
  try {
    const part = (window: unknown, counted: ScrollCheckEventRequest[] | null): ScrollCheckWindowEvents | null =>
      window === null || counted === null ? null : scrollCheckWindowEvents(counted, firstPartyHostname);
    const control = part(evidence.control, requests.control);
    const scroll = part(evidence.scroll, requests.scroll);
    const shown = [control, scroll].some((events) => events !== null && (events.destinations.length > 0 || events.notDecoded > 0));
    if (!shown) return evidence;
    const carried: ScrollCheckEvidence = { ...evidence, events: { control, scroll } };
    return isScrollCheckEvidence(carried) ? carried : evidence;
  } catch {
    return evidence;
  }
}

/**
 * The evidence with its scroll window's call stacks, validated a second time
 * with them; without them when there is no scroll window, the recording
 * failed, or they would not validate. Call stacks can cost a check its
 * stacks, never its lists. It never throws.
 */
function withCallStacks(
  evidence: ScrollCheckEvidence,
  stacks: ScrollCheckStackRecorder | undefined,
  listed: ScrollCheckListedRequests[] | undefined
): ScrollCheckEvidence {
  if (stacks === undefined) return evidence;
  try {
    if (evidence.scroll === null || listed === undefined) {
      stacks.freeze();
      return evidence;
    }
    const entries = stacks.entries(listed);
    if (entries === null) return evidence;
    const carried: ScrollCheckEvidence = { ...evidence, scroll: { ...evidence.scroll, stacks: entries } };
    return isScrollCheckEvidence(carried) ? carried : evidence;
  } catch {
    return evidence;
  }
}

function leftSite<RequestT extends object>(run: ScrollCheckRun<RequestT>): boolean {
  try {
    return run.leftSiteAt() !== null || !run.sameSubject(run.page.url());
  } catch {
    return false;
  }
}

function safeCount(read: () => number): number {
  try {
    const value = read();
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function sequence<RequestT extends object>(
  run: ScrollCheckRun<RequestT>,
  progress: {
    outcome: ScrollCheckOutcome | null;
    screens: number;
    control: { start: number; end: number } | null;
    scroll: { start: number; end: number } | null;
    addressChanged: boolean;
  },
  deadline: number
): Promise<void> {
  const { timing, page } = run;
  // Wait until `until`, or stop at the check's own deadline.
  const waitUntil = async (until: number): Promise<void> => {
    const stop = Math.min(until, deadline);
    const remaining = stop - run.now();
    if (remaining > 0) await run.sleep(remaining);
    if (until > deadline) throw new ScrollCheckStop("cut-short");
  };
  // One page call, bounded by the deadline. The deadline's wait is stopped
  // once the call answers, so no timer outlives it.
  const withinDeadline = async <T>(operation: Promise<T>): Promise<T> => {
    const remaining = deadline - run.now();
    if (remaining <= 0) {
      operation.catch(() => undefined);
      throw new ScrollCheckStop("cut-short");
    }
    const answered = new AbortController();
    const deadlinePassed = new Promise<never>((_resolve, reject) => {
      run.sleep(remaining, answered.signal).then(() => {
        if (!answered.signal.aborted) reject(new ScrollCheckStop("cut-short"));
      }, reject);
    });
    try {
      return await Promise.race([operation, deadlinePassed]);
    } finally {
      answered.abort();
    }
  };
  const onSite = (): void => {
    if (leftSite(run)) throw new ScrollCheckStop("left-site");
  };
  const readState = async (): Promise<ScrollState> => {
    const state = await withinDeadline(page.scrollState());
    if (state === null) throw new ScrollCheckStop("cut-short");
    return state;
  };

  // Settle: the visit's own time counts toward it.
  await waitUntil(run.navigationStartedAt + timing.settleAfterNavigationMs);
  onSite();

  // The window with no input.
  const controlStart = run.now();
  run.recorder.openWindow("control");
  if (run.stacks) {
    // Call-stack observations are kept from just before the scroll window
    // opens (SCROLL_CHECK_STACK_LEAD_MS); the window itself is still the
    // recorder's alone to decide.
    await waitUntil(Math.max(controlStart, controlStart + timing.controlWindowMs - SCROLL_CHECK_STACK_LEAD_MS));
    run.stacks.keep(run.firstPartyHostname);
  }
  await waitUntil(controlStart + timing.controlWindowMs);
  onSite();
  const controlEnd = run.now();
  progress.control = { start: controlStart, end: controlEnd };
  if (run.faultForTests === "throw") throw new Error("The check was made to throw for this test.");
  if (run.faultForTests === "hang") await withinDeadline(new Promise<never>(() => undefined));

  // The scroll window, contiguous with the first.
  const scrollStart = controlEnd;
  run.recorder.openWindow("scroll");
  const startUrl = page.url();
  let state = await readState();
  if (state.height <= state.viewport + SCROLL_CHECK_END_SLACK_PX) {
    progress.outcome = "nothing-to-scroll";
    return;
  }
  for (let step = 1; step <= MAX_SCROLL_CHECK_SCREENS; step += 1) {
    // A page whose root or body has scrolling turned off is never scrolled.
    if (state.locked) {
      progress.outcome = "locked";
      break;
    }
    const before = state;
    if (!(await withinDeadline(page.scrollTo(before.top + before.viewport)))) throw new ScrollCheckStop("cut-short");
    await waitUntil(scrollStart + step * timing.stepDwellMs);
    onSite();
    state = await readState();
    if (state.top <= before.top) {
      progress.outcome = "did-not-move";
      break;
    }
    progress.screens += 1;
    if (state.top + state.viewport >= state.height - SCROLL_CHECK_END_SLACK_PX && state.height <= before.height) {
      progress.outcome = "reached-end";
      break;
    }
  }
  if (progress.outcome === null) progress.outcome = "depth-limit";
  // Before any screen the page was never scrolled, so no scroll window ran.
  if (progress.screens === 0) return;
  if (progress.outcome === "reached-end" || progress.outcome === "depth-limit") {
    await waitUntil(scrollStart + progress.screens * timing.stepDwellMs + timing.deepestDwellMs);
    onSite();
    if (!(await withinDeadline(page.scrollTo(0)))) throw new ScrollCheckStop("cut-short");
  }
  await waitUntil(scrollStart + timing.scrollWindowMs);
  onSite();
  progress.addressChanged = page.url() !== startUrl;
  progress.scroll = { start: scrollStart, end: run.now() };
}

/**
 * A sleep that rejects as soon as the visit is cancelled, and resolves early
 * once its own `stop` aborts. Either way its timer and listeners are gone.
 */
export function abortableSleep(
  signal: AbortSignal | undefined,
  cancelled: (signal: AbortSignal) => Error
): (ms: number, stop?: AbortSignal) => Promise<void> {
  return (ms, stop) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(cancelled(signal));
        return;
      }
      if (stop?.aborted) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        stop?.removeEventListener("abort", onStop);
      };
      const onAbort = () => {
        finish();
        reject(cancelled(signal as AbortSignal));
      };
      const onStop = () => {
        finish();
        resolve();
      };
      const timer = setTimeout(() => {
        finish();
        resolve();
      }, Math.max(0, ms));
      signal?.addEventListener("abort", onAbort, { once: true });
      stop?.addEventListener("abort", onStop, { once: true });
    });
}
