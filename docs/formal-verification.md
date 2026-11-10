# Formal verification claims register

This register lists what the bounded formal verification suites hold, each in
one form: for all inputs in a domain D, under bounds B and axioms A, code F
satisfies property P, checked by test T, whose name is in its file at commit C
and not at C's first parent. Each row is a statement about this repository's
own code over a closed, finite domain, and says nothing of what a browser, a
page or a network hands that code.

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
- **Tests:** T, each test the row rests on, by its file and its exact name as the source spells it, template placeholders included.
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
whole word and in any case, except in this list. A space in a phrase also
matches a hyphen or a slash, a trailing star stands for any ending of the word,
and emphasis and link marks are read through:

- `proof`, `proofs`, `prove`, `proves`, `proved`, `proven`, `proving`, `provable`, `provably`: a finite check holds a property over its domain at a commit. These words claim an argument for inputs beyond the domain, which no check here walks.
- `theorem`, `theorems`: these name a statement settled by such an argument, which no row is.
- `guarant*`, `bulletproof`: these words promise behavior on whatever input arrives, and a row speaks only of its domain, bounds and axioms.
- `formally verif*`: this names a machine-checked argument against a specification, which these suites do not make. "Formal verification" names the program and its release gate, and stays allowed.
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
members a family gained after its Commit all pass. `npm run test:unit` reruns
the lib suites in its unit lanes, the workspace suites in
`npm run test:investigation` and the case exploration in
`npm run test:investigation-exploration`, wherever it runs; the guard reads
that wiring from `package.json`. A row states what its tests hold at the commit
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
tests job writes the report for each commit it tests, and its attest job signs
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

## What this register does not claim

- That a browser behaves as an axiom states. Each axiom stays a question for measurement, and the amd64 hold rate is among what is not yet measured.
- How often an input in a domain, or an open finding, occurs in a browser.
- Anything about an input outside a row's domain or past its bounds.
- That a restated oracle states the right rule.

## Files

The finite-check harness is `lib/finite-check.ts`, with its own test
`lib/finite-check.test.ts`. Its catch log, which the Release status section
describes, has a test of its own outside this register's rows,
`lib/finite-check-catch-log.test.ts`. The suites are `lib/fv-producer-identity.test.ts`,
`lib/fv-coverage-loss.test.ts`, `lib/fv-request-accounting.test.ts`,
`lib/fv-published-stacks.test.ts`, `lib/fv-initiator-claims.test.ts`,
`lib/fv-warning-fragments.test.ts`, `lib/fv-worker-readout.test.ts`,
`lib/fv-scroll-producer.test.ts`, `lib/fv-worker-model.test.ts` and
`investigation/test/case-exploration.test.ts`. The worker model is
`lib/fv-worker-model.ts`, replayed through the real code by
`lib/fv-worker-model-replay.ts`. The case exploration's walks and checks are
in `investigation/test/case-exploration-walk.ts`, run in worker threads by
`investigation/test/case-exploration-worker.ts`, with a planted fault for its
self-tests in `investigation/test/case-exploration-plant-worker.ts`.

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

### RA1.RA2. The join conserves counted requests and pairs nothing across a shortfall

- **Property:** Every counted request lands in exactly one bucket and an uncounted one in none; when the session missed a request and only some are counted, no counted request takes an observation; otherwise the nth request takes the nth observation; joins on one tally add up across a recorder's URLs.
- **Code:** `joinObservations` and `StackTally` in `lib/call-stack-publisher.ts`.
- **Domain:** Page requests, observations over every category kind, dropped observations, and every mask of which requests are counted; for the tally, every pair of joins within the smaller bounds. The distinct groups are the suite's sample of group keys.
- **Bounds:** up to 5 page requests, 5 observations and 5 dropped observations; for pairs of joins, up to 2 requests, 2 observations and 1 dropped observation each.
- **Axioms:** none
- **Method:** bounded, sampled, restatement
- **Not claimed:** The position rule restates the join's own docblock. What `lib/scroll-check-stacks.ts`, Inspect or a browser hands the join is outside this row; RA7 holds what Inspect hands it, and RA6 what the check's recorders hand it.
- **Tests:**
  - `lib/fv-request-accounting.test.ts`: "RA1 and RA2: the join conserves counted requests and never pairs across a shortfall"
  - `lib/fv-request-accounting.test.ts`: "RA1: joins add up across a recorder's URLs, over every pair of small joins"
- **Variants:**
  - `lib/fv-request-accounting.test.ts`: names beginning "RA1 and RA2 catch a variant"
  - `lib/fv-request-accounting.test.ts`: "RA1 catches a variant: each join starts its tally over"
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

## Claims from F2: published stacks, initiator claims and warning fragments

### RA3. What one call stack publishes

- **Property:** A stack publishes only requested frames' hosts, at most four, innermost first, with no consecutive repeat, and nothing when no frame was requested; it names each script once, only from requested frames, and stops naming where it stops listing hosts; a recorder's host cache changes nothing it publishes; a recorder that publishes hosts only names no script.
- **Code:** `publishedStack` and `RequestedCodeUrls` in `lib/call-stack-publisher.ts`.
- **Domain:** Every stack over the suite's `SYMBOLS` (requested scripts on several hosts, one host with more than one script, a frame the visit did not request on a requested host, one on another host, and an empty frame URL), published hosts only and with scripts; for the host cache, every stack over a smaller alphabet that holds a URL too long to hold as itself. The symbols are the suite's sample of frame addresses.
- **Bounds:** stacks of up to 6 frames over 9 symbols; for the host cache, up to 4 frames.
- **Axioms:** `publishedHost` and `publishedScript` are taken as given, so a regression in either moves both sides, and nothing here says how a real address redacts.
- **Method:** bounded, sampled, restatement
- **Tests:**
  - `lib/fv-published-stacks.test.ts`: "the symbols span the bound: five hosts, one with two scripts, and frames the visit did not request"
  - `lib/fv-published-stacks.test.ts`: "RA3: a stack publishes only requested frames' hosts, at most four, innermost first, no consecutive repeat"
  - `lib/fv-published-stacks.test.ts`: "RA3: a stack names each script once, and stops naming where it stops listing hosts"
  - `lib/fv-published-stacks.test.ts`: "RA3: a recorder's host cache changes nothing it publishes"
- **Variants:**
  - `lib/fv-published-stacks.test.ts`: names beginning "RA3 catches a variant"
  - `lib/fv-published-stacks.test.ts`: "RA3 catches a variant: the host cache reads the held key and not the URL"
  - `lib/fv-published-stacks.test.ts`: "RA3 catches a variant: the host cache keeps a different host"
- **Commit:** 8cd96197eb96efc3dcd38efbb7dbf18876ec0093

### RA3-C. Every observation falls in its one category, and the code set keeps its bound

