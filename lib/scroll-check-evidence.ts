import { isPublishedHost, MAX_INSPECTION_GROUP_HOSTS } from "./connection-inspection-evidence";
import { isRecord } from "./guards";

/**
 * What a "Check after scrolling" visit shows: the third-party hosts its page
 * first contacted in 10 seconds without input, and those it first contacted
 * in the next 10 seconds while the visit scrolled, both after a long settle.
 * Built on the server from raw hostnames that never leave it
 * (lib/scroll-check.ts), carried only in the immediate result's ephemeral
 * block, and never saved, exported or printed (owner's calls, 2026-10-23).
 *
 * The shape is closed and holds counts, published hosts and fixed facts
 * only: no URL, path, query, body, cookie, storage, script or frame name, and
 * no timing beyond the fixed windows. Hosts are published through the
 * report's own hostname redaction and grouped by site. For each host the
 * scroll window lists, it can also hold which scripts were on the call stack
 * of its requests, as hosts only, under Inspect's rules (build brief
 * 2026-10-24): never a script address, function name, position, id or depth.
 *
 * Kept apart from the builder so the client's report reader can validate the
 * block without the public-suffix list the redaction pass needs.
 */

/** How the check ended; lib/scroll-check-copy.ts words each one. */
export const SCROLL_CHECK_OUTCOMES = [
  "reached-end",
  "depth-limit",
  "did-not-move",
  "nothing-to-scroll",
  "left-site",
  "cut-short",
  "locked",
  "not-run"
] as const;
export type ScrollCheckOutcome = (typeof SCROLL_CHECK_OUTCOMES)[number];

/**
 * What cut collection during the windows, in this order:
 * - `visit-budget`: the single scan had used up its own request budget
 *   before the check began, so the page was already missing requests;
 * - `check-allowance`: the check's own request allowance refused a request;
 * - `proxy-budget`: the scan proxy's per-visit traffic or byte budget refused
 *   or cut a transfer during the check;
 * - `refused`: the scanner refused a request in a window for another reason
 *   (an address it could not verify as public, for one), or had not decided
 *   on it when the check ended;
 * - `host-bound`: the recorder reached one of its own bounds.
 */
export const SCROLL_CHECK_INCOMPLETE_REASONS = [
  "visit-budget",
  "check-allowance",
  "proxy-budget",
  "refused",
  "host-bound"
] as const;
export type ScrollCheckIncompleteReason = (typeof SCROLL_CHECK_INCOMPLETE_REASONS)[number];

/** The visit scrolls at most this many screens. */
export const MAX_SCROLL_CHECK_SCREENS = 8;
/** At most this many hosts are listed per window, across its sites; the counts stay full. */
export const MAX_SCROLL_CHECK_LISTED_HOSTS = 20;
/**
 * At most this many call stacks are listed for each host the scroll window
 * lists (owner call 2, 2026-10-24); the rest of its requests are counted in
 * its `notListed`.
 */
export const MAX_SCROLL_CHECK_STACK_GROUPS = 3;

/** One site's hosts, as the report publishes them, listed in name order. */
export type ScrollCheckSiteHosts = {
  /** The site: the published form of the hosts' registrable domain. */
  site: string;
  hosts: string[];
};

export type ScrollCheckWindow = {
  /**
   * Third-party hosts first contacted in this window, grouped by site: sites
   * with the most hosts first, then by name; at most twenty hosts in all.
   */
  hosts: ScrollCheckSiteHosts[];
  /** How many third-party hosts were first contacted in this window, listed or not. */
  hostCount: number;
  /** How many sites those hosts belong to. */
  siteCount: number;
  /** Third-party requests that started in this window and that the scanner sent. */
  requests: number;
};

/** One call stack a listed host's requests came with, as at most four published hosts. */
export type ScrollCheckStackGroup = {
  /** The host's counted requests whose call stack published as exactly these hosts. */
  count: number;
  /**
   * At most four published hosts, innermost first, consecutive repeats
   * collapsed, each the host of a frame whose script address the visit
   * requested. No script address is published (owner call 2).
   */
  hosts: string[];
};

/**
 * Which scripts were on the call stack of the requests a check counted for
 * one host its scroll window lists, under Inspect's rules
 * (lib/call-stack-publisher.ts). Every counted request is in exactly one
 * place: requests = the groups' counts + redirected + withoutStack +
 * withoutNamedScript + notListed + unobserved. The validator holds that sum.
 */
