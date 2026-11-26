# Formal verification claims register

This register lists what the bounded formal verification suites hold, each in
one form: for all inputs in a domain D, under bounds B and axioms A, code F
satisfies property P, checked by test T, whose name is in its file at commit C
and not at C's first parent. Each row is a statement about this repository's
own code over a closed, finite domain, and says nothing of what a browser, a
page or a network hands that code.

Some rows rest on a tool this project did not write. A row whose method is
`model checked` rests on TLC, which walked a TLA+ specification. A row whose
method is `machine-checked argument` rests on Verus, which accepted a statement
about a Rust function for every value of a type. The unit suite runs neither
tool. Each such row says where the tool runs, what the unit suite holds in its
place, and what the tool was trusted for.

The register covers the suites of the F batches, named by their file prefix
and listed under Files below. Other tests also use `lib/finite-check.ts`, the
walks of the investigation workspace's W1 and W2 suites among them, and this
register claims nothing for them, except the W2 tests the F5 suite names, which
have rows of their own.

The suites state these claims in their own docblocks, and their commit
messages state them again. The code is the authority. Where a commit message
and its suite disagree, this register says what the suite holds.

`lib/formal-verification-register.test.ts` holds this file to the suites in
both directions. It checks names, numbers and words, not meaning: a row whose
Property misstates what its tests hold passes when its names, numbers and words
are in order. The guard holds the register against honest drift and accidental
edits by a maintainer, not against a suite or register rewritten to evade it;
the Limits section below names what it does not follow. It refuses a row that
is missing a field, names a method outside the list below, uses a word from the
wording list, states a number it cannot find in the source, names a file that
does not exist or a name in code or in quotes that the files it names do not
hold, or cites a test that does not exist, by that exact name, in that file. It
refuses a cited test, or a test a cited family matches, that carries skip,
todo, only or expectFailure, takes options other than a plain object literal,
sits under anything but blocks, loops and the callbacks of tests it does not
refuse, has no function literal to run, or calls its context's skip or todo. It
also refuses a suite file this register does not name, a test in a suite file
that no row cites, and an open test cited as a claim. It reads each named
commit from git, and refuses one that is missing, is not a commit, is not an
ancestor of the checked-out commit, does not hold the row's tests and families,
or whose first parent holds any of them.

## What a row says

Each claim row has these fields, in this order:

- **Property:** P, the statement the tests hold.
- **Code:** F, the code the tests run: production code, or the harness or model the row holds.
- **Domain:** D, the closed set of inputs the tests walk. A quantifier in the Property (every, all, never) reads inside this domain.
- **Bounds:** B, the sizes the walk stops at. Nothing beyond them is claimed.
- **Axioms:** A, what the row assumes about the environment, or none.
- **Method:** how the domain is covered, from the list below.
- **Not claimed:** what the row leaves out, where that needs saying. This field is optional.
- **Checked by:** for a row whose method is `machine-checked argument`, and for no other row: the script that runs the tool and holds what the tool is asked, and where that script runs.
- **Tests:** T, each test the row rests on, by its file and its exact name as the source spells it, template placeholders included. A row with a Checked by field may state none, with the reason; no other row may.
- **Variants:** the tests that hold the check to broken variants of the code: a family of templated tests by the start of their names, or a test by its exact name, or none with the reason.
- **Members:** the entries of a cited family's table that this row rests on, where the family holds members for other rows too. This field is optional.
- **Commit:** C, a full commit id, an ancestor of the checked-out commit and a commit object, in whose tree each cited test and family is present, and in whose first parent none is.

A family is cited whole, and a row rests only on the members caught by a
property it states. A family matches only templated test names; a variant test
written with a plain name is cited by that name.

An open finding has a Finding in place of the fields from Property to Members,
and may list Cases, the entries of a table-driven test. It claims nothing: it
pins what the code does, not what it should do.

## Methods

- `exhaustive`: every member of a closed domain the row states.
- `bounded`: every input within the stated bounds, which state a size, and nothing beyond them.
- `reachable states`: every state and every transition a breadth-first search reaches from its start over a stated event alphabet, under the stated axioms. A state the alphabet cannot reach is outside the domain.
- `trace conformance`: traces of a model replayed through the real code, with each step's output compared with the model's. It holds the code to the model, and neither to a browser.
- `sampled`: written-out cases from a wider domain passed, and nothing is said of the rest of that domain.
- `restatement`: the oracle restates the production rule, from a docblock, a commit or the code, so it catches the code drifting from that rule and never a wrong rule. It qualifies another method and never stands alone.
- `model checked`: TLC held the row's invariants on every state it reached from the first state of each configuration the row names, over that configuration's alphabet and bounds, under the switches it sets. It holds a specification and not the code; a further method in the same row says how far the code is held to the specification. TLC's side of each comparison in the unit suite is a committed export, which a hosted workflow compares with TLC's own output.
- `machine-checked argument`: Verus accepted that an executable Rust function returns what a written specification says, for every value of the type the Domain states, with no bound. It holds the function to the specification as written. It holds the specification to nothing, and it says nothing of compiled bytes or of the code that calls the function. It trusts Verus, Z3, vstd, the Rust compiler and the specification. In the field's usual terms, a function Verus accepts for every value is formally verified against its written specification, under the trust this entry states. This register says that of the functions the kernel rows name and of nothing else, and never of the scanner.

Where a row walks every variation of cases the suite writes out (every cut of
every prefix of its paths, say), the walk is exhaustive over those variations
of those cases, which the Domain names as the suite's, and the cases themselves
are a sample of a wider set, so such a row lists both exhaustive and sampled.
The same holds of a bounded walk over an alphabet the suite writes out, which
lists bounded and sampled. A row whose domain mixes these says, in its Domain,
which part each method covers. A count a suite pins (states, transitions,
cases, variants) is a change detector, never evidence, and this register states
no such count.

## Wording

The guard refuses each of these words and phrases anywhere in this file, as a
whole word and in any case, except in this list and in one sentence that
closes the Methods entry for `machine-checked argument`, which the guard holds
word for word and admits in that place only. A space in a phrase also
matches a hyphen or a slash, a trailing star stands for any ending of the word,
and emphasis and link marks are read through:

- `proof`, `proofs`, `prove`, `proves`, `proved`, `proven`, `proving`, `provable`, `provably`: a finite check holds a property over its domain at a commit, and these words claim more than that. The kernel rows state an argument for every value of a type, and name it by their method, `machine-checked argument`, and by no other word.
- `theorem`, `theorems`: these name a statement settled by such an argument, which no row is.
- `guarant*`, `bulletproof`: these words promise behavior on whatever input arrives, and a row speaks only of its domain, bounds and axioms.
- `formally verif*`: this names code held to a written specification by a machine-checked argument. No finite check here is one, and nothing here says it of the scanner. The Methods entry for `machine-checked argument` says it once, of the functions the kernel rows name and of nothing else; the rows name their method and do not use the phrase. "Formal verification" names the program and its release gate, and stays allowed.
- `verified`, `verifies`, `certified`, `certifies`: these give the code a verdict against a standard, where a row says only that its tests held over their domain.
- `sound*`: these speak of a method beyond the domain it was run on, and a row speaks of one domain.
- `correct`, `correctly`, `correctness`, `incorrect`, `incorrectly`: as a verdict this says the code is right or wrong. A restated oracle catches drift from a rule and never a wrong rule, and a check against a hand-written table holds only that table.
- `ensur*`, `assur*`: these say the code makes a property true wherever it runs, where a row says only that the property held over its domain.

Further rules refuse unbounded wording. A quantifier (any, every, all, each or
arbitrary, with fillers such as "of the", "possible", "given", "live" or "web")
over sites, websites, pages, URLs, domains, origins, user agents or browsers,
named or not, names an open domain no check walks, and so do real-world before
pages or sites, a phrase for the whole of the web, and the phrases that claim a
scope with no domain, which the guard lists. A quantifier over inputs must name
the row's domain or bounds at once, and not a domain or bounds of something
else. A browser named without a quantifier is not refused, since the register
names Chromium where it says what is not measured. Every, all and never are not
refused on their own: they belong to the suites' own property names, and a
row's Domain scopes them. The file is plain ASCII with no HTML entity, and no
HTML tag, comment, declaration or processing instruction outside code spans, so
no character outside ASCII and no markup the guard reads hides a word from
these rules; the Limits section names markup it does not read. A cited test
name, a family's prefix and the titles it matches, and each case and member are
held to the same words under their own refusal, which names the suite file;
none trips it today.

A number is stated only where it states a bound or a domain. The guard reads
the words as a reader sees them, with emphasis and link marks read through. It
counts any run of digits, whatever follows it, and a decimal with a leading
dot; spelled numbers above one, spelled ordinals past the second, and spelled
multipliers; and "one" only where it states a bound (after "up to", "at most",
"at least", "exactly" or "plus", or before "past" or "more"). "zero" names a
convention here, not a count. Each number a row states sits inside a phrase
the guard anchors to suite source that holds it: the code that sets or pins it
where there is such code, and otherwise the suite's own words for it, in a
comment, a docblock, a test name or a property name. A phrase holds a
whole clause from its lead and appears in its row once, so swapped numbers or
swapped clauses fail, and a number outside the rows fails. A number inside a
cited test name, or inside a quote of a suite's own words longer than a pair
of words, is the suite's own, held verbatim by the exact-name and quote
checks; a quote of a word or a pair is read like any other words.

## What the commit means

The Commit of a row is a commit whose tree holds its cited tests and families
and whose first parent holds none of them, not the commit that holds this file,
so a row never names its own commit. The guard checks what the field says: a
full commit id, of type commit, an ancestor of the checked-out commit, in whose
tree each cited test and family is present, and in whose first parent none is.
It does not say where a test first appeared in history: a test deleted and
added again, a file renamed, a merge whose second parent held the test, and
members a family gained after its Commit all pass. `npm run test:unit` reruns the lib suites in its unit lanes, while
`npm run test:investigation:all` runs the workspace suites in
`npm run test:investigation`, the case exploration in
`npm run test:investigation-exploration`, and the conformance suite in
`npm run test:tla-case-machine`, wherever it runs. A row states what its tests hold at the commit
that holds this file, and a test may have held less, or held a different rule,
at its Commit. What binds a run of the cited tests to a release candidate is
the signed execution report the Release status section describes.

