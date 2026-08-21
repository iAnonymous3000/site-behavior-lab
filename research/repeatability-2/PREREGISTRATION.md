# Instrument repeatability, study 2. Declared 2026-08-21

**Status: design declared, frame not yet fixed, not collected.** No scan in this
study has run. Two things must land before collection begins: the frame file
(below) and the instrument extension (below). Both are named here so that
neither can be chosen after seeing a result.

The design below is fixed as of this commit. If any part of it changes, this
file records the change and the reason before collection begins, or the study is
abandoned and redeclared.

Successor to [`research/repeatability/`](../repeatability/PREREGISTRATION.md),
whose findings become this study's questions rather than a patch to it.

## Why there is a second study

Study 1 published a repeatability result whose two preregistered eligibility
checks were both inoperative. The correction is recorded in
[`research/repeatability/RESULT.md`](../repeatability/RESULT.md). The root cause
is worth stating exactly, because it decides this study's instrument:

`scripts/repeatability-run.mjs:63` reads `run?.quality?.run?.outcome`.
`scripts/scanner-fidelity-invariants.mjs:168` reads the same expression. The
second one works and the first one cannot, because the fidelity module is handed
a **v2 public report**, which carries `run.quality`, and study 1's collector was
handed a frozen-v1 `ScanResult` (`lib/types.ts:371`), which has no `run` wrapper
and no `quality` field at all. The check silently resolved to `"complete"` on
every run. A second, hand-written cap test could never match the producer's
warning string either.

Study 1 hand-built an eligibility rule that this repository already implements,
tests, and uses. That is the defect. The fix is not a better hand-built rule.

## Instrument: the attempt ledger, not a new collector

This study collects through
[`scripts/smoke-scanner-fidelity.mjs`](../../scripts/smoke-scanner-fidelity.mjs)
into the attempt ledger defined by
[`scripts/scanner-fidelity-study-lib.mjs`](../../scripts/scanner-fidelity-study-lib.mjs).
No study-specific collector is written.

What that buys, none of which study 1 had:

- **Every attempt is recorded, including failures.** A refused target is written
  as `outcome: "scan-failure"` with a sanitized reason, not dropped.
- **`totalRequests` is a first-class metric.** Study 1 could not decide cap
  saturation from its own artifact because it never recorded this.
- **Eligibility is structural, not a string match.** `classifyObservation`
  reads `run.quality.byFamily.requests.outcome` from the producer's own quality
  ledger.
- **Every exclusion keeps its reason.** `summarizeRepeatability` returns
  `excludedTargets` with `recordedRuns`, `eligibleRuns`, and sorted reasons.
- **The frame, the build, and the driver are bound into the artifact** by
  `sitesFileDigest`, `expectedBuildCommit`, `measurementIdentityDigest`, and
  `driverRuntime`.
- **Identity drift excludes a target.** If the execution, measurement
  environment, or condition fingerprint moves between repetitions, that target
  is excluded rather than scored across two different instruments.

## Eligibility, by citation

The rule is `classifyObservation` and `MINIMUM_REPEATABILITY_RUNS` in
`scripts/scanner-fidelity-study-lib.mjs`. It is **not restated here in prose**,
because a prose restatement that drifts from the code is precisely what study 1
published. Reviewers check the code.

Two consequences are worth naming, since they are the clauses study 1 meant to
have:

- An arm whose `runOutcome` is not `complete`, or whose `requestOutcome` is not
  `complete`, is excluded. Request-family censoring includes the recording cap,
  so the runs study 1 could not screen are excluded here by construction.
- A target with fewer than `MINIMUM_REPEATABILITY_RUNS` eligible repetitions is
  excluded entirely and reported in `excludedTargets`, never averaged over
  fewer repeats.

## Procedure, and the three ways it silently collects nothing

Declared here because each of these produces an empty or fully-excluded study
that still exits successfully.

1. **The report producer must be in r2 mode, and that takes three environment
   variables together, not one.** `publicR2ReportsReadiness`
   (`lib/runtime-scan-report.ts`) requires
   `SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS=1`, a full 40-character
   `SITE_BEHAVIOR_LAB_BUILD_COMMIT`, and
   `SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION=1`. The per-family quality block that
   `requestOutcome` reads exists only in r2.

   The two failure modes differ, and only one of them is loud:

   - **Flag unset or `0`:** the server produces v1 perfectly happily.
     `run.quality.byFamily` does not exist, `requestOutcome` is `null`, and
     **every arm is excluded as `run-requests-incomplete`**. The study completes
     and reports zero eligible targets. This is the silent one, and it is the
     one that would look like a finding.
   - **Flag `1` with a prerequisite missing:** admission outage. A requested but
     unready r2 producer is never permission to emit v1 instead, so this fails
     visibly.

   Before collection, confirm on a single scan that `run.quality.byFamily`
   is present in the response body. Do not begin a 300-scan run without it.
2. **`SITE_BEHAVIOR_LAB_BUILD_COMMIT` is required in the server process**,
   which is where the report is produced. `buildRuntimeScanReportV2R2` rejects
   the report outright as `build-provenance-missing` otherwise.
3. **The same value must also be set for the driver process**, which reads it as
   `EXPECTED_BUILD_COMMIT` and cross-checks it against what the server reported.
   Setting it on only one of the two processes is the easy mistake.

`.github/workflows/scanner-fidelity.yml` sets all of these, and is the reference
for the local invocation.

Conditions are fixed by `SCANNER_FIDELITY_MODE=single`, which the driver records
as `device: desktop`, `gpcEnabled: false`, `consentMode: "observe"`. These are
study 1's conditions unchanged, so the two studies remain comparable.