export type ScrollCheckHostStacks = {
  /** The listed host, exactly as the window lists it; it covers every raw host first contacted in the window that publishes as it. */
  host: string;
  /** The requests to it the check itself counted in the scroll window: sent, third party, never the page's own navigation. */
  requests: number;
  /** Requests grouped by their published call stack, the most frequent first, at most three. */
  groups: ScrollCheckStackGroup[];
  /** Requests that followed a redirect, which carry the call stack of the request that started it. */
  redirected: number;
  /**
   * Requests Chromium sent with no call stack: those the page's HTML starts,
   * and, in Chromium 153, an image a script created. So no count here shows
   * that no script was involved.
   */
  withoutStack: number;
  /** Requests whose call stack held no frame with an address the visit requested as a script or document. */
  withoutNamedScript: number;
  /**
   * Requests not broken down: those in call stacks beyond the third, and
   * those past a bound of the check's recording.
   */
  notListed: number;
  /** Requests the call-stack recording never observed, such as a dedicated worker's. */
  unobserved: number;
};

export type ScrollCheckScrollWindow = ScrollCheckWindow & {
  /** Of `requests`, those to third-party hosts the page had already contacted before the window. */
  knownHostRequests: number;
  /**
   * One entry per listed host, in the listed order: which scripts were on
   * the call stack of its requests. Present when the check recorded call
   * stacks, and only in the scroll window (owner call 1, 2026-10-24).
   */
  stacks?: ScrollCheckHostStacks[];
};

export type ScrollCheckEvidence = {
  outcome: ScrollCheckOutcome;
  /** Screens the visit scrolled, 0 to 8. */
  screens: number;
  /** The 10-second window without input; null when it did not run to its end. */
  control: ScrollCheckWindow | null;
  /** The scroll window; null when the visit never moved the page or the window did not run to its end. */
  scroll: ScrollCheckScrollWindow | null;
  incomplete: ScrollCheckIncompleteReason[];
  /** Whether the page changed its own address while the visit scrolled. */
  addressChanged: boolean;
};

const EVIDENCE_KEYS = ["outcome", "screens", "control", "scroll", "incomplete", "addressChanged"] as const;
const WINDOW_KEYS = ["hosts", "hostCount", "siteCount", "requests"] as const;
const SCROLL_WINDOW_KEYS = [...WINDOW_KEYS, "knownHostRequests"] as const;
const SCROLL_WINDOW_STACK_KEYS = [...SCROLL_WINDOW_KEYS, "stacks"] as const;
const SITE_KEYS = ["site", "hosts"] as const;
const HOST_STACK_KEYS = [
  "host",
  "requests",
  "groups",
  "redirected",
  "withoutStack",
  "withoutNamedScript",
  "notListed",
  "unobserved"
] as const;
const STACK_GROUP_KEYS = ["count", "hosts"] as const;

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A host belongs to its site when it is the site or a name under it. */
function belongsTo(host: string, site: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

function isSiteHosts(value: unknown): value is ScrollCheckSiteHosts {
  if (!isRecord(value) || !hasExactlyKeys(value, SITE_KEYS)) return false;
  const { site, hosts } = value;
  if (!isPublishedHost(site) || !Array.isArray(hosts) || hosts.length === 0) return false;
  if (!hosts.every((host) => isPublishedHost(host) && belongsTo(host, site))) return false;
  // In name order, each once.
  return hosts.every((host, index) => index === 0 || hosts[index - 1] < host);
}

function isWindow(value: unknown, keys: readonly string[]): value is ScrollCheckWindow {
  if (!isRecord(value) || !hasExactlyKeys(value, keys)) return false;
  const { hosts, hostCount, siteCount, requests } = value;
  if (![hostCount, siteCount, requests].every(isCount)) return false;
  if (!Array.isArray(hosts) || !hosts.every(isSiteHosts)) return false;
  const groups = hosts as ScrollCheckSiteHosts[];
  const listed = groups.reduce((sum, group) => sum + group.hosts.length, 0);
  // Every host first contacted is listed, up to twenty in all.
  if (listed !== Math.min(hostCount as number, MAX_SCROLL_CHECK_LISTED_HOSTS)) return false;
  // Each site at most once, sites with more listed hosts first, then by name.
  if (new Set(groups.map((group) => group.site)).size !== groups.length) return false;
  if (
    groups.some((group, index) => {
      if (index === 0) return false;
      const previous = groups[index - 1];
      return group.hosts.length > previous.hosts.length || (group.hosts.length === previous.hosts.length && group.site <= previous.site);
    })
  ) {
    return false;
  }
  const allHosts = groups.flatMap((group) => group.hosts);
  if (new Set(allHosts).size !== allHosts.length) return false;
  // A complete list names every site; a cut one names at least the sites it lists.
  if (listed === hostCount ? siteCount !== groups.length : (siteCount as number) < groups.length) return false;
  if ((siteCount === 0) !== (hostCount === 0) || (siteCount as number) > (hostCount as number)) return false;
  // Each host first contacted here was first contacted by a request the scanner sent.
  return (requests as number) >= (hostCount as number);
}

function isStackGroup(value: unknown): value is ScrollCheckStackGroup {
  if (!isRecord(value) || !hasExactlyKeys(value, STACK_GROUP_KEYS)) return false;
  if (!isCount(value.count) || value.count === 0) return false;
  const { hosts } = value;
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > MAX_INSPECTION_GROUP_HOSTS) return false;
  if (!hosts.every(isPublishedHost)) return false;
  // Consecutive repeats are collapsed, so no host follows itself.
  return !hosts.some((host, index) => index > 0 && host === hosts[index - 1]);
}

