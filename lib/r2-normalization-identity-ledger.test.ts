import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
  PAGEGRAPH_R2_NORMALIZATION_VERSION
} from "./scan-report-v2-normalization";

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
 *      superset; every published report is still a fixed point) or a
 *      NARROWING (anything else).
 *   2. For a widening: append the OLD literal below to
 *      SUPERSEDED_R2_NORMALIZATIONS for BOTH observers in
 *      scan-report-v2-normalization.ts, and pair it with its historical
 *      producer epoch in HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION
 *      (and the PageGraph catalog map) in scan-report-v2-r2-producer-contract.ts.
 *   3. For a narrowing: STOP. Published reports need remediation before the
 *      identity may move; see docs/scan-report-v2-rfc.md and the remediation
 *      CLI.
 *   4. Check every producer tuple that references the ACTIVE constant
 *      (node-v4-b68c-* in scan-report-v2-r2-producer-contract.ts): tuples that
 *      described the OLD epoch must be repointed at a new HISTORICAL_*
 *      constant carrying the old literal, or their reports stop validating.
 *   5. Only then update the two literals below to the new identity.
 */
const ACTIVE_NODE_R2_NORMALIZATION_LITERAL =
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:b68c7b0c0312d1ea5799aa491859ff88737e16da2791453b0936a9b4c14d62a7+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1";
const ACTIVE_PAGEGRAPH_R2_NORMALIZATION_LITERAL =
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:b68c7b0c0312d1ea5799aa491859ff88737e16da2791453b0936a9b4c14d62a7+tldts@7.4.9+pagegraph-request-evidence-v1+r2-http-status-compat-v1";

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
const PINNED_DYNAMIC_WARNING_PATTERNS_LABEL = "scanner-warning-patterns-v7";
const PINNED_IS_SCANNER_WARNING_SHA256 =
  "af0925bbeb63878bcf963b3008b527970f94fe2232c7067f7cf276dba23dab67";

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
