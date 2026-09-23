import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CUSTOM_EVENT_LABEL,
  MAX_DECODED_BODY_CHARS,
  META_STANDARD_EVENTS,
  TIKTOK_STANDARD_EVENTS,
  X_EVENT_NAMES,
  decodePixelRequest,
  inspectPixelRequest,
  summarizePixelEvents,
  type PixelEventInput
} from "./pixel-events";
import {
  ADMITTED_PIXEL_CUSTOM_EVENT_LABEL,
  admittedPixelEventVocabulary
} from "./redact-scan-report-v1";

const HASH = "a".repeat(64);

test("inherited object keys never become identifier categories", () => {
  const inputs: PixelEventInput[] = [
    { url: "https://www.facebook.com/tr?ev=PageView&ud[constructor]=value&ud[__proto__]=value&ud[em]=value" },
    { url: "https://analytics.tiktok.com/api/v2/pixel", postData: '{"event":"Pageview","user":{"constructor":"value","__proto__":"value","toString":"value","email":"value"}}' }
  ];
  for (const input of inputs) {
    const inspection = inspectPixelRequest(input);
    assert.equal(inspection?.bodyDecoded, true);
    assert.deepEqual(inspection?.decoded.advancedMatching, ["email"]);
    const summary = JSON.parse(JSON.stringify(summarizePixelEvents([input])));
    assert.deepEqual(summary[0].advancedMatching, ["email"], "the JSON boundary cannot acquire null, object, or function categories");
  }
});

test("unsupported pixel bodies remain recognized endpoints with incomplete decoding", () => {
  for (const postData of [null, "", "{\"event\":", "opaque-data", "42", '{"unknown":{"email":"value"}}']) {
    const inspection = inspectPixelRequest({ url: "https://analytics.tiktok.com/api/v2/pixel", method: "POST", postData });
    assert.ok(inspection);
    assert.equal(inspection.bodyDecoded, false, String(postData));
    assert.deepEqual(inspection.decoded.events, []);
  }
  for (const postData of [
    '{"ev":"Purchase"}',
    "opaque-data",
    "x".repeat(MAX_DECODED_BODY_CHARS + 1),
    // Contains "=", so it passed as a urlencoded form while carrying no pair.
    '--b\r\nContent-Disposition: form-data; name="ev"\r\n\r\nPurchase'
  ]) {
    const inspection = inspectPixelRequest({ url: "https://www.facebook.com/tr?ev=PageView", method: "POST", postData });
    assert.equal(inspection?.bodyDecoded, false);
    assert.deepEqual(inspection?.decoded.events, ["PageView"], "a body failure does not discard a decoded query label");
  }
  assert.equal(inspectPixelRequest({ url: "https://unrelated.example/", postData: "invalid" }), null);
});

test("mixed and multiple TikTok batches retain positives while exposing unparsed entries", () => {
  const inspect = (body: unknown) => inspectPixelRequest({ url: "https://analytics.tiktok.com/api/v2/pixel", postData: JSON.stringify(body) });
  const mixed = inspect({ batch: [{ event: "Pageview", user: { email: HASH } }, null] });
  assert.equal(mixed?.bodyDecoded, false);
  assert.deepEqual(mixed?.decoded.events, ["Pageview"]);
  assert.deepEqual(mixed?.decoded.advancedMatching, ["email"]);
  const complete = inspect({ batch: [{ event: "Pageview" }], events: [{ event: "ViewContent", user: { phone: HASH } }] });
  assert.equal(complete?.bodyDecoded, true);
  assert.deepEqual(complete?.decoded.events, ["Pageview", "ViewContent"]);
  assert.deepEqual(complete?.decoded.advancedMatching, ["phone"]);
  assert.equal(inspect({ batch: [] })?.bodyDecoded, true, "an explicitly empty supported batch is decoded");
  assert.equal(inspect({ event: "Pageview", user: "opaque" })?.bodyDecoded, false);
  assert.equal(inspect({ event: "Pageview", user: { email: 123 } })?.bodyDecoded, false);
  assert.equal(inspect({ event: "Pageview", batch: "opaque" })?.bodyDecoded, false);
  assert.equal(inspect({ event: "Pageview", context: "opaque" })?.bodyDecoded, false);
  const bothUsers = inspect({ event: "Pageview", context: { user: { email: HASH } }, user: { phone: HASH } });
  assert.equal(bothUsers?.bodyDecoded, true);
  assert.deepEqual(bothUsers?.decoded.advancedMatching, ["email", "phone"]);
  const unnamed = inspect({ batch: [{ user: { email: HASH } }] });
  assert.equal(unnamed?.bodyDecoded, false);
  assert.deepEqual(unnamed?.decoded.events, []);
  assert.deepEqual(unnamed?.decoded.advancedMatching, ["email"], "a missing event label must not discard an observed identifier field");
  let nested: unknown = { event: "Pageview" };
  for (let i = 0; i < 100; i++) nested = { batch: [nested] };
  assert.equal(inspect(nested)?.bodyDecoded, false, "deep input is bounded and disclosed");
});