- **Property:** Every observation falls in its one category, a group keeps the stack that keyed it, and past the code bound nothing is named; the code set holds to its bound and says when it has gone past it.
- **Code:** `categorizeObservation` and `RequestedCodeUrls` in `lib/call-stack-publisher.ts`.
- **Domain:** Exhaustive over a redirect hop or not, each stack shape (absent, empty, naming a requested script, naming none), and the code set open or past its bound; sampled for the stack that stands for each shape and for the addresses, which the suite writes out. Bounded over the code set filled one address at a time to its bound, then an address it already holds, and one address past the bound.
- **Bounds:** the code set's own bound, `MAX_REQUESTED_CODE_URLS`.
- **Axioms:** none
- **Method:** exhaustive, bounded, sampled, restatement
- **Tests:**
  - `lib/fv-published-stacks.test.ts`: "RA3: every observation falls in its one category, and past the code bound nothing is named"
  - `lib/fv-published-stacks.test.ts`: "RA3: the code set holds to its bound and says when it has gone past it"
- **Variants:**
  - `lib/fv-published-stacks.test.ts`: names beginning "RA3 catches a variant"
  - `lib/fv-published-stacks.test.ts`: "RA3 catches a variant: a group forgets the stack that keyed it"
- **Commit:** 8cd96197eb96efc3dcd38efbb7dbf18876ec0093

### RA3-S. A stack's script bound, an unpublishable frame and a long URL

- **Property:** A stack keeps its first eight scripts, however many it holds; a requested frame with no published address lists its host and names no script; a URL too long to hold as itself is held by its digest, so its frame still lists its host, and a URL one character past it is not taken for it.
- **Code:** `publishedStack` and `RequestedCodeUrls` in `lib/call-stack-publisher.ts`.
- **Domain:** The scripts the suite writes out across the hosts a stack keeps, each count of them, repeated; one blob frame beside a requested script; one long URL.
- **Bounds:** none beyond those cases.
- **Axioms:** `publishedHost` and `publishedScript` are taken as given.
- **Method:** sampled
- **Tests:**
  - `lib/fv-published-stacks.test.ts`: "RA3: a stack keeps its first eight scripts, however many it holds"
  - `lib/fv-published-stacks.test.ts`: "RA3: a frame with no published address lists its host and names no script"
  - `lib/fv-published-stacks.test.ts`: "RA3: a URL too long to hold as itself is still named, by its digest"
- **Variants:**
  - `lib/fv-published-stacks.test.ts`: "RA3 catches a variant: the script bound is gone"
  - `lib/fv-published-stacks.test.ts`: "RA3 catches a variant: a frame with no published address names a script"
- **Commit:** 8cd96197eb96efc3dcd38efbb7dbf18876ec0093

### RA7. Inspect's counts do not depend on pairing

- **Property:** With every request counted, the join refuses nothing, and which observation pairs with which moves no count; through Inspect's real recorder the evidence is the first observations in arrival order, against a table spelled out in the test, whichever pairs with which. Arrival order still decides what a surplus takes, so Inspect is stable under pairing and not under a reordering that moves a surplus observation ahead of a taken one.
- **Code:** `joinObservations` and `StackTally` in `lib/call-stack-publisher.ts`, and `ConnectionInspectionRecorder` in `lib/connection-inspection.ts`.
- **Domain:** Request counts, dropped observations and observation sequences over every category kind, with every request counted; for the recorder, request counts and sequences over the suite's observation shapes, each with every order of what it takes. The observation shapes are the suite's sample.
- **Bounds:** up to 5 requests, 5 dropped observations and 5 observations; through the recorder, up to 3 requests and 3 observations.
- **Axioms:** none
- **Method:** bounded, sampled, restatement
- **Tests:**
  - `lib/fv-request-accounting.test.ts`: "RA7: with every request counted, nothing is refused and pairing moves no count"
  - `lib/fv-request-accounting.test.ts`: "RA7: Inspect's real recorder takes the first observations, whichever pairs with which"
- **Variants:**
  - `lib/fv-request-accounting.test.ts`: names beginning "RA7 catches a variant"
- **Commit:** 8cd96197eb96efc3dcd38efbb7dbf18876ec0093

### RA7-P. Where Inspect and a check part

- **Property:** When a URL is observed more often than it was requested, with differing categories, Inspect's one request takes the first observation, and a check, which cannot tell which observation was its request's, takes neither and reads the request as unobserved.
- **Code:** `ConnectionInspectionRecorder` in `lib/connection-inspection.ts` and `ScrollCheckStackRecorder` in `lib/scroll-check-stacks.ts`.
- **Domain:** The one stream the test writes out: a page request observed more often than it was requested, under different scripts.
- **Bounds:** none beyond that case.
- **Axioms:** none
- **Method:** sampled
- **Tests:**
  - `lib/call-stack-publisher.test.ts`: "Inspect and the check part when a URL is observed more often than it was requested, with differing categories"
- **Variants:** none: the test pins where the recorders part, which RA7's bounded check leaves to arrival order.
- **Commit:** 8cd96197eb96efc3dcd38efbb7dbf18876ec0093

### RA8. When a request row may name its initiator

- **Property:** Every claim lands in at most one outcome, and in none when no observation of its URL names an initiator; an answer rests on every observation and request of its URL, names only what every observation named, covers no more requests than observations, and consumes nothing; held to the counts alone, it does not depend on which stream arrives first; past either table's bound nothing is claimed, and the loss is counted.
- **Code:** the attribution refusal rule in `lib/request-initiator.ts`.
- **Domain:** Every order of events over the suite's `URLS`, each event one observation (with one of the suite's `INITIATORS`, or none) or one request the page reported; for the bounds, each table filled to `MAX_TRACKED_INITIATORS` and then passed. The URLs and initiators are the suite's sample.
- **Bounds:** orders of up to 5 events.
- **Axioms:** none
- **Method:** bounded, sampled, restatement
- **Not claimed:** The rule, not its parser. Whether a preflight's initiator differs from its request's, and whether a page-side URL can carry a fragment the observation's does not, stay measurements.
- **Tests:**
  - `lib/fv-initiator-claims.test.ts`: "RA8: every claim lands in one outcome, and an answer rests on every observation and request of its URL"
  - `lib/fv-initiator-claims.test.ts`: "RA8: nothing past a table's bound is claimed, and the loss is counted"
- **Variants:**
  - `lib/fv-initiator-claims.test.ts`: names beginning "RA8 catches a variant"
- **Commit:** 8cd96197eb96efc3dcd38efbb7dbf18876ec0093

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

## Claims from the RA6 rule

### RA6. A request in the window shows nothing a later report gave it

