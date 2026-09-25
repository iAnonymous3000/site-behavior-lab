import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { publicStringPolicyInputs } from "./redact-scan-report-v1";
import { PRIVATE_SUFFIX_TENANT_SHAPES } from "./redaction-v2";
import {
  NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
  PAGEGRAPH_R2_NORMALIZATION_VERSION,
  SUPERSEDED_R2_NORMALIZATIONS
} from "./scan-report-v2-normalization";
import {
  HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION,
  NODE_R2_PRODUCER_TUPLES,
  PAGEGRAPH_R2_PRODUCER_TUPLES
} from "./scan-report-v2-r2-producer-contract";

/**
 * The identity ledger: the two ACTIVE r2 normalization identities, pinned as
 * exact reviewed literals.
 *
 * The active identities are COMPUTED from the redaction and public-string
 * policy digests, and several producer tuples reference the computed constant
 * rather than a literal. So a change anywhere in the sanitizer's inputs (an
 * allowlist entry, the patterns label, a policy digest input) moves the active
 * identity, the tuples follow it, and every live report published under the
 * OLD identity is silently orphaned from remediation replay and
 * readable-identity checks while every test stays green. That drift was
 * demonstrated experimentally before this ledger existed.
 *
 * When this test fails, the identity moved. That is sometimes correct, but it
 * is never incidental. The ritual, in order:
 *
 *   1. Decide whether the change is a WIDENING (the new sanitizer admits a
 *      superset; every published report is still a fixed point), a
 *      public-suffix ENGINE refresh proved equivalent over the published
 *      corpus, or a NARROWING (anything else).
 *   2. For a widening or a proved-equivalent engine refresh: append the OLD
 *      literal below to SUPERSEDED_R2_NORMALIZATIONS for BOTH observers in
 *      scan-report-v2-normalization.ts, and pair it with its historical
 *      producer epoch in HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION
 *      (and the PageGraph catalog map) in scan-report-v2-r2-producer-contract.ts.
 *      An engine refresh needs the differential proof, not a version bump: same
 *      registrable domain, suffix, and ICANN/private flags for every hostname
 *      in the published corpus and the reviewed allowlists.
 *   3. For a narrowing: STOP. Published reports need remediation before the
 *      identity may move; see docs/scan-report-v2-rfc.md and the remediation
 *      CLI. There are two exceptions, each an owner decision recorded in its
 *      SUPERSEDED_R2_NORMALIZATIONS entry with everything that file's docblock
 *      requires: an engine refresh the owner accepts without remediation (the
 *      tldts 7.4.10 to 7.4.13 move is one), and a reviewed sanitizer narrowing
 *      the owner accepts (public-string-policy-v4 is one). The narrowing also
 *      moves PUBLIC_STRING_POLICY_VERSION, replaces every committed report
 *      holding a removed string through a privacy replacement in the same
 *      push, and pins the retired literals in RETIRED_*_LITERAL below. Stored
 *      reports either changes fail closed on read.
 *   4. Check every producer tuple that references an ACTIVE or computed
 *      constant (the node-v4-*-active-* family in
 *      scan-report-v2-r2-producer-contract.ts): tuples that described the OLD
 *      epoch must be repointed at a HISTORICAL_* constant carrying the old
 *      literal, or their reports stop validating. This is not only the
 *      normalization: NODE_R2_CURRENT_ADBLOCK_IDENTITY moves with every Brave
 *      list refresh, and NODE_R2_PUBLIC_LIMITS / PAGEGRAPH_R2_PUBLIC_LIMITS
 *      derive their request ceiling from the live MAX_RECORDED_REQUESTS. A
 *      closed row that follows any of them silently restates what its
 *      already-published reports were measured and validated against, which is
 *      the same drift this ledger exists to catch.
 *   5. Only then update the two literals below to the new identity.
 */
const ACTIVE_NODE_R2_NORMALIZATION_LITERAL =
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v4:359b216f1168c4caf2f107e9f5220cbab5e0da9b4dad686129922a9ab3e4e9bc+tldts@7.4.13+node-evidence-policy-v1+r2-http-status-compat-v1";
const ACTIVE_PAGEGRAPH_R2_NORMALIZATION_LITERAL =
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v4:359b216f1168c4caf2f107e9f5220cbab5e0da9b4dad686129922a9ab3e4e9bc+tldts@7.4.13+pagegraph-request-evidence-v1+r2-http-status-compat-v1";

/**
 * The identities the latest NARROWING retired, pinned as exact literals beside
 * the active ones. A narrowing's superseded entry is not optional: without it
 * every stored share under the retired identity fails as an unreviewed
 * normalization, affected or not. The corpus cannot notice its absence, since
 * no committed report carries the retired identity, and neither can the replay
 * loops over SUPERSEDED_R2_NORMALIZATIONS and the closed producer rows, which
 * iterate over whatever those tables hold: a missing entry or row just runs
 * one fewer time. Replace these two literals, with the test below, at the next
 * narrowing.
 */
