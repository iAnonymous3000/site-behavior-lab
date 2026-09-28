import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "tldts";
import { canonicalJson, publicReportDigest } from "./canonical-json";
import { DETECTOR_VERSIONS } from "./measurement-kernel";
import allowlists from "./redaction-allowlists.json";
import { publicStringPolicyInputs, redactPrivacyPolicy, RedactionPass, redactScanResultV1 } from "./redact-scan-report-v1";
import {
  emptyRedactionCounters,
  isExactPublicSuffixHost,
  publicRegistrableDomain,
  redactHostnameV2,
  redactPathV2,
  redactUrlV2,
  type RedactionCounters
} from "./redaction-v2";
import { buildScanConditions, buildScanResult } from "./scan-result-builder";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import { redactPublicScanReportV2R2 } from "./scan-report-v2-r2-remediation";
import { buildNodeScanReportV2R2, type NodeScanReportV2R2Input } from "./scan-result-v2-r2-builder";
import { assertProperty, withoutOne, type SeededRandom } from "./seeded-property";
import { findTrackerMatch } from "./tracker-catalog";
import type { CookieRecord, FingerprintDetectionSummary, NetworkRequestRecord, StorageRecord } from "./types";

// ---------------------------------------------------------------------------
// Redaction as a property.
//
// Every public boundary (producer, store, export, remediation) runs the same
// redactors again over what an earlier one published, so each must be a fixed
// point: redact(redact(x)) equals redact(x), and the second pass counts
// nothing, or the managed reader refuses the stored report as not idempotent.
// And what they publish must hold no network address, no long digit run, no
// email and, in a policy quote, no URL.
//
// The draws aim at the shapes that have leaked before: private-suffix tenant
// labels carrying a runner address or a per-visit token, IPv4 and IPv6
// literals and their alternate spellings, punycode, ports, userinfo, matrix
// parameters, markers a prior pass wrote, and identifiers inside quotes.
// ---------------------------------------------------------------------------

const SEED = 20260928;
const ITERATIONS = 3000;

const WORDS = ["shop", "news", "mail", "portal", "static", "media", "tenant", "clinic", "acme", "example", "data"];
const ICANN_SUFFIXES = ["com", "net", "org", "io", "de", "co.uk", "com.au", "gov.uk", "sale", "app"];
const PRIVATE_SUFFIXES = [
  "akamaihd.net",
  "cloudfront.net",
  "github.io",
  "herokuapp.com",
  "netlify.app",
  "azurefd.net",
  "s3.amazonaws.com",
  "blogspot.com",
  "appspot.com"
];
const UNPUBLISHABLE_SUFFIXES = ["internal", "localhost", "example", "test", "local", "invalid"];
const MARKERS = ["{label}", "{seg}", "{n}", "[redacted]", "{invalid-host}", "{invalid-url}"];

function digits(random: SeededRandom, length: number): string {
  return Array.from({ length }, (_, index) => String(index === 0 ? 1 + random.int(9) : random.int(10))).join("");
}

function octet(random: SeededRandom): number {
  return random.pick([0, 1, 10, 127, 169, 172, 192, 203, 255, random.int(256)]);
}

function ipv4(random: SeededRandom): string {
  return Array.from({ length: 4 }, () => octet(random)).join(".");
}

function token(random: SeededRandom, alphabet: string, length: number): string {
  return Array.from({ length }, () => alphabet[random.int(alphabet.length)]).join("");
}

/** One DNS label, from ordinary names to the per-client and per-visit shapes. */
function label(random: SeededRandom): string {
  switch (random.int(14)) {
    case 0:
      return random.pick(allowlists.subdomainLabels.literals);
    case 1: {
      const separator = random.pick(["-", "_"]);
      return `${random.pick(["", "ip", "a", "host", "clientnsv4-s"])}${random.chance(0.5) ? separator : ""}${ipv4(random)
        .split(".")
        .join(separator)}${random.chance(0.5) ? `${separator}${random.pick(["s", "edge", "c"])}` : ""}`;
    }
    case 2:
      return digits(random, random.pick([9, 10, 12, 13, 15, 16, 20]));
    case 3:
      return `${random.pick(WORDS)}-${digits(random, random.pick([9, 10, 12, 13, 16]))}`;
    case 4:
      return token(random, "0123456789abcdef", random.pick([12, 16, 24, 32]));
    case 5:
      return token(random, "abcdefghijklmnopqrstuvwxyz0123456789", random.pick([14, 20, 33, 40]));
    case 6:
      return `xn--${token(random, "abcdefghijklmnopqrstuvwxyz0123456789", random.pick([6, 10, 14]))}`;
    case 7:
      return `${random.pick(WORDS)}${digits(random, random.pick([1, 4, 9]))}`;
    case 8:
      return random.pick(["{label}", "redacted-label"]);
    case 9:
      return random.pick(WORDS).toUpperCase();
    case 10:
      return `${token(random, "0123456789abcdef", 8)}-${token(random, "0123456789abcdef", 4)}-${token(
        random,
        "0123456789abcdef",
        4
      )}`;
    case 11:
      return `2001-db8-${random.int(10)}--${random.int(100)}`;
    default:
      return random.pick(WORDS);
  }
}

