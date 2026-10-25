import assert from "node:assert/strict";
import { test } from "node:test";
import { INSPECTION_CAVEAT, inspectionWithoutStackSentence } from "./connection-inspection-copy";
import {
  isScrollCheckEvidence,
  MAX_SCROLL_CHECK_STACK_GROUPS,
  type ScrollCheckEvidence,
  type ScrollCheckHostStacks,
  type ScrollCheckScrollWindow
} from "./scroll-check-evidence";
import {
  SCROLL_CHECK_STACKS_CAVEAT,
  SCROLL_CHECK_STACKS_HEADING,
  scrollCheckNoStackHostsLine,
  scrollCheckStackGroupLine,
  scrollCheckStacksCopy,
  scrollCheckStacksNotListedLine,
  scrollCheckStacksRedirectedLine,
  scrollCheckStacksUnobservedLine,
  scrollCheckStacksWithoutNamedScriptLine,
  scrollCheckStacksWithoutStackLine,
  type ScrollCheckStacksCopy
} from "./scroll-check-stacks-copy";

/**
 * The call-stack section's copy over every entry shape the closed validator
 * admits: which lines appear, in which words, and that each sentence keeps
 * the rules every check sentence keeps. lib/scroll-check-stacks.test.ts holds
 * the section's words to what the real recorder writes for the fixture page.
 */

const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const VERDICT_WORDS = /\b(?:caused|causes|proves?|safe|honou?rs?|ignores?|complies|comply)\b/i;
const COUNT_KEYS = ["redirected", "withoutStack", "withoutNamedScript", "notListed", "unobserved"] as const;
const GROUP_HOSTS = [["static.bravo.org", "cdn.alpha.net"], ["cdn.alpha.net"], ["{label}.tag.org"]];

type Counts = Record<(typeof COUNT_KEYS)[number], number>;

function entryOf(host: string, groupCounts: number[], counts: Counts): ScrollCheckHostStacks {
  const groups = groupCounts.map((groupCount, index) => ({ count: groupCount, hosts: GROUP_HOSTS[index] }));
  const requests = groupCounts.reduce((sum, value) => sum + value, 0) + COUNT_KEYS.reduce((sum, key) => sum + counts[key], 0);
  return { host, requests, groups, ...counts };
}

/**
 * Evidence whose scroll window lists exactly these entries' hosts, each its
 * own site, in the window's own order (one host per site, so by site name),
 * or null when the validator refuses it.
 */
function evidenceWith(unordered: ScrollCheckHostStacks[]): ScrollCheckEvidence | null {
  const siteOf = (host: string) => host.replace(/^[^.]+\./, "");
  const stacks = [...unordered].sort((left, right) => (siteOf(left.host) < siteOf(right.host) ? -1 : 1));
  const hosts = stacks.map((entry) => ({ site: siteOf(entry.host), hosts: [entry.host] }));
  const requests = stacks.reduce((sum, entry) => sum + entry.requests, 0);
  const scroll: ScrollCheckScrollWindow = { hosts, hostCount: stacks.length, siteCount: stacks.length, requests, knownHostRequests: 0, stacks };
  const value: ScrollCheckEvidence = {
    outcome: "reached-end",
    screens: 3,
    control: { hosts: [], hostCount: 0, siteCount: 0, requests: 0 },
    scroll,
    incomplete: [],
    addressChanged: false
  };
  return isScrollCheckEvidence(value) ? value : null;
}

function allLines(copy: ScrollCheckStacksCopy): string[] {
  return [copy.heading, ...copy.lines, copy.caveat, ...(copy.unobserved ? [copy.unobserved] : [])];
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.;:])\s+(?=[A-Z0-9])/);
}

/** Every entry the validator takes, with up to three groups and each other count 0, 1 or 2. */
function entryShapes(host: string): ScrollCheckHostStacks[] {
  const shapes: ScrollCheckHostStacks[] = [];
  const groupChoices = [[], [2], [2, 1], [3, 2, 1]];
  const values = [0, 1, 2];
  for (const groupCounts of groupChoices) {
    for (const redirected of values) {
      for (const withoutStack of values) {
        for (const withoutNamedScript of values) {
          for (const notListed of values) {
            for (const unobserved of values) {
              const entry = entryOf(host, groupCounts, { redirected, withoutStack, withoutNamedScript, notListed, unobserved });
              if (evidenceWith([entry])) shapes.push(entry);
            }
          }
        }
      }
    }
  }
  return shapes;
}

