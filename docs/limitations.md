# Limitations and acceptable use in detail

The long-form boundary statements, moved out of the README on 2026-09-02. The
README carries the condensed version; the wording here is the wording the
guard tests pin, so change both together.

## Acceptable Use

Use Site Behavior Lab for transparency research, journalism, compliance review, debugging your own sites, or inspecting public websites where that activity is allowed. Do not use it for attacking, brute-forcing, crawling at abusive rates, bypassing access controls, or scanning systems you do not own or do not have permission to test.

The visit is passive except for two bounded interactions. First, an **active input probe**: the Node/Playwright scanner types a synthetic, non-PII test value into up to a handful of supported form fields already in the viewport to test for keystroke/input capture. Native form submission is blocked, but focus, input and blur handlers can run and send requests. Unsupported, offscreen and failed attempts count as omitted coverage. It never presses Enter or enters real data; the typed value is synthetic and is not stored, and every report of a visit where at least one field accepted the value discloses how many fields were typed into. A visit where no field accepted it carries no such statement, even when keystrokes were dispatched into fields that refused them. Second, in **consent comparison mode only**, the scanner clicks a single accept-all or reject-all control on the page's cookie/consent banner (first layer only, recognized CMP controls or an exact accept/reject label), and every such run discloses exactly what was clicked or that nothing was. Both interactions' requests still pass through the scanner's SSRF/public-address guard. Operators running an open deployment should be aware their scanner performs these bounded interactions on scanned sites at a visitor's request.

With optional durable execution, an attempt whose execution, publication, or status coordination was lost may be abandoned and retried once under a fenced two-attempt lease. The target can therefore receive an extra automated visit that was partial or that completed before its result was lost. The report still contains one completed attempt per condition and never merges evidence from separate attempts; if a complete R2 report already exists, recovery reconciles that exact stored report instead of visiting again.

Operators of public deployments are still responsible for abuse prevention and local legal compliance. For security-sensitive reports, follow [SECURITY.md](SECURITY.md).

### What this is ready for

Site Behavior Lab produces **reproducible investigative evidence**: a recorded,
versioned account of what one automated Chromium visit observed, with its
measurement boundaries stated in the report itself. That is a sound basis for
research, journalism, debugging your own properties, and building a documented
case to investigate further.

It is **not** a calibrated detector suite or a compliance oracle, and the
repository says so in machine-readable form rather than in marketing prose. Run
the gate yourself before relying on it:

```bash
npm run release:readiness
```

To verify a published report's exact bytes against what this project
published, one command replays the digest chain:

```bash
npm run verify:report -- <report-id>
```

Add `--from <dir>` to check bytes you saved yourself rather than the bytes this
site serves today; if you intend to rely on a report, read
[docs/evidence-custody.md](docs/evidence-custody.md) first, and note that a
printed copy is a rendering whose footer carries the wire digest, not the
evidence.