/** A hostname-valued field: a registered name, a hosting tenant, an address, or junk. */
function hostname(random: SeededRandom): string {
  const labels = (count: number) => Array.from({ length: count }, () => label(random));
  switch (random.int(9)) {
    case 0:
      return [...labels(random.int(3)), random.pick(WORDS), random.pick(ICANN_SUFFIXES)].join(".");
    case 1:
      return [...labels(random.int(3)), label(random), random.pick(ICANN_SUFFIXES)].join(".");
    case 2:
    case 3:
      return [...labels(random.int(2)), label(random), random.pick(PRIVATE_SUFFIXES)].join(".");
    case 4:
      return random.pick([
        ipv4(random),
        `0x${octet(random).toString(16)}.${octet(random)}`,
        String(random.int(2 ** 31) + 2 ** 31),
        `0${octet(random).toString(8)}.${octet(random)}.${octet(random)}.${octet(random)}`,
        `${octet(random)}.${random.int(65536)}`
      ]);
    case 5:
      return random.pick([`[2001:db8::${random.int(65536).toString(16)}]`, "[::1]", `[::ffff:${ipv4(random)}]`, "2001:db8::1"]);
    case 6:
      return [...labels(1 + random.int(2)), random.pick(UNPUBLISHABLE_SUFFIXES)].join(".");
    case 7:
      return random.pick(PRIVATE_SUFFIXES);
    default:
      return random.pick(MARKERS);
  }
}

function hostnameField(random: SeededRandom): string {
  const host = hostname(random);
  const port = random.chance(0.1) ? `:${random.pick([80, 443, 8080, random.int(65536)])}` : "";
  const withDots = `${random.chance(0.15) ? "." : ""}${host}${random.chance(0.1) ? "." : ""}${port}`;
  return random.chance(0.1) ? ` ${withDots} ` : withDots;
}

function pathSegment(random: SeededRandom): string {
  switch (random.int(9)) {
    case 0:
      return random.pick(allowlists.routeLiterals.literals);
    case 1:
      return digits(random, 1 + random.int(12));
    case 2:
      return `${random.pick(WORDS)}@${random.pick(WORDS)}.com`;
    case 3:
      return `${random.pick(WORDS)};jsessionid=${digits(random, 10)}`;
    case 4:
      return random.pick(["%7Bseg%7D", "%7Bn%7D", "{seg}", "{n}", "%E2%82%AC", "%ZZ"]);
    case 5:
      return label(random);
    case 6:
      return ipv4(random);
    default:
      return random.pick(WORDS);
  }
}

function url(random: SeededRandom): string {
  const scheme = random.pick(["https", "https", "http", "ftp", "javascript", "data"]);
  if (scheme === "javascript" || scheme === "data") return `${scheme}:${random.pick(WORDS)}`;
  const userinfo = random.chance(0.1) ? `${random.pick(WORDS)}:${digits(random, 9)}@` : "";
  const host = hostname(random);
  const port = random.pick(["", "", ":80", ":443", ":8080", `:${random.int(65536)}`]);
  const path = Array.from({ length: random.int(8) }, () => pathSegment(random)).join("/");
  const keys = [...allowlists.queryKeys.literals, "email", "token", "[redacted]", "UTM_SOURCE", random.pick(WORDS)];
  const query = random.chance(0.5)
    ? `?${Array.from({ length: 1 + random.int(4) }, () => `${random.pick(keys)}=${random.pick([digits(random, 9), "a@b.com", ipv4(random), ""])}`).join("&")}`
    : "";
  const fragment = random.chance(0.2) ? `#${random.pick(WORDS)}` : "";
  return `${scheme}://${userinfo}${host}${port}/${path}${query}${fragment}`;
}

/** An identifier a policy sentence can carry, in the spellings policies use. */
function quoteIdentifier(random: SeededRandom): string {
  const word = () => random.pick(WORDS);
  switch (random.int(12)) {
    case 0:
      return `${word()}@${word()}.com`;
    case 1:
      // A second obfuscated address after the first survives one replace pass.
      return random.chance(0.5)
        ? `${word()} [dot] ${word()} [at] ${word()} [dot] com`
        : `${word()} [at] ${word()} [dot] ${word()} [at] ${word()} [dot] com`;
    case 2:
      return `${word()} (at) ${word()}.org`;
    case 3:
      return `https://${word()}.com/${word()}`;
    case 4:
      return `www.${word()}.com${random.chance(0.5) ? `/${word()}` : ""}`;
    case 5:
      return `${word()}.${random.pick(["com", "co.uk", "sale"])}/${word()}`;
    case 6:
      return `+${random.int(99)} (${digits(random, 3)}) ${digits(random, 3)}-${digits(random, 4)}`;
    case 7:
      return `${digits(random, 3)}${random.pick(["-", ".", " ", "‐", "−"])}${digits(random, 3)}${random.pick(["-", "."])}${digits(random, 4)}`;
    case 8:
      return digits(random, random.pick([9, 12, 16]));
    case 9:
      return random.chance(0.5) ? ipv4(random) : ipv4(random).split(".").join(random.pick(["-", "_"]));
    case 10:
      return `${word()}.${random.pick(["com", "sale", "de"])}`;
    default:
      return random.pick(["1798.100-1798.199", "2026-09-28 12:00", "555-0199", "section 1798.140"]);
  }
}

