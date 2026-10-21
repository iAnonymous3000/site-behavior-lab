import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initiatorObservationFromCdpParams,
  MAX_TRACKED_INITIATORS,
  RequestInitiatorIndex
} from "./request-initiator";

// The value of this module is what it REFUSES to attribute. A test suite that
// only proved the happy path would pass against an implementation that guessed.

test("a direct initiator URL is read from the CDP payload", () => {
  const observation = initiatorObservationFromCdpParams({
    request: { url: "https://tracker.example/pixel" },
    initiator: { type: "script", url: "https://site.example/tag.js" }
  });
  assert.deepEqual(observation, {
    requestUrl: "https://tracker.example/pixel",
    initiatorUrl: "https://site.example/tag.js"
  });
});

test("the initiator falls back to the nearest stack frame that names a URL", () => {
  const observation = initiatorObservationFromCdpParams({
    request: { url: "https://tracker.example/p" },
    initiator: {
      type: "script",
      stack: { callFrames: [{ url: "" }, { url: "https://site.example/gtm.js" }] }
    }
  });
  assert.equal(observation?.initiatorUrl, "https://site.example/gtm.js");
});

test("an async parent stack is followed when the immediate frames are anonymous", () => {
  // What the parser does with a parent, not a shape a live scan receives: no
  // stack the scanner reads carries one (see the comment on topStackUrl).
  const observation = initiatorObservationFromCdpParams({
    request: { url: "https://tracker.example/p" },
    initiator: {
      type: "script",
      stack: { callFrames: [], parent: { callFrames: [{ url: "https://site.example/a.js" }] } }
    }
  });
  assert.equal(observation?.initiatorUrl, "https://site.example/a.js");
});

test("a payload with no usable initiator yields an observation with no URL, not a guess", () => {
  assert.deepEqual(initiatorObservationFromCdpParams({ request: { url: "https://a.example/" } }), {
    requestUrl: "https://a.example/",
    initiatorUrl: null
  });
  assert.deepEqual(
    initiatorObservationFromCdpParams({
      request: { url: "https://a.example/" },
      initiator: { type: "other" }
    }),
    { requestUrl: "https://a.example/", initiatorUrl: null }
  );
});

test("malformed payloads are refused rather than partially read", () => {
  assert.equal(initiatorObservationFromCdpParams(null), null);
  assert.equal(initiatorObservationFromCdpParams({}), null);
  assert.equal(initiatorObservationFromCdpParams({ request: {} }), null);
  assert.equal(initiatorObservationFromCdpParams({ request: { url: "" } }), null);
});

test("one URL with one initiator is attributed", () => {
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
  index.noteRequest("https://t.example/p");
  assert.equal(index.claim("https://t.example/p"), "https://s.example/a.js");
  assert.equal(index.stats().attributed, 1);
});

test("one URL requested from TWO different initiators is refused, not guessed", () => {
  // This is the whole point. Joining on URL cannot say which row belongs to
  // which initiator, and picking the first would publish an attribution the
  // evidence does not support.
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/b.js" });
  index.noteRequest("https://t.example/p");
  index.noteRequest("https://t.example/p");
  assert.equal(index.claim("https://t.example/p"), null);
  assert.equal(index.stats().ambiguous, 1);
  assert.equal(index.stats().attributed, 0);
});

test("repeated requests that agree on their initiator stay attributable", () => {
  const index = new RequestInitiatorIndex();
  for (let i = 0; i < 3; i += 1) {
    index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
    index.noteRequest("https://t.example/p");
  }
  for (let i = 0; i < 3; i += 1) assert.equal(index.claim("https://t.example/p"), "https://s.example/a.js");
  assert.equal(index.stats().attributed, 3);
});

test("a later observation with no initiator conflicts with an earlier named one", () => {
  // "Chromium told us nothing this time" is different evidence from "it told us
  // the same thing", so the pair cannot be collapsed into a confident answer.
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: null });
  index.noteRequest("https://t.example/p");
  index.noteRequest("https://t.example/p");
  assert.equal(index.claim("https://t.example/p"), null);
  assert.equal(index.stats().ambiguous, 1);
});

test("a URL requested more often than it was observed is refused on every row, not inherited", () => {
  // The shape a dedicated worker produces: the page and the worker request one
  // URL, the session observes only the page's request, and Playwright reports
  // both rows. The URL join cannot tell which row was the observed one, so
  // crediting both with the page's initiator would publish it on the worker's
  // row too.
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/main.js" });
  index.noteRequest("https://t.example/p");
  index.noteRequest("https://t.example/p");
  assert.equal(index.claim("https://t.example/p"), null);
  assert.equal(index.claim("https://t.example/p"), null);
  assert.equal(index.stats().refusedUnobserved, 2);
  assert.equal(index.stats().attributed, 0);
  assert.equal(index.stats().ambiguous, 0);
});