A shallow or partial clone, a clone with grafts, a commit that is not found,
or a git that fails, fails the guard, with a message that says so; replacement
objects are read past, so a commit shows its own tree. A missing or stranded
commit is most likely a rebase of unpushed history, which gives every commit a
new id: the message says so, and the fix is to find, for each row, the commit
whose subject matches the batch that landed its tests in `git log`, and put its
full id in the Commit field. CI's history is owned by one test,
`lib/ci-performance-contract.test.ts`, "every job that runs the unit suite checks out the whole history, unfiltered",
which holds every workflow job that runs the unit suite to a full, unfiltered
checkout. A build context with no repository at all, as the container image
build has by design, skips the commit checks on the checkout by name and runs
every other check.

## Limits of the guard

The guard reads the spellings this register lists and, within names, numbers
and words, holds the register against honest drift and accidental edits, not
against a suite or register rewritten to evade it. It does not follow these:

- `node:test` reached through a spelling beyond those the guard reads: an import of it, a name bound to one by assignment or destructuring, and the `test`, `it` and modifier members of those names. A computed or chained spelling, as in `nt[name]` or `nt.test.skip`, is not read.
- A test context aliased, or passed to a named function, so a subtest or a skip through it is not seen. A cited test whose body is not a function literal is refused.
- `this.skip()` inside a `function` callback, which skips the test through the context bound to `this`.
- A test the code never reaches for a reason only control flow shows, such as an empty loop, a test in a loop's incrementor, or a `continue`, `break`, `return` or `throw` before it. The guard reads where a test sits, not whether the code reaches it.
- Markup the word and HTML rules do not read as the page does: an escaped backtick, which the HTML rule takes as opening a code span, so a tag after it is not refused when a later backtick on that line closes the span; a code span paired across a line break, which the HTML rule does not take as code; and a reference-style link, whose marks the word rules do not read through.
- Quantifier and number spellings beyond the ones the Wording section lists.
- A table-driven open test's entries the table reader does not read. It takes a case only from an object literal in the array literal the test loops over, whose name is a plain string literal; an entry named by a template literal, an entry built by a call or a spread, and an entry added to the array by a later statement are left out of the table with no refusal, so Cases can match the table while the suite runs an open case the register does not list.
- The fixture side of the guard's own check that each refusal is caught first by something. That check reads the refusals the git fixture tests catch from `FIXTURE_PROPERTIES` in `lib/formal-verification-register.test.ts`, a list written by hand, and not from the fixture tests. The failing-git refusal has no planted variant and is caught only by fixture tests, so deleting every fixture test that catches it would leave that check passing.
- Meaning: a Property that misstates what its tests hold, as the opening says.

## Release status

The release gate `formal-verification` is in code. `RELEASE_READINESS.json`
names it, with a `requiredSuites` entry for each test file a row of this
register cites, and `scripts/v1-release-contract.mjs` pins the same entries, so
a manifest that drops the gate, changes its kind, drops an entry or asks an
entry for less is refused. The guard holds that list to the files the rows
cite, both ways.

`npm run release:formal-verification-report` runs each of those files again,
alone, and writes an execution report for the commit it ran at. For each file
the report holds the test runner's counts (tests, passed, failed, cancelled,
skipped, todo), the command's own counts of what those leave out (tests that
failed as expected, and describe blocks skipped, left todo or failed as a
block), each test by name with its outcome, and each catch `assertCaughtBy`
accepted, with the variant's name, the property its suite named and the
property the counterexample carried. `lib/finite-check.ts` records a catch
only where a run names a log for it, as that command does, and
`lib/finite-check-catch-log.test.ts` holds that recorder. The command writes
no report unless the checkout is a clean commit and the run meets each entry:
no test skipped, left todo, failed, cancelled or failed as expected, no
describe block skipped, left todo or failed as a block, the tests that passed
and the catches recorded for the property the suite named at or above the
entry's minimums, and no catch recorded for another property. A test that
failed as expected is one marked so whose body threw: the test runner reports
it as a pass, and here it is none. The command's reading of the test runner's
events was derived on the Node this repository pins, and must be derived again
when that pin moves.

The gate passes only when a release candidate's evidence carrier binds such a
report for the candidate commit, with a signature bundle made by CI at that
commit, and the gate then reads the report against the same entries. CI's
formal-verification job writes the report for each commit CI tests, and its attest job signs
it on the main branch. Until a carrier binds a signed report for a candidate,
the gate fails, and it fails today: no carrier exists.

What the report does not hold. A count a suite pins inside a test (states,
transitions, cases) stays inside that test: the report counts tests and
recorded catches, and an entry's minimums are change detectors, never
evidence. A catch is a line the harness appended to a log while the suite ran.
The suite's own process writes that log, so the list of catches is not
independent of the suite it describes, and nothing here can tell a line the
harness wrote from a line of the same form written by other code in that
process. The gate holds the number of catches and that none names another
property. It does not hold that variant names are distinct, and a variant
caught for more than one property is counted once for each. The counts and
the outcomes are likewise the producer's own statement of its run: the
signature attributes that statement to a CI run at the commit, and checks
nothing else of it. The report names no method, which is a statement of a row
and nothing a run can observe. The gate does not compare the report's test
names with the tests the rows cite: the guard holds those at each commit, and
the guard is not among the files the report runs. A report shows that the
cited files ran and passed at a commit. It adds nothing to what a row claims.

The gate's execution report runs the unit suite's files. It runs neither TLC
nor Verus. What a `model checked` or `machine-checked argument` row rests on
is a hosted workflow run at a commit: `tla-checks.yml` writes and signs a
receipt, and `trust-kernel.yml` passes or fails. No release gate reads
either today. A reader who wants the tool's verdict for a release looks for
those runs at the release's commit.

## What this register does not claim

- That a browser behaves as an axiom states. Each axiom stays a question for measurement, and the amd64 hold rate is among what is not yet measured.
- How often an input in a domain, or an open finding, occurs in a browser.
- Anything about an input outside a row's domain or past its bounds.
- That a restated oracle states the right rule.
- Anything about a visit made with the scanner's investigation seam set. No suite sets the seam, or hands a check the boundary callback or the deadline margin that only the seam supplies.
- That a scan's address decision rests on the kernel. It rests on `lib/ip-safety.ts`.
- That TLC or Verus ran at a commit, beyond what the hosted runs at that commit show.

## Files

The finite-check harness is `lib/finite-check.ts`, with its own test
`lib/finite-check.test.ts`. Its catch log, which the Release status section
describes, has a test of its own outside this register's rows,
`lib/finite-check-catch-log.test.ts`. The 12 active required suites are
`lib/fv-producer-identity.test.ts`, `lib/fv-coverage-loss.test.ts`,
`lib/fv-warning-fragments.test.ts`, `lib/fv-ipv4-classifier.test.ts`,
`lib/fv-report-consistency.test.ts`, `lib/address-kernel.test.ts`,
`lib/finite-check.test.ts`, `investigation/test/case-exploration.test.ts`,
`investigation/test/evidence-model.test.ts`, `investigation/test/purge.test.ts`,
`investigation/test/readings.test.ts`, and
`scripts/tla-case-machine-conformance.test.mjs`. The case exploration's walks
and checks are in `investigation/test/case-exploration-walk.ts`, run in worker
threads by `investigation/test/case-exploration-worker.ts`, with a planted
fault for its self-tests in `investigation/test/case-exploration-plant-worker.ts`.

The active TLA+ specification is under `specs/case-machine`. Its conformance
suite is `scripts/tla-case-machine-conformance.test.mjs`, which reads the
committed export `specs/case-machine/conformance.json`. The trust kernel is
under `tools/trust-kernel`. `scripts/trust-kernel-verus.mjs` runs Verus on it,
and the unit suite's test of the module the scanner loads is
`lib/address-kernel.test.ts`. (Nine suites that previously verified retired
v1/v2 live-scan producers—ephemeral scroll-check, connection-inspection,
initiator-claims, and legacy worker-hold suites—were retired when `POST /api/scan`
was replaced by `POST /api/v3/scan`.)

## Claims from F1: producer identity, coverage loss and request accounting

### EB1. A producer row's run matches that row and no other

- **Property:** A run built from a producer row matches that row and no other; a run with any one key field changed matches no row; a refetch of the same lists keeps its row; each Node row admits a run at its own request limit and refuses one past it; no PageGraph row accepts a misshapen methodology.
- **Code:** `nodeTupleMatches`, `pageGraphTupleMatches` and `assertR2ProducerContract` in `lib/scan-report-v2-r2-producer-contract.ts`.
- **Domain:** Exhaustive over every Node and PageGraph producer row the contract's tables hold, each made into a run by the suite's fixture, and each of its key fields changed. Sampled for the changed value, which is the value the suite writes out for that field and no row holds, and over the methodology suffixes the suite lists for each PageGraph row and the methodology spellings it lists as misshapen. A run the fixtures cannot synthesize is outside it. Rows are only ever added.
- **Bounds:** One key field changed at a time; a request count at each row's limit and one past it.
- **Axioms:** none
- **Method:** exhaustive, sampled
- **Tests:**
  - `lib/fv-producer-identity.test.ts`: "EB1: each Node producer row's run matches that row and no other"
  - `lib/fv-producer-identity.test.ts`: "EB1: each Node producer row admits exactly its own request limit"
  - `lib/fv-producer-identity.test.ts`: "EB1: a run with any one Node key field changed matches no row, and a refetch keeps its row"
  - `lib/fv-producer-identity.test.ts`: "EB1: each PageGraph producer row's run matches that row and no other"
  - `lib/fv-producer-identity.test.ts`: "EB1: a run with any one PageGraph key field changed matches no row"
  - `lib/fv-producer-identity.test.ts`: "EB1: no PageGraph row accepts a misshapen methodology"
