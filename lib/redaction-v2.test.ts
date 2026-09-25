import assert from "node:assert/strict";
import { test } from "node:test";
import { domainToASCII } from "node:url";
import tldtsPackage from "tldts/package.json";
import {
  INVALID_URL_MARKER,
  INVALID_HOST_MARKER,
  PUBLIC_SUFFIX_ENGINE_VERSION,
  emptyRedactionCounters,
  isGeneralizedPrivateSuffixTenantHost,
  queryKeyAllowed,
  publicRegistrableDomain,
  redactCookieName,
  redactHostnameV2,
  redactPageTitle,
  redactPathV2,
  redactStorageKey,
  redactUrlV2,
  tokenShapeMarker
} from "./redaction-v2";

test("public-suffix provenance matches the exact installed package", () => {
  assert.equal(PUBLIC_SUFFIX_ENGINE_VERSION, `tldts@${tldtsPackage.version}`);
});

test("malformed and non-http input redacts, never passes through", () => {
  // The exact v1 defect this replaces: report-url returned unparseable URLs unchanged.
  const malformed = redactUrlV2("not a url at all");
  assert.equal(malformed.value, INVALID_URL_MARKER);
  assert.equal(malformed.counters.malformedUrlsDropped, 1);

  const nonHttp = redactUrlV2("javascript:alert(document.cookie)");
  assert.equal(nonHttp.value, INVALID_URL_MARKER);
  assert.equal(nonHttp.counters.malformedUrlsDropped, 1);

  const singleLabel = redactUrlV2("https://AlicePatient/secret");
  assert.equal(singleLabel.value, INVALID_URL_MARKER);
  assert.equal(singleLabel.counters.malformedUrlsDropped, 1);
  const singleLabelHost = redactHostnameV2("AlicePatient");
  assert.equal(singleLabelHost.value, INVALID_HOST_MARKER);
  assert.equal(singleLabelHost.counters.malformedUrlsDropped, 1);

  for (const specialUse of ["alice.internal", "alice.localhost", "alice.example"]) {
    assert.equal(redactUrlV2(`https://${specialUse}/secret`).value, INVALID_URL_MARKER);
    assert.equal(redactHostnameV2(specialUse).value, INVALID_HOST_MARKER);
  }
  assert.equal(redactUrlV2("https://alice.github.io/secret").value, "https://alice.github.io/{seg}");
  assert.equal(publicRegistrableDomain("example.com."), "example.com");
  assert.equal(publicRegistrableDomain("Alice.Patient.example.com."), "example.com");
  assert.equal(publicRegistrableDomain("example.com.."), "example.com");
  assert.equal(publicRegistrableDomain("WWW.EXAMPLE.COM"), "example.com");
});

test("IP, port, and page-title literals never cross the public boundary", () => {
  for (const input of [
    "http://192.168.1.37:8080/patient/abc",
    "http://2130706433:3000/private",
    "http://[fd00::a:b:c:d]:3000/secret",
    "https://203.0.113.55/account"
  ]) {
    const redacted = redactUrlV2(input);
    assert.equal(redacted.value, INVALID_URL_MARKER);
    assert.equal(redacted.counters.malformedUrlsDropped, 1);
  }
  assert.equal(redactHostnameV2("192.168.1.37").value, INVALID_HOST_MARKER);
  assert.equal(redactHostnameV2("[fd00::a:b:c:d]").value, INVALID_HOST_MARKER);

  assert.equal(
    redactUrlV2("https://telemetry.example.com:8443/products?utm_source=private", {
      preserveQueryKeys: true
    }).value,
    "https://telemetry.example.com/products?utm_source="
  );

  assert.equal(redactPageTitle("Anna Schmidt's private dashboard"), "");
  assert.equal(redactPageTitle(redactPageTitle("already public")), "", "the title marker is byte-idempotent");
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
  const redacted = redactUrlV2("https://clinic.example.com/hiv/treatment");
  assert.equal(redacted.value, "https://{label}.example.com/{seg}/{seg}");
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
  const redacted = redactUrlV2("https://telemetry.example.com/collect?utm_source=news&email=anna%40example.com&gclid=abc123", {
    preserveQueryKeys: true
  });
  assert.equal(redacted.value, "https://telemetry.example.com/{seg}?utm_source=&%5Bredacted%5D=&gclid=");
  assert.equal(redacted.counters.queryKeysRedacted, 1);

  // Without preserveQueryKeys the query drops entirely.
  const dropped = redactUrlV2("https://telemetry.example.com/collect?utm_source=news", {});
  assert.equal(dropped.value.includes("?"), false);
  assert.equal(dropped.counters.queryKeysRedacted, 1);

  assert.equal(queryKeyAllowed("utm_campaign"), true);
  assert.equal(queryKeyAllowed("ud[em]"), true);
  assert.equal(queryKeyAllowed("utm_alice_private_account"), false);
  assert.equal(queryKeyAllowed("ud[alice_private_account]"), false);
  // v1's pattern rule passed any short alphanumeric key; the literal
  // allowlist does not.
  assert.equal(queryKeyAllowed("annaschmidt1987"), false);

  const hostile = redactUrlV2(
    `https://telemetry.example.com/collect?${[
      "utm_alice_private_account=secret",
      "ud[alice_private_account]=secret",
      ...Array.from({ length: 100 }, (_, index) => `unknown_${index}=x`),
      "UTM_SOURCE=x",
      "utm_source=y"
    ].join("&")}`,
    { preserveQueryKeys: true }
  );
  assert.equal(hostile.value.includes("alice"), false);
  assert.equal((hostile.value.match(/utm_source/g) ?? []).length, 1);
  assert.ok(hostile.value.length < 1_000);
  assert.ok(hostile.counters.queryKeysRedacted >= 102);
});

