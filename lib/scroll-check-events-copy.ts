import { ADOBE_ANALYTICS_FORMAT, GA4_SCROLL_EVENT, SCROLL_DEPTH_EVENT } from "./analytics-event-vocabulary";
import {
  MAX_SCROLL_CHECK_EVENT_BEACONS,
  MAX_SCROLL_CHECK_EVENT_DESTINATIONS,
  MAX_SCROLL_CHECK_EVENT_LINES,
  scrollCheckDestinationEventTotal,
  type ScrollCheckEventCount,
  type ScrollCheckEventDestination,
  type ScrollCheckEvidence,
  type ScrollCheckWindowEvents
} from "./scroll-check-evidence";
import { displayHost } from "./text-format";

/**
 * Reader copy for the analytics events a check's page sent (build brief
 * approved 2026-10-25, section 4, with owner calls 1 to 3): a folded section,
 * like the call-stack section, that follows the check's lists. React-free so
 * unit tests reach every sentence; the evidence explorer's lazy chunk renders
 * it. Never "caused", "proves", "safe", "honors", "ignores" or "complies",
 * and each sentence is at most 30 words, a destination's list of events
 * aside. Counts of one read in the singular, and a line that does not apply
 * is left out.
 *
 * The window without input is one count line, and the scroll window is
 * listed by destination (owner call 2); a collection address on the site
 * itself is labelled by its format and names no company (owner call 3).
 * Lines the approved copy has no text for are DRAFTED for the owner's
 * review, and a corrected draft stands where the approved sentence would be
 * false for what a result records, with the approved text beside it: each is
 * named where it is used.
 */

/** The folded section's summary, approved. */
export const SCROLL_CHECK_EVENTS_HEADING = "Analytics events the page sent";

/** The scope caveat, approved. */
export const SCROLL_CHECK_EVENTS_SCOPE =
  "Only events in GA4's standard collection format and Adobe Analytics' classic beacons are read; other analytics tools and formats are not.";

/** The timing caveat, approved, for a scroll window that sent events. */
export const SCROLL_CHECK_EVENTS_TIMING =
  "Being sent while scrolling does not show that scrolling was the reason, though scroll-depth events are usually sent for it.";

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** Every event a window's destinations received, named and custom. */
export function scrollCheckWindowEventCount(events: Pick<ScrollCheckWindowEvents, "destinations">): number {
  return events.destinations.reduce((sum, destination) => sum + scrollCheckDestinationEventTotal(destination), 0);
}

/** The window without input, as one count line (owner call 2), approved. */
export function scrollCheckEventsControlLine(n: number): string {
  if (n === 0) return "In 10 seconds without scrolling, the page sent no analytics event.";
  if (n === 1) return "In 10 seconds without scrolling, the page sent 1 analytics event.";
  return `In 10 seconds without scrolling, the page sent ${count(n)} analytics events.`;
}

/**
 * The scroll window's line before its destinations, approved: "While
 * scrolling, it sent `<m>`:". DRAFTED for a scroll window that sent none,
 * which the approved copy has no line for, in the words of the approved
 * line for a window without input that sent none.
 */
export function scrollCheckEventsScrollLine(m: number): string {
  return m === 0 ? "While scrolling, it sent no analytics event." : `While scrolling, it sent ${count(m)}:`;
}

/** How many times an event was sent, after its name: DRAFTED, since the approved examples show each once. */
function times(n: number): string {
  if (n === 1) return "";
  return n === 2 ? " twice" : ` ${count(n)} times`;
}

/**
 * A destination's named events in the listed order: a name as the
 * vocabulary writes it, GA4's scroll event with its percent in brackets,
 * and the scroll depths one run after their shared words, as the approved
 * examples read: "scroll (90%)", "scroll depth 25%, 50%, 75%, 100%".
 */
export function scrollCheckEventNames(events: readonly ScrollCheckEventCount[]): string {
  const parts: string[] = [];
  events.forEach((event, index) => {
    if (event.name === SCROLL_DEPTH_EVENT) {
      const first = index === 0 || events[index - 1].name !== SCROLL_DEPTH_EVENT;
      parts.push(`${first ? `${SCROLL_DEPTH_EVENT} ` : ""}${event.percent}%${times(event.count)}`);
      return;
    }
    const percent = event.name === GA4_SCROLL_EVENT && event.percent !== null ? ` (${event.percent}%)` : "";
    parts.push(`${event.name}${percent}${times(event.count)}`);
  });
  return parts.join(", ");
}

/**
 * The custom events after a destination's named ones, approved: "and `<k>`
 * custom events whose names this check does not show." DRAFTED without the
 * "and" for a destination whose every event is a custom one.
 */
function customEventsClause(k: number, after: boolean): string {
  const and = after ? "and " : "";
  return k === 1 ? `${and}1 custom event whose name this check does not show` : `${and}${count(k)} custom events whose names this check does not show`;
}

