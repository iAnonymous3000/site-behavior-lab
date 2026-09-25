# Changelog

All notable changes to Site Behavior Lab are documented here.

The format is based on Keep a Changelog. The project has not declared a stable
public API or a 1.0 release.

## Unreleased

### Fixed

- A scanner quota refusal (HTTP 429) now reaches the visitor as the declared
  `rate-limited` notice instead of raw server text. The notice says the scanner
  reached a request limit, blames no one (the quota store merges per-visitor and
  global windows, so it cannot know whose traffic fired it), and states the
  server's wait when the response carries one. An older page talking to a newer
  scanner, or the reverse, still renders a true sentence.
- A completed scan could fail to publish (a 500) when a request with an
  unrepresentable HTTP status sat on a row that publication later drops; the
  markers are now counted over the retained rows. Grounding drops (a CNAME cloak
  whose host was not retained, an ungrounded policy entity) are recorded as
  dropped evidence instead of as a budget that was never reached.
- The leading-dot invalid-host marker is terminal in the hostname redactor, so
  redaction stays idempotent for it.
- Static builds offer the evidence explorer's PDF control on committed reports
  only when `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PDF_EXPORT_ENABLED=1`, matching the
  receipt, and the saved-page explorer's PDF link now binds the source and
  correction hashes as the receipt link does. An undeclared self-hosted build
  that fronts a container loses that control; set the flag to restore it.
- The print route renders the site scope caveat from the footer's constant, so
  the PDF no longer omits the restart-safe retry sentence.
- A release attest job re-run alone now finds prepare's artifacts (they are named
  by prepare's attempt, bounded to 1 through 100) instead of refusing as a
  substitution. `release:governance:verify-selection` and three sibling operator
  scripts compile `dist/schema` before loading it, so a fresh clone runs them and
  a stale build cannot pass.
- An anchoring run that pushed its proposal branch but could not open the pull
  request no longer finishes green on the re-run with no pull request; the
  re-run opens it after checking the branch is one log-only commit on main.
- Retention: a second container's in-flight delete no longer refuses a finished
  publication on another container. Durable jobs (disabled in production): the
  admission time is bounded by the Durable Object's clock, and a refused
  preparation is remembered for its admission window so a replayed Turnstile
  token buys no second preparation.
- Each proxy DNS lookup has a 35 s backstop past a default resolver's own retry
  schedule, and the container raises the libuv pool from 4 to 16 threads so slow
  lookups in one scan cannot queue another scan's preflight into a refusal.
- The CNAME reference research instrument applies public-suffix wildcard,
  exception and IDN rules (`cname-reference@2`). Nothing committed was produced
  with `@1`.
- Test hygiene: the policy PDF stop check bounds the parse thread's own CPU work
  instead of a wall window, and the print request cap is pinned to the scanner's
  recording cap.
- A Shields filter-match count could include a request the engine had not yet
  evaluated at the passive-load boundary, and on a small page exceed the
  evaluated count, which failed the r2 report. The count now covers only
  requests classified by that boundary, so it can only go down; v1 counts are
  unchanged.
- After a script redirect, the recorded HTTP status described the first
  document instead of the page the report measures, so a 200 loader that
  redirected to a 403 block page read as a normal load (consent was clicked,
  the input probe typed and the block page's policy was followed), and a
  static host's 404 that redirected to its 200 app shell read as a failed load.
  The status is now the newest main-frame document on the frozen subject's
  origin (redirect hops and 204/205 responses excluded), and v1
  `summary.status`, r2 `qualityFacts.status`, the HTTP warning, the subject
  classifier and the consent, keystroke and policy gating all read it. Detector
  outcomes on redirected visits change without a detector version bump.
- A navigation the input probe blocked stayed in the request log and in the
  probe's own capture. A child-frame navigation carrying the test value then
  published a third-party document row that never loaded and a keystroke
  finding naming a host that never received anything. Once the abort succeeds,
  a blocked navigation now leaves the log and its counts, keeps its lost request
  coverage record, and names no recipient. One that would have carried the test
  value to a third party leaves the input check incomplete, so the report does
  not state that the value stayed on the page. v1 reports have no quality
  block, so the scanner now also emits a fixed warning whenever it stops a
  navigation while the probe runs, carrying the value or not, and v1 readers
  read it like a request deadline, as r2 reads the loss: the request evidence
  is incomplete, the visit leaves the corpus population and is not compared or
  benchmarked on third-party services, and the keystroke claim is left to the
  probe's own lines (next entry). The route stops every navigation started
  while the probe runs, an ad frame rotating during its wait included, and a
  v1 visit with such a stop now leaves the corpus population and the
  third-party benchmark, as r2 visits already did. None of the 30 runs of the
  2026-09 toolchain canary (five sites, theguardian.com among them) recorded
  one, so this is expected to be uncommon; where it happens, a refreshed v1
  aggregate pools fewer runs for that reason, not because the sites changed.
- A v1 report stated that no typed value left the page whenever the input probe
  did not complete its test in a way r2 records only in the detector's status:
  a navigation it stopped that would have carried the value to a third party,
  a request whose URL or body it could not read in full (one past its capture
  bounds included), a field it left untested or that refused the value, its
  own work failing, too little time to start it, and a page that left the
  recorded site before or during it. v1 reports have no detector status. The
  scanner now adds one of two fixed warnings in each of the first five cases,
  an unread-request line for a request it stopped or could not read in full
  after its first keystroke and an incomplete-test line for the rest (a
  request lost before any keystroke included, since the page had not yet seen
  the value), and v1 readers treat the
  keystroke claim, and only that claim, as incomplete for either line and for
  the existing lines that say the page left the recorded site before or during
  the probe. Request evidence, comparisons and the corpus population stay as v1
  measured them. More new v1 visits therefore lose the calm headline, each
  one where r2 already withheld the claim: 15 of the 126 committed r2 runs
  (recorded under earlier probe versions) and all 6 github.com runs of the
  2026-09 toolchain canary ended with the keystroke check incomplete. The two lines and the stopped-navigation line
  above join the listener-withheld warning below in this release's
  public-string policy widening.
- A v1 consent visit whose click left the recorded site says so, and keeps its
  requests, cookies, storage and fingerprinting at the pre-click boundary, but
  v1 readers read all four as complete: third-party services (benchmarked),
  cookies, storage keys and fingerprint and session-recording findings were
  allowed where r2, which records a dropped loss for each, withholds them. v1
  readers now read that line as lost coverage in those four families. The input
  probe's disclosure that its requests were omitted from the log, written when
  the page left the recorded site after the probe typed, is now read as lost
  request coverage, like a stopped navigation. Both are reader changes: no
  committed report carries either line, and no string or digest moves.
- Three more losses that r2 reports record had no v1 line, so v1 readers read
  the lost families as complete: a page that left the recorded site before the
  scanner finished reading its state (requests, cookies, storage and
  fingerprinting; an observe-mode visit then published no cookies and no
  storage, read as a complete absence), a page that left the site while the
  input probe ran (requests and fingerprinting; the probe's subject line is
  also added where r2 records no loss, and its omitted-requests disclosure says
  nothing about fingerprinting), and a window or tab the page opened, whose
  requests the scanner blocks and leaves out of the log (requests, in any
  phase). The scanner now adds a fixed warning beside each r2 loss, and v1
  readers censor the families r2 drops for that loss: such a visit leaves the
  corpus population and is not compared or benchmarked on third-party
  services, and a page that left before its state was read also withholds its
  listener findings, as r2 does over its fingerprint detector. One residue
  stays: for a probe that lost the page, r2 also marks `detector-output`
  censored over the keystroke detector, which v1 records only through the
  keystroke claim's own reason. No v1 surface shows that family, so no claim
  r2 withholds stands on v1. No committed report
  carries any of the three lines. They are new admitted public strings, so
  they move the public-string policy digest with this release's redaction
  change.
- The input probe's block of a main-frame navigation (a form submitted through
  another frame's `submit`, for example) replaced the page with an error page,
  so the scanner's own block read as the page leaving the recorded site: the
  probe was discarded and fingerprinting was censored. The probe now stops
  these navigations the way a cancelled navigation stops, the page stays in
  place, and the probe completes on the rest of what it observed.
- On a GPC visit, a worker started by another worker, or built through
  `Worker.prototype.constructor`, could stand in for a page worker the
  verification channel never reached, so a worker that ran without the signal
  went undisclosed. Attaches are now tagged by the session they arrive on, and
  checked against the browser's own record of the page's dedicated workers as
  well as the page-side construction count. A visit whose channel never opened
  now discloses the larger of the two counts. Two narrow gaps remain: a worker
  in a frame the automation layer cannot place is missing from the browser's
  record, and a dedicated worker started inside a `SharedWorker` is in neither
  record.
- A consent banner read that lost a frame was recorded as "banner not visible",
  so a banner that could have been in the unread frame completed a
  visible-then-hidden transition and published a weak signal of the chosen
  consent. Such a moment is now left out, as a read of no frame already was;
  without the after-click moment the choice state is unavailable. It records
  no capture loss, so a choice the TCF API or OneTrust readback verified stays
  verified and uncensored, and a frame that detached during the read, which
  shows nothing, does not count as unread.
- A v1 report dropped a session-recording or input-monitoring detection without
  a trace when a script origin it named had no publishable registrable domain
  (a path-style S3 host, a bare IP address, a host that is itself a public
  suffix), and then stated that no listener signals were observed. The v1
  sanitizer now adds a fixed warning when it withholds such a detection, and v1
  readers treat the listener claim, and only that claim, as incomplete. r2
  already recorded the drop as a capture loss, which also censors the keystroke
  claim; a v1 keystroke recipient redacts to a host marker the sanitizer
  accepts, so the v1 line leaves that claim alone. The new admitted warning
  moves the public-string policy digest and both r2 normalization identities;
  the outgoing ones are closed with this release's identity bookkeeping. No
  committed report changes. Reports whose detection was dropped before this
  change cannot be identified, because raw evidence is not retained.

### Measurement epoch

- The node-detectors-v10 measurement epoch declares, in one step, the
  identities the fixes above move, so no report presents new behavior under
  the old identity. It moves no toolchain input: Playwright 1.63.0,
  adblock-rust 0.13.3, tldts 7.4.13 and the September 21 Brave lists stay.
  Recorded identities, old to new:
  - Base Node methodology, which is also the v1 methodology token and the
    corpus cohort key:
    `shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v3+detector-coverage-v2`
    to
    `shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v4+detector-coverage-v2`,
    for the subject's HTTP status.
  - r2 methodology suffix: `consent-r2-v4` to `consent-r2-v5` (a banner
    moment read from only some frames), `gpc-worker-application-v2` to
    `gpc-worker-application-v3` (worker attach accounting) and
    `active-probe-v2` to `active-probe-v3` (probe-blocked navigations), with
    the new base in front.
  - Detectors: `synthetic-sentinel@4` to `synthetic-sentinel@5`, because a
    navigation the probe blocks is no longer searched for the test value or
    counted toward the probe's capture cap (one that would have carried the
    value to a third party leaves the probe incomplete instead), and a probe
    whose own main-frame block used to end it now runs to the end.
    `DETECTOR_REGISTRY_VERSION` moves from `node-detectors-v9` to
    `node-detectors-v10`, and its digest from `b15c8281...4715` to
    `6f8d32c3...5657`. Recomputing the v9 digest from the current inputs
    with only the keystroke version and the registry label restored
    reproduces `b15c8281...4715`, so nothing else moved. The obligation
    target registries keep v9 as a closed epoch and enforce v10.
    No other detector version moves: the subject status changes consent and
    policy outcomes on redirected visits the way subject-validity-v3 did,
    without a detector version bump, and the keystroke outcomes it changes
    ride on `synthetic-sentinel@5`.
  - Node and PageGraph r2 normalization: public-string-policy-v3
    `cb7064a1...059d` to `b40a333a...3d51` under the same `tldts@7.4.13`, a
    widening by four admitted warnings, the listener-withheld line and the
    input probe's unread-request, incomplete-test and stopped-navigation lines.