## Frame and size, fixed before collection

- **Frame:** a study-local file at `research/repeatability-2/frame.json`, passed
  as `SCANNER_FIDELITY_SITES`, whose bytes are hashed into the ledger as
  `sitesFileDigest`. **That file does not exist yet.** This declaration is not
  complete, and collection may not begin, until it is committed together with
  the screening pass that produced it: which URLs were screened, when, and which
  were rejected for refusing automation. A frame assembled after seeing any
  result from this study voids the declaration. The CI frame at `public/scanner-fidelity-sites.json` is
  **not** used: it holds ten targets chosen to exercise scanner invariants,
  including deliberately quiet sites, which is a different sampling purpose.
- **Frame size:** 100 URLs, carried forward under study 1's rule, that a prior
  screening pass observed serving an honest automated browser. As in study 1,
  this excludes sites that refuse automation, so the result describes
  repeatability **on pages this scanner can measure at all** and must never be
  stated as repeatability over the open web.
- **Repeats:** k = 3, back to back. `SCANNER_FIDELITY_REPETITIONS` accepts 1
  through 5; k = 3 is study 1's value, kept for comparability, and 5 is the
  design ceiling if a future study wants more.
- **Expected cost:** study 1 averaged 12.0 s per scan over 60 scans. 100 targets
  at k = 3 is 300 scans, roughly 60 minutes serial.

**Why 100 and not 20.** Study 1 could not carry a detector agreement rate at
n = 20: 19/20 has a 95% Wilson interval of [0.76, 0.99], and even a clean 17/17
gives [0.82, 1.00]. At n = 100, perfect agreement gives a lower bound of 0.963.
The frame is sized to the interval the study intends to publish, before
collection, rather than reporting whatever interval the frame happened to
support.

**Minimum denominator.** The detector agreement measure is published only if at
least 60 targets are eligible. Below that the agreement result is reported as
its raw fraction with its interval and explicitly not as a rate. The spread
distributions publish at whatever denominator survives, always stated.

## Measures

### Available from the ledger with no code change

1. **Relative spread per target per metric**, over `totalRequests`,
   `thirdPartyRequests`, `knownTrackerRequests`, and `thirdPartyDomains`.
   Reported as `(max - min) / mean`, computed from the per-attempt counts the
   ledger retains, which preserves continuity with study 1's published figure.
   The ledger's own `metricSummary.relativeRange` is `(max - min) / median` and
   is reported **alongside**, never in place of it. Two different denominators
   must not be published under one name.
2. **Exact agreement** per target per metric: `range === 0` across the eligible
   repeats.
3. **Third-party domain Jaccard**, min and median pairwise
   (`summarizeArm.thirdPartyDomainJaccard`). New in this study. A count can
   repeat exactly while the underlying set churns, so this measures something
   the counts cannot.
4. **The exclusion ledger itself**: how many targets were excluded and for which
   reasons. Study 1's central failure was reporting an exclusion count of zero
   that no mechanism could have produced, so this is a published result here,
   not a footnote.

### Requiring a declared prerequisite

`armObservation` in `scripts/scanner-fidelity-invariants.mjs` is deliberately
privacy-reduced and carries neither of these:

5. **Third-party cookies**, a metric study 1 published.
6. **Per-detector outcome agreement.** Study 1's headline finding was a detector
   agreement figure.

These are **not dropped**. Dropping them would narrow the study to fit the
instrument, which is the failure mode this project's freeze-schedule decision
prohibits by name. They are declared as a prerequisite code change that must
land, and be reviewed, **before collection begins**:

> Extend `armObservation` to carry `thirdPartyCookies` from the run summary and,
> per detector, the `status` and outcome from the detector ledger rather than
> the length of a detections array. A detector reporting `partial` because its
> own capture was cut must be distinguishable from one that ran fully and found
> nothing, which study 1 could not do.

The privacy argument for the extension, to be reviewed on its own terms: both
additions are already public facts in every published report, and the
observation already carries a list of third-party domains, which is
substantially more disclosive than a cookie count and a detector status.

Collection begins only after that change lands. A change to the instrument
**during** collection is an identity violation, not a threshold failure, and
would end this study.

## The question study 1 handed forward

`cname-uncloaking` disagreed with itself across three consecutive visits to one
page. Study 1 could not say why, and the row it happened on was the one least
defensible as eligible. Three mechanisms remain unseparated: candidate
truncation from a capped request log, the ten-host resolution slice in
request-arrival order (`MAX_CNAME_LOOKUPS`, `lib/scanner.ts:278`), and live DNS
resolution failure.

This study **separates the first from the other two by construction**, because a
request-censored run is now excluded before it can contribute. It does not
separate the second from the third. Doing so needs the detector to record how
many candidates it omitted and how many lookups failed, which
`resolveCnameCloaks` already returns as `omittedCandidateCount`. Whether that
reaches the ledger is part of the prerequisite above; if it does not, this study
reports the disagreement rate and explicitly does not attribute it.

## What this study still cannot conclude

- Nothing about accuracy. A repeatable detector can be repeatably wrong.
- Nothing about sites that refuse automation.
- Nothing about variation across networks, regions, times of day, or machines,
  unless the collection is sharded across more than one of them, in which case
  the identity-drift exclusion will remove those targets rather than average
  over them.
- Nothing about a different build. The identity is bound into the ledger.
- Nothing about the open web. The frame is a screening-passing subpopulation and
  every figure inherits that.

## Publication rule

The result is published with its conditions, its denominator, and its exclusion
ledger, or it is not published. "The distributions are too wide to support a
noise floor" remains a correct and useful outcome.

Findings become the next study, never a patch to this one.
