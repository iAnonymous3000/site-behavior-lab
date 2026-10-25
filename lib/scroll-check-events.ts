import { decodeAnalyticsBeacon, type AnalyticsBeaconBody } from "./analytics-events";
import { isThirdParty } from "./domain-utils";
import { CUSTOM_EVENT_LABEL } from "./pixel-events";
import { redactHostnameV2 } from "./redaction-v2";
import {
  compareScrollCheckEventCounts,
  compareScrollCheckEventDestinations,
  MAX_SCROLL_CHECK_EVENT_BEACONS,
  MAX_SCROLL_CHECK_EVENT_DESTINATIONS,
  MAX_SCROLL_CHECK_EVENT_LINES,
  scrollCheckDestinationEventTotal,
  type ScrollCheckEventCount,
  type ScrollCheckEventDestination,
  type ScrollCheckWindowEvents
} from "./scroll-check-evidence";

/**
 * The GA4 and Adobe Analytics events a check's page sent in one window (build
 * brief approved 2026-10-25, owner calls 1 to 3), decoded through the one
 * decoder (lib/analytics-events.ts) and published as the check publishes
 * everything else: hosts through the report's own hostname redaction, counts,
 * and names only in the shared vocabulary's words. Raw URLs, hosts and bodies
 * never leave this module, and a body is never kept.
 *
 * WHICH REQUESTS. The check's own recorder (ScrollCheckRecorder.windows(),
 * lib/scroll-check.ts) decides, by its window and decision rules: a request
 * that started inside the window, that the scanner sent, that is neither the
 * page's own navigation nor a redirect hop (the beacon it continues was
 * counted), and whose address is in a decoded format. Unlike the host lists,
 * the site's own hosts count, since that is where its collection addresses
 * are; `ownSite` says which.
 *
 * BOUNDS, each counted in `notDecoded`, a request at most once there:
 * - at most 200 beacons decoded, in arrival order; the bodies of the rest are
 *   never read;
 * - at most 10 destinations, the most events first; the beacons of the rest;
 * - at most 20 event lines per destination, in the listed order; the beacons
 *   that carried the rest.
 */

/** One request the check's own window counted for its analytics events. */
export type ScrollCheckEventRequest = {
  /** The request's raw hostname, as the recorder read it. */
  host: string;
  url: string;
  /** Its body through the scanner's own bounded helper, read only if the window decodes it. */
  body(): AnalyticsBeaconBody;
};

type DestinationDraft = {
  destination: Omit<ScrollCheckEventDestination, "events">;
  /** Each line, by name and percent, and the requests that carried it. */
  lines: Map<string, { line: ScrollCheckEventCount; carriers: Set<number> }>;
  requests: number[];
};

/** One window's events from the requests its recorder counted for them, in arrival order. It never reads more than 200 bodies. */
export function scrollCheckWindowEvents(requests: readonly ScrollCheckEventRequest[], firstPartyHostname: string): ScrollCheckWindowEvents {
  const drafts = new Map<string, DestinationDraft>();
  // Requests whose events were not all read or listed, each once.
  const notRead = new Set<number>();
  let beacons = 0;
  let pastBound = 0;
  requests.forEach((request, index) => {
    if (beacons >= MAX_SCROLL_CHECK_EVENT_BEACONS) {
      pastBound += 1;
      return;
    }
    const decoded = decodeAnalyticsBeacon(request.url, () => request.body());
    if (decoded === null) return;
    beacons += 1;
    if (!decoded.complete) notRead.add(index);
    const host = redactHostnameV2(request.host).value;
    const ownSite = !isThirdParty(firstPartyHostname, request.host);
    const key = JSON.stringify([decoded.format, host, ownSite]);
    let draft = drafts.get(key);
    if (draft === undefined) {
      draft = { destination: { format: decoded.format, host, ownSite, beacons: 0, customEvents: 0 }, lines: new Map(), requests: [] };
      drafts.set(key, draft);
    }
    draft.destination.beacons += 1;
    draft.requests.push(index);
    for (const event of decoded.events) {
      if (event.name === CUSTOM_EVENT_LABEL) {
        draft.destination.customEvents += 1;
        continue;
      }
      const lineKey = JSON.stringify([event.name, event.percent]);
      const entry = draft.lines.get(lineKey) ?? { line: { name: event.name, percent: event.percent, count: 0 }, carriers: new Set<number>() };
      entry.line.count += 1;
      entry.carriers.add(index);
      draft.lines.set(lineKey, entry);
    }
  });
  const ranked = [...drafts.values()]
    .map((draft) => {
      const { format, host, ownSite, beacons: received, customEvents } = draft.destination;
      const events = [...draft.lines.values()].map((entry) => entry.line).sort(compareScrollCheckEventCounts);
      const full: ScrollCheckEventDestination = { format, host, ownSite, beacons: received, events, customEvents };
      return { draft, full };
    })
    // A destination is listed for an event it received.
    .filter(({ full }) => scrollCheckDestinationEventTotal(full) > 0)
    .sort((left, right) => compareScrollCheckEventDestinations(left.full, right.full));
  for (const { draft } of ranked.slice(MAX_SCROLL_CHECK_EVENT_DESTINATIONS)) {
    for (const index of draft.requests) notRead.add(index);
  }
  const destinations = ranked.slice(0, MAX_SCROLL_CHECK_EVENT_DESTINATIONS).map(({ draft, full }) => {
    for (const unlisted of full.events.slice(MAX_SCROLL_CHECK_EVENT_LINES)) {
      const carriers = draft.lines.get(JSON.stringify([unlisted.name, unlisted.percent]))?.carriers ?? [];
      for (const index of carriers) notRead.add(index);
    }
    const events = full.events.slice(0, MAX_SCROLL_CHECK_EVENT_LINES).map((line) => ({ ...line }));
    return { format: full.format, host: full.host, ownSite: full.ownSite, beacons: full.beacons, events, customEvents: full.customEvents };
  });
  return { beacons, destinations, notDecoded: pastBound + notRead.size };
}