- The probe and GPC worker revisions also change what v1 reports record (v1
  request rows after a probe-blocked navigation, the input probe's
  unread-request, incomplete-test and stopped-navigation warnings, and when
  the GPC worker warning appears), but their components stay in the r2 suffix
  where their earlier revisions were declared. The v1 token still moves in this epoch,
  through subject-validity-v4, so no v1 cohort mixes reports from before and
  after either change.
- The reviewed corpus line advances to the new base. No committed report is
  on the outgoing line, so its replayed handoff moves nothing, and the
  published aggregate changes only when a refresh on the new line passes the
  handoff gate.
- Published reports keep their recorded identities. The deployed producer
  rows `node-v12-toolchain-2026-09-active-lists-2026-09-21`,
  `node-v12-toolchain-2026-09-active-no-adblock` and
  `pagegraph-v4-tldts7413-active` are closed to their exact literals (the v12
  methodology, the cb7064 normalization, node-detectors-v9 and a frozen copy
  of the September 21 lists under adblock-rust 0.13.3), byte for byte what
  the deployed source produced. The outgoing normalizations stay readable as
  superseded identities, and v1 reports that name the outgoing base stay
  fixed points of the sanitizer. The new active rows are
  `node-v13-detectors-v10-active-lists-2026-09-21`,
  `node-v13-detectors-v10-active-no-adblock` and
  `pagegraph-v4-listener-withheld-active`.

### Redaction v5

- Two kinds of string a saved report could publish are now withheld. A hosting
  tenant label under a shared provider suffix (the first label of a
  registrable domain under a private public suffix, such as `akamaihd.net`) is
  generalized to `{label}` when it holds a dashed or underscored IPv4 address,
  when it is at least 32 characters long with five or more separate digit
  runs, or when a segment of it (split on `-` and `_`) is a Unix timestamp in
  seconds or milliseconds, a run of sixteen or more digits, a hex token of
  sixteen or more characters mixing digits and letters, or a token of sixteen
  or more characters with at least three digit runs, wherever a host or
  registrable domain is published:
  request, provenance, cookie, CNAME, consent-frame and policy hosts, a
  Shields-list tracker's domain and entity, and policy entities. Akamai's EUM
  beacon hosts put the scanner's egress address, a visit timestamp and
  per-visit tokens there. A site whose own host has such a label is refused
  before the scan. An email address, obfuscated address (`[at]` or `(at)`),
  `@` handle, URL with a scheme, `www.` host or host with a path inside a
  quoted policy sentence becomes `[redacted]`, and so does any run of nine or
  more digits (seven or more after `+`) with at most two separators between
  digits: a phone number, but also a statute range joined by a dash or slash
  such as `1798.100-1798.199`, or a date followed by a time. The quote is then
  marked incomplete, so its claim is kept but never checked. A bare hostname
  and a shorter number are kept. The shapes cover the per-visit patterns
  seen in published reports, not every identifier: a dashed IPv6 address, a
  shorter token, a sparse token whose label has fewer than five digit runs,
  and a numeric id that is neither a timestamp nor sixteen digits long
  survive. Platform default hostnames, such as Heroku's
  `example-app-1234567890ab.herokuapp.com` and a Cloud Run service URL, stay
  verbatim and scannable.
- Identities, old to new. `REDACTION_VERSION` stays 4: every committed sidecar
  and logged r2 wire pins revision 4, so the narrowing is named by the
  public-string policy instead. `PUBLIC_STRING_POLICY_VERSION` moves from
  `public-string-policy-v3` to `public-string-policy-v4`, and the policy digest
  from `b40a333a...3d51` to `359b216f...e9bc`, which now also hashes the tenant
  shapes and the quote spans. The same move admits the three v1 warnings for
  a page that left the site or opened a window, which `b40a333a` replaced with
  the redacted-warning marker, so it is a narrowing that also carries a
  widening. Both r2 normalization identities move with it; `tldts@7.4.13` and
  the allowlists do not.
- The outgoing Node and PageGraph normalizations stay readable as superseded
  identities, recorded as the second kind of owner exception the superseded
  list admits: a reviewed sanitizer narrowing, with its removed strings and
  their positions, the three admitted warnings, the committed-corpus proof,
  the retention bound and the owner's acceptance on 2026-09-25 in the entry. The outgoing producer rows
  `node-v13-detectors-v10-active-lists-2026-09-21`,
  `node-v13-detectors-v10-active-no-adblock` and
  `pagegraph-v4-listener-withheld-active` are closed to their exact literals
  (the v13 methodology, the `b40a333a` normalization, node-detectors-v10 and a
  frozen copy of the September 21 lists under adblock-rust 0.13.3), byte for
  byte what the epoch's source produced. The new active rows are
  `node-v14-public-string-policy-v4-active-lists-2026-09-21`,
  `node-v14-public-string-policy-v4-active-no-adblock` and
  `pagegraph-v4-public-string-policy-v4-active`.
- The methodology does not move, and neither does the v1 token. The three v1
  lines above for a page that left the site or opened a window change what v1
  reports record and how v1 readers censor inside the current reviewed line
  (the `subject-validity-v4` base). No committed report carries that line, so
  no committed cohort can mix reports from before and after the change.
