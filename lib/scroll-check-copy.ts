import {
  MAX_SCROLL_CHECK_SCREENS,
  SCROLL_CHECK_LIST_STATES,
  type ScrollCheckEvidence,
  type ScrollCheckListState,
  type ScrollCheckOutcome,
  type ScrollCheckSiteHosts,
  type ScrollCheckWindow
} from "./scroll-check-evidence";
import { displayHost } from "./text-format";

/**
 * Reader copy for "Check after scrolling" (owner's approval, 2026-10-23, the
 * build brief's section 4). React-free so unit tests reach every sentence;
 * the server page renders the entry, and the evidence explorer's lazy chunk
 * renders the result panel. Never "caused", "proves", "safe", "honors",
 * "ignores" or "complies", and each sentence is at most 30 words. Counts of
 * one read in the singular, and a line that does not apply to a result is
 * left out.
 *
 * Where an approved sentence would be false for what a result records, a
 * corrected draft stands in its place, with the approved text beside it,
 * pending the owner's review: each is named where it is used.
 *
 * The answers and labels brief of 2026-10-25 adds its section 4: one line
 * for the requests that got no answer (owner call 2), and, when the lists
 * were compared, a window's hosts split under up to three headings by their
 * list state (owner call 3, option a), with two caveats once, or one line
 * when the lists could not be compared. A result without labels, an older
 * scanner's included, reads exactly as it did.
 */

/**
 * The entry a fresh result offers in "What this visit could not see", in its
 * "Anything that loads only after interaction or consent" item.
 */
export const SCROLL_CHECK_ENTRY = {
  label: "Check after scrolling",
  sentence:
    "Opens the scan form ready for a new visit that lets this page settle and then scrolls it, checking scrolling only; nothing runs until you press Check."
} as const;

export const SCROLL_CHECK_HEADING = "What this page first contacted after scrolling began";

export const SCROLL_CHECK_EMPTY_FURTHER = "Scrolling further, or the way a person does, could still load more.";

export const SCROLL_CHECK_TIMING_CAVEAT =
  "Being first contacted while scrolling does not show that scrolling was the reason: pages also load things on timers, which the 10 seconds without scrolling measure.";

export const SCROLL_CHECK_MECHANISM_CAVEAT =
  "The visit scrolled by script, one screen a second, with no mouse, touch or clicks, so content that waits for those was not reached.";

export const SCROLL_CHECK_CONSENT_CAVEAT =
  "Some sites treat scrolling as agreeing to cookies; this check does not tell whether this page did.";

export const SCROLL_CHECK_STARTING_POINT =
  "The check began where the single scan ended, on the page as the scan left it, including any made-up test value the scan typed into its fields.";

/**
 * The single scan's own request budget, as the sentence below states it. The
 * scanner's constant (MAX_RECORDED_REQUESTS, lib/scan-runtime.ts) is
 * server-only; lib/scroll-check-copy.test.ts holds the two equal.
 */
export const SCROLL_CHECK_VISIT_BUDGET_REQUESTS = 1_000;

export const SCROLL_CHECK_VISIT_BUDGET = `The single scan had already reached its limit of ${SCROLL_CHECK_VISIT_BUDGET_REQUESTS.toLocaleString("en-US")} requests, so the page was missing some of its own requests when the check began.`;

export const SCROLL_CHECK_INCOMPLETE =
  "Some of the page's requests during the check could not be followed, so these lists can be incomplete.";

export const SCROLL_CHECK_ADDRESS_CHANGED =
  "The page changed its own address while scrolling, as pages that load the next article do; the visit stayed on this site.";

export const SCROLL_CHECK_NOT_SAVED =
  "This visit scrolled the page after the report below was collected, so nothing from it is saved, shared, exported or printed.";

/**
 * The not-saved line for a result whose visit never scrolled the page: a
 * page that fit, was locked or did not move before its first screen, a check
 * that did not run or that stopped before scrolling. Corrected draft: the
 * approved sentence (SCROLL_CHECK_NOT_SAVED) says the visit scrolled the
 * page, which is false for these.
 */
export const SCROLL_CHECK_NOT_SAVED_UNSCROLLED =
  "This visit was a check after scrolling, so nothing from it is saved, shared, exported or printed.";

export const SCROLL_CHECK_REPORT_NOTE = "The report below covers the visit before the check began.";

/**
 * The line above the report for a check that did not run. Corrected draft:
 * the approved sentence (SCROLL_CHECK_REPORT_NOTE) places the report before a
 * check that never began.
 */
export const SCROLL_CHECK_REPORT_NOTE_NOT_RUN = "The report below covers this visit.";

export const SCROLL_CHECK_SEPARATION =
  "This new visit is a different observation from the report you came from, so it can neither confirm nor refute anything in it.";

