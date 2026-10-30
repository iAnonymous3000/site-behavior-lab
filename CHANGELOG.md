# Changelog

All notable changes to Site Behavior Lab are documented here.

The format is based on Keep a Changelog. The project has not declared a stable
public API or a 1.0 release.

## Unreleased

### Fixed

- The Shields copy says the list-blocking numbers come from Site Behavior
  Lab's list-based simulation, which can differ from Brave Standard on a
  page's requests to its own site. The simulation applies every list to every
  request; Brave's default Standard setting skips most of these lists for
  such requests (brave-core `c664e847`, confirmed natively on one site). The
  classification card no longer says "An actual Shields visit blocks these".
  The report details, methodology page, glossary, scan-mode hint and
  limitations change; no stored report, count or identity does. The
  limitations page also names the iOS-only default list the snapshot
  carries, which desktop Brave never loads.
- The synthetic-input card's title says the test value appeared in requests
  to its recipients, as its lead already did, instead of that it "reached"
  them. A request the scanner's own guard refused still names its recipient
  (the page sent the value), so "reached" claimed a receipt the evidence does
  not show. Filed by the external review of 2026-10-28 (item 1); the
  measured evidence and the report's other wording are unchanged.
- The consent probe reads a control as CSS does (consent-control-and-state@4,
  node-detectors-v22). A control set back to `visibility: visible` inside a
  hidden ancestor, or to `pointer-events: auto` inside one that takes no
  pointer input, is visible and clickable, as a real click finds it; through
  @3 either ancestor value hid or disabled it. And a hit on a shadow root's
  host is followed into that root, level by level, until it names the
  control: an overlay inside the root retargets to the same host, so through
  @3 a covered control in a known CMP's shadow root read as visible and was
  clicked. Filed by the external review of 2026-10-28 (items 3 and 4).
- A shared worker the fingerprint readout saw held, whose attacher channel
  then closed before the worker made another move, is an unread realm and
  leaves the fingerprinting evidence incomplete (fingerprint-observer@11,
  node-detectors-v22). Through @10 it was excluded as having run nothing,
  although the hold last seen may already have broken, while the same loss
  before the readout counted it unread. Item 5 of that review.
- node-detectors-v22 moves the fingerprint observer and the consent probe
  with the registry (`8e5f4258...a5f9` to `e4367c5d...ff68`). The two v26
  producer rows close to frozen literals that hash as they ran, every other
  Node and PageGraph row is unchanged, and two v27 rows open; the
  obligations, public strings, normalization and methodology do not move. A
  temporal comparison across the epoch refuses detector findings and consent
  verification.
- The scroll check no longer names a page request's script host for a
  dedicated worker's request to the same URL. When a URL has more requests
  than the page's DevTools session observed and only some are counted, none
  of its counted requests takes a call stack, and each counts as not
  observed. Inspect's output is unchanged. Item 2.
- The comparison panel's "entities only with" lists read each request's own
  catalog match, as each visit's own report does, so request order on a host
  with two entities no longer moves an entity between the lists, and a host
  redaction merged (one Google row among nine on `{label}.google.com`) no
  longer counts its unmatched requests for the entity. The stored v1 diff
  keeps the domain-summary rule the v1 reader reconciles it with, so every
  stored v1 comparison still reads. Item 6.
- The request log keeps an applied resource-type filter visible after
  switching to a comparison visit with no request of that type: the select
  shows "ping (none here)" over the empty table instead of "All types". Item 7.
- A finished in-process scan job leaves memory when its 75-minute window
  from admission ends, with or without another job call; before, only a job
  call pruned it. Item 8.
- Two history visits recorded at the same instant get no since-last delta,
  nor does a newest visit with two visits tied just before it; the direction,
  or the visit compared with, had come from which report id sorts first. No
  committed report is tied. Item 9.

- The disclosures say what fingerprint-observer@10 does with shared workers
  (owner call 6). docs/limitations.md, the methodology page and the coverage
  boundary's cross-realm entry, which said through @9 that shared-worker code
  goes unobserved, now say that the scanner holds each shared worker at its
  main script and reads its canvas, font and WebGL use with the page's own
  observer, credited by the ownership rule; that a shared worker reached
  late, one started before the hold could land, one the automation layer's
  own DevTools session let run while it was held, or a module shared worker
  with a static import, is never read and marks the evidence incomplete;
  that one which ended within 10 ms of starting has its own sentence, quoted
  word for word; that Chromium gives a shared worker no Worker constructor;
  that worklets are still not instrumented; and which reports read no shared
  worker (`fingerprint-observer@9` or earlier). The limitations page also
  gives the hold's cost in every arm (a median of 6 to 11 ms before a held
  shared worker's first statement in local measurements, at most 51 ms with
  the attacher alone under load and 11 ms in 40 whole scans), says no arm
  installs the GPC signal into a shared worker, and words the counts caveat
  as traffic: "SharedWorker traffic and WebSocket activity are not recorded
  beyond the disclosed boundaries". It also gives the debugger window as wide
  as it is: a worker held at its main script is let run with the debugger
  off, and every late shared worker but one already running when reached (its first pause at another script or not the breakpoint's, its
  main script run before the breakpoint took effect, or its hold broken by
  the automation layer's release) runs with the debugger on for a few
  milliseconds, until the attacher's `Debugger.disable` lands, so a
  `debugger;` statement in that window pauses it until then (about 1.7 ms,
  once, in local runs). The methodology page says so in a clause, and the
  attacher's docblock no longer says the debugger goes off at once for a lost
  race. The README and docs/capabilities.md make no claim about shared-worker
  code, and their traffic lines stay true, so they are unchanged; the GPC
  disclosure is unchanged. Two boundary tests pin each claim to the code that
  makes it true (the observer version, the bound, the late reasons the thread
  classifies, the readout's unread rule, markLate's `debuggerOn` for every
  late class and the broken hold's own disable, the GPC installer's one worker
  kind), and a scanner test holds the ended-at-once line and its quality line
  to both contexts: the fresh result's v1 and public r2 reports, and the
  store's sanitized report that saved, shared and exported reports read.
- A shared worker whose hold at its main script ended before the
  fingerprint observer was installed is an unread realm, not a read one
  (fingerprint-observer@10; the defect never shipped). Any DevTools client's
  release of a worker, `Runtime.runIfWaitingForDebugger` or a waiting
  session's detach, ends a pause the worker is in, instrumentation pauses
  included, and Playwright's browser session detaches every shared worker as
  it attaches. When that detach reached a worker the attacher had just
  paused, the worker ran its main script with no observer, the install
  evaluated only at its next pause or task, and the attacher reported it
  installed and released, so the readout read the realm complete on the
  install's empty snapshot. In local loads of a page whose shared worker reads
  the unmasked WebGL renderer and a canvas, that happened in 3 to 9 of 50 to
  60 unloaded loads and 2 or 3 of 200 concurrent ones, each with a hold of 37
  to 118 ms against a median of 5 to 9. The attacher's thread now treats a
  resume of a held worker, or a pause at one of its statements, before every
  install command answered as a broken hold: the worker is late
  (`resumed-while-held`), the debugger is sent off at once, and nothing
  reports it installed or released; the main thread never presents a late
  worker as held, installed or released. A resume behind the answers is the
  hold's own end. In two runs of 120 unloaded loads, each of the 24 broken
  holds came 0.4 to 1.8 ms after the pause, with the attacher's own release
  already answered before it, so the release was Playwright's; in the second
  run the debugger stayed on for 2.5 to 5.3 ms after the resume. The readout
  no longer settles on that lagging view either: a shared worker the main
  thread sees held, at the freeze, after reaching, or attached during the
  drain, waits for its next move within the drain's bound, since the thread
  may already have broken the hold with its "late" report still in flight.
  Late reads unread; released, died while held, or still held at the bound is
  excluded as before, so the change only ever turns an exclusion into an
  unread realm. With the fix, every held worker of 200 loaded, 200 concurrent
  and 120 unloaded loads had its calls read (200, 195 and 112 held), and every
  broken hold read unread; in the production base image (linux/arm64), 199 of
  200 loaded single and 199 of 200 concurrent loads held in each of two
  passes, and 117 then 120 of 120 unloaded, every miss `resumed-while-held`
  and unread. A real-Chromium case makes the break certain: a second DevTools
  client releases the worker inside a test-only wait in the hold.
- The scanner reads a page's shared workers (fingerprint-observer@10,
  node-detectors-v21; shared-worker coverage brief, approved 2026-10-26,
  calls 1 to 6). Each visit registers its browser context with the shared
  browser's one shared-worker attacher, which holds the visit's shared
  workers at their main script while the fingerprint observer is installed,
  so a shared worker's canvas and WebGL calls now publish as the visit's
  evidence, its unmasked WebGL vendor and renderer reads included,
  credited to the page when its script is of the main document's origin and
  that document was current at its creation, and read unscoped otherwise.
  Through @9 every shared worker was an unread realm: the visit carried the
  Web Workers line, a fingerprinting capture loss and a partial detector. A
  shared worker the attacher reached late, or one the attacher could not
  serve (a start or a registration that failed), is still an unread realm.
  A shared worker the attacher never reached that ended within 10 ms of its
  creation, by the attacher's own receive times, has its own line, "The
  page started 1 shared worker that ended within 10 ms, before the
  fingerprint observer could reach it, so whether it ran any code is not
  known." (with a count of 2 or more, "The page started <n> shared workers
  that ended within 10 ms, before the fingerprint observer could reach them,
  so whether they ran any code is not known."), and its own r2 capture-loss
  detail, `fingerprint-shared-worker-ended`, under the fingerprinting family
  and apart from `fingerprint-observer`; it is not a budget. Readers still
  treat the visit's fingerprinting evidence as incomplete for it (owner call
  3b), so the line censors exactly what the Web Workers line censors, and
  the r2 reader's note words it as the line does. Its bound, detail and
  words live in one dependency-free module, lib/shared-worker-ended-at-once.ts,
  which the scanner, the loss contract, the presentation, the censorship
  notes, the comparison rules and the v1 store's sanitizer share. The
  detector is partial on that loss alone, which detector-obligations-v3
  admits (an alternative loss on the partial fingerprint row); v12 to v20
  keep detector-obligations-v2. In a consent visit, a shared worker read at
  the read just before the click no longer makes that boundary incomplete,
  so the page's own fingerprint detections are placed by phase again; one
  that ended at once makes it incomplete, with its loss at that read's
  phase. GPC stays dedicated-only. Identity: the registry moves from
  node-detectors-v20 (`30f7aa03...ae75a`) to node-detectors-v21
  (`8e5f4258...a5f9`), and recomputing it with only the registry version, the
  observer version and the obligation contract restored reproduces
  `30f7aa03...ae75a`; detector-obligations-v2 (`502d1490...0f2b`) to v3
  (`f023d19e...18b2`); the public string policy (public-string-policy-v4)
  from `bc719d41...844e` to `3a2328d7...a1a1` through its pattern label,
  scanner-warning-patterns-v9 to v10, alone, which admits the line's two
  forms and nothing else. The Node and PageGraph normalizations move with
  it, and `bc719d41...844e` joins SUPERSEDED_R2_NORMALIZATIONS for both, so,
  as at node-detectors-v15, no report published before this epoch compares
  over time with one after it, for any family. The two v25 producer rows
  close to frozen literals that hash as they ran (`5c649d27...6ce4`, the
  parent's live pair), the PageGraph canvas-evidence row closes the same way
  (`5608cd93...3ae8`), and two v26 rows and a PageGraph row open; dumped as
  canonical JSON at 83e21bbd and here, all 85 Node and 21 PageGraph rows of
  the parent are byte for byte unchanged, ids and order included. Reports
  already published keep their detector version. Tests: the scanner suite
  runs each shared-worker case with the attacher on and off (a test-only
  switch that leaves the scanner as it was through @9), reads a shared
  worker's canvas and another's WebGL in two concurrent visits of one
  browser, takes a shared worker that ends at once through the real r2
  builder, the obligations, the evaluator and the store's sanitizer, in
  observe and consent visits, and shows that with the attacher on and off
  every evidence family but the shared worker's fingerprint evidence, every
  other detector and loss, and the dedicated worker's counts are the same;
  the v1 and r2 parity property models both reads of a shared worker that
  ended at once; the validation matrix gains two real-Chromium cases (38).
- The scanner can now hold a shared worker at its main script and install
  the fingerprint observer there (shared-worker coverage brief, approved
  2026-10-26, calls 1, 1b, 4 and 6). New in lib/shared-worker-attacher.ts:
  one attacher per shared browser, on a worker_threads thread of its own,
  with its own DevTools client and a browser-level auto-attach filtered to
  shared workers. A shared worker of a context no visit registered is
  detached in its attach event's own step and nothing else is sent to it.
  For a registered visit's worker the thread sends `Debugger.enable`, an
  instrumentation breakpoint before any script and the release of its own
  start-up hold in that step, and on the first pause, only when it is at the
  worker's main script, the fingerprint installer's own commands, then turns
  the debugger off, which resumes the worker. A worker reached late (its
  first pause at another script, a main script parsed before the breakpoint
  with no pause ahead of a later answer, or already running) gets nothing
  installed and reads unread. The installer
  (lib/worker-fingerprint-realm.ts) hands the thread its commands with a new
  "shared-worker" realm of the observer, judges the answers by the
  dedicated install's own rule, reads the stream and the barrier through the
  thread in the order its connection received them, and credits a shared
  worker to the visit's main document only when its script's origin is that
  document's and the document current at its attach, read on the thread's
  own connection, is the main frame's at the freeze; otherwise it is
  unscoped, never excluded. The readout's shared terms stand apart from the
  dedicated ones, which they never move, and a shared worker the thread
  never reached that ended within 10 ms of its attach is counted apart from
  the realms that ran unread. GPC stays dedicated-only: the GPC installer
  names dedicated workers as its only kind, and a shared construction is a
  GPC loss whether or not a shared attach exists. The scanner does not use
  the attacher yet, so no report changes in this step. Real-Chromium cases
  install the observer at the main-script pause of a classic blob, an http,
  a module, an importing and a closing shared worker and of one that tries
  to start a dedicated worker (Chromium 153 gives a shared worker no Worker
  constructor, natively), with no crash; a module worker with a static import
  is reported late; a deliberately late attacher reads unread; two
  concurrent visits each read only their own worker.
- A check after scrolling's result now shows its answers and labels (build
  brief approved 2026-10-25, section 4, owner calls 2, 3, 4 and 6). The line
  for requests that got no answer sits after the traffic line, before the
  analytics events. A labelled window's hosts split under up to three
  headings, each list labelled by its own heading. In the events section
  each destination carries its state in brackets before its colon, and
  Brave's own account of its Standard setting follows the note for an
  address on the site itself, once. The caveats begin with the report's
  matching caveat and the approved blocking caveat when a label shows, or
  with "This check could not compare its requests with the default filter
  lists of Brave Shields." when the scanner's list engine was not loaded. A
  result without labels, an older container's included, shows exactly the
  panel it did. The panel and its copy stay in the evidence explorer's lazy
  chunk (client-boundary test). The below-the-fold coverage-boundary entry,
  README, docs/capabilities.md and the methodology page say a check counts
  only answered requests and can show the same visit's list matches, pinned
  by the boundary test, and docs/limitations.md names the new fields beside
  the divergence from the RFC it records; docs/scan-report-v2-rfc.md is
  unchanged. The static smoke renders the panel from the shells the real
  scanner wrote for the answers and labels fixtures' pages, and for the
  labels page with its list engine unavailable, on a desktop and a phone.
- A check after scrolling now labels each host it lists, and each analytics
  destination, with how its counted requests compared with the default
  filter lists of Brave Shields in the same visit (build brief approved
  2026-10-25, part B, owner calls 3, 4 and 6): matched, no match, or not
  compared, the strongest across them. The labels read only what the
  scanner's page route already records for every request, check requests
  included: the requests its metered engine wrapper ran on
  (`shieldsClassifiedRequests`) and the decisions it stored
  (`shieldsMatches`). No engine is called for them, and a request outside
  the classified set reads as not compared even when a decision was stored
  for it, as an ineligible request's `false` is. A listed host takes the
  strongest state across every raw host it stands for, through the raw-host
  mapping the call-stack join uses, and a destination the strongest across
  the beacons grouped into it. The evidence carries an optional
  `filterLists`, "compared" or "unavailable" (the engine not loaded), only
  beside a listed host or an event destination; with "compared", every
  window that ran carries `matchedHosts` and `uncomparedHosts`, the listed
  hosts in those states in listed order, and every destination its `lists`.
  A part the closed validator refuses is dropped alone, and a result
  without labels, an older container's included, still validates. The
  result's copy splits a labelled window's hosts under up to three
  headings, brackets each destination's state before its colon, adds
  Brave's own account of its Standard setting once beside a labelled
  destination on the site itself, and adds the report's matching caveat and
  the approved blocking caveat once when a label shows, or, without the
  engine, "This check could not compare its requests with the default
  filter lists of Brave Shields." The heading for hosts not compared is a
  corrected draft: the approved "`<i>` were reached only through redirects,
  which this check does not compare with the lists:" names a reason the
  evidence does not carry, so it reads "`<i>` had no request this check
  compared with the lists; it does not compare requests that followed a
  redirect:", the approved text beside it. A serial-lane fixture, through
  the real scanner, its engine and the vendored lists, shows all three
  states, a listed host over two raw hosts in different states, and the
  site's own GA4 address matched.