test("oversized raw URLs fail closed before public shaping", () => {
  const result = redactUrlV2(`https://example.com/?q=${"x".repeat(20_000)}`, { preserveQueryKeys: true });
  assert.equal(result.value, INVALID_URL_MARKER);
  assert.equal(result.counters.malformedUrlsDropped, 1);
});

test("subdomain labels are reviewed-literal only; tenant and token labels generalize", () => {
  assert.equal(redactUrlV2("https://telemetry.example.com/").value, "https://telemetry.example.com/");

  const tokened = redactUrlV2("https://a8f3c9d2e1b4f6a7.telemetry.example.com/");
  assert.equal(tokened.value, "https://{label}.telemetry.example.com/");
  assert.equal(tokened.counters.subdomainLabelsGeneralized, 1);

  const uuid = redactUrlV2("https://123e4567-e89b-12d3-a456-426614174000.cdn.example.com/");
  assert.equal(uuid.value, "https://{label}.cdn.example.com/");

  // Conventional numbered shards are not token-like.
  assert.equal(redactUrlV2("https://cdn2.example.com/").value, "https://cdn2.example.com/");
  assert.equal(redactUrlV2("https://alice.patient.example.com/").value, "https://{label}.{label}.example.com/");
  assert.equal(
    redactUrlV2("https://Alice.Patient.example.com./secret").value,
    "https://{label}.{label}.example.com/{seg}"
  );
  assert.equal(
    redactHostnameV2("Alice.Patient.example.com..").value,
    "{label}.{label}.example.com"
  );
});