/**
 * The lists, in the report's own words (lib/report-findings.ts,
 * app/_components/report-tables.tsx), for the same-visit labels (build brief
 * 2026-10-25, part B, owner calls 3 and 4).
 */
export const SCROLL_CHECK_LISTS_NAME = "the default filter lists of Brave Shields";

/** The report's own caveat for a list match, word for word (app/_components/report-tables.tsx), said once when a label shows. */
export const SCROLL_CHECK_MATCHING_CAVEAT = "Matching is computed while the page loads normally; it is not a measured block.";

/** Approved as drafted (section 4), said once when a label shows. */
export const SCROLL_CHECK_BLOCKING_CAVEAT =
  "With blocking on, what a matched request would load never runs, so a visit with Shields might also skip hosts that had no match.";

/** Approved: the scanner's list engine was not loaded, so nothing was compared. */
export const SCROLL_CHECK_LISTS_UNAVAILABLE = `This check could not compare its requests with ${SCROLL_CHECK_LISTS_NAME}.`;

/**
 * The approved heading for the hosts no counted request of which was
 * compared with the lists, kept beside its corrected draft
 * (scrollCheckListHeading): it names a reason the evidence does not carry.
 */
export const SCROLL_CHECK_UNCOMPARED_HEADING_APPROVED =
  "`<i>` were reached only through redirects, which this check does not compare with the lists:";

/**
 * The heading over the listed hosts in one list state (owner call 3, option
 * a), counting only the hosts it holds. Matched and no match, approved.
 * CORRECTED DRAFT for not compared (SCROLL_CHECK_UNCOMPARED_HEADING_APPROVED
 * is the approved text): a host is not compared when none of its counted
 * requests was, and the evidence does not say why, so a heading that says
 * every such host was reached only through redirects would be false for one
 * that was not compared for another reason. It names the state, then the
 * one reason the check knows of, without saying it is this host's.
 */
export function scrollCheckListHeading(state: ScrollCheckListState, n: number): string {
  if (state === "matched") return `${count(n)} had a request that matched ${SCROLL_CHECK_LISTS_NAME}:`;
  if (state === "no-match") return `${count(n)} had none that matched:`;
  return `${count(n)} had no request this check compared with the lists; it does not compare requests that followed a redirect:`;
}

/** How each check ended, approved, for a result whose sentence holds as approved. */
const OUTCOME_SENTENCES: Readonly<Record<ScrollCheckOutcome, string>> = {
  "reached-end": "The visit scrolled to the end of the page, then went back to the top.",
  "depth-limit": `The visit scrolled ${MAX_SCROLL_CHECK_SCREENS} screens, its limit; the page continued below that, and nothing further down was reached.`,
  "did-not-move": "The page was taller than the window but did not move when scrolled, so nothing below the first screen was reached.",
  locked: "The page was taller than the window but had scrolling turned off, so the visit did not scroll it.",
  // Corrected draft. Approved: "The page fit in the window, so there was
  // nothing to scroll." A page that scrolls inside a box of its own fits the
  // window as a whole while its content runs on, which that sentence denies.
  "nothing-to-scroll":
    "The page as a whole fit in the window, so there was nothing to scroll; any box inside it that scrolls on its own was not scrolled.",
  "left-site": "The page left this site during the check, so the check stopped there.",
  // Corrected draft. Approved: "The check stopped early when its time ran
  // out." The scanner also ends a check this way when the page stops
  // answering its reads or an error stops it, so the time is not always why.
  "cut-short": "The check stopped early, before it could finish.",
  "not-run": "The check did not run, because this visit could not load the page normally."
};

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function screens(k: number): string {
  return k === 1 ? "1 screen" : `${count(k)} screens`;
}

/** How the check ended, for this result. */
export function scrollCheckOutcomeSentence(evidence: Pick<ScrollCheckEvidence, "outcome" | "screens">): string {
  const k = evidence.screens;
  // Corrected draft. Approved: "The page was taller than the window but had
  // scrolling turned off, so the visit did not scroll it." After a screen,
  // the visit had scrolled it; the page turned scrolling off on the way.
  if (evidence.outcome === "locked" && k > 0) {
    return `The page turned scrolling off after the visit had scrolled ${screens(k)}, so the visit scrolled it no further.`;
  }
  // Corrected draft. Approved: "The page was taller than the window but did
  // not move when scrolled, so nothing below the first screen was reached."
  // After a screen, the page had moved; it stopped moving on the way.
  if (evidence.outcome === "did-not-move" && k > 0) {
    return `The page stopped moving when scrolled after ${screens(k)}, so nothing further down was reached.`;
  }
  return OUTCOME_SENTENCES[evidence.outcome];
}