- A check after scrolling now counts a request only once its host answered
  it, with a response at any status (build brief approved 2026-10-25, part A,
  owner calls 1 and 2). Until now the check took a request the scanner sent
  as reached, so a host that never answered was still listed, and its
  requests still counted toward the call-stack counts, the event counts and
  the traffic line. The scanner now feeds the check its page's response and
  requestfailed events, attached in runScrollCheckPhase once the envelope is
  built and detached in its finally, so neither listener exists during the
  ordinary visit, and no failure's error text is read. A host is listed when
  its first request started in the window and the scanner sent it, and one
  of its requests there was answered, so a failed first try followed by a
  good retry still lists it; the request counts, the call-stack join and the
  decoded analytics beacons count answered requests only. Each window
  carries an optional `unanswered` count, only when above 0: the requests
  the scanner sent, other than the page's own navigation, that got no
  answer, among those it would otherwise have counted (a third-party
  request, or a beacon in a decoded format, the site's own hosts included),
  each once; a request the scanner refused is never one of them. The settle
  after the windows now waits, under its one bound of at most 5 seconds
  within the deadline, for the routing decisions in flight and then for an
  answer or a failure for every request the scanner sent in the windows it
  reports, and ends as soon as everything is in. The result's copy gains one
  line, "`<n>` requests got no answer before the check ended, so they are not
  listed or counted." (approved, as the single total; the singular is
  drafted). A serial-lane fixture shows, through the scanner's route, that a
  sendBeacon beacon, a keepalive fetch, an image, a 204, a 404, a 302 and its
  hop to a new host, and a dedicated worker's fetch each receive a response;
  that a refused plain-HTTP connection, a refused tunnel and the scanner's
  own refusal reach the page as failures; that an answer landing after the
  scroll window but within the settle counts; and that one past the bound
  does not. The check's invariant tests pass unchanged.
- A check after scrolling's result now shows the analytics events it
  records, in one section folded by default like the call-stack section,
  after the lists and right before how the check ended, under "Analytics
  events the page sent" (build brief approved 2026-10-25, section 4, owner
  calls 2 and 3). Opened, it reads the window without input as one count
  line ("In 10 seconds without scrolling, the page sent 1 analytics
  event."), then the scroll window by destination ("While scrolling, it
  sent 9:", then "GA4 events to *.example.com, an address on this site:
  page_view twice, scroll (90%), scroll depth 20%, 40%, 60%, and 1 custom
  event whose name this check does not show."), a note for each format that
  an address on the site itself receives, naming no company, the requests
  not read in full, and the scope and timing caveats, in the approved words.
  Lines the approved copy has no text for are drafted and await the owner: a
  scroll window that sent none ("While scrolling, it sent no analytics
  event."), an event sent more than once ("page_view twice", "load 13
  times"), and a destination whose events are all custom (the approved
  custom clause without its "and"). And where a bound could have applied,
  the approved "`<n>` requests could not be read in full, so some events may
  be missing." would be false for requests read in full and only not listed,
  so it reads "... could not be read in full or were past this check's
  limits, ..."; the approved text sits beside the draft. The section and its
  copy live in the evidence explorer's lazy chunk, and the decoder and the
  builder reach no client bundle (client-boundary test). The copy test runs
  a truth table over the evidence shapes the validator admits and pins the
  section the real check writes for the fixture page. The below-the-fold
  coverage-boundary entry, README, docs/capabilities.md and the methodology
  page say a check can show the GA4 and Adobe Analytics events it saw sent,
  in its immediate result only, pinned by the boundary test;
  docs/limitations.md and the README's limits name what recognizing the two
  formats by path misses, a renamed collection endpoint and Adobe's newer
  Web SDK; and the static
  smoke renders the section from the check shell the real scanner wrote:
  folded before the outcome, opened in the approved words and axe-clean,
  absent without events, and on a phone a 44 px summary with no sideways
  scroll.
- A check after scrolling now records the GA4 and Adobe Analytics events its
  page sent in each window, the site's own collection addresses included, in
  its immediate result only (build brief approved 2026-10-25, owner calls 1
  to 3: names under option c, both windows, first-party addresses labelled by
  format). Only the check's own recorder decides which requests count, by its
  window and decision rules: one that started inside the window, that the
  scanner sent, that is neither the page's own navigation nor a redirect hop,
  and whose address is in a decoded format. Unlike the host lists, the site's
  own hosts count, since that is where its collection addresses are. The
  scanner hands the recorder its own bounded body helper, which the check
  calls only for those requests, when it builds its evidence, keeping
  nothing. Each window decodes at most 200 beacons and lists at most 10
  destinations and 20 event lines per destination; what a bound leaves out,
  and any body truncated, unreadable or in no recognized shape, is counted
  once in `notDecoded`. The check's `scrollCheck` block gains an optional,
  closed `events` with a `control` and a `scroll` part, each null exactly when
  its window is, carried only when a window received an event or could not
  read one in full: per destination, its format, its published host, whether
  it is on the visited site, its beacons, its events by name and percent with
  counts, and its custom events. The validator admits only the shared
  vocabulary's words, a percent only on GA4's scroll event or a scroll depth,
  at most one event per Adobe beacon, and the order rules the builder sorts
  by; events that fail it are dropped and the rest of the check kept.
  lib/scroll-check-events.test.ts pins the rules over the real check on a
  virtual clock, and the serial-lane lib/scroll-check-events-fixture.test.ts
  runs the real scanner over a local page (a timer's GA4 beacon without
  input; while scrolling, GA4 batches by sendBeacon to the site's own tagging
  host, one body past the scanner's cap, and Adobe links by image and by
  POST) and through the scan API, where the client reads the shell and
  nothing is saved. The check's existing suites, its invariant tests
  included, pass unchanged, and docs/limitations.md names the new field.
- A new decoder, lib/analytics-events.ts, reads the GA4 and Adobe Analytics
  events a request carried, for a check after scrolling (build brief approved
  2026-10-25, owner call 1, option c). It recognizes the two formats by path
  and format parameters, never by host, so a collection address on the site's
  own domain is decoded too: GA4's `/g/collect` with `v=2` and a `G-`
  measurement id, whose URL's `en` is one event and each line of a batched
  body another; and Adobe's classic `/b/ss/` beacons, from the URL or from a
  urlencoded body, each one event named by its link type. A GA4 name in
  Google's documented vocabulary (lib/analytics-event-vocabulary.ts, which
  the evidence validator will read too) is shown as catalogued; every other
  GA4 name, and every Adobe link name, is generalized to "custom event" unless
  it reads as a scroll depth (it contains "scroll", also "depth", "tracking",
  "percent" or a % sign, and exactly one integer from 0 to 100), which is
  shown in the scanner's own words as "scroll depth <N>%". Only two values are
  read: GA4's percent_scrolled on its scroll event, kept only as an integer
  from 0 to 100, and Adobe's link name, for that test alone. A body is read
  only for a request in a decoded format, through a reader the caller hands
  in, and a truncated, unreadable or unrecognized body is reported as not read
  in full, never guessed at. The decoder reuses lib/pixel-events.ts's
  isSafeEventToken, buildEventVocabulary, catalogEventName and
  CUSTOM_EVENT_LABEL, the first three now exported unchanged; the report's
  own pixel-events detector (pixel-request-decoder@6) gives byte-identical
  output, by its unit tests and by a seeded harness over 40,000 pixel inputs
  run at the parent and at this commit. Nothing uses the decoder yet;
  lib/analytics-events.test.ts pins both formats, the batched lines, the
  vocabulary rule, the matcher's positive and negative cases, the one value
  read, the body's coverage, and that no other parameter or value reaches its
  output.
- A check after scrolling's result now shows the call-stack hosts it records,
  in one section that follows the scroll window's host list, folded by
  default under "Which scripts asked for them" (owner call 2, 2026-10-24),
  and only when the list carries stacks. Opened, it reads each host's stacks
  in Inspect's approved words prefixed by the host ("pixel.charlie.com: 1
  request. Scripts on the call stack, innermost first: static.bravo.org then
  cdn.alpha.net."), the hosts that came with no call stack once, the redirect,
  no-named-script and unobserved cases once each, worded for "these hosts'
  requests", and Inspect's caveat verbatim. Two lines are not the approved
  text and await the owner: the approved "`<host>`: `<n>` more requests had
  other call stacks, not listed here." would be false for requests past a
  bound of the recording, which the same count holds, so it reads "...
  more requests are not broken down here, because the check shows at most 3
  call stacks per host and keeps a bounded number of them." (the cap clause
  only beside three listed stacks); and requests with no stack to hosts that
  also had stacks, which the approved copy has no line for, read "`<n>` more
  requests to these hosts came with no call stack, so no script is named for
  them." The section and its copy live in the evidence explorer's lazy chunk,
  never in the homepage's own code (client-boundary test). The
  script-to-request-causality and below-the-fold coverage-boundary entries,
  README, docs/capabilities.md and the methodology page say a check can show
  call-stack hosts for the hosts it first contacted while scrolling, in its
  immediate result only, and the static smoke renders the section from check
  shells the real scanner wrote, folded, opened and absent.
- A check after scrolling now records, for each host its scroll window lists
  as first contacted (at most 20), which scripts were on the call stack of
  the requests the check counted for it, under Inspect's rules, in its
  immediate result only (build brief approved 2026-10-24: the scroll window
  only; hosts only, at most 3 stacks per host, no script addresses). The
  stacks come from the CDP session the scanner already opens for attribution,
  which stays attached until cleanup, after the check; no session, page
  listener, command or domain is added, and the ordinary result is equal with
  and without the check, thrown or timed out, as before. Only the check's own
  page-request recorder decides which requests belong to the window and
  counts them; the stack recorder notes the scripts and documents requested
  from the navigation's start to the end of the window, keeps the session's
  third-party observations from one second before the window opens until the
  check builds its evidence, bounded by the check's 500-request allowance,
  and joins them per URL, in arrival order, to every request the window
  recorded for each listed host, counted or not, so a refused request never
  hands its stack to a later one. An observation a bound drops is counted as
  not listed, never as unobserved, and a listed host covers every raw host
  first contacted in the window that publishes as it. Each entry's counts
  add up to its requests, the entries never exceed the window's requests to
  new hosts, and the closed validator holds both; stacks that would not
  validate, or a session that never opened, cost the check its stacks and
  nothing else. lib/scroll-check-stacks.test.ts and the serial-lane
  lib/scroll-check-stacks-fixture.test.ts (a loader that inserts a tag on
  scroll whose fetch names the tag, then the loader; an image a script draws;
  a redirect hop; a worker's request; self-named scripts; two raw hosts that
  publish as one) pin it, and a test holds the check and Inspect to the one
  publisher. The RFC divergence note in docs/limitations.md says the block can
  carry call-stack hosts; docs/scan-report-v2-rfc.md is unchanged.
- How a visit publishes a call stack now lives in one module,
  lib/call-stack-publisher.ts, instead of in Inspect this connection's
  recorder alone, so the check after scrolling can show call-stack hosts
  under the same rules without restating them. The module holds the rules
  the owner ruled on 2026-10-22 (a frame names its script only when its
  address is a Script or Document the same visit had requested, at most four
  hosts innermost first through the report's hostname redaction, redirect
  hops and requests with no stack counted apart, preflights left out) and
  the per-URL join of the page's requests to the session's observations, in
  arrival order. It holds no state: each recorder keeps its own requested
  addresses, stacks and counts, and stops at its own boundary. Inspect's
  evidence is byte for byte what it was, and its unit tests and serial-lane
  fixture pass unchanged. lib/call-stack-publisher.test.ts pins the shared
  rules and holds the recorder to the module, and lib/client-boundary.test.ts
  keeps the module, which reads the redaction pass and sha256, out of every
  client bundle. The import walk that test uses (lib/client-import-graph.ts)
  now follows side-effect imports too, which it had missed: a mutation that
  added `import "./call-stack-publisher";` to a client module passed it.
- The scan form no longer tells a check after scrolling that it makes a share
  report. On a site that already has reports, the note under the form kept
  its usual line during a check, "A new check runs one visit in the selected
  mode and makes a separate share report, kept for up to about 7 days. It is
  not added to this site's history: ...", beside the check's own "What it
  finds shows here only and is not saved."; a check saves nothing, so the
  line now reads "A check after scrolling runs one visit and saves nothing,
  so it makes no share report and is never added to this site's history."
  while the check's arrival holds, and returns to the usual line once an
  edit or a comparison ends it. Found by following the entry on the live
  site at d098bba0; the static smoke now reads the note during a check.
- The privacy-policy reader fetches a direct PDF policy with undici 8.12.3
  (from 8.11.2), as node-detectors-v20. 8.12.2 patches CVE-2026-109869
  (GHSA-xjj6-f33q-929c, high: an unhandled error on a response with
  excessive content-encodings) and two moderate advisories,
  GHSA-4qv8-2p9j-2685 (unbounded memory in the EventSource parser) and
  GHSA-f72v-6w45-q472 (a Subresource Integrity bypass through non-lowercase
  algorithm tokens), all published after main's last green run at 89432413;
  main CI's `npm audit` and Trivy (repository and runtime image) then
  refused every build on 8.11.2, 25a99b95's included, so production stayed
  on 89432413. The detector moves with the library, as
  lib/policy-pdf-libraries.test.ts requires since 8cd1e8e2, so no policy read
  under 8.12.3 shares a version with one under 8.11.2:
  policy-text-cross-check@13 gets its row there, the registry is
  node-detectors-v20, the two v24 producer rows (the October 19 list row and
  the no-list row) close to frozen literals that hash as they ran, and the
  two v25 rows open with only the cross-check and the registry moved. pdf.js
  stays at 6.3.289, and the methodology, normalization, lists, toolchain and
  public strings are unchanged. Beside it, fast-uri moves from 3.1.8 to 3.1.9
  through a new override (GHSA-w74x-v6f9-j3xg and GHSA-wjr9-j795-jxcr,
  moderate; GHSA-xhq7-xmqj-769h and GHSA-333x-w4r6-6crp, low); it reaches the
  lock only through ajv, a development dependency, so the pruned runtime
  image contains none of it.
- A check after scrolling whose page as a whole fit the window now says it in
  those words: "The page as a whole fit in the window, so there was nothing
  to scroll; any box inside it that scrolls on its own was not scrolled." The
  approved sentence, "The page fit in the window, so there was nothing to
  scroll.", was false for a page that scrolls inside a box of its own, whose
  document fits the window while its content runs on (the fixture's
  inner-scroller page ends this way). It is a corrected draft pending the
  owner's review, with the approved text beside it in
  lib/scroll-check-copy.ts.
