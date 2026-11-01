import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";
import * as productionModule from "./request-initiator";
import { MAX_TRACKED_INITIATORS, type RequestInitiatorIndex } from "./request-initiator";

/**
 * RA8, a bounded check of the attribution refusal rule: when a request row may name
 * the initiator Chromium reported for its URL.
 *
 * Domain: every order of up to 5 events over 2 URLs, each event one observation (with
 * one of 2 initiators, or none) or one request the page reported. Within that bound
 * the rule holds for all inputs at this commit, and since each claim's answer is held
 * to the counts alone, it holds whichever stream arrives first.
 *
 * This holds the rule, not its parser. Two questions about what Chromium sends stay
 * measurements: whether a preflight's initiator differs from its request's, and
 * whether a page-side URL can carry a fragment the observation's does not.
 */

type InitiatorModule = typeof productionModule;

const URLS = ["https://pixel.example.net/a", "https://pixel.example.net/b"] as const;
const INITIATORS = ["https://cdn.example.net/one.js", "https://cdn.example.net/two.js", null] as const;

type Event = { kind: "observation"; url: string; initiator: string | null } | { kind: "request"; url: string };

const EVENTS: readonly Event[] = URLS.flatMap((url) => [
  ...INITIATORS.map((initiator): Event => ({ kind: "observation", url, initiator })),
  { kind: "request", url } as Event
]);

function apply(index: RequestInitiatorIndex, event: Event): void {
  if (event.kind === "observation") index.record({ requestUrl: event.url, initiatorUrl: event.initiator });
  else index.noteRequest(event.url);
}

function eachOrder(maximum: number, visit: (events: readonly Event[]) => void): number {
  let cases = 0;
  const events: Event[] = [];
  const walk = () => {
    cases += 1;
    visit(events);
    if (events.length === maximum) return;
    for (const event of EVENTS) {
      events.push(event);
      walk();
      events.pop();
    }
  };
  walk();
  return cases;
}

function checkClaims(module: InitiatorModule): number {
  return eachOrder(5, (events) => {
    const index = new module.RequestInitiatorIndex();
    for (const event of events) apply(index, event);
    const input = () => ({ events: [...events] });
    const observedWithInitiator = events.filter((event) => event.kind === "observation" && event.initiator !== null).length;
    holds("observed-counts-every-named-initiator", index.stats().observed === observedWithInitiator, input);

    for (const url of URLS) {
      const named = events.filter((event) => event.kind === "observation" && event.url === url) as Extract<Event, { kind: "observation" }>[];
      const requests = events.filter((event) => event.kind === "request" && event.url === url).length;
      const distinct = new Set(named.map((event) => event.initiator));
      const before = index.stats();
      const claimed = index.claim(url);
      const after = index.stats();
      const claimInput = () => ({ events: [...events], url, claimed, before, after });

      const attributed = after.attributed - before.attributed;
      const ambiguous = after.ambiguous - before.ambiguous;
      const refused = after.refusedUnobserved - before.refusedUnobserved;

      // Every claim lands in one outcome, and an answer is always the attributed one.
      holds("a-claim-lands-in-one-outcome", attributed + ambiguous + refused <= 1, claimInput);
      holds("an-answer-is-counted-as-attributed", (claimed !== null) === (attributed === 1), claimInput);

      // What an answer rests on, stated from the counts and not from the code's order.
      holds("an-answer-is-what-every-observation-named", claimed === null || named.every((event) => event.initiator === claimed), claimInput);
      holds("an-answer-backs-every-request-it-covers", claimed === null || (requests >= 1 && requests <= named.length), claimInput);

      const again = index.claim(url);
      const afterAgain = index.stats();
      holds(
        "a-claim-consumes-nothing",
        again === claimed &&
          afterAgain.attributed - after.attributed === attributed &&
          afterAgain.ambiguous - after.ambiguous === ambiguous &&
          afterAgain.refusedUnobserved - after.refusedUnobserved === refused,
        claimInput
      );

      // This restates the claim's order, so it catches the code drifting from that order, not a wrong order.
      const unanimous = distinct.size === 1 ? [...distinct][0] : undefined;
      if (distinct.size > 1) holds("conflicting-initiators-are-ambiguous", claimed === null && ambiguous === 1, claimInput);
      else if (named.length === 0) holds("a-url-with-no-observation-moves-no-count", claimed === null && attributed + ambiguous + refused === 0, claimInput);
      else if (unanimous === null) holds("observations-naming-no-initiator-move-no-count", claimed === null && attributed + ambiguous + refused === 0, claimInput);
      else if (requests === 0 || requests > named.length) holds("a-shortfall-of-observations-is-refused", claimed === null && refused === 1, claimInput);
      else holds("a-unanimous-url-with-enough-observations-is-attributed", claimed === unanimous, claimInput);
    }
  });
}

