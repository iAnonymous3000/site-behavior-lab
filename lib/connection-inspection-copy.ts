import type { ConnectionInspectionEvidence, ConnectionInspectionGroup } from "./connection-inspection-evidence";
import { displayHost, displayPublicUrl } from "./text-format";

/**
 * Reader copy for "Inspect this connection" (owner's approval, 2026-10-22,
 * the brief's section 4, plus the sentences the rulings added). React-free so
 * unit tests reach every sentence; the evidence explorer's lazy chunk renders
 * it. Never "caused", "proves", "honors", "ignores" or "complies", and each
 * sentence is at most 30 words. Counts of one read in the singular.
 */

/**
 * The link each third-party row of a fresh result's request log offers. Its
 * accessible name adds the address, as the row shows it, so a list of links
 * read out of context still says which connection each one inspects.
 */
export const INSPECT_CONNECTION_LINK = {
  label: "Inspect this connection",
  name: (address: string) => `Inspect this connection to ${displayPublicUrl(address)}`
} as const;

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** "a", "a then b", "a then b then c": hosts innermost first, as the report shows them. */
function hostChain(hosts: readonly string[]): string {
  return hosts.map(displayHost).join(" then ");
}

/** One stack group, approved: "`<n>` requests. Scripts on the call stack, innermost first: `<host>` then `<host>`." */
export function inspectionGroupSentence(group: Pick<ConnectionInspectionGroup, "count" | "hosts">): string {
  const requests = group.count === 1 ? "1 request." : `${count(group.count)} requests.`;
  return `${requests} Scripts on the call stack, innermost first: ${hostChain(group.hosts)}.`;
}

/**
 * Requests Chromium sent with no call stack. REPLACES the approved draft,
 * "`<n>` requests were started by the page itself, not by a script, so they
 * have no call stack.", pending the owner's review at the push: Chromium 153
 * reports an image a script created (new Image(), an appended element, a
 * timer, another site's tag) as the parser's, with the document's URL and no
 * stack, so "not by a script" would be false for the commonest pixel shape
 * (lib/connection-inspection-fixture.test.ts pins that behavior). This keeps
 * the approved sentence's place and claims only what the browser reported.
 */
export function inspectionWithoutStackSentence(n: number): string {
  return n === 1
    ? "1 request came with no call stack, so no script is named; the browser gives none for requests the page's HTML starts, nor for images a script creates."
    : `${count(n)} requests came with no call stack, so no script is named; the browser gives none for requests the page's HTML starts, nor for images a script creates.`;
}

/** Redirect hops, ruled (ruling 4). */
export function inspectionRedirectedSentence(n: number): string {
  return n === 1
    ? "1 of these requests followed a redirect, so it carries the call stack of the request that started it, and no script is shown for it."
    : `${count(n)} of these requests followed a redirect, so they carry the call stack of the request that started it, and no script is shown for them.`;
}

/** Stacks with no frame whose address the visit requested, ruled (ruling 4). */
export function inspectionWithoutNamedScriptSentence(n: number): string {
  return n === 1
    ? "1 request had no script on the call stack with an address this visit requested, so no script is named."
    : `${count(n)} requests had no script on the call stack with an address this visit requested, so no script is named.`;
}

/** Requests a bound kept from being broken down. Drafted for the owner's review. */
export function inspectionNotListedSentence(n: number): string {
  return n === 1
    ? "1 more request to this address is not broken down here, because the inspection keeps a bounded number of them."
    : `${count(n)} more requests to this address are not broken down here, because the inspection keeps a bounded number of them.`;
}

/**
 * Requests the page reported and the call-stack recording never observed,
 * shown under the approved worker caveat (ruling 4). Drafted for the owner's
 * review.
 */
export function inspectionUnobservedSentence(n: number): string {
  return n === 1
    ? "1 of this visit's requests to this address was not observed, so nothing is shown for it."
    : `${count(n)} of this visit's requests to this address were not observed, so nothing is shown for them.`;
}

export const INSPECTION_CAVEAT =
  "A call stack shows which scripts were running when a request was made, not which one decided to make it. Requests made by workers are not observed.";

export const INSPECTION_SEPARATION =
  "This new visit is a different observation from the report you came from, so it can neither confirm nor refute that report's row.";

export type InspectionPanelCopy = {
  heading: string;
  /** Present only when the visit made no request to the address. */
  didNotRecur: string | null;
  /** The breakdown, group by group, then each other count that is not zero. */
  lines: string[];
  /** The caveat, shown with a breakdown. */
  caveat: string | null;
  /** The unobserved count's line, under the caveat. */
  unobserved: string | null;
  separation: string;
};

/** Everything the result panel says, in order, for one inspection's evidence. */
export function inspectionPanelCopy(evidence: ConnectionInspectionEvidence): InspectionPanelCopy {
  const address = displayPublicUrl(evidence.address);
  const heading = `Which scripts asked for ${address} in this new visit`;
  if (evidence.matched === 0) {
    return {
      heading,
      didNotRecur: `This new visit made no request to ${address}. Connections can change between visits, so this does not show the earlier one did not happen.`,
      lines: [],
      caveat: null,
      unobserved: null,
      separation: INSPECTION_SEPARATION
    };
  }
  const lines = evidence.groups.map(inspectionGroupSentence);
  if (evidence.redirected > 0) lines.push(inspectionRedirectedSentence(evidence.redirected));
  if (evidence.withoutStack > 0) lines.push(inspectionWithoutStackSentence(evidence.withoutStack));
  if (evidence.withoutNamedScript > 0) lines.push(inspectionWithoutNamedScriptSentence(evidence.withoutNamedScript));
  if (evidence.notListed > 0) lines.push(inspectionNotListedSentence(evidence.notListed));
  return {
    heading,
    didNotRecur: null,
    lines,
    caveat: INSPECTION_CAVEAT,
    unobserved: evidence.unobserved > 0 ? inspectionUnobservedSentence(evidence.unobserved) : null,
    separation: INSPECTION_SEPARATION
  };
}