- **Property:** A request in the check's scroll window shows nothing it did not have because of what the page reported after the window: every counted request to a URL the page reported again from the window's end on reads as unobserved; a report after the window changes no window; a report to another URL on the host leaves this one as it was; a report the recorder lost, past its bound in a window or after the freeze, or unreadable, costs the check its stacks, and nothing else does; with none lost, the join hears every report.
- **Code:** `ScrollCheckRecorder` in `lib/scroll-check.ts` and `ScrollCheckStackRecorder` in `lib/scroll-check-stacks.ts`, through the join.
- **Domain:** Exhaustive over: one of the suite's checked URLs (short, past the held URL's length, or on a host that publishes as another name), with one request or a pair of requests from the suite's window requests in the window, at least one counted, each made by the page under one of the suite's scripts or with no stack, or by a worker the session never observes; then the suite's later worlds, none, one later report from any of those, a redirect hop, a main-frame navigation or a refused request, or a pair of reports from the worker or the scripts, each in the window's last millisecond or after the freeze, to the URL, to the URL with a fragment, or to another URL on the host. An uncounted request was sent and never answered. Sampled over lost reports: the window recorder's bound at the small sizes the suite sets, each with the counts, repeats, schemes and unreadable addresses the suite writes out; the stack recorder's bound is not varied.
- **Bounds:** none beyond those enumerations; neither recorder bound is walked in the first part.
- **Axioms:** The session observes every request of the page and none of a worker; each observation arrives before the page's event, in request order; every report arrives before the evidence is built.
- **Method:** exhaustive, sampled, restatement
- **Not claimed:** The cases where those axioms fail, pinned open below. The case the F2 commit described, a worker's request taking the stack of a page request to the same URL after the window, is the one this rule closes; by the message of the commit that landed the rule, the real-Chromium fixture produced it only while a slow request held the check's settle open, which no cited test shows. How often a browser produces any of this is not measured.
- **Tests:**
  - `lib/fv-request-accounting.test.ts`: "RA6: a request in the window shows nothing it did not have, whatever the page reports after the window"
  - `lib/fv-request-accounting.test.ts`: "RA6: a report the recorder lost costs the check its stacks, and nothing else does"
- **Variants:**
  - `lib/fv-request-accounting.test.ts`: names beginning "RA6 catches a variant"
- **Commit:** 0931b39082ba9e682e9b9ac0cded7da38b483930

## Claims from F3: the worker readout's kernels and the scroll producer

### CL8a. The readout's classifier over the whole view domain

- **Property:** The shared classifier holds over every view, and fingerprint-observer@12 moves only fingerprint-observer@11's exclusions, toward unread or toward the stream; a shared worker excluded or unread at the freeze, or ended at once, stays so whatever the drain's end shows; a shared worker's stream lands where the world's text says; the dedicated classifier holds over every view.
- **Code:** the kernels `freezeDedicatedRealm`, `freezeSharedRealm`, `resolveSharedRealm` (with `resolveReachingRealm` and `resolveHeldRealm`), `streamAtFreeze`, `dedicatedLandedTerm` and `sharedLandedTerm` in `lib/worker-fingerprint-realm.ts`.
- **Domain:** Shared views over the hold, the detach flags, channel loss, the install outcome, attachment after the freeze or not, the lifetime against the ended-at-once bound, the last word and a break; each view that waits on the drain against each end the suite moves (hold, detach flags, channel loss and lifetime), and each that reads its stream against every slot, loss, break and credit; for staying settled, the shared views with no last word and no break, against the same ends; dedicated views over the release, the detach flags, channel loss, the install outcome, the last word, a break, the owner, frame trees read or not, the slot, and loss and break at the drain's end. Combinations the mirror never produces are walked too. Sampled for the lifetime, at the values the Bounds name, and for the text of a snapshot, which the suite writes out.
- **Bounds:** none beyond those products; the lifetime takes none, under the bound, at it and one past it.
- **Axioms:** none: the only premise is that a view's fields are what the kernels are handed.
- **Method:** exhaustive, sampled, restatement
- **Not claimed:** That a view is true of the worker, which is the model's question (F4); that a browser behaves as the model says; that excluded means no page code ran, which is not in the view. The @11 reference is spelled out from git and catches drift from what @12 said it changed, not a wrong rule at @11.
- **Tests:**
  - `lib/fv-worker-readout.test.ts`: "CL8a: the shared classifier holds over every view, and @12 moves only what it said it moved"
  - `lib/fv-worker-readout.test.ts`: "CL8a: a worker settled at the freeze stays settled, whatever the drain's end shows"
  - `lib/fv-worker-readout.test.ts`: "CL8a: a shared worker's stream lands where the world's text says"
  - `lib/fv-worker-readout.test.ts`: "CL8a: the dedicated classifier holds over every view"
- **Variants:**
  - `lib/fv-worker-readout.test.ts`: names beginning "CL8a catches a variant"
- **Commit:** 8d1ec26228f9e2a518f31150071da3a4ceed382c

### CL8a-M. The classifier through the real mirror and readout

- **Property:** Through the real mirror and readout, @12 moves @11's exclusions toward unread and toward the stream, and nothing else; a shared worker attached on a stream that missed a commit is credited to nothing, read in full or not, and one attached before that loss keeps what it read.
- **Code:** `SharedWorkerVisitChannel` in `lib/shared-worker-attacher.ts` and the readout in `lib/worker-fingerprint-realm.ts`.
- **Domain:** Exhaustive over every cut of every prefix of the suite's written-out report paths, each with each way the channel is lost, less those a loss before the freeze leaves unreported. Sampled over a stream that missed a commit: the worlds the suite writes out, commits never watched and the page's session lost before or after the attach, beside commits watched.
- **Bounds:** none beyond that enumeration; these worlds read with the drain's settle set to nothing, so production's timer ends the drain at once.
- **Axioms:** as CL7: the attacher's thread is scripted and reports in the order it posted, and each scripted answer stands for the browser's.
- **Method:** exhaustive, sampled, restatement
- **Tests:**
  - `lib/fv-worker-readout.test.ts`: "CL8a: a shared worker attached on a stream that missed a commit is credited to nothing"
  - `lib/fv-worker-readout.test.ts`: "CL8a: through the real mirror and readout, @12 moves @11's exclusions toward unread and toward the stream, and nothing else"
- **Variants:**
  - `lib/fv-worker-readout.test.ts`: names beginning "CL8a catches a variant"
  - `lib/fv-worker-readout.test.ts`: "CL8a catches a variant: a creation document read on a stream that missed a commit is kept"
- **Commit:** 8d1ec26228f9e2a518f31150071da3a4ceed382c

### CL7. Every attached worker lands in one term

