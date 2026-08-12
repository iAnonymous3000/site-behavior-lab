import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isPublicIpAddress } from "./ip-safety";
import { normalizeScanUrl } from "./scan-prefill";

/**
 * Regression guards for the 12 Aug serious-use audit.
 *
 * Each test below fails against the code as it shipped. They live together
 * because the findings share one shape: the scanner said something about a
 * visit that the visit did not support, or acted on a site in a way the
 * project does not claim to.
 */

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

test("a URL carrying credentials is refused in the browser, before any request", () => {
  // The server rejects these too, but by then the password is already in the
  // POST body and can reach a WAF or an access log.
  for (const value of [
    "https://user:pass@example.com/path?token=secret",
    "user:pass@example.com/path",
    "https://user@example.com/",
    "https://:pass@example.com/"
  ]) {
    assert.equal(normalizeScanUrl(value), null, `${value} must not normalize into a scannable URL`);
  }

  // The stripping this boundary already did must still work, and a plain URL
  // must not be mistaken for a credentialed one.
  assert.equal(
    normalizeScanUrl("https://example.com/path?token=secret#frag"),
    "https://example.com/path"
  );

  // No credential-specific message: the homepage gzip budget had no room for
  // one. The refusal itself is unconditional above, which is the property that
  // matters, and this asserts the client cannot be made to send one anyway.
  // An @ in a path or query is not userinfo and must still scan.
  assert.equal(normalizeScanUrl("https://example.com/a@b"), "https://example.com/a@b");
});

/**
 * 2001::/23 is IANA's IETF Protocol Assignments block. The guard used to
 * enumerate a few non-reachable prefixes inside it and treat the rest as
 * public, so ORCHID and unallocated protocol space passed a check whose whole
 * job is refusing addresses that are not globally reachable.
 */
test("IPv6 protocol-assignment space defaults to refused, with the registry's exceptions allowed", () => {
  for (const address of [
    "2001::1", // Teredo
    "2001:1::4", // unallocated inside 2001:1::/32
    "2001:2::1", // BMWG benchmarking
    "2001:10::1", // deprecated ORCHID
    "2001:20::1", // ORCHIDv2
    "2001:30::1", // unallocated
    "2001:4:113::1", // neighbour of AS112-v6, not allocated
    "2001:db8::1" // documentation, and OUTSIDE the /23, so it needs its own rule
  ]) {
    assert.equal(isPublicIpAddress(address), false, `${address} is not globally reachable`);
  }

  // Refusing these would be a real regression: IANA marks them reachable.
  for (const address of [
    "2001:1::1", // Port Control Protocol anycast
    "2001:1::2", // TURN anycast
    "2001:1::3", // DNS-SD service registration anycast
    "2001:3::1", // AMT
    "2001:4:112::1", // AS112-v6
    "2001:200::1", // ordinary global unicast above the block
    "2606:4700::1111"
  ]) {
    assert.equal(isPublicIpAddress(address), true, `${address} is globally reachable and must scan`);
  }
});

/**
 * The consent click is a synthetic MouseEvent. On a form's submit control that
 * runs the form's activation behavior, which made this scanner POST forms on
 * sites it was only supposed to observe.
 */