- **Variants:**
  - `lib/fv-producer-identity.test.ts`: names beginning "EB1 catches a variant"
  - `lib/fv-producer-identity.test.ts`: "EB1 catches a variant: the Node match key loses runtime identity"
  - `lib/fv-producer-identity.test.ts`: "EB1 catches a variant: a refetch retires the row"
  - `lib/fv-producer-identity.test.ts`: "EB1 catches a variant: a duplicated Node row carries different limits"
  - `lib/fv-producer-identity.test.ts`: "EB1 catches a variant: the limit check is gone"
  - `lib/fv-producer-identity.test.ts`: "EB1 catches a variant: a limit refuses the value it allows"
  - `lib/fv-producer-identity.test.ts`: "EB1 catches a variant: a duplicated PageGraph row"
- **Commit:** af6c9568efe3f9cbf2503a8d9b3086fd8b240167

### EB2. A row's obligations are the contract its registry is held to

- **Property:** Every Node producer row that carries obligations names the obligation contract and digest its detector registry is held to, by the production digest recipe, and its registry is a target epoch; a row with no obligations names no contract, and its registry is no target epoch; every target epoch of the obligation contracts is named by a row.
- **Code:** the rows of `lib/scan-report-v2-r2-producer-contract.ts`, with `detectorObligationContractVersion` and the obligation registries in `lib/detector-obligations.ts`.
- **Domain:** Every Node producer row, with and without obligations, and every target registry of the obligation contracts.
- **Bounds:** none beyond those tables.
- **Axioms:** none
- **Method:** exhaustive
- **Tests:**
  - `lib/fv-producer-identity.test.ts`: "EB2: every row's obligations are the contract its detector registry is held to"
  - `lib/fv-producer-identity.test.ts`: "EB2: every target epoch of the obligation contracts is named by a row"
- **Variants:**
  - `lib/fv-producer-identity.test.ts`: "EB2 catches a variant: one row's obligation digest is edited"
  - `lib/fv-producer-identity.test.ts`: "EB2 catches a variant: one row names another contract's version"
  - `lib/fv-producer-identity.test.ts`: "EB2 catches a variant: the epoch map sends v2 epochs to the active contract"
  - `lib/fv-producer-identity.test.ts`: "EB2 catches a variant: a row's registry is no longer a target epoch"
  - `lib/fv-producer-identity.test.ts`: "EB2 catches a variant: every registry reads as a target epoch"
- **Commit:** af6c9568efe3f9cbf2503a8d9b3086fd8b240167

### EB3. Each status contract admits its own reason table

- **Property:** A status-v1 row admits exactly the current status and reason table less `evidence-cap-reached`, a status-v2 row admits exactly the current table, and a complete detector carries no reason.
- **Code:** `assertR2ProducerContract` in `lib/scan-report-v2-r2-producer-contract.ts`, which reads `lib/detector-status-contract.ts`.
- **Domain:** Exhaustive over every Node producer row, with each detector, each status that is not complete with every reason code, and the complete status with each code. Sampled for strings that are no code: one such string, beside each status.
- **Bounds:** none beyond that product.
- **Axioms:** none
- **Method:** exhaustive, sampled, restatement
- **Not claimed:** The table is spelled out in the test, and the test holds production's table equal to it. Whether that table is what reports should say is a policy question this row does not answer.
- **Tests:**
  - `lib/fv-producer-identity.test.ts`: "EB3: status-v1 rows admit the current status and reason table less the cap reason, and status-v2 rows all of it"
- **Variants:**
  - `lib/fv-producer-identity.test.ts`: names beginning "EB3 catches a variant"
- **Commit:** af6c9568efe3f9cbf2503a8d9b3086fd8b240167

### CL1.1. A family is censored exactly when a recorded loss names it

- **Property:** A family is censored exactly when a recorded loss names it, and its reason names the loss kind; a family holding several kinds names each kind once, sorted, in either of the orders the suite gives them.
- **Code:** `evaluateQuality` in `lib/scan-report-v2-evaluators.ts`.
- **Domain:** Every subset of the evidence families with each loss kind; every non-empty set of loss kinds in one family, in the order listed and reversed.
- **Bounds:** none beyond those subsets.
- **Axioms:** none
- **Method:** exhaustive
- **Tests:**
  - `lib/fv-coverage-loss.test.ts`: "CL1: a family is censored exactly when a recorded loss names it, over every family subset and kind"
  - `lib/fv-coverage-loss.test.ts`: "CL1: a family's reasons name every kind of loss it holds, once, in any order"
- **Variants:**
  - `lib/fv-coverage-loss.test.ts`: names beginning "CL1 catches a variant"
  - `lib/fv-coverage-loss.test.ts`: "CL1 catches a variant: only the first kind of loss is named"
- **Commit:** af6c9568efe3f9cbf2503a8d9b3086fd8b240167

### CL1.2. More loss never uncensors

- **Property:** Adding the loss of a further capture-loss contract detail never uncensors a family: after each addition, a family is censored exactly when some recorded entry names it.
- **Code:** `evaluateQuality` in `lib/scan-report-v2-evaluators.ts`.
- **Domain:** Subsets of the capture-loss detail contract, each with a further detail added.
- **Bounds:** subsets of up to 3 details, each with a further detail added.
- **Axioms:** none
- **Method:** bounded
- **Tests:**
  - `lib/fv-coverage-loss.test.ts`: "CL1: more loss never uncensors, over subsets of up to 3 contract details plus one"
- **Variants:**
  - `lib/fv-coverage-loss.test.ts`: "CL1 catches a variant: a third loss uncensors"
- **Commit:** af6c9568efe3f9cbf2503a8d9b3086fd8b240167

### CL1.3. More loss never clears a run failure

- **Property:** More loss never removes a run failure reason other than an empty load, and only a request loss can move an empty load from failed to complete. An empty load leaves the reasons when a recorded request loss explains it, or when a loss that fails the run itself replaces it with its own reason, as a page-subject-validity loss does though it is not a request loss; the run then stays failed. That carve-out is pinned: a run's outcome alone is not monotone in loss.
- **Code:** `evaluateQuality` in `lib/scan-report-v2-evaluators.ts`.
- **Domain:** Bounded over contract details; crossed with every run fact the suite builds. Sampled over the navigation status, a status of 200, 404 or none, and the requests observed, none or a single request. Exhaustive over a bot wall title or not, a settled navigation or not, and the request-capture budget exhausted or not.
- **Bounds:** a subset of at most 1 detail, with a further detail added.
- **Axioms:** none
- **Method:** exhaustive, bounded, sampled
- **Not claimed:** Which loss may take an empty load away while the run stays failed. The test lets an empty load go whatever loss is added, so it would also pass a loss of another family that dropped the empty load and failed the run for a reason of its own.
- **Tests:**
  - `lib/fv-coverage-loss.test.ts`: "CL1: more loss never clears a run failure, over every run fact crossed with up to 2 details"
  - `lib/fv-coverage-loss.test.ts`: "CL1 carve-out: a run's outcome alone is not monotone, because a request loss explains an empty load"
- **Variants:**
  - `lib/fv-coverage-loss.test.ts`: names beginning "CL1 catches a variant"
- **Commit:** af6c9568efe3f9cbf2503a8d9b3086fd8b240167

### CL2. A censored family blocks exactly its metrics

- **Property:** Every metric is blocked exactly by its own censored sources, in the v2 and the r2 evaluators; censoring adds no reason of its own, and a metric is eligible exactly when it has no reason.
- **Code:** `evaluateComparability` in `lib/scan-report-v2-evaluators.ts` and `evaluateComparabilityR2` in `lib/scan-report-v2-r2-evaluators.ts`.
- **Domain:** Exhaustive over every pair of censoring patterns over the evidence families, baseline and variant, for every metric family. Sampled over the comparison fixtures the suite builds, on each of which the pairs are walked.
- **Bounds:** none beyond that product.
- **Axioms:** none
- **Method:** exhaustive, sampled, restatement
- **Not claimed:** Each metric's sources are spelled out in the test, which holds `METRIC_EVIDENCE_SOURCES` in `lib/metric-evidence-sources.ts` equal to them; a source wrongly assigned in both places is not seen.
- **Tests:**
  - `lib/fv-coverage-loss.test.ts`: "CL2: every metric is blocked exactly by its own censored sources, over every pair of censoring patterns"
- **Variants:**
  - `lib/fv-coverage-loss.test.ts`: names beginning "CL2 catches a variant"
  - `lib/fv-coverage-loss.test.ts`: "CL2 catches a variant: the r2 evaluator loses the base evaluator's consent reasons"
- **Commit:** af6c9568efe3f9cbf2503a8d9b3086fd8b240167

### CL4. Every loss an obligation names is a contract detail

- **Property:** Every loss an obligation names is a capture-loss contract detail, under a family that detail allows.
- **Code:** the obligation registries in `lib/detector-obligations.ts`, with `isKnownCaptureLossDetail` and `captureLossDetailAllowsFamily` in `lib/capture-loss-detail-contract.ts`.
- **Domain:** Every loss named by an obligation in each obligation registry: the historical v1, the historical v2 and the current.
- **Bounds:** none beyond those registries.
- **Axioms:** none
- **Method:** exhaustive
- **Tests:**
  - `lib/fv-coverage-loss.test.ts`: "CL4: every loss an obligation names is a contract detail under a family it allows, in all three contracts"
- **Variants:**
  - `lib/fv-coverage-loss.test.ts`: names beginning "CL4 catches a variant"
  - `lib/fv-coverage-loss.test.ts`: "CL4 catches a variant: the contract moves a detail to another family"
- **Commit:** af6c9568efe3f9cbf2503a8d9b3086fd8b240167

### F1-H. The finite-check harness refuses what it should