- A check after scrolling's own result now shows, at its top, what the check
  recorded: "What this page first contacted after scrolling began", then what
  the page first contacted in 10 seconds without scrolling and in the next 10
  seconds while the visit scrolled, the hosts listed by site ("lazy.net:
  cdn.lazy.net, *.lazy.net"), the requests it sent to third parties it had
  already contacted, how the check ended, whether the page changed its own
  address, what cut the lists, the timing, mechanism and consent caveats,
  where the check began, and that nothing from the visit is saved, shared,
  exported or printed, with the separation sentence and "Open the earlier
  result" when the link named one. One sentence then says what the ordinary
  report beneath covers: "The report below covers the visit before the check
  began." Every sentence is the approved one, a count of one in the
  singular, and a line that does not apply is left out; where an approved
  sentence would be false for what a result records, a corrected draft
  stands in its place pending the owner's review, with the approved text
  beside it in lib/scroll-check-copy.ts: a page that turned scrolling off or
  stopped moving after the visit had scrolled some screens, a check that
  stopped early for a reason other than its time, the not-saved line for a
  visit that never scrolled, and the line above the report of a check that
  did not run. "N more are not listed." is drafted. The result offers no
  share, no CSV, JSON or PDF export, no "Post on X" or "Copy post", and no new
  visit of its own (no Inspect this connection, no Blocker follow-up); on
  paper the whole result, its ordinary report included, stays off the page.
  It renders only from the result the tab's own submit received: a resumed,
  restored or recovered job's result that carries a check shows nothing, and
  neither does a reload. The panel and its copy live in the evidence
  explorer's lazy chunk, and the homepage's own code reads only the type-only
  result reader, so the scanner's recorder never reaches a client bundle.
  The coverage boundary's below-the-fold entry, the README, the capabilities
  list, the methodology page and the limitations page now say that an
  on-demand check can show, in its immediate result only, the third-party
  hosts its page first contacted after scrolling began; the scanner's own "no
  scrolling" sentences stay as they are, since they remain true of every
  saved report. The static smoke follows a check link and presses Check
  against a test answer; the Chromium smoke sends the refusals and follows a
  check link, and scans nothing.
- A fresh result now offers "Check after scrolling" in its visit summary,
  under "Anything that loads only after interaction or consent" (or "after
  further interaction"), with the approved sentence beside it: "Opens the
  scan form ready for a new visit that lets this page settle and then
  scrolls it, checking scrolling only; nothing runs until you press Check."
  It follows the rule the Blocker follow-up and Inspect this connection
  follow: only a runtime share's permalink offers it, for the page and the
  share its board's other follow-ups name (gate G4), from a visit that
  established that page (gate G3), and only on a report of revision 2,
  since only that scanner can carry a check. A committed report, the
  printable route, a file opened from disk and an archive comparison offer
  none, and print hides it. The homepage's own live result shows no visit
  summary, so it offers none either; its share's permalink does. The link
  is `/#scan?url=<page>&check=scroll`, with `&from=<share id>` when the
  result has a share, and like every scan link it fills the form and
  submits nothing. The form takes at most one of a mode, an inspection or a
  check, and exactly the value "scroll"; any other value, a repeat, or a
  check beside a mode or an inspection refuses the whole link, target
  included, and the address bar keeps none of it. While its arrival holds
  (the field still holds the link's page and no comparison is selected, as
  for an inspection), the form selects Single, its one button reads
  "Check", and a status line the button names says: "Checking after
  scrolling. A new visit to <page> runs as a single scan, lets the page
  settle, watches it for 10 seconds without input, then scrolls down up to
  8 screens. What it finds shows here only and is not saved. It takes about
  a minute." The disclosure under the field then starts "A check is one
  automated, headless Chromium visit from a fixed en-US / UTC profile: a
  single scan, then up to 8 screens of scrolling, with no clicking." in
  place of the single scan's sentence; the server renders both and the
  form's state picks one, so the swap costs HTML, not homepage JavaScript,
  and a page without JavaScript keeps the single scan's. Only then does a
  scan request ask for the check, and a deployment that queues scans
  refuses it in the browser, in the approved words, before the submit is
  claimed.
- The scan API now accepts an optional `check: "scroll"` on a single scan:
  an after-scrolling check. It reaches the scanner as a visit option and
  never the recorded payload, and nothing from such a visit is saved (owner
  call 2): the scan API returns its immediate result without a share, a
  shadow copy or a publication boundary, so no report store, export or
  printed page ever holds it. The check's evidence travels only in that
  result's ephemeral block, in a new optional `scrollCheck` key of the
  single-report r2 shell, closed and validated like the rest of the block,
  never beside `inspection` and never on a comparison shell; every other
  ephemeral key stays refused. That key departs from the RFC's section 15.2
  a second time; the RFC text is unchanged and docs/limitations.md records
  the divergence beside the first, as does a comment at the type, and the
  published schemas are regenerated unchanged. At most one check runs at a
  time in a container (owner call 3), so one scan slot always stays free:
  the synchronous path refuses a second check before it takes a slot or is
  charged, and the async path at admission, before it charges, holding the
  check until its job ends however it ends. A check costs two rate-limit
  tokens, as a comparison does, by one rule: the container's charge now
  derives from the edge's, so the two never price a request differently.
  Each refusal is one sentence the visitor reads: beside a comparison or an
  inspection, "A check after scrolling runs on a single scan only."; on a
  scanner that writes version 1 reports, "This deployment's scanner cannot
  carry an after-scrolling check."; while another runs, "Another
  after-scrolling check is running; try again in a minute."; and while scans
  run as durable jobs, refused by the browser before it mints a credential,
  by the edge before any capability lookup and by the Node durable
  preparation, "This deployment queues scans, and an after-scrolling check
  cannot run from the queue." Any other value of `check` is refused with a
  drafted sentence, "The only check a scan can ask for is the after-scrolling
  check." A fixture test runs one check through the scan API's own
  execution path, the real scanner and the real report store: the immediate
  result carries the evidence, the client's reader accepts it, and the
  store holds nothing.
- A scan visit can now, only when asked, run a "Check after scrolling" on
  the same page once its ordinary result is complete: the groundwork for
  the check the owner approved on 2026-10-23. With the new `scrollCheck`
  visit option, a hostnames-only recorder listens on the page's own request
  events from before the navigation, refused requests included, and stays
  attached past the evidence boundary, so it holds the visit's whole host
  history. The scanner builds the envelope first (its result, its r2
  measurement, its duration and its proxy diagnostics, frozen as today);
  only then does the check switch the page route to its own allowance of
  500 routed requests, so the visit's 1,000-request budget and its capture
  loss never move, let the page settle until 25 s after the navigation
  began, watch it for 10.5 s with no input, and scroll it by script for
  10.5 s: up to 8 steps of one window height, 1 s after each, 2 s at the
  deepest point, one jump back to the top, padded to the window's length.
  The scroll reads and sets the scrolling element's position through the
  bounded page collector's accessors, captured before page script runs, with
  no pointer, wheel or input into any frame, and checks before every step
  whether the root or the body has scrolling turned off; a locked page is
  never scrolled. It ends as reached-end, depth-limit, did-not-move,
  nothing-to-scroll, left-site, cut-short, locked, or not-run when the page
  subject was not valid, by the gate the consent click and the typing probe
  use. A host is listed in a window when the page's first request to it
  started there and the scanner sent it, compared by raw hostname and the
  report's own third-party rule, published through the report's hostname
  redaction and grouped by site, at most twenty in all with full counts; a
  window that did not run to its end lists nothing. What cut collection
  (the visit's own budget used up before the check, the check's allowance,
  the proxy's per-visit budgets, a refusal, the recorder's bounds) is
  named. The check has a 45 s budget of its own, which never falls before
  its fixed sequence, run on time, has ended, and a cancellation stops it
  within the step it lands in. It never throws into the visit: every
  failure ends as an outcome inside its evidence, which travels beside the
  envelope, keyed by that exact object; nothing uses it yet. Without the
  option nothing attaches and nothing waits. A fixture test drives the real
  scanner over local pages: a timer pixel lists in the window without
  input, a lazy third-party frame, an in-view pixel, two depth beacons and
  a consent tool's vendor list while scrolling, a host contacted before the
  window lists in neither, an overflow lock under a modal is never
  scrolled, a page that snaps back does not move, an endless feed reaches
  the depth limit, a page that fits or scrolls inside its own container has
  nothing to scroll, a page that leaves its site ends the check there, a
  page that changes its own address while scrolling is said to, and a page
  past 1,000 requests keeps the same capture loss with or without the check
  while the check still loads within its own allowance. The same page,
  scanned with and without the check, and with the check made to throw or
  to hang, yields the same report, and the visit's result and measurement
  read the same before and after its own check.
- An "Inspect this connection" visit's own result now shows, at its top,
  what that visit recorded: "Which scripts asked for <address> in this new
  visit", then one line per call-stack group ("2 requests. Scripts on the
  call stack, innermost first: <host> then <host>."), the redirect hops,
  the requests with no call stack, the stacks with no script the visit
  requested and anything a bound kept from being broken down, each in its
  own sentence and in the singular for one; then the caveat ("A call stack
  shows which scripts were running when a request was made, not which one
  decided to make it. Requests made by workers are not observed."), the
  requests the call-stack recording never observed, and the separation
  sentence ("This new visit is a different observation from the report you
  came from, so it can neither confirm nor refute that report's row.") with
  "Open the earlier result" when the link named one. A visit that made no
  request to the address says so instead: "This new visit made no request
  to <address>. Connections can change between visits, so this does not
  show the earlier one did not happen." The approved sentence for requests
  with no call stack said they were started "not by a script"; Chromium
  reports an image a script created exactly as it reports one in the page's
  markup, so the panel says instead: "<n> requests came with no call stack,
  so no script is named; the browser gives none for requests the page's
  HTML starts, nor for images a script creates." The panel renders only from
  the result this tab's own Inspect press received, never on a resume, a
  restore, a reload, a share permalink, an export or paper, and only when
  that result carries evidence for the address asked about, so a result
  without it never reads as one that made no request. The ordinary result
  follows below it unchanged. Once per inspection, a frame after the result
  region takes focus, the panel's top is brought just below the sticky
  strips: on a phone, an inspection that replaced an earlier result arrived
  with the panel above the viewport, since focus scrolls only when none of
  the region is on screen. Focus stays on the result. The coverage
  boundary's causality entry, the README and docs/capabilities.md now say
  an on-demand inspection visit can show call-stack hosts in its immediate
  result only, and that a request it shows with no call stack is not shown
  to have been started without a script. The static smoke stands a
  committed comparison's baseline visit in for a fresh single result: its
  third-party rows, and none of its first-party rows, offer the link with
  the right address, page and share, which the committed permalink, its
  explorer and an opened file never do; following it fills the form with
  Single and Inspect and the line on screen and sends nothing, an edit or a
  comparison ends it, Inspect sends the address, the answer's panel shows
  its groups and its counts at the top of its result, a second inspection
  shows the did-not-recur state, a reload shows none, an unusable
  inspection link is scrubbed, and on a phone an inspection that replaces
  an earlier result arrives with its heading on screen below the sticky
  strips. The Chromium smoke follows an inspection link against the Node
  app's own build, presses nothing, and checks that the API refuses
  malformed inspections, and a version 1 scanner every inspection, before
  any visit.
- Each third-party row of a fresh result's request log now offers "Inspect
  this connection", whose accessible name adds the row's address as the log
  shows it. It is offered on the homepage's own live result and that scan's
  runtime share permalink, decided by the same freshness the Blocker
  follow-up uses, and only where that follow-up's page can be visited again
  (reportNewVisitTarget, gates G3 and G4): never on a committed report, a
  file opened from disk, a comparison built in the archive, a visit that did
  not establish its page, a report from a scanner whose results cannot carry
  an inspection, a first-party row, a row redaction could not publish, or
  paper, where the print stylesheet hides it too. The link is
  `/#scan?url=<page>&inspect=<address>&from=<share report id>`, the address
  being the row's published URL without its query, minted by one function
  the explorer's lazy chunk renders. The scan link parser accepts `inspect`
  beside an address it accepts, never beside a mode, once, and only in the
  shape the redaction pass writes, checked syntactically so the homepage
  bundle reads no public-suffix list; `from` may now sit beside an
  inspection as beside a mode. Anything else refuses the whole link, and
  every link is still scrubbed from the address bar. Following one fills
  the form with the page, selects Single, labels the button "Inspect", and
  shows "Inspecting <address>. A new visit to <page> will record which
  scripts were running when each request to this address was made. The
  details show here only and are not saved." Editing the address or picking
  a comparison ends it, as the back-link's arrival rule does, and putting
  both back restores it. Nothing submits on its own; Turnstile and the rate
  limit apply unchanged. Pressing Inspect sends the address in the scan
  request, and a scanner running durable jobs is refused before the submit
  is claimed, so the browser check is not spent. A unit test walks every
  committed row through the row link's minter, the form's parser and the
  gate's check, and all three agree.
- The scan API now accepts an optional `inspect` field: the published
  address, query dropped, of the connection an "Inspect this connection"
  visit asks about. It is accepted only on a single scan, only as an address
  the redaction pass would leave unchanged, and is refused otherwise before
  quota, DNS or Chromium; it costs one rate-limit token like any single
  scan. It reaches the scanner as a visit option and never the recorded
  payload, so the visit's conditions, methodology and saved report are an
  ordinary single scan's: a test saves an inspected and an ordinary scan of
  the same visit and finds the same bytes apart from the ids each mints, and
  the seven identity constants print byte-identical before and after. The
  evidence travels only in the immediate result, in a new optional
  `inspection` key of the single-report r2 shell's ephemeral block beside the
  screenshot, which persistence, export and the published schema never
  carry; the schema generator's digests are unchanged, every other ephemeral
  key stays refused, and comparison shells take none. That key departs from
  the RFC's section 15.2, which calls its r2 wire-type graph complete; the
  RFC text is unchanged and docs/limitations.md records the divergence, as
  does a comment at the type. An inspection is refused with one sentence of
  its own on a scanner that writes version 1 reports, whose result has no
  ephemeral block: "Inspecting a connection needs a scanner that writes
  revision 2 reports, and this one writes version 1 reports, so no visit was
  made." It is refused with another while scans run as durable jobs, whose
  exact-keyed admission commitment has no place for it, by the browser
  before it mints a credential, by the edge before any capability lookup,
  and by the Node durable preparation instead of being dropped:
  "Inspecting a connection is not available while this scanner runs scans
  as recoverable jobs, so no visit was made." Both are undeclared, so the
  visitor reads the sentence itself. The browser's scan request carries the
  field only when the form hands one over, so every other request is byte
  for byte the one it was. An in-process test runs one inspection through
  the scan API's own execution path, the real scanner over a local fixture
  and the real report store: the immediate result carries the evidence and
  the client's reader accepts it, and the saved share holds none of it.
- A scan visit can now record, for one published address and only when
  asked, which scripts were on the call stack when its requests to that
  address were made: the groundwork for "Inspect this connection". The
  scanner's request attribution session already receives each request's
  synchronous initiator stack; with the new `inspect` visit option its
  existing handler also feeds a recorder, and the page request count it
  already keeps feeds the same recorder, so no session, command, domain or
  browser behavior is added and a visit without the option keeps nothing
  new. Both stop at the visit's evidence boundary. The evidence holds counts,
  published hosts and published addresses only: requests whose published
  address, query dropped, equals the inspected one are counted from the
  page's own request events, a dedicated worker's included; the session's
  observations of the same URLs are joined to them, at most as many as the
  page reported; redirect hops, requests with no stack, and stacks with no
  frame whose address the visit requested as a script or document are
  counted apart; a stack names at most four hosts, innermost first,
  consecutive repeats collapsed, and the addresses of the scripts behind
  them; a sourceURL name counts only when it is an address the visit
  requested; and anything a bound keeps from being broken down is counted
  as not listed. The counts always add up, and a closed validator, built
  without the public-suffix list so a client reader can use it, holds the
  shape and the sum. It travels only beside the visit's envelope, keyed by
  that exact object, so no builder, shadow emission, clone or serialization
  carries it; nothing uses it yet. A fixture test drives the real scanner
  over a local page: a tag's function called by its loader groups as the
  tag host then the loader host, an image in the HTML and an image a
  script created both arrive with no stack (Chromium 153 reports a
  script-created image as the parser's), a self-named script is named only
  when its name is an address the visit requested, a redirect hop counts
  apart, and a worker's fetch counts as unobserved.
- The comparison that "Compare with blocking on" opens now links back to
  the result it came from. The form keeps the earlier result's id while the
  field still holds exactly the address the link put there and the one
  comparison selected is the mode it asked for, the arrival rule the form
  already uses; editing the address or changing the mode ends it, and
  putting both back as the link set them restores it. A scan that starts
  with the connection intact carries it to its result in this tab only, by
  whichever path shows that result in this page load; a reload, another tab,
  an opened file and the scan request itself never carry it, and the form's
  state never holds it. That result, on the homepage only, shows "Open the
  earlier result", a link to the earlier result's share permalink, with one
  sentence: "This comparison and the earlier result are different visits,
  so this pair can neither confirm nor refute what the earlier card
  showed." It sits under the result's header, ahead of its headline, and
  says nothing about the earlier card's numbers, title or level. The link
  resolves as any freshly produced report's share does, on the scan API's
  own origin behind a static build, and nothing shows where that API serves
  no report pages. It renders in the explorer's lazy chunk, never on a
  report page or the printable route, and the print stylesheet hides it.
  Nothing in any saved report, report identity, index, social card or
  permalink changes, so a share permalink of the new comparison shows no
  link back.
- "Compare with blocking on" now names the fresh result it is offered on:
  its link is `/#scan?url=<page>&mode=shields&from=<share report id>`, the
  id of that result's own share, the one its share permalink is addressed
  by. A fresh result without a share, and every report that is not fresh,
  names none, and its link is exactly the one it was; the label and the
  sentence are unchanged. Both boards of a runtime share permalink and the
  homepage's explorer read the id from the same view and the same freshness
  as the page they visit again, through one function, so the permalink's
  two boards name the same share and its client gains no prop. Committed
  report pages are unchanged. The form fills the address and Blocker as
  before and does not use the id yet.
- A scan link that asks for a comparison can now also name the result it
  came from: `#scan?url=<address>&mode=shields&from=<share report id>`. The
  form accepts `from` only beside an address and a mode it accepts, and only
  as one share report id written exactly as that share's own address shows
  it; `from` alone, `from` without a mode, a repeated `from`, an empty one or
  any other value refuses the whole link, address and mode included, as an
  unknown key always has, and every link is still scrubbed from the address
  bar. A link with only an address, or an address and a mode, resolves
  exactly as before. The link builder adds `from` only beside a mode and
  only for a valid id, so it never mints a link the form would refuse, and
  without one the link is exactly the one it was. The fragment never
  reaches a server, and the id is already public in the share's own
  address. Nothing mints it yet, and the form does not use it yet.
- The Chromium smoke now follows a scan link that asks for Blocker against
  the Node scanner's own health, at the start of its UI checks: the form
  must keep the address, select Blocker once health offers it, or keep
  Single when it does not, and send no scan request. It presses nothing and
  scans nothing. The follow-up on a fresh result is not pinned there, since
  that smoke's only scan target, example.com, matches no Brave-list request;
  the static smoke shows it on a fresh result its test answers with a
  committed report.
- A fresh Single or GPC result whose requests matched Brave's lists now
  offers "Compare with blocking on" in its Brave-list card's Look closer
  group, with the sentence that says the scan form opens ready to visit the
  page twice and nothing runs until you press Compare. Following it fills
  the form with the page and Blocker, beside the result, and runs nothing.
  A fresh result is the homepage's own live scan, for as long as the result
  shown is the one that scan returned, and that scan's runtime share
  permalink, whose server decides it from where it read the report and hands
  the same answer to the evidence explorer, so both boards offer the same
  follow-up. A committed report and its explorer, a file opened from disk
  and a comparison built in the archive offer none, and neither the
  printable page nor the PDF renders it. It is built in the explorer's lazy
  chunk and on the server; the homepage's own code gains only the flag that
  says its result is fresh. Committed report pages are unchanged.
- A findings card can now decide a new visit beside its Look closer view: a
  link that opens the scan form ready for a comparison and never runs one.
  The only one minted is on the Brave-list card when requests matched on a
  normal load: "Compare with blocking on. Opens the scan form ready to visit
  this page twice, once simulating Brave's default filter-list blocking;
  nothing runs until you press Compare." It links to
  `/#scan?url=<page>&mode=shields`. The card's branch decides it, never its
  level, and only where the Look closer draft's gates pass: the report is a
  single visit or a GPC comparison, never a Blocker or consent comparison or
  another kind of pair; the visit's request evidence is complete; the visit
  established the requested page; it is not a PageGraph import; and the page
  can be visited again, by its exact route or, where only a shape of the
  route was kept, because the report requested a front page on its own site.
  That front page is visited as itself, so a report that requested
  `https://www.<domain>/` compares `https://www.<domain>/`, not the bare
  domain, and "this page" stays true. Every target comes from one module,
  the one behind the report header's "Scan this site again" and "Scan this
  exact route again" links, which keep their own targets. It is for fresh results
  only, the homepage's own live scan and that scan's runtime share: no
  committed report offers it, since every corpus site already holds newer
  Blocker comparisons, and 52 committed GPC comparisons would offer it if
  they were fresh. Nothing renders it yet.
- A scan link can now ask the form for a comparison mode
  (`#scan?url=<address>&mode=shields`, or `gpc` or `consent`). The form
  keeps the address and holds the mode while the scanner's health is
  pending, when the run modes read "checking", then selects that comparison
  if health offers it, or keeps Single beside the run control's note that
  the comparison is not available. The link never submits anything: nothing
  runs until the visitor presses the button. A link with only an address
  behaves exactly as before. Any other key, a repeated key or any other mode
  refuses the whole link, address included, as an unknown key always has,
  and every link is scrubbed from the address bar as before. Once a link's
  comparison is selected for an address with no evidence on record, a line
  under the field says what the comparison makes: "A new check runs two
  visits in the selected mode and makes a separate share report, kept for
  up to about N days", N from the scanner's own health, or "for a limited
  time" without one. That is the first sentence of the known-site note's
  line, and a corpus site keeps the whole note, history clause included.
  Nothing on the site links with a mode yet.
- The runner's test that every lib test file's process writes to a blocking
  stdout now reads the descriptor's flags from /proc on Linux. Its WASI
  reading never showed O_NONBLOCK on CI's Linux runners or in the container
  build, so the test failed there although both lanes passed; macOS keeps
  the WASI reading.
- A lib test file's last results are no longer dropped when node --test falls
  behind reading them. With --test-force-exit, a file's process could exit
  while results it had written were still queued for node --test, and the
  check that every file's summary arrived then failed the lane, as it did in
  3 of 6 runs of five real files at load 6 to 13. Both lanes now preload the
  runner into every test file's process, where it makes stdout blocking, so a
  write waits for node --test instead of queueing. In 6 runs of those files
  at load 5 to 14, no result was ever left queued, while one of 3 runs
  without the preload came up 4 tests short. A node program that shares a
  test's stdout and writes to it, or a signal during a large write, can still
  leave results queued, and the summary check names the file either way; no
  lib test shares its stdout today. Which tests run, and what each asserts,
  is unchanged.
- The unit test lanes now fail when a lib test file's results stop short.
  node --test passes a file whose process exits 0 on whatever results reached
  it, and with --test-force-exit a file's process can exit before node --test
  has read the results it wrote last. On 2026-10-21 a local gate's parallel
  lane passed with the last 45 of measurement-candidate-binding's 96 results
  missing, and nothing in its log said so; its count read 2,691 tests, 45
  short. Each lane now records, through a second reporter beside spec, the
  summary every file's process writes last, and fails and names any file
  whose summary never arrived. Which tests run, and what each asserts, is
  unchanged.
- The privacy page and the page shown for an unavailable report now say a
  live share can be deleted before about 7 days. They stated only the age,
  but the store keeps the newest 500 shares and deletes older ones to make
  room once each has lasted its minimum survival time, as the README's
  retention note already said. Both numbers come from the store's own
  defaults, now declared side by side, and a test holds the reference
  deployment's configuration to those defaults, since both pages describe
  that deployment.
- While the browser check runs, the note under the scan form now says
  scanning turns on once the check passes. It said "Scan", but the button
  beside the address can read Scan, Compare, Check now or Compare now.
- On the homepage, an address whose site already has evidence now leads with
  that evidence instead of a one-line hint. The note under the field offers
  "Read the report from <date>" as the primary action, keeps "View history",
  names the report's kind in the Run control's own label and gives its
  headline ("Run: Blocker. Lead finding: ..."), and, when the typed host or
  path is not the page that report requested, says which page the evidence
  is for. The one submit button reads "Check now", or "Compare now" in a
  comparison mode, in the secondary style, with every gate it had; a second
  submit control would have duplicated them. A line under the note, which
  also describes the button, says what it does: a new check runs one visit,
  or two for a comparison, in the selected mode and makes a separate share
  report, kept for up to about the number of days the scanner's own health
  reports, or "for a limited time" when it reports none; it is not added to
  the site's history, in the site history page's own words. A visitor who
  followed a site's own "Scan this site again" link keeps the usual primary
  Scan button, with the note, until the field is edited, and a running scan
  keeps it too. An address with no evidence changes nothing.
- The scan form now holds what it needs to say, for a site that already has
  evidence, what reading that evidence gives and what a new check would do
  instead. Each corpus site the form recognizes carries its newest report's
  requested URL, its headline and its run mode, all from the report index;
  the run mode names a report's kind in the Run control's own labels, and a
  temporal or custom comparison gets no kind. The browser reads the share
  retention the scanner itself reports in its health
  (`checks.reportStore.maxAgeDays`), and only as a finite positive number:
  while health is pending, after it fails, and for zero, negative, non-finite,
  non-numeric or missing values it has no number, and nothing falls back to
  the build's default. A value it cannot use never fails the health check
  itself, since the Node scanner reports 0 when its store cannot be built.
  The site history page's sentence about live rescans now comes from one
  shared clause, so the form can say it in the same words. Nothing renders
  differently yet.
- The coverage boundary, the README, the capabilities doc and the request
  attribution map now say what a recorded initiator can stand for beyond a
  loader that was told what to fetch. A script that wraps fetch or
  XMLHttpRequest is credited with every request it relays: 217 committed
  rows in 24 runs credit Datadog's browser agent, among them requests to
  Google Analytics, Amazon Ads, Permutive and Lotame. A script can give
  itself any name with a sourceURL comment, and is credited under that
  name. Requests made by dedicated workers are not observed. The boundary
  and the map's coverage note add the rows the join now refuses, a URL
  requested more times than the scan received an initiator for it, and the
  boundary says that a report made before that rule can show the page's
  initiator on a worker's row, with nothing in its methodology to say
  which rule it was made under. A report adapted from PageGraph keeps its
  map subtitle and coverage note. Report JSON is unchanged. All 1,029
  committed reports draw the map, so each shows the new subtitle in the
  evidence explorer and on the printable page and PDF the scanner serves,
  and 730 of them also show the new coverage note. The static permalink
  does not render the map, since the explorer loads lazily.
- A live scan no longer credits a dedicated worker's request with the
  page's initiator. The initiator join pairs the request log's rows with
  Chromium's initiator reports by URL, and the session it reads sees only
  the page's own target, never a worker's. So when a worker and the page
  requested one URL, both rows published the page's initiator, as the
  fixture test of 2026-10-19 observed. The join now counts every request
  the page reported, kept in the log or not, and claims a URL only when it
  observed no fewer requests for it than the page made and every
  observation names one initiator. Requests the log leaves out are counted
  too, so a reload whose traffic the log excludes cannot stand in for a
  worker's row. Every row of such a URL is now "Not attributed". The
  scanner counts these refusals but does not publish the count. No
  methodology component marks the change, so a report's methodology does
  not say which rule it was made under. The report wire, the public-string
  policy and both r2 normalization identities are unchanged, and so are
  committed reports.
- Report pages now show each findings card's "Look closer" view at the
  foot of the card: the link, which names its card, and the sentence that
  says what it opens. The permalink renders it before any script runs, and
  the evidence explorer renders the same view in the same place. Views
  never print: the printable page and the PDF render none, and a printed
  permalink hides them with the other controls. The cookie card's history
  view needs to know that the site's history lists another report, which
  only the committed corpus can say, so the static export decides it while
  it builds and hands the same answer to the explorer. A report served by
  the scanner itself offers no history view, since there that read would
  cost a first request about 12 seconds. The views live in the explorer's
  lazy chunk, so the homepage's initial JavaScript gains no code; only its
  reference to that chunk is renumbered. The report JSON and the social
  cards are byte-identical, and so is the report index apart from its build
  time. 694 of 1,029 committed reports gain a view.
- Findings cards no longer stop at an explanation and an evidence link.
  Six kinds of card now decide one "Look closer" view each: a link the
  reader could already follow, aimed at fewer rows, with one sentence
  saying what it opens. A view establishes nothing new. It is keyed by its
  card's branch, never by its level, so a severity decision moves none. A
  view of the request log is offered only when its filter keeps a retained
  row on the visit it opens, asked with the log's own predicates, which the
  table and the cards now share. A filtered log over-matches by design, so
  its sentence says "filtered to", never "the requests that carried". The
  bottom line gets no view, and a shared consent framework endpoint gets no
  platform view, since it is not one platform. Counts are committed reports.
  - The typing test's card filters the request log to its first recipient
    (15).
  - The consent-banner card opens its catalog-matched requests, or with no
    tracking-related service the platform's own requests (185 and 4).
  - The listener card moves to the typing test's card, or filters the log
    to a catalogued replay vendor, or to the first script origin in a
    listener's call chain (1, 113 and 401).
  - The policy card that lists companies the policy does not appear to
    name opens the catalog-matched requests (344).
  - The Reject-all card opens that visit's catalog matches (1), as a
    conclusive GPC pair's card does for the visit with the signal (none
    committed).
  - The cookie card opens the site's history, which lists each retained
    report's cookie count, wherever that history holds another report
    (532).
- The scan form no longer says a comparison is unavailable before the
  scanner has answered. Until its health check returned, the published site
  showed "GPC comparison is not available from this scanner" and two "requires
  the Node scanner" lines on first paint, then offered all three a moment
  later; a dynamic build offered them before the scanner could refuse. While
  health is pending the comparison buttons now stay off under one line,
  "Checking which comparisons this scanner offers.", and each mode is offered
  or refused only once health has answered. No report page changes.
- A report's bottom line now says what its own level means. The title had
  two forms over five levels, so 694 committed reports printed "this visit
  has review-worthy signals" under a "Worth checking" (497) or "Context"
  (197) label. Those now read "this visit has signals worth checking" and
  "this visit has signals, none ranked worth checking": Context is an
  observation, neither an all-clear nor review-worthy. "Review-worthy"
  (198), "few review signals" (127) and the cut-short title (4) are
  unchanged, and the bottom line still names no finding. The headline
  banner keeps the headline's own tone on every surface; whether it should
  follow the bottom line waits on the headline and severity decisions.
  694 reports change.
- The scan form now says what a scan does to the page before anyone presses
  Scan. Under the URL field, in the scanner's own words: a single scan is one
  automated, headless Chromium visit from a fixed en-US / UTC profile, with no
  scrolling, clicking or consent interaction; each visit types a made-up test
  value into form fields, never submitting the form, and reads the site's
  privacy policy when it finds one; comparison modes run two visits, and
  consent mode tries to click the banner's Accept all in one and Reject all in
  the other.
  The homepage used to say only that the visit reads "what the page actually
  loaded", and the typing test was disclosed only after submission, under the
  progress bar. The copy is rendered on the server and handed to the form as
  markup, so it adds HTML, not homepage JavaScript. The operator status line
  (rate limits, storage, the comparison list) moves under More options; a
  scanner failure and its Retry status button stay under the field, in a live
  region that is always mounted so the failure is still announced. No report
  page changes.
- A report page now says what was checked and what the visit could not
  see, directly after its bottom line and before any card that counts or
  ranks what the visit recorded. "What was checked" gives the page (the
  requested address, and where the visit landed when that was another
  address: 94 reports, most of them a redirect to another path), when the
  visit ran, the setup (headless Chromium, the recorded window size, en-US
  and UTC, where it ran from, that its network region was not recorded, and
  whether it sent GPC), one visit or two and what they were configured to
  differ in, what the scanner did to the page, and the outcome in plain
  words. The typing test is named from the scanner's own disclosure, and a
  visit without one says no typing was recorded, never that the page had no
  form fields, since a visit that typed into nothing writes no line. A banner
  choice reads as a click only where the consent facts record an activated
  control. "What this visit could not see" names other pages, signed-in
  visitors and other regions, anything that loads after interaction, and
  services the US-biased catalog does not name, each only where every visit
  carries the warning that says so, then each check whose evidence was
  incomplete, linked to its card where the board describes the visit that
  lost it. Apart from the date, these facts appeared only in the evidence
  explorer, about 16,000 px down a phone. The lists follow the verdict
  rather than lead the page, so the headline banner and the bottom line
  keep their place: the identity block above them only loses its
  machine-worded run-quality line, whose "recorded by the scanner" or
  "derived from status and warnings" the receipt already states beside each
  visit's exact quality, and no banner starts lower than it did. Every
  committed report page changes (1,029); 359 of them list incomplete checks.
  The explorer, the printable page and the PDF carry the lists in the same
  place. No report, warning or admitted string changes.
- Three detectors stop reporting more than they measured
  (node-detectors-v19). The privacy-policy cross-check kept an HTML policy
  read the collector cut short, at 400,000 characters or after visiting
  20,000 page nodes, and compared it as the whole policy, so a company the
  policy names past the cut was published as one it does not appear to name
  while the check read as complete. policy-text-cross-check@12 records such a
  read as a failed policy read, with the existing lost policy visit, as a
  policy PDF whose text runs past the limit already was, and compares none of
  it. Read the way the scanner reads them, none of the 313 reference policy
  pages reaches either bound at desktop or phone width: the longest read is
  134,185 characters, and linkedin.com, the nearest to the node bound, has
  about 16,500 nodes. The reader's rule that a stored read within 5% of the
  limit lists no unnamed company now covers only cross-checks before @12 and
  v1 reports, which record no cross-check version, so an r2 @12 read of a
  long policy keeps its omissions. The input probe matched every request
  the page started before the scanner's route had decided on it, so in a
  Brave Shields block simulation it named a recipient whose requests the
  engine had stopped, and the comparison showed no change.
  synthetic-sentinel@6 waits for the route's decisions and leaves out the
  requests the engine stopped. A request the scanner's own guard refused, to
  an address that is not public or could not be verified, at a URL that is not
  HTTP, or past the request budget, still names its recipient: no loss leaves
  the input claim incomplete for it, so leaving it out would read as a
  complete finding that the value stayed. No committed report shows the
  defect: the 11 block-simulation reports with an input detection name
  weather.gov's arcgis host with a retained response each. The CNAME probe
  followed three lookups and reported every chain it cut as a whole one.
  dns-cname-chain@6 follows ten, the bound of the reviewer-side reference, and
  a test pins the two equal; a chain still going at ten names, or one that
  loops, with no tracker among the names followed, is recorded as a failed
  lookup with the existing loss and v1 line, and a tracker found within the
  bound stands as a cloak. Ten lookups over up to ten subdomains is up to
  150 s of DNS at 1.5 s a lookup, which the scan's 45 s deadline still
  bounds; a chain the deadline cuts records the failed-lookup loss as before.
  The wire keeps no chain, so how many reports the hop bound changed cannot
  be counted, and the stopped cname-uncloaking reliability sweep must
  restart on this build. The registry digest moves from `5d13b8ac...b95e` to
  `c6d25284...942d`; no warning or admitted string changes, the
  normalization, methodology and every other producer field are unchanged,
  and the two live `node-v23-detectors-v18` rows are closed to their exact
  literals. Reports already published keep their detector versions.
- Production Health no longer calls a rollout stale when production
  advances while a run is polling. Each run pins the production revision
  when it starts and used to accept a live revision only if it was that one
  or an earlier one, so a newer promotion whose Pages deploy (one to two
  minutes) landed inside the run's six polls failed the run and reopened
  the canonical issue. When both live revisions are reported and the pin is
  inside its rollout budget, the run now re-reads production, and if
  production has fast-forwarded from the pin and both live revisions equal
  or precede it, it reports the rollout as pending with a "Production
  advanced during the probe" warning and leaves the posture checks to the
  runs the newer revision's deploys request. A forked, force-moved or
  unpromoted revision still fails. None of the 13 failed runs among 1,000
  from August 21 to October 20 was this case. Release readiness requires
  this workflow's bytes to match between a durable-jobs soak and its
  candidate, so this lands before any durable-enable candidate.
- A report that records supporting visit pairs is no longer exported as a
  printable page or PDF that leaves them out. Both documents print a
  comparison's two primary visits and say they carry the evidence for every
  recorded visit, but an r2 intervention report can also embed supporting
  pairs, complete replication visits that neither printed. Both now refuse
  that shape: the PDF and the evidence package answer 422 before the render
  limit is charged or a browser starts, the printable page says why and
  links the report and its JSON, and the report hides its printable-version
  and PDF controls. No committed report has supporting pairs and the public
  scanner never records them, though the committed publisher accepts them,
  so no committed report, page or PDF changes.
- Evidence links in a report opened on the home page no longer stop
  working while a scheduled-rescan management link is in the address. The
  scheduled-rescan panel handles a fragment change first and, in the same
  event, puts its retained `#watch=` link back, so the request log, the
  domain table and the evidence switcher, reading the address after it, saw
  the capability instead of the link: a findings link left the request log
  closed and unfiltered, and a comparison link left the switcher on the
  other visit. They now take each link's target from the event and read the
  address only when a report opens. Encrypted watches are off in
  production, so only a hand-made management link reaches this, and report
  pages never show the panel. Client only: no stored report changes.
- Cancelling a scan while Chromium was opening its browsing context no
  longer leaves a whole browser running. The scanner read the cancel as a
  stuck browser, dropped that browser from its cache without closing it and
  launched a new one, so each such cancel held about 150 MB until the
  container restarted; a browser that really was stuck was left running the
  same way. A cancel now keeps the browser, and a stuck one closes once the
  last scan using it finishes. A scan still finishing on a replaced browser
  also dialed the new browser's DevTools port, lost its worker channel and
  reported the page's dedicated workers as unread; each scan now dials its
  own browser. Runtime only: no detector version or stored report changes.
- A burst of saved scans can no longer stop the scanner saving reports for
  a week. The R2 retention listing refused to read more than 1,000 report
  objects, and saving a report prunes first, so once a burst of new shares,
  each exempt from count pruning for 75 minutes, pushed the store past
  1,000, every save, maintenance pass and health probe failed until the
  bucket's 8-day lifecycle rule emptied it. A save that would leave more
  than 936 shares count pruning cannot yet remove, or more than 1,000 report
  objects, is now refused before anything is written, and an async scan job
  reports it as "Scanner is busy. Try again shortly." A listing past 1,000
  reads the oldest 1,000 and leaves the rest for a later pass, so retention
  keeps draining. Reaching the bound takes 1,001 saved scans within 75
  minutes, which the per-client limits and the scanner's throughput leave
  to deliberate abuse. Runtime only: no stored report changes.
- A privacy-policy read that may have stopped at the scanner's
  400,000-character limit no longer lists the observed companies it did not
  find as ones the policy does not appear to name. An HTML read stops at
  that limit, or after visiting 20,000 page nodes, without recording that it
  did, so a company the policy names past that point was never seen. Six
  cvs.com reports from August 7 to September 7, 2026 stored reads of 399,900
  to 400,000 characters and listed 34 omissions across 6 companies, Google
  in every one, although the complete CVS reads of July 21 (28,494
  characters) and September 28 (32,683) name Google. The September 28 read
  leaves the other five unnamed too, but a read that may be cut cannot
  establish that. A stored read within 5% of the limit now says those companies'
  mentions are unknown. This changes the privacy-policy card of 6 of the
  1,029 committed reports and no headline. No stored report changes and the
  withdrawn omissions no longer render, so it takes no corrections event; a
  PDF saved before this change still lists them. A read stopped by the node
  bound can be shorter and still reads as complete, which only a scanner
  change can fix. docs/limitations.md said HTML policy text, like a PDF's,
  was used only when it fit the limit in full; it now says what happens.
- A v1 comparison no longer shows a storage-key delta when either visit's
  storage read was incomplete. The comparison panel took storage from the
  request-count gate, which a v1 storage-snapshot loss leaves open on
  purpose, since it is not request loss. So two abcya.com Shields pairs whose
  storage reads were both cut showed "Storage keys" with no change, empty
  storage change lists and a note that the deltas include every
  observation, beside per-visit tiles that call each snapshot incomplete.
  Storage tiles and lists now also need both visits' storage measurements
  exact, and the panel says why storage is withheld; r2 pairs already gated
  storage this way. This changes the evidence explorer, printable view and
  PDF of 2 of the 1,029 committed reports (20261012-1f2f9090 and
  20261019-aed823a4), none of it in the static export. No stored report
  changes and the withdrawn claim no longer renders, so it takes no
  corrections event; a PDF saved before this change still shows the tile.
- The privacy-policy cross-check no longer reads Walgreens' privacy center
  as the policy (policy-text-cross-check@11, node-detectors-v18). @10
  withholds an unlabeled page with under 3,000 characters of prose that
  links to another policy document, and it counted that prose in the
  page's whole text. walgreens.com's privacy center keeps most of its prose
  in a consent manager's preference center it has not opened and in two
  tabs it has not selected, 7,457 characters in all, so each weekly gallery
  leg read it as the policy and published the companies its cards never
  name as ones the policy does not appear to name. In this change's own
  scans before it, @10 listed 6 to 12 of them, among them Adobe, Google,
  Criteo and Microsoft. Prose is now counted without the page's closed
  panels: a dialog it has not opened (a dialog element, the dialog or
  alertdialog role, or aria-modal) and a tab panel it has not selected, as
  the browser reports whether each renders, read through the same bounded
  collector. A section the page folds in place still counts, as a policy's
  folded text must. A measure of only what the page renders was tried first
  and withheld Cleveland Clinic's policy at a phone's width, where it
  renders 195 of its 37,327 characters of prose. A read that fails or is cut
  short, or that leaves no letter, is measured on the whole text as before.
  Judged by both builds on the same render of each of the 313 reference
  pages, at desktop and phone widths, only Walgreens changes: 935
  characters of prose outside its closed panels, 894 at a phone's width.
  The Guardian, Discover, Capital One and Home Depot stay withheld, and the
  nearest unlabeled page that links to another policy document and is not a
  hub carries 3,463 to 3,755 (EFF's privacy issue page, from render to
  render). Real sites, both builds back to back over two rounds:
  walgreens.com moves from complete to withheld at both widths, the four
  other hubs stay withheld, and lbpost.com, naver.com, Cleveland Clinic and
  the USA TODAY Network policy (augusta.com, usatoday.com) read the same
  policies under both wherever the scan's proxy budget let both visits reach
  them. The registry digest moves from `40b13770...b9f8` to
  `5d13b8ac...b95e`; the normalization, methodology and every other producer
  field are unchanged, and the two live `node-v22-detectors-v17` rows are
  closed to their exact literals. Reports already published keep their
  detector version, and the reports `SBL-CORR-2026-005` cites keep its
  notice.
- The Browser Behavior Signals list in the evidence explorer prints the
  hosts a synthetic test value reached with "*" for a hidden subdomain
  label, as the keystroke card does. It printed the stored token, as in
  "typed value was sent to {label}.arcgis.com as plain, from 2 fields". The
  fingerprinting card quotes the same evidence lines only for its canvas,
  WebGL, audio and WebRTC heuristics, so no card changes. A test fails on
  any sanitizer token in that list on any visit of a committed report. This
  changes the rendered text of 15 of the 1,029 committed reports at
  d437e995, all of it in this list, which renders in the browser and not in
  the static export. No stored report changes and no claim is corrected, so
  it takes no corrections event.
- No findings-card sentence runs past 30 words, the length of the bottom-line
  card's method sentence. The 35-word pass left sentences of 31 to 35 words:
  the Brave Shields filter-list card's detail on 1,023 of the 1,029 committed
  reports, the privacy-policy card's leads where no policy text was compared
  and its lead naming companies the policy does not, and the consent-banner
  and Brave-list comparison caveats. Each is now two sentences, and every
  clause, caveat and count still renders. A card that names a list now names
  it in sentences of its own, so no list can carry a sentence past the limit:
  each DNS alias, pixel and unclassified service has a sentence, and the
  keystroke card's lead states how many domains received the test value, then
  names them and the encodings. A sentence that follows a list no longer opens
  with a numeral. Branches no committed report reaches were split too, among
  them a consent framework endpoint with no tracker, a GPC pair that moved
  every metric and a listener lead naming all ten event categories. The
  consent card's Reject-all lead names that visit as its title does, so three
  long service names that recorded no response stay within the limit. The test
  that builds every committed report's cards fails on any sentence over 30
  words, and fixtures built from the catalog's longest names, every keystroke
  encoding and every identifier label hold each list template under it. This
  changes the rendered text of 1,023 of the 1,029 committed reports at
  7ceac3be. No stored report changes and no claim is corrected, so it takes no
  corrections event.
- A comparison report's permalink says which visit ran first, or that the
  order was not recorded, before the evidence explorer opens and without
  JavaScript. The line added for the comparison section reached a permalink
  only once the explorer opened; the compact page a shared link opens showed
  each visit's start time only inside the collapsed provenance receipt. The
  same line, with the same methodology link when no order was recorded, now
  follows the summary's caveat, and the comparison section takes it over
  when the explorer opens, so the page states it once either way. The static
  smoke checks a recorded and an unrecorded order without JavaScript, and
  that the explorer then states the same words. This changes the rendered
  text of 1,028 of the 1,029 committed reports at a0223c82, the commit
  that last changed the corpus: 1,008 with a recorded order and 20 without
  one. No stored report changes and no claim is corrected, so it takes no
  corrections event.
- Findings cards print a hidden part of a host or URL the way the evidence
  tables do: "*" for a subdomain label and one ellipsis for path segments.
  The sanitizer stores these as "{label}", "{seg}" and "{n}", and several
  cards printed the stored form, as in "{label}.nike.com →
  {label}.{label}.omtrdc.net" in the DNS-alias evidence. The privacy-policy
  evidence, the consent platform's host and the hosts a synthetic test value
  reached did the same. So did the reasons an inconclusive comparison lists
  on its card and in the comparison panel. Where two compared pages differ
  only in hidden parts, a reason now says both are shown as one URL rather
  than printing it twice. The stored reports and their JSON keep the tokens.
  A test fails on any sanitizer token in a committed report's card text or
  comparison reasons. This changes the rendered text of 526 of the 1,029
  committed reports at d920a91d. No stored report changes and no claim is
  corrected, so it takes no corrections event.
- Findings cards no longer carry sentences of up to 62 words. On 970 of the
  1,029 committed reports, at least one card sentence ran past 35 words. Some
  cards joined whole sentences into one list. On 103 reports an inconclusive
  comparison's reasons read "...never counts as matching., The baseline
  visit ... totals. and The variant visit ...". The fingerprinting and
  listener cards ran each detection's evidence together, so the numbers no
  longer said which heuristic they belonged to. Other cards held a caveat in
  a parenthetical or after a semicolon, as in the Brave-list blocking card's
  lead of up to 47 words. Each long sentence is now two or more shorter
  ones, and nothing is dropped: every clause, caveat and count still
  renders, and each evidence sentence names its detection. Branches no
  committed report reaches were split too, among them a one-sided consent
  pair, a privacy policy contradicted on two counts or on advertising
  identifiers, and a cut-short visit with several recorded causes. A test
  builds every committed report's cards the way its permalink does. It fails
  on any sentence over 35 words or any list of joined sentences. This
  changes the rendered text of 1,007 of the 1,029 committed reports at
  a2f4077a. No stored report changes and no claim is corrected, so it takes
  no corrections event.
- A report's header names its format in plain words. The chip beside a v1
  report's eyebrow read "v1 schema · facts legacy-derived · descriptive
  report", which names a wire generation and a derivation step rather than
  what they mean for a reader. It now reads "Older format: some facts
  reconstructed, descriptive only", and an r1 report's reads "Earlier format:
  limited, descriptive only" (no committed report is r1). Both still state
  what RFC 10.1 and 15.7 require the interface to carry, and the precise label
  stays in the evidence receipt's and the methodology block's Schema fields. A
  current r2 report has no caveat to state, so its header carries no chip.
  This changes the rendered header of all 1,029 committed reports at a1686ebe
  (966 v1 and 63 r2); no stored report changes.
- The bottom-line card's method sentence no longer runs 88 words. On 880
  committed reports one sentence named the report's exact schema,
  methodology, tracker-catalog, ServiceRole-taxonomy, metric-contract,
  producer and Global Privacy Control cohort, then the corpus coverage in a
  parenthetical. The card keeps the not-a-random-sample caveat and the
  per-card denominator, and its longest sentence is now 30 words. The cohort
  and its coverage are stated in the methodology block and, on a report
  permalink, whose methodology block waits for the evidence explorer, in the
  evidence receipt. Both read them from the card, so they appear exactly when
  the card ranks against a cohort. This changes the rendered text of 880 of
  the 1,029 committed reports at a1686ebe and drops nothing from the page; no
  stored report changes.
- The unavailable-report page renders in the site shell, so a reader who
  follows an expired or mistyped link keeps the navigation, the footer and
  the skip link, and it says that shared links to live scan reports expire
  after about 7 days on the reference deployment. The number comes from
  lib/report-share-retention.ts, which the report store uses as its default
  and the privacy page now reads instead of a hand copy. No report changes.
- The printable report fits a phone screen. Its guide printed the
  64-character correction-context SHA-256 as unbreakable inline code, which
  made /reports/<id>/print/ 513 px wide at a 375 px viewport; the print-only
  CSS was not the cause. The guide's digests now wrap on screen only, and the
  Chromium smoke checks the printable page at phone width. Exporter PDFs of
  four committed reports (175 pages) render identical page images at 150 dpi
  with and without the rule. No report changes.
- Every comparison report now says which visit ran first, or that the order
  was not recorded. The order was recorded but easy to miss or not shown at
  all: a v1 report carried it as one row among its measurement caveats, and
  the r2 `experiment.order` field rendered nowhere. The comparison section now states it beside the two
  visits' durations, in the scan result, the evidence explorer, the printed
  report and the PDF. "Ran first" names the visit the record names; a
  comparison captured before order randomization shipped recorded no order,
  so it reads "order not recorded" with the visit whose recorded start time
  is earlier, and links the methodology page. A before/after pair states no
  order, because its labels already give it. Every recorded order agrees with
  its visits' start times, which a new corpus test checks. This changes the
  rendered text of 1,028 of the 1,029 committed reports at a1686ebe (861 v1
  and 63 r2 comparisons with a recorded order, and 104 without one; the
  corpus holds no before/after pair). No stored report changes and no claim
  is corrected, so it takes no corrections event. docs/limitations.md and the
  methodology page describe the line.
- An absence card no longer leads with the absence its title withholds.
  When a card's absence claim was not established (evidence collection was
  cut short, a detector did not finish, or the visit returned an error or
  block page), its title said so, as in "Incomplete evidence: No Google
  Analytics observed in retained evidence before collection stopped", while
  its lead stated the absence as fact: "This visit did not contact Google
  Analytics." The title and lead of the seven absence cards now come from
  one eligibility decision, the lead confines the absence to the retained
  evidence ("No Google Analytics request appears in the retained
  evidence."), and the report-consistency gate checks the recorded choice
  against the claim's fact gate on every committed report. This changes the
  rendered text of 222 of the 1,029 committed reports at c45a9fba; no stored
  report changes.
- The input probe's loss notes no longer say a readback "did not finish".
  The `keystroke-probe-capture` count mixes request rows the probe could not
  read in full with candidate fields it skipped (offscreen, an unsupported
  type, past its field bound) or could not finish testing, so its note now
  names both causes, and the `keystroke-probe` note says the probe did not
  complete its test. The rendered notes of 8 committed reports change; no
  stored report changes. docs/limitations.md now also says that hidden and
  zero-size fields are never probe candidates.
- CSV exports neutralize a formula character that follows a semicolon or a
  tab, past any spaces or quotes, as they already did for a leading one.
  Excel opens a .csv with the locale's list separator, a semicolon in much of
  Europe, so "ok;=HYPERLINK(1)" became a field beginning "=HYPERLINK(1)".
  No committed export changes.
- A dedicated Web Worker that ends before the scanner can tie it to its
  document, having recorded nothing, no longer marks the visit's
  fingerprinting evidence incomplete (fingerprint-observer@9,
  node-detectors-v17). A worker's evidence is credited to the visit only when
  the worker, still running, answers a command sent after the page's frame
  tree came back; on a busy news page that tree comes back hundreds of
  milliseconds late, and a blob worker that runs one job and ends within a
  second is gone by then. Through @8 every such worker was an unread realm:
  the report carried the Web Workers line, a fingerprinting capture loss and
  a partial detector. In the October news sweep 41 of 500 reports carry the
  line. On 2026-10-18 a build that logs every worker's readout made 54
  visits to those sites and four others, and the line came from two causes
  alone: 45 workers on 19 visits that ended before they could vouch for their
  owner, every one of which had recorded no call at all, and shared workers
  on 6 visits (a blob SharedWorker on abc10.com and on a wthr.com frame, and
  AdScore's `js.ad-score.com` on thehour.com, lifezette.com and
  theintelligencer.com), which are never instrumented and still mark the
  evidence incomplete. A worker read in full whose document can be shown
  neither current nor replaced now counts as no realm when its whole
  snapshot records nothing, and stays one unread realm, its evidence never
  credited, when it records anything. In before and after scans of 14 sites
  the same hour, the line fell from 15 of 27 visits to 5 of 28, all 5 on
  abc10.com, lifezette.com or thehour.com, whose logged visits started a
  shared worker. The registry digest moves from `fe7a02dd...c129` to
  `40b13770...b9f8`; the normalization, methodology and every other producer
  field are unchanged, and the `node-v21-detectors-v16` rows are closed to
  their exact literals. Reports already published keep their detector
  version.
- The fingerprint observer no longer reads a frame's own deep framework code
  as unattributable listener registrations (fingerprint-observer@8,
  node-detectors-v16). A registration whose script is not the running one is
  attributed from its call stack, which the observer captured 64 frames deep;
  a capture that filled with no third-party frame counted the frame as lost,
  withheld its session-recording and input-monitoring findings and marked the
  visit's fingerprinting evidence incomplete. In the October news sweep that
  happened on 30 of 500 reports. On the 11 of those sites revisited two weeks
  later, the registrant was the lost frame's own code (React 19's commit
  traversal in Next.js pages, YouTube's embedded player, Sourcepoint's Preact
  privacy manager and an Acast player), registering 67 to 275 frames below
  its task with no third-party frame anywhere in the chain; markers seen only
  in listener-line reports (a YouTube embed, Hearst's platform scripts, a
  Sourcepoint frame) place the other 19 with them. On thehour.com the
  withheld top frame held 20 third-party origins on the session-recording
  list and 11 on the input-monitoring list. A capture that fills its 64 frames with no
  third-party frame is now taken once more, 512 frames deep: a chain that ends
  inside it reads as the frame's own registration, or as its third-party
  registrant when one sits past frame 64, and a chain that fills 512 frames
  still bounds the frame's listener attribution. A registration the first
  capture attributes keeps exactly that capture's answer, and a page that
  keeps the second capture from going deeper stays bounded, never unreadable.
  Rescanned on 2026-10-18, thehour.com and myplainview.com published their
  top frames' session-recording (17 to 21 origins) and input-monitoring (10
  to 13) findings, and attn.com, colorlines.com, kxxv.com and
  dailynorthwestern.com moved from a partial detector to complete.
  The registry digest moves from `940c0c9e...59e0` to `fe7a02dd...c129`; the
  normalization, methodology and every other producer field are unchanged,
  and the `node-v20-detectors-v15` rows are closed to their exact literals.
  Reports already published keep their detector version.
- The fingerprint observer no longer discards a whole frame when one of its
  canvas or font-measurement bounds overflows (fingerprint-observer@7,
  node-detectors-v15). Through @6 more than 128 distinct strings measured with
  `measureText`, more than 128 fonts, more than 256 canvases, more than 256
  distinct characters drawn on one canvas, or a drawn or measured string or
  font longer than 4,096 characters nulled the frame's snapshot, and the
  report published no fingerprint call or finding from that frame. Taboola's
  recommendation widget fits its headlines by measuring every character and
  character pair in the widget's fonts (1,482 to 4,993 calls on four news
  pages across three of its publisher networks). In the October news sweep
  all 121 pages that rendered the widget lost a frame, against 1 of the other
  379; on the four pages rescanned it was the main frame, and abc10.com's
  held a canvas fingerprinting and an offline audio fingerprinting finding
  the report omitted. An
  overflowed bound now withholds only the finding it limits (the
  canvas-fingerprinting finding for the canvas bounds, the canvas-font
  finding for the measurement bounds); the frame's other findings and every
  API call count publish, the fingerprinting family stays censored and the
  detector partial, and v1 reports carry one of two new lines saying which
  finding is incomplete. The canvas-font finding is never published from
  overflowed measurements: making the frames readable without that rule
  would have reported canvas font fingerprinting on every widget page from
  text layout. A dedicated worker that overflows a bound stays unread, as
  before. The two admitted lines widen the public-string policy (digest
  `344fdfdf...1563` to `bc719d41...844e`); the outgoing Node and PageGraph
  normalizations stay readable as superseded identities, and the
  `node-v19-detectors-v14` rows and `pagegraph-v4-tldts7416-active` are
  closed to their exact literals. Reports already published keep their
  detector version.
- The privacy-policy cross-check no longer reads a privacy hub as the policy
  (policy-text-cross-check@10, node-detectors-v14). A site's policy link can
  lead to a landing page whose policy is on another page it links to:
  theguardian.com's reaches /info/privacy, link cards around no prose, and
  its September report's policy card listed nine companies the policy does
  not name, among them The Trade Desk, LiveRamp, Criteo and Comscore, all
  four named at /help/privacy-policy. Rendering every page the committed
  corpus and the October news sweep read as a policy found five such hubs
  (the Guardian, Discover, Capital One, Home Depot, Walgreens), all in the
  committed corpus. At a0223c82, 56 of its reports read one as the policy
  and 52 of them still show an omission card; those cards list 245
  omissions in all, 100 of them companies the site's own policy names.
  None of the 238 sweep reports that could be
  classified read a hub. A read is now withheld (failed/`load-failed` with a
  `policy-visit` drop) when its title and h1 headings name no policy,
  notice, statement, terms or practices, its text carries under 3,000
  characters of prose sentences, and it links to another document the
  selector would read as the site's policy. The policy-page link search
  leaves out links into the page itself, which filled its twelve candidates
  on Discover's privacy center. Over the same pages this withholds the
  Guardian, Discover, Capital One and Home Depot and no policy: unlabeled
  policies that link to another policy document carry 37,327 (Cleveland
  Clinic) or 50,424 (every USA TODAY Network page) characters of prose, and
  short ones call themselves policies. Walgreens' privacy center, whose
  cards hide 7,457 characters of dialog prose, is still read. The linked
  page is not read in place of a hub: Home Depot's links first to a summary.
  Only a page whose letters are mostly Latin script is judged, since the
  prose measure reads no other script, and a link to the page itself over
  http or on its www host is the same document. Both were added before this
  version was first published, after it withheld naver.com's
  34,003-character Korean policy, which policy-text-cross-check@9 had read.
  Stored reports are unchanged.
- `SBL-CORR-2026-005`, a reviewed clarification (active), names the 52
  committed reports at a0223c82 whose privacy-policy card lists companies
  the policy does not appear to name from a privacy hub read; its record is
  https://sitebehavior.org/corrections/policy-hub-reads/. The claim is wrong
  and still renders, which docs/corrections-ledger.md says takes an event.
  The cards render unchanged, and the clarification becomes each report's
  current notice in its subhead, share text, social card and site feed, in
  place of `SBL-CORR-2026-001` on 22 reports and `SBL-CORR-2026-002` on 6.
  Every cited report is retention-pinned, and the 24 that no earlier event
  cited now refuse temporal comparison. Two of the 52 are privacy
  replacements, which the event names through their removed originals, the
  only form the ledger accepts. No stored report, corpus statistic or
  manifest changes.
- The privacy-policy cross-check no longer publishes a page shell as the
  policy (policy-text-cross-check@9, node-detectors-v13). The read waited a
  fixed second after DOMContentLoaded, so a client-rendered policy (a
  OneTrust privacy notice fetches its text over three requests) was read
  before it arrived, and the scan proxy's shared traffic budget, once spent
  by the scanned page, refused the policy page's requests. In the October
  news sweep, 19 USA TODAY Network reports published 688 characters of
  navigation as the policy, listing every observed tracker as one the policy
  does not name, beside a 62,512-character policy that names Google and
  Facebook; 52 more failed in about 90 ms, published as a policy that
  failed to load, consistent with the proxy refusing the policy's own host
  (a rescan of press-citizen.com recorded exactly that `resource-limit`
  refusal of its cm. host). The read now also waits,
  within the scan budget and at most 4 s, for the policy page's network to
  go quiet, which adds up to about 3 s to a scan whose policy page never
  does; withholds a read under 3,000 characters taken while a document,
  script or data request was still open, or after the proxy refused or cut
  short a request during the visit; and skips the visit as
  `budget-unavailable` with a `policy-visit` cap loss when the proxy would
  refuse the policy document itself. A long read stands even while tracking
  or chat fetches stay open, and a capped proxy that can still reach the
  policy's host reads it (24 such sweep visits read full policies).
- Reports from those earlier cross-checks no longer publish an omission or
  a "policy read" result from a read under 3,000 characters: the policy card
  says the cross-check was not established, as it already did for a policy
  link that led to the homepage. No stored report changes. At c45a9fba this
  withdraws 21 "does not appear to name" cards (Khan Academy's 612-character
  read named Google as unnamed; its policy names it) and 12 "made no
  statement this scan can check" cards, one per report. It takes no
  corrections-ledger event because it only withdraws a claim, which
  docs/corrections-ledger.md now states; docs/limitations.md describes the
  rule.
- The reassuring severity badge reads "Not flagged" instead of "Nothing
  observed", which sat above cards that report what was observed, such as
  "Google Analytics present, no remarketing signal".
- While the browser check runs, the scan field names the note that says why
  Scan is off: the button is disabled and takes no focus, so pressing Enter
  in the field was silent for a keyboard or screen-reader user. Each
  directory category chip names its count as sites ("Banking & money 9
  sites").
- A request, cookie or CNAME alias on a deep subdomain no longer leaves a
  finished scan unpublishable. Generalizing short labels lengthened a valid
  253-character host past the managed reader's hostname cap, and from 17
  generalized labels the re-read refused the host as invalid, so the bundle
  failed as `report-resource-limit` (a cause-less 500) or
  `redaction-not-idempotent`. Hosts that fit before are unchanged.
- The managed reader reads the sanitizer's two code-point caps (policy
  quotes, warnings) in code points, so a quote of emoji or CJK Extension B
  text with a scrubbed address no longer refuses its report; and a
  resource-limit refusal names the limit and path it broke in the server
  log.
- Security: the container build turns off Next's unused image optimizer,
  whose `/_next/image` route rendered a report's print page per request
  outside the report-read quota; the transport reader unwraps exactly one
  job envelope, so a doubly wrapped import cannot skip the per-family caps;
  a consent result naming an `Object.prototype` member is refused instead of
  throwing; and a Turnstile transport failure answers with a fixed sentence,
  logging the transport text.
- Security: next moves to 16.3.8, the sharp override to 0.35.5 and
  source-map-js to 1.2.2, past GHSA-cjq9-62q9-8jv4 (CVE-2026-94483, high,
  server-side request forgery in Image Optimization) and five moderate or
  low Next.js advisories fixed in the same release, GHSA-wq5f-xc86-pv6w
  (high, bundled librsvg) and GHSA-68fv-2mgg-jv7q (CVE-2026-93749, high,
  event-loop denial of service through postcss's source maps), which made
  main CI's `npm audit` and both Trivy scans fail at `ab164b80`. next stays
  on the 16.3 line, and no other package changes version except next's and
  sharp's platform binaries and @next/env. No measurement identity moves.
- Five scan refusals that reached the visitor without a declared cause now
  carry one, with their own notice: a host lookup that ran past its 5 s
  deadline (`host-lookup-timeout`, 503, worded to blame neither the address
  nor the site; the scanner's direct entrypoint, which called the same
  timeout `target-unreachable`, now declares it too), a public-suffix host
  (`public-suffix-target`, 400), a token-shaped tenant under a private suffix
  (`generalized-tenant-target`, 400), a host with more than 64 addresses
  (`address-fanout-target`, 400), and a finished r2 report the scanner
  withheld because its own content is not a fixed point of redaction
  (`report-redaction-unstable`, 500; this was the generic "could not
  complete" error, and the reason still goes to the server log). The same
  refusal produced by the build on every report alike (a normalization
  identity or redaction version the reader cannot read, an exception in the
  sanitizer), every other persistence refusal, and a resolver failure such
  as `EAI_AGAIN` still have no declared cause. The synchronous scan route
  carries the cause; a scan job, durable or in-process, records only a
  message, so its failed status carries the declared refusal's sentence and
  no cause. A page built before this change renders the server's own
  sentence for the new causes, as for any unknown cause.
- A visit whose requested address, or the address its redirects ended on,
  has no name an r2 report can carry now declares `unnameable-subject-target`
  (400) with its own notice. An IP literal or a public suffix there was the
  builder's generic 500, and a generalized tenant was refused at persistence
  as a redaction failure; nothing is published in either case, as before.
- A scan budget that runs out in the scanner's own setup (browser, Shields
  engine, scan proxy, context and page), before the page is requested, now
  declares `service-error` (503) instead of `page-load-timeout`, whose notice
  told the visitor the page was slow; so does a navigation that times out
  inside a window the setup cut below the 30-second navigation timeout.
  Both sentences keep the phrase the featured-scan retry recognizes.
- A failed page load the scanner can attribute to the site now declares
  `page-load-failed` (502) with its own notice: Chromium named a network
  error from the site's side (TLS, HTTP, a refused, reset or timed-out
  connection), and the scan proxy recorded only refusals it reads as the
  site's answer on the target or a redirect hop. A refused, reset or
  timed-out upstream connection is read that way although the network
  between, or an outage of the scanner's own egress, produces the same.
  Every other navigation failure stays a cause-less 502, and its sentence
  no longer blames the site: the proxy's resolver failure, traffic bound or
  a socket error the scanner's own host raised (`EMFILE`, `ENOBUFS`,
  `EADDRNOTAVAIL` and the like, now recorded apart from the site's upstream
  failure) on the navigation, any proxy budget refusal during the visit, a
  full proxy block record, Chromium's generic or machine-side network
  errors (`ERR_FAILED`, `ERR_NETWORK_CHANGED`, `ERR_NAME_NOT_RESOLVED` and
  the like), the scanner's own route abort, a browser that closed. The scan
  proxy records the resolver's authoritative no-such-name (`ENOTFOUND`,
  `ENODATA`, or an empty answer) as `name-not-found`, apart from other
  resolution failures, the reading the scan target check already gave it.
  The featured-corpus refresh's failure taxonomy, which reads the sentence,
  now counts the cause-less navigation failure against the scanner (an
  unrecognized failure) instead of excusing it as a site that refused an
  automated visit, and retries it once as transient, since its sentence
  advises trying again shortly. Only the failure attributed to the site
  still leaves the scanner's success-rate denominator.