- **Property:** Every dedicated worker attached before the freeze, and every shared worker the attacher reported, lands in exactly one term of the real readout's diagnostics, for a dedicated worker the term its world says, and the terms add up to what the readout publishes; the drain waits for each thing it names and ends when that arrives; an emission in the drain moves no freeze point already passed.
- **Code:** the readout in `lib/worker-fingerprint-realm.ts`, `SharedWorkerVisitChannel` in `lib/shared-worker-attacher.ts`, and `DedicatedWorkerAttachSession` in `lib/devtools-worker-channel.ts`.
- **Domain:** Sampled over the dedicated worlds: a quiet worker with one thing varied at a time (its start, each failing install, each later stream with each barrier answer) crossed with each way of going away and each owner state, under each channel mode the suite lists, except that the earlier installer's hold takes the current owner only; then workers started by others, no channel, and witness counts that disagree with what attached. Exhaustive over the shared worlds: every cut of every prefix of the suite's written-out report paths, each prefix with an answered install crossed with each stream, barrier answer and credit, with the reports the mirror must ignore after late, under each way the channel is lost. Sampled over the drain: the things the suite lists for it to wait for, and the emissions the suite writes out.
- **Bounds:** none beyond those enumerations. The accounting worlds read with the drain's settle set to nothing, so production's timer ends the drain at once; the drain and emission worlds read with a settle that never expires in the test, so each case is decided by order.
- **Axioms:** The attacher's thread is scripted and reports in the order it posted, so F4 replays the real thread; each scripted answer stands for the browser's and arrives in the turn it was sent unless a world holds it; a detach reaches the session before the installer; an earlier installer holds until told to, which the real GPC installer does not once its channel closes.
- **Method:** exhaustive, sampled, restatement
- **Not claimed:** A dedicated worker attached in the drain lands in no term (OPEN-F3.3). The dedicated worlds take a worker an earlier installer holds as excluded, the reading OPEN-F3.6 pins open, and witness counts and attaches have nothing to join them (OPEN-F3.4). Whether a browser produces a path, and what a term says of a site. The expected terms restate the docblocks of the diagnostics and of the readout. A shared worker on the dedicated channel stays out of these terms, and `shared.diedPaused` is written by nothing since @12.
- **Tests:**
  - `lib/fv-worker-readout.test.ts`: "CL7: every dedicated worker lands in one term of the real readout, the one its world says, and the terms add up"
  - `lib/fv-worker-readout.test.ts`: "CL7: every shared worker the attacher reported lands in one term of the real readout, and the terms add up"
  - `lib/fv-worker-readout.test.ts`: "CL7: the drain waits for each thing it names and ends when that arrives, at a bound that never expires"
  - `lib/fv-worker-readout.test.ts`: "CL7: an emission in the drain moves no freeze point"
- **Variants:**
  - `lib/fv-worker-readout.test.ts`: names beginning "CL7 catches a variant"
- **Commit:** 8d1ec26228f9e2a518f31150071da3a4ceed382c

### RA4. The scroll producer passes its validator and keeps what it earned

- **Property:** Through the real recorders and the real `runScrollCheck`, every check validates and keeps each part its world earned (its stacks, labels, counts and outcome); a fact that throws costs that fact's part and no other; past each recorder's bound the check stays whole and loses its stacks only for a report it lost; within the domain, the window relations and the counting rule hold.
- **Code:** `runScrollCheck` and `ScrollCheckRecorder` in `lib/scroll-check.ts`, `ScrollCheckStackRecorder` in `lib/scroll-check-stacks.ts`, and `isScrollCheckEvidence` in `lib/scroll-check-evidence.ts`.
- **Domain:** Each run through the whole check at the production timing, on a scripted page and clock. Exhaustive over: every subset of the request buckets but the empty one and the one holding only an unanswered request, in each of the suite's URL forms; every subset of what a window does not count, around what it does; every ordered pair of the host forms in the suite's table; every combination of counts but the empty one, under the suite's per-shape bound, of the stack shapes it lists. Sampled over: the host-form table itself; the stack shapes; the worlds the counting rule turns on; the window recorder's host and request bounds at the small sizes the suite sets, not at production's; the stack recorder's script-address and dropped-URL bounds at production's own; the list bound across site sizes; each ending with a scroll window and the listed ways to have none; and facts that throw, one at a time.
- **Bounds:** none beyond those enumerations.
- **Axioms:** Every observation arrives before its page event, except in the settle's one world, which says otherwise; the session reports a URL without its fragment; Node's URL and the page's agree on a host.
- **Method:** exhaustive, sampled, restatement
- **Not claimed:** Analytics events beyond the one beacon of each kind `lib/scroll-check-events.test.ts` walks; requests after the window, which RA6 holds; a recording that failed or a session that never opened; timings other than production's; host forms beyond the table, and the forms the validator refuses, pinned open below.
- **Tests:**
  - `lib/fv-scroll-producer.test.ts`: "RA4: every bucket and every subset of them leaves the check its stacks"
  - `lib/fv-scroll-producer.test.ts`: "RA4: the worlds the counting rule turns on say what their windows should"
  - `lib/fv-scroll-producer.test.ts`: "RA4: a fact that throws costs the check that fact's part and no other"
  - `lib/fv-scroll-producer.test.ts`: "RA4: what a window does not count, around what it does, leaves the check whole and counted"
  - `lib/fv-scroll-producer.test.ts`: "RA4: past each of the recorders' bounds the check stays whole, and loses its stacks only for a report it lost"
  - `lib/fv-scroll-producer.test.ts`: "RA4: every count of every stack shape leaves the check its stacks, whatever the group bound keeps"
  - `lib/fv-scroll-producer.test.ts`: "RA4: every host form in the table leaves the check its stacks, as a listed host, a pair of them, and a pair of frames"
  - `lib/fv-scroll-producer.test.ts`: "RA4: the list bound, with the window's other counts and each way to have list facts, leaves the check whole"
  - `lib/fv-scroll-producer.test.ts`: "RA4: each ending validates and keeps what it earned"
- **Variants:**
  - `lib/fv-scroll-producer.test.ts`: names beginning "RA4 catches a variant"
- **Commit:** 8d1ec26228f9e2a518f31150071da3a4ceed382c

## Claims from F4: the shared-worker hold, modeled and replayed

The model in `lib/fv-worker-model.ts` is a hand-written breadth-first search
over the browser and the worker, the attacher's thread, the mirror over its
port, and the drain and the readout's wait for the page's frame tree. Each
worker's term comes from the real kernels. Whether a page statement ran comes
from the world's own process. Its shared worlds are the hold world (one worker,
every step), the stream world (one worker from its release on, with its stream
and the barrier's hops) and the world of `TWO_WORKER_WORLD` (a pair of workers
under its stated bound); a smaller world, `SMALL_WORLD`, carries some of the
variants, and a dedicated world holds one worker on the main thread's channel.
Its axioms are switches, each of which only removes transitions:

- A1: a session's commands and a worker's own words on it arrive in order.
- A2: another client's release of a held worker is heard by the attacher's session.
- A3, used as its negation: a detach never overtakes a session's events still on their way.
- A4: a worker the debugger holds at its start runs nothing until it is released; the plan states it of a dedicated worker.
- A5, in halves: the port between the thread and the main thread delivers in order, and a message posted before the freeze is processed before the settle bound.

### F4-READ. A read's observer preceded every statement