- Stored shares are not rewritten. The reader re-runs the current sanitizer,
  so a share saved under the outgoing identity that holds a string v4 removes
  is no longer served, and the remediation planner refuses to rewrite it. The
  application stops serving a share at seven days and the bucket deletes it at
  eight, so this affects at most the shares saved in the eight days before the
  deploy. The owner accepted that instead of a migration.
- Two committed reports published such tenant hosts:
  `20260727-f378d41658184b8e1b014ae2e41b8541` and
  `20260817-693b5bc1c455e1be2d0b42b4d8efa292`, both Shields comparisons of one
  site with two affected hosts each. They are replaced for privacy: redacted
  copies are published as `20260727-4006618d80dc779268592042b119010e` and
  `20260817-8d7ada3c1897a6c494396ed15db32a53`, the originals are removed, and
  `SBL-CORR-2026-004` (privacy-superseded) names both pairs. Each copy is the
  current sanitizer's output with only its share moved: the two hosts become one
  `{label}.akamaihd.net` row, so the unblocked run counts one fewer
  third-party domain (44 to 43, and 43 to 42), and every earlier correction
  event applies to the copy. No committed quote changes, and no comparison
  decision in the corpus moves. `npm run reports:remediate -- --privacy-replace
  <report-id>` produced them and refuses during a measurement freeze, as the
  pruner does. This reduces what is served only: git history and the archived
  earlier releases still hold the original bytes, and the earlier release
  receipts and the transparency log still list their digests.

### OffscreenCanvas

- The fingerprint observer now reads OffscreenCanvas 2D work in the page.
  Text drawing, `drawImage`, `getImageData` and `measureText` on an
  OffscreenCanvas 2D context feed the canvas readback and font-probing
  heuristics with the same thresholds as a page canvas, and page and offscreen
  canvases share the one 256-canvas tracking cap. An export through
  `convertToBlob` is recorded as its own API, `canvas.convertToBlob`, only when
  its promise fulfills, never as `canvas.toBlob`, so an export still pending
  when the visit's evidence is collected is not recorded. Text drawn offscreen
  keeps its provenance into another canvas through `drawImage`, including
  `drawImage` of a bitmap made by `transferToImageBitmap` or
  `createImageBitmap`, and a page canvas whose control moved to an
  OffscreenCanvas with `transferControlToOffscreen` is read as showing that
  OffscreenCanvas's text. An ImageBitmap handed to a `bitmaprenderer` context
  carries no provenance, for either kind of canvas. Before this, a page that
  fingerprinted only on an OffscreenCanvas left no event and no detection, so
  its fingerprint card read quiet. WebGL on an OffscreenCanvas was already
  observed. The observer captures the OffscreenCanvas intrinsics at init, so a
  page that later replaces its constructors, methods or getters cannot hide
  the work, and it brands canvases and contexts with their native getters
  rather than their prototype chains, so re-prototyping a canvas or context,
  or planting a throwing prototype trap, neither hides the work nor breaks
  the page's calls.
- Every promise call the observer records (`convertToBlob`,
  `createImageBitmap`, `OfflineAudioContext.startRendering`,
  `RTCPeerConnection.createOffer` and `setLocalDescription`) now hands the
  page a promise of its own that settles as the native one does, one
  microtask later. A rejection the page leaves unhandled reaches
  `unhandledrejection` as it does unobserved, where the audio and WebRTC calls
  used to mark it handled, and a page that swaps `Promise[Symbol.species]` or
  the promise constructor around a call no longer keeps a fulfilled call from
  being recorded.
- Canvas and WebGL work inside a Web Worker is still not observed, including
  drawing a worker does on a canvas the page transferred to it. Observing it
  would mean opening the DevTools channel on every arm and pausing every
  worker before its first statement, a new intervention in the baseline visit
  (only the GPC arm pauses workers today), plus a worker-realm observer and a
  readback path for workers that exit early. The coverage boundary entry for
  OffscreenCanvas 2D work is narrowed to `worker-realm-canvas`, which says so,
  names the two page-realm gaps above, and says that reports measured before
  node-detectors-v11 did not observe OffscreenCanvas 2D work in the page at
  all, so a quiet canvas finding on one does not rule it out.
- Recorded identities, old to new:
  - Base Node methodology, which is also the v1 methodology token and the
    corpus cohort key:
    `shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v4+detector-coverage-v2`
    to
    `shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v4+detector-coverage-v2+fingerprint-surface-v2`.
    The earlier surface, page canvases only, was unnamed, so only the revision
    carries a component, as with `gpc-worker-application-v2`. The r2
    methodology moves with the base.
  - Detectors: `fingerprint-observer@4` to `fingerprint-observer@5`.
    `DETECTOR_REGISTRY_VERSION` moves from `node-detectors-v10` to
    `node-detectors-v11`, and its digest from `6f8d32c3...5657` to
    `80209bf7...e22a`. The digest also hashes the fingerprint vocabulary, so
    recomputing it from the current inputs with the registry label and the
    observer version restored and the `canvas.convertToBlob` token removed
    from both vocabulary arrays reproduces `6f8d32c3...5657`, and nothing else
    moved. Keeping the token gives `6d76e9d9...ce13`, a value no deployment
    carried. The obligation target registries keep v10 as a closed epoch and
    enforce v11.
  - Node and PageGraph r2 normalization: public-string-policy-v4
    `359b216f...e9bc` to `7fd4ef76...69f5` under the same `tldts@7.4.13`, a
    widening by the one admitted `canvas.convertToBlob` token. The policy name
    stays `public-string-policy-v4`: a widening is not a policy revision, as
    the v9 and v10 detector epochs' widenings kept v3.
- The reviewed corpus line advances to the new base. No committed report is on
  the outgoing line, so its replayed handoff moves nothing, and the published
  aggregate changes only when a refresh on the new line passes the handoff
  gate. New v1 reports count OffscreenCanvas work in `fingerprintEvents` and
  may carry canvas detections the outgoing line could not, so they are not
  pooled with it. A canary panel site that uses OffscreenCanvas can move the
  toleranced `fingerprintEvents` metric legitimately.
- Published reports keep their recorded identities. The deployed producer rows
  `node-v14-public-string-policy-v4-active-lists-2026-09-21`,
  `node-v14-public-string-policy-v4-active-no-adblock` and
  `pagegraph-v4-public-string-policy-v4-active` are closed to their exact
  literals (the v13 methodology, the `359b216f` normalization,
  node-detectors-v10 and a frozen copy of the September 21 lists under
  adblock-rust 0.13.3), byte for byte what `89ae341f` produced. The outgoing
  normalizations stay readable as superseded identities, and v1 reports that
  name the outgoing base stay fixed points of the sanitizer. The new active
  rows are `node-v15-detectors-v11-active-lists-2026-09-21`,
  `node-v15-detectors-v11-active-no-adblock` and
  `pagegraph-v4-convert-to-blob-active`.

## [0.6.0] - 2026-09-06

Declared on 2026-09-06 (the date above) and tagged `v0.6.0` on 2026-09-24 at
`ee525b5f` by Cut Release Tag run 36047081291, with its receipt archived at
[docs/release-receipts/0.6.0/release-receipt.json](docs/release-receipts/0.6.0/release-receipt.json);
see [release status](RELEASE.md#current-release-state).

This milestone brings findings and their evidence closer together, makes
incomplete observations harder to misread, and carries tested artifacts from
main CI into deployment. It preserves the report schemas and published
measurements. It does not declare 1.0 readiness, a stable public API, or measured
detector error rates.

### Highlights

- An evidence-first report interface with shared findings across server-rendered
  and interactive views, clearer comparisons, print/export actions, and site
  history. Directory search accepts URLs consistently and fits narrow screens.
- Consistent uncertainty and coverage disclosures across reports, summaries,
  comparisons, and exports, including historical pixel evidence and failed visits.
- Parallel CI builds and reuse of tested, attested container and Pages artifacts
  during production deployment. Routine maintainer changes go directly to main;
  exact-source checks, promotion authority, and live verification still apply.
- A bounded investigative-v1 qualification contract and independent capture
  workflow. Qualification remains evidence-gated; formal calibration is separate.
- A clearer repository front page, a real report screenshot, and explicit
  separation between a prepared product milestone and a completed release tag.

### Added

- The published coverage boundary now names two request-log surfaces this
  scanner does not instrument: what a site declares in its response headers,
  and which redirect led to which, in which frame. Both entries state what a
  report does carry, because the near misses are what a reader would otherwise
  mistake for the missing fact: cookie records expose flags a `Set-Cookie`
  header set, the bounded privacy-policy fetch reads `Content-Length` and
  `Location` without retaining either, and a redirect hop is published as its
  own request row with no frame identifier and no link to the hop it led to.
  Neither entry names absent identifiers, because `lib/scanner.ts` and
  `lib/scan-runtime.ts` are themselves boundary sources and a pinned token
  would fix an identifier this project's own code may legitimately use later,
  so both rest on review and the catalog page marks them as such. The heading
  for not-instrumented entries no longer says every one of them is held by a
  test, which was already untrue of four shipped entries. No detector, report
  field, or capture path changed, and no admitted public string or
  normalization identity moved.

### Changed

- A GPC-enabled visit now runs every Web Worker the site asks for and delivers
  the signal inside each dedicated worker's own realm, verified by a readback
  from that realm before the worker's first statement (a DevTools session
  scoped to the measured page pauses each worker, installs
  `navigator.globalPrivacyControl`, and reads it back in the same evaluation).
  Previously the GPC arm rewrote network worker sources at the route boundary
  and refused `blob:`/`data:` workers with a page-visible `NotSupportedError`,
  a one-arm intervention a GPC comparison had to read around; a worker spawned
  inside another worker ran with no signal and no disclosure at all. Workers
  the scanner cannot attest from inside their realm (SharedWorker, or any
  worker when the verification channel is unavailable) still run untouched and
  are disclosed through the existing capture-loss warning. This changes what
  the GPC arm does at runtime, so the Node r2 methodology gains the
  `gpc-worker-application-v2` component and the outgoing `node-detectors-v6`
  methodology is closed as an exact historical producer row pair for its
  deployed window; no committed report is affected, and no admitted public
  string or normalization identity moved.