test("no more requests than agreeing observations stay attributable", () => {
  // Fewer requests than observations is not a shortfall: every request Playwright
  // reported could have been one the session observed.
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
  index.noteRequest("https://t.example/p");
  assert.equal(index.claim("https://t.example/p"), "https://s.example/a.js");
  assert.equal(index.stats().refusedUnobserved, 0);
});

test("a row whose request was never counted is refused, so skipping the count cannot restore the inheriting join", () => {
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
  assert.equal(index.claim("https://t.example/p"), null);
  assert.equal(index.stats().refusedUnobserved, 1);
  assert.equal(index.stats().attributed, 0);
});

test("the count and the observation may arrive in either order", () => {
  // The two streams race, so a request counted before its observation arrived
  // must be joined exactly as one counted after it.
  const countedFirst = new RequestInitiatorIndex();
  countedFirst.noteRequest("https://t.example/p");
  countedFirst.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
  const observedFirst = new RequestInitiatorIndex();
  observedFirst.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
  observedFirst.noteRequest("https://t.example/p");
  assert.equal(countedFirst.claim("https://t.example/p"), "https://s.example/a.js");
  assert.equal(observedFirst.claim("https://t.example/p"), "https://s.example/a.js");
});

test("conflicting observations stay ambiguous even when the requests also outnumber them", () => {
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/b.js" });
  for (let i = 0; i < 3; i += 1) index.noteRequest("https://t.example/p");
  assert.equal(index.claim("https://t.example/p"), null);
  assert.equal(index.stats().ambiguous, 1);
  assert.equal(index.stats().refusedUnobserved, 0);
});

test("a URL observed with no initiator is not a refusal, however many times it was requested", () => {
  // Nothing was there to withhold, so the row is not counted as one the rule refused.
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: null });
  index.noteRequest("https://t.example/p");
  index.noteRequest("https://t.example/p");
  assert.equal(index.claim("https://t.example/p"), null);
  assert.deepEqual(index.stats(), {
    observed: 0,
    attributed: 0,
    ambiguous: 0,
    refusedUnobserved: 0,
    dropped: 0,
    requestsDropped: 0
  });
});

test("an unseen URL is simply unattributed, and counts as neither attributed nor refused", () => {
  // A worker-only URL: Playwright reported it, the session never observed it.
  const index = new RequestInitiatorIndex();
  index.noteRequest("https://worker-only.example/");
  assert.equal(index.claim("https://worker-only.example/"), null);
  assert.equal(index.claim("https://never.example/"), null);
  assert.deepEqual(index.stats(), {
    observed: 0,
    attributed: 0,
    ambiguous: 0,
    refusedUnobserved: 0,
    dropped: 0,
    requestsDropped: 0
  });
});

test("the join table is bounded, and drops are counted rather than silent", () => {
  const index = new RequestInitiatorIndex();
  for (let i = 0; i < MAX_TRACKED_INITIATORS + 5; i += 1) {
    index.record({ requestUrl: `https://t.example/${i}`, initiatorUrl: "https://s.example/a.js" });
    index.noteRequest(`https://t.example/${i}`);
  }
  assert.equal(index.stats().dropped, 5);
  // A dropped observation must read as unattributed, never as attributed.
  assert.equal(index.claim(`https://t.example/${MAX_TRACKED_INITIATORS + 1}`), null);
  assert.equal(index.claim("https://t.example/0"), "https://s.example/a.js");
});

test("the request table is bounded too, and a request it could not count refuses its URL", () => {
  const index = new RequestInitiatorIndex();
  for (let i = 0; i < MAX_TRACKED_INITIATORS; i += 1) index.noteRequest(`https://t.example/${i}`);
  // Observed, but its request arrived after the table was full: the claim
  // cannot show the row was observed, so it is refused rather than treated as
  // a URL with no requests at all.
  index.record({ requestUrl: "https://late.example/p", initiatorUrl: "https://s.example/a.js" });
  index.noteRequest("https://late.example/p");
  assert.equal(index.stats().requestsDropped, 1);
  assert.equal(index.claim("https://late.example/p"), null);
  assert.equal(index.stats().refusedUnobserved, 1);
  // A URL counted before the bound keeps counting after it.
  index.noteRequest("https://t.example/0");
  index.record({ requestUrl: "https://t.example/0", initiatorUrl: "https://s.example/a.js" });
  assert.equal(index.claim("https://t.example/0"), null);
  assert.equal(index.stats().requestsDropped, 1);
});

test("observed counts only what Chromium actually named", () => {
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://a.example/", initiatorUrl: null });
  index.record({ requestUrl: "https://b.example/", initiatorUrl: "https://s.example/a.js" });
  assert.equal(index.stats().observed, 1);
});