- **Property:** `holds` names the property and the input and builds the input only on failure; `assertCaughtBy` accepts only a counterexample for the named property, and refuses a variant the check passes, one caught for another property, and one that breaks the check itself; `loadVariant` applies its edits to a separate instance, resolves the variant's own imports, keeps a replacement literal, and refuses an edit that does not land exactly once.
- **Code:** `lib/finite-check.ts`.
- **Domain:** The cases its test file writes out.
- **Bounds:** none beyond those cases.
- **Axioms:** none
- **Method:** sampled
- **Tests:**
  - `lib/finite-check.test.ts`: "holds names the property and the input, and builds the input only on failure"
  - `lib/finite-check.test.ts`: "assertCaughtBy returns the counterexample only for the named property"
  - `lib/finite-check.test.ts`: "assertCaughtBy refuses a variant the check passes"
  - `lib/finite-check.test.ts`: "assertCaughtBy refuses a variant caught for another property"
  - `lib/finite-check.test.ts`: "assertCaughtBy refuses a variant that breaks the check instead of a property"
  - `lib/finite-check.test.ts`: "loadVariant applies its edit to a separate instance and leaves production alone"
  - `lib/finite-check.test.ts`: "loadVariant resolves the variant's own imports"
  - `lib/finite-check.test.ts`: "loadVariant keeps a replacement literal, including replacement patterns"
  - `lib/finite-check.test.ts`: "loadVariant refuses an edit that does not land exactly once"
- **Variants:** none: each case tests a refusal or an acceptance of the harness directly.
- **Commit:** af6c9568efe3f9cbf2503a8d9b3086fd8b240167

## Claims from F2: warning fragments

### CL6. Which warning lines each loss predicate reads

- **Property:** Every loss predicate reads exactly its pinned lines; a predicate reads its line placed first or last among all the others, and nothing from the other lines; a comparison's label keeps every substring reading and hides a whole line from the predicates that read whole lines; every predicate has a pinned row, and every row reads something.
- **Code:** the loss predicates in `lib/comparison-eligibility.ts`.
- **Domain:** Exhaustive over every fixed line the public-string policy admits. Sampled over the dynamic forms the suite writes out for its patterns: counts 1, 2 and 1000, the status lines at the statuses the suite lists, one URL for the blocked-request and policy forms, both consent modes, every consent outcome and every catalogued banner. The patterns admit lines beyond these, so the admitted set is unbounded: the suite's phrase "every admitted line" reads as this domain. The forms are held both ways: each must be admitted, and the pattern version they were written against is pinned. The one consent form left out is pinned as refused.
- **Bounds:** none beyond the fixed lines and the written-out forms.
- **Axioms:** none
- **Method:** exhaustive, sampled
- **Not claimed:** `runHitRequestCap`'s count of requests, which reads no warning; `runHitRequestRecordingCap` in `lib/scan-report-views.ts`, which restates one fragment; the producer ever writing these lines at the right moment. Of the plainly named variant tests, the new admitted line and the new predicate plant an input or a table entry, not a code variant.
- **Tests:**
  - `lib/fv-warning-fragments.test.ts`: "the domain is what the policy admits, under the pattern version its forms were written against"
  - `lib/fv-warning-fragments.test.ts`: "the one consent click form left out of the domain is one the policy refuses"
  - `lib/fv-warning-fragments.test.ts`: "every consent outcome and every catalogued banner is in the domain"
  - `lib/fv-warning-fragments.test.ts`: "every predicate has a pinned row, and every row reads something"
  - `lib/fv-warning-fragments.test.ts`: "CL6: every predicate reads exactly its pinned lines, over every admitted line"
  - `lib/fv-warning-fragments.test.ts`: "CL6: a predicate reads its line anywhere in a run, and nothing from the others"
  - `lib/fv-warning-fragments.test.ts`: "CL6: a comparison's label keeps every substring reading and hides a whole line"
- **Variants:**
  - `lib/fv-warning-fragments.test.ts`: names beginning "CL6 catches a variant"
  - `lib/fv-warning-fragments.test.ts`: "CL6 catches a new admitted line a fragment would silently read"
  - `lib/fv-warning-fragments.test.ts`: "CL6 catches a new predicate with no pinned row"
  - `lib/fv-warning-fragments.test.ts`: "CL6 catches a variant: a whole-line predicate starts reading substrings"
- **Commit:** 8cd96197eb96efc3dcd38efbb7dbf18876ec0093

## Claims from F5: the case machine, its purge slice and the fold

The case exploration walks the private workspace's case machine and its fold
as they stand in the public repository, over synthetic fixtures. Its docblock
lists each property with its domain, method and the variants it must catch.
These rows quote those properties as the walk module names them, grouped by
the test that holds them.

### F5-M. The machine over the full promised plan

- **Property:** On every reachable state: "every state the walk reaches lies inside the domain its key encodes"; "each event is accepted exactly when the rule W2 states for it holds"; "an accepted event changes exactly the fields W2's rule for it names, to the values it names"; "retry counters are what the accepted events count, and stay within their caps"; "the gate and the rule hold what the accepted events made them, and a closed case keeps no gate"; "a case is closed exactly when no slot is planned or running, and a slot closed unstarted carries the configuration in force"; "a closed case never reopens: its closure never changes, and nothing but cleanup changes after it"; "the baseline rule, once recorded, never changes"; "cleanup changes only by the events that name it, and reconcile reads what it states"; "a begun attempt ran under the configuration in force when it began, and that never changes"; "denominatorOf agrees with the phases"; "isTerminal agrees with closed and no cleanup pending"; "continuationOf agrees with an open case and its unresolved cleanup"; "at most one attempt runs"; "an arm never changes"; "instrumented waits on baseline's rule, and begins under the configuration it was met under"; "a terminal attempt never reopens"; "continuation blocks on unresolved cleanup"; "unresolved cleanup changes no acquisition"; "a purge answers as the restated reducer does on the closed flag and the manifest, and changes nothing else, and nothing else reads the manifest"; "an event from an actor the rule does not allow is refused"; "the actors a rule allows get the same answer"; "a visit begins only on a met control for the configuration in force, or on the owner's exception for it"; "an exception is recorded only for a visit that has not begun"; "the exploratory mark is on exactly when an exception was recorded"; "without the purge slice, no event returns to a state"; "every sink is terminal"; "a supervisor's event is accepted from every non-terminal state".
- **Code:** `plannedState`, `step`, `denominatorOf`, `isTerminal` and `continuationOf` in `investigation/core/case-machine.ts`, `applyRecordEvent` in `investigation/core/evidence-model.ts` and `purgeStep` in `investigation/core/purge.ts`, against the restatements in `investigation/test/case-exploration-walk.ts`.
- **Domain:** Every state the machine reaches from the promised plan, slots B1 to B3 and I1 to I3, over the suite's event alphabet: each event the plan's rules name, from the actor its rule names. Evidence records, purge events, other keys and digests, and events from other actors are left out of the walk; on every reachable state the authority probes send each body, evidence records and purge events among them, from each actor its rule does not allow. A purge is held on each state with no manifest, every path listed and present, and every path listed and absent.
- **Bounds:** caps of 2 control misses, 2 start retries and 1 configuration change; the walk stops with an error at twice its pinned state count.
- **Axioms:** none
- **Method:** reachable states, restatement
- **Not claimed:** Any wall-clock bound; any slot subset not walked; evidence ids in this walk; identities or digests beyond the fold instances; more than one row per slot; any symmetry. Termination assumes that alarms arrive eventually and the store eventually accepts a write, which is not checked. That a supervisor's event is accepted is a claim of the machine, not of the log. A worker thread that computes the right count and digest without holding the properties is outside what the range checks see.
- **Tests:**
  - `investigation/test/case-exploration.test.ts`: "the six-slot plan: every reachable state, under every machine property"
- **Variants:**
  - `investigation/test/case-exploration.test.ts`: names beginning "the machine walk catches"
- **Commit:** 7cf121cee94561716bbf337b7c1ab34d376ed9c3

### F5-S. The scenario plans and small plans

- **Property:** The machine properties of F5-M hold on each smaller plan, walked whole, and on those plans each closed state answers a purge as the restated reducer does with every manifest the slice reaches.
- **Code:** `plannedState` and `step` in `investigation/core/case-machine.ts`, `applyRecordEvent` in `investigation/core/evidence-model.ts` and `purgeStep` in `investigation/core/purge.ts`.
- **Domain:** Every reachable state of the scenario plans I1 to I3 and B1 to B3, of the plan B1 and I1, and of the plan B1, B2, I1 and I2, each a separate instance.
- **Bounds:** the caps of F5-M.
- **Axioms:** none
- **Method:** reachable states, restatement
- **Tests:**
  - `investigation/test/case-exploration.test.ts`: "the scenario plans and two small plans, every machine property, each closed state paired with every manifest the slice reaches"
- **Variants:**
  - `investigation/test/case-exploration.test.ts`: names beginning "the machine walk catches"
- **Commit:** 7cf121cee94561716bbf337b7c1ab34d376ed9c3

### F5-P. The purge slice

- **Property:** "purgeStep answers as the restated reducer does, accepting exactly when it does, with its refusal and its manifest"; "SUMMARY_ONLY holds exactly when a manifest exists and every path on it reads absent".
- **Code:** `purgeStep` and `retentionTier` in `investigation/core/purge.ts`, against the restatement in `investigation/test/case-exploration-walk.ts`.
- **Domain:** Every state `purgeStep` reaches from no manifest, open and closed, over the events of `purgeSliceAlphabet`: each subset of the paths in `PURGE_PATHS` in one order as a manifest, one manifest repeating a path, and each path, listed or the `UNLISTED` one, read absent or remaining.
- **Bounds:** the paths in `PURGE_PATHS`.
- **Axioms:** none
- **Method:** reachable states, restatement
- **Not claimed:** The slice's statuses cycle, and the test asserts only that its graph has a cycle. The separation from the machine rests on the reducer's signature, held by F5-R5.
- **Tests:**
  - `investigation/test/case-exploration.test.ts`: "the purge slice: every state purgeStep reaches from no manifest, open and closed, over three paths"
- **Variants:**
  - `investigation/test/case-exploration.test.ts`: names beginning "the purge slice catches"
- **Commit:** 7cf121cee94561716bbf337b7c1ab34d376ed9c3

### F5-F. The fold over its instances

