import {
  PUBLIC_SUFFIX_ENGINE_VERSION,
  REDACTION_ALLOWLISTS_DIGEST,
  REDACTION_ALLOWLISTS_VERSION,
  REDACTION_VERSION
} from "./redaction-v2";
import {
  PUBLIC_STRING_POLICY_DIGEST,
  PUBLIC_STRING_POLICY_VERSION
} from "./redact-scan-report-v1";
import type { ObserverKind } from "./scan-report-v2";

/** Current producer identities. Builders and remediation must use one source. */
export const NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION =
  `redaction-v${REDACTION_VERSION}+${REDACTION_ALLOWLISTS_VERSION}:${REDACTION_ALLOWLISTS_DIGEST}+${PUBLIC_STRING_POLICY_VERSION}:${PUBLIC_STRING_POLICY_DIGEST}+${PUBLIC_SUFFIX_ENGINE_VERSION}+node-evidence-policy-v1+r2-http-status-compat-v1`;

export const PAGEGRAPH_R2_NORMALIZATION_VERSION =
  `redaction-v${REDACTION_VERSION}+${REDACTION_ALLOWLISTS_VERSION}:${REDACTION_ALLOWLISTS_DIGEST}+${PUBLIC_STRING_POLICY_VERSION}:${PUBLIC_STRING_POLICY_DIGEST}+${PUBLIC_SUFFIX_ENGINE_VERSION}+pagegraph-request-evidence-v1+r2-http-status-compat-v1`;

/**
 * Exact reviewed v3 identities that can be replayed through the v4 sanitizer.
 * This is intentionally not a regex: a self-declared or unreviewed v3
 * normalization must fail closed instead of being blessed by remediation.
 */
export const MIGRATABLE_REDACTION_V3_NORMALIZATIONS: Readonly<
  Record<ObserverKind, readonly string[]>
> = Object.freeze({
  "node-playwright": Object.freeze([
    "redaction-v3+allowlists-v2:042fbfccf7b914479b7100002c5f709b54314606840c4dde50fb2368e23c30e8+public-string-policy-v2:74f1170bbf38a2f85629fa612c01f5da3c0ab1d8f0042f4082eef21815db868c+tldts@7.4.3+node-evidence-policy-v1"
  ]),
  "pagegraph-import": Object.freeze([
    "redaction-v3+allowlists-v2:042fbfccf7b914479b7100002c5f709b54314606840c4dde50fb2368e23c30e8+public-string-policy-v2:74f1170bbf38a2f85629fa612c01f5da3c0ab1d8f0042f4082eef21815db868c+tldts@7.4.3+pagegraph-request-evidence-v1"
  ]),
  // Browser Run is a retired report producer. Its historical r1/r2 outputs
  // have no reviewed v3 replay identity and cannot be upgraded by inference.
  "browser-run-worker": Object.freeze([])
});

/**
 * Identities this generation has already published and retired without
 * remediating a single byte. Two kinds of change qualify, and nothing else.
 *
 * A WIDENING of the sanitizer's public-string vocabulary admits strings the
 * older pass replaced with a placeholder, so every report the older pass
 * produced is still a fixed point of the newer one. It keeps its own identity,
 * because it really was sanitized under the narrower vocabulary and a reader
 * comparing two reports must be able to see that.
 *
 * A public-suffix ENGINE refresh that provably admits the same strings also
 * qualifies, and only with the proof: the vocabulary is unchanged, so the
 * fixed-point property holds exactly when the new engine returns the same
 * registrable domain, suffix, and ICANN/private flags for every hostname the
 * published corpus and the reviewed allowlists contain. Verify that
 * differentially before adding the entry, never assume it from a patch-level
 * version bump.
 *
 * Exact strings, never a pattern, for the same reason the v3 set is exact: an
 * unreviewed or self-declared identity must fail closed rather than be blessed
 * by inference. Only add an entry for a change that cannot remove a string from
 * the admitted set; anything that can REQUIRES remediation instead.
 */
export const SUPERSEDED_R2_NORMALIZATIONS: Readonly<
  Record<ObserverKind, readonly string[]>
