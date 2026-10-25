import { INSPECTION_CAVEAT, inspectionGroupSentence } from "./connection-inspection-copy";
import {
  MAX_SCROLL_CHECK_STACK_GROUPS,
  type ScrollCheckHostStacks,
  type ScrollCheckScrollWindow,
  type ScrollCheckStackGroup
} from "./scroll-check-evidence";
import { displayHost } from "./text-format";

/**
 * Reader copy for a check's call-stack hosts (build brief 2026-10-24, the
 * owner's approval of section 4 with calls 1 to 3): a folded section that
 * follows the scroll window's host list. React-free so unit tests reach every
 * sentence; the evidence explorer's lazy chunk renders it. Never "caused",
 * "proves", "safe", "honors", "ignores" or "complies", and each sentence is at
 * most 30 words. Counts of one read in the singular, and a line that does not
 * apply is left out.
 *
 * Inspect's approved words are used by import, never restated: its group
 * sentence (prefixed by the host) and its caveat. Where an approved sentence
 * would be false for what a result records, a corrected draft stands in its
 * place, with the approved text beside it, pending the owner's review.
 */

/** The folded section's summary, approved. */
export const SCROLL_CHECK_STACKS_HEADING = "Which scripts asked for them";

/** The caveat, Inspect's own, verbatim (approved). */
export const SCROLL_CHECK_STACKS_CAVEAT = INSPECTION_CAVEAT;

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * One call stack of one host, approved: Inspect's group sentence prefixed by
 * the host. "`<host>`: `<n>` requests. Scripts on the call stack, innermost
 * first: `<host>` then `<host>`."
 */
export function scrollCheckStackGroupLine(host: string, group: ScrollCheckStackGroup): string {
  return `${displayHost(host)}: ${inspectionGroupSentence(group)}`;
}

/**
 * A host's requests the check did not break down. CORRECTED DRAFT. Approved:
 * "`<host>`: `<n>` more requests had other call stacks, not listed here."
 * That is true of the requests in call stacks beyond the third, but the same
 * count also holds requests past a bound of the recording (an observation the
 * check could not keep, or a script it could no longer name), which may have
 * had no stack or one already listed. So the sentence names both causes
 * where both are possible, and only the bound where the host shows fewer
 * than three stacks, in the pattern of Inspect's drafted not-listed line.
 */
export function scrollCheckStacksNotListedLine(entry: Pick<ScrollCheckHostStacks, "host" | "groups" | "notListed">): string {
  const n = entry.notListed;
  const host = displayHost(entry.host);
  const more = entry.groups.length > 0 ? "more " : "";
  const requests = n === 1 ? `1 ${more}request is` : `${count(n)} ${more}requests are`;
  const because =
    entry.groups.length === MAX_SCROLL_CHECK_STACK_GROUPS
      ? `the check shows at most ${MAX_SCROLL_CHECK_STACK_GROUPS} call stacks per host and keeps a bounded number of them`
      : "the check keeps a bounded number of them";
  return `${host}: ${requests} not broken down here, because ${because}.`;
}

/** Hosts whose every counted request came with no call stack, summarized once, approved. */
export function scrollCheckNoStackHostsLine(hosts: number): string {
  return `${count(hosts)} of these hosts came with no call stack, so no script is named; the browser gives none for requests the page's HTML starts, nor for images a script creates.`;
}

/**
 * Requests with no call stack to the hosts that did have stacks, or other
 * counted cases. DRAFTED for the owner's review: the approved copy summarizes
 * hosts with no stack at all and has no line for these.
 */
export function scrollCheckStacksWithoutStackLine(n: number): string {
  return n === 1
    ? "1 more request to these hosts came with no call stack, so no script is named for it."
    : `${count(n)} more requests to these hosts came with no call stack, so no script is named for them.`;
}

/** Redirect hops, Inspect's approved sentence worded for these hosts' requests. */
export function scrollCheckStacksRedirectedLine(n: number): string {
  return n === 1
    ? "1 of these hosts' requests followed a redirect, so it carries the call stack of the request that started it, and no script is shown for it."
    : `${count(n)} of these hosts' requests followed a redirect, so they carry the call stack of the request that started it, and no script is shown for them.`;
}

/** Stacks with no frame the visit requested, Inspect's approved sentence worded for these hosts' requests. */
export function scrollCheckStacksWithoutNamedScriptLine(n: number): string {
  return n === 1
    ? "1 of these hosts' requests had no script on the call stack with an address this visit requested, so no script is named."
    : `${count(n)} of these hosts' requests had no script on the call stack with an address this visit requested, so no script is named.`;
}

/** Requests the recording never observed, under the caveat, Inspect's sentence worded for these hosts' requests. */
export function scrollCheckStacksUnobservedLine(n: number): string {
  return n === 1
    ? "1 of these hosts' requests was not observed, so nothing is shown for it."
    : `${count(n)} of these hosts' requests were not observed, so nothing is shown for them.`;
}

export type ScrollCheckStacksCopy = {
  heading: string;
  /** Each listed host's stacks and its not-broken-down line, in the listed order, then each summary that applies. */
  lines: string[];
  caveat: string;
  /** The unobserved count's line, under the caveat. */
  unobserved: string | null;
};

/** A host whose every counted request came with no call stack. */
function cameWithNoStack(entry: ScrollCheckHostStacks): boolean {
  return entry.withoutStack === entry.requests;
}

/**
 * The folded section for a scroll window's call stacks, or null when none
 * applies: no scroll window, no stacks recorded, or no host listed.
 */
export function scrollCheckStacksCopy(scroll: ScrollCheckScrollWindow | null): ScrollCheckStacksCopy | null {
  const stacks = scroll?.stacks;
  if (!stacks || stacks.length === 0) return null;
  const lines: string[] = [];
  for (const entry of stacks) {
    for (const group of entry.groups) lines.push(scrollCheckStackGroupLine(entry.host, group));
    if (entry.notListed > 0) lines.push(scrollCheckStacksNotListedLine(entry));
  }
  const noStackHosts = stacks.filter(cameWithNoStack).length;
  if (noStackHosts > 0) lines.push(scrollCheckNoStackHostsLine(noStackHosts));
  const total = (pick: (entry: ScrollCheckHostStacks) => number, of: readonly ScrollCheckHostStacks[] = stacks) =>
    of.reduce((sum, entry) => sum + pick(entry), 0);
  const withoutStack = total((entry) => entry.withoutStack, stacks.filter((entry) => !cameWithNoStack(entry)));
  if (withoutStack > 0) lines.push(scrollCheckStacksWithoutStackLine(withoutStack));
  const redirected = total((entry) => entry.redirected);
  if (redirected > 0) lines.push(scrollCheckStacksRedirectedLine(redirected));
  const withoutNamedScript = total((entry) => entry.withoutNamedScript);
  if (withoutNamedScript > 0) lines.push(scrollCheckStacksWithoutNamedScriptLine(withoutNamedScript));
  const unobserved = total((entry) => entry.unobserved);
  return {
    heading: SCROLL_CHECK_STACKS_HEADING,
    lines,
    caveat: SCROLL_CHECK_STACKS_CAVEAT,
    unobserved: unobserved > 0 ? scrollCheckStacksUnobservedLine(unobserved) : null
  };
}
