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
  // The common tag-manager shape: the synchronous frames are anonymous and the
  // URL only appears on the async parent.
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
  assert.equal(index.claim("https://t.example/p"), null);
  assert.equal(index.stats().ambiguous, 1);
  assert.equal(index.stats().attributed, 0);
});

test("repeated requests that agree on their initiator stay attributable", () => {
  const index = new RequestInitiatorIndex();
  for (let i = 0; i < 3; i += 1) {
    index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
  }
  assert.equal(index.claim("https://t.example/p"), "https://s.example/a.js");
});

test("a later observation with no initiator conflicts with an earlier named one", () => {
  // "Chromium told us nothing this time" is different evidence from "it told us
  // the same thing", so the pair cannot be collapsed into a confident answer.
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: "https://s.example/a.js" });
  index.record({ requestUrl: "https://t.example/p", initiatorUrl: null });
  assert.equal(index.claim("https://t.example/p"), null);
  assert.equal(index.stats().ambiguous, 1);
});

test("an unseen URL is simply unattributed, and counts as neither attributed nor ambiguous", () => {
  const index = new RequestInitiatorIndex();
  assert.equal(index.claim("https://never.example/"), null);
  assert.deepEqual(index.stats(), { observed: 0, attributed: 0, ambiguous: 0, dropped: 0 });
});

test("the join table is bounded, and drops are counted rather than silent", () => {
  const index = new RequestInitiatorIndex();
  for (let i = 0; i < MAX_TRACKED_INITIATORS + 5; i += 1) {
    index.record({ requestUrl: `https://t.example/${i}`, initiatorUrl: "https://s.example/a.js" });
  }
  assert.equal(index.stats().dropped, 5);
  // A dropped observation must read as unattributed, never as attributed.
  assert.equal(index.claim(`https://t.example/${MAX_TRACKED_INITIATORS + 1}`), null);
});

test("observed counts only what Chromium actually named", () => {
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://a.example/", initiatorUrl: null });
  index.record({ requestUrl: "https://b.example/", initiatorUrl: "https://s.example/a.js" });
  assert.equal(index.stats().observed, 1);
});