### Fixed

- Incomplete-visit copy no longer exposes internal `capture-loss:*` reason
  codes or silently discards the recorded loss count. Historical reports whose
  warning proves the 64 MiB aggregate response-byte ceiling now say how many
  response streams or proxy tunnels were truncated or refused, without
  relabelling that number as missing requests.
- New Node r2 reports record the byte ceiling as `response-bytes`, distinct
  from the 1,000-request routing/recording ceiling; that semantic change
  advances the Node `resource-budget` methodology epoch while preserving the
  exact historical producer tuple used by the committed corpus.
- The weekly Brave Shields list refresh can complete again. It regenerated
  `THIRD_PARTY_INVENTORY.json` for the new list bytes but never synced
  `THIRD_PARTY_REVIEWS.json`, whose rows are keyed by `url@sha256`, so every
  refresh failed the unit suite on `missing ledger row` before reaching the
  proposal step and no refresh ever reached a human. New rows are created
  unreviewed, so the review gate is unchanged.
- A Brave refresh whose rules moved upstream is no longer reported as a broken
  refresh. `NODE_R2_CURRENT_ADBLOCK_IDENTITY` is a source literal no workflow
  may edit, so once the fetch overwrites the snapshot the producer-contract
  assertions have a predetermined answer: the run went red with `unknown Node
  producer tuple` and `redaction-not-idempotent`, which reads as a redaction
  bug that does not exist. `npm run lists:adoption` now names that condition
  directly, prints the exact literal to adopt, and counts the committed reports
  measured under the outgoing identity so a maintainer knows whether it must
  also be frozen. A new guard test fails first, and says so, when the pin goes
  stale. The pinned constant's own docblock still claimed the fetch timestamp
  was why the job could not self-green, which #146 had already fixed.
- The canonical featured-refresh issue says which kind of red a run is. It
  published a bare rate (`61/81 (75%)`), and a rate cannot distinguish a broken
  scanner from sites declining an undisguised automated browser, which need
  opposite responses. The failure taxonomy added in #149 existed only in the
  job log, because the alerting job receives a sanitized projection and never
  sees per-target diagnostics; the counts now travel through that projection.
  Counts only: no target names, messages, or URLs reach the public issue, and a
  taxonomy that contradicts the counts beside it is dropped rather than
  rendered. The classification itself now reads the producer's structured
  reason for the four values that name the site declining, rather than the
  English diagnostic; the fifth is its catch-all and covers three outcomes that
  are the scanner's, so it keeps going through the sentence, which separates
  them.

### Landed after the declaration

These changes landed on `main` between the 2026-09-06 declaration and the
2026-09-24 tag, so `v0.6.0` contains them. The full review behind most of these
entries is in [docs/comprehensive-review-2026-09-22.md](docs/comprehensive-review-2026-09-22.md).

#### Security

- next moves to 16.3.6 and the sharp override to 0.35.4, past
  GHSA-2xp9-vwfh-vxw4 (critical, Image Optimization API) and
  GHSA-rgj7-g3m4-5g8c (high, bundled libheif), which had made npm audit and
  both Trivy scans fail.

#### Changed

- Toolchain epoch 2026-09 (#9) moves the measurement toolchain in one
  reviewed step: Playwright 1.62.1 to 1.63.0 (bundled Chromium 151.0.7922.34
  to 153.0.8010.12), with the container base
  `mcr.microsoft.com/playwright:v1.63.0-noble` at index digest `eff16c30`
  (was v1.62.1-noble at `dcc5531e`), whose Node 24.18.1 and npm 11.16.0
  become Node 24.20.0 and npm 11.19.0; adblock-rust 0.13.2 to 0.13.3, with
  the vendored WASM rebuilt from the locked Cargo graph (`aa0df933` to
  `4034076e`); and tldts 7.4.10 to 7.4.13. The inputs are frozen as of the
  tldts 7.4.13 cut: tldts 7.4.14 (published 2026-09-21) and 7.4.15
  (2026-09-23) are excluded and wait for a later epoch. New Node reports
  record the
  `shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v3+detector-coverage-v2`
  base methodology and the `tldts@7.4.13` normalization, and the reviewed
  corpus line advances to that methodology. Detector versions do not move.
  Published reports keep their recorded identities: the outgoing Node and
  PageGraph producer rows are closed to their exact literals, the outgoing
  normalization identity stays accepted, and committed v1 reports that name
  the outgoing methodology stay fixed points. The tldts move is not a
  widening. Every stored report is re-redacted with the new engine when it is
  read, whatever its era, so one holding a host whose redaction the new
  engine changes fails closed instead of being served: a label below a
  removed suffix rule that is now generalized, a direct child of a newly
  wildcarded zone such as `*.eth.limo`, or a host that is now a suffix itself
  such as `cloud.run`. So does one whose scanned site's stored registrable
  domain is now itself a suffix, such as an Azure App Service app on a
  `<region>-01.azurewebsites.net` hostname or a Cloud Run service, or one
  whose CNAME-cloaked tracker the new engine assigns a different registrable
  domain, including an allowlisted host below a removed suffix rule such as
  `api.adaptable.app`. No committed report holds such a host. For the live
  store the owner accepted that instead of remediating: shares expire after 7
  days and the storage bucket deletes them at 8, so only reports saved in the
  8 days before the deploy can be affected. The engine differential found no
  changed block decision and the public-suffix refresh no changed parse over
  the committed corpus; neither is a replay of live traffic. The exact-build
  staging A/B passed: all 44 compared panel medians stayed within tolerance,
  and the full record is in
  [docs/toolchain-epoch-2026-09.md](docs/toolchain-epoch-2026-09.md).
- The toolchain canary compares capture loss like with like. A site may keep
  a capture loss only if every run of it in both builds records the same
  family, kind and detail, and only the metrics that family feeds are then
  left out for that site; a loss that differs between builds fails the
  comparison. Before, any capture loss refused the run, and since
  node-detectors-v9 records the fingerprint listener-attribution loss on most
  ad-heavy pages, even the baseline build could not produce a receipt.
  Receipts move to version 2.
- Detector epoch `node-detectors-v9` revises three detectors.
  `pixel-request-decoder@6` reads multipart form bodies (a page's `FormData`
  beacon) field by field instead of reading them as complete forms with no
  events, and records a multipart body it cannot read completely as a decoding
  gap. `policy-text-cross-check@7` reads a privacy policy only when the landed
  page is itself a policy, so a link that lands on the site root or back on a
  scanned page with no policy path, a redirect that drops the policy path, a
  not-found or error page, or a page with no policy wording records a failed
  policy read; it also matches mentions by catalog entity, adds trade names
  such as Yahoo, Twilio Segment (as Twilio, segment.io or segment.com, never
  the bare word), Smart AdServer, Rubicon Project and Microsoft Clarity (as
  clarity.ms or Clarity by Microsoft), and no longer counts the word
  "clarity" as naming Microsoft. It
  reads the policy text without the page's script, style, noscript and
  template content, so a vendor loader in the policy page's body (Clarity,
  Segment, Google Analytics, the Meta Pixel, Bing UET) no longer counts as
  the policy naming that vendor.
  `fingerprint-observer@4` keeps a frame's canvas, WebGL, audio and WebRTC
  evidence when only its listener attribution is bounded, withholds that
  frame's session-recording and input-monitoring findings, and says so in a
  new admitted warning that readers censor exactly like the unreadable-frame
  warning. Published reports keep their recorded detector versions: the
  outgoing producer rows are closed to their exact identities, the outgoing
  normalization identity stays readable, and a report from an earlier
  cross-check version treats a missed mention of Twilio Segment, Yahoo
  Advertising, Equativ, Magnite or Microsoft Clarity as unknown rather than as
  an omission.