- **Property:** "every fold state the walk reaches has a key, and each state it adds is held whole by its key"; "SUMMARY_ONLY implies every digest the log names is kept by the owner or listed and confirmed absent"; "nothing is both kept and listed" and "a digest a row names as raw never becomes kept", by the shadow and by the case's own kept objects; "a manifest subset walked here is taken exactly when it is what rows and controls named, less what the owner keeps"; "an empty manifest is taken only when no attempt began"; "raw-object-cannot-be-kept is heard exactly when an owner's event would start keeping a raw digest, or a listed path once a manifest exists, and nothing else refuses it first"; "the genuine paths stay reachable"; "a fold entry from an actor the rule does not allow is refused"; "a visit begins only on a control met under the identity in force, or on the owner's exception for it"; "a visit's basis on record is the exception when one was pending for it, and the control otherwise"; "a row is recorded late exactly when its attempt had ended"; "a row is taken exactly when its attempt began, its id is unused and no manifest exists"; "a patch is taken exactly when none was and the visit it names ended, where no raw digest or listed path is involved"; "a case is planned once".
- **Code:** `foldEntry` in `investigation/core/case-store.ts` and `applyRecordEvent` in `investigation/core/evidence-model.ts`, against the restatements in `investigation/test/case-exploration-walk.ts`.
- **Domain:** Every state `foldEntry` reaches from case-planned on B1 and B2 (each fold property is held on every state the walk adds, as its key rebuilds it; see Not claimed), over the suite's fold alphabet, in each fold instance (`FOLD_TWO`, `FOLD_PAIR` and `FOLD_THREE`), each with an enumerated identity set and nothing beyond it.
- **Bounds:** the identities and digests of each instance; one row per slot.
- **Axioms:** none
- **Method:** reachable states, restatement
- **Not claimed:** Captures and other finishes, deadlines, reconcile, other cleanup events, retries, the instrumented slots and the rule, which the fold alphabet leaves out; any identity or digest beyond the instances. That a state the walk merges into a key it already added is held whole by that key: the walk compares a state with what its key rebuilds only when it adds the state, a new key or a split, and holds every other property on what the key rebuilds, so a fold defect the key cannot hold, on an interleaving whose twin the walk added first, passes them all.
- **Tests:**
  - `investigation/test/case-exploration.test.ts`: `the fold, ${name}: every state foldEntry reaches, under every fold property`
- **Variants:**
  - `investigation/test/case-exploration.test.ts`: names beginning "the fold walk catches"
- **Commit:** 7cf121cee94561716bbf337b7c1ab34d376ed9c3

### F5-E. The fold's pure entry gives the store path's state

- **Property:** Folding the whole synthetic case through `foldEntry` gives the same state as running it through `runCommand` on memory stores.
- **Code:** `foldEntry` and `runCommand` in `investigation/core/case-store.ts`.
- **Domain:** The one synthetic case the test folds.
- **Bounds:** none beyond that case.
- **Axioms:** none
- **Method:** sampled
- **Tests:**
  - `investigation/test/case-exploration.test.ts`: "the fold's pure entry gives the store path's state on the whole synthetic case"
- **Variants:** none: the test compares the exported entry with the store path it was taken from.
- **Commit:** 7cf121cee94561716bbf337b7c1ab34d376ed9c3

### F5-U. Positions in UTF-16 columns

- **Property:** A position falls in a range only after conversion, with columns in UTF-16 code units on both sides.
- **Code:** `readExecutionJoin` in `investigation/core/readings.ts`.
- **Domain:** Exhaustive over every start, end and offset over the code units of one inline script, in the one document the suite writes out, which holds a character outside the BMP; that document is the suite's sample.
- **Bounds:** none beyond that document.
- **Axioms:** none
- **Method:** exhaustive, sampled
- **Not claimed:** That the same stack read in code points lands wrong is shown too; that changes the test's input and is not a variant.
- **Tests:**
  - `investigation/test/case-exploration.test.ts`: "UTF-16 columns: positions read off a document holding a character outside the BMP, in code units on both sides"
- **Variants:** none: the test holds its own variant inside it, production's first-line column off by one.
- **Commit:** 7cf121cee94561716bbf337b7c1ab34d376ed9c3

### F5-H. The exploration checks itself

- **Property:** The per-state checks give the same answer, and the same first counterexample, on one thread and across many; the worker pool and the range checks fail on each fault planted in the real worker with a message that names it; the machine walk stops at its state bound with a message that says so; the caps the suite states are production's; the keys refuse the states the tests write out as outside their domain and rebuild the ones they accept; every machine and fold property has a variant caught by that property with the others off, the domain and the caps aside; the suite's threads saw no answer that no job was waiting for.
- **Code:** the walks, keys and pool in `investigation/test/case-exploration-walk.ts`, `investigation/test/case-exploration-worker.ts`, `investigation/test/case-exploration-plant-worker.ts` and `investigation/test/case-exploration.test.ts`, and the caps in `investigation/core/case-machine.ts`.
- **Domain:** The plans, variants, planted faults and states the tests write out.
- **Bounds:** none beyond those cases.
- **Axioms:** none
- **Method:** sampled
- **Tests:**
  - `investigation/test/case-exploration.test.ts`: "the per-state checks give the same answer, and the same first counterexample, on one thread and across many"
  - `investigation/test/case-exploration.test.ts`: "the pool and the range checks fail on each fault planted in the real worker, with a message that names it, not by timeout"
  - `investigation/test/case-exploration.test.ts`: "the machine walk stops at its state bound, with a message that says so"
  - `investigation/test/case-exploration.test.ts`: "the caps this file states are production's"
  - `investigation/test/case-exploration.test.ts`: "the key refuses a state outside its domain, and rebuilds every state it accepts"
  - `investigation/test/case-exploration.test.ts`: "the fold's key refuses what it could not rebuild"
  - `investigation/test/case-exploration.test.ts`: "every machine property has a variant it alone catches, the domain and the caps aside, which are always on"
  - `investigation/test/case-exploration.test.ts`: "every fold property has a variant it alone catches"
  - `investigation/test/case-exploration.test.ts`: "the suite's threads saw no answer that no job out was waiting for"
- **Variants:** none: each test plants the fault it refuses, or compares the suite's statement with production's.
- **Commit:** 7cf121cee94561716bbf337b7c1ab34d376ed9c3

## Claims from W2 that F5 rests on

These rows hold the plan's properties on readings, joins and the purge
reducer's signature. Their tests landed with W2, and the F5 suite names them in
its table.

### F5-R1. A positive observation stays observed

- **Property:** A positive count stays observed under every limit; an empty count speaks only of its window, at the granularity reported; no record, a truncation and an out-of-scope window never read absent; complete is withheld unless every condition holds; a row is read in its own attempt, by its own instrument.
- **Code:** `readObservation` in `investigation/core/readings.ts` and `readRow` in `investigation/core/evidence-model.ts`.
- **Domain:** Exhaustive over the full product of the observation's axes the suite spells out (record present or absent, block or function only, the window's end reason, scope, completeness, cleanup state and the operation's outcome), and the combinations `readRow` takes. Sampled for the count, which takes representatives.
- **Bounds:** counts as representatives, not every count.
- **Axioms:** none
- **Method:** exhaustive, sampled, restatement
- **Tests:**
  - `investigation/test/readings.test.ts`: "every observation, over the full product of its axes, reads as a table spelled out here"
  - `investigation/test/readings.test.ts`: "a reading's vocabulary has no word for absent, and a 0 says only what it can"
  - `investigation/test/evidence-model.test.ts`: "a row is read in its own attempt, by its own instrument"
- **Variants:**
  - `investigation/test/readings.test.ts`: names beginning "observations catch"
- **Commit:** 3fef1027f8024eddcee58d19abee7f248bf8d80c

### F5-R2. A join needs every condition

- **Property:** A join needs the same attempt, target, frame and loader, and each other condition; an unmet condition is no join, with its reason; equal attempt ids alone never link.
- **Code:** `readExecutionJoin` in `investigation/core/readings.ts`.
- **Domain:** Exhaustive over every subset of the conditions the suite's `BREAKS` breaks. Sampled over the ways to break a condition: each is broken the one way the suite writes out.
- **Bounds:** none beyond those subsets.
- **Axioms:** none
- **Method:** exhaustive, sampled
- **Tests:**
  - `investigation/test/readings.test.ts`: "every subset of broken conditions names exactly those conditions, and equal attempt ids alone never link"
- **Variants:**
  - `investigation/test/readings.test.ts`: names beginning "joins catch"
- **Commit:** 3fef1027f8024eddcee58d19abee7f248bf8d80c

### F5-R3. Script identity, time and the words a join can say

- **Property:** Script identity goes by id where present, else by URL, start and digest unique in the inventory, and a repeated URL is ambiguous; an id on one side only must be held by an inventory entry that places it at the range; a time falls inside the armed window, or the declared uncertainty across clocks; a met join reads `position_consistent`, never caused.
- **Code:** `readExecutionJoin` in `investigation/core/readings.ts`.
- **Domain:** The fault cases the test writes out, compared as whole JSON, and the worded cases.
- **Bounds:** none beyond those cases.
- **Axioms:** none
- **Method:** sampled
- **Not claimed:** The one-sided placement rule, its cases and the variants that hold it landed later, in the commit whose subject begins Place a one-sided script id at the range, which changed the rule; at this row's Commit the test expected `position_consistent` for an id held by an entry naming nothing else.
- **Tests:**
  - `investigation/test/readings.test.ts`: "each condition of a join, alone, gives no join with that reason, and the boundaries fall where stated"
  - `investigation/test/readings.test.ts`: "the only words a join can say"
- **Variants:**
  - `investigation/test/readings.test.ts`: names beginning "joins catch"
- **Commit:** 3fef1027f8024eddcee58d19abee7f248bf8d80c

### F5-R4. A position falls in a range only after conversion