> = Object.freeze({
  "node-playwright": Object.freeze([
    // V1 probe disclosure widening; no previously admitted string is removed.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:6c78c05523e1f16c88264d0144af33587bd6dc11e04d337a6af2d58190639266+tldts@7.4.10+node-evidence-policy-v1+r2-http-status-compat-v1",
    // First deployed v4 identity. Retired by scanner-warning-patterns-v4,
    // which widened only the fixed scanner-warning vocabulary.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:dbb6c25e0645a6a98c2290d562f931ccfe065cf0ab1feded4798920024d312a3+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1",
    // Retired by scanner-warning-patterns-v5, which admits the three consent
    // probe-failure disclosures that v4 replaced with "[redacted warning]".
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:6e87d9833c274788638c00887eb2dc1f3edd6e45ea5137ac07871279b24ec40b+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1",
    // Retired by scanner-warning-patterns-v6, which admits the unconfirmed
    // consent dispatch and the unsettled routed-request disclosures.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:5b1fd8d09fed5a91b2f1e3a395a2a5a6794fc879f05f9eaea1b00652542cf0bd+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1",
    // Retired by scanner-warning-patterns-v7, which admits the unreadable-frame
    // consent disclosure split out of "search-interrupted".
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:61319540712ac2cf0c4851669a5a2fddbe96305b885818269808bd5706632f3a+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1",
    // Retired by the accuracy hardening release, which adds only controlled
    // scanner warnings to the admitted public vocabulary.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:68c36f5132e92c25d024a23e201f931304ff9527063ac622f622e5955682bf23+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1",
    // Retired by catalog-review-v3 / hand-curated-2026.08: the sanitizer's
    // reviewed historical-catalog list (a policy-digest input) gained the
    // closing 2026.07 identity, and the catalog additions only admit new
    // entity, category, and suffix strings. Nothing an older pass admitted
    // was removed, so every published report stays a fixed point.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:b68c7b0c0312d1ea5799aa491859ff88737e16da2791453b0936a9b4c14d62a7+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1",
    // Retired by scanner-warning-patterns-v8, which widens the HTTP status
    // disclosure to the full three-digit grammar the producer can emit
    // (LinkedIn's 999 and other out-of-band refusals previously became
    // "[redacted warning]") and admits the amended consent-arm interaction
    // disclosure alongside the sentence it replaces. Both changes only admit;
    // nothing an older pass admitted was removed, so every published report
    // stays a fixed point.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:ec263b9176229101c26212bf1cef8a04cdeb167777a2f8501a842b4eab53d0ae+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1",
    // Retired by the 2026-08-04 measurement epoch, which moved the public
    // suffix engine to tldts@7.4.10. The admitted public-string vocabulary is
    // byte-identical on both sides (the policy digest does not move), and
    // 7.4.10 is a data-only refresh of the suffix trie: parsing every
    // hostname-shaped string in the published corpus, the allowlists, and the
    // tracker catalog under both engines produced identical registrable
    // domains, suffixes, and ICANN/private flags, so no published report loses
    // an admitted string and every one stays a fixed point. The identity still
    // moves, because the engine that computed those domains is recorded
    // methodology and a reader comparing two reports must be able to see it.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:6c78c05523e1f16c88264d0144af33587bd6dc11e04d337a6af2d58190639266+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1"
  ]),
  "pagegraph-import": Object.freeze([
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:6c78c05523e1f16c88264d0144af33587bd6dc11e04d337a6af2d58190639266+tldts@7.4.10+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:dbb6c25e0645a6a98c2290d562f931ccfe065cf0ab1feded4798920024d312a3+tldts@7.4.9+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:6e87d9833c274788638c00887eb2dc1f3edd6e45ea5137ac07871279b24ec40b+tldts@7.4.9+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:5b1fd8d09fed5a91b2f1e3a395a2a5a6794fc879f05f9eaea1b00652542cf0bd+tldts@7.4.9+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:61319540712ac2cf0c4851669a5a2fddbe96305b885818269808bd5706632f3a+tldts@7.4.9+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:68c36f5132e92c25d024a23e201f931304ff9527063ac622f622e5955682bf23+tldts@7.4.9+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:b68c7b0c0312d1ea5799aa491859ff88737e16da2791453b0936a9b4c14d62a7+tldts@7.4.9+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    // Retired by scanner-warning-patterns-v8; see the node-playwright entry.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:ec263b9176229101c26212bf1cef8a04cdeb167777a2f8501a842b4eab53d0ae+tldts@7.4.9+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    // Retired by the tldts@7.4.10 public-suffix move; see the node-playwright entry.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:6c78c05523e1f16c88264d0144af33587bd6dc11e04d337a6af2d58190639266+tldts@7.4.9+pagegraph-request-evidence-v1+r2-http-status-compat-v1"
  ]),
  "browser-run-worker": Object.freeze([])
});

export function currentR2NormalizationForObserver(observer: ObserverKind): string | null {
  if (observer === "node-playwright") return NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION;
  if (observer === "pagegraph-import") return PAGEGRAPH_R2_NORMALIZATION_VERSION;
  return null;
}

/**
 * True for an identity this generation may READ unchanged: the active one, or
 * one it superseded by widening. Producing a fresh report still requires the
 * active identity; this only governs already-published bytes.
 */
export function isReadableR2Normalization(observer: ObserverKind, source: string): boolean {
  return (
    source === currentR2NormalizationForObserver(observer) ||
    SUPERSEDED_R2_NORMALIZATIONS[observer].includes(source)
  );
}

export const REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX = "v3-to-v4-ip-port-title@1";

export function migratedR2NormalizationForV3(observer: ObserverKind, source: string): string | null {
  if (!MIGRATABLE_REDACTION_V3_NORMALIZATIONS[observer].includes(source)) return null;
  // Preserve the exact historical base. Replacing it with a fresh-producer
  // identity would falsely make a remediated tldts/list snapshot comparable
  // to a newly captured v4 run.
  return `${source}+${REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX}`;
}