/** Past either table's bound, nothing the table lost can be claimed, and the loss is counted. */
function checkBounds(module: InitiatorModule): void {
  const url = (index: number) => `https://pixel.example.net/${index}`;
  const initiator = "https://cdn.example.net/one.js";

  const observations = new module.RequestInitiatorIndex();
  for (let index = 0; index < MAX_TRACKED_INITIATORS; index += 1) observations.record({ requestUrl: url(index), initiatorUrl: initiator });
  observations.record({ requestUrl: url(0), initiatorUrl: initiator });
  holds("a-known-url-is-not-dropped-at-the-bound", observations.stats().dropped === 0, () => observations.stats());
  observations.record({ requestUrl: "https://pixel.example.net/past", initiatorUrl: initiator });
  observations.noteRequest("https://pixel.example.net/past");
  holds("an-observation-past-the-bound-is-counted-as-dropped", observations.stats().dropped === 1, () => observations.stats());
  holds("an-observation-past-the-bound-claims-nothing", observations.claim("https://pixel.example.net/past") === null, () => observations.stats());

  const requests = new module.RequestInitiatorIndex();
  for (let index = 0; index < MAX_TRACKED_INITIATORS; index += 1) requests.noteRequest(url(index));
  requests.noteRequest(url(0));
  holds("a-known-url-is-not-dropped-at-the-bound", requests.stats().requestsDropped === 0, () => requests.stats());
  requests.record({ requestUrl: "https://pixel.example.net/past", initiatorUrl: initiator });
  requests.noteRequest("https://pixel.example.net/past");
  holds("a-request-past-the-bound-is-counted-as-dropped", requests.stats().requestsDropped === 1, () => requests.stats());
  // Its observation is held, but its count is not, so the row is refused rather than claimed.
  holds("a-request-past-the-bound-claims-nothing", requests.claim("https://pixel.example.net/past") === null && requests.stats().refusedUnobserved === 1, () => requests.stats());
}

const modulePath = require.resolve("./request-initiator");
const variant = (...edits: SourceEdit[]) => loadVariant<InitiatorModule>(modulePath, edits);

test("RA8: every claim lands in one outcome, and an answer rests on every observation and request of its URL", () => {
  assert.equal(EVENTS.length, 8);
  // Orders of up to 5 of the 8 events.
  assert.equal(checkClaims(productionModule), 1 + 8 + 8 ** 2 + 8 ** 3 + 8 ** 4 + 8 ** 5);
});

test("RA8: nothing past a table's bound is claimed, and the loss is counted", () => {
  checkBounds(productionModule);
});

