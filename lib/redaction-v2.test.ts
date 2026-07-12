import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INVALID_URL_MARKER,
  INVALID_HOST_MARKER,
  emptyRedactionCounters,
  queryKeyAllowed,
  redactCookieName,
  redactHostnameV2,
  redactPathV2,
  redactStorageKey,
  redactUrlV2,
  tokenShapeMarker
} from "./redaction-v2";

test("malformed and non-http input redacts, never passes through", () => {
  // The exact v1 defect this replaces: report-url returned unparseable URLs unchanged.
  const malformed = redactUrlV2("not a url at all");
  assert.equal(malformed.value, INVALID_URL_MARKER);
  assert.equal(malformed.counters.malformedUrlsDropped, 1);

  const nonHttp = redactUrlV2("javascript:alert(document.cookie)");
  assert.equal(nonHttp.value, INVALID_URL_MARKER);
  assert.equal(nonHttp.counters.malformedUrlsDropped, 1);
});

test("paths are default-deny: only allowlisted route literals survive", () => {
  const redacted = redactUrlV2("https://example.com/products/12345/anna-schmidt/report.pdf");
  // "products" is on the route allowlist; the id, the name, and the file are not.
  assert.equal(redacted.value, "https://example.com/products/{n}/{seg}/{seg}");
  assert.equal(redacted.counters.pathSegmentsGeneralized, 3);

  // A privacy-policy route survives whole.
  assert.equal(redactUrlV2("https://example.com/legal/privacy").value, "https://example.com/legal/privacy");
});

test("health topics and short lowercase words do not survive by shape", () => {
  // The RFC's stated reason for literal allowlists over heuristics: short
  // lowercase words include names and health topics.
  const redacted = redactUrlV2("https://clinic.example/hiv/treatment");
  assert.equal(redacted.value, "https://clinic.example/{seg}/{seg}");
});

test("paths are capped and the overflow is counted", () => {
  const redacted = redactUrlV2("https://example.com/a/b/c/d/e/f/g/h");
  assert.equal(redacted.value, "https://example.com/{seg}/{seg}/{seg}/{seg}/{seg}/{seg}");
  assert.equal(redacted.counters.pathSegmentsGeneralized, 8); // 6 generalized + 2 dropped
});

test("matrix parameters strip before classification", () => {
  const redacted = redactUrlV2("https://example.com/docs;jsessionid=8A7F3C/page");
  assert.equal(redacted.value, "https://example.com/docs/{seg}");
  assert.equal(redacted.counters.matrixParamsStripped, 1);
});

test("query keys survive only via the allowlist; values always drop", () => {
  const redacted = redactUrlV2("https://t.example/collect?utm_source=news&email=anna%40example.com&gclid=abc123", {
    preserveQueryKeys: true
  });
  assert.equal(redacted.value, "https://t.example/{seg}?utm_source=&%5Bredacted%5D=&gclid=");
  assert.equal(redacted.counters.queryKeysRedacted, 1);

  // Without preserveQueryKeys the query drops entirely.
  const dropped = redactUrlV2("https://t.example/collect?utm_source=news", {});
  assert.equal(dropped.value.includes("?"), false);

  assert.equal(queryKeyAllowed("utm_campaign"), true);
  assert.equal(queryKeyAllowed("ud[em]"), true);
  // v1's pattern rule passed any short alphanumeric key; the literal
  // allowlist does not.
  assert.equal(queryKeyAllowed("annaschmidt1987"), false);
});

test("token-shaped subdomain labels generalize; the registrable domain and named services survive", () => {
  assert.equal(redactUrlV2("https://telemetry.example.com/").value, "https://telemetry.example.com/");

  const tokened = redactUrlV2("https://a8f3c9d2e1b4f6a7.telemetry.example.com/");
  assert.equal(tokened.value, "https://{label}.telemetry.example.com/");
  assert.equal(tokened.counters.subdomainLabelsGeneralized, 1);

  const uuid = redactUrlV2("https://123e4567-e89b-12d3-a456-426614174000.cdn.example.com/");
  assert.equal(uuid.value, "https://{label}.cdn.example.com/");

  // Conventional numbered shards are not token-like.
  assert.equal(redactUrlV2("https://cdn2.example.com/").value, "https://cdn2.example.com/");
});