- **Property:** A shared worker the readout reads had its observer in before every statement of page code it ran.
- **Code:** the readout's kernels in `lib/worker-fingerprint-realm.ts`, as `lib/fv-worker-model.ts` calls them, over the attacher thread, mirror and drain the model restates.
- **Domain:** Every event order in the alphabets of the shared worlds.
- **Bounds:** each world's alphabet, with the bounds the suite asserts on the kinds of step, how far each queue can be overtaken and how many reports wait on a port.
- **Axioms:** A1 and A2, the smallest set; the hold world decides it.
- **Method:** reachable states
- **Tests:**
  - `lib/fv-worker-model.test.ts`: "the axiom table: every property under each subset of the plan's axioms, the smallest sets it needs, and which world holds it"
- **Variants:**
  - `lib/fv-worker-model.test.ts`: "the world's facts catch a thread that takes no resume for a broken hold, as a worker read though it ran unobserved"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### F4-AGE. A read state is no older than the freeze

- **Property:** A shared worker the readout reads is read at a state no older than the freeze.
- **Code:** the readout's kernels in `lib/worker-fingerprint-realm.ts`, as `lib/fv-worker-model.ts` calls them.
- **Domain:** Every event order in the alphabets of the shared worlds.
- **Bounds:** each world's alphabet and the bounds the suite asserts.
- **Axioms:** A1, A3's negation (no detach overtaking) and A5's order half, the smallest set; the stream world decides it. A3 itself is the plan's open ordering study, so this row rests on what that study has not yet measured.
- **Method:** reachable states
- **Tests:**
  - `lib/fv-worker-model.test.ts`: "the axiom table: every property under each subset of the plan's axioms, the smallest sets it needs, and which world holds it"
- **Variants:**
  - `lib/fv-worker-model.test.ts`: names beginning "the model catches a variant of the kernels"
- **Members:**
  - "a running worker's last word at the call is its state, with no barrier"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### F4-TERM. Every shared worker the readout heard of lands in one term

- **Property:** Every shared worker the readout heard of lands in exactly one term, and where @12 lands a worker apart from where @11 would have, it moves it only from excluded, toward unread or toward its stream.
- **Code:** the readout's kernels in `lib/worker-fingerprint-realm.ts`, as `lib/fv-worker-model.ts` calls them.
- **Domain:** Every event order in the alphabets of the shared worlds.
- **Bounds:** each world's alphabet and the bounds the suite asserts.
- **Axioms:** none
- **Method:** reachable states
- **Not claimed:** The one-term row cannot fail in the model, whose kernels return one term; it has force only in the replay's sums over the real readout, which F4-TRACE holds.
- **Tests:**
  - `lib/fv-worker-model.test.ts`: "the axiom table: every property under each subset of the plan's axioms, the smallest sets it needs, and which world holds it"
  - `lib/fv-worker-model.test.ts`: "the direction property has moves to judge: a worker gone held moves to unread, and one gone after its install to its stream"
- **Variants:**
  - `lib/fv-worker-model.test.ts`: names beginning "the model catches a variant of the kernels"
- **Members:**
  - "a worker gone with no pause, past the bound, is read as ended at once"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### F4-TABLE. The axiom table only weakens as axioms are dropped

- **Property:** A property that holds under a set of axioms holds under every larger set, in each shared world; A4 changes no verdict for a shared worker under any subset of the other axioms; in the dedicated world, a worker held at its attach and excluded ran nothing, under A4 and only under A4; with Z among the switches, the @11 shared rule keeps the first exclusion row in the small world under no detach overtaking, and in the hold world needs A1, A2, no detach overtaking and A5's order half, where @12 needs only A5's order half.
- **Code:** `lib/fv-worker-model.ts`, over the real kernels.
- **Domain:** Every subset of A1 to A5, with A5's halves apart, over each shared world; the dedicated world under each axiom; for the @11 rule, the small world under Z and no detach overtaking, and the hold world under the subsets of A1, A2, no detach overtaking, A5's order half and Z.
- **Bounds:** each world's alphabet and the bounds the suite asserts.
- **Axioms:** each subset in turn, as the property states.
- **Method:** reachable states
- **Tests:**
  - `lib/fv-worker-model.test.ts`: "an assumption only ever removes behavior: a property that holds under a set holds under every larger one"
  - `lib/fv-worker-model.test.ts`: "A4 changes nothing for a shared worker: each transition it forbids has a twin no axiom forbids, so the plan's word on the shared exclusion stands"
  - `lib/fv-worker-model.test.ts`: "the dedicated world is where A4 acts: a worker held at its attach and excluded ran nothing, under A4 and only under A4"
  - `lib/fv-worker-model.test.ts`: "what the @11 rule rests on: in the small world, only on no detach overtaking; in the hold world, on A1 and A2 too, where @12 needs neither"
- **Variants:**
  - `lib/fv-worker-model.test.ts`: "the model catches a variant of the dedicated kernel: a released worker is excluded"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### F4-BEYOND. What the empty rows would take