- A page address the site answers with a file to download (an attachment,
  or a PDF, which headless Chromium does not render) now declares
  `page-is-download` (422) with its own notice and no retry advice. It was
  the cause-less 502 that said the site may be down, unreachable, or
  blocking automated visits, although the site had answered. The featured
  refresh counts it against the scanner and never retries it.
- When the page route's own re-check of the navigation's host, made
  seconds after the scan gate's, refuses it as private, unresolvable, past
  its lookup deadline, or with too many addresses, the scan now ends with
  the gate's own declared refusal (`private-target`, `target-unreachable`,
  `host-lookup-timeout` or `address-fanout-target`) instead of the cause-less
  502 that said the site may be down, unreachable, or blocking automated
  visits. A resolver failure on that re-check stays a cause-less 502, with
  the sentence that blames neither side.
- A scan whose privacy-policy link read threw before any policy visit, for a
  reason other than the scan budget, no longer fails to publish on r2. The
  scanner records that as a failed policy detector with no policy phase, which
  the detector obligations admit, and the builder had refused it; the built
  report now persists and reads back like any other.
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

### OffscreenCanvas and Web Workers

- The fingerprint observer now reads OffscreenCanvas 2D work in the page.
  Text drawing, `drawImage`, `getImageData` and `measureText` on an
  OffscreenCanvas 2D context feed the canvas readback and font-probing
  heuristics with the same thresholds as a page canvas, and page and offscreen
  canvases share the one 256-canvas tracking cap. An export through
  `convertToBlob` is recorded as its own API, `canvas.convertToBlob`, only when
  its promise fulfills, never as `canvas.toBlob`, so an export still pending
  when the visit's evidence is collected is not recorded. Text drawn offscreen
  is traced into another canvas only through `drawImage`, including
  `drawImage` of a bitmap made by `transferToImageBitmap` or
  `createImageBitmap`, and a page canvas whose control moved to an
  OffscreenCanvas with `transferControlToOffscreen` is read as showing that
  OffscreenCanvas's text. Any other route, such as an ImageBitmap handed to a
  `bitmaprenderer` context or a pattern made with `createPattern`, is not
  traced, for either kind of canvas. Before this, a page that
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
- Every arm now opens the scanner's DevTools channel to the measured page and
  holds each dedicated worker, workers started by other workers included,
  paused before its first statement while the arm's installers run in order,
  then resumes it once. Only the GPC arm used to open this channel. Its
  installer is unchanged: it still installs and reads back the signal inside
  each worker first in the pause, and its accounting and disclosure are the
  same. Every arm then installs the fingerprint observer in the same pause
  (next item). Playwright already holds every worker paused until its own
  setup finishes, so this lengthens an existing pause rather than adding the
  first one, but the lengthening is a change to the visit in every arm,
  baseline included. In the design's local measurements of a prototype of
  this install (one macOS machine, headless Chromium 153, before the install
  landed), a dedicated worker's start took 3 to 6 ms longer than under
  Playwright alone, a burst of eight workers 7 to 8 ms longer, and each
  wrapped call inside a worker 0.6 to 1.5 microseconds longer. A worker whose
  script arrives late pays the same, because the pause comes after the fetch.
  The pause waits only for the installs on the worker's own session: nothing
  answered on the page's main thread holds it, so a page busy in a long task,
  or waiting on a pending navigation, does not hold its workers for that
  time. The design measured on idle pages only.
  The GPC arm still pays about 0.4 ms per worker more than the others for its
  own handshake, now small beside the install every arm pays; what grows is
  every arm's distance from an ordinary visit. A visit whose channel cannot
  be established still proceeds without it, as the GPC arm already did.