test("cookie names and storage keys are allowlist-or-marker with shape classes", () => {
  const counters = emptyRedactionCounters();
  assert.deepEqual(redactCookieName("_ga", counters), { value: "_ga", preserved: true });
  assert.equal(redactCookieName("8f14e45fceea167a5a36dedd4bea2543", counters).value, "[redacted:hex-like]");
  assert.deepEqual(redactStorageKey("theme", counters), { value: "theme", preserved: true });
  assert.equal(redactStorageKey("user_anna_schmidt", counters).value, "[redacted]");
  assert.equal(counters.cookieNamesRedacted, 1);
  assert.equal(counters.storageKeysRedacted, 1);
});

test("shape markers classify, never authorize survival", () => {
  assert.equal(tokenShapeMarker("123e4567-e89b-12d3-a456-426614174000"), "[redacted:uuid-like]");
  assert.equal(tokenShapeMarker("deadbeefcafe1234"), "[redacted:hex-like]");
  // Numeric wins over hex for digit-only strings (digits are valid hex too).
  assert.equal(tokenShapeMarker("20260711"), "[redacted:numeric]");
  assert.equal(tokenShapeMarker("aGVsbG8gd29ybGQxMjM0"), "[redacted:long-token]");
  assert.equal(tokenShapeMarker("anna"), "[redacted]");
});

test("IDN hosts canonicalize to punycode and default ports strip", () => {
  const redacted = redactUrlV2("https://münchen.example.com:443/privacy");
  assert.equal(redacted.value, "https://xn--mnchen-3ya.example.com/privacy");
});

test("hostname and path field sanitizers apply the same policy without a containing URL", () => {
  const host = redactHostnameV2(".a8f3c9d2e1b4f6a7.Telemetry.Example.com");
  assert.equal(host.value, ".{label}.telemetry.example.com");
  assert.equal(host.counters.subdomainLabelsGeneralized, 1);

  const malformed = redactHostnameV2("anna@example.com/path");
  assert.equal(malformed.value, INVALID_HOST_MARKER);
  assert.equal(malformed.counters.malformedUrlsDropped, 1);

  const path = redactPathV2("/products/12345/anna;session=secret?ignored=yes");
  assert.equal(path.value, "/products/{n}/{seg}");
  assert.equal(path.counters.pathSegmentsGeneralized, 2);
  assert.equal(path.counters.matrixParamsStripped, 1);
});

test("all public markers are byte-idempotent across repeated boundaries", () => {
  const once = redactUrlV2(
    "https://a8f3c9d2e1b4f6a7.example.com/private/12345?secret=x&utm_source=y",
    { preserveQueryKeys: true }
  ).value;
  assert.equal(redactUrlV2(once, { preserveQueryKeys: true }).value, once);
  assert.equal(redactPathV2(redactPathV2("/private/12345").value).value, "/{seg}/{n}");
  assert.equal(redactHostnameV2(redactHostnameV2("a8f3c9d2e1b4f6a7.example.com").value).value, "{label}.example.com");

  const counters = emptyRedactionCounters();
  for (const marker of [
    "[redacted]",
    "[redacted:uuid-like]",
    "[redacted:numeric]",
    "[redacted:hex-like]",
    "[redacted:long-token]"
  ]) {
    assert.equal(tokenShapeMarker(marker), marker);
    assert.equal(redactCookieName(marker, counters).value, marker);
    assert.equal(redactStorageKey(marker, counters).value, marker);
  }
  assert.equal(redactUrlV2(INVALID_URL_MARKER).value, INVALID_URL_MARKER);
  assert.equal(redactHostnameV2(INVALID_HOST_MARKER).value, INVALID_HOST_MARKER);
});