test("cookie names and storage keys are allowlist-or-marker with shape classes", () => {
  const counters = emptyRedactionCounters();
  assert.deepEqual(redactCookieName("_ga", counters), { value: "_ga", preserved: true });
  for (const githubCookie of ["_octo", "logged_in", "cpu_bucket", "preferred_color_mode", "tz", "_gh_sess"]) {
    assert.deepEqual(redactCookieName(githubCookie, counters), { value: githubCookie, preserved: true });
  }
  assert.equal(redactCookieName("8f14e45fceea167a5a36dedd4bea2543", counters).value, "[redacted:hex-like]");
  assert.deepEqual(redactStorageKey("theme", counters), { value: "theme", preserved: true });
  assert.deepEqual(redactStorageKey("soft-nav:marker", counters), { value: "soft-nav:marker", preserved: true });
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

test("IDN hosts canonicalize before an unreviewed subdomain is generalized", () => {
  const redacted = redactUrlV2("https://münchen.example.com:443/privacy");
  assert.equal(redacted.value, "https://{label}.example.com/privacy");
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
  assert.equal(
    redactUrlV2("https://cdn.{label}.website-files.com/private").value,
    "https://cdn.{label}.website-files.com/{seg}"
  );
  assert.equal(
    redactHostnameV2("cdn.{label}.website-files.com").value,
    "cdn.{label}.website-files.com"
  );

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

test("a leading-dot invalid-host marker is terminal and moves no counter", () => {
  // A leading-dot cookie domain that fails the host policy publishes the
  // marker with its dot kept. A later boundary (store, export, remediation,
  // the managed reader's fixed-point check) must not re-parse that form and
  // count another malformed drop.
  for (const input of [".203.0.113.55", ".[2001:db8::1]", ".foo.localhost"]) {
    const once = redactHostnameV2(input);
    assert.equal(once.value, `.${INVALID_HOST_MARKER}`);
    assert.equal(once.counters.malformedUrlsDropped, 1);
    const twice = redactHostnameV2(once.value);
    assert.equal(twice.value, once.value);
    assert.deepEqual(twice.counters, emptyRedactionCounters());
  }
  assert.deepEqual(redactHostnameV2(INVALID_HOST_MARKER).counters, emptyRedactionCounters());
  // Only the exact published forms are terminal; a raw spelling around the
  // marker is still malformed input.
  assert.equal(redactHostnameV2(` .${INVALID_HOST_MARKER}`).counters.malformedUrlsDropped, 1);
});

// Four hosts laid out like the private-suffix tenants two committed v1 reports
// published: two Akamai EUM beacon hosts carrying the scanner egress address,
// the Akamai edge address and a visit timestamp, and two carrying per-visit
// client tokens. The addresses are documentation ranges and the timestamps and
// tokens are invented, with the observed segment lengths and digit runs, so no
// fixture repeats a value the privacy replacement removed.
const TOKEN_TENANT_HOSTS = [
  "192-0-2-41_s-198-51-100-43_ts-1767225600-clienttons-s.akamaihd.net",
  "qwert2yuiop3asdfg4hj-zxc5v6-79b48c136-clientnsv4-s.akamaihd.net",
  "203-0-113-121_s-198-51-100-24_ts-1767312000-clienttons-s.akamaihd.net",
  "mnbvc7xzlkj5hgfd2sap-lkj9h3-5d83bcfa2-clientnsv4-s.akamaihd.net"
];

function onlyLabelsGeneralized(count: number) {
  return { ...emptyRedactionCounters(), subdomainLabelsGeneralized: count };
}

test("an address- or token-shaped tenant label under a private suffix generalizes and is counted", () => {
  for (const host of TOKEN_TENANT_HOSTS) {
    const hostname = redactHostnameV2(host);
    assert.equal(hostname.value, "{label}.akamaihd.net", host);
    assert.deepEqual(hostname.counters, onlyLabelsGeneralized(1), host);
    const url = redactUrlV2(`https://${host}/`);
    assert.equal(url.value, "https://{label}.akamaihd.net/", host);
    assert.deepEqual(url.counters, onlyLabelsGeneralized(1), host);
    assert.equal(isGeneralizedPrivateSuffixTenantHost(host), true, host);
  }

  // Each shape on its own. The address hosts above also carry a timestamp,
  // so each row below is caught by exactly one shape.
  for (const [shape, host] of [
    ["dashed IPv4", "198-51-100-7-clienttons-s.akamaihd.net"],
    ["Unix timestamp in seconds", "1767225600-clienttons-s.akamaihd.net"],
    ["Unix timestamp in milliseconds", "1767225600000-clienttons-s.akamaihd.net"],
    ["numeric token of sixteen digits", "4839201756482913.herokuapp.com"],
    ["hex token", "deadbeefcafe1234.herokuapp.com"],
    ["mixed token with three digit runs", "a1b2c3d4e5f6g7h8.github.io"],
    // Two digit runs in the long segment, eight across the label.
    ["long label with five digit runs", "abcde1fghij2klmnopqr-abc1d2-12a34b567-clientnsv4-s.akamaihd.net"]
  ]) {
    const hostname = redactHostnameV2(host);
    assert.equal(hostname.value.startsWith("{label}."), true, `${shape}: ${host}`);
    assert.deepEqual(hostname.counters, onlyLabelsGeneralized(1), `${shape}: ${host}`);
  }

  // Deeper labels follow the ordinary subdomain rule on top of the tenant.
  const deep = redactHostnameV2(`a.b.${TOKEN_TENANT_HOSTS[0]}`);
  assert.equal(deep.value, "{label}.{label}.{label}.akamaihd.net");
  assert.deepEqual(deep.counters, onlyLabelsGeneralized(3));

  // An IDNA A-label is exempt from the token shapes, not from the address one.
  const addressIdn = domainToASCII("198-51-100-7-\u4f8b\u3048.github.io");
  assert.equal(addressIdn.startsWith("xn--198-51-100-7-"), true, addressIdn);
  assert.equal(redactHostnameV2(addressIdn).value, "{label}.github.io");
});

test("the tenant marker is terminal and stable service tenants stay verbatim", () => {
  assert.deepEqual(redactHostnameV2("{label}.akamaihd.net"), {
    value: "{label}.akamaihd.net",
    counters: emptyRedactionCounters()
  });
  assert.deepEqual(redactUrlV2("https://{label}.akamaihd.net/").counters, emptyRedactionCounters());

  // "официальныйсайт" encodes to an A-label whose base36 tail would read as a
  // mixed token; the exemption keeps it.
  const idn = domainToASCII("\u043e\u0444\u0438\u0446\u0438\u0430\u043b\u044c\u043d\u044b\u0439\u0441\u0430\u0439\u0442.github.io");
  assert.equal(idn, "xn--80aawagblqe0bno1a8en.github.io");
  for (const host of [
    "trial-eum-clienttons-s.akamaihd.net",
    "trial-eum-clientnsv4-s.akamaihd.net",
    "creditkarmacdn-a.akamaihd.net",
    "d3e54v103j8qbb.cloudfront.net",
    // Two digit runs: a random token this sparse survives by design.
    "abcd1234efgh5678ijkl.cloudfront.net",
    "fonts.googleapis.com",
    // One digit run.
    "coolprogrammer2000.github.io",
    // Hex-like words shorter than the hex threshold.
    "face2face.github.io",
    "cafe1234.herokuapp.com",
    // Platform default hostnames are the site's stable address: Heroku's
    // twelve-character app id and a Cloud Run service's twelve-digit project
    // number sit below the hex and numeric thresholds.
    "example-app-1234567890ab.herokuapp.com",
    "hello-123456789012.us-central1.run.app",
    // A long label whose digit runs are too few for the label shape.
    "my-company-marketing-site-2024-v2.netlify.app",
    idn,
    // ICANN registrable domains are out of scope: a registered name is public.
    "203-0-113-7.com"
  ]) {
    assert.deepEqual(redactHostnameV2(host), { value: host, counters: emptyRedactionCounters() }, host);
    assert.equal(isGeneralizedPrivateSuffixTenantHost(host), false, host);
  }

  // An address-shaped label left of an ICANN registrable domain was already a
  // generalized subdomain label, and still is.
  const icann = redactHostnameV2("203-0-113-7.static.example-isp.net");
  assert.equal(icann.value, "{label}.static.example-isp.net");
  assert.deepEqual(icann.counters, onlyLabelsGeneralized(1));
});

test("a per-visit client token laid out like the observed ones generalizes whatever its long segment's digit runs", () => {
  // The observed Akamai clientnsv4 tokens carry a twenty-character base32
  // segment, a six-character segment starting "p", and a nine-character hex
  // segment. Only the long segment can meet a segment shape, and a random one
  // has fewer than three digit runs about a third of the time, so the label
  // shape must catch those. Each draw keeps one observed digit layout for the
  // two later segments and places zero to three digit runs in the long one.
  // Park-Miller: seeded, so every run draws the same labels.
  let state = 0x5eed;
  const next = (bound: number) => {
    state = (state * 48271) % 2147483647;
    return Math.floor((state / 2147483647) * bound);
  };
  const fill = (layout: string, letters: string, digits: string) =>
    Array.from(layout, (slot) => (slot === "d" ? digits[next(digits.length)] : letters[next(letters.length)])).join("");
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const laterLayouts = [
    ["lldld", "ddlddlddd"],
    ["dldll", "dlddlllld"],
    ["lddll", "dldlddddl"]
  ];
  for (let runs = 0; runs <= 3; runs += 1) {
    for (let draw = 0; draw < 200; draw += 1) {
      // Runs start at distinct slots three apart, so two runs never touch.
      const slots = [0, 3, 6, 9, 12, 15, 18];
      for (let index = slots.length - 1; index > 0; index -= 1) {
        const other = next(index + 1);
        [slots[index], slots[other]] = [slots[other], slots[index]];
      }
      const long = Array.from({ length: 20 }, () => "l");
      for (const start of slots.slice(0, runs)) {
        long[start] = "d";
        if (next(2) === 1) long[start + 1] = "d";
      }
      const [middle, hex] = laterLayouts[next(laterLayouts.length)];
      const label = [
        fill(long.join(""), letters, "234567"),
        `p${fill(middle, letters, "0123456789")}`,
        fill(hex, "abcdef", "0123456789"),
        "clientnsv4",
        "s"
      ].join("-");
      assert.equal(label.length, 50, label);
      assert.equal(label.split("-")[0].match(/[0-9]+/g)?.length ?? 0, runs, label);
      const host = `${label}.akamaihd.net`;
      assert.equal(redactHostnameV2(host).value, "{label}.akamaihd.net", host);
      assert.equal(isGeneralizedPrivateSuffixTenantHost(host), true, host);
    }
  }
});