- The Shields simulation uses the Brave default filter lists fetched
  2026-09-21 (31 lists, manifest `7e42412e`), adopted from the weekly refresh
  proposal. The September 7 snapshot stays readable as a closed producer
  identity.
- Subject validity v3 recognizes a network-security interstitial served with
  HTTP 200 (a denial and appeal page on a sparse document) as a suspected
  block, and the reviewed corpus line follows it. Historical cohorts keep
  their identities.
- Catalog hosting suffixes (`azurefd.net`, `azureedge.net`) survive report
  persistence under a new normalization identity, with the outgoing producer
  tuples closed.
- A Shields filter-list CNAME match no longer names an operator; only curated
  catalog matches do.
- PDF exports carry every request row in visit order and can be verified
  independently of the viewer.
- Category pages state that their rows come from the page's one measurement
  cohort and disclose when listed sites have newer eligible visits outside it.
  Category rows count a site's retained reports the way the directory and
  profile do.
- Report titles give up the date before the domain, so no committed title is
  cut; comparison kind and report reference always remain.
- A verified consent pair leads with the Reject-all visit its findings board
  describes; pair-framed share text and social cards no longer show one
  visit's unlabeled counts; a permalink discloses when the visit landed on a
  different site than requested.
- The anchoring workflow extends one proposal branch instead of opening a new
  pull request for the same log head each week, carrying pending proofs
  forward.
- React 19.3, lucide-react 1.47, and the development tooling (Node and Worker
  types, axe, Wrangler) are updated. The Worker sources are typechecked only
  in their own program, which was the cause of the type failures in #228.

#### Fixed

- Advancing the reviewed corpus line no longer hands a category page to a
  retired line's narrower cohort on recency. Each reviewed line keeps the
  handoff decision it made while current, so moving to a line with no reports
  yet leaves every published aggregate and category page as it was.
- The privacy page and homepage no longer say the input probe flushes unload
  beacons; teardown-only transmissions are not measured.
- The homepage's initial JavaScript no longer includes the report-view and
  comparison modules (198 KB to 182 KB gzip before the React update).
- The changelog heading uses the bracketed form the tag ceremony requires, and
  main CI now checks the same form.
- The release-readiness scripts build the schema contract they need, so a
  fresh checkout (including the 1.0 ceremony) no longer fails
  `decisions-approved` with a false reason.
- A consent arm's uncatalogued cross-site hosts are scored with the fixed
  thresholds instead of rendering a green bottom line; the fingerprint card
  counts distinct APIs; a pixel firing in two phases is named once; pair
  comparability reasons no longer show raw wire tokens; a v1 consent
  comparison whose click left the site is refused.
- A page that stalls after opening a loopback connection is reported as a
  load timeout, not a private-network target. Watch creation stops before
  redeeming a Turnstile token when encrypted watches are disabled.
- The homepage calls its successfully loaded site count that, not "measured";
  keyless generalized-host rows no longer date the status page's aggregate.
- The coverage boundary discloses that OffscreenCanvas 2D work is not
  observed.
- Reports from 2026-06-25 to 2026-07-06 whose WebGL detections match only the
  single-signal rule the observer dropped on 2026-07-20 label them as such and
  no longer rank them at warn level; three bing.com reports that recorded the
  homepage as the privacy policy no longer show omission cards over its text.
- Documentation: the Brave list refresh and transparency anchoring are
  described as they run, the operations runbook matches the tested-artifact
  deployment, all eleven methodology components are listed, contributors are
  told to use `npm ci`, and 37 broken links are fixed.
- Worker source-shape tests fail when a marker is missing; deadline tests no
  longer fail under load; unreachable helpers, exports and a never-emitted
  failure cause are removed.

## 0.5.0 - 2026-08-11

Historical source declaration, never tagged or receipted. Its changes are
retained here as recorded; this heading does not claim a published release.

Evidence you can print, cite, and check. A report now leaves the browser as a
document with page numbers and a running identity, says on its face when the
visit behind it was incomplete, and carries the boundary of what this
instrument does not measure onto the artifact itself rather than leaving it on
a page the reader never visits. The disclosure surfaces were corrected against
the code they describe, and two guards now hold them there.

It does not declare a stable public API, enable npm publication, or claim any
readiness gate its own evaluator reports as failing. The 1.0 readiness check
does not run for a governed 0.x ceremony and no gate here is asserted as
passed. ScanReport contracts are unchanged: v1 frozen, v2/r1 and v2/r2
byte-immutable.

### Added

- The published coverage boundary gained the three surfaces it was missing:
  timing side channels, geolocation, and the Permissions API, all verifiably
  uninstrumented and none of them previously listed for a reader consulting
  what this scanner does not measure. Its guard also widened from reading two
  scanner sources to eight, with two derivations that refuse any module able to
  reach the page but absent from that list, because three such modules already
  were.
- A research-only native Brave Shields differential (`npm run
  shields:native-diff`) that launches a pinned local Brave behind the same
  connect-time public-address proxy every scan uses, correlates Brave's sparse
  `Network.requestAdblockInfoReceived` events with CDP requests, and writes a
  bounded redacted receipt. It is deliberately not a ScanReport producer: the
  public wire is unchanged. Its receipt states that a native event is emitted
  only for a block or a matched exception, so no event is not an allow verdict
  and the stream is not a denominator for error rates.
- Every printed page carries "Page N of M" and the report id it belongs to. A
  multi-page evidence document with no page numbers cannot be cited in a
  filing, and a removed or reordered page left no trace. Done in CSS `@page`
  margin boxes rather than the PDF renderer's own footer, so a browser print
  and the generated PDF get the same running footer from one source.
- A report built on an incomplete visit says so above the numbers it
  qualifies, on screen and on paper, including why it matters: an absence
  inside a visit that did not finish is especially weak evidence. Run quality
  already recorded this, but only inside the evidence receipt, which a reader
  scrolling to the tables never opens.
- The exported PDF opens in the browser's viewer instead of downloading
  unseen, so a reader can look at the document before keeping it. Saving still
  works from the viewer, keeps the same filename, and costs no second render.
- Guards on the sentences this project publishes about itself: the manifest
  lookup in `docs/verify-a-report.md` is executed against a committed receipt
  and its digest compared to the real file, and a boundary entry may no longer
  assert a sweeping universal about what the report format contains. Both were
  mutation-tested against defects that had actually shipped.
- Printed report pages carry an evidence footer with the exact wire SHA-256 of
  the bytes they render, the verification command in both its live-site and
  `--from` forms, and a statement that the print is a rendering rather than the
  evidence. Committed reports name the transparency log; time-limited shares are
  told instead to save the bytes now, because no external anchor covers them.
- A report can be downloaded as a PDF from the scanner, at
  `/api/reports/<id>/pdf` and from the report page. The scanner renders its own
  printable page, so the file carries the same complete evidence, the same
  evidence footer and the same wire digest a browser print does, from one
  renderer and one set of copy. The render waits for the page to settle, because
  a document captured earlier states a different severity basis than the page a
  reader prints. It is a rendering and not the evidence, which the footer inside
  it says and `docs/evidence-custody.md` explains. Container-only, like the
  printable page it renders: a static deployment has no browser.
- The approved use boundary from `RELEASE_READINESS.json` is now shown to
  readers, on paper, in the report evidence receipt, and on the methodology
  page. It was an approved decision that no reader had ever been shown.
- `docs/evidence-custody.md`: what to save, and when, to keep a report you
  intend to rely on.
- A weekly workflow anchors the current transparency-log head through
  OpenTimestamps and proposes the appended log for review. Committed anchors are
  now machine-checked against the head they claim, and the unanchored gap is
  held under a declared ceiling.
- CI now verifies that the transparency log covers every committed report, and
  runs `verify:report` offline against the newest committed report, which is the
  command printed on every paper copy.
- A container-only printable report route at `/reports/<id>/print`, which
  server-renders the complete evidence rather than the summary-only rendering a
  browser print of the interactive page produces. Its `printComplete` render
  mode opens every disclosure and raises the row caps, so paper truncates only
  where the scan truncated.