- **Property:** A position falls in a range only after conversion: a stack one-based, a range zero-based with an exclusive end, an inline script's `resource_start` applied.
- **Code:** `readExecutionJoin` in `investigation/core/readings.ts`.
- **Domain:** Sampled over the grid: the suite's written-out script starts and ranges, each against every position the grid sweeps, read through a restated ordering. Exhaustive over every range of an inline script read off the one ASCII document the suite writes out, against every offset. Sampled over the boundaries of a range spelled out.
- **Bounds:** none beyond those cases.
- **Axioms:** none
- **Method:** exhaustive, sampled, restatement
- **Tests:**
  - `investigation/test/readings.test.ts`: "positions on a grid fall in or out of a range as a plain ordering says, on the first line of an inline script and after it"
  - `investigation/test/readings.test.ts`: "positions read off a real document's text, not off arithmetic: every range of an inline script, against offsets"
  - `investigation/test/readings.test.ts`: "the boundaries of a range, spelled out, on an inline script's first line"
- **Variants:**
  - `investigation/test/readings.test.ts`: names beginning "joins catch"
- **Commit:** 3fef1027f8024eddcee58d19abee7f248bf8d80c

### F5-R5. The purge reducer reads only the closed flag, the manifest and the event

- **Property:** `purgeStep` takes exactly the closed flag, the manifest and the event, and its answer reads nothing else; the separate purge slice of F5-P rests on this.
- **Code:** `purgeStep` in `investigation/core/purge.ts`.
- **Domain:** The reducer's declared parameters, read from its parse, and the slice check the test runs.
- **Bounds:** none beyond that signature.
- **Axioms:** none
- **Method:** sampled
- **Tests:**
  - `investigation/test/purge.test.ts`: "the reducer's signature is the closed flag, the manifest and the event, and its answer reads nothing else"
- **Variants:** none: widening the signature fails the test.
- **Commit:** 3fef1027f8024eddcee58d19abee7f248bf8d80c

## Claims from the IPv4 address classifier

`lib/ip-safety.ts` decides which addresses a scan may connect to. These rows
hold its IPv4 rule to a table the suite writes out by hand, `NON_PUBLIC_BLOCKS`
with `REACHABLE_EXCEPTIONS`, from the IANA registries and the RFC each line
names. By the table an address is public exactly when it lies in no block, or
lies in an exception. The classifier and the table differ on the exceptions,
which are outside each row here and pinned open as OPEN-IP4.1.

### IP4-T. An address reads as the table says

- **Property:** An IPv4 address reads public exactly when the suite's table says it is public, and each such dotted quad is an address. The table is well formed: each line starts its own block, the limited broadcast address is the reserved block's last, each exception lies inside a block, no reachable line touches a block, and the table read by prefix agrees with the table read by address.
- **Code:** `isPublicIpAddress` and `isIpAddress` in `lib/ip-safety.ts`.
- **Domain:** IPv4 addresses written as a dotted quad of decimal octets. Exhaustive over each prefix that leaves out an address's last octet, at the lowest last octet, the highest, and the value `movingOctet` gives that prefix; and over each value of the last octet for each prefix in `EDGE_PREFIXES`, the prefixes that hold a table line's first or last address or the address just outside either end. Sampled for the last octet of a prefix outside `EDGE_PREFIXES`: the walk reads those values of it and no others, so this row does not walk the whole IPv4 space. The addresses of `REACHABLE_EXCEPTIONS` are left out.
- **Bounds:** none beyond those enumerations.
- **Axioms:** none
- **Method:** exhaustive, sampled
- **Not claimed:** That the table is the registries'. It was written by hand, no test holds it to a registry, and a block it lacks or misstates is not seen. Any address read at a last octet the walk does not take, away from the table's edges; IP4-F holds the classifier's text there and says what that leaves out. Any IPv6 address: `lib/ip-safety.test.ts` and `lib/serious-use-audit-fixes.test.ts` hold IPv6 by written-out cases, and no row here does. That a caller asks the classifier, or what a resolver answers.
- **Tests:**
  - `lib/fv-ipv4-classifier.test.ts`: "the table is well formed: each line starts its own block, one block lies inside another, each exception lies inside a block, and no reachable line touches a block"
  - `lib/fv-ipv4-classifier.test.ts`: "IP4: every address of every prefix at an edge of a table line reads as the table says, over every fourth octet"
  - `lib/fv-ipv4-classifier.test.ts`: "IP4: every prefix of three octets reads as the table says at the lowest fourth octet, the highest and one that moves with the prefix"
- **Variants:**
  - `lib/fv-ipv4-classifier.test.ts`: names beginning "IP4 catches a variant:"
  - `lib/fv-ipv4-classifier.test.ts`: names beginning "IP4 catches a variant no edge prefix holds"
  - `lib/fv-ipv4-classifier.test.ts`: "every block of the table has a variant that removes it"
  - `lib/fv-ipv4-classifier.test.ts`: "every block of the table has a variant that moves each end that parts public from non-public"
- **Commit:** 86e139ca6a01854841bedeb9622e72bff04878bd

### IP4-F. The classifier's text names no last octet

- **Property:** The classifier's emitted text names its octets where it makes them and where it takes those before the last, and names its argument where it splits it, and nowhere else.
- **Code:** `isPublicIpv4` in `lib/ip-safety.ts`, as the unit suite compiles it.
- **Domain:** The one emitted text of that function, read for the names `octets`, `address` and `arguments`.
- **Bounds:** none beyond that text.
- **Axioms:** none
- **Method:** sampled
- **Not claimed:** That the classifier's answer does not depend on the last octet. This is a check of text, a change detector for one shape: a read of the last octet by a spelling it does not look for, outside that function or through a helper, passes it, and a test below plants one such fault and shows that this check and the edge walk both pass it.
- **Tests:**
  - `lib/fv-ipv4-classifier.test.ts`: "IP4: the emitted classifier names its octets once to take the first three, and its argument once to split it"
  - `lib/fv-ipv4-classifier.test.ts`: "the text check passes a fault it does not look for, which is what it leaves out"
- **Variants:**
  - `lib/fv-ipv4-classifier.test.ts`: names beginning "IP4 catches a variant of the emitted text"
- **Commit:** 86e139ca6a01854841bedeb9622e72bff04878bd

### IP4-S. Which spellings are an address

- **Property:** Handed over directly, the dotted quad of decimal octets with no leading zero is an address, with or without a trailing dot, and reads as the table says. Each other spelling of that address the suite builds, and an octet past its range, is no address and never reads public. In brackets, or with a further character before or after it, a quad reads as the address it then names, or as none.
- **Code:** `isPublicIpAddress`, `isIpAddress` and `normalizeHostname` in `lib/ip-safety.ts`.
- **Domain:** Sampled over the addresses of `SAMPLE_ADDRESSES`: each table line's first and last address, the address outside each end, and the public addresses in `PUBLIC_SAMPLES`. Exhaustive, for each of those, over the spellings `spellingsOf` builds, which are each split into parts that inet_aton accepts with each part in each radix of `RADIXES`, with and without a trailing dot; over the bracketed forms the suite writes out; and over each character of `DECORATIONS` placed before the quad and after it. The octets past their range are those in `PAST_RANGE`.
- **Bounds:** none beyond those enumerations; a decoration is a single character at either end.
- **Axioms:** none
- **Method:** exhaustive, sampled, restatement
- **Not claimed:** The bracketed and decorated part restates `normalizeHostname` and the classifier's own comment on leading zeros, so it catches drift from them. A spelling outside these: a longer decoration, a character inside the quad, a radix spelled another way.
- **Tests:**
  - `lib/fv-ipv4-classifier.test.ts`: "IP4: only four decimal octets with no leading zero are an address, and every other spelling of the sample is none and never public"
  - `lib/fv-ipv4-classifier.test.ts`: "IP4: a dotted quad in brackets, with a trailing dot or with one further character reads as the address it then names, or as none"
- **Variants:**
  - `lib/fv-ipv4-classifier.test.ts`: names beginning "IP4 catches a variant of the reader"
  - `lib/fv-ipv4-classifier.test.ts`: names beginning "IP4 catches a variant of the wrapping"
- **Commit:** 86e139ca6a01854841bedeb9622e72bff04878bd

### IP4-U. A literal host of a URL is refused when the table says so

- **Property:** As the host of an http or https URL, a spelling of an IPv4 address, or a compressed IPv4-mapped spelling of it, is refused as a private target exactly when the table says the address is not public; and the URL parser of the Node that runs the suite reads each spelling as its address.
- **Code:** `assertPublicHttpUrlShape` in `lib/url-safety.ts`.
- **Domain:** Sampled over the addresses of `SAMPLE_ADDRESSES`, less those of `REACHABLE_EXCEPTIONS`. Exhaustive, for each of those, over the spellings `spellingsOf` builds, with and without a trailing dot, and the bracketed mapped spellings the suite writes out, each under both schemes.
- **Bounds:** none beyond those enumerations.
- **Axioms:** A caller parses its URL with the parser of the Node that runs the suite. The test checks that parser's reading of each spelling, and no other parser's.
- **Method:** exhaustive, sampled
- **Not claimed:** A host that is no literal, which a caller resolves and then asks the classifier about; the proxy's own path to the classifier in `lib/public-scan-proxy.ts`; a redirect.
- **Tests:**
  - `lib/fv-ipv4-classifier.test.ts`: "IP4: through a URL, every spelling of the sample is refused exactly when the table says its address is not public"
- **Variants:**
  - `lib/fv-ipv4-classifier.test.ts`: names beginning "IP4 catches a variant of the URL entry"
- **Commit:** 86e139ca6a01854841bedeb9622e72bff04878bd

### IP4-M. An IPv6 literal that carries an IPv4 address

