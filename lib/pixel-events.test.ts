import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DECODED_BODY_CHARS, decodePixelRequest, summarizePixelEvents, type PixelEventInput } from "./pixel-events";

const HASH = "a".repeat(64);

// --- Meta -------------------------------------------------------------------

test("Meta: a plain /tr GET yields the event name and no advanced matching", () => {
  const decoded = decodePixelRequest({ url: "https://www.facebook.com/tr/?id=123&ev=PageView&dl=https%3A%2F%2Fshop.example" });
  assert.deepEqual(decoded, { platform: "Meta", product: "Meta Pixel", events: ["PageView"], advancedMatching: [] });
});

test("Meta: advanced-matching keys map to identifier categories, values are ignored", () => {
  const decoded = decodePixelRequest({
    url: `https://www.facebook.com/tr/?id=1&ev=Purchase&ud%5Bem%5D=${HASH}&ud%5Bph%5D=${HASH}&ud%5Bexternal_id%5D=abc&ud%5Bzp%5D=${HASH}`
  });
  assert.equal(decoded?.events.join(","), "Purchase");
  // decodePixelRequest preserves request order; summarizePixelEvents canonicalises it.
  assert.deepEqual(decoded?.advancedMatching, ["email", "phone", "external_id", "address"]);
});

test("Meta: an empty advanced-matching value is not counted as present", () => {
  const decoded = decodePixelRequest({ url: "https://www.facebook.com/tr/?id=1&ev=Lead&ud%5Bem%5D=" });
  assert.deepEqual(decoded?.advancedMatching, []);
});

test("Meta: a PII-shaped ev value is generalized, not dropped", () => {
  // The safe-token filter decides whether the RAW STRING may be looked up, not
  // whether an event happened. Dropping the event left a decoded pixel with
  // zero events while the report still headlined "reported specific named
  // events, not just their presence" -- an unnameable event is still an event.
  // The security property is unchanged: the value never reaches the report.
  const decoded = decodePixelRequest({ url: `https://www.facebook.com/tr/?id=1&ev=${HASH}` });
  assert.deepEqual(decoded?.events, ["custom event"]);
  assert.ok(!JSON.stringify(decoded).includes(HASH));
});

test("Meta: a non-ASCII custom event name is counted as a custom event", () => {
  // Real regression: a French site firing fbq('trackCustom', 'Lead - Formulaire
  // contact') with an en dash produced events: [] and a pixel card claiming
  // specific named events.
  const decoded = decodePixelRequest({
    url: "https://www.facebook.com/tr/?id=1&ev=Lead%20%E2%80%93%20Formulaire%20contact"
  });
  assert.deepEqual(decoded?.events, ["custom event"]);
  assert.ok(!JSON.stringify(decoded).includes("Formulaire"));
});

test("Meta: non-standard event names are generalized, never persisted", () => {
  // A site-defined event token can carry a visitor's name or account handle;
  // the report keeps the standard vocabulary verbatim and generalizes the rest.
  const decoded = decodePixelRequest({
    url: "https://www.facebook.com/tr/?id=1&ev=Purchase&ev=JohnSmithSignup&ev=Account%20renamed"
  });
  assert.deepEqual(decoded?.events.sort(), ["Purchase", "custom event"]);
  assert.ok(!JSON.stringify(decoded).includes("JohnSmithSignup"));
});

test("Meta: standard event names are canonicalized case-insensitively", () => {
  const decoded = decodePixelRequest({ url: "https://www.facebook.com/tr/?id=1&ev=pageview" });
  assert.deepEqual(decoded?.events, ["PageView"]);
});

test("TikTok: non-standard event names are generalized, never persisted", () => {
  const decoded = decodePixelRequest({
    url: "https://analytics.tiktok.com/api/v2/pixel",
    method: "POST",
    postData: JSON.stringify({
      batch: [{ event: "ViewContent" }, { event: "jane.doe@example signup" }, { event: "LoyaltyTierGold" }]
    })
  });
  assert.deepEqual(decoded?.events.sort(), ["ViewContent", "custom event"]);
  assert.ok(!JSON.stringify(decoded).includes("LoyaltyTierGold"));
});

test("Meta: a urlencoded POST body is merged with the query string", () => {
  const decoded = decodePixelRequest({
    url: "https://www.facebook.com/tr/?id=1",
    method: "POST",
    postData: `ev=ViewContent&ud%5Bem%5D=${HASH}`
  });
  assert.deepEqual(decoded?.events, ["ViewContent"]);
  assert.deepEqual(decoded?.advancedMatching, ["email"]);
});

// --- TikTok -----------------------------------------------------------------

test("TikTok: a single POST event yields the event name and hashed identifiers", () => {
  const decoded = decodePixelRequest({
    url: "https://analytics.tiktok.com/api/v2/pixel",
    method: "POST",
    postData: JSON.stringify({
      event: "CompletePayment",
      context: { user: { email: HASH, phone_number: HASH }, page: { url: "x" } },
      properties: { value: 10 }
    })
  });
  assert.deepEqual(decoded?.events, ["CompletePayment"]);
  assert.deepEqual(decoded?.advancedMatching, ["email", "phone"]);
});