- `lib/print-row-caps.ts`: print row ceilings derived from the committed
  corpus's observed per-run maxima, so a printed report is complete for every
  report the corpus has actually recorded.
- A total static-export size gate in the static smoke run. Per-page budgets
  cannot see an export made of many pages that each pass; this bounds the whole
  artifact and names the largest directories when it fails.

### Fixed

- Consent probes no longer submit a scanned site's form when an accept/reject
  control is also a submit control, and an interrupted post-click settle can no
  longer be rewritten as "nothing was clicked." Credentialed scan URLs are
  refused before leaving the browser, IPv6 protocol space now defaults closed
  around its exact globally reachable exceptions, and durable preparation
  releases are fenced to the reservation they actually hold.
- Machine-readable report metadata now names the automation that produced the
  report instead of hard-coding Chromium for PageGraph imports. The featured
  catalog validator also enforces the full committed `scanAvailability`
  contract rather than accepting malformed entries that fail later in CI.
- Removed 1,541 lines across 13 verified-dead paths, including a superseded
  calibration archive launcher and report-removal wrapper, while retaining the
  duplicate-looking controls and helpers that still have real consumers.
- Reader and operator documentation no longer describes open WAF/log gates as
  closed, an anchored transparency-log prefix as total coverage, review-only
  blind spots as test-enforced, or conditional input-probe disclosures as
  universal. Source-derived guards now hold those claims, every accepted scan
  token header, active methodology suffix, and referenced path/script to the
  contracts they describe.
- Printed reports dropped the standing scope caveat, the causal map's text
  equivalent, and the capped-evidence qualifiers, while printing search boxes
  and filter selects into the middle of the evidence. A printed comparison also
  showed one arm's numbers without naming the arm.
- The approved use boundary rendered as "not A and B", which parses as "not (A
  and B)" and permits being exactly one of them. Each excluded use is now negated
  individually.
- `SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS` accepted any value, so a share could
  publish an expiry the storage bucket's own eight-day deletion rule destroyed
  first. The effective TTL is now clamped strictly below the bucket rule.
- The reader-facing verification recipe did not run. `docs/verify-a-report.md`
  told a skeptic to read a top-level `files` key that no real evidence manifest
  has, so the published snippet raised `KeyError` on every receipt. Both
  corrected commands were executed against a committed receipt before shipping.
- A published boundary entry claimed no report field holds request headers at
  all, which its own GPC readback falsifies. The claim is now scoped, and it had
  shipped inside a card the catalog page labels as enforced by test.
- The native Shields differential reported comparisons it had not made.
  Correlation required only a shared CDP request id and fell back to an
  arbitrary record, so an ordinary redirect (which reuses one id across hops)
  made it compare one engine's verdict on one URL with the other's on a
  different URL and report the difference as real. Brave's own synthetic-data
  flag reached the wire but no decision, and an unrecognised resource type was
  evaluated as a guessed one, manufacturing disagreements in exactly the cases
  the tool exists to study.
- The release runbook could send an operator to dispatch the version-declaration
  commit even though the content-addressed governance receipt is necessarily
  introduced by a later carrier. The workflow now refuses that stale selection
  in its read-only preparation job, before environment approval, and the
  capture handoff names the required commit, promotion, selector, and dispatch
  order explicitly. The runbook also distinguishes the receipt-only 0.x path
  from the measurement-bound exact-1.0 path.

## [0.4.0] - 2026-08-01

Promotes 0.4.0-rc.1 unchanged: the release-candidate rehearsal of the
prerelease tag mechanics the 1.0 ceremony will use, cut on the release-1.0
preparation batch. The rc was re-dated from 2026-07-31 after its first tag
ceremony failed before creating any tag (the ceremony can only tag the
current head of main), so this section also covers the work that landed
between those attempts. It does not declare a
stable public API, enable npm publication, or claim any readiness gate that
its own evaluator reports as failing. ScanReport contracts are unchanged
(v1 frozen, v2/r1 and v2/r2 byte-immutable).

### Added

- A machine-readable release-readiness manifest (`RELEASE_READINESS.json`)
  evaluated by `npm run release:readiness`: release decisions stay red until
  a named human approves them, derived gates re-score committed evidence on
  every run without trusting any artifact's self-declared verdict, and
  operator attestations bind a literally-true statement contract to the
  target release with per-gate freshness windows. The proposed compatibility
  promise is digest-pinned by its decision. The evaluator currently reports
  NOT READY, and a test pins that honest state.
- The corpus statistics artifact now keeps one distribution cohort per exact
  schema/revision, methodology, tracker-catalog, ServiceRole-taxonomy,
  metric-contract, producer, and requested-GPC identity, and percentile
  wording requires both the exact cohort and the named metric to reach the
  50-site floor. `metric-contract-v1` and `service-role-taxonomy-v1` are
  published as digest-pinned artifacts, separating all catalog-matched
  request rows from the read-time third-party tracking-role subset.
- A measurement-freeze switch (`SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE`)
  quiesces every corpus writer except the controlled collection lane, with a
  loud notice job on each skipped writer and a preflight refusal of both
  frozen-v1 lanes during a freeze.
- Preregistered A/A repeatability studies: a declared-before-collection
  preregistration (frame digest, repetitions, conditions, thresholds) and an
  evaluator that treats binding mismatches, including a preregistration
  declared after collection began, as identity violations rather than
  threshold failures.
- Detector-calibration readiness is derived by re-analyzing committed studies
  against the exact current release identity on every build, so a study
  bound to an earlier build, catalog, or filter-list revision demotes itself;
  the committed pixel pilot is disclosed as ineligible instead of invisible.
- Operational evidence became machine-readable receipts: controlled-runner
  destruction receipts with a fail-closed verifier, an R2 lifecycle readback
  (API-token or wrangler-OAuth sourced) that detects conflicting retention
  rules production health cannot see, a durable archive lane that copies each
  release receipt into the repository after digest review against the
  annotated tag, and a third-party review ledger with one version-keyed row
  per inventory item gated against drift in CI.
- The report-consistency gate validates rendered semantics (absence claims,
  identity conflicts, reassuring copy over loud findings, subject scope)
  against structured report facts, and report identity flows through one
  exact per-host catalog seam that never renders the lossy one-slot domain
  summary directly.

- Four service-catalog classifications, each verified against the vendor's
  own documentation before entry: HUMAN Security bot defense and Microsoft
  Azure CDN endpoints (both resolve operational-only and are never counted
  as tracking), Cloudflare Web Analytics, and Tealium's tag-serving CDN
  domain. Catalog identity `hand-curated-2026.08`, provenance
  `catalog-review-v3`; no ServiceRole taxonomy change, so corpus cohorts do
  not fragment on that axis.
- Consent-interaction reports disclose which consent control was actually
  clicked, not only the choice that was requested.
- The Sourcepoint consent-selector audit, with the result recorded next to
  the selectors it reviewed.
- An r2 normalization identity ledger: both active identities are pinned as
  reviewed literals, and any sanitizer-input change that moves them fails
  closed until the documented retirement ritual runs.
- The homepage "Try" suggestions restate one committed-corpus observation
  per domain and are rendered where a first-time visitor can see them.

### Fixed

- Five stability defects (an unbounded policy probe, a proxy
  `uncaughtException`, a silently-cancelled Brave-list refresh, a false
  weekly alarm, and a dead test) and the self-host documentation that
  described them incorrectly.
- The UI/UX audit findings: focus indicators and interactive-control
  boundaries reach WCAG 1.4.11 in both themes with forced-colors support;
  the scan field's whole visible surface is clickable; client URL
  validation now rejects in Chromium what its Node-only test wrongly
  pinned as rejected; the 404 page carries its own metadata; touch-target
  floors, keyboard-focus recovery on failure paths, and number, byte, and
  timezone formatting across report surfaces.
- Two latent identity-aliasing defects exposed by the catalog revision: a
  closed producer epoch tracked the active catalog identity instead of the
  one it published under, and the v1 redactor's reviewed-identity list
  omitted the closing catalog revision, which would have broken
  redaction idempotence for committed reports.

### Changed

- Every pressable control meets the 44px touch-target floor whenever any
  coarse pointer exists, without inheriting the narrow-viewport layout; the
  static smoke asserts computed target sizes in both a mobile and a wide
  hybrid-pointer context, and the two error boundaries gained their first
  coverage.
- Both production promotion workflows can mint their App token via the
  non-deprecated client-id input the moment the operator stores the App
  client id; the deprecated path keeps working until then.
- The thirteen 2026-07-21 featured-site deferrals were removed ahead of
  their hard expiry so the next scheduled cycles can generate fresh
  adjudication evidence; deferral-exclusion mechanics remain covered by
  synthetic tests.