- In every arm, each dedicated worker now gets the page's own fingerprint
  observer, the same function with the same wrappers and heuristics, installed
  in the pause above before the worker's first statement. The install runs
  where a read of `self.location` or a WebGL context creation would crash the
  renderer, so the observer never does either in a worker, and a real-Chromium
  test installs it into paused workers of nine shapes, including ones whose
  script 404s, fails an import or fails to parse, and fails on a crash.
- Canvas, font and WebGL work inside each dedicated worker now reaches the
  report, in every arm, read back at the same two moments as the page's own
  evidence: the passive boundary and the final state read. A worker has no
  read surface. In its pause the scanner adds a DevTools binding that the
  observer captures and deletes from the worker's global before the worker's
  first statement, and the worker streams over it: the first recording of a
  task sends "open" at once, and the task's microtask checkpoint sends the
  worker's whole cumulative snapshot. Delivery can lag the worker by seconds
  when emissions queue up, so a read of a running worker first sends it a
  DevTools query that it answers on its own thread, between two statements
  even inside a long task or an `Atomics.wait`, and whose answer arrives
  behind everything the worker sent before answering. The worker's state is
  its last word when that answer arrives. A worker whose last word then is
  "open" is still inside a task, and the read waits up to half a second in all
  for the answers and for that task's snapshot, rather than taking the state
  from before the task; a worker without either by then is unread, never read
  at an older state. Each worker's snapshot is normalized and merged by the
  same functions as a frame's, once per worker, so nothing is counted twice,
  and heuristics apply per worker as they do per frame. A worker is credited
  only while its document is current. Its owner frame and loader are read
  from the page's frame tree beside the install, never holding the worker;
  since that tree is answered on the page's main thread, possibly only after
  a pending navigation has committed, a loader counts as the owner's only
  when the worker itself answers a DevTools query sent after the tree
  arrived, which a worker whose document was replaced no longer does. Each
  read then counts a worker, attached or gone, only if that document is in
  the page's frames read at the moment of the read, so an interstitial that
  fingerprints in a worker and then navigates to the site is not credited to
  the site, and a frame that navigates while the read is still waiting on
  another worker does not take back a worker its document had at that moment.
  That holds whatever state the navigation left the worker's stream in: a
  busy worker it ended mid-task is excluded with its document, not counted
  unread. A worker whose evidence cannot be read in full (its install failed,
  it was still mid-task or its evidence was still queued when the wait ended,
  its stream broke, the DevTools channel went away while it ran, its owner
  document could not be recorded or the worker could not vouch for it, or the
  browser reported it and the channel never attached it) is an unread realm
  (next item). A worker a document starts while its own navigation is
  pending is one of these: its owner can only be read after the commit, when
  the worker has gone, so it is neither credited to the next document nor
  excluded.
