import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePixelRequest, summarizePixelEvents, type PixelEventInput } from "./pixel-events";

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

test("Meta: a PII-shaped ev value is rejected by the safe-token filter", () => {
  const decoded = decodePixelRequest({ url: `https://www.facebook.com/tr/?id=1&ev=${HASH}` });
  assert.deepEqual(decoded?.events, []);
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
