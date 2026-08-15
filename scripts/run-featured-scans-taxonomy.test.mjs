import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFeaturedFailures } from "./run-featured-scans.mjs";

/**
 * Pinned to the EXACT strings two real runs produced on 2026-08-14, not to
 * invented ones. A classifier written against paraphrases is a classifier that
 * silently stops matching the first time the producer rewords a message, and
 * the failure mode is the worst kind: everything lands in `unclassified` while
 * the run still looks green.
 */
const REAL_FAILURES = [
  { site: "coinbase.com", message: "Skipping scan target: primary baseline arm: main navigation returned HTTP 403." },
  { site: "reuters.com", message: "Skipping scan target: primary baseline arm: main navigation returned HTTP 401." },
  { site: "wayfair.com", message: "Skipping scan target: primary baseline arm: main navigation returned HTTP 429." },
  { site: "fidelity.com", message: "The page could not be loaded. The site may be down, unreachable, or blocking automated visits." },
  { site: "cnn.com", message: "Skipping scan target: primary baseline arm: only 1 network request(s) observed, navigation likely failed or was blocked." },
  { site: "ebay.com", message: "The scan exceeded the maximum scan duration." },
  { site: "americanexpress.com", message: "Skipping scan target: primary baseline arm: report could not verify the rendered page subject." }
];

test("site refusals are separated from scanner faults", () => {
  const groups = classifyFeaturedFailures(REAL_FAILURES);
  const refused = groups.get("target-refused") ?? [];
  assert.deepEqual(
    refused.map((entry) => entry.site).sort(),
    ["cnn.com", "coinbase.com", "fidelity.com", "reuters.com", "wayfair.com"],
    "403, 401, 429, an unreachable load and a one-request navigation are all the site declining"
  );
  assert.deepEqual((groups.get("scanner-timeout") ?? []).map((e) => e.site), ["ebay.com"]);
  assert.deepEqual((groups.get("subject-unverified") ?? []).map((e) => e.site), ["americanexpress.com"]);
});

test("nothing real lands in unclassified", () => {
  // The bucket exists so an unfamiliar message is visible rather than silently
  // counted as a refusal. If a producer reword drops known failures into it,
  // this fails instead of quietly reclassifying the web as hostile.
  const groups = classifyFeaturedFailures(REAL_FAILURES);
  assert.equal(groups.get("unclassified"), undefined);
  const unknown = classifyFeaturedFailures([{ site: "x.example", message: "something nobody has seen" }]);
  assert.equal((unknown.get("unclassified") ?? []).length, 1);
});

test("refusals are reported first", () => {
  // They are the large, expected group. Listing a one-off scanner fault above
  // them is what makes a rate read as a regression.
  const order = [...classifyFeaturedFailures(REAL_FAILURES).keys()];
  assert.equal(order[0], "target-refused");
});

test("the taxonomy changes no counts", () => {
  // It names the parts; it must never alter the denominator or the rate. A
  // classifier that drops or duplicates a failure would move the gate it exists
  // to explain.
  const groups = classifyFeaturedFailures(REAL_FAILURES);
  const total = [...groups.values()].reduce((sum, group) => sum + group.length, 0);
  assert.equal(total, REAL_FAILURES.length);
  assert.deepEqual(classifyFeaturedFailures([]).size, 0);
});