- An unread worker realm now marks the visit's fingerprinting evidence
  incomplete, never clean. It adds to the existing `fingerprinting` capture
  loss under the existing `fingerprint-observer` detail, whose count is now
  the observer realms (frames and workers) whose evidence is incomplete, at
  the read where it was unread, and the detector reads partial, never failed,
  when every frame was read. A new fixed warning says so on v1: "The
  fingerprint observer could not read one or more Web Workers the page
  started, so fingerprint-like API calls and heuristics for this visit are
  incomplete." Neither existing observer line is true of a worker (one says a
  frame was not read, the other that every frame was), so the new line stands
  beside them, and it follows both reads: a worker unread only at the passive
  boundary, which r2 records as that boundary's loss, still carries it, so
  v1 withholds what r2 withholds. v1 readers censor the fingerprinting and
  detector-output families for it exactly as for the frame line, and the
  reader notes on both wires say which loss it was, the frame line first,
  then the worker line, then the listener line. A page's `terminate()` costs
  evidence only when a read falls inside it: Chromium lets the worker's task
  run for about two seconds and still delivers its last snapshot as it ends
  the worker, so a worker terminated well before a read is read in full.
- A shared worker the page starts now marks the visit's fingerprinting
  evidence incomplete, in every arm: the owner's call is that a page that ran
  code in a realm the observer cannot see never reads clean. The observer is
  not installed in shared workers (Chromium does not attach them to a
  page-scoped session), so the scanner's DevTools channel watches for them
  instead, with browser-level target discovery filtered to shared workers of
  the scan's own browser context, which neither attaches nor pauses them.
  Each one counts as one unread realm for the whole visit, with the worker
  line above. Discovery rides the same channel, so on a visit whose channel is
  unavailable no shared worker is seen; the channel is established only with
  discovery armed, so it never holds dedicated workers without it. In a
  consent comparison, r2 places fingerprint detections and call counts
  before or after the click only when the read just before the click covered
  every realm, so a shared worker the page started by then, like a frame or
  a dedicated worker unread at that moment, withholds every r2 fingerprint
  detection and call count of that visit, the page's own included; v1, which
  has no phases, keeps them. A shared worker started after the click marks
  the evidence incomplete without withholding them.