/** The control window's line, approved. */
export function scrollCheckControlLine(hostCount: number): string {
  if (hostCount === 0) return "In 10 seconds without scrolling, the page first contacted no new third-party host.";
  if (hostCount === 1) return "In 10 seconds without scrolling, the page first contacted 1 new third-party host.";
  return `In 10 seconds without scrolling, the page first contacted ${count(hostCount)} new third-party hosts.`;
}

/** The scroll window's line before its hosts, approved; used only when it lists some. */
export function scrollCheckScrollLine(k: number, hostCount: number): string {
  return `In the next 10 seconds, while the visit scrolled ${screens(k)}, it first contacted ${count(hostCount)} more:`;
}

/** The scroll window's line when it first contacted no host, approved. */
export function scrollCheckEmptyScrollLine(k: number): string {
  return `While the visit scrolled ${screens(k)}, the page contacted no third-party host it had not already contacted.`;
}

/** Requests to hosts already contacted, approved. */
export function scrollCheckTrafficLine(requests: number): string {
  return requests === 1
    ? "While scrolling, the page also sent 1 request to a third party it had already contacted."
    : `While scrolling, the page also sent ${count(requests)} requests to third parties it had already contacted.`;
}

/**
 * Requests that got no answer, both windows' as one total (build brief
 * 2026-10-25, owner call 2), approved: "`<n>` requests got no answer before
 * the check ended, so they are not listed or counted." DRAFTED for one
 * request, in the singular.
 */
export function scrollCheckNoAnswerLine(n: number): string {
  return n === 1
    ? "1 request got no answer before the check ended, so it is not listed or counted."
    : `${count(n)} requests got no answer before the check ended, so they are not listed or counted.`;
}

/** Hosts a window counted and did not list. Drafted for the owner's review. */
export function scrollCheckNotListedLine(n: number): string {
  return n === 1 ? "1 more is not listed." : `${count(n)} more are not listed.`;
}

/**
 * One site's hosts as the reader sees them: the site alone when it is the
 * only host, otherwise the site, then its hosts.
 */
export function scrollCheckSiteLine(group: ScrollCheckSiteHosts): string {
  if (group.hosts.length === 1 && group.hosts[0] === group.site) return displayHost(group.site);
  return `${displayHost(group.site)}: ${group.hosts.map(displayHost).join(", ")}`;
}

/** One heading of a labelled window's list, and the sites under it. */
export type ScrollCheckHostGroupCopy = {
  state: ScrollCheckListState;
  heading: string;
  /** One line per site, with only its hosts in this state, in the evidence's order. */
  sites: string[];
};

export type ScrollCheckWindowCopy = {
  line: string;
  /** One line per site, in the evidence's order; empty when `groups` holds them. */
  sites: string[];
  /**
   * When the window's hosts carry list labels: up to three headings, in the
   * order matched, no match, not compared, each holding its sites.
   */
  groups?: ScrollCheckHostGroupCopy[];
  /** Present when the window counted more hosts than it lists; it says nothing about their lists. */
  notListed: string | null;
  /** The empty scroll window's second sentence. */
  further: string | null;
};

export type ScrollCheckPanelCopy = {
  heading: string;
  control: ScrollCheckWindowCopy | null;
  scroll: ScrollCheckWindowCopy | null;
  traffic: string | null;
  /** Both windows' requests that got no answer, when there are any: after the traffic line, before the analytics events. */
  noAnswer: string | null;
  outcome: string;
  addressChanged: string | null;
  /** The visit-budget line, then the incomplete line, each when it applies. */
  incomplete: string[];
  /**
   * The lists' line when they could not be compared, or the two matching
   * caveats when a label shows; then the timing, mechanism and consent
   * caveats, each when it applies, then the starting point.
   */
  caveats: string[];
  notSaved: string;
  separation: string;
};

/** A window's listed hosts under up to three headings, or null when they carry no list labels. */
function labelledGroups(window: ScrollCheckWindow): ScrollCheckHostGroupCopy[] | null {
  const { matchedHosts, uncomparedHosts } = window;
  if (matchedHosts === undefined || uncomparedHosts === undefined) return null;
  const stateOf = (host: string): ScrollCheckListState =>
    matchedHosts.includes(host) ? "matched" : uncomparedHosts.includes(host) ? "not-compared" : "no-match";
  const groups: ScrollCheckHostGroupCopy[] = [];
  for (const state of SCROLL_CHECK_LIST_STATES) {
    const sites = window.hosts
      .map((group) => ({ site: group.site, hosts: group.hosts.filter((host) => stateOf(host) === state) }))
      .filter((group) => group.hosts.length > 0);
    const n = sites.reduce((sum, group) => sum + group.hosts.length, 0);
    if (n > 0) groups.push({ state, heading: scrollCheckListHeading(state, n), sites: sites.map(scrollCheckSiteLine) });
  }
  return groups;
}