- **Property:** A compressed IPv4-mapped spelling reads as the table says of the IPv4 address it carries; and each other embedding the suite writes out reads public for no address the table says is not public.
- **Code:** `isPublicIpAddress` in `lib/ip-safety.ts`.
- **Domain:** For the mapped spellings, dotted and in hexadecimal words: exhaustive over each address of each prefix in `EDGE_PREFIXES` and over each value of an address's upper half with each octet of its lower half at its lowest and its highest; and the further mapped spellings of `mappedSpellings` over `SAMPLE_ADDRESSES`. For the other embeddings: the spellings of `embeddedSpellings` over the addresses of `SAMPLE_ADDRESSES` the table says are not public. The addresses of `REACHABLE_EXCEPTIONS` are left out.
- **Bounds:** none beyond those enumerations.
- **Axioms:** none
- **Method:** exhaustive, sampled
- **Not claimed:** The IPv6 space. An embedding the suite does not write out. What an embedding of a public address reads: the row holds only that an embedding of a non-public address does not read public.
- **Tests:**
  - `lib/fv-ipv4-classifier.test.ts`: "IP4: an IPv4-mapped spelling reads as the address it carries, and no other embedding of a non-public address reads public"
- **Variants:**
  - `lib/fv-ipv4-classifier.test.ts`: names beginning "IP4 catches a variant of the IPv6 carriers"
- **Commit:** 86e139ca6a01854841bedeb9622e72bff04878bd

## Claims from the report consistency rules

A report's headline and its findings board are computed apart, and
`lib/report-consistency.ts` holds rules between them and the facts. These rows
hold those rules over a product of visits the suite builds. The product is not
the set of reports a scan can make: it is the suite's own lists, crossed. The
walk first found classes of visit on which a rule fired. They were fixed in the
report facts, and RC-A holds the activity slice with them in it.

### RC. No consistency rule fires over the product of visits

- **Property:** On each view of the suite's product, the facts, the headline and the findings board built for the arm that headline focuses break no rule of `reportConsistencyViolations`: no fingerprint story without fingerprint activity, no cookie absence beside a recorded cookie of another site, no calm headline over a warn or loud card or an alert bottom line, no absent services card beside a named operator, no categorical absence under a closed fact gate, no unscoped absence lead under a closed fact gate, no error page's evidence put on the requested page, no single-visit headline above a card for the other visit, no services or platforms card, and no subhead that states the shown visit's cross-site counts, without that visit's phase note, and no comparison headline whose visits recorded different scanner actions without the caveat, and none with it where they match. A pair-scope headline is exempt from the phase-note rule: its subhead compares its visits' whole-visit totals, and the rule holds only the findings board to the note of the visit the board shows.
- **Code:** `buildReportFacts` in `lib/report-facts.ts`, `buildReportHeadline` in `lib/report-headline.ts`, `buildFindings` in `lib/report-findings.ts` and `reportConsistencyViolations` in `lib/report-consistency.ts`.
- **Domain:** Exhaustive over each slice's own product of the lists the suite writes out: `ACTIVITY` and `ACTIVITY_LEADS`, a visit on the v1 wire read by `viewFromV1Report`; `SUBJECT`, `LEGACY_GAPS`, `LEDGER` and `FAMILY_LOSS` crossed with `AVAILABILITY_VISITS`, where the r2 form is set on the view and made by no reader; `DESIGNS` crossed with `ARM` for each visit of a pair, joined by the comparison constructors of `lib/compare-reports.ts`; and `CONSENT` over the r2 consent fixture's pair. Sampled for the value that stands for each class, which the suite writes out; for each field no list names, which stays as the fixtures give it; and for pairings of classes across slices, which are not built.
- **Bounds:** none beyond those products.
- **Axioms:** none
- **Method:** exhaustive, sampled
- **Not claimed:** A report outside the product. A board ranked against corpus percentiles: each board here is built with no corpus. A published correction, a PageGraph import's own card, storage counts and same-organization ownership, which no list varies. That the rules are the right rules, or that a headline and a board that break none of them agree in other ways. The classes were chosen from the comparisons the facts, the headline and the cards for a single visit make; the board's comparison cards were not read branch by branch. A seeded fault is walked by `walkForFaults`, which leaves the `ACTIVITY` product out, so what else a fault fires is stated over those slices and nothing wider.
- **Tests:**
  - `lib/fv-report-consistency.test.ts`: "RC: no rule fires on any visit of the availability slice, whatever the page was and whatever the scan could not record"
  - `lib/fv-report-consistency.test.ts`: "RC: no rule fires on any pair the real comparison constructors join, over each design"
  - `lib/fv-report-consistency.test.ts`: "RC: no rule fires on the consent pair, over each choice state, gate and tracker"
- **Variants:**
  - `lib/fv-report-consistency.test.ts`: names beginning "RC catches a variant"
  - `lib/fv-report-consistency.test.ts`: "every rule has a seeded fault"
- **Commit:** bc1ff528b0e014a59e50b354ab3f6edc28b0fb8b

### RC-P. The phase note and the comparison caveat over the phase and typing classes

- **Property:** On each view of the suite's `PHASES` product and of its pairs over `DESIGNS` crossed with `TYPING`, the facts, the headline and the findings board built for the arm that headline focuses break no rule of `reportConsistencyViolations`, among them `count-phase-note-mismatch` and `pair-action-caveat`.
- **Code:** `runPhaseNotes` and `pairActionCaveat` in `lib/report-phase-note.ts`, `crossSitePhaseSplit` and `recordedScannerActions` in `lib/report-phase-split.ts`, `buildReportHeadline` in `lib/report-headline.ts`, `buildFindings` in `lib/report-findings.ts` and `reportConsistencyViolations` in `lib/report-consistency.ts`.
- **Domain:** Exhaustive over `PHASES`, an r2 single visit made from the r2 fixture whose counted rows the suite places in page load, partly or wholly in an active-probe phase, crossed with the services it names and a complete or censored request log; and over `DESIGNS` crossed with `TYPING` for each visit of a pair, joined by the comparison constructors of `lib/compare-reports.ts`. Sampled for the value that stands for each class, which the suite writes out, and for each field no list names, which stays as the fixtures give it.
- **Bounds:** none beyond those products.
- **Axioms:** none
- **Method:** exhaustive, sampled
- **Not claimed:** That a phase records why a request was made or what it carried. A report outside the product: an r2 comparison whose visits recorded different actions, a consent phase in `PHASES`, and a phase the walk does not place. That the notes say the right thing, or that a share text or share card the gate does not read carries them.
- **Tests:**
  - `lib/fv-report-consistency.test.ts`: "RC: no rule fires on any pair whose two visits carry each typing disclosure, over each design"
  - `lib/fv-report-consistency.test.ts`: "RC: no rule fires on a visit whose counted rows were recorded in page load, partly or wholly during the typing probe"
- **Variants:** none: the faults that break the phase note and the caveat are members of the family RC cites, names beginning "RC catches a variant", which held tests before this row's commit and so is cited by RC alone.
- **Commit:** 7f632fa7fefcd3b4e68894f38f777a9a91091741

### RC-A. The activity slice, with the classes the walk first found

- **Property:** On each view of the activity slice no rule of `reportConsistencyViolations` fires, the classes included on which `quiet-copy-over-loud-finding` fired before this commit: a policy that says cookies are not used beside a cookie of the site's own, and a consent platform's host that is the site's own. On the policy class the facts rank the count conflict and the headline is not calm; on the consent class the board holds no consent card and the bottom line is calm.
- **Code:** `policyFacts`, `signals.consentPlatform` and `observedSeverity` in `lib/report-facts.ts`, and the policy and consent cards of `buildFindings` in `lib/report-findings.ts`, which read those facts and make neither decision again.
- **Domain:** Exhaustive over the product of `ACTIVITY` and `ACTIVITY_LEADS`, a visit on the v1 wire read by `viewFromV1Report`. Sampled as RC states: the value that stands for each class is written out, and no class is paired with the other slices.
- **Bounds:** none beyond that product.
- **Axioms:** none
- **Method:** exhaustive, sampled
- **Not claimed:** What RC does not claim. That no other card decides from its own reading of the evidence: the decisions moved into the facts are the ones this walk found. A policy statement other than the count comparisons of `policyFacts`. How often either class occurs: rendered before and after this commit, the headline and board of each committed report read the same.
- **Tests:**
  - `lib/fv-report-consistency.test.ts`: "RC: no rule fires on any visit of the activity slice"
  - `lib/fv-report-consistency.test.ts`: "RC: a policy that says no cookies are used, beside a cookie of the site's own, is a conflict the facts rank, and the headline is not calm"
  - `lib/fv-report-consistency.test.ts`: "RC: a consent platform's host that is the site's own is no consent card, and the calm headline sits over a calm bottom line"
- **Variants:**
  - `lib/fv-report-consistency.test.ts`: "RC catches the facts no longer ranking a policy's count conflict"
  - `lib/fv-report-consistency.test.ts`: "RC catches the board looking for a consent platform among the site's own rows again"
- **Commit:** d62eabb4fc87f0a437a11aa050bcd5275c71c51a

### RC-H. The walk is the production path, and reaches the stories it lists

- **Property:** The walk's own composition of facts, headline, board and rules gives what `validateReportPresentation` gives; and the slices reach the headline stories the suite lists and no other.
- **Code:** `validateReportPresentation` in `lib/report-consistency.ts`, against `present` in `lib/fv-report-consistency.test.ts`.
- **Domain:** The views the test writes out at the slices' corners; and the stories the walks of RC gathered, which the test reads after them.
- **Bounds:** none beyond those cases.
- **Axioms:** none
- **Method:** sampled
- **Tests:**
  - `lib/fv-report-consistency.test.ts`: "the walk's own composition gives what validateReportPresentation gives, on the slices' corners"
  - `lib/fv-report-consistency.test.ts`: "the four slices above reached these headline stories, and no other"
- **Variants:** none: each test compares the walk with production, or with a list the suite writes out.
- **Commit:** bc1ff528b0e014a59e50b354ab3f6edc28b0fb8b

## Claims from the TLA+ specification

### TLA-CASE. The real case machine's transitions are the specification's