- The coverage boundary entry for OffscreenCanvas 2D work is now
  `cross-realm-canvas`, and covers what stays unobserved: canvas and font
  work split across the page and a worker (text drawn in a worker and read
  from an image the page receives, or drawn by a worker on a canvas the page
  transferred to it and exported by the page), and shared workers and
  worklets. It says that a dedicated worker whose evidence cannot be read in
  full, and a shared worker the scanner sees start, mark the visit's evidence
  incomplete rather than clean, and that a visit without the DevTools
  connection cannot see a shared worker start. It still
  names the page-realm routes above that are not traced and the pending
  export, and says that reports measured before node-detectors-v11 observed
  neither OffscreenCanvas 2D work in the page nor any canvas, font or WebGL
  work inside a worker, with the markers a reader finds on one (an r2 report
  whose fingerprint detector is `fingerprint-observer@4` or earlier and whose
  methodology lacks `+worker-fingerprint-v1`, or a v1 report without
  `+fingerprint-surface-v2`), so a quiet canvas, font or WebGL finding on one
  does not rule that work out.
- Recorded identities, old to new:
  - Base Node methodology, which is also the v1 methodology token and the
    corpus cohort key:
    `shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v4+detector-coverage-v2`
    to
    `shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v4+detector-coverage-v2+fingerprint-surface-v2`.
    `fingerprint-surface-v2` names the whole surface the observer now reads:
    OffscreenCanvas 2D work in the page and canvas, font and WebGL work in
    every dedicated worker, together with the every-arm worker pause that
    reaching the workers takes and the new v1 worker line. The earlier
    surface, page canvases only, was unnamed, so only the revision carries a
    component, as with `gpc-worker-application-v2`. Both halves land before
    any deploy, so the v1 token moves once.
  - r2 methodology: the base move above, and one new component,
    `worker-fingerprint-v1`, appended after `auxiliary-context-block-v1`. It
    names the every-arm paused attach, the observer installed in each
    dedicated worker, the streamed readback behind a barrier at both reads,
    owner-document scope, and the accounting that makes an unread worker
    realm, or a shared worker the channel sees start, a fingerprinting
    capture loss (a visit whose channel was never established sees no shared
    worker, as above). Earlier
    methodologies observed no worker realm, so only this revision carries a
    component. `gpc-worker-application-v3` does not move: its installer runs
    first in the same pause with the same readback and loss definition.
  - Detectors: `fingerprint-observer@4` to `fingerprint-observer@5`, which
    covers both the page's OffscreenCanvas work and the worker realms: @5
    was never deployed (`main` and `production` still carry @4), so the
    worker realm does not need a version of its own.
    `DETECTOR_REGISTRY_VERSION` moves from `node-detectors-v10` to
    `node-detectors-v11`, and its digest from `6f8d32c3...5657` to
    `80209bf7...e22a`. The digest also hashes the fingerprint vocabulary, so
    recomputing it from the current inputs with the registry label and the
    observer version restored and the `canvas.convertToBlob` token removed
    from both vocabulary arrays reproduces `6f8d32c3...5657`, and nothing else
    moved. Keeping the token gives `6d76e9d9...ce13`, a value no deployment
    carried. The worker realm adds no event token, reason code or
    obligation, so the digest stays `80209bf7...e22a`. The obligation target
    registries keep v10 as a closed epoch and enforce v11.
  - Node and PageGraph r2 normalization: public-string-policy-v4
    `359b216f...e9bc` to `63947670...7366` under the same `tldts@7.4.13`, a
    widening by two admissions: the `canvas.convertToBlob` token and the new
    worker realm line. Removing both from the current policy inputs
    reproduces `359b216f...e9bc`, and a test holds that. The token alone gave
    `7fd4ef76...69f5`, a value no deployment carried, so it has no
    superseded entry. The policy name stays `public-string-policy-v4`: a
    widening is not a policy revision, as the v9 and v10 detector epochs'
    widenings kept v3.
- The reviewed corpus line advances to the new base. No committed report is on
  the outgoing line, so its replayed handoff moves nothing, and the published
  aggregate changes only when a refresh on the new line passes the handoff
  gate. New v1 reports count OffscreenCanvas work and dedicated worker work
  in `fingerprintEvents` and may carry canvas, font and WebGL detections the
  outgoing line could not, so they are not pooled with it. A new v1 run with
  a worker the observer could not read, or with a shared worker its DevTools
  channel saw start, carries the worker line, so its `fingerprintEvents` is
  not counted in its cohort, as for the frame line; a site that starts a
  shared worker on every visit therefore contributes no `fingerprintEvents`
  on the new line from any visit whose channel was established. A visit
  whose channel was not established cannot see a shared worker start, so it
  carries no line for one and its `fingerprintEvents` is counted. A canary panel
  site that uses OffscreenCanvas or fingerprints in a worker can move the
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
  `pagegraph-v4-convert-to-blob-active`; they follow the live methodology and
  normalization, so they carry `worker-fingerprint-v1` and `63947670` with no
  further row, and the PageGraph row keeps the name of the epoch's first
  admission.

### Brave Shields lists

- The Shields simulation uses the Brave default filter lists fetched
  2026-10-19 (31 lists, manifest `25bef053`), adopted from the weekly refresh
  proposal, so the status page's snapshot stays current past October 26. The
  October 18 snapshot stays readable as a closed producer identity: the
  node-detectors-v18 list row is closed to its exact literals as
  `node-v23-detectors-v18-active-lists-2026-10-18`, byte for byte what
  `a1ec8a55` produced, and the new active list row is
  `node-v23-detectors-v18-active-lists-2026-10-19`. The no-list row, the
  methodology, the normalization and the corpus cohorts do not move, and
  reports production wrote with the October 18 lists read as before.
- The Shields simulation uses the Brave default filter lists fetched
  2026-10-18 (31 lists, manifest `01437eff`), replacing the September 28
  snapshot the status page had marked stale. The September 28 snapshot stays
  readable as a closed producer identity: the node-detectors-v17 list row is
  closed to its exact literals as
  `node-v22-detectors-v17-active-lists-2026-09-28`, byte for byte what
  `3e885607` produced, and the new active list row is
  `node-v22-detectors-v17-active-lists-2026-10-18`. The no-list row, the
  methodology, the normalization and the corpus cohorts do not move, and
  reports production wrote with the September 28 lists read as before.
- The Shields simulation uses the Brave default filter lists fetched
  2026-09-28 (31 lists, manifest `2e8c9278`), adopted from the weekly refresh
  proposal. The September 21 snapshot stays readable as a closed producer
  identity: the node-detectors-v11 list row is closed to its exact literals as
  `node-v15-detectors-v11-active-lists-2026-09-21`, byte for byte what
  `d8a9560e` produced, and the new active list row is
  `node-v15-detectors-v11-active-lists-2026-09-28`. The no-list row, the
  methodology, the normalization and the corpus cohorts do not move, and the
  95 committed v1 reports measured under the September 21 lists read and pair
  as before.

### Measurement epoch node-detectors-v12

One epoch, declared before any deploy, covers the policy PDF path, three
detectors that now end partial beside the evidence they kept, and five v1
lines for claims r2 withholds.

#### Policy PDF path

- The privacy-policy reader fetches a direct PDF policy with undici 8.11.2
  (from 7.29.1, the 7.x security patch for GHSA-3wwx-pv8p-q78v that main took
  first, f0c45978) and reads it with pdf.js 6.3.289 (from 6.2.108), landed as
  one declared change. undici 8 offers HTTP/2 in ALPN by default, through the scan
  proxy's CONNECT tunnel too, so the policy fetch now sets `allowH2: false` and
  still asks the site for HTTP/1.1 alone, as it did under undici 7. The 8.x
  line also changes connection handling the fetch can meet: 8.11.1 fixes a
  hang on a 3xx response with a large body, and 8.11.2 stops reconnecting
  aborted requests. pdf.js 6.3 changes how it infers characters for some
  fonts that embed no font program and no ToUnicode map: a CID-keyed
  TrebuchetMS is now read by the Macintosh glyph order it follows, where 6.2
  read its right single quote as a middle dot and so lost the no-cookies claim
  in "We don't use cookies." The release also changes the inference for a
  CID-keyed Symbol font and three private-use math glyphs, which fixtures
  built for them did not reproduce. Every PDF the
  tests parse extracts byte-identical text under both versions except the
  TrebuchetMS fixture built to show the change, and so do all 261
  text-bearing PDFs among the 1,181 that ship with macOS and its applications
  on the maintainer's machine (12.8 million characters). The Docker smoke's
  reading-structure check now reads MarkInfo from the Map pdf.js 6.3 returns.

#### Detectors that kept evidence

Four scanner branches recorded a detector failed while the visit still
published what that detector found. The r2 builder refuses evidence from a
detector that reported no activity, so no r2 report could be built for such
a visit: a scan that publishes r2 failed with no report, and a v1 scan kept
its v1 report but lost its r2 shadow copy. Each now ends the detector
partial with the same loss it recorded before, and with the `scan-failed`
reason in the first three branches and `load-failed` in the fourth:

- consent-banner, when the banner search threw or read no frame after the
  consent interaction had begun: the consent facts already say the
  interaction was attempted, and the after-interaction reads run in that
  phase. The v1 consent line is unchanged and still names the failure; r2 no
  longer tells a search that threw from one that read no frame.
- cname-uncloaking, when a lookup failed beside another that resolved to a
  cloak: the cloak publishes with the failed lookups as the detector's loss.
  With no cloak kept the detector still fails. The failed lookup's v1 line is
  new in this epoch (below).
- fingerprint-heuristics, when no frame could be read but a worker realm
  was: the worker's evidence publishes. A realm read with no evidence in it
  now ends partial too, where its r2 report was already built. With no realm
  read the detector still fails.