function quote(random: SeededRandom): string {
  const parts: string[] = [];
  for (let index = 0; index < 1 + random.int(6); index += 1) {
    parts.push(random.chance(0.5) ? quoteIdentifier(random) : random.pick(["We", "do not", "sell", "your data;", "contact", "us at", "or"]));
    if (random.chance(0.1)) parts.push(random.pick(["\u0000", "\n", "\t", "”", "...", "!", "(", ")"]));
  }
  // A trailing "www" becomes a span once the incomplete-quote marker follows it.
  if (random.chance(0.1)) parts.push(random.pick(["visit www", "see www.", "at www"]));
  const text = parts.join(" ");
  return random.chance(0.1) ? `${text} ${"We keep records. ".repeat(12)}` : `${text}${random.pick([".", "...", "", ":", ")"])}`;
}

// ---------------------------------------------------------------------------
// What a published value may not hold, and the shapes the codebase publishes
// on purpose.
// ---------------------------------------------------------------------------

const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const LEAKS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "dotted IPv4", pattern: new RegExp(String.raw`(?<![\d.])${OCTET}(?:\.${OCTET}){3}(?![\d]|\.\d)`) },
  { name: "dashed IPv4", pattern: new RegExp(String.raw`(?<!\d)${OCTET}(?:[-_]${OCTET}){3}(?!\d)`) },
  { name: "9+ digit run", pattern: /\d{9,}/ },
  { name: "email", pattern: /[^\s@]+@[^\s@]+/ }
];
const QUOTE_URL = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:[a-z0-9_-]+\.)+[a-z]{2,}\/\S/i;

type Leak = { name: string; match: string };

function leaksIn(text: string): Leak[] {
  return LEAKS.flatMap(({ name, pattern }) => {
    const match = pattern.exec(text);
    return match ? [{ name, match: match[0] }] : [];
  });
}

/**
 * The leaks in a published hostname, less the ones a recorded decision keeps,
 * each scoped to the one label it covers:
 *
 * - an ICANN registrable domain's own label is a registered public name, and
 *   redaction keeps it verbatim (lib/redaction-v2.ts, the private-suffix
 *   tenant note: "ICANN registrable domains are out of scope");
 * - a private-suffix tenant label may keep a numeric id of nine to fifteen
 *   digits that is not a timestamp (docs/limitations.md, the saved-report
 *   sanitizer paragraph: "a numeric id that is neither a timestamp nor
 *   sixteen digits long" survives, and a ten- or thirteen-digit id starting
 *   with 1 reads as a timestamp). Every other leak in a tenant label, a dashed
 *   IPv4 address above all, still counts.
 */
function hostnameLeaks(value: string): Leak[] {
  const host = value.replace(/^\./, "");
  const parsed = parse(host.replace(/\{label\}/g, "redacted-label"), { allowPrivateDomains: true });
  if (!parsed.domain || (!parsed.isIcann && !parsed.isPrivate)) return leaksIn(host);
  const labels = host.split(".");
  const index = labels.length - parsed.domain.split(".").length;
  const registered = labels[index];
  labels[index] = "";
  const outside = leaksIn(labels.join("."));
  if (parsed.isIcann) return outside;
  return [
    ...outside,
    ...leaksIn(registered).filter((leak) => !(leak.name === "9+ digit run" && tenantDigitRunsSurvive(registered)))
  ];
}

function tenantDigitRunsSurvive(tenant: string): boolean {
  return tenant.split(/[-_]+/).every((segment) =>
    (segment.match(/\d{9,}/g) ?? []).every(
      (run) => run.length < 16 && !(run === segment && run.startsWith("1") && (run.length === 10 || run.length === 13))
    )
  );
}

