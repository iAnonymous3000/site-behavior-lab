import {
  categorizeObservation,
  heldUrlKey,
  joinObservations,
  observedRequest,
  RequestedCodeUrls,
  StackTally,
  type PublishedStack,
  type StackObservationCategory
} from "./call-stack-publisher";
import { isThirdParty } from "./domain-utils";
import { requestHostname } from "./scroll-check";
import { MAX_SCROLL_CHECK_STACK_GROUPS, type ScrollCheckHostStacks } from "./scroll-check-evidence";

/**
 * Call-stack hosts for a check after scrolling (build brief 2026-10-24, owner
 * calls 1 to 3): for each host the check lists as first contacted in its
 * scroll window, which scripts were on the call stack of the requests the
 * check counted for it, under Inspect's rules, through the one stack
 * publisher (lib/call-stack-publisher.ts). Raw URLs and stacks never leave
 * this module: the evidence holds counts and published hosts only, and never
 * a script address (owner call 2).
 *
 * PASSIVE. It is fed only by the `Network.requestWillBeSent` handler of the
 * CDP session the scanner already opens for attribution, which stays
 * attached until the scanner's cleanup, after the check. No session, page
 * listener, command or domain is added, and it never throws into the visit.
 *
 * ONE CLOCK. Only the check's own page-request recorder (ScrollCheckRecorder,
 * lib/scroll-check.ts) decides which requests belong to the scroll window and
 * which it counts. This recorder only keeps the session's observations, from
 * just before the window opens (an observation of a request can arrive
 * before the page's own event for it) until the check builds its evidence
 * (or after the page's event), and never sorts them by their own times. When
 * the check ends, the requests the window recorded for each listed host are
 * joined per URL, in arrival order, to these observations; a request the
 * window did not count still takes its observation, so it never hands its
 * stack to a later one.
 *
 * WHAT IT KEEPS, each bounded:
 * - the Script and Document addresses requested from the navigation's start
 *   to the end of the scroll window, which alone name frames, so a script
 *   loaded after scrolling began names its own frames;
 * - from just before the scroll window, each third-party observation's
 *   category, by the check's own third-party rule, up to the check's own
 *   request allowance. An observation the bound drops is counted for its
 *   URL, so its request is not listed rather than read as never observed.
 */

/** URLs whose dropped observations are counted one by one; past this, every unjoined request is not listed. */
const MAX_DROPPED_URLS = 2_000;

/** One request the check's own window recorded for a listed host, and whether the window counted it. */
export type ScrollCheckStackRequest = { url: string; counted: boolean };

/** A host the scroll window lists, and every request its raw hosts made in that window, in arrival order. */
export type ScrollCheckListedRequests = { host: string; requests: ScrollCheckStackRequest[] };

/** The check publishes hosts only, so its groups are keyed by them alone. */
function hostsKey(stack: PublishedStack): string {
  return JSON.stringify(stack.hosts);
}

export class ScrollCheckStackRecorder {
  private readonly code = new RequestedCodeUrls();
  private readonly stacks = new Map<string, PublishedStack>();
  private readonly hostCache = new Map<string, string>();
  private readonly kept = new Map<string, StackObservationCategory[]>();
  private readonly dropped = new Map<string, number>();
  private keptObservations = 0;
  private droppedUntracked = false;
  private notingCode = true;
  /** The report's first-party hostname, once the recorder keeps observations. */
  private keepingFor: string | null = null;
  private frozen = false;
  private broken = false;

  /**
   * @param maxObservations the check's own request allowance, which bounds
   * its routed requests the same way (owner call 5 of 2026-10-23): the most
   * observations it keeps.
   */
  constructor(private readonly maxObservations: number) {}

  /** One `Network.requestWillBeSent` payload from the visit's own CDP session, from before it navigates. */
  observe(params: unknown): void {
    if (this.frozen || this.broken) return;
    try {
      const observed = observedRequest(params);
      if (observed === null) return;
      if (observed.code && this.notingCode) this.code.note(observed.key);
      if (this.keepingFor === null) return;
      // The check counts third-party requests only, by this same rule, so no
      // observation of a host it could list is left out here.
      const host = requestHostname(observed.rawUrl);
      if (host === null || !isThirdParty(this.keepingFor, host)) return;
      if (this.keptObservations >= this.maxObservations) {
        this.noteDropped(observed.key);
        return;
      }
      this.keptObservations += 1;
      const list = this.kept.get(observed.key) ?? [];
      list.push(categorizeObservation(observed, this.code, this.stacks, hostsKey, { scripts: false, hostCache: this.hostCache }));
      this.kept.set(observed.key, list);
    } catch {
      this.broken = true;
    }
  }

  /** Start keeping observations: just before the scroll window opens. */
  keep(firstPartyHostname: string): void {
    if (!this.frozen && !this.broken) this.keepingFor = firstPartyHostname;
  }

  /** The scroll window ended: addresses requested from now on name no frame. */
  windowEnded(): void {
    this.notingCode = false;
  }

  /** The session could not be opened or enabled, so no observation can be told apart from a worker's: no stacks are published. */
  sessionUnavailable(): void {
    this.broken = true;
  }

  /** Stop recording. */
  freeze(): void {
    this.frozen = true;
  }

  /**
   * Each listed host's call stacks, in the listed order, or null when the
   * recording failed or never kept an observation, in which case the check
   * carries no stacks rather than wrong counts. It never throws.
   */
  entries(listed: readonly ScrollCheckListedRequests[]): ScrollCheckHostStacks[] | null {
    this.freeze();
    if (this.broken || this.keepingFor === null) return null;
    try {
      return listed.map((entry) => this.hostStacks(entry));
    } catch {
      return null;
    }
  }

  private hostStacks(entry: ScrollCheckListedRequests): ScrollCheckHostStacks {
    // Per URL, in arrival order: every request the window recorded to this
    // host's raw hosts, counted or not.
    const byUrl = new Map<string, boolean[]>();
    for (const request of entry.requests) {
      const key = heldUrlKey(request.url);
      const counted = byUrl.get(key) ?? [];
      counted.push(request.counted);
      byUrl.set(key, counted);
    }
    const tally = new StackTally();
    for (const [key, counted] of byUrl) {
      const dropped = this.droppedUntracked ? counted.length : (this.dropped.get(key) ?? 0);
      joinObservations(tally, counted.length, this.kept.get(key) ?? [], dropped, (index) => counted[index]);
    }
    const ranked = tally.rankedGroups(this.stacks);
    let notListed = tally.notListed;
    for (const group of ranked.slice(MAX_SCROLL_CHECK_STACK_GROUPS)) notListed += group.count;
    return {
      host: entry.host,
      requests: entry.requests.filter((request) => request.counted).length,
      groups: ranked.slice(0, MAX_SCROLL_CHECK_STACK_GROUPS).map(({ count, stack }) => ({ count, hosts: [...stack.hosts] })),
      redirected: tally.redirected,
      withoutStack: tally.withoutStack,
      withoutNamedScript: tally.withoutNamedScript,
      notListed,
      unobserved: tally.unobserved
    };
  }

  private noteDropped(key: string): void {
    const count = this.dropped.get(key);
    if (count !== undefined) {
      this.dropped.set(key, count + 1);
    } else if (this.dropped.size < MAX_DROPPED_URLS) {
      this.dropped.set(key, 1);
    } else {
      this.droppedUntracked = true;
    }
  }
}