function listed(window: ScrollCheckWindow): Pick<ScrollCheckWindowCopy, "sites" | "groups" | "notListed"> {
  const shown = window.hosts.reduce((sum, group) => sum + group.hosts.length, 0);
  const groups = shown > 0 ? labelledGroups(window) : null;
  return {
    sites: groups ? [] : window.hosts.map(scrollCheckSiteLine),
    ...(groups ? { groups } : {}),
    notListed: window.hostCount > shown ? scrollCheckNotListedLine(window.hostCount - shown) : null
  };
}

/**
 * Whether a list label shows on the panel: a labelled window lists a host,
 * or the scroll window lists an analytics destination with its state (the
 * window without input's destinations are one count line, so theirs never
 * show).
 */
export function scrollCheckLabelsShown(evidence: Pick<ScrollCheckEvidence, "filterLists" | "control" | "scroll" | "events">): boolean {
  if (evidence.filterLists !== "compared") return false;
  const hostsShown = [evidence.control, evidence.scroll].some((window) => window !== null && window.hosts.length > 0 && window.matchedHosts !== undefined);
  const destinationsShown = (evidence.events?.scroll?.destinations ?? []).some((destination) => destination.lists !== undefined);
  return hostsShown || destinationsShown;
}

/**
 * Everything the result panel says, in reading order, for one check's
 * evidence: what arrived without input, then while scrolling, how the check
 * ended, what limits the lists, the caveats, and what is not saved.
 */
export function scrollCheckPanelCopy(evidence: ScrollCheckEvidence): ScrollCheckPanelCopy {
  const scrolled = evidence.screens > 0;
  const control: ScrollCheckWindowCopy | null = evidence.control
    ? { line: scrollCheckControlLine(evidence.control.hostCount), ...listed(evidence.control), further: null }
    : null;
  const scroll: ScrollCheckWindowCopy | null = evidence.scroll
    ? evidence.scroll.hostCount > 0
      ? { line: scrollCheckScrollLine(evidence.screens, evidence.scroll.hostCount), ...listed(evidence.scroll), further: null }
      : { line: scrollCheckEmptyScrollLine(evidence.screens), sites: [], notListed: null, further: SCROLL_CHECK_EMPTY_FURTHER }
    : null;
  const incomplete: string[] = [];
  if (evidence.incomplete.includes("visit-budget")) incomplete.push(SCROLL_CHECK_VISIT_BUDGET);
  // Said of the lists, so only beside one.
  if ((control || scroll) && evidence.incomplete.some((reason) => reason !== "visit-budget")) incomplete.push(SCROLL_CHECK_INCOMPLETE);
  const caveats: string[] = [];
  // The lists come first among the caveats: they qualify the lists above.
  if (evidence.filterLists === "unavailable") caveats.push(SCROLL_CHECK_LISTS_UNAVAILABLE);
  else if (scrollCheckLabelsShown(evidence)) caveats.push(SCROLL_CHECK_MATCHING_CAVEAT, SCROLL_CHECK_BLOCKING_CAVEAT);
  if (evidence.scroll && evidence.scroll.hostCount > 0) caveats.push(SCROLL_CHECK_TIMING_CAVEAT);
  if (scrolled) caveats.push(SCROLL_CHECK_MECHANISM_CAVEAT, SCROLL_CHECK_CONSENT_CAVEAT);
  if (evidence.outcome !== "not-run") caveats.push(SCROLL_CHECK_STARTING_POINT);
  const unanswered = (evidence.control?.unanswered ?? 0) + (evidence.scroll?.unanswered ?? 0);
  return {
    heading: SCROLL_CHECK_HEADING,
    control,
    scroll,
    traffic: evidence.scroll && evidence.scroll.knownHostRequests > 0 ? scrollCheckTrafficLine(evidence.scroll.knownHostRequests) : null,
    noAnswer: unanswered > 0 ? scrollCheckNoAnswerLine(unanswered) : null,
    outcome: scrollCheckOutcomeSentence(evidence),
    addressChanged: evidence.addressChanged ? SCROLL_CHECK_ADDRESS_CHANGED : null,
    incomplete,
    caveats,
    notSaved: scrolled ? SCROLL_CHECK_NOT_SAVED : SCROLL_CHECK_NOT_SAVED_UNSCROLLED,
    separation: SCROLL_CHECK_SEPARATION
  };
}

/** The one sentence between the panel and the report it follows. */
export function scrollCheckReportNote(evidence: Pick<ScrollCheckEvidence, "outcome">): string {
  return evidence.outcome === "not-run" ? SCROLL_CHECK_REPORT_NOTE_NOT_RUN : SCROLL_CHECK_REPORT_NOTE;
}