- **Property:** C1 (what the browser emitted before the freeze, and what the thread posted on hearing it, is processed before the settle bound) and D1 (all of that is processed before the page's frame tree answers) are not axioms of the plan, and each says only what it says: with both on top of every axiom the exclusion rows still fail, so measuring latency cannot close them; D1 closes the no-term row only in the hold and stream worlds, and over every world only Z, which restates the safety property's premise, closes it. With Z alone assumed, the small world keeps the exclusion rows. The named trace, a worker that ran unobserved before the freeze and that the mirror does not yet call late, is reachable, frozen as held, as reaching and by the second pass, and the readout excludes it.
- **Code:** `lib/fv-worker-model.ts`, over the real kernels.
- **Domain:** Every event order in the alphabets of the shared worlds and the small world, under each switch set the tests name.
- **Bounds:** each world's alphabet and the bounds the suite asserts.
- **Axioms:** the plan's axioms with C1, D1 and Z as each test names them; none of C1, D1 and Z is a fact of Chromium.
- **Method:** reachable states
- **Not claimed:** That Z holds of a browser: that the empty rows hold under Z shows only that they have no other way to fail. The small-world clause is checked by the production pass that opens each named member's test.
- **Tests:**
  - `lib/fv-worker-model.test.ts`: "beyond the plan's axioms: C1, D1 and Z are not axioms, and each says only what it says"
  - `lib/fv-worker-model.test.ts`: "the named trace is reachable, frozen as held, as reaching, and by the second pass, and A5's latency half closes one of its causes in two of those forms"
  - `lib/fv-worker-model.test.ts`: "the named trace asks that the worker ran unobserved: an ordinary hold, which ran with its observer in, is not it, and the same with its install failed is"
- **Variants:**
  - `lib/fv-worker-model.test.ts`: names beginning "the model catches a variant of the kernels"
- **Members:**
  - "the @11 shared rule is restored: a worker gone held is excluded"
  - "lostWithChannel is ignored: a worker the closed channel left running reads as held"
  - "a worker the mirror knows is late is excluded"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### F4-WORLD. The model's ground truth and bounds are its own

- **Property:** A fold of the labels alone agrees with the model's ground truth on every state of every shared world; before the drain ends, states that differ only in what the mirror, the readout and the port hold have the same world moves, in the hold and stream worlds; each world has exactly the kinds of step written out by hand; each queue is overtaken only as far as the suite states in the hold and stream worlds and `TWO_WORKER_WORLD`, and in the hold world only with its axiom off; the narrowings a review tried are transitions; the port bound of `TWO_WORKER_WORLD` is reached; and no state short of a finished readout is stuck in the hold and stream worlds and `TWO_WORKER_WORLD` under any of the switch sets the suite lists (none, the plan's axioms, those with C1, with D1, with both, and with Z too).
- **Code:** `lib/fv-worker-model.ts`.
- **Domain:** Every reachable state of each world named, under no assumption and under the switch sets named.
- **Bounds:** each world's alphabet; in `TWO_WORKER_WORLD`, a move that would leave more reports on the port than its bound is cut, so that world is left out of the world-move check.
- **Axioms:** none, and the plan's axioms where a test names them.
- **Method:** reachable states
- **Not claimed:** The state and transition counts the suite pins are change detectors. Where in a trace each kind of step can happen is not held, beyond the narrowings written out.
- **Tests:**
  - `lib/fv-worker-model.test.ts`: "the worlds reach exactly these states and transitions, under no assumption and under the plan's axioms"
  - `lib/fv-worker-model.test.ts`: "each world has exactly these kinds of step, written out by hand and not read off the model"
  - `lib/fv-worker-model.test.ts`: "each queue can be overtaken this far and no further, and only with its axiom off"
  - `lib/fv-worker-model.test.ts`: "each narrowing a kind of step could hide is a transition: an install evaluated at a statement's pause, a quick life after the breakpoint's answer, a dependency's pause with no other client"
  - `lib/fv-worker-model.test.ts`: "at most four reports wait on the port in the two-worker world, and four do"
  - `lib/fv-worker-model.test.ts`: "every world reaches each term it is meant to, and no state short of a finished readout is stuck under any assumptions"
  - `lib/fv-worker-model.test.ts`: "both workers land in the two-worker world"
  - `lib/fv-worker-model.test.ts`: "the ground truth is the world's own: a fold of the labels alone agrees with the model on every state of every shared world"
  - `lib/fv-worker-model.test.ts`: "the fold fires: a model that forgets at the freeze that its worker ran unobserved parts from it"
  - `lib/fv-worker-model.test.ts`: "the world's moves are its own: before the drain ends, states that differ only in what the mirror, the readout and the port hold have the same world moves"
  - `lib/fv-worker-model.test.ts`: "the world-move check fires: a worker that may end only while the mirror does not say held is caught"
  - `lib/fv-worker-model.test.ts`: "the two a held worker could stop at are in the world: a statement with no observer in, and a later script"
- **Variants:** none: the fold and the world-move check each have a self-test above that shows it fires.
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### F4-HARNESS. The search and the replay check themselves

- **Property:** A set of assumptions blocks a transition if any one of its axioms forbids it; the input automaton closes over what a side does not hear, counts and covers what it does, and refuses a model that is not a function of what a side hears; the search refuses a move that leaves a state of another size; each check a replay leans on fires when what it counts falls short, and passes when nothing does.
- **Code:** the search and automaton in `lib/fv-worker-model.ts` and the replay in `lib/fv-worker-model-replay.ts`.
- **Domain:** The small graphs and cases the tests write out by hand.
- **Bounds:** none beyond those cases.
- **Axioms:** none
- **Method:** sampled
- **Tests:**
  - `lib/fv-worker-model.test.ts`: "a set of assumptions blocks a transition if any one of its axioms forbids it"
  - `lib/fv-worker-model.test.ts`: "each check a replay leans on fires when what it counts falls short, and passes when nothing does"
  - `lib/fv-worker-model.test.ts`: "the input automaton closes over what a side does not hear, and counts and covers what it does"
  - `lib/fv-worker-model.test.ts`: "the input automaton refuses a model that is not a function of what a side hears"
  - `lib/fv-worker-model.test.ts`: "the search refuses a move that leaves a state of another size, which would split one state in two"
- **Variants:** none: these are the harness's own cases, written out by hand, and the replay's checks are shown to fire on what they count falling short.
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### F4-TRACE. The real thread, mirror and readout follow the model

- **Property:** The real attacher thread hears every sequence it can hear in the hold and stream worlds, with no axiom assumed, and posts and sends what the model says at each step; the real mirror and readout hear every sequence they can hear with the port in order and land where the model says, and with the port out of order and the thread dead take every transition of what they can hear; through the real thread, its in-process transport, the real mirror and the real readout, a set of traces takes every transition of what all of it hears; in the world of `TWO_WORKER_WORLD` each side takes every transition of what it hears and both together reach every landing; the real session, installer and readout hear every sequence of the dedicated world, and under A4 keep `a-dedicated-worker-held-at-its-attach-and-excluded-ran-no-page-code-before-the-freeze` and `a-dedicated-worker-read-had-the-observer-before-every-statement` by the world's facts; each word the model drops, the real thread makes nothing of, from that state on, but a late worker's own stream, which it forwards; on a scripted broken hold, the real path keeps `excluded-implies-no-unobserved-page-code-before-the-freeze` and `read-implies-the-observer-preceded-every-statement`, and a worker running at its attach whose late the mirror heard lands in a term; each row's need and each form of the named trace goes through the real code, and the term the real readout counted breaks the property the model says it breaks, except on the trace for `a-worker-that-ran-before-the-freeze-lands-in-a-term`, where the model's term is nowhere and is judged as the model gives it, so that test depends on none of the readout's term counts: among what it holds are the real mirror against the model (the installer's install counts included) and that the real drain had not ended at each label before the last, and that it ended; the landing is not compared on those traces.
- **Code:** `sharedWorkerAttacherThread`, `SharedWorkerVisitChannel` and `inProcessAttacherTransportForTests` in `lib/shared-worker-attacher.ts`, the readout in `lib/worker-fingerprint-realm.ts`, `DedicatedWorkerAttachSession` in `lib/devtools-worker-channel.ts`, and the replay in `lib/fv-worker-model-replay.ts`.
- **Domain:** The model's traces of each world, each replayed in one process over a stand-in socket and patched timers, with the port a queue in the harness; the scripted traces the tests write out.
- **Bounds:** every sequence where a test says every sequence, and otherwise a set of traces that takes every transition of the side's input automaton.
- **Axioms:** Each side's next output is a function of what it has heard, which is checked of the model only; at the level of socket frames it is false of the code. The traces through both sides together assume the plan's axioms with C1 and D1, and the dropped words are delivered with A1 assumed.
- **Method:** trace conformance
- **Not claimed:** A passing replay is no evidence about classification, since both sides call the real kernels; that evidence is CL8a. A set that takes every transition stands for every trace only if the code's next output depends on nothing outside the automaton's state. The replay runs the model's traces only, so it says nothing of what the real code does on a sequence the model has no move for: the model leaves out a command's own timeout, so a held worker's install that settles after its detach, after which the real thread posts installed and then released, is reached by no trace that assumes no detach overtaking, and by the others only when the install's answer was already on its way.
- **Tests:**
  - `lib/fv-worker-model.test.ts`: "replay: the real thread hears every sequence it can hear in the hold world, with no axiom assumed, and posts and sends what the model says"
  - `lib/fv-worker-model.test.ts`: "replay: the real thread hears every sequence it can hear from a worker's release on, with no axiom assumed"
  - `lib/fv-worker-model.test.ts`: "replay: the real mirror and readout hear every sequence they can hear with the port in order, and land where the model says"
  - `lib/fv-worker-model.test.ts`: "replay: with the port out of order and the thread dead, the real mirror and readout take every transition of what they can hear"
  - `lib/fv-worker-model.test.ts`: "replay: through the real thread, its in-process transport, the real mirror and the real readout, a set of traces takes every transition of what all of it hears"
  - `lib/fv-worker-model.test.ts`: "replay: the two-worker world, each side by every transition of what it hears, and both at once to every landing"
  - `lib/fv-worker-model.test.ts`: "replay: the real session, installer and readout hear every sequence of the dedicated world"
  - `lib/fv-worker-model.test.ts`: "replay: each word the model drops, the real thread makes nothing of, from that state on through every transition, in the hold and stream worlds"
  - `lib/fv-worker-model.test.ts`: `the table's need, of the real code: ${property} in the ${world.name} world, under ${assumptions.join(" ")}`
  - `lib/fv-worker-model.test.ts`: `the named trace frozen as ${form}, with ${cause}, goes through the real code: the real readout excludes a worker that ran unobserved`
  - `lib/fv-worker-model.test.ts`: "the @11 rule, in the real readout, is caught by the world's facts on a worker that ran and went away held"