test("the consent click cancels activation for form submit controls only", () => {
  const consent = source("lib/consent-interaction.ts");
  assert.match(consent, /nativePreventDefault/, "the click must be able to cancel activation");
  assert.match(
    consent,
    /if \(isFormSubmitControl\(element\)\) \{\s*nativeReflectApply\(nativePreventDefault, event, \[\]\);/,
    "activation must be cancelled for submit controls before dispatch"
  );
  // Scoped, not blanket: an <a href> consent control legitimately registers a
  // choice by navigating, and requiring type="button" would refuse the bare
  // <button> most real CMPs ship.
  assert.doesNotMatch(
    consent,
    /controlSelector[^\n]*:not\(\[type=submit\]\)/,
    "the fix must not remove submit controls from the selector"
  );
  assert.match(consent, /const isFormSubmitControl/, "the submit test must exist");
  // Read through native accessors, so a page cannot hide its form association.
  assert.match(consent, /nativeButtonForm/);
  assert.match(consent, /nativeInputForm/);
});

/**
 * The caller turns ANY rejection from the consent probe into clicked:false. The
 * settle wait could reject after a real click, so a published report could say
 * nothing was clicked while post-click cookies sat in the log.
 */
test("a post-click settle failure cannot be published as an un-clicked consent probe", () => {
  const scanner = source("lib/scanner.ts");
  assert.match(
    scanner,
    /await page\.waitForTimeout\(settleMs\)\.catch\(\(\) => \{\s*settleInterrupted = true;/,
    "the settle wait must not be able to reject after a click"
  );
  // Swallowing it must not silently promote the run to a complete observation.
  assert.match(scanner, /settleInterrupted\?: boolean;/, "the outcome must carry the interruption");
  assert.match(
    scanner,
    /consentProbe\?\.settleInterrupted === true/,
    "the caller must record capture loss when the settle was cut short"
  );
});

/**
 * `extras` is computed once from the baseline arm, so appending it to a
 * pair-framed sentence presents one visit's signals as part of the comparison.
 */
test("the Shields pair subhead carries no baseline-only extras", () => {
  const headline = source("lib/report-headline.ts");
  const shieldsSubhead = headline.slice(
    headline.indexOf("recorded ${plural(removed, \"fewer third-party request\")} in the visit configured"),
    headline.indexOf("story: \"comparison\"", headline.indexOf("Brave's ad-block engine"))
  );
  assert.ok(shieldsSubhead.length > 0, "the Shields pair branch must still be findable");
  assert.doesNotMatch(
    shieldsSubhead,
    /\$\{extraNote\}/,
    "a pair-framed subhead must not append baseline-arm extras"
  );
});

test("a transient corpus-stats failure stays retryable for the next mount", () => {
  const overview = source("app/_components/report-overview.tsx");
  const onError = overview.slice(overview.indexOf("onError: () => {"), overview.indexOf("setCorpus(null);\n        }") + 40);
  assert.ok(onError.length > 0);
  assert.doesNotMatch(
    onError,
    /corpusStatsCache = null;/,
    "a transport failure must not be cached, or percentiles stay off for the whole tab"
  );
  // The success branch's negative cache is deliberate and must stay: a served
  // but malformed payload cannot become valid on a refetch.
  assert.match(overview, /corpusStatsCache = isCorpusStats\(payload\) \? payload : null;/);
});

test("releasing a durable preparation slot is fenced on the reservation it holds", () => {
  const worker = source("cloudflare/container-worker.ts");
  assert.match(
    worker,
    /releaseDurablePreparationSlot\(input: \{ capabilityHash: ArrayBuffer; reservedExpiresAt: number \}\)/,
    "the RPC must take the reservation expiry"
  );
  assert.match(
    worker,
    /reservedExpiresAt: reservation\.expiresAt/,
    "the call site must pass the reservation it actually holds"
  );
});

test("the third-party badge names every metric that set the card's level", () => {
  const findings = source("lib/report-findings.ts");
  assert.match(findings, /const entityBenchmarkAlsoDrivesLevel/);
  assert.match(
    findings,
    /entityBenchmarkAlsoDrivesLevel\s*\?\s*`\$\{domainsBenchmark\.label\} \$\{benchmarkLabel\("trackerEntities"/,
    "when entities drive the level the badge must say so alongside the domains percentile"
  );
});

test("a browser that cannot open a context is dropped from the cache, not closed", () => {
  const scanner = source("lib/scanner.ts");
  const block = scanner.slice(
    scanner.indexOf("context = await withScanTimeoutDisposing("),
    scanner.indexOf("throwIfScanAborted(options.signal);", scanner.indexOf("context = await withScanTimeoutDisposing("))
  );
  assert.match(block, /sharedBrowser = null;/, "a wedged browser must leave the cache");
  assert.match(block, /browserLaunchPromise = null;/);
  // Never close it here: a sibling scan may still hold contexts on it.
  assert.doesNotMatch(block, /browser\.close\(\)/, "closing would break an in-flight sibling scan");
  assert.match(block, /if \(sharedBrowser === browser\)/, "only drop the instance that actually failed");
});

/**
 * The Shields stat paired a numerator measured at the passive-load boundary
 * with the RETAINED request total. Those are different populations: later
 * straggler rows are retained and deliberately excluded from the frozen
 * counter, so "240 ... of 390 requests" described a ratio over requests the
 * engine never evaluated.
 */
test("the Shields stat is denominated by requests the engine actually evaluated", () => {
  const overview = source("app/_components/report-overview.tsx");
  const shields = overview.slice(
    overview.indexOf('label: "Matched Shields lists"'),
    overview.indexOf("icon: shieldsMeasurement.origin", overview.indexOf('label: "Matched Shields lists"'))
  );
  assert.ok(shields.length > 0, "the Shields stat block must still be findable");
  assert.match(
    shields,
    /shieldsMeasurement\.evaluated/,
    "the recorded branch must use the evaluated count as its denominator"
  );
  // Discriminated on origin, so there is no unreachable "recorded but unknown
  // denominator" branch to write copy for.
  assert.match(source("lib/report-insights.ts"), /\{ origin: "recorded"; evaluated: number \}/);
  assert.doesNotMatch(
    shields,
    /verified classification of \$\{retainedCountLabel\(\s*run\.counts\.totalRequests/,
    "the retained request total is the wrong population for a verified classification"
  );
  // The measurement must actually carry it, or the UI has nothing honest to use.
  const insights = source("lib/report-insights.ts");
  assert.match(insights, /evaluated: facts\.requestsEvaluated/);
  assert.match(insights, /evaluated: null/, "a legacy-derived measurement records no evaluation");
});

/**
 * A censored detector family does not make every count a lower bound. The
 * notice said it did, on runs whose requests, cookies, storage and
 * fingerprinting all completed.
 */
test("the degraded-run notice scopes its lower-bound claim to what was censored", () => {
  const views = source("lib/scan-report-views.ts");
  const notice = views.slice(
    views.indexOf("export function degradedRunNotice"),
    views.indexOf("export function runQualitySummary")
  );
  assert.ok(notice.length > 0);
  assert.match(notice, /failed\.length > 0/, "a failed visit and a censored family must read differently");
  // Matches the contract, not the sentence: the censored branch must say the
  // completed families are NOT lower bounds. Pinning the exact wording is how
  // guards in this repo have repeatedly broken on correct edits.
  assert.match(
    notice,
    /families that completed/,
    "a run whose other families completed must not be told every count is a floor"
  );
});