const RETIRED_NODE_R2_NORMALIZATION_LITERAL =
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:b40a333af90f0b6a7bd1e5c702edcd7ef768167bc811ae20272a6e993cb83d51+tldts@7.4.13+node-evidence-policy-v1+r2-http-status-compat-v1";
const RETIRED_PAGEGRAPH_R2_NORMALIZATION_LITERAL =
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:b40a333af90f0b6a7bd1e5c702edcd7ef768167bc811ae20272a6e993cb83d51+tldts@7.4.13+pagegraph-request-evidence-v1+r2-http-status-compat-v1";

test("the active r2 normalization identities match their reviewed ledger literals", () => {
  assert.equal(
    NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
    ACTIVE_NODE_R2_NORMALIZATION_LITERAL,
    "The ACTIVE node r2 normalization identity moved. This orphans every live r2 report published under the old identity unless the retirement ritual in this file's docblock runs first."
  );
  assert.equal(
    PAGEGRAPH_R2_NORMALIZATION_VERSION,
    ACTIVE_PAGEGRAPH_R2_NORMALIZATION_LITERAL,
    "The ACTIVE PageGraph r2 normalization identity moved. This orphans every live PageGraph r2 report published under the old identity unless the retirement ritual in this file's docblock runs first."
  );
});

/**
 * The admitted-warning vocabulary has two halves: exact strings (which feed the
 * policy digest and therefore the identity above) and the isScannerWarning
 * PATTERN block, which the digest never sees. Its version lives only in the
 * hand-bumped `dynamicWarningPatterns` label, so editing a regex without
 * bumping the label publishes two different vocabularies under one identity
 * and nothing fails. Pin the function source alongside the label: changing
 * either without the other goes red, and the fix is to update BOTH (and treat
 * the change as a widening per the ritual above, since an admitted-pattern
 * change is a vocabulary change even though the digest cannot show it).
 */
const PINNED_DYNAMIC_WARNING_PATTERNS_LABEL = "scanner-warning-patterns-v9";
const PINNED_IS_SCANNER_WARNING_SHA256 =
  "5079a0127a6274827ed58561c291b3ab113ded3478eca6605235f5632d24de4d";

test("the warning-pattern block matches the version label that names it", () => {
  const source = readFileSync(path.join(process.cwd(), "lib", "redact-scan-report-v1.ts"), "utf8");

  const labelMatch = source.match(/dynamicWarningPatterns:\s*"([^"]+)"/);
  assert.ok(labelMatch, "dynamicWarningPatterns label not found");
  assert.equal(labelMatch[1], PINNED_DYNAMIC_WARNING_PATTERNS_LABEL);

  const start = source.indexOf("function isScannerWarning(");
  assert.ok(start > 0, "isScannerWarning not found");
  const end = source.indexOf("\nfunction ", start + 1);
  assert.ok(end > start, "isScannerWarning end not found");
  const digest = createHash("sha256").update(source.slice(start, end)).digest("hex");
  assert.equal(
    digest,
    PINNED_IS_SCANNER_WARNING_SHA256,
    `isScannerWarning changed without this pin moving. If the change alters which strings are admitted, bump dynamicWarningPatterns (currently "${PINNED_DYNAMIC_WARNING_PATTERNS_LABEL}") and run the identity-retirement ritual above; then update this pin to ${digest}.`
  );
});

test("the identities the public-string-policy-v4 narrowing retired stay declarable and replayable", () => {
  assert.notEqual(RETIRED_NODE_R2_NORMALIZATION_LITERAL, NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION);
  assert.notEqual(RETIRED_PAGEGRAPH_R2_NORMALIZATION_LITERAL, PAGEGRAPH_R2_NORMALIZATION_VERSION);
  assert.equal(
    SUPERSEDED_R2_NORMALIZATIONS["node-playwright"].includes(RETIRED_NODE_R2_NORMALIZATION_LITERAL),
    true,
    "the retired Node identity must be a SUPERSEDED_R2_NORMALIZATIONS entry"
  );
  assert.equal(
    SUPERSEDED_R2_NORMALIZATIONS["pagegraph-import"].includes(RETIRED_PAGEGRAPH_R2_NORMALIZATION_LITERAL),
    true,
    "the retired PageGraph identity must be a SUPERSEDED_R2_NORMALIZATIONS entry"
  );
  const methodologies = HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION[RETIRED_NODE_R2_NORMALIZATION_LITERAL];
  assert.ok(methodologies && methodologies.length > 0, "the retired Node identity must name its producer epoch");
  // Every methodology it names has a closed row, with and without the lists.
  const nodeRows = NODE_R2_PRODUCER_TUPLES.filter(
    (tuple) => tuple.normalizationVersion === RETIRED_NODE_R2_NORMALIZATION_LITERAL
  );
  assert.equal(nodeRows.length > 0, true, "no closed Node producer row carries the retired identity");
  for (const methodology of methodologies) {
    for (const lists of [true, false]) {
      assert.equal(
        nodeRows.some((tuple) => tuple.methodologyVersion === methodology && (tuple.adblockIdentity !== null) === lists),
        true,
        `no closed ${lists ? "list" : "no-adblock"} row for ${methodology}`
      );
    }
  }
  for (const tuple of nodeRows) assert.equal(methodologies.includes(tuple.methodologyVersion), true, tuple.id);
  assert.equal(
    PAGEGRAPH_R2_PRODUCER_TUPLES.some(
      (tuple) => tuple.normalizationVersion === RETIRED_PAGEGRAPH_R2_NORMALIZATION_LITERAL
    ),
    true,
    "no closed PageGraph producer row carries the retired identity"
  );
});