Every publication is also chained into the append-only
[transparency log](https://sitebehavior.org/transparency-log.json), whose most
recently anchored head carries OpenTimestamps anchors covering the entries
beneath it; anchors cover a prefix, so entries published since that anchor have
no external time bound until the next weekly anchoring run. The detectors'
enumerated blind spots are published on the
[catalog page](https://sitebehavior.org/catalog/), where each entry states
whether a test enforces it against the scanner source or it rests on review.

Two limits matter most for serious work, and both are deliberate:

- **No published detector accuracy.** No claim-bearing detector
  (keystroke-exfiltration, pixel-events, consent-banner, fingerprint-heuristics,
  cname-uncloaking, privacy-policy) has an eligible calibration study yet, so
  there are no precision/recall numbers to quote. Findings are observations to
  verify, not measurements with known error rates. Any future published rate
  must use the v3 study schema and is conditional on its exact structured
  measurement arm; in particular, pixel-event sensitivity is measured only in
  the desktop, GPC-disabled arm where accept-all registration was verified
  again after reload, never from a requested click alone and never generalized
  to all visits. The release-grade, role-separated producer and operator sequence are documented in
  [docs/calibration-study-operations.md](docs/calibration-study-operations.md).
- **The claim boundary is investigative evidence requiring independent
  corroboration.** Standalone legal determinations and sole-court-exhibit use
  are explicitly excluded; that decision is approved and recorded in
  [`RELEASE_READINESS.json`](RELEASE_READINESS.json).

Three practical consequences when interpreting a report:

- A **failed or challenged load is not an absence of trackers.** Sites refuse
  undisguised automated browsers, and the scanner reports that honestly instead
  of evading it. Check the report's quality and bot-wall disclosures before
  reading a low count as a clean result.
- **Counts describe the instrumented visit, not an ordinary browser visit.**
  Capture loss can make retained request counts lower bounds for that same
  visit. Cookie and storage snapshots can change in either direction. Service
  Workers are blocked by design; SharedWorker and WebSocket coverage is absent
  beyond the disclosed boundaries; storage is read from the top frame only.
- **Severity may not be corpus-ranked.** Percentile severity needs a
  current-method cohort of at least 50 sites. Where none exists the report falls
  back to fixed thresholds, and `public/corpus-stats.json` shows each cohort's
  real size.

If you self-host for serious use, read the Docker build-arg note below (the
image bakes in public URLs at build time), and treat durable jobs and an
independent egress backstop as prerequisites rather than options: both are off
in the committed production configuration and are tracked as release gates.

## Data Attribution

The tracker/service catalog is a US-biased, hand-curated, in-repo list of high-prevalence third-party services in [lib/tracker-catalog.ts](lib/tracker-catalog.ts), licensed with this repository under AGPL-3.0-or-later. It deliberately bundles no third-party dataset, so there is no separate NonCommercial term to clear before commercial use.

Coverage is intentionally a lower bound: the curated list names recognizable services rather than every tracker. The Shields filter-list-match and block-simulation signals are computed separately, with Brave's own ad-block engine (the [`adblock`](https://github.com/brave/adblock-rust) Rust crate compiled to WASM, built from `tools/adblock-wasm/`) over Brave's default filter lists, vendored as a pinned snapshot; those lists do not assign the service/entity labels shown by the curated catalog.

[`THIRD_PARTY_INVENTORY.json`](THIRD_PARTY_INVENTORY.json) is the deterministic dependency and filter-source evidence inventory. It is not a complete notice set: the checked lockfiles do not establish licenses for 68 third-party Cargo packages or any of the 31 filter-list sources, so legal review and any required notice/source-offer work remain release gates. The automated dependency/CVE checks, WASM reproducibility boundary, and artifact-attestation gate are documented in [`docs/supply-chain-assurance.md`](docs/supply-chain-assurance.md).


## Important Limitations

### Which workers run, and how the GPC signal reaches them

The Node scanner blocks Service Worker registration so Service Worker fetches
cannot evade Playwright routing or the report recorder. That is a deliberate
containment choice and can make the visit differ from a normal returning-user
session. Dedicated Web Worker requests are recorded; SharedWorker traffic
beyond the entry script is not, and no WebSocket activity is.

A **GPC-enabled visit runs every worker the site asks for**, any script URL
(`http(s):`, `blob:`, and `data:` alike), and delivers the signal into each
dedicated worker's own realm rather than rewriting or refusing the worker. The
scanner attaches a DevTools session to the measured page only, pauses each
dedicated worker (including workers spawned by other workers) before its first
statement, installs `navigator.globalPrivacyControl` inside the worker realm,
and reads the property back in the same evaluation. A worker counts as carrying
the signal only when that readback from inside its own realm returned `true`;
delivery is never inferred from the injection having been attempted. A worker
the scanner could not attest this way still runs untouched, and the run says so
in its warnings and marks its request evidence incomplete. `SharedWorker` is
the standing case: Chromium does not expose shared workers to a page-scoped
DevTools session, so on a GPC-enabled visit a shared worker's realm never
carries the signal (its network requests still carry the `Sec-GPC: 1` header),
and every such construction is disclosed as unverified. The baseline arm gets
no DevTools session, no pause, and no injection, so for verified workers a GPC
comparison differs between arms only in the signal itself; an unverified worker
is the remaining one-arm asymmetry and is always disclosed.

### What one report covers

Site Behavior Lab reports what happened during automated Chromium visits from the configured scanner instance: one completed visit for a single report, or one completed visit per condition for a comparison. Optional durable execution may abandon an attempt whose execution, publication, or status coordination was lost and retry it once, so the target can see an extra visit that was partial or that completed before its result was lost; report evidence is never merged across attempts.

### What the counts describe

Retained request counts can be a lower bound for the same instrumented visit when capture is incomplete. Cookie and storage snapshots can change in either direction and are not monotonic lower bounds. None of these counts establishes what an ordinary browser visit would have done: blocking Service Workers, suppressing navigation, or typing a sentinel can change which requests occur. Requests made by a dedicated Web Worker are recorded (worker sessions attach to the page's network manager), but Service Workers are blocked at context creation so none runs, a SharedWorker's own traffic beyond its entry script is not recorded because the recorder is page-scoped, no WebSocket activity is recorded at all, neither the connection nor its messages (Chromium surfaces sockets only through a listener the scanner does not subscribe to, so the handshake never enters the HTTP request log either), and storage keys are read from the top frame only.

### The two bounded interactions

Each visit is otherwise passive (no scrolling or clicking) except for the consent-banner click and active input probe. The probe types a synthetic, non-personal sentinel into supported fields already in the viewport, blocks native form submission and probe-triggered navigation, and watches retained requests for that value leaving the site. Focus, input and blur handlers can run and send requests. Offscreen fields, constrained number/date fields and failed attempts count as omitted coverage, not site prevention. Auxiliary pages are blocked and omitted request coverage is recorded. The scanner does not navigate away to flush recorders: teardown-only transmissions are not measured. These observations are lower bounds and do not cover login flows, later steps, untested fields or other frames.

### CNAME uncloaking

Separately, the scanner uncloaks CNAME-disguised trackers (third parties hidden behind a first-party subdomain) by resolving first-party subdomains' DNS CNAME chains to known tracking services (the curated catalog first, then the broader Brave Shields lists); this is a bounded, best-effort step that depends on current DNS resolution and that tracker coverage.

### Advertising-pixel event decoding

Advertising-pixel event decoding reads the events Meta/TikTok/X pixels fire from the request itself; standard-vocabulary event names are stored verbatim and site-defined names are generalized to "custom event", while populated advanced-matching identifier fields are detected by checking that a known identifier parameter carries a non-empty value; the value is inspected only transiently in memory and never persisted, exposed, semantically interpreted, or hash-validated (the platforms document the values as hashed; that is not verified). Because the visit is passive and not logged in, advanced-matching identifiers usually appear only on interaction-gated flows (checkout, sign-in, form submit), so a passive visit reports the events fired far more often than the identifiers attached.

### The privacy-policy cross-check

The privacy-policy cross-check is a bounded extra read on the Node scanner: it reads the HTML page or direct PDF the site links from the scanned page (through the scanner's connect-time SSRF guard, after the request log is closed so the read never inflates the report's counts) and runs conservative sentence-level text matches, quoting each matched sentence. PDF bodies are capped at 8 MiB and 64 pages and, like HTML policy text, are accepted only when the complete extracted text fits the detector's text ceiling. Only same-site policy links and known policy-hosting services (Termly, iubenda, and similar) are attributed to the site, so another company's policy (a Cloudflare challenge page's link, the reCAPTCHA badge's Google policy) is never analyzed as the site's own, and the check is skipped entirely when the page load failed. It can miss policies without a discoverable link or hosted on an unrelated corporate domain, image-only PDFs, misread unusual phrasing, and cannot interpret legal definitions, so its findings are documented discrepancies to review, never legal conclusions.

### Comparison modes, and the order the two visits ran in

GPC comparison mode runs two sequential visits, one without GPC and one with it. Shields comparison mode runs one classification-only visit and one Brave Shields block-simulation visit. From the July 13, 2026 randomization release onward, the two visits of a completed comparison attempt run in randomized order so time-ordered site behavior is not systematically assigned to the same arm across scans. Post-release v1 report warnings name the visit that ran first; post-release v2 JSON records `AB` for baseline first or `BA` for variant first. Comparisons captured before that release used a fixed baseline-then-variant order and carry no randomized-order disclosure. A single two-visit report is not counterbalanced; only an aggregate containing independent AB and BA pairs can make that claim.

### Consent comparison

Consent comparison mode runs one visit that clicks the banner's accept-all choice and one that clicks reject-all: the click targets known CMP controls first (OneTrust, Cookiebot, Didomi, Usercentrics, TrustArc, Sourcepoint, and similar, including consent iframes and shadow-DOM hosts), then a conservative exact-label match ("Accept all", "Reject all", "Only necessary cookies", and similar whole labels only), on the banner's first layer only; choices hidden behind a settings layer are not navigated. Banner presence varies by scanner location (many CMPs only gate EEA/UK/California traffic), so a visit where no control could be clicked is disclosed as pre-consent and the report makes no claim about the choice. Legacy v1 reports record only that the click was dispatched; r2 reports also record bounded TCF/OneTrust readbacks and state whether registration was verified or contradicted, only a weak banner-transition signal was seen, or verification was unavailable or failed. Even verified r2 request evidence spans before and after the click, so trackers in the reject-click visit can be pre-choice traffic, strictly-necessary vendors, or processing claimed under legitimate interest; that finding is an observation to review, not a violation ruling.

### The Brave Shields block simulation

The simulation uses Brave's own ad-block engine (the open-source [`adblock`](https://github.com/brave/adblock-rust) Rust crate, compiled to WASM) with the `default_enabled` lists from Brave's filter-list catalog. Under the Node scanner's `shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.1+subject-validity-v2+detector-coverage-v2` base methodology (production r2 reports record the full extended identity, this base plus the phase-kernel, boundary-state, consent, budget, proxy-traffic, service-worker-block, accountability, ServiceRole-taxonomy, and GPC worker-application suffixes, in `provenance.methodologyVersion`), each route-evaluated request is matched with its actual HTTP method against the document that initiated it: an ordinary subresource uses its requesting frame, a subframe navigation uses the parent document, and a non-HTTP inherited frame such as `about:blank` walks to its nearest HTTP(S) ancestor. Main-frame navigations are deliberately neither blocked nor counted as matches, and redirect follow-up URLs that Playwright does not re-route are not independently evaluated. The source URL is used transiently by the engine and never added to the public v1 report. It matches network requests only: it does not apply cosmetic/element-hiding rules (CNAME cloaking is handled by the separate DNS step described above, not the block simulation), and the lists are a pinned snapshot, so blocked counts describe only this engine/list snapshot in the scanner. They do not establish real Brave behavior or a lower bound on its blocking; independently paired browser measurements would be needed to assess that relationship.

### What a result does not generalize to

Differences in either comparison can also reflect timing, experiments, cache state, consent state, or bot detection. Comparisons count as two rate-limit tokens and hold one scan slot until both visits finish. Results are not universal claims about what every visitor will receive. Sites can vary behavior by browser, region, IP reputation, account state, consent state, automation detection, or time.

### Where reports are stored, and for how long

Shareable reports are stored on the configured report store (filesystem or Cloudflare R2) with 128-bit random IDs behind a date prefix. The JSON endpoint has the Node per-client read limit. On the Cloudflare Containers topology, `GET`/`HEAD` requests for runtime report HTML/RSC, the printable rendering, and both generated social cards share an additional atomic Durable Object quota of 120 requests per client and 1,200 globally per fixed minute; refusals are fail-closed and `no-store`, and any other method on `/reports/*` is answered 405 at the edge without reaching the container. Those runtime routes are request-rendered and re-check store expiry every time, so Next's Full Route Cache cannot retain an expired report. Old/excess stored reports are pruned by age and count. Persisted reports omit inline screenshots to keep stored JSON and permalink responses smaller; the immediate in-browser scan result can still show the viewport screenshot. A persistent filesystem volume is suitable for single-node deployments; public or horizontally scaled deployments should use durable shared storage.

When the optional durable queue is enabled, its active payload is a separate application-encrypted Durable Object record containing only scheme + host + path and scan options. It excludes IP/client hash, Turnstile and access tokens, headers, cookies, screenshots, evidence, and results. Non-content scheduling metadata is unencrypted but contains no target or client identity. The active ciphertext is deleted on every terminal outcome and hard-bounded to 75 minutes; Cloudflare platform recovery snapshots may retain application-encrypted copies until their own retention window expires.

Static reports under `public/reports/` are different from filesystem share reports: they are committed, public, and retained until removed from git. They are useful for reproducible public evidence and gallery pages, not private or temporary scan results.

### Reading the fingerprinting section

The fingerprinting section is an observation layer, not a definitive accusation. API calls such as canvas, WebGL, audio, or WebRTC access can be legitimate. Behavioral heuristics currently cover canvas readback after drawing, repeated canvas font measurement, WebGL entropy reads, offline audio rendering, WebRTC peer-connection setup, and third-party listener coverage; comparison runs are still required before making stronger claims.