- fingerprint-heuristics, when a consent-mode visit lost its subject (the
  click, or the page before its state was read, left the recorded site)
  after the read taken just before the click read a frame but was
  incomplete: a frame it could not read, bounded listener attribution, or a
  worker realm it could not read, a shared worker included. That read's
  record publishes on both wires in place of the unread state, as it already
  did beside a complete read, which already ended partial. With no frame
  read there, nothing publishes and the detector still fails.

#### v1 claims r2 withholds

For the same visit, the v1 report allowed claims the r2 report withholds.
Each cause below now leaves a v1 line where r2 records its loss, and v1
readers withhold what r2 withholds there. Other causes stay open, each named
in `lib/v1-r2-parity-property.test.ts` and listed in the 2026-09-29 update of
`docs/comprehensive-review-2026-09-22.md`. No committed v1 report carries any
of these lines, so no committed report reads differently. The consent-banner
item reads lines the scanner already wrote, so a stored v1 report outside
the committed corpus that carries one now withholds the consent-banner claim,
as intended.

- The end-of-visit storage read, the one v1 publishes, that failed or was cut
  at its bounds left v1 publishing the empty or cut list with no line, so the
  storage keys stood and were benchmarked. A new fixed warning now says the
  scanner could not read the page's storage in full, and v1 readers censor the
  storage family for it, as r2 does. The read taken after the verification
  reload, which v1 never publishes, does not add it, and neither does the one
  taken just before a consent click, which v1 publishes only when the page
  then left the recorded site before its state was kept, where the line for
  that departure already marks storage incomplete.
- A consent-banner detector that did not complete left the consent-banner
  claim, which the calm headline requires, standing on v1. In the consent
  modes the existing sentences for a banner search that ran out of time,
  failed, read no frame or not every frame, was interrupted by a page that
  moved, or clicked a control that never responded already say so, and v1
  readers now withhold the claim for each; the completed search that found no
  control does not. Observe mode's banner-visibility check had no line, so a
  new fixed warning says the scanner could not complete it. The existing line
  for a post-consent reload that left the recorded site now withholds the
  claim too, as r2's dropped consent-verification loss does.
- A privacy policy read after a link search that did not cover every link
  kept the privacy-policy claim standing on v1, although a link the search
  never reached may be the policy and r2 withholds the claim. A new fixed
  warning says the search did not cover every link, and v1 readers withhold
  the claim for it. A failed load, where the policy probe is withheld on
  purpose, adds neither the loss nor the line.
- A CNAME cloak found on a visit whose lookups stopped at their bound, with
  first-party subdomains left unresolved, kept the CNAME cloaking claim
  standing on v1, although one left unresolved may be a cloaked tracker and r2
  withholds the claim. A new fixed warning says the scanner looked up CNAME
  records for only some of those subdomains, and v1 readers withhold the
  claim for it. A failed lookup adds its own line instead (next item).
- A CNAME cloak found beside a lookup that failed kept the CNAME cloaking
  claim standing on v1, although the subdomain that lookup was for may be a
  cloaked tracker and r2 withholds the claim. A new fixed warning says the
  scanner could not complete one or more CNAME lookups, and v1 readers
  withhold the claim for it. The scanner adds it for every failed lookup, and
  for a probe that failed outright, with or without a cloak; beside
  candidates left past the bound a visit carries both lines.

#### Identities

- Recorded identities, old to new:
  - Detectors: `policy-text-cross-check@7` to `@8` (extracted text and the
    fetch can differ on some inputs), and `consent-control-and-state@2` to
    `@3`, `dns-cname-chain@4` to `@5` and `fingerprint-observer@5` to `@6`
    (the partial outcomes above; the observer script itself is unchanged).
    `DETECTOR_REGISTRY_VERSION` moves from `node-detectors-v11` to
    `node-detectors-v12`, and its digest from `80209bf7...e22a` to
    `30a670c8...da88`. Recomputing it from the current inputs with the four
    versions, the obligations identity below and the registry label restored
    reproduces `80209bf7...e22a`, so nothing else moved. `516f4eb2...eb25`,
    the policy move alone, was never deployed and has no closed epoch.
  - Obligations: `detector-obligations-v1` (`fb8bd077...22a3`) to
    `detector-obligations-v2` (`502d1490...0f2b`), which adds one row: a CNAME
    detector partial with `scan-failed`, owing the same dropped
    `cname-lookups` loss as the failed one. Readers hold node-detectors-v3 to
    v11 to the v1 registry, which still hashes to `fb8bd077...22a3`, and
    node-detectors-v12 to v2, so no closed epoch admits an outcome its
    producer never emitted. The consent banner's failed `scan-failed` row
    stays in v2 although the new producer no longer sets it, as other rows
    the producer never sets stay registered. The obligation target
    registries keep v11 as a closed epoch and enforce v12.
  - Node and PageGraph r2 normalization: public-string-policy-v4
    `63947670...7366` to `344fdfdf...1563` under the same `tldts@7.4.13`, a
    widening by the five admitted warnings above. Removing them from the
    current policy inputs reproduces `63947670...7366`, and a test holds that.
    The policy name and the `scanner-warning-patterns-v9` label stay: a
    widening is not a policy revision, and `isScannerWarning` is unchanged.
- Because the normalization moves, an r2 comparison that pairs a report
  from before this epoch with one from after it is ineligible in every
  family (an environment mismatch), where the policy move alone would have
  withheld detector findings only. The r2 corpus cohorts do not split, since
  their key does not include the normalization, and v1 pairs are unaffected.
- The methodology does not move, and neither does the v1 token (the base Node
  methodology and corpus cohort key). The corpus pools six metrics, each
  gated by the third-party services, third-party cookies or fingerprint APIs
  claim and by one population rule (a complete, pre-consent visit whose
  request evidence is neither censored nor capped). The storage line censors
  the storage family alone, and the consent-banner, policy-search and CNAME
  lines each withhold one claim, none of them pooled; none changes a run's v1
  outcome. The partial outcomes change r2 detector statuses only: a v1 scan
  published its v1 report beside the refused r2 build before and still
  does, and the r2 reports they let publish are measured the same way as any
  other. So no pooled metric changes meaning, and the 95 committed v1
  reports on the current line (`+fingerprint-surface-v2`) share a cohort
  with the reports that follow them. The corpus neutrality snapshot of all
  1028 managed comparison decisions reads `917f947e...0f64` with the code at
  `cb3ef421` and with this epoch's.
- Published reports keep their recorded identities. The deployed producer rows
  `node-v15-detectors-v11-active-lists-2026-09-28` and
  `node-v15-detectors-v11-active-no-adblock` are closed to their exact
  literals (the v15 methodology and normalization, node-detectors-v11 and a
  frozen copy of the September 28 lists under adblock-rust 0.13.3), byte for
  byte what `0cf2f128` produced, and `pagegraph-v4-convert-to-blob-active` to
  its `63947670` normalization and the 2026.08 catalog, byte for byte what
  `cb3ef421` produced. The outgoing Node and PageGraph normalizations stay
  readable as superseded identities, the Node one paired with the v15
  methodology that all three v15 rows ran. The new active rows are
  `node-v16-detectors-v12-active-lists-2026-09-28`,
  `node-v16-detectors-v12-active-no-adblock` and
  `pagegraph-v4-storage-snapshot-active`, which keeps the name of the
  epoch's first admission.

### Toolchain epoch 2026-10

- Toolchain epoch 2026-10 moves two inputs in one reviewed step and holds the
  rest: tldts 7.4.13 to 7.4.16, the registry's latest at the cut (published
  2026-09-27; 7.4.14, published 2026-09-21, and 7.4.15, published 2026-09-23,
  passed over), and wasm-bindgen 0.2.126 to 0.2.129 with the vendored adblock
  WASM rebuilt from the locked Cargo graph (`sbl_adblock_wasm_bg.wasm` `4034076e`
  to `7dda4b30`, the linked walrus 0.26.4 to 0.27.2, syn 3.0.6 added beside
  syn 2.0.118 as a proc-macro dependency). adblock-rust stays 0.13.3, and
  Playwright stays 1.63.0 with Chromium 153.0.8010.12 and the container base
  `mcr.microsoft.com/playwright:v1.63.0-noble` at index digest `eff16c30`:
  Chromium 154 waits for Playwright 1.64 to reach a stable release. The WASM
  reproducibility contract now proves the wasm-bindgen CLI from the binary's
  producers section, because 0.2.129 no longer embeds the crate's source path.
- Recorded identities, old to new: the Node and PageGraph r2 normalizations
  move from `tldts@7.4.13` to `tldts@7.4.16` under the same
  public-string-policy-v4 digest `344fdfdf...1563`. Nothing else a report
  records moves. The base Node methodology (the v1 token and corpus cohort
  key) and the r2 methodology keep their adblock-rust 0.13.3 and Playwright
  1.63.0 components, so the reviewed corpus line does not advance and no
  outgoing methodology joins the historical list; the disclosed engine
  version, the request-context identity and the September 28 list identity
  are unchanged; no detector, obligation or policy digest moves. The rebuilt
  WASM changes no recorded identity: no identity names wasm-bindgen or the
  WASM bytes, and the engine differential over the committed list snapshot
  (107,388 hosts, two sources, four resource types, GET and POST: 1,718,208
  tuples, plus 12 synthetic control tuples) found no changed block decision
  between the two builds.
- The tldts move is not a widening. tldts changes only its suffix trie: 11
  private rules added (`*.azure.databricksapps.com`, `*.compute.herokuapp.com`
  and 9 exact rules, among them `surge.sh`, `glideos.app` and three Databricks
  app suffixes) and 2 removed (`alpha-myqnapcloud.com`, `dev-myqnapcloud.com`).
  Every stored report is re-redacted with the new engine when it is read,
  whatever its era, so one holding a host whose redaction the new engine
  changes fails closed instead of being served: a non-allowlisted label below
  a removed rule (`myapp.alpha-myqnapcloud.com`), a direct child of
  `*.compute.herokuapp.com`, or a host equal to one of six added rules that is
  now a suffix itself (`surge.sh`). So does one whose stored registrable
  domain the new engine computes differently, in any of the three positions
  that store one: a scanned site at or below those six rules or under a
  removed rule, or at a direct child of `*.compute.herokuapp.com` (its stored
  `compute.herokuapp.com` stays fixed, but its origin host is now a suffix);
  and a Shields-list tracker, matched on a request or through a CNAME cloak,
  whose stored domain the new engine no longer derives from the stored host:
  at or below those six rules, anywhere under a removed rule, allowlisted or
  not, and anywhere under `*.compute.herokuapp.com` but its apex (a Surge,
  Glide or Heroku compute host is the likeliest live case). Measured over the
  committed corpus (1029 reports, their sidecars, the index and every other
  tracked text file: 30,766 host-like tokens and 5,389 URLs), both engines
  agree on every token and on every one of 3,970 stored registrable domains,
  no token sits in a changed rule's zone (the reports store a Shields-list
  tracker at 203 CNAME-cloak positions over 13 domains and at no request
  position), and `reports:remediate --check` reports every report and
  sidecar current under both engines. Of 117 synthetic probes around the
  changed rules (each changed rule as the apex and under eight label shapes),
  sanitized by the 7.4.13 engine and read back through the managed reader
  and the remediation planner under 7.4.16, 19 published host strings, 67
  stored subject keys, 78 request tracker domains and 78 cloak tracker
  domains stop being fixed points. For the live store, publishing this epoch
  is the owner's acceptance of that instead of remediating: shares expire
  after 7 days and the storage bucket deletes them at 8 (the
  `reports-retention-backstop-8d` rule, read back with wrangler for this
  epoch on 2026-09-30, enabled and unchanged), so only reports saved in the
  8 days before the deploy can be affected. The corpus neutrality snapshot of all
  1028 managed comparison decisions reads `917f947e...0f64` under both
  engines and with this epoch's identity bookkeeping applied.
- Published reports keep their recorded identities. The deployed producer
  rows `node-v16-detectors-v12-active-lists-2026-09-28` and
  `node-v16-detectors-v12-active-no-adblock` are closed to their exact
  literals (the v15 methodology, the `344fdfdf` normalization under tldts
  7.4.13, node-detectors-v12 and a frozen copy of the September 28 lists
  under adblock-rust 0.13.3), byte for byte what `f9d6c46e` produced, and
  `pagegraph-v4-storage-snapshot-active` to its `344fdfdf` normalization
  under tldts 7.4.13 and the 2026.08 catalog. The outgoing normalization
  identities stay accepted (not readable) as the recorded owner exception in
  `SUPERSEDED_R2_NORMALIZATIONS`, the Node one paired with the v15
  methodology both v16 rows ran. The new active rows are
  `node-v17-toolchain-2026-10-active-lists-2026-09-28`,
  `node-v17-toolchain-2026-10-active-no-adblock` and
  `pagegraph-v4-tldts7416-active`. Because the normalization moves, an r2
  comparison that pairs a report from before this epoch with one from after
  it is ineligible in every family; the r2 corpus cohorts do not split, and
  v1 pairs are unaffected.
- The exact-build staging A/B between `f9d6c46e` and `34d6847b` failed under
  its gate twice, each time on a detector-output capture-loss signature that
  differed between the builds: in round 1 one baseline Guardian run dropped
  the consent-banner probe, and in round 2 one candidate python.org run
  truncated the privacy-policy link search (a baseline Guardian run again
  dropped the consent-banner probe). No canary metric is counted from
  detector output, and the compared medians were within tolerance in both
  rounds (a diagnostic reimplementation of the gate's median step over the
  metric-feeding families, all 44 compared panel medians; not the gate). The
  owner published the epoch on 2026-09-30 under a recorded exception to the
  A/B gate, with the gate, its tolerances and the panel unchanged. Two
  commits followed on `main` before publication, neither staged nor
  scanned: `4dfd0ca1` patched the dev-only brace-expansion and fast-uri
  advisories that failed main CI's audit gate, and `5d908f89`, the
  published commit, upgraded the runtime image's OpenSSL past
  CVE-2026-84782, which failed main CI's image scan for every build on the
  pinned base. The full record, with all four canary receipts, is in
  [docs/toolchain-epoch-2026-10.md](docs/toolchain-epoch-2026-10.md).
- Security patches beside the epoch, as `f0c45978` took undici 7.29.1
  before the node-detectors-v12 epoch. `4dfd0ca1`: the brace-expansion
  override moves from 5.0.9 to 5.0.12 (GHSA-qhr7-859c-m2p7 and
  GHSA-6j4f-fj2g-mc7p, high; GHSA-q2hr-2g5m-vwhr, moderate) and fast-uri
  from 3.1.7 to 3.1.8 through ajv (GHSA-hrr3-gc8f-f4qj, moderate), all
  four published 2026-09-29 (UTC), after the baseline's main CI run, which
  main CI's whole-lockfile `npm audit` at `--audit-level=low` fails on;
  both are development-only in the lock, so the pruned runtime image
  contains neither. `5d908f89`: the runner stage upgrades exactly
  libssl3t64 and openssl from 3.0.13-0ubuntu3.15 to 3.0.13-0ubuntu3.16,
  past CVE-2026-84782 (HIGH, published 2026-09-29) in the pinned Playwright
  base, which main CI's Trivy image scan refuses on every build of that
  base; neither Node nor the bundled Chromium links the system OpenSSL, so
  the scanner's TLS stacks are unchanged, and the container package ledger,
  keyed by upstream version, does not move. The pin is dropped once a base
  digest ships the fix. No measurement identity moves in either commit.

### Toolchain canary gate

- The toolchain canary compares capture loss strictly only in the evidence
  families its metrics are counted from (requests, cookies, storage and
  fingerprinting): every run of a site in both builds must still record the
  same signatures there, and a shared loss still leaves out the metrics its
  family feeds. A loss in any other family, such as detector output or
  consent verification, now fails the comparison only when more than half of
  one build's runs of a site carry it and none of the other build's do;
  otherwise `compare` prints it as `NOTED` with both builds' run counts,
  recorded and not compared, including a loss every run of both builds
  carries. The 2026-10 epoch failed its A/B twice on detector-output
  signatures, each carried by 1 of 3 runs of one build and none of the
  other, while all 44 medians the gate would have compared stayed within
  tolerance. On 2026-10-02, before the next baseline capture, the owner
  chose to refine the gate along the lines of that epoch's recorded
  proposal; this rule goes beyond the proposal: it still fails a systematic
  difference, it covers every family that feeds no metric, not only
  detector output, and it notes a loss every run of both builds carries.
  Receipts and their version do not change. Under the refined gate the
  committed 2026-10 receipts pass with those signatures noted beside
  github's every-run keystroke-probe truncation; that does not change that
  epoch's record: it was published under a recorded exception, and the FAIL
  output it quotes reproduces only from a checkout that predates this
  change, such as `eecb7335`. The 2026-09 receipts pass under both rules
  with the same compared medians; the refined gate adds one `NOTED` line,
  for github's keystroke-probe truncation, and the noted count to the PASS
  line, so the output the 2026-09 record quotes also reproduces verbatim
  only from a checkout that predates this change. The rule is in
  [docs/toolchain-epoch.md](docs/toolchain-epoch.md).

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