test("X purchase classification requires a finite positive decimal", () => {
  for (const key of ["tw_sale_amount", "tw_order_quantity"]) {
    for (const value of ["", "0", "0.00", "-1", "not-a-number", "Infinity", "0x10", "1e9"]) {
      const decoded = decodePixelRequest({url: `https://analytics.twitter.com/i/adsct?${key}=${encodeURIComponent(value)}`});
      assert.ok(!decoded?.events.includes("Purchase"), `${key}=${value}`);
    }
    for (const value of ["1", "49.99", ".50"]) {
      assert.deepEqual(decodePixelRequest({url: `https://analytics.twitter.com/i/adsct?${key}=${value}`})?.events, ["Purchase"]);
    }
  }
});

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

// The exact framing Chromium sends for navigator.sendBeacon(url, FormData),
// which is how fbevents.js flushes its beacon transport (captured from
// headless Chromium through Playwright's request.postData()).
const BOUNDARY = "----WebKitFormBoundaryJ35BhSdbXodubXgB";
const formPart = (name: string, value: string, boundary = BOUNDARY): string =>
  `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const formBody = (parts: Array<[string, string]>, boundary = BOUNDARY): string =>
  parts.map(([name, value]) => formPart(name, value, boundary)).join("") + `--${boundary}--\r\n`;

test("Meta: a FormData beacon body decodes each multipart part", () => {
  const body = formBody([
    ["id", "1234567890"],
    ["ev", "Purchase"],
    // A part value is raw text, never a nested urlencoded form.
    ["dl", "https://shop.example/checkout?ev=Lead&ud[ph]=5551234"],
    ["ud[em]", HASH],
    ["ud[ph]", ""],
    ["cd[value]", "49.99"]
  ]);
  for (const contentType of [
    undefined,
    `multipart/form-data; boundary=${BOUNDARY}`,
    `Multipart/Form-Data; Boundary="${BOUNDARY}"`,
    // A mislabeled body is still read by its own framing, never as urlencoded.
    "text/plain;charset=UTF-8"
  ]) {
    const input: PixelEventInput = { url: "https://www.facebook.com/tr/", method: "POST", postData: body, contentType };
    const inspection = inspectPixelRequest(input);
    assert.equal(inspection?.bodyDecoded, true, String(contentType));
    assert.deepEqual(inspection?.decoded.events, ["Purchase"], String(contentType));
    assert.deepEqual(inspection?.decoded.advancedMatching, ["email"], String(contentType));
    const summary = JSON.stringify(summarizePixelEvents([input]));
    assert.ok(!summary.includes(HASH), "the identifier value is only tested for emptiness");
  }

  const x = inspectPixelRequest({
    url: "https://analytics.twitter.com/i/adsct",
    method: "POST",
    postData: formBody([["txn_id", "abc"], ["tw_sale_amount", "49.99"]])
  });
  assert.equal(x?.bodyDecoded, true);
  assert.deepEqual(x?.decoded.events, ["Purchase"], "X reads the same form parts");

  const dashLeadingForm = inspectPixelRequest({ url: "https://www.facebook.com/tr/", method: "POST", postData: "--flag=1&ev=Lead" });
  assert.equal(dashLeadingForm?.bodyDecoded, true, "a urlencoded body is not multipart without a delimiter line");
  assert.deepEqual(dashLeadingForm?.decoded.events, ["Lead"]);
});

test("Meta: a malformed or unsupported multipart body is not decoded but keeps its closed parts", () => {
  const cd = (name: string) => `Content-Disposition: form-data; name="${name}"`;
  const close = `--${BOUNDARY}--\r\n`;
  const lead = formPart("ev", "Purchase");
  const email = formPart("ud[em]", HASH);
  const cases: Array<{ name: string; postData: string; contentType?: string; events: string[]; advancedMatching: string[] }> = [
    { name: "no close delimiter", postData: lead + `--${BOUNDARY}\r\n${cd("ud[em]")}\r\n\r\n${HASH}`, events: ["Purchase"], advancedMatching: [] },
    { name: "part with no blank line", postData: lead + `--${BOUNDARY}\r\n${cd("ud[em]")}\r\n${HASH}\r\n` + close, events: ["Purchase"], advancedMatching: [] },
    { name: "part with no header block", postData: lead + `--${BOUNDARY}\r\n\r\n${HASH}\r\n` + email + close, events: ["Purchase"], advancedMatching: ["email"] },
    {
      name: "file part",
      postData: lead + `--${BOUNDARY}\r\n${cd("upload")}; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n` + email + close,
      events: ["Purchase"],
      advancedMatching: ["email"]
    },
    { name: "filename parameter", postData: `--${BOUNDARY}\r\n${cd("ev")}; filename="blob"\r\n\r\nLead\r\n` + email + close, events: [], advancedMatching: ["email"] },
    { name: "extra part header", postData: `--${BOUNDARY}\r\n${cd("ev")}\r\nContent-Type: text/plain\r\n\r\nLead\r\n` + email + close, events: [], advancedMatching: ["email"] },
    { name: "LF-only framing", postData: `--${BOUNDARY}\n${cd("ev")}\n\nPurchase\n--${BOUNDARY}--\n`, events: [], advancedMatching: [] },
    { name: "epilogue after the close delimiter", postData: lead + email + close + "ev=Lead", events: ["Purchase"], advancedMatching: ["email"] },
    { name: "declared type without a boundary", postData: lead + email + close, contentType: "multipart/form-data", events: [], advancedMatching: [] },
    { name: "declared boundary absent from the body", postData: lead + email + close, contentType: "multipart/form-data; boundary=other", events: [], advancedMatching: [] },
    { name: "declared boundary a prefix of the body's", postData: lead + email + close, contentType: "multipart/form-data; boundary=----WebKitFormBoundary", events: [], advancedMatching: [] },
    {
      name: "first line is not the declared delimiter",
      postData: `--${"x".repeat(BOUNDARY.length)}\r\n${cd("ev")}\r\n\r\nPurchase\r\n` + close,
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
      events: [],
      advancedMatching: []
    }
  ];
  for (const { name, postData, contentType, events, advancedMatching } of cases) {
    const inspection = inspectPixelRequest({ url: "https://www.facebook.com/tr/", method: "POST", postData, contentType });
    assert.equal(inspection?.bodyDecoded, false, name);
    assert.deepEqual(inspection?.decoded.events, events, name);
    assert.deepEqual(inspection?.decoded.advancedMatching, advancedMatching, name);
  }
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

test("the producer vocabulary and the frozen redaction snapshot agree", () => {
  // The admitted pixel event names are written out twice: the producer decides
  // what a scan can identify (this module), and lib/redact-scan-report-v1.ts
  // keeps its own frozen snapshot because that snapshot feeds
  // PUBLIC_STRING_POLICY_DIGEST and therefore the published normalization
  // identity of every committed report. The two are deliberately NOT wired
  // together: importing one into the other would let an ordinary producer edit
  // silently move a frozen contract.
  //
  // Nothing bound them, though, so they could drift. If Meta shipped a new
  // standard event and only the producer list learned it, a scan that
  // positively identified that event would have it rewritten to "custom event"
  // on publication, telling the reader the site fired something unidentified,
  // while both modules' own tests stayed green. This is the binding: drift now
  // fails here, where the person editing the producer list sees it, and the
  // fix is a deliberate identity move rather than a silent downgrade.
  const admitted = admittedPixelEventVocabulary();

  assert.equal(
    CUSTOM_EVENT_LABEL,
    ADMITTED_PIXEL_CUSTOM_EVENT_LABEL,
    "the generalized label must read identically on both sides"
  );

  const producer: Record<string, string[]> = {
    Meta: [...META_STANDARD_EVENTS.values()].sort(),
    TikTok: [...TIKTOK_STANDARD_EVENTS.values()].sort(),
    X: [...X_EVENT_NAMES].sort()
  };

  assert.deepEqual(
    Object.keys(admitted).sort(),
    Object.keys(producer).sort(),
    "both sides must cover the same platforms"
  );

  for (const [platform, names] of Object.entries(producer)) {
    assert.ok(names.length > 0, `${platform} vocabulary must be non-empty`);
    assert.deepEqual(
      admitted[platform].events.filter((name) => name !== ADMITTED_PIXEL_CUSTOM_EVENT_LABEL),
      names,
      `${platform}: the producer can identify an event the published vocabulary does not admit, so publication would generalize it to "custom event"`
    );
  }
});