/**
 * The public-string policy digest hashes the private-suffix tenant shapes and
 * the policy-quote identifier spans as pattern SOURCES and thresholds under a
 * hand-bumped label each, and the span policy also hashes the
 * trailing-punctuation rule and the incomplete-quote marker, both declared
 * outside the quote functions. The code that combines them is not hashed, so
 * two blocks of source text are pinned here beside their labels, as
 * isScannerWarning is above, because Function.prototype.toString would differ
 * between the tsc and esbuild bundles:
 *   - redaction-v2.ts from isGeneralizedTenantLabel through
 *     generalizePrivateSuffixTenant: the xn-- exemption, the label and
 *     segment digit-run counts, the segment split and the counter;
 *   - redact-scan-report-v1.ts from redactPolicyQuote through
 *     withoutTrailingSentenceEnd: the scrub-before-cap order, the marker loop,
 *     the span order and replacement, and the incomplete-quote form
 *     (markIncompleteQuote and the sentence-end characters it strips).
 * A change to either block that alters which strings are published needs its
 * label bumped and the identity ritual in this file's docblock; a change that
 * alters nothing updates only the pin.
 */
const PINNED_TENANT_SHAPES_LABEL = "private-suffix-tenant-shapes-v1";
const PINNED_TENANT_RULE_SHA256 = "010920430673f65dde633e51668379c648765f3737dc2e456680f490f9a63177";
const PINNED_QUOTE_SPANS_LABEL = "policy-quote-identifier-spans-v1";
const PINNED_QUOTE_SCRUB_SHA256 = "7415b98528413ae2e704890f1e5a06ce7f91e1685ce9036f932371ee5cac897a";

function pinnedBlock(file: string, first: string, last: string): string {
  const source = readFileSync(path.join(process.cwd(), "lib", file), "utf8");
  const start = source.indexOf(first);
  assert.ok(start > 0, `${first} not found`);
  const lastStart = source.indexOf(last, start);
  assert.ok(lastStart > start, `${last} not found after ${first}`);
  const end = source.indexOf("\n}\n", lastStart);
  assert.ok(end > lastStart, `${last} end not found`);
  return source.slice(start, end + 3);
}

test("the tenant rule and the quote scrub match the labels that name them in the policy digest", () => {
  assert.equal(PRIVATE_SUFFIX_TENANT_SHAPES.label, PINNED_TENANT_SHAPES_LABEL);
  assert.equal(publicStringPolicyInputs().policyQuoteIdentifierSpans.label, PINNED_QUOTE_SPANS_LABEL);

  const tenant = createHash("sha256")
    .update(pinnedBlock("redaction-v2.ts", "function isGeneralizedTenantLabel(", "function generalizePrivateSuffixTenant("))
    .digest("hex");
  assert.equal(
    tenant,
    PINNED_TENANT_RULE_SHA256,
    `the private-suffix tenant rule changed without this pin moving. If the change alters which hosts generalize, bump PRIVATE_SUFFIX_TENANT_SHAPES.label (currently "${PINNED_TENANT_SHAPES_LABEL}") and run the identity ritual above; then update this pin to ${tenant}.`
  );
  const quoteBlock = pinnedBlock("redact-scan-report-v1.ts", "function redactPolicyQuote(", "function withoutTrailingSentenceEnd(");
  // The incomplete-quote form changes published quote bytes as much as the
  // spans do, so the pin must reach it.
  for (const name of ["export function scrubPolicyQuoteIdentifiers(", "function markIncompleteQuote(", "function withoutTrailingSentenceEnd("]) {
    assert.equal(quoteBlock.includes(name), true, `the quote-scrub pin must cover ${name}`);
  }
  const quote = createHash("sha256").update(quoteBlock).digest("hex");
  assert.equal(
    quote,
    PINNED_QUOTE_SCRUB_SHA256,
    `the policy-quote scrub changed without this pin moving. If the change alters which quotes publish, bump the span policy label (currently "${PINNED_QUOTE_SPANS_LABEL}") and run the identity ritual above; then update this pin to ${quote}.`
  );
});