- **Variants:**
  - `lib/fv-worker-model.test.ts`: names beginning "the replay catches a variant"
  - `lib/fv-worker-model.test.ts`: "the world's facts catch a thread that takes no resume for a broken hold, as a worker read though it ran unobserved"
  - `lib/fv-worker-model.test.ts`: "the replay catches a variant of the thread: a resume, or a pause at a statement, behind the install's answers breaks the hold"
  - `lib/fv-worker-model.test.ts`: "the replay catches a variant of the thread: a pause at a statement after the install's answers breaks the hold"
  - `lib/fv-worker-model.test.ts`: "the replay catches a variant of the main thread: late is not terminal, once the port is out of order"
  - `lib/fv-worker-model.test.ts`: "the whole replay catches a variant of the thread: a report that says more than the main side's own replay words"
  - `lib/fv-worker-model.test.ts`: "the replay catches a variant of the dedicated readout: an install's late answer upgrades a worker the pause bound concluded"
  - `lib/fv-worker-model.test.ts`: "the replay catches a variant of the dedicated channel: a detach before the resume is not taken as dying paused"
  - `lib/fv-worker-model.test.ts`: "the world's facts catch a thread that drops a broken hold's late, as a worker excluded though it ran unobserved"
  - `lib/fv-worker-model.test.ts`: "the world's facts catch a readout that lands a worker in no term, as one that ran before the freeze"
  - `lib/fv-worker-model.test.ts`: "the world's facts catch a dedicated install whose late answer upgrades a worker the pause bound concluded, as a read of one that ran unobserved"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### F4-HAND. What lies outside the model's alphabet, by hand

- **Property:** Words and bounds outside the model's alphabet go through the real thread as the tests write them out, including a hold's default bound and the commands a visit may send.
- **Code:** `sharedWorkerAttacherThread` in `lib/shared-worker-attacher.ts`.
- **Domain:** The cases the tests write out.
- **Bounds:** none beyond those cases.
- **Axioms:** none
- **Method:** sampled
- **Tests:**
  - `lib/fv-worker-model.test.ts`: `by hand, through the real thread: ${name}`
  - `lib/fv-worker-model.test.ts`: "by hand, through the real thread: a hold's bound is 3 seconds when nothing else is asked"
- **Variants:** none: each templated case catches its own variant of the thread inside the test, and the hold's default bound is read directly.
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

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

## Open findings

Each finding below is pinned by a test as the code behaves, not as it should.
None is claimed, and none is fixed: changing one moves what a report means,
which is the owner's call.

### OPEN-RA6.1. A worker's request takes the stack of an observation the page never reported

- **Finding:** A worker's request in the check's scroll window takes the stack of an observation in the lead that the page never reported. This is where RA6's first axiom fails. Whether Chromium sends such an observation is not measured.
- **Tests:**
  - `lib/scroll-check-stacks.test.ts`: "open (RA6): a worker's request in the window takes the stack of an observation in the lead that the page never reported"
- **Commit:** 8cd96197eb96efc3dcd38efbb7dbf18876ec0093

### OPEN-RA6.2. A worker's request takes the stack of a request reported after the evidence

- **Finding:** A worker's request in the window takes the stack of a later request whose page event comes after the evidence is built. This is where RA6's last axiom fails. Whether Chromium produces it is not measured.
- **Tests:**
  - `lib/scroll-check-stacks.test.ts`: "open (RA6): a worker's request in the window takes the stack of a later request whose page event comes after the evidence"
- **Commit:** 0931b39082ba9e682e9b9ac0cded7da38b483930

### OPEN-F3.1. One frame on a host with a leading dot costs the check its stacks

- **Finding:** A frame whose URL names a host with a leading dot makes the validator refuse its group, and the check drops every stack of every host. A page could hide its stacks this way; no count is wrong, and the check is in the immediate result only.
- **Tests:**
  - `lib/fv-scroll-producer.test.ts`: "open (RA4): one frame on a host with a leading dot costs the whole check its stacks"
- **Commit:** 8d1ec26228f9e2a518f31150071da3a4ceed382c

### OPEN-F3.2. A listed host the validator refuses empties the check

- **Finding:** A listed host with a leading dot, or one that publishes as the marker beside a host on another site, makes the validator refuse the window, and the whole check becomes a bare cut-short, in the immediate result only. Whether such a host can be sent and answered is not measured.
- **Tests:**
  - `lib/fv-scroll-producer.test.ts`: "open (RA4): a listed host the validator refuses turns the whole check into a bare cut-short"
- **Commit:** 8d1ec26228f9e2a518f31150071da3a4ceed382c

### OPEN-F3.3. A dedicated worker attached in the drain lands in no term

- **Finding:** A dedicated worker attached in the drain is counted as attached and lands in no term. Paused at its attach, only the diagnostics show it; running at its attach, it is no unread realm, where the same worker attached before the call counts as an unread realm. This moves the readout's unread realms, which the suite's docblock says feed the published count. Whether Chromium attaches a running worker in a drain is not measured.
- **Tests:**
  - `lib/fv-worker-readout.test.ts`: "open (CL7): a dedicated worker attached in the drain lands in no term, paused or running"