test("a scroll window with no stacks, or none to show, has no section", () => {
  assert.equal(scrollCheckStacksCopy(null), null);
  const plain: ScrollCheckScrollWindow = { hosts: [], hostCount: 0, siteCount: 0, requests: 0, knownHostRequests: 0 };
  assert.equal(scrollCheckStacksCopy(plain), null);
  assert.equal(scrollCheckStacksCopy({ ...plain, stacks: [] }), null);
});

test("the section speaks in the approved words, Inspect's own where the brief says so", () => {
  assert.equal(SCROLL_CHECK_STACKS_HEADING, "Which scripts asked for them");
  assert.equal(SCROLL_CHECK_STACKS_CAVEAT, INSPECTION_CAVEAT);
  assert.equal(
    SCROLL_CHECK_STACKS_CAVEAT,
    "A call stack shows which scripts were running when a request was made, not which one decided to make it. Requests made by workers are not observed."
  );
  assert.equal(
    scrollCheckStackGroupLine("pixel.charlie.com", { count: 3, hosts: ["static.bravo.org", "cdn.alpha.net"] }),
    "pixel.charlie.com: 3 requests. Scripts on the call stack, innermost first: static.bravo.org then cdn.alpha.net."
  );
  assert.equal(
    scrollCheckStackGroupLine("{label}.lima.net", { count: 1, hosts: ["{label}.tag.org"] }),
    "*.lima.net: 1 request. Scripts on the call stack, innermost first: *.tag.org."
  );
  assert.equal(
    scrollCheckNoStackHostsLine(2),
    "2 of these hosts came with no call stack, so no script is named; the browser gives none for requests the page's HTML starts, nor for images a script creates."
  );
  // The reason the no-stack line gives is Inspect's, word for word.
  const reason = "the browser gives none for requests the page's HTML starts, nor for images a script creates.";
  assert.ok(scrollCheckNoStackHostsLine(1).endsWith(reason) && inspectionWithoutStackSentence(1).endsWith(reason));
  assert.equal(
    scrollCheckStacksRedirectedLine(2),
    "2 of these hosts' requests followed a redirect, so they carry the call stack of the request that started it, and no script is shown for them."
  );
  assert.equal(
    scrollCheckStacksRedirectedLine(1),
    "1 of these hosts' requests followed a redirect, so it carries the call stack of the request that started it, and no script is shown for it."
  );
  assert.equal(
    scrollCheckStacksWithoutNamedScriptLine(2),
    "2 of these hosts' requests had no script on the call stack with an address this visit requested, so no script is named."
  );
  assert.equal(scrollCheckStacksUnobservedLine(2), "2 of these hosts' requests were not observed, so nothing is shown for them.");
  assert.equal(scrollCheckStacksUnobservedLine(1), "1 of these hosts' requests was not observed, so nothing is shown for it.");
  // Drafted: requests with no stack to hosts that had stacks too.
  assert.equal(scrollCheckStacksWithoutStackLine(2), "2 more requests to these hosts came with no call stack, so no script is named for them.");
  assert.equal(scrollCheckStacksWithoutStackLine(1), "1 more request to these hosts came with no call stack, so no script is named for it.");
});

test("a host's requests not broken down name the cap only where the cap could have applied", () => {
  const capped = entryOf("cdn.capped.net", [5, 4, 3], { redirected: 0, withoutStack: 0, withoutNamedScript: 0, notListed: 3, unobserved: 0 });
  assert.equal(
    scrollCheckStacksNotListedLine(capped),
    "cdn.capped.net: 3 more requests are not broken down here, because the check shows at most 3 call stacks per host and keeps a bounded number of them."
  );
  const bounded = entryOf("cdn.bounded.net", [1], { redirected: 0, withoutStack: 0, withoutNamedScript: 0, notListed: 1, unobserved: 0 });
  assert.equal(scrollCheckStacksNotListedLine(bounded), "cdn.bounded.net: 1 more request is not broken down here, because the check keeps a bounded number of them.");
  const none = entryOf("cdn.none.net", [], { redirected: 0, withoutStack: 0, withoutNamedScript: 0, notListed: 2, unobserved: 0 });
  assert.equal(scrollCheckStacksNotListedLine(none), "cdn.none.net: 2 requests are not broken down here, because the check keeps a bounded number of them.");
});

