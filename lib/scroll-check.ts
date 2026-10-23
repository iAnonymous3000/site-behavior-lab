import { isThirdParty, partyKey } from "./domain-utils";
import { redactHostnameV2 } from "./redaction-v2";
import {
  isScrollCheckEvidence,
  MAX_SCROLL_CHECK_LISTED_HOSTS,
  MAX_SCROLL_CHECK_SCREENS,
  SCROLL_CHECK_INCOMPLETE_REASONS,
  type ScrollCheckEvidence,
  type ScrollCheckIncompleteReason,
  type ScrollCheckOutcome,
  type ScrollCheckScrollWindow,
  type ScrollCheckWindow
} from "./scroll-check-evidence";

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
/** The longest the check waits, after its windows, for the scanner's routing decisions. */
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
      const host = requestHost(this.facts.url(request));
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

  /** The third-party lists of each window that ran to its end, and what cut collection in them. */
  windows(input: {
    firstPartyHostname: string;
    control: { start: number; end: number } | null;
    scroll: { start: number; end: number } | null;
  }): {
    control: ScrollCheckWindow | null;
    scroll: ScrollCheckScrollWindow | null;
    reasons: Set<ScrollCheckIncompleteReason>;
  } {
    const reasons = new Set<ScrollCheckIncompleteReason>();
    if (this.boundReached && (input.control || input.scroll)) reasons.add("host-bound");
    const window = (interval: { start: number; end: number }) => {
      const firstContacted = new Map<string, Set<string>>();
      let requests = 0;
      let knownHostRequests = 0;
      for (const entry of this.entries) {
        if (entry.at < interval.start || entry.at >= interval.end) continue;
        const decision = entry.redirected ? "sent" : this.decisions.get(entry.request) ?? null;
        if (decision === "allowance") reasons.add("check-allowance");
        else if (decision !== "sent") reasons.add("refused");
        if (entry.navigation || decision !== "sent") continue;
        if (!isThirdParty(input.firstPartyHostname, entry.host)) continue;
        requests += 1;
        const firstAt = this.firstSeen.get(entry.host);
        if (firstAt === undefined) continue;
        if (firstAt < interval.start) {
          knownHostRequests += 1;
          continue;
        }
        if (this.firstEntries.get(entry.host) !== entry) continue;
        const published = redactHostnameV2(entry.host).value;
        const site = redactHostnameV2(partyKey(entry.host)).value;
        const hosts = firstContacted.get(site) ?? new Set<string>();
        hosts.add(published);
        firstContacted.set(site, hosts);
      }
      return { ...listedHosts(firstContacted), requests, knownHostRequests };
    };
    const control = input.control ? window(input.control) : null;
    const scroll = input.scroll ? window(input.scroll) : null;
    return {
      control: control
        ? { hosts: control.hosts, hostCount: control.hostCount, siteCount: control.siteCount, requests: control.requests }
        : null,
      scroll,
      reasons
    };
  }
}

/** The raw hostname of an http(s) request URL, or null for any other. */
function requestHost(url: string): string | null {
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
  try {
    await run.settleRoutes(Math.max(250, Math.min(SCROLL_CHECK_ROUTE_SETTLE_MS, deadline - run.now())));
  } catch {
    // Decisions still pending count as not followed; the windows say so.
  }
  try {
    const windows = run.recorder.windows({
      firstPartyHostname: run.firstPartyHostname,
      control: progress.control,
      scroll: progress.scroll
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
    return isScrollCheckEvidence(evidence) ? evidence : CUT_SHORT_EVIDENCE;
  } catch {
    return CUT_SHORT_EVIDENCE;
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
