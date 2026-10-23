import { isPublishedAddressShape } from "./connection-inspection-address";
import { isRecord } from "./guards";

/**
 * What an "Inspect this connection" visit shows about one address: which
 * scripts were on the call stack when the new visit's requests to it were
 * made. Built on the server from raw stacks that never leave it
 * (lib/connection-inspection.ts), carried only in the immediate result's
 * ephemeral block, and never saved, exported or printed (owner's rulings,
 * 2026-10-22).
 *
 * The shape is closed and holds counts, published hosts and published
 * addresses only: never a function name, a line or column number, a script,
 * frame or request id, a frame name, a stack depth, a query string or a raw
 * URL. Hosts are published through the same hostname redaction as the
 * report, and a script is named only when its address is one the same visit
 * requested as a script or a document.
 *
 * Every matched request is in exactly one place, so the counts add up:
 * matched = the groups' counts + redirected + withoutStack +
 * withoutNamedScript + notListed + unobserved. The validator holds that sum.
 *
 * Kept apart from the builder so the client's report reader can validate the
 * block without the public-suffix list the redaction pass needs.
 */
export type ConnectionInspectionGroup = {
  /** Matched requests whose call stack published as exactly these hosts and scripts. */
  count: number;
  /**
   * At most four published hosts, innermost first, consecutive repeats
   * collapsed, each the host of a frame whose script address the visit
   * requested.
   */
  hosts: string[];
  /**
   * The published addresses of the scripts behind those hosts, innermost
   * first, each once, at most eight. A frame named by a sourceURL comment is
   * here only when that name is an address the visit requested.
   */
  namedScripts: string[];
};

export type ConnectionInspectionEvidence = {
  /** The inspected address: a request row's published URL without its query. */
  address: string;
  /**
   * How many requests the page reported in this visit whose published address,
   * query dropped, equals `address`, counted from the page's own request
   * events, so a dedicated worker's requests count too.
   */
  matched: number;
  /** Matched requests grouped by their published call stack, largest first, at most twenty. */
  groups: ConnectionInspectionGroup[];
  /**
   * Matched requests that followed a redirect: such a request carries the call
   * stack of the request that started the chain, so no script is shown for it.
   */
  redirected: number;
  /**
   * Matched requests Chromium sent with no call stack: those the page's HTML,
   * a preload or the browser started, and also, in Chromium 153, an image a
   * script created, which it reports exactly as it reports the HTML's own.
   * So no count here shows that no script was involved.
   */
  withoutStack: number;
  /**
   * Matched requests whose call stack held no frame with an address the visit
   * requested as a script or document (unnamed code, or a name nothing
   * requested), so no script is named.
   */
  withoutNamedScript: number;
  /**
   * Matched requests the inspection did not break down because one of its
   * bounds was reached: groups beyond the twentieth, or more addresses,
   * observations or script addresses than it keeps.
   */
  notListed: number;
  /**
   * Matched requests the call-stack recording never observed, such as the
   * requests a dedicated worker makes, which the page reports and the page's
   * own session never sees.
   */
  unobserved: number;
};

/** At most this many hosts per group (owner's ruling: hosts only, at most four). */
export const MAX_INSPECTION_GROUP_HOSTS = 4;
/** At most this many named scripts per group. */
export const MAX_INSPECTION_GROUP_SCRIPTS = 8;
/** At most this many groups are listed; the rest are counted in notListed. */
export const MAX_INSPECTION_GROUPS = 20;

const EVIDENCE_KEYS = [
  "address",
  "matched",
  "groups",
  "redirected",
  "withoutStack",
  "withoutNamedScript",
  "notListed",
  "unobserved"
] as const;
const GROUP_KEYS = ["count", "hosts", "namedScripts"] as const;

// A published host: the report's own hostname redaction writes lowercase
// labels and the {label} marker, and its marker for a host it cannot name.
const PUBLISHED_HOST = /^(?:\{invalid-host\}|(?:\{label\}|[a-z0-9_-]{1,63})(?:\.(?:\{label\}|[a-z0-9_-]{1,63}))+)$/;

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A host exactly as the report's hostname redaction publishes it. Shared with
 * the after-scrolling check's evidence (lib/scroll-check-evidence.ts), so the
 * two closed shapes hold one published-host rule.
 */
export function isPublishedHost(value: unknown): value is string {
  // The hostname redaction publishes an IP literal as its marker, never itself.
  return typeof value === "string" && value.length <= 253 && PUBLISHED_HOST.test(value) && !/^\d+\.\d+\.\d+\.\d+$/.test(value);
}

function isGroup(value: unknown): value is ConnectionInspectionGroup {
  if (!isRecord(value) || !hasExactlyKeys(value, GROUP_KEYS)) return false;
  if (!isCount(value.count) || value.count === 0) return false;
  const { hosts, namedScripts } = value;
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > MAX_INSPECTION_GROUP_HOSTS) return false;
  if (!hosts.every(isPublishedHost)) return false;
  // Consecutive repeats are collapsed, so no host follows itself.
  if (hosts.some((host, index) => index > 0 && host === hosts[index - 1])) return false;
  if (!Array.isArray(namedScripts) || namedScripts.length > MAX_INSPECTION_GROUP_SCRIPTS) return false;
  if (!namedScripts.every((script) => typeof script === "string" && isPublishedAddressShape(script))) return false;
  return new Set(namedScripts).size === namedScripts.length;
}

/**
 * The closed shape above, with its counts adding up to `matched`. Anything
 * else, an extra key included, is refused, so a field a future producer adds
 * cannot reach a reader that does not know it.
 */
export function isConnectionInspectionEvidence(value: unknown): value is ConnectionInspectionEvidence {
  if (!isRecord(value) || !hasExactlyKeys(value, EVIDENCE_KEYS)) return false;
  if (typeof value.address !== "string" || !isPublishedAddressShape(value.address)) return false;
  const counts = [value.matched, value.redirected, value.withoutStack, value.withoutNamedScript, value.notListed, value.unobserved];
  if (!counts.every(isCount)) return false;
  const groups = value.groups;
  if (!Array.isArray(groups) || groups.length > MAX_INSPECTION_GROUPS || !groups.every(isGroup)) return false;
  // Groups are keyed by what they publish, so no two publish the same thing,
  // and they are listed largest first.
  const keys = new Set(groups.map((group) => JSON.stringify([group.hosts, group.namedScripts])));
  if (keys.size !== groups.length) return false;
  if (groups.some((group, index) => index > 0 && group.count > groups[index - 1].count)) return false;
  const [matched, ...rest] = counts as number[];
  const grouped = groups.reduce((sum, group) => sum + group.count, 0);
  return grouped + rest.reduce((sum, count) => sum + count, 0) === matched;
}