- **Property:** On each of the five plans, the real machine reaches the states the specification reaches, and on each of them accepts each event of the alphabet exactly when the specification does and leaves the state the specification leaves. TLC held each invariant of the specification's table on every state of each plan. The real purge reducer answers as the specification's on every pairing of the slice.
- **Code:** `specs/case-machine/CaseMachine.tla` and `specs/case-machine/PurgeSlice.tla`, against `investigation/core/case-machine.ts` and `investigation/core/purge.ts`.
- **Domain:** The plans of F5-M and F5-S and the slice of F5-P, over the same event alphabet and under the same caps, which a test holds to production's.
- **Bounds:** Those plans and caps.
- **Axioms:** none
- **Method:** model checked, reachable states, trace conformance
- **Not claimed:** Refusal reasons, evidence ids and the record events of `investigation/core/evidence-model.ts`, which the specification does not model. Three guards that the specification words as the rule text does and the code words otherwise; on these plans both give the same transitions, and nothing is said of another plan. The fold of F5-F, which is not specified. That the relations of the specification and the machine are the same edge by edge: they are compared by counts and a digest. That TLC ran at the commit that holds this file: the hosted workflow compares the committed export with TLC by schedule (weekly) and by hand, not on each push, and is to be run at each release candidate.
- **Tests:**
  - `scripts/tla-case-machine-conformance.test.mjs`: "the export was made under each plan's committed configuration, in a run where TLC held every invariant of the table on every state"
  - `scripts/tla-case-machine-conformance.test.mjs`: "the caps the specification's configurations set are production's"
  - `scripts/tla-case-machine-conformance.test.mjs`: `the real machine's reachable transitions are the specification's, on the plan ${planName}`
  - `scripts/tla-case-machine-conformance.test.mjs`: `TLC's traces replay through the real step, state by state, on the plan ${planName}`
  - `scripts/tla-case-machine-conformance.test.mjs`: "the plans whose traces are kept are the six-slot plan and the two smallest"
  - `scripts/tla-case-machine-conformance.test.mjs`: "an event from an actor the specification's table refuses is refused by the real machine"
  - `scripts/tla-case-machine-conformance.test.mjs`: "the real purgeStep and retentionTier answer as the specification's reducer, on every pairing of the slice"
  - `scripts/tla-case-machine-conformance.test.mjs`: "through the real step a purge answers as the specification's reducer and moves nothing else, and no other event reads the manifest, on the two smallest plans"
- **Variants:**
  - `scripts/tla-case-machine-conformance.test.mjs`: names beginning "the relation check catches a variant of the real machine:"
  - `scripts/tla-case-machine-conformance.test.mjs`: "the relation check passes the real machine on the plan the variants run on"
- **Commit:** 7326be58c59b405a10390d77af5af724e1518090

### TLA-EXPORT. The committed export names what wrote it

- **Property:** The specification's committed export names the script that wrote it and the files it was written from, and each of those files still has the digest the export records.
- **Code:** `specs/case-machine/conformance.json` as data, read by `scripts/tla-tools-lib.mjs`.
- **Domain:** The files the export names: the export script and the modules it imports, the specification's files and the committed configurations.
- **Bounds:** none beyond those files.
- **Axioms:** none
- **Method:** exhaustive
- **Not claimed:** That an export is what TLC writes: the unit suite runs no TLC.
- **Tests:**
  - `scripts/tla-case-machine-conformance.test.mjs`: "the committed export names the script that wrote it and the files it was written from, and each still has the digest it records"
- **Variants:** none: the suite seeds no fault of an export.
- **Commit:** abddd5766fdb5ea7aa7d12ab69dab13067b2bb2a

## Claims from the trust kernel

`tools/trust-kernel` is a Rust crate, compiled to a WebAssembly module the
scanner loads. In live scans, `lib/address-kernel-comparison.ts` treats an
address as public only when both `lib/ip-safety.ts` and the kernel's address
functions answer public for the same address value (`tsDecision &&
outcome.record === "agreed"`), failing closed on any load failure, reader
mismatch, or disagreement while counting where they differ. The rows below
state what Verus accepted for the Rust value functions alone; URL parsing,
DNS resolution, redirects, browser egress, and the TypeScript spelling checks
lie outside these rows. Nothing calls the kernel's canonical JSON.

### TK-A4. An IPv4 value is public exactly when the written table says so

- **Property:** `is_public_ipv4` returns true exactly when the value lies in none of the sixteen ranges of the written table, and each line of the table is the block its comment names. The function overflows no integer.
- **Code:** `is_public_ipv4` in `tools/trust-kernel/kernel/src/address.rs`.
- **Domain:** Every 32-bit value. An address here is a value; no text is read.
- **Bounds:** none
- **Axioms:** none of the environment. The method's trust is stated under Methods.
- **Method:** machine-checked argument
- **Not claimed:** That the table is what the IANA registries list: that is a human reading, dated in the source. The table follows `lib/ip-safety.ts` where they part: it refuses the addresses of OPEN-IP4.1. The WebAssembly bytes: the argument is about the Rust function. How a text becomes a value: Node reads it for the scanner, and the kernel's own text reader is ordinary Rust. That URL parsing, DNS resolution, redirects, or browser egress follow the same rule; live scans require both the kernel and `lib/ip-safety.ts` to agree and fail closed otherwise.
- **Checked by:** `scripts/trust-kernel-verus.mjs`, which pins the statement word for word and the specification by digest, refuses source that would let a claim through unchecked, and requires Verus to refuse each seeded break. It runs in the workflow `.github/workflows/trust-kernel.yml`.
- **Tests:**
  - `lib/address-kernel.test.ts`: "the IPv4 entry point answers as the reference on both sides of every block edge"
- **Variants:** none: the runner's seeded breaks need Verus.
- **Commit:** cf699bc2d1b8dc699ef6d8ff21404ccdc0902773

### TK-A6. An IPv6 value is public exactly when the written rule says so

- **Property:** `is_public_ipv6` returns true exactly when the written rule over prefixes holds of the value, and each prefix of the rule starts on a boundary of its own length. Told how an address was spelled, the function can only turn a public answer into a refusal.
- **Code:** `is_public_ipv6` and `is_public_ipv6_as_spelled` in `tools/trust-kernel/kernel/src/address.rs`.
- **Domain:** Every 128-bit value.
- **Bounds:** none
- **Axioms:** none of the environment.
- **Method:** machine-checked argument
- **Not claimed:** As TK-A4. The rule refuses three blocks the registry marks reachable, as the reference does. That the facts about spelling passed in are the right ones: the text layer reads them and Verus does not read the text layer.
- **Checked by:** as TK-A4.
- **Tests:**
  - `lib/address-kernel.test.ts`: "the IPv6 entry point answers as the reference, and each half of the value is where it belongs"
  - `lib/address-kernel.test.ts`: "a value spelled another way is the same value, where the reference follows the spelling"
- **Variants:** none: the runner's seeded breaks need Verus.
- **Commit:** cf699bc2d1b8dc699ef6d8ff21404ccdc0902773

### TK-ENC. Two different admitted trees never share bytes

- **Property:** The encoder returns bytes exactly when the tree is admitted, and those bytes are the written encoding of that tree. Two different admitted trees never have the same bytes. In an admitted object each key is less than every later key. The encoder indexes nothing out of range and overflows no integer.
- **Code:** `encode_admitted` in `tools/trust-kernel/kernel/src/encode.rs`.
- **Domain:** Every value tree of the encoder's type. "Admitted" is wider than canonical.
- **Bounds:** none
- **Axioms:** none of the environment.
- **Method:** machine-checked argument
- **Not claimed:** That the written encoding is JSON, or is what `lib/canonical-json.ts` writes: a generated comparison in the hosted workflow holds that on its cases and on no others. How a tree is built from bytes (the parser, the number text, the normalization), and so that every tree the kernel builds is admitted. Memory and stack depth. Any use: no code of the scanner, the Worker or the site calls the kernel's canonical JSON.
- **Checked by:** as TK-A4.
- **Tests:** none: the unit suite has none.
- **Variants:** none: the runner's seeded breaks need Verus.
- **Commit:** c4470db9aa0322f9ef5eb0c04148d9793a12306a

### TK-MOD. The module the scanner loads is the pinned one

- **Property:** The vendored module has the digest the reproducibility contract records for every host that built it. A module with other bytes, or none, is refused, and an entry point's number is an answer only when it is 1 or 0.
- **Code:** `lib/address-kernel.ts`, and `lib/trust-kernel-wasm/sbl_trust_kernel_wasm.wasm` as data.
- **Domain:** The vendored file and the refusals the suite writes out.
- **Bounds:** none beyond those cases.
- **Axioms:** none
- **Method:** sampled
- **Not claimed:** That those bytes are a build of the source Verus read. The hosted workflow builds the module twice from clean and compares the builds with the contract, `tools/trust-kernel/reproducibility-contract.json`, and not with the vendored file; the unit suite does not build. That the contract's digest was recorded honestly: it is a committed file.
- **Tests:**
  - `lib/address-kernel.test.ts`: "the vendored module is the bytes the contract records for every host that built it"
  - `lib/address-kernel.test.ts`: "a module that is not the pinned bytes is refused, and so is a missing one"
  - `lib/address-kernel.test.ts`: "an entry point's number is an answer only when it is 1 or 0"
  - `lib/address-kernel.test.ts`: "a text is read into the value Node gives it, and a text Node does not read has none"
- **Variants:** none: the suite plants no variant of the loader, and its refusals are written-out cases.
- **Commit:** cf699bc2d1b8dc699ef6d8ff21404ccdc0902773

## Open findings

Each finding below is pinned by a test as the code behaves, not as it should.
None is claimed, and none is fixed: changing one moves what a report means,
which is the owner's call.

### OPEN-IP4.1. Anycast addresses the registry marks reachable read as not public

- **Finding:** The IANA special-purpose registry marks 192.0.0.9, Port Control Protocol anycast, and 192.0.0.10, Traversal Using Relays around NAT anycast, as globally reachable. The classifier reads both as not public, directly and in the mapped spelling: it takes the octets before the last, so it cannot tell them from their neighbours in the protocol assignments block. Its IPv6 side admits the same services. A scan of either address is refused; nothing private is reached.
- **Tests:**
  - `lib/fv-ipv4-classifier.test.ts`: "open (IP4): the two anycast addresses the registry marks globally reachable read as not public"
- **Commit:** 86e139ca6a01854841bedeb9622e72bff04878bd