/**
 * One destination of the scroll window, approved: "GA4 events to
 * analytics.google.com: scroll (90%)." and "Adobe Analytics events to
 * smetrics.capitalone.com, an address on this site: scroll depth 25%, 50%,
 * 75%, 100%.", its custom events after its named ones.
 */
export function scrollCheckEventDestinationLine(destination: ScrollCheckEventDestination): string {
  const where = `${destination.format} events to ${displayHost(destination.host)}${destination.ownSite ? ", an address on this site" : ""}:`;
  const named = scrollCheckEventNames(destination.events);
  if (destination.customEvents === 0) return `${where} ${named}.`;
  if (named === "") return `${where} ${customEventsClause(destination.customEvents, false)}.`;
  return `${where} ${named}, ${customEventsClause(destination.customEvents, true)}.`;
}

/** The format's name as the own-site note says it: "GA4's", "Adobe Analytics'". */
function possessive(format: ScrollCheckEventDestination["format"]): string {
  return format === ADOBE_ANALYTICS_FORMAT ? `${format}'` : `${format}'s`;
}

/** The note for an address on the visited site (owner call 3), approved, once per format. */
export function scrollCheckEventsOwnSiteNote(format: ScrollCheckEventDestination["format"]): string {
  return `An address on this site receives these in ${possessive(format)} format; the visit cannot see where it passes them on.`;
}

/**
 * Requests whose events were not all read or listed. Approved: "`<n>`
 * requests could not be read in full, so some events may be missing." That
 * holds for a body cut or unreadable, but the same count also holds the
 * requests past a bound, which were read and are not listed. CORRECTED DRAFT
 * where a bound could have applied (a window at 200 beacons or 10
 * destinations, or a destination at 20 event lines): "`<n>` requests could
 * not be read in full or were past this check's limits, so some events may
 * be missing."
 */
export function scrollCheckEventsNotDecodedLine(n: number, bounded: boolean): string {
  if (bounded) {
    return n === 1
      ? "1 request could not be read in full or was past this check's limits, so some events may be missing."
      : `${count(n)} requests could not be read in full or were past this check's limits, so some events may be missing.`;
  }
  return n === 1 ? "1 request could not be read in full, so some events may be missing." : `${count(n)} requests could not be read in full, so some events may be missing.`;
}

/** Whether one of a window's bounds could have left something out of it. */
function atABound(events: ScrollCheckWindowEvents | null): boolean {
  if (events === null) return false;
  return (
    events.beacons === MAX_SCROLL_CHECK_EVENT_BEACONS ||
    events.destinations.length === MAX_SCROLL_CHECK_EVENT_DESTINATIONS ||
    events.destinations.some((destination) => destination.events.length === MAX_SCROLL_CHECK_EVENT_LINES)
  );
}

export type ScrollCheckEventsCopy = {
  heading: string;
  /** The window without input's count line, when that window ran. */
  control: string | null;
  /** The scroll window's line, when that window ran. */
  scroll: string | null;
  /** One line per destination of the scroll window, in its order. */
  destinations: string[];
  /** One note per format of the scroll window's destinations on the visited site. */
  ownSite: string[];
  /** Both windows' requests not read in full or listed, when there are any. */
  notDecoded: string | null;
  /** The scope caveat, then the timing caveat when the scroll window sent events. */
  caveats: string[];
};

/**
 * The folded section for a check's analytics events, or null when its
 * evidence carries none: no window received an event or left one unread.
 */
export function scrollCheckEventsCopy(evidence: Pick<ScrollCheckEvidence, "events">): ScrollCheckEventsCopy | null {
  const events = evidence.events;
  if (events === undefined) return null;
  const scroll = events.scroll;
  const sent = scroll === null ? 0 : scrollCheckWindowEventCount(scroll);
  const destinations = scroll === null ? [] : scroll.destinations;
  const ownSiteFormats = [...new Set(destinations.filter((destination) => destination.ownSite).map((destination) => destination.format))];
  const notDecoded = (events.control?.notDecoded ?? 0) + (scroll?.notDecoded ?? 0);
  return {
    heading: SCROLL_CHECK_EVENTS_HEADING,
    control: events.control === null ? null : scrollCheckEventsControlLine(scrollCheckWindowEventCount(events.control)),
    scroll: scroll === null ? null : scrollCheckEventsScrollLine(sent),
    destinations: destinations.map(scrollCheckEventDestinationLine),
    ownSite: ownSiteFormats.map(scrollCheckEventsOwnSiteNote),
    notDecoded: notDecoded > 0 ? scrollCheckEventsNotDecodedLine(notDecoded, atABound(events.control) || atABound(scroll)) : null,
    caveats: sent > 0 ? [SCROLL_CHECK_EVENTS_SCOPE, SCROLL_CHECK_EVENTS_TIMING] : [SCROLL_CHECK_EVENTS_SCOPE]
  };
}