- The release runbook documents rollback (revert forward through the pull
  request flow; tags and production never rewind), the identity-versus-bytes
  meaning of the committed-report freeze, quantified durable-jobs soak
  durations, and the measurement-freeze rules a repository variable cannot
  enforce.
- The v0.3.0 release receipt is durably archived in-repository with its
  digest verified against the annotated tag.

## [0.3.0] - 2026-07-30

Pre-1.0 milestone prepared for the repository's first attested tag ceremony.
It does not declare a stable public API, enable npm publication, turn automated
observations into legal conclusions, or claim that disabled operational paths
are live. The ScanReport schema contracts (v1 frozen, v2/r1, v2/r2) continue to
version independently.

### Added

- Exact-source release receipt isolation now separates candidate builds,
  hostile-data validation and attestation, and atomic tag publication. The
  release gate independently requires the exact promoted commit and all five
  named main-branch CI conclusions.
- Detector accountability records the exact detector and phase obligations for
  each metric family, preserves historical producer tuples, and refuses to use
  public output as proof that a detector ran.
- A first pixel-events calibration pilot exercises the labeled-study pipeline
  and deliberately publishes no precision or recall rate because it contains no
  representative labeled cases.
- Real-site scanner-fidelity coverage checks both supported wire generations,
  renders every returned report, and rejects contradictions between navigation,
  detector status, findings, and reader-facing summaries.
- Production-control receipts now record the bounded WAF admission ceiling,
  log-retention queries, and required R2 create/read/delete/absence canary
  without treating those observations as permanent infrastructure guarantees.

### Changed

- Report and corpus metrics now remain cohort-, methodology-, producer-, and
  detector-status-specific. Unsupported, omitted, censored, or deadline-lost
  families remain unavailable instead of silently becoming reassuring zeroes.
- Featured and one-off report publishers now propose reviewed pull requests;
  corpus floors are structural, and a stale proposal must be regenerated from
  one current tree rather than updated in place.
- Both production promotion paths authenticate with a repository-scoped GitHub
  App token and keep checkout credentials out of Git configuration. The
  production updater ruleset grants that App its sole bypass while the exact-
  SHA evidence ruleset retains none; freeze refusals and the positive
  promotion canary are recorded separately from workflow source.
- The browser and container measurement toolchain moved to Playwright 1.62,
  the application moved to Next.js 16, and reviewed GitHub Actions pins and
  dependency overrides moved with the corresponding evidence contracts.
- Evidence Library, comparison, shared-link, print, reduced-motion, live-scan,
  and narrow-screen states now expose more of their evidence and status without
  turning missing or incomplete observations into verdicts.

### Fixed

- Detector-specific failures, phase omissions, capture loss, and evidence caps
  no longer borrow another detector's success, report unmeasured rates, or use
  budget-exhaustion language for a bounded evidence cap.
- CNAME, privacy-policy, platform-request, consent, navigation, detached-frame,
  and third-party-host findings now stay aligned with the exact facts their
  detectors observed.
- Scanner setup, CNAME resolution, worker fetches, cancellation, durable-job
  pumping, and response parsing now spend and report the deadline that actually
  governs them instead of continuing work or misclassifying the stop.
- A blocked or still-working scan no longer reads as a clean result or failed
  navigation, and a widget or shared-link error no longer blanks otherwise
  valid live evidence.
- Corpus cards and rankings no longer pool incompatible cohorts, count covered
  sites as measured sites, or headline comparison deltas that the selected pair
  could not support.
- Link-state announcements, new-tab disclosure, printable evidence, reduced
  motion, mobile overflow, and representative control-state handling were
  repaired across the report and scan surfaces.

### Security

- `main` now uses a no-bypass, linear-history pull-request ruleset with strict
  candidate checks and resolved review threads; any matching `v*` release tag,
  once created, is protected from update or deletion by a separate no-bypass
  ruleset.
- Production promotion authority is separated from ordinary workflow tokens,
  while exact-SHA evidence checks stay in a distinct no-bypass boundary.
- Supply-chain CI verifies the deterministic dependency/filter inventory,
  audited registry state, Rust advisories, repository configuration, and the
  smoke-tested runtime image without suppressing blocking findings.

### Documentation

- Release and governance documentation now distinguishes source evidence,
  deployment convergence, environment approval, immutable tags, the closed
  production-updater gate, and the still administrator-bypassable,
  non-App-exclusive tag-creation path instead of presenting them as one gate.
- Evidence and calibration language states that one automated visit is a
  lower-bound observation rather than a universal or legal conclusion, and
  that a pilot with no representative labeled cases cannot emit rates.

## [0.2.0] (declared 2026-07-25; never tagged)

Milestone of the pre-1.0 development line, declared for tagging on 2026-07-25.
No `v0.2.0` tag or GitHub release was created. On 2026-07-29 the release policy
returned to development rather than retroactively tagging a later tree. The
0.3.0 milestone supersedes that untagged declaration, while this section remains
as the source-level record of what the project called 0.2.0. Neither declaration
creates a stable public API or enables npm publication. The ScanReport schema
contracts (v1 frozen, v2/r1, v2/r2) version independently of this line and are
unchanged by it.

These entries describe source-level work on the private development line. A
feature-gated path, test, canary, or runbook is not evidence that its external
activation gate has passed or that the corresponding production control is live.

### Added

- A machine-readable development release policy plus deterministic exact-clean-
  HEAD receipts for the tested static tree and local container image. CI retains
  both receipts under artifact names containing the tested commit.
- OCI source, revision, title, and license labels on the runtime image, with the
  release-evidence gate requiring its label and embedded runtime commit to agree.
- Native v2/r2 temporal-report construction for archive and uploaded singles,
  with chronology, subject/device identity, methodology, producer, toolchain,
  per-family comparability, and every diff recomputed before rendering or
  export. Mixed v1/v2 pairs and frozen v2/r1 pairs refuse explicitly.
- An active-producer contract matrix that takes Node/Playwright and request-only
  PageGraph r2 output through managed receipt validation, rendering, temporal
  comparison, and corpus shaping while separately pinning the controlled
  featured-corpus preflight. Retired Browser Run output remains outside active
  parity, and PageGraph-unsupported families remain unavailable rather than
  zero.
- Analysis-only repeated-pair and detector-calibration contracts. Repeated
  effects remain metric-scoped and descriptive, while detector rates require a
  separately labeled study with complete denominators; no representative
  calibration study, population-effect claim, or detector-accuracy claim is
  supplied by the repository today.
- A keyboard and assistive-technology contract covering replacement-region
  focus, sibling page landmarks, explicit directory submission, non-tooltip
  explanations, visible clipped-card focus, comparison announcements, text
  equivalents for request timelines, definition-list semantics, and touch
  targets. Static browser smoke also samples representative light, dark,
  archive, comparison, report, explorer, and narrow states for serious or
  critical Axe findings; that is not WCAG certification or manual screen-reader
  coverage.
- A shared browser JSON-fetch policy with connection and whole-operation
  deadlines, decompressed-response byte ceilings, caller-abort composition,
  and latest-operation ownership. Report, archive, comparison, corpus,
  scanner-health, ordinary and durable scan-submission, admission-recovery, and
  cancellation reads now cross bounded response-body contracts.
- Request-bound durable-admission recovery using a fresh 256-bit browser
  capability, canonical semantic commitment, tab-scoped pre-POST retention,
  header-only readback, and one atomic quota/work/recovery record. The browser
  enables it only when health reports a ready durable edge, and inability to
  retain the recovery capability stops the POST before any request leaves the
  tab.
- A budgeted persistent durable-job pump that prioritizes lease recovery and
  ordinary dispatch, isolates optional scheduled-rescan failures, aborts hung
  work, and persists a successor before yielding. Durable execution and its
  sharding path remain disabled in the committed production configuration.
- Accountless encrypted scheduled rescans with bounded cadence, TTL, attempts,
  history, atomic quota/admission, capability-only management, Worker-only
  encryption and key rotation, and fresh target validation. The post-durability
  feature flag remains off in production and still requires the staged canaries
  and operator receipts in its runbook.
- A fixed-prefix, independently authenticated R2 create/read/delete/absence
  canary plus a production-health lane. Its Worker, secrets, URL, and required
  gate are not configured live, so the implementation does not prove deletion
  of production report objects.
- Crawlable, canonical per-site profiles, paginated directory pages, qualified
  category summaries, corpus exports, and a searchable detector catalog.
- Compact evidence receipts, report breadcrumbs, exact-rescan and history
  paths, social cards, and an evidence-problem reporting link.