test("TikTok: a batched body decodes every event object", () => {
  const decoded = decodePixelRequest({
    url: "https://analytics.tiktok.com/api/v2/pixel/batch",
    method: "POST",
    postData: JSON.stringify({
      batch: [
        { event: "ViewContent", context: { user: { external_id: "abc" } } },
        { event: "AddToCart", context: { user: {} } }
      ]
    })
  });
  assert.deepEqual(decoded?.events.sort(), ["AddToCart", "ViewContent"]);
  assert.deepEqual(decoded?.advancedMatching, ["external_id"]);
});

test("TikTok: empty user values are not treated as identifiers", () => {
  const decoded = decodePixelRequest({
    url: "https://analytics.tiktok.com/api/v2/pixel",
    method: "POST",
    postData: JSON.stringify({ event: "Pageview", context: { user: { email: "" } } })
  });
  assert.deepEqual(decoded?.advancedMatching, []);
});

test("TikTok: a malformed body is tolerated", () => {
  const decoded = decodePixelRequest({ url: "https://analytics.tiktok.com/api/v2/pixel", method: "POST", postData: "not json" });
  assert.deepEqual(decoded, { platform: "TikTok", product: "TikTok Pixel", events: [], advancedMatching: [] });
});

// --- X (Twitter) ------------------------------------------------------------

test("X: an order-value adsct request reads as a purchase", () => {
  const decoded = decodePixelRequest({ url: "https://analytics.twitter.com/i/adsct?txn_id=abc&tw_sale_amount=49.99&type=javascript" });
  assert.deepEqual(decoded, { platform: "X", product: "X (Twitter) Pixel", events: ["Purchase"], advancedMatching: [] });
});

test("X: a plain adsct request reads as conversion tracking, on t.co too", () => {
  const decoded = decodePixelRequest({ url: "https://t.co/i/adsct?txn_id=abc&type=javascript" });
  assert.deepEqual(decoded?.events, ["Conversion tracking"]);
});

// --- non-pixel + aggregation ------------------------------------------------

test("a non-pixel request decodes to null", () => {
  assert.equal(decodePixelRequest({ url: "https://cdn.example.com/app.js" }), null);
  assert.equal(decodePixelRequest({ url: "https://www.facebook.com/sharer.php" }), null);
});

test("summarizePixelEvents merges per platform, dedupes, counts requests, and orders Meta/TikTok/X", () => {
  const inputs: PixelEventInput[] = [
    { url: "https://www.facebook.com/tr/?id=1&ev=PageView" },
    { url: `https://www.facebook.com/tr/?id=1&ev=Purchase&ud%5Bem%5D=${HASH}` },
    { url: "https://analytics.twitter.com/i/adsct?txn_id=a&type=javascript" },
    { url: "https://cdn.example.com/ignored.js" }
  ];

  const summary = summarizePixelEvents(inputs);
  assert.deepEqual(
    summary.map((pixel) => pixel.platform),
    ["Meta", "X"]
  );

  const meta = summary[0];
  assert.deepEqual(meta.events, ["PageView", "Purchase"]);
  assert.deepEqual(meta.advancedMatching, ["email"]);
  assert.equal(meta.requests, 2);
});

test("summarizePixelEvents never stores a raw identifier value, only category labels", () => {
  const summary = summarizePixelEvents([{ url: `https://www.facebook.com/tr/?id=1&ev=Lead&ud%5Bem%5D=${HASH}` }]);
  assert.ok(!JSON.stringify(summary).includes(HASH));
  assert.deepEqual(summary[0].advancedMatching, ["email"]);
});

test("decodePixelRequest ignores an over-large POST body but still reads the URL", () => {
  // The TikTok event lives in the JSON body; past the cap it is treated as absent,
  // so nothing is parsed out of the oversized string (no crash, no smuggled data).
  const oversized = `{"event":"Purchase","x":"${"a".repeat(MAX_DECODED_BODY_CHARS)}"}`;
  const tiktok = decodePixelRequest({
    url: "https://analytics.tiktok.com/api/v2/pixel?sdkid=1",
    method: "POST",
    postData: oversized
  });
  assert.deepEqual(tiktok?.events, []);
  assert.deepEqual(tiktok?.advancedMatching, []);

  // A cap-exceeding urlencoded body is skipped, but URL query params still decode.
  const urlEncoded = decodePixelRequest({
    url: "https://www.facebook.com/tr/?id=1&ev=PageView",
    method: "POST",
    postData: `pad=${"a".repeat(MAX_DECODED_BODY_CHARS)}`
  });
  assert.equal(urlEncoded?.events.join(","), "PageView");
});
