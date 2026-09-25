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
 * remediating a single byte. Three kinds of change qualify, and nothing else.
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
 * A public-suffix engine refresh that CAN remove admitted strings qualifies
 * only as a recorded owner exception. An entry is not a readability guarantee:
 * the managed reader re-runs the current sanitizer over every stored
 * redaction-v4 r2 report whatever normalization it declares, so a stored report
 * holding a host whose redaction the new engine changes, or a registrable
 * domain it stored that the new engine redacts or recomputes differently,
 * fails closed. Such an entry needs, in its own comment, the complete set of host
 * shapes and stored-domain positions that stop being fixed points, the committed
 * corpus proof that none of them is published, the retention bound on the live
 * store, and the owner's acceptance of orphaning the stored reports that hold
 * one. Short of all four, remediate.
 *
 * Exact strings, never a pattern, for the same reason the v3 set is exact: an
 * unreviewed or self-declared identity must fail closed rather than be blessed
 * by inference. Outside that recorded exception, only add an entry for a
 * change that cannot remove a string from the admitted set; anything that can
 * REQUIRES remediation instead.
 */
export const SUPERSEDED_R2_NORMALIZATIONS: Readonly<
  Record<ObserverKind, readonly string[]>
> = Object.freeze({
  "node-playwright": Object.freeze([
    // Retired by the node-detectors-v10 measurement epoch, which admits two
    // exact fixed scanner warnings: the v1 listener-withheld disclosure
    // (LISTENER_DETECTION_WITHHELD_WARNING) and the input probe's unread
    // request line (KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING). Nothing an older
    // pass admitted was removed and the public-suffix engine is unchanged, so
    // every published report stays a fixed point.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:cb7064a154022024d8ffa25c110de6feff64f2b0ecbd375b14a24ff17105059d+tldts@7.4.13+node-evidence-policy-v1+r2-http-status-compat-v1",
    // Retired by the 2026-09 toolchain epoch, which moved the public-suffix
    // engine to tldts@7.4.13 under the same policy digest. This is the
    // recorded owner exception in the docblock above, not a widening: it
    // removes admitted strings. tldts-core 7.4.13 ships the same JavaScript as
    // 7.4.10 and tldts changes only its suffix trie: 94 rules added (6
    // wildcard, 88 exact) and 8 removed. The authoritative list is the rule
    // diff between the two tldts tries. Categories 1 to 4 are host strings
    // (a request, cookie, frame or script host); category 5 is a registrable
    // domain the report stores. By category, a host the 7.4.10 sanitizer
    // published:
    // 1. under one of the 8 removed rules stops being a fixed point when a
    //    label the older engine kept whole as part of the registrable domain
    //    is now generalized or moved: "myapp.adaptable.app" becomes
    //    "{label}.adaptable.app". A host whose labels below the new
    //    registrable domain are all ones the allowlist keeps stays fixed
    //    (api.adaptable.app, www.xnbay.com; not www.u2.xnbay.com, whose u2 is
    //    generalized). Below aivencloud.com only direct children fail as host
    //    strings, all of them, because *.aivencloud.com replaces it. The
    //    allowlist exception does not hold for a CNAME-cloak tracker domain,
    //    and the aivencloud one holds for neither stored position (5);
    // 2. that is a direct child of one of the 6 wildcard-added zones
    //    (*.eth.limo, *.eth.link, *.p.azurewebsites.net,
    //    *.cursorusercontent.com, *.builtwithrocket.new, *.aivencloud.com)
    //    stops being a fixed point: "{label}.eth.limo" is now a suffix and
    //    redacts to "{invalid-host}";
    // 3. below one of the 88 exact added rules STAYS a fixed point as a host
    //    string. Azure's newer default App Service hostnames sit under the 71
    //    added "<region>-01.azurewebsites.net" rules: the older engine
    //    already published them as "{label}.<region>-01.azurewebsites.net",
    //    which the new one reads as a registrable domain and leaves alone. The
    //    same app as the scanned site fails (5);
    // 4. equal to one of those exact rules, now a suffix itself, stops being
    //    a fixed point for 84 of the 88 (cloud.run, scw.site, the bare Azure
    //    region hosts, among others); the other 4 were published as
    //    "{label}.<parent>" and stay fixed;
    // 5. stored as a registrable domain the 7.4.10 engine computed is checked
    //    again under the new engine even where every host string above stays
    //    fixed. The scanned site's subject.requested and subject.observed
    //    registrableDomain fail when the new engine redacts them differently:
    //    a site below an exact added rule (87 of the 88; only vps.hrsn.net
    //    keeps hrsn.net) or deeper than a direct child under
    //    *.aivencloud.com. The sanitizer throws unsafe-subject-identity,
    //    which the reader reports as redaction-not-idempotent and the
    //    remediation planner as unsupported-report-schema. The domain and
    //    entity of a Shields-list tracker matched through a CNAME cloak fail
    //    when the new engine computes a different registrable domain for the
    //    stored target: below an exact added rule (again all but
    //    vps.hrsn.net), deeper than a direct child under a wildcard-added
    //    zone, or an allowlisted host under a removed rule (api.adaptable.app);
    //    the reader reports that as redaction-not-idempotent and the planner
    //    as unsupported-report-schema (sanitizer-rejected-evidence). A
    //    scanned site keeps the allowlist exception. A scanned App Service app
    //    on Azure's newer "<region>-01.azurewebsites.net" hostnames, or a
    //    scanned Cloud Run service, is the likeliest live case.
    // readManagedReport enters its fixed-point branch on the redaction
    // version alone, never the normalization, so every stored redaction-v4 r2
    // report of every era, not only cb7064 ones, is re-redacted with the new
    // engine when read, and one holding a host in category 1, 2 or 4, or a
    // stored registrable domain in category 5, fails closed instead of being
    // served. Read-time
    // party grouping of a host kept whole under a changed zone also follows
    // the new engine (api.cloud.run groups as itself, no longer under
    // cloud.run).
    // Committed corpus: every host-like token and URL in the committed
    // reports, their provenance sidecars, the index, the allowlists, the
    // tracker catalogs and every other tracked text file parses to the same
    // domain, suffix and ICANN/private flags and redacts to the same bytes
    // under both engines, and none falls inside a changed rule's zone as a
    // host or a stored registrable domain, so every committed report stays a
    // fixed point. Live store: the application
    // stops serving a share at its 7-day expiry and the bucket's
    // reports-retention-backstop-8d rule deletes the reports/ prefix at 8 days
    // (research/ops-receipts/r2-lifecycle-readback.json; the owner read the
    // rule back with wrangler for this epoch), so exposure is bounded to
    // reports saved in the 8 days before the deploy that hold such a host.
    // The owner accepted orphaning those reports instead of remediating them.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:cb7064a154022024d8ffa25c110de6feff64f2b0ecbd375b14a24ff17105059d+tldts@7.4.10+node-evidence-policy-v1+r2-http-status-compat-v1",
    // Retired by node-detectors-v9, which admits the fingerprint
    // listener-attribution disclosure beside the unreadable-frame one. Only a
    // fixed scanner warning is added; nothing an older pass admitted was
    // removed, so every published report stays a fixed point.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:42735187d5a7121bacd36074418a138c64dfb0eb5575b5983a134398670e5384+tldts@7.4.10+node-evidence-policy-v1+r2-http-status-compat-v1",
    // Catalog public-suffix metadata is now retained; prior admitted bytes stay unchanged.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:980a41d7ebd83e46269be8565bfa4547185d2282415884d39b7592752064df26+tldts@7.4.10+node-evidence-policy-v1+r2-http-status-compat-v1",
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
    // Retired by the two warnings node-detectors-v10 admits; see the
    // node-playwright entry.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:cb7064a154022024d8ffa25c110de6feff64f2b0ecbd375b14a24ff17105059d+tldts@7.4.13+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    // Retired by the 2026-09 toolchain epoch's move to tldts@7.4.13; see the
    // node-playwright entry.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:cb7064a154022024d8ffa25c110de6feff64f2b0ecbd375b14a24ff17105059d+tldts@7.4.10+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    // Retired by node-detectors-v9's listener-attribution disclosure; see the
    // node-playwright entry.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:42735187d5a7121bacd36074418a138c64dfb0eb5575b5983a134398670e5384+tldts@7.4.10+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    // Catalog public-suffix metadata is now retained; prior admitted bytes stay unchanged.
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:980a41d7ebd83e46269be8565bfa4547185d2282415884d39b7592752064df26+tldts@7.4.10+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
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
 * True for an identity this generation ACCEPTS on already-published bytes: the
 * active one, or one it superseded (see SUPERSEDED_R2_NORMALIZATIONS). This
 * gates the declared identity only; each report must still be a fixed point of
 * the current sanitizer to be read. Producing a fresh report still requires
 * the active identity.
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