for (const [name, property, find, replace] of [
  [
    "a conflict goes unnoticed",
    "conflicting-initiators-are-ambiguous",
    "if (existing.initiatorUrl !== observation.initiatorUrl)\n                existing.conflicting = true;\n",
    ""
  ],
  [
    "a conflict is answered, and counted as attributed",
    "an-answer-is-what-every-observation-named",
    "this.ambiguous += 1;\n            return null;",
    "this.attributed += 1;\n            return entry.initiatorUrl;"
  ],
  [
    "a conflict lands in two outcomes",
    "a-claim-lands-in-one-outcome",
    "this.ambiguous += 1;\n            return null;",
    "this.ambiguous += 1;\n            this.refusedUnobserved += 1;\n            return null;"
  ],
  [
    "a URL nobody observed is counted as refused",
    "a-url-with-no-observation-moves-no-count",
    "if (!entry)\n            return null;",
    "if (!entry) {\n            this.refusedUnobserved += 1;\n            return null;\n        }"
  ],
  [
    "an attribution is counted once per URL",
    "a-claim-consumes-nothing",
    "this.attributed += 1;\n",
    "if (!entry.counted)\n            this.attributed += 1;\n        entry.counted = true;\n"
  ],
  [
    "a claim uses up an observation",
    "a-claim-consumes-nothing",
    "this.attributed += 1;\n",
    "this.attributed += 1;\n        entry.observations -= 1;\n"
  ],
  [
    "a conflict is answered but counted ambiguous",
    "an-answer-is-counted-as-attributed",
    "this.ambiguous += 1;\n            return null;",
    "this.ambiguous += 1;\n            return entry.initiatorUrl;"
  ],
  [
    "a conflict is not counted",
    "conflicting-initiators-are-ambiguous",
    "this.ambiguous += 1;\n            return null;",
    "return null;"
  ],
  [
    "a request nobody reported can be claimed",
    "an-answer-backs-every-request-it-covers",
    "if (requests === 0 || requests > entry.observations) {",
    "if (requests > entry.observations) {"
  ],
  [
    "more requests than observations can be claimed",
    "an-answer-backs-every-request-it-covers",
    "if (requests === 0 || requests > entry.observations) {",
    "if (requests === 0) {"
  ],
  [
    "equal counts are refused",
    "a-unanimous-url-with-enough-observations-is-attributed",
    "requests > entry.observations",
    "requests >= entry.observations"
  ],
  [
    "a second observation is not counted",
    "a-unanimous-url-with-enough-observations-is-attributed",
    "existing.observations += 1;\n",
    ""
  ],
  [
    "a refusal is not counted",
    "a-shortfall-of-observations-is-refused",
    "this.refusedUnobserved += 1;\n            return null;",
    "return null;"
  ],
  [
    "an observation naming nothing is counted as refused",
    "observations-naming-no-initiator-move-no-count",
    "if (entry.initiatorUrl === null)\n            return null;\n",
    ""
  ],
  [
    "an attribution is not counted",
    "an-answer-is-counted-as-attributed",
    "this.attributed += 1;\n",
    ""
  ],
  [
    "a claim counts another URL's requests",
    "an-answer-backs-every-request-it-covers",
    "const requests = (_a = this.requestsByUrl.get(requestUrl)) !== null && _a !== void 0 ? _a : 0;",
    "const requests = [...this.requestsByUrl.values()].reduce((sum, count) => sum + count, 0);"
  ],
  [
    "an observation naming nothing is counted as observed",
    "observed-counts-every-named-initiator",
    "if (observation.initiatorUrl !== null)\n            this.observed += 1;",
    "this.observed += 1;"
  ]
] as const) {
  test(`RA8 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkClaims(variant({ find, replace })));
  });
}

for (const [name, property, find, replace] of [
  ["the observation table has no bound", "an-observation-past-the-bound-is-counted-as-dropped", "if (this.byUrl.size >= exports.MAX_TRACKED_INITIATORS) {", "if (false) {"],
  ["the request table has no bound", "a-request-past-the-bound-is-counted-as-dropped", "if (this.requestsByUrl.size >= exports.MAX_TRACKED_INITIATORS) {", "if (false) {"],
  ["a dropped observation is not counted", "an-observation-past-the-bound-is-counted-as-dropped", "this.dropped += 1;\n", ""],
  ["a dropped request is not counted", "a-request-past-the-bound-is-counted-as-dropped", "this.requestsDropped += 1;\n", ""],
  ["a known URL is dropped at the observation bound", "a-known-url-is-not-dropped-at-the-bound", "if (existing) {", "if (existing && this.byUrl.size < exports.MAX_TRACKED_INITIATORS) {"],
  ["a known URL is dropped at the request bound", "a-known-url-is-not-dropped-at-the-bound", "if (count !== undefined) {", "if (count !== undefined && this.requestsByUrl.size < exports.MAX_TRACKED_INITIATORS) {"],
  ["a dropped observation is still kept", "an-observation-past-the-bound-claims-nothing", "this.dropped += 1;\n            return;", "this.dropped += 1;"],
  ["a dropped request is still counted", "a-request-past-the-bound-claims-nothing", "this.requestsDropped += 1;\n            return;", "this.requestsDropped += 1;"]
] as const) {
  test(`RA8 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkBounds(variant({ find, replace })));
  });
}