/** The leaks in a published URL: its host as a hostname, the rest as text, and any explicit port. */
function urlLeaks(value: string): Leak[] {
  const match = /^https?:\/\/([^/?#]*)(.*)$/.exec(value);
  if (!match) return leaksIn(value);
  const leaks = [...hostnameLeaks(match[1]), ...leaksIn(match[2])];
  // Ports can disclose private service topology, so every explicit one drops.
  if (match[1].includes(":")) leaks.push({ name: "explicit port", match: match[1] });
  return leaks;
}

/** A policy quote's leaks, less the ones finding B1 below holds open, plus any URL. */
function quoteLeaks(value: string): Leak[] {
  const leaks = leaksIn(value).filter((leak) => !QUOTE_LEAKS_HELD_OPEN.has(leak.name));
  const url = QUOTE_URL.exec(value);
  if (url) leaks.push({ name: "URL", match: url[0] });
  return leaks;
}

const ZERO_COUNTERS: RedactionCounters = emptyRedactionCounters();

function secondPassFailure(first: string, second: { value: string; counters: RedactionCounters }): string | null {
  if (second.value !== first) return `not a fixed point: ${JSON.stringify(first)} became ${JSON.stringify(second.value)}`;
  if (JSON.stringify(second.counters) !== JSON.stringify(ZERO_COUNTERS)) {
    return `the second pass counted ${JSON.stringify(second.counters)}`;
  }
  return null;
}

/** Characters out of a string, one at a time, then whole dot-separated labels. */
function* shrinkText(value: string): Generator<string> {
  const labels = value.split(".");
  if (labels.length > 1) for (const kept of withoutOne(labels)) yield kept.join(".");
  const tokens = value.split(" ");
  if (tokens.length > 1) for (const kept of withoutOne(tokens)) yield kept.join(" ");
  for (let index = 0; index < value.length; index += 1) yield value.slice(0, index) + value.slice(index + 1);
}

test("the hostname redactor is a fixed point and publishes no address, port, long digit run or email", () => {
  assertProperty({
    name: "hostname redaction",
    seed: SEED,
    iterations: ITERATIONS,
    generate: (random) => hostnameField(random),
    shrink: shrinkText,
    describe: (value) => JSON.stringify({ input: value, published: redactHostnameV2(value).value }),
    property: (input) => {
      const first = redactHostnameV2(input).value;
      const idempotence = secondPassFailure(first, redactHostnameV2(first));
      if (idempotence) return idempotence;
      const leaks = hostnameLeaks(first);
      if (/:\d/.test(first)) leaks.push({ name: "explicit port", match: first });
      return leaks.length === 0 ? null : `published ${JSON.stringify(first)} holds ${leaks.map((leak) => `a ${leak.name} (${leak.match})`).join(", ")}`;
    }
  });
});

test("the URL redactor is a fixed point in both query modes and publishes no address, port, long digit run or email", () => {
  for (const preserveQueryKeys of [false, true]) {
    assertProperty({
      name: `URL redaction (preserveQueryKeys ${preserveQueryKeys})`,
      seed: SEED + Number(preserveQueryKeys),
      iterations: ITERATIONS,
      generate: (random) => url(random),
      shrink: function* (value) {
        const parts = value.split("/");
        for (const kept of withoutOne(parts)) if (kept.length >= 3) yield kept.join("/");
        yield* shrinkText(value);
      },
      describe: (value) => JSON.stringify({ input: value, published: redactUrlV2(value, { preserveQueryKeys }).value }),
      property: (input) => {
        const first = redactUrlV2(input, { preserveQueryKeys }).value;
        const idempotence = secondPassFailure(first, redactUrlV2(first, { preserveQueryKeys }));
        if (idempotence) return idempotence;
        const leaks = urlLeaks(first);
        return leaks.length === 0 ? null : `published ${JSON.stringify(first)} holds ${leaks.map((leak) => `a ${leak.name} (${leak.match})`).join(", ")}`;
      }
    });
  }
});

test("the path redactor is a fixed point and publishes only reviewed segments and markers", () => {
  assertProperty({
    name: "path redaction",
    seed: SEED,
    iterations: ITERATIONS,
    generate: (random) =>
      `${random.chance(0.8) ? "/" : ""}${Array.from({ length: random.int(9) }, () => pathSegment(random)).join("/")}${random.pick(["", "?a=1", "#x"])}`,
    shrink: shrinkText,
    property: (input) => {
      const first = redactPathV2(input).value;
      const idempotence = secondPassFailure(first, redactPathV2(first));
      if (idempotence) return idempotence;
      const reviewed = new Set([...allowlists.routeLiterals.literals.map((literal) => literal.toLowerCase()), "{seg}", "{n}"]);
      const unreviewed = first.split("/").filter((segment) => segment !== "" && !reviewed.has(segment));
      return unreviewed.length === 0 ? null : `published ${JSON.stringify(first)} keeps ${JSON.stringify(unreviewed)}`;
    }
  });
});

/**
 * Quote shapes the span table leaves on purpose (the POLICY_QUOTE_IDENTIFIER_SPANS
 * docstring in lib/redact-scan-report-v1.ts, design decision D4): a bare
 * hostname is not a URL here, since ordinary words are host-shaped, and so
 * is kept. The URL check below already reads only a scheme, `www.` or a host
 * followed by a path.
 *
 * TODO(redaction finding B1): an IPv4 address under the nine-digit phone
 * threshold, dotted or dashed ("10.0.0.1", "8.8.8.8", "10-0-0-1"), survives
 * the span table and publishes, and nothing in the codebase records that as
 * deliberate. The spans are hashed into PUBLIC_STRING_POLICY_DIGEST, so a fix
 * is an identity narrowing that needs an owner decision; until then it is
 * held open here and must still be reached.
 */
const QUOTE_LEAKS_HELD_OPEN = new Set(["dotted IPv4", "dashed IPv4"]);

/**
 * TODO(redaction finding B2): a quote longer than the 200-character cap with
 * no identifier span is cut by capCharacters after normalization, and a cut
 * that lands on a space publishes a trailing space the next pass trims, so the
 * published quote is not a fixed point. The Node producer already cuts quotes
 * to 200 UTF-16 units (lib/privacy-policy.ts truncateQuote), so only a quote
 * from another source reaches it. The cap sits inside the pinned quote-scrub
 * block (lib/r2-normalization-identity-ledger.test.ts), so a fix changes
 * published bytes and needs the span-policy label and the identity ritual.
 */
function capLeftTrailingSpace(input: string, first: string, second: string): boolean {
  const normalized = input.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(normalized).length > 200 && /\s$/.test(first) && second === first.trimEnd();
}

test("a published policy quote is a fixed point and holds no address, long digit run, email or URL", () => {
  let heldOpen = 0;
  let capHeldOpen = 0;
  const publish = (text: string) =>
    redactPrivacyPolicy(
      {
        url: "https://www.example.com/privacy",
        claims: [{ kind: "no-selling-or-sharing", quote: text }],
        mentionedEntities: [],
        unmentionedEntities: [],
        policyTextLength: 4000
      },
      new RedactionPass()
    ).claims[0]?.quote ?? "";
  assertProperty({
    name: "policy quote redaction",
    seed: SEED,
    iterations: ITERATIONS,
    generate: (random) => quote(random),
    shrink: shrinkText,
    describe: (value) => JSON.stringify({ input: value, published: publish(value) }),
    property: (input) => {
      const first = publish(input);
      const second = publish(first);
      if (second !== first) {
        if (capLeftTrailingSpace(input, first, second)) capHeldOpen += 1;
        else return `not a fixed point: ${JSON.stringify(first)} became ${JSON.stringify(second)}`;
      }
      if (leaksIn(first).some((leak) => QUOTE_LEAKS_HELD_OPEN.has(leak.name))) heldOpen += 1;
      const open = quoteLeaks(first);
      return open.length === 0 ? null : `published ${JSON.stringify(first)} holds ${open.map((leak) => `a ${leak.name} (${leak.match})`).join(", ")}`;
    }
  });
  assert.ok(heldOpen > 0, "finding B1 was never reached; if quotes now scrub short IPv4 addresses, remove it");
  assert.ok(capHeldOpen > 0, "finding B2 was never reached; if the cap no longer leaves a trailing space, remove it");
});

// ---------------------------------------------------------------------------
// Whole reports: every field a host, URL or quote reaches, through the real
// sanitizers. The fields are drawn from the shapes above; quotes are drawn as
// the producer bounds them (lib/privacy-policy.ts truncateQuote), since the
// over-length case is finding B2 above.
// ---------------------------------------------------------------------------

const SUBJECT_REGISTRABLE = "redaction-fixture.net";
const SUBJECT_URL = `https://www.${SUBJECT_REGISTRABLE}/`;
const BUILD_ENV = { SITE_BEHAVIOR_LAB_BUILD_COMMIT: "a".repeat(40) } as NodeJS.ProcessEnv;
const FIXED_WARNINGS: readonly string[] = publicStringPolicyInputs().fixedWarnings;

function producerQuote(random: SeededRandom): string {
  const text = quote(random);
  return text.length <= 200 ? text : `${text.slice(0, 197).trimEnd()}...`;
}

function name(random: SeededRandom, reviewed: readonly string[]): string {
  return random.pick([
    () => random.pick(reviewed),
    () => token(random, "abcdefghijklmnopqrstuvwxyz0123456789_", 1 + random.int(40)),
    () => `${random.pick(WORDS)}@${random.pick(WORDS)}.com`,
    () => ipv4(random),
    () => random.pick(["[redacted]", "[redacted:numeric]", "[redacted:hex-like]", "[redacted:long-token]"])
  ])();
}

type ReportDraw = {
  requests: Array<{ url: string; thirdParty: boolean }>;
  cookies: CookieRecord[];
  storage: StorageRecord[];
  listenerOrigins: string[];
  keystrokeRecipients: string[];
  quotes: string[];
  policyUrl: string;
  frameUrl: string;
  warnings: string[];
};

function reportDraw(random: SeededRandom): ReportDraw {
  return {
    requests: Array.from({ length: 1 + random.int(6) }, () => ({ url: url(random), thirdParty: random.chance(0.6) })),
    cookies: Array.from({ length: random.int(4) }, () => ({
      name: name(random, allowlists.cookieNames.literals),
      domain: hostnameField(random),
      path: `/${pathSegment(random)}`,
      sameSite: random.pick(["Lax", "Strict", "None", "lax", "unknown"]),
      secure: random.chance(0.5),
      httpOnly: random.chance(0.5),
      session: random.chance(0.5),
      thirdParty: random.chance(0.5)
    })),
    storage: Array.from({ length: random.int(4) }, () => ({
      area: random.pick(["localStorage", "sessionStorage"] as const),
      key: name(random, allowlists.storageKeys.literals),
      valueBytes: random.int(4096)
    })),
    listenerOrigins: Array.from({ length: random.int(3) }, () => (random.chance(0.5) ? url(random) : hostname(random))),
    keystrokeRecipients: Array.from({ length: random.int(3) }, () => hostnameField(random)),
    quotes: Array.from({ length: random.int(4) }, () => producerQuote(random)),
    policyUrl: url(random),
    frameUrl: url(random),
    warnings: [...random.subset(FIXED_WARNINGS, 0.05), ...(random.chance(0.3) ? [quote(random)] : [])]
  };
}

function shrinkDraw(draw: ReportDraw): Iterable<ReportDraw> {
  const candidates: ReportDraw[] = [];
  for (const key of ["requests", "cookies", "storage", "listenerOrigins", "keystrokeRecipients", "quotes", "warnings"] as const) {
    for (const kept of withoutOne(draw[key] as unknown[])) candidates.push({ ...draw, [key]: kept });
  }
  return candidates;
}

function listenerDetections(draw: ReportDraw): FingerprintDetectionSummary[] {
  const detections: FingerprintDetectionSummary[] = [];
  if (draw.listenerOrigins.length > 0) {
    detections.push({
      kind: "session-recording",
      heuristic: "interaction-listener-coverage-v1",
      count: 2,
      evidence: { eventTypes: ["click"], listenerTargets: ["document"], thirdPartyOrigins: draw.listenerOrigins, totalListenerCalls: 2 }
    });
  }
  return detections;
}

/**
 * TODO(redaction finding B3): a request whose host is itself one of the
 * catalog's hosting suffixes (a bare azurefd.net or azureedge.net). The first
 * v1 pass verifies the curated match against the raw host and keeps it while
 * the host publishes as the invalid-host marker; the next pass cannot verify
 * a match against the marker and drops it, so the report is not a fixed
 * point until the second pass. r2 refuses tracker evidence on such a host, so
 * only v1 reaches it, and a browser rarely requests a bare hosting suffix.
 * Dropping the match on the first pass narrows what v1 publishes, which the
 * redaction ledger stops for an owner decision.
 */
function convergesAfterCuratedSuffixTrackerDrop(draw: ReportDraw, second: unknown, third: unknown): boolean {
  const curatedSuffixes = new Set(publicStringPolicyInputs().curatedPublicSuffixes);
  const bareSuffixRequest = draw.requests.some((request) => {
    try {
      return curatedSuffixes.has(new URL(request.url).hostname.toLowerCase().replace(/\.$/, ""));
    } catch {
      return false;
    }
  });
  return bareSuffixRequest && canonicalJson(second) === canonicalJson(third);
}

/** Every host, URL, name and quote field of a sanitized v1 report, scanned by its kind. */
function v1ReportLeaks(report: ReturnType<typeof buildScanResult>): Leak[] {
  const origin = (value: string) => (/^https?:\/\//i.test(value) ? urlLeaks(value) : hostnameLeaks(value));
  return [
    ...urlLeaks(report.conditions.requestedUrl),
    ...urlLeaks(report.conditions.finalUrl),
    ...report.requests.flatMap((request) => [...urlLeaks(request.url), ...hostnameLeaks(request.domain)]),
    ...report.domains.flatMap((domain) => hostnameLeaks(domain.domain)),
    ...report.cookies.flatMap((cookie) => [...hostnameLeaks(cookie.domain), ...leaksIn(cookie.name), ...leaksIn(cookie.path)]),
    ...report.storage.flatMap((entry) => leaksIn(entry.key)),
    ...(report.fingerprintDetections ?? []).flatMap((detection) =>
      detection.kind === "session-recording" || detection.kind === "input-monitoring"
        ? detection.evidence.thirdPartyOrigins.flatMap(origin)
        : detection.kind === "keystroke-exfiltration"
          ? detection.evidence.recipients.flatMap(hostnameLeaks)
          : []
    ),
    ...(report.privacyPolicy
      ? [...urlLeaks(report.privacyPolicy.url), ...report.privacyPolicy.claims.flatMap((claim) => quoteLeaks(claim.quote))]
      : []),
    ...(report.consentInteraction?.frameUrl ? urlLeaks(report.consentInteraction.frameUrl) : []),
    ...leaksIn(report.summary.pageTitle)
  ];
}

test("the v1 report sanitizer publishes no leak in any host, URL, name or quote field and is a fixed point", () => {
  let heldOpen = 0;
  const CLAIM_KINDS = ["no-cookies", "no-third-party-cookies", "no-selling-or-sharing", "honors-gpc"] as const;
  const sanitized = (draw: ReportDraw) =>
    buildScanResult({
      pageTitle: draw.quotes[0] ?? "Fixture",
      status: 200,
      durationMs: 1000,
      firstPartyDomain: `www.${SUBJECT_REGISTRABLE}`,
      conditions: buildScanConditions({
        profile: "node-playwright",
        requestedUrl: draw.frameUrl,
        finalUrl: SUBJECT_URL,
        scannedAt: "2026-09-28T12:00:00.000Z",
        chromiumVersion: "136.0.0.0",
        viewport: { width: 1440, height: 980, isMobile: false },
        consentMode: "accept-all"
      }),
      requests: draw.requests.map((request, index): NetworkRequestRecord => {
        let host = "";
        try {
          host = new URL(request.url).hostname;
        } catch {
          host = request.url;
        }
        return {
          id: index + 1,
          url: request.url,
          domain: host,
          method: "GET",
          resourceType: "script",
          status: 200,
          thirdParty: request.thirdParty,
          tracker: request.thirdParty ? findTrackerMatch(host) : null,
          startedAtMs: index
        };
      }),
      cookies: draw.cookies,
      storage: draw.storage,
      fingerprintDetections: [
        ...listenerDetections(draw),
        ...(draw.keystrokeRecipients.length > 0
          ? [
              {
                kind: "keystroke-exfiltration" as const,
                heuristic: "input-sentinel-exfiltration-v1" as const,
                count: 1,
                evidence: { recipients: draw.keystrokeRecipients, encodings: ["plain"], fieldsTyped: 1, fieldTypes: ["text"] }
              }
            ]
          : [])
      ],
      fingerprintEvents: [],
      privacyPolicy: {
        url: draw.policyUrl,
        claims: draw.quotes.slice(0, CLAIM_KINDS.length).map((text, index) => ({ kind: CLAIM_KINDS[index], quote: text })),
        mentionedEntities: [],
        unmentionedEntities: [],
        policyTextLength: 4000
      },
      consentInteraction: { mode: "accept-all", clicked: true, cmp: "OneTrust", frameUrl: draw.frameUrl },
      screenshot: null,
      warnings: draw.warnings
    });
  assertProperty({
    name: "v1 report sanitizer fixed point",
    seed: SEED,
    iterations: 400,
    generate: (random) => reportDraw(random),
    shrink: shrinkDraw,
    property: (draw) => {
      const first = sanitized(draw);
      const leaks = v1ReportLeaks(first);
      if (leaks.length > 0) return `published ${leaks.map((leak) => `a ${leak.name} (${leak.match})`).join(", ")}`;
      const second = redactScanResultV1(first).report;
      if (canonicalJson(second) === canonicalJson(first)) return null;
      const changed = Object.keys(first).filter(
        (key) => canonicalJson(first[key as keyof typeof first]) !== canonicalJson(second[key as keyof typeof second])
      );
      if (
        changed.every((key) => ["summary", "requests", "domains"].includes(key)) &&
        convergesAfterCuratedSuffixTrackerDrop(draw, second, redactScanResultV1(second).report)
      ) {
        heldOpen += 1;
        return null;
      }
      return `a second pass changed ${changed.join(", ")}: ${changed
        .map((key) => `${canonicalJson(first[key as keyof typeof first])} became ${canonicalJson(second[key as keyof typeof second])}`)
        .join("; ")
        .slice(0, 2000)}`;
    }
  });
  assert.ok(heldOpen > 0, "finding B3 was never reached; if the tracker match now survives or drops on the first pass, remove it");
});

/** A host the Node producer can record: one with a party key, or a public suffix itself. */
function recordableHost(host: string): boolean {
  return (
    publicRegistrableDomain(host) !== null ||
    isExactPublicSuffixHost(host) ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) ||
    /^\[[0-9a-f:.]+\]$/i.test(host)
  );
}

function partyOf(host: string): string {
  return publicRegistrableDomain(host) ?? host;
}

test("a built r2 report is a fixed point of the managed sanitizer over generated hosts, URLs and quotes", () => {
  const input = (draw: ReportDraw): NodeScanReportV2R2Input => {
    const requests = [{ url: SUBJECT_URL, thirdParty: false }, ...draw.requests].flatMap((request) => {
      let parsed: URL;
      try {
        parsed = new URL(request.url);
      } catch {
        return [];
      }
      const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !host || !recordableHost(host)) return [];
      return [{ url: request.url, host }];
    });
    const cookies = draw.cookies.flatMap((cookie) => {
      const host = cookie.domain.trim().replace(/^\./, "").replace(/\.+$/, "");
      let canonical: string;
      try {
        canonical = new URL(`https://${host}/`).hostname;
      } catch {
        return [];
      }
      if (!host || /[\s/@?#]/.test(host) || (publicRegistrableDomain(canonical) === null && !/^(?:\d{1,3}\.){3}\d{1,3}$|^\[/.test(canonical))) {
        return [];
      }
      return [{ ...cookie, thirdParty: partyOf(canonical) !== SUBJECT_REGISTRABLE }];
    });
    return {
      runId: "run-redaction-property",
      startedAt: "2026-09-28T12:00:00.000Z",
      requestedUrl: SUBJECT_URL,
      observedUrl: SUBJECT_URL,
      conditions: {
        gpc: false,
        shields: "classification",
        consent: "observe",
        device: { kind: "desktop", viewport: { width: 1440, height: 980, isMobile: false } },
        probes: { keystroke: false, policyVisit: true },
        locale: "en-US",
        language: "en-US",
        timezone: "UTC",
        egress: { label: "redaction-property" },
        browser: { name: "chromium", version: "136.0.0.0" },
        headless: true,
        automation: "playwright-chromium"
      },
      acquisition: "public-api",
      adblockEngineLoaded: false,
      measurement: {
        phases: [
          { phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 1000 },
          { phaseId: 1, kind: "policy-analysis", startedAtMs: 1000, endedAtMs: 2000 }
        ],
        detectors: {
          "fingerprint-heuristics": { version: DETECTOR_VERSIONS["fingerprint-heuristics"], status: "complete", phaseId: 0 },
          "keystroke-exfiltration": { version: DETECTOR_VERSIONS["keystroke-exfiltration"], status: "skipped", reason: "probe-disabled" },
          "cname-uncloaking": { version: DETECTOR_VERSIONS["cname-uncloaking"], status: "complete", phaseId: 0 },
          "pixel-events": { version: DETECTOR_VERSIONS["pixel-events"], status: "complete", phaseId: 0 },
          "consent-banner": { version: DETECTOR_VERSIONS["consent-banner"], status: "complete", phaseId: 0 },
          "privacy-policy": { version: DETECTOR_VERSIONS["privacy-policy"], status: "complete", phaseId: 1 }
        },
        qualityFacts: { status: 200, botWallTitleMatched: false, navigationSettled: true, budgetsExhausted: [], captureLoss: [] }
      },
      evidence: {
        requests: requests.map(({ url: requestUrl, host }, index) => {
          const thirdParty = partyOf(host) !== SUBJECT_REGISTRABLE;
          const tracker = thirdParty && publicRegistrableDomain(host) !== null ? findTrackerMatch(host) : null;
          return {
            id: index + 1,
            url: requestUrl,
            domain: host,
            method: "GET",
            resourceType: index === 0 ? "document" : "script",
            status: 200,
            thirdParty,
            tracker: tracker?.confidence === "curated" ? tracker : null,
            startedAtMs: index,
            phaseId: 0
          };
        }),
        cookieMutations: [],
        cookiesFinal: cookies,
        storageMutations: [],
        storageFinal: draw.storage,
        fingerprintEvents: [],
        fingerprintDetections: listenerDetections(draw).map((detection) => ({ ...detection, phaseId: 0 })),
        cnameCloaks: [],
        pixelEvents: [],
        privacyPolicy: {
          url: draw.policyUrl,
          claims: draw.quotes.slice(0, 1).map((text) => ({ kind: "no-selling-or-sharing" as const, quote: text })),
          mentionedEntities: [],
          unmentionedEntities: [],
          policyTextLength: 4000
        }
      },
      summary: { pageTitle: draw.quotes[0] ?? "Fixture", durationMs: 2000 },
      warnings: draw.warnings.filter((warning) => FIXED_WARNINGS.includes(warning)),
      screenshot: null
    };
  };
  const reached = { generalizedHosts: 0, cookies: 0, listenerOrigins: 0 };
  assertProperty({
    name: "r2 managed sanitizer fixed point",
    seed: SEED,
    iterations: 400,
    generate: (random) => reportDraw(random),
    shrink: shrinkDraw,
    property: (draw) => {
      const published = toPublicScanReportR2(buildNodeScanReportV2R2(input(draw), BUILD_ENV));
      const evidence = published.run.evidence;
      reached.generalizedHosts += evidence.requests.filter((request) => request.domain.includes("{label}")).length;
      reached.cookies += evidence.cookiesFinal.length;
      reached.listenerOrigins += evidence.fingerprintDetections.length;
      const again = redactPublicScanReportV2R2(published);
      return publicReportDigest(again) === publicReportDigest(published)
        ? null
        : `the managed sanitizer changed the built report: ${canonicalJson(published).slice(0, 1500)} became ${canonicalJson(again).slice(0, 1500)}`;
    }
  });
  // Not vacuous: the builder kept generalized hosts, cookies and listener origins to re-sanitize.
  for (const [field, count] of Object.entries(reached)) assert.ok(count > 0, `no built report carried ${field}`);
});