- **Commit:** 8d1ec26228f9e2a518f31150071da3a4ceed382c

### OPEN-F3.4. An unwitnessed worker masks a witnessed one

- **Finding:** The witness is a count, and nothing joins it to the workers that attached, so a worker the witness never saw, attached before the freeze or in the drain, stands in for a witnessed worker that never attached. This moves the readout's unread realms, which the suite's docblock says feed the published count. How often a witness and its attaches disagree this way is not measured.
- **Tests:**
  - `lib/fv-worker-readout.test.ts`: "open (CL7): an unwitnessed worker, attached before the freeze or in the drain, masks a witnessed worker that never attached"
- **Commit:** 8d1ec26228f9e2a518f31150071da3a4ceed382c

### OPEN-F3.5. A gap in the drain leaves a worker read at its older snapshot

- **Finding:** A gap in the drain before the barrier's answer leaves the worker read at its older snapshot with no unread realm, where a gap before the call reads as a broken stream. It needs a lost or oversized emission, which the observer does not produce.
- **Tests:**
  - `lib/fv-worker-readout.test.ts`: "open (CL7): a gap in the drain before the barrier's answer leaves the worker read at its older snapshot"
- **Commit:** 8d1ec26228f9e2a518f31150071da3a4ceed382c

### OPEN-F3.6. A worker an earlier installer still holds at a channel close reads excluded

- **Finding:** A dedicated worker an earlier installer still holds when the channel closes reads excluded. The test's earlier installer holds until released; read again after, the worker reads lost with the channel. The suite reasons that the real GPC installer reads so only within the close's tick, in which no readout can start, so no saved report reads it.
- **Tests:**
  - `lib/fv-worker-readout.test.ts`: "open (CL8a): a dedicated worker an earlier installer still holds when the channel closes is excluded until its flow moves on"
- **Commit:** 8d1ec26228f9e2a518f31150071da3a4ceed382c

### OPEN-F4.1. A release in flight at the freeze reads as excluded

- **Finding:** The headline of F4, an implementation finding. The readout takes a worker released, or still held at the bound, as having run nothing before the freeze, and that is false for a release in flight at the freeze: the worker's disable lands, it runs with its observer, and the mirror hears of it one hop later, before the bound. The same false premise is in the reaching branch and in the second pass, which needs no second worker. A failed install in the same window lands the same way, having run with no observer, so measuring latency cannot close either exclusion row. In the axiom table, `excluded-implies-no-page-code-before-the-freeze` and `excluded-implies-no-unobserved-page-code-before-the-freeze` hold under no subset of A1 to A5 in the shared worlds taken together.
- **Tests:**
  - `lib/fv-worker-model.test.ts`: `open (F4, ${kind}): ${name}, which rests on ${rests}`
- **Cases:**
  - "an ordinary hold whose release is one hop from the mirror at the freeze, frozen as held, is excluded though it ran, with its observer in"
  - "the same, frozen as reaching, with only its attach heard at the freeze"
  - "the same, read by the second pass, with every report on the port at the freeze"
  - "a failed install in the same window is excluded though the worker ran with no observer"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### OPEN-F4.2. The named trace, by each of its causes

- **Finding:** A worker held at the freeze and still at the bound, having run unobserved, is excluded. In the model, A5's latency half closes one cause, for a worker frozen held or reaching; the others rest on what no axiom states: socket-to-port latency for what the browser emitted before the freeze, the same bound read across a connection that closes behind the freeze, and the thread's own hold bound, which needs a resume held on the socket past that bound. Each case names what would rule it out.
- **Tests:**
  - `lib/fv-worker-model.test.ts`: `open (F4, ${kind}): ${name}, which rests on ${rests}`
- **Cases:**
  - "held at the freeze and at the bound, with its late on the port, is excluded though it ran unobserved"
  - "held at the freeze and at the bound, with its late posted after the freeze, is excluded though it ran unobserved"
  - "held at the freeze and at the bound, with its resume still on the thread's socket, is excluded though it ran unobserved"
  - "held at the freeze, its hold's bound fires before the resume is heard, and it is excluded though it ran unobserved"
  - "held at the freeze, the connection closes behind it with the resume on its socket, and it is excluded though it ran unobserved"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### OPEN-F4.3. A worker that ran can land in no term

- **Finding:** The row `a-worker-that-ran-before-the-freeze-lands-in-a-term` holds under no subset of A1 to A5. A worker that ran lands in no term by the first way only in the model's alphabet, where discovery on the page's connection is a free step: production reads that discovery after the frame tree and counts a worker it found with no report as unattached, which is unread, so the first way needs the frame tree ahead of the discovery, one order on one connection. The other way the row fails is the page's channel lost at the freeze, when the frame tree comes back at once. Pinned beside it, outside the row (which asks only while the attacher lives): an attach lost with the attacher's connection, with no discovery. Each pin is replayed through the real code. Ordering inside Chromium is not read.
- **Tests:**
  - `lib/fv-worker-model.test.ts`: `open (F4, ${kind}): ${name}, which rests on ${rests}`
  - `lib/fv-worker-model.test.ts`: "open (F4, environment axiom): with the page's channel lost at the freeze, a worker that ran, with its attach on the port, lands in no term"
- **Cases:**
  - "a worker that ran, whose attach is on the port when the frame tree answers, lands in no term"
  - "a worker whose attach went down with the connection, which ran when Chromium let it, lands in no term"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### OPEN-F4.4. Attached after the freeze by the mirror's clock, and excluded

- **Finding:** The second pass again, with another worker holding the drain open and the attacher alive: a worker attached after the freeze by the mirror's clock, released, is excluded though it ran before the freeze. It holds under C1 and D1 too, so no latency bound closes it.
- **Tests:**
  - `lib/fv-worker-model.test.ts`: "open (F4, implementation): attached after the freeze by the mirror's clock, released, and excluded, though it ran before the freeze, with another worker's drain open"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### OPEN-F4.5. A detach that overtakes a worker's last emission

- **Finding:** If a detach can overtake a resume, it can overtake a last emission, and @12 then reads a gone worker at the snapshot before it, short of its last task. It can reach a saved report. Whether a detach overtakes is the plan's ordering study, not measured.
- **Tests:**
  - `lib/fv-worker-model.test.ts`: "open (A3): a worker whose detach overtakes its last emission is read at the snapshot before it"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3

### OPEN-F4.6. A dedicated worker already running when it attached

- **Finding:** The readout counts an attached dedicated worker with no record as held, and the channel takes a detach before its resume as dying paused; neither reads whether the worker waits for the debugger. A worker already running when it attached reads held inside the arming's round trip, and excluded at every later readout if it goes in that window. It can reach a saved report. How often a dedicated worker attaches already running is not measured.
- **Tests:**
  - `lib/fv-worker-model.test.ts`: "open (dedicated): a worker already running when it attached is excluded inside the arming's round trip"
- **Commit:** 5aea6d6120edcb929a3576b502cd2f5a638115d3