function isHostStacks(value: unknown): value is ScrollCheckHostStacks {
  if (!isRecord(value) || !hasExactlyKeys(value, HOST_STACK_KEYS)) return false;
  const { host, requests, groups, redirected, withoutStack, withoutNamedScript, notListed, unobserved } = value;
  if (!isPublishedHost(host)) return false;
  const counts = [requests, redirected, withoutStack, withoutNamedScript, notListed, unobserved];
  // A listed host was first contacted by a request the check counted.
  if (!counts.every(isCount) || requests === 0) return false;
  if (!Array.isArray(groups) || groups.length > MAX_SCROLL_CHECK_STACK_GROUPS || !groups.every(isStackGroup)) return false;
  // Groups are keyed by the hosts they publish, so no two publish the same,
  // and they are listed the most frequent first.
  if (new Set(groups.map((group) => JSON.stringify(group.hosts))).size !== groups.length) return false;
  if (groups.some((group, index) => index > 0 && group.count > groups[index - 1].count)) return false;
  const [counted, ...rest] = counts as number[];
  const grouped = groups.reduce((sum, group) => sum + group.count, 0);
  return grouped + rest.reduce((sum, count) => sum + count, 0) === counted;
}

/**
 * One entry per host the window lists, in its listed order, whose requests
 * are some of those the window counted to hosts it had not contacted
 * before, so together they never exceed them.
 */
function areHostStacks(value: unknown, window: ScrollCheckScrollWindow): boolean {
  if (!Array.isArray(value)) return false;
  const listed = window.hosts.flatMap((group) => group.hosts);
  if (value.length !== listed.length) return false;
  if (!value.every((entry, index) => isHostStacks(entry) && entry.host === listed[index])) return false;
  const total = (value as ScrollCheckHostStacks[]).reduce((sum, entry) => sum + entry.requests, 0);
  return total <= window.requests - window.knownHostRequests;
}

/**
 * The closed shape above and the facts that tie its parts together. Anything
 * else, an extra key included, is refused, so a field a future producer adds
 * cannot reach a reader that does not know it.
 */
export function isScrollCheckEvidence(value: unknown): value is ScrollCheckEvidence {
  if (!isRecord(value) || !hasExactlyKeys(value, EVIDENCE_KEYS)) return false;
  const { outcome, screens, control, scroll, incomplete, addressChanged } = value;
  if (typeof outcome !== "string" || !(SCROLL_CHECK_OUTCOMES as readonly string[]).includes(outcome)) return false;
  if (!isCount(screens) || screens > MAX_SCROLL_CHECK_SCREENS) return false;
  if (typeof addressChanged !== "boolean") return false;
  if (control !== null && !isWindow(control, WINDOW_KEYS)) return false;
  if (scroll !== null) {
    // Call stacks are the scroll window's only optional part.
    const withStacks = isRecord(scroll) && Object.prototype.hasOwnProperty.call(scroll, "stacks");
    if (!isWindow(scroll, withStacks ? SCROLL_WINDOW_STACK_KEYS : SCROLL_WINDOW_KEYS)) return false;
    const window = scroll as ScrollCheckScrollWindow;
    if (!isCount(window.knownHostRequests) || window.requests < window.hostCount + window.knownHostRequests) return false;
    if (withStacks && !areHostStacks(window.stacks, window)) return false;
  }
  if (!Array.isArray(incomplete)) return false;
  const reasons = SCROLL_CHECK_INCOMPLETE_REASONS as readonly string[];
  if (!incomplete.every((reason) => typeof reason === "string" && reasons.includes(reason))) return false;
  // Each reason once, in the declared order.
  if (incomplete.some((reason, index) => index > 0 && reasons.indexOf(reason) <= reasons.indexOf(incomplete[index - 1]))) return false;
  // The scroll window follows a whole window without input, and is published
  // only when the visit moved the page; so is a change of address.
  if (scroll !== null && (control === null || screens === 0)) return false;
  if (addressChanged && screens === 0) return false;
  switch (outcome) {
    case "not-run":
      return screens === 0 && control === null && scroll === null && incomplete.length === 0 && !addressChanged;
    case "nothing-to-scroll":
      return screens === 0 && scroll === null;
    case "reached-end":
      return screens > 0 && scroll !== null;
    case "depth-limit":
      return screens === MAX_SCROLL_CHECK_SCREENS && scroll !== null;
    case "locked":
    case "did-not-move":
      // Before any screen, the page was never scrolled and no scroll window
      // ran; after one, the window ran to its end where the page stopped.
      return screens === 0 ? scroll === null : scroll !== null;
    default:
      // left-site and cut-short end wherever they happen.
      return true;
  }
}