test("every entry shape the validator admits says each count once, and nothing that did not happen", () => {
  const shapes = entryShapes("cdn.one.net");
  assert.ok(shapes.length > 900, `only ${shapes.length} shapes`);
  for (const entry of shapes) {
    const evidence = evidenceWith([entry]) as ScrollCheckEvidence;
    const copy = scrollCheckStacksCopy(evidence.scroll);
    const label = JSON.stringify(entry);
    assert.ok(copy, label);
    assert.equal(copy.heading, SCROLL_CHECK_STACKS_HEADING, label);
    assert.equal(copy.caveat, SCROLL_CHECK_STACKS_CAVEAT, label);
    const expected: string[] = entry.groups.map((group) => scrollCheckStackGroupLine(entry.host, group));
    if (entry.notListed > 0) expected.push(scrollCheckStacksNotListedLine(entry));
    const noStack = entry.withoutStack === entry.requests;
    if (noStack) expected.push(scrollCheckNoStackHostsLine(1));
    else if (entry.withoutStack > 0) expected.push(scrollCheckStacksWithoutStackLine(entry.withoutStack));
    if (entry.redirected > 0) expected.push(scrollCheckStacksRedirectedLine(entry.redirected));
    if (entry.withoutNamedScript > 0) expected.push(scrollCheckStacksWithoutNamedScriptLine(entry.withoutNamedScript));
    assert.deepEqual(copy.lines, expected, label);
    assert.equal(copy.unobserved, entry.unobserved > 0 ? scrollCheckStacksUnobservedLine(entry.unobserved) : null, label);
    // The cap is named only beside three listed stacks.
    assert.equal(copy.lines.some((line) => line.includes("at most 3 call stacks")), entry.notListed > 0 && entry.groups.length === MAX_SCROLL_CHECK_STACK_GROUPS, label);
    for (const text of allLines(copy)) {
      for (const sentence of sentencesOf(text)) assert.ok(sentence.split(/\s+/).length <= 30, `over 30 words: ${sentence}`);
      assert.equal(DASHES.test(text), false, text);
      assert.equal(VERDICT_WORDS.test(text), false, text);
      assert.equal(/\b1 requests\b|\b1 hosts\b|\b1 more requests\b/.test(text), false, `a count of one in the plural: ${text}`);
    }
  }
});

test("over several hosts, the summaries count across them and the hosts with no stack are counted once each", () => {
  const zero = { redirected: 0, withoutStack: 0, withoutNamedScript: 0, notListed: 0, unobserved: 0 };
  const stacks = [
    entryOf("pixel.charlie.com", [1], zero),
    entryOf("img.delta.net", [], { ...zero, withoutStack: 1 }),
    entryOf("cdn.foxtrot.net", [], { ...zero, redirected: 1 }),
    entryOf("cdn.golf.net", [], { ...zero, unobserved: 1 }),
    entryOf("cdn.hotel.net", [], { ...zero, withoutNamedScript: 1 }),
    entryOf("{label}.lima.net", [1], { ...zero, withoutStack: 1 }),
    entryOf("img.echo.net", [], { ...zero, withoutStack: 3 })
  ];
  const evidence = evidenceWith(stacks);
  assert.ok(evidence);
  const copy = scrollCheckStacksCopy(evidence.scroll);
  assert.deepEqual(copy, {
    heading: "Which scripts asked for them",
    lines: [
      "pixel.charlie.com: 1 request. Scripts on the call stack, innermost first: static.bravo.org then cdn.alpha.net.",
      "*.lima.net: 1 request. Scripts on the call stack, innermost first: static.bravo.org then cdn.alpha.net.",
      "2 of these hosts came with no call stack, so no script is named; the browser gives none for requests the page's HTML starts, nor for images a script creates.",
      "1 more request to these hosts came with no call stack, so no script is named for it.",
      "1 of these hosts' requests followed a redirect, so it carries the call stack of the request that started it, and no script is shown for it.",
      "1 of these hosts' requests had no script on the call stack with an address this visit requested, so no script is named."
    ],
    caveat: INSPECTION_CAVEAT,
    unobserved: "1 of these hosts' requests was not observed, so nothing is shown for it."
  });
  // Two entry shapes side by side, every pair the validator admits from a
  // sample of each, keep the same line rules.
  const left = entryShapes("cdn.left.net").filter((_entry, index) => index % 37 === 0);
  const right = entryShapes("cdn.right.org").filter((_entry, index) => index % 41 === 0);
  for (const a of left) {
    for (const b of right) {
      const pair = evidenceWith([a, b]);
      if (!pair) continue;
      const lines = scrollCheckStacksCopy(pair.scroll)?.lines ?? [];
      const noStackHosts = [a, b].filter((entry) => entry.withoutStack === entry.requests).length;
      assert.equal(lines.includes(scrollCheckNoStackHostsLine(noStackHosts)), noStackHosts > 0, JSON.stringify([a, b]));
      const redirected = a.redirected + b.redirected;
      assert.equal(lines.includes(scrollCheckStacksRedirectedLine(redirected)), redirected > 0);
    }
  }
});