- A public status page that fails closed across current, stale, degraded, and
  unknown deployment or artifact evidence.
- Public security and corrections pages, RFC 9116 security.txt discovery, and
  an append-only machine-readable corrections ledger contract.
- Truthful scan stages and tab-scoped recovery for accepted jobs without
  persisting scanner access keys.
- A disabled-by-default, enum-only aggregate observability boundary with
  Global Privacy Control and Do Not Track opt-outs.
- Contribution, conduct, code ownership, issue-form, pull-request, citation,
  and source-package metadata.

### Changed

- The homepage now leads with the scan task, delays archive and full-report
  code until requested, and offers server-selected examples plus known-site
  history without downloading the full manifest on first load.
- Saved report pages server-render a compact summary and load the full evidence
  explorer only after the reader requests it.
- Canonical, Open Graph, Twitter, robots, and sitemap output now uses one
  fail-closed public HTTPS origin and respects the configured base path.
- Runtime scanner pages and expiring runtime report URLs are excluded from
  search indexing while currently retained, versioned static evidence remains
  discoverable.
- Featured-corpus refreshes use bounded transient-only retries and require at
  least 80 percent active-catalog coverage across at least 50 sites; temporary
  deferrals are versioned, time-bounded, and publicly explained.
- Revision-2 featured-corpus publication is gated on an attested stable-region
  self-hosted runner, exact clean-checkout provenance, consent verification,
  and persistence checks. Automated schedule and repository dispatches require
  that controlled r2 lane once the runner label is configured; until then the
  weekly refresh continues on a loudly disclosed frozen v1 fallback (workflow
  warning annotation, distinct commit message) instead of failing against
  unprovisioned infrastructure. Legacy v1 otherwise remains an explicit manual
  dispatch lane, and manual v1 cannot reconcile the authoritative refresh state.
- Corpus statistics, category summaries, leaderboards, and researcher exports
  now select exact schema/methodology/recorded-producer cohorts. R2 and legacy
  v1 data are never silently pooled; rows expose provenance, quality,
  consent-verification, comparison-decision, compatibility, inclusion, and
  cohort-denominator metadata while excluded rows remain auditable.
- Node r2 facts now travel with the frozen-v1 compatibility result in an owned,
  process-local, non-serializable measurement envelope, so cloning, queuing,
  and async execution cannot silently detach evidence before public or shadow
  emission.
- Valid HTTP 600-999 observations now cross the frozen r2 boundary as `null`
  plus explicit request-family capture-loss facts instead of a fabricated 599.
  Readers remain strict, and affected navigation claims are treated as failed
  or incomplete rather than reassuring privacy results.
- Comparison changes are presented as signed variant-minus-baseline
  observations, including per-domain request contributions, without treating
  either direction as inherently better or upgrading descriptive differences
  into causal claims.
- Encrypted-watch creation shares the ordinary Turnstile or scanner-token gate
  and atomic quota path; an optional separate edge-only factor is confined to
  isolated operator staging canaries and never reaches the public browser.

### Fixed

- Single-column mobile grid collapses now use `minmax(0, 1fr)` like their
  desktop counterparts, so an item whose font-dependent minimum content width
  exceeds the viewport (as on CI's font set at 390px) can no longer blow the
  track out and force page-level horizontal overflow.
- The runtime container image no longer ships the base image's global package
  managers (npm, npx, yarn, corepack, whose bundled tar, undici, and sigstore
  copies carried fixed-upstream HIGH/CRITICAL advisories the app never
  executes) or the WebKit-only GStreamer "bad" plugins. Container release
  evidence now asserts the package-manager absence instead of a version, and
  the blocking Trivy image gate passes on real findings removal, not
  suppression.
- A consent control identified by a known CMP selector keeps its CMP
  attribution when its page-owned click handler throws on the first dispatch
  and the control only reacts to the later generic-tier retry; the report no
  longer downgrades that click to a generic text match.
- The promotion smoke and the hourly production synthetic no longer hard-depend
  on one third party: both walk an ordered list of fixed, independently hosted
  candidate targets (iana.org, then w3.org; the synthetic's candidates stay
  server-allowlisted for the monitor credential), fall through only on a
  target-attributable scan failure with a logged warning, and stay red when
  every candidate fails, which indicates scanner-side breakage.
- Directory search now normalizes pasted URLs and `www` hosts, keeps one
  current profile per canonical site, and selects the newest eligible Shields
  comparison independently of the latest general report.
- Public-suffix-apex sites such as `gov.uk` remain discoverable, and pasted
  subdomain URLs resolve to their canonical site profile.
- Corrections-linked original and replacement reports are protected from age
  and count pruning, with malformed or dangling ledger references failing
  closed before deletion.
- Correction events now render on the public ledger and affected report pages;
  corrected, superseded, or withdrawn reports are `noindex`, and CI enforces
  unchanged event history plus byte-identical previously pinned bundles.
- Scanner workflows reject stale local processes and fail safely on a
  non-fast-forward publication race instead of rebasing already validated
  retention output.
- Status freshness expires in the browser instead of leaving a stale positive
  badge, and status copy no longer implies that endpoint alignment proves a
  successful scan or storage round trip.
- Evidence-problem links open the required GitHub form with safe report fields,
  and runtime status reads the canonical public deployment receipt rather than
  a missing scanner-local file.
- Mobile evidence receipts wrap safely at 320 CSS pixels, and source links for
  validation fixtures are pinned to the exact public build commit.
- Stale or superseded browser reads can no longer overwrite newer report state
  or clear its busy indicator, and oversized or stalled JSON responses fail at
  the shared bounded transport boundary.
- Ordinary scan submission, scanner-health, and cancellation responses now
  bound stalled headers, stalled bodies, malformed JSON, and decompressed size;
  caller cancellation remains distinct from a transport deadline.
- Outcome-unknown durable submissions retain one request-bound admission across
  reload and use a bounded, header-only GET window to recover exact accepted
  identifiers without another POST. Exact retries converge without charging
  quota or admitting work twice; changed semantics fail before the network,
  definitive rejections clear the pending record, and uncertain failures keep
  it available through the accessible recovery UI.
- Turnstile validation derives a retry UUID from the admission capability hash
  and exact challenge token: the same token converges on one Siteverify
  operation, while a refreshed challenge receives a distinct identity.
- Failed r2 navigations whose exact status is unrepresentable now lead report
  headlines and findings with an explicit incomplete-load explanation; quiet
  or positive absence cards are downgraded instead of becoming false claims.
- The CONNECT egress proxy preserves already queued response bytes through a
  graceful tunnel half-close instead of truncating them when one side ends
  first.

### Security

- A direct GitHub private vulnerability reporting path replaces ambiguous
  disclosure instructions.
- Public canonical-origin validation requires a public DNS-style hostname and
  rejects IP literals plus local or special-use names; recovery state stores
  only opaque job capabilities and bounded timestamps.
- Routed GPC initialization binds script and worker instrumentation to the
  measured first-party request, preserves worker/module semantics, and refuses
  redirects or request-metadata drift. Unparseable modules keep their original
  bytes and produce disclosed, bounded capture loss rather than aborting or
  silently overstating GPC coverage.
- Durable admission and encrypted-watch capabilities stay in headers or URL
  fragments rather than request paths and queries; authoritative stores retain
  only bounded identifiers, hashes, encrypted targets, and required recovery
  metadata rather than raw browser bearers or caller identity.

### Documentation

- A correction-review workflow requires immutable report identities and
  append-only dispositions.
- Operator guides document the revision-2 corpus rollout and the disclosure,
  infrastructure, and review gates required before aggregate observability can
  be enabled.
- Release and operator runbooks separate clean-source artifact receipts from
  live deployment proof and record the still-open governance, preview-access,
  Node-version, delete-canary, and independent-egress gates.
- The research evidence model documents why repeated directional observations
  are not replication or causal claims and why source-pinned acceptance
  fixtures are not detector calibration data.
- Durable-job, encrypted-watch, and R2 delete-canary runbooks require isolated
  staging, distinct credentials, explicit teardown, exact-source readback, and
  a separately reviewed production activation; none of those documents
  authorizes enabling the currently off feature flags.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[0.4.0]: https://github.com/iAnonymous3000/site-behavior-lab/releases/tag/v0.4.0
[0.4.0-rc.1]: https://github.com/iAnonymous3000/site-behavior-lab/releases/tag/v0.4.0-rc.1
[0.3.0]: https://github.com/iAnonymous3000/site-behavior-lab/releases/tag/v0.3.0
[0.2.0]: https://github.com/iAnonymous3000/site-behavior-lab/commit/4240d32d1fa987e8d61d74fe719f6a8382422efa
