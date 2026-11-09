import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVE_PROBE_SUBJECT_WARNING, CONSENT_RELOAD_SUBJECT_WARNING } from "./active-probe-subject-warnings";
import { PAGE_SUBJECT_UNVERIFIED_WARNING, SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING } from "./bot-wall-classifier";
import * as productionEligibility from "./comparison-eligibility";
import { CONSENT_CMP_SELECTORS, CONSENT_PROBE_OUTCOMES, consentInteractionWarning } from "./consent-interaction";
import { CONSENT_INTERACTION_LEFT_SUBJECT_WARNING } from "./consent-subject-loss-warning";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";
import { GPC_WORKER_CAPTURE_LOSS_WARNING } from "./gpc-injection";
import { publicStringPolicyInputs, RedactionPass, redactScannerWarnings } from "./redact-scan-report-v1";
import {
  AUXILIARY_PAGE_REQUESTS_BLOCKED_WARNING,
  CNAME_CANDIDATES_OMITTED_WARNING,
  CNAME_LOOKUP_FAILED_WARNING,
  CONSENT_BANNER_CHECK_INCOMPLETE_WARNING,
  FINGERPRINT_CANVAS_EVIDENCE_BOUNDED_WARNING,
  FINGERPRINT_CANVAS_FONT_EVIDENCE_BOUNDED_WARNING,
  FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING,
  FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING,
  FINGERPRINT_WORKER_REALM_CAPTURE_LOSS_WARNING,
  INVALID_UPSTREAM_RESPONSE_WARNING,
  KEYSTROKE_PROBE_INCOMPLETE_WARNING,
  KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING,
  KEYSTROKE_PROBE_PAGE_LEFT_WARNING,
  KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING,
  KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING,
  LISTENER_DETECTION_WITHHELD_WARNING,
  PAGE_LEFT_SUBJECT_BEFORE_STATE_WARNING,
  PIXEL_DECODE_CAPTURE_LOSS_WARNING,
  POLICY_LINK_SEARCH_INCOMPLETE_WARNING,
  STORAGE_SNAPSHOT_CAPTURE_LOSS_WARNING,
  UNSETTLED_ROUTED_REQUEST_WARNING
} from "./scan-runtime";
import { sharedWorkersEndedAtOnceWarning } from "./shared-worker-ended-at-once";

/**
 * CL6, an exhaustive check of which warning lines each loss predicate reads.
 *
 * A v1 report's censoring turns on substrings of its warnings, restated in
 * comparison-eligibility.ts because it runs in client bundles. Such a predicate fails
 * two ways no per-line test sees: a fragment that stops matching its own line, and a
 * fragment that also matches another line. So the whole matrix is pinned below.
 *
 * Domain: every fixed line the public-string policy admits, and every dynamic form its
 * patterns admit at counts 1, 2 and a large one, with both consent modes, every outcome
 * and every catalogued banner, each alone in a run and among all the others. That list
 * of forms is written by hand, so it is held two ways: each must really be admitted, and
 * the pattern version it was written against is pinned, so a new pattern that moves the
 * version stops here. A new consent form need not move it, so the one form left out is
 * pinned as refused. Outside this: runHitRequestCap's count of requests, which reads no
 * warning; runHitRequestRecordingCap in scan-report-views.ts, which restates one fragment;
 * and the producer ever writing these lines at the right moment.
 */

type Eligibility = typeof productionEligibility;

const PATTERN_VERSION_THE_FORMS_FOLLOW = "scanner-warning-patterns-v10";
const LARGE_COUNT = 1000;

const counted = (form: (count: number) => string) => [form(1), form(2), form(LARGE_COUNT)];
const requestCapLines = counted((count) => `The scan stopped recording or loading additional requests after ${count} requests.`);
const responseCapLines = counted((count) => `The scan stopped loading additional response bytes after reaching the ${count} MiB aggregate response-byte budget.`);
const uploadCapLines = counted((count) => `The scan stopped forwarding additional request bytes after reaching the ${count} MiB aggregate upload-byte budget.`);
const sharedWorkerLines = counted(sharedWorkersEndedAtOnceWarning);

const OMITTED_REQUESTS = "Requests from this incomplete probe were omitted from the recorded request log and counts.";
const FIELD_COUNTS = ["1 form field", "2 form fields", `${LARGE_COUNT} form fields`];
const typedCurrent = (fields: string, tail: string) =>
  `This scan typed a synthetic test value into ${fields} with native form submission blocked. Focus, input and blur handlers may run and send requests. The value is synthetic and is not stored. ${tail}`;
const typedHistorical = (fields: string, tail: string) =>
  `This scan typed a synthetic test value into ${fields} (never submitting the form) to test whether typed input is captured and sent to third parties. The value is synthetic and is not stored.${tail}`;
const typedOmittedLines = FIELD_COUNTS.flatMap((fields) => [typedCurrent(fields, OMITTED_REQUESTS), typedHistorical(fields, ` ${OMITTED_REQUESTS}`)]);

const MODES = ["accept-all", "reject-all"] as const;
const CONSENT_FAILURES = CONSENT_PROBE_OUTCOMES.filter((outcome) => outcome !== null);
const consentFailureLines = MODES.flatMap((mode) => CONSENT_FAILURES.map((failure) => consentInteractionWarning({ mode, clicked: false }, failure)));

const PROXY_BUDGET_LINE = "The scan stopped opening additional proxy requests after reaching its connection and target safety budget.";

/**
 * The lines the route guard writes for a request it refused as not verifiably
 * public: both labelled forms, and the summary line past the example limit.
 * The non-HTTP(S) line beside them stays unread (unmatchedDynamicLines).
 */
const routeGuardRefusalLines = [
  "Blocked a request that could not be verified as public: https://example.com/",
  "Blocked a request that could not be verified as a public HTTP(S) URL: https://example.com/",
  "Blocked additional requests that could not be verified as public. Only the first 5 examples are shown."
];

/** The dynamic forms the patterns admit that no predicate should read. */
const unmatchedDynamicLines = [
  ...[100, 404, 999].map((status) => `The page returned HTTP ${status}; this report reflects an error or block page, not a normal load.`),
  ...counted((count) => `Skipped PageGraph request ${count} because its URL was not HTTP(S).`),
  "Resolved 1 first-party subdomain that is a CNAME alias for a third-party tracker (CNAME cloaking), which request-URL matching alone would miss.",
  "Resolved 1 first-party subdomain that are CNAME aliases for third-party trackers (CNAME cloaking), which request-URL matching alone would miss.",
  "Resolved 2 first-party subdomains that are CNAME aliases for third-party trackers (CNAME cloaking), which request-URL matching alone would miss.",
  `Resolved ${LARGE_COUNT} first-party subdomains that are CNAME aliases for third-party trackers (CNAME cloaking), which request-URL matching alone would miss.`,
  ...FIELD_COUNTS.flatMap((fields) => [
    typedCurrent(fields, "Observed requests during typing and the following wait are included in the request log. Teardown-only transmissions are not measured."),
    typedHistorical(fields, ""),
    typedHistorical(fields, " Requests the page sent during and after this typing, including any unload beacons, are part of the recorded request log and counts.")
  ]),
  'The two visits ran in randomized order; the "GPC off" visit ran first.',
  "Blocked a non-HTTP(S) request: https://example.com/",
  "Read the site's privacy policy (https://example.com/) and compared its text against this visit's observed behavior. Policy checks are an automated text match with the matched sentences quoted, not a legal reading.",
  ...MODES.flatMap((mode) => [
    consentInteractionWarning({ mode, clicked: false }),
    ...CONSENT_CMP_SELECTORS.map((entry) => consentInteractionWarning({ mode, clicked: true, cmp: entry.cmp })),
    consentInteractionWarning({ mode, clicked: true, matchedText: mode === "accept-all" ? "accept all" : "reject all" })
  ])
];

/**
 * Exactly the lines each predicate reads. A line in the domain that is not listed here
 * for a predicate must not match it. Spelled through the producers' own constants where
 * they exist, so this reads as the intent, and so a reworded constant moves with it.
 */
const SINGLE_PREDICATE_LINES: Readonly<Record<string, readonly string[]>> = {
  runHitRequestCap: requestCapLines,
  runHitSuspectedChallengeOrSoftBlock: [SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING],
  runHitPageSubjectUnverified: [PAGE_SUBJECT_UNVERIFIED_WARNING],
  runHitResponseByteCap: responseCapLines,
  runHitUploadByteCap: uploadCapLines,
  runHitGpcWorkerCaptureLoss: [GPC_WORKER_CAPTURE_LOSS_WARNING],
  runHitInvalidUpstreamResponseCaptureLoss: [INVALID_UPSTREAM_RESPONSE_WARNING],
  runHitProxyTrafficBudget: [PROXY_BUDGET_LINE],
  runHitUnsettledRoutedRequests: [UNSETTLED_ROUTED_REQUEST_WARNING],
  runHitFingerprintObserverCaptureLoss: [FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING],
  runHitFingerprintListenerAttributionLoss: [FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING],
  runHitFingerprintWorkerRealmLoss: [FINGERPRINT_WORKER_REALM_CAPTURE_LOSS_WARNING],
  runHitFingerprintCanvasEvidenceBounded: [FINGERPRINT_CANVAS_EVIDENCE_BOUNDED_WARNING],
  runHitFingerprintCanvasFontEvidenceBounded: [FINGERPRINT_CANVAS_FONT_EVIDENCE_BOUNDED_WARNING],
  runHitFingerprintSharedWorkersEndedAtOnce: sharedWorkerLines,
  runHitListenerDetectionWithheld: [LISTENER_DETECTION_WITHHELD_WARNING],
  runHitPixelDecodeCaptureLoss: [PIXEL_DECODE_CAPTURE_LOSS_WARNING],
  runHitKeystrokeProbeCaptureLoss: [KEYSTROKE_PROBE_INCOMPLETE_WARNING],
  runHitKeystrokeProbeRequestUnread: [KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING],
  runHitKeystrokeProbeTestIncomplete: [KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING],
  runHitKeystrokeProbeNavigationStopped: [KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING],
  runHitKeystrokeProbeRequestsOmitted: typedOmittedLines,
  runKeystrokeProbePageLeft: [KEYSTROKE_PROBE_PAGE_LEFT_WARNING],
  runPageLeftSubjectBeforeState: [PAGE_LEFT_SUBJECT_BEFORE_STATE_WARNING],
  runHitAuxiliaryPageRequestsBlocked: [AUXILIARY_PAGE_REQUESTS_BLOCKED_WARNING],
  runHitRouteGuardRequestsBlocked: routeGuardRefusalLines,
  runKeystrokeProbeLeftSubject: [CONSENT_INTERACTION_LEFT_SUBJECT_WARNING, CONSENT_RELOAD_SUBJECT_WARNING, ACTIVE_PROBE_SUBJECT_WARNING],
  runConsentInteractionLeftSubject: [CONSENT_INTERACTION_LEFT_SUBJECT_WARNING],
  runHitStorageSnapshotCaptureLoss: [STORAGE_SNAPSHOT_CAPTURE_LOSS_WARNING],
  runHitPolicyLinkSearchIncomplete: [POLICY_LINK_SEARCH_INCOMPLETE_WARNING],
  runHitCnameCandidatesOmitted: [CNAME_CANDIDATES_OMITTED_WARNING],
  runHitCnameLookupFailed: [CNAME_LOOKUP_FAILED_WARNING],
  runConsentBannerIncomplete: [CONSENT_BANNER_CHECK_INCOMPLETE_WARNING, ...consentFailureLines],
  runConsentReloadLeftSubject: [CONSENT_RELOAD_SUBJECT_WARNING]
};

/** The lines that censor the request family, read through the predicates that make it up. */
const REQUEST_EVIDENCE_PREDICATES = [
  "runHitRequestCap",
  "runHitResponseByteCap",
  "runHitUploadByteCap",
  "runHitGpcWorkerCaptureLoss",
  "runHitInvalidUpstreamResponseCaptureLoss",
  "runHitKeystrokeProbeCaptureLoss",
  "runHitKeystrokeProbeNavigationStopped",
  "runHitKeystrokeProbeRequestsOmitted",
  "runKeystrokeProbePageLeft",
  "runConsentInteractionLeftSubject",
  "runPageLeftSubjectBeforeState",
  "runHitAuxiliaryPageRequestsBlocked",
  "runHitRouteGuardRequestsBlocked",
  "runHitProxyTrafficBudget",
  "runHitUnsettledRoutedRequests"
] as const;

const EXPECTED_LINES: Readonly<Record<string, readonly string[]>> = {
  ...SINGLE_PREDICATE_LINES,
  runRequestEvidenceCapped: REQUEST_EVIDENCE_PREDICATES.flatMap((predicate) => SINGLE_PREDICATE_LINES[predicate])
};

/** Predicates that read a whole line, so a comparison's label in front of it hides the line from them. */
const EXACT_PREDICATES: ReadonlySet<string> = new Set([
  "runHitSuspectedChallengeOrSoftBlock",
  "runHitPageSubjectUnverified",
  "runKeystrokeProbeLeftSubject",
  "runConsentInteractionLeftSubject",
  "runConsentReloadLeftSubject"
]);

const predicateNames = (module: Eligibility) => Object.keys(module).filter((name) => name.startsWith("run")).sort();

type Predicate = (run: { warnings: string[]; summary: { totalRequests: number } }) => boolean;

function matches(module: Eligibility, predicate: string, line: string): boolean {
  return ((module as unknown as Record<string, Predicate>)[predicate])({ warnings: [line], summary: { totalRequests: 0 } });
}

function readsRun(module: Eligibility, predicate: string, warnings: string[]): boolean {
  return ((module as unknown as Record<string, Predicate>)[predicate])({ warnings, summary: { totalRequests: 0 } });
}

function domainLines(): string[] {
  const inputs = publicStringPolicyInputs();
  const dynamic = [
    ...unmatchedDynamicLines,
    ...Object.values(EXPECTED_LINES).flat().filter((line) => !inputs.fixedWarnings.includes(line))
  ];
  return [...new Set([...inputs.fixedWarnings, ...dynamic])];
}

function checkMatrix(module: Eligibility, lines: readonly string[]): number {
  let cases = 0;
  for (const predicate of predicateNames(module)) {
    const expected = EXPECTED_LINES[predicate];
    holds("every-predicate-has-a-pinned-row", expected !== undefined, () => ({ predicate }));
    for (const line of lines) {
      cases += 1;
      const input = () => ({ predicate, line });
      if (expected.includes(line)) holds("a-predicate-still-reads-its-own-line", matches(module, predicate, line), input);
      else holds("a-predicate-reads-no-other-line", !matches(module, predicate, line), input);
    }
  }
  return cases;
}

/** A real run carries many lines: a predicate reads its line wherever it sits, and nothing from the rest. */
function checkMixedRuns(module: Eligibility, lines: readonly string[]): number {
  let cases = 0;
  for (const predicate of predicateNames(module)) {
    const own = EXPECTED_LINES[predicate];
    holds("every-predicate-has-a-pinned-row", own !== undefined, () => ({ predicate }));
    const others = lines.filter((line) => !own.includes(line));
    cases += 1;
    holds("a-predicate-reads-nothing-from-other-lines", !readsRun(module, predicate, others), () => ({ predicate, others: others.length }));
    for (const line of own) {
      cases += 2;
      holds("a-predicate-reads-its-line-among-others", readsRun(module, predicate, [line, ...others]), () => ({ predicate, line, at: "first" }));
      holds("a-predicate-reads-its-line-among-others", readsRun(module, predicate, [...others, line]), () => ({ predicate, line, at: "last" }));
    }
  }
  return cases;
}

/** What a predicate reads under a label: its pinned lines, except through a part that reads whole lines. */
function readsUnderALabel(predicate: string, line: string): boolean {
  const parts: readonly string[] = predicate === "runRequestEvidenceCapped" ? REQUEST_EVIDENCE_PREDICATES : [predicate];
  return parts.some((part) => !EXACT_PREDICATES.has(part) && EXPECTED_LINES[part].includes(line));
}

/**
 * Every caller hands these predicates one run's own warnings, which the scanner writes
 * with no label. compare-reports.ts and scan-report-views.ts label only a report-level
 * list. Nothing refuses a label on an uploaded run's list, where redaction admits one,
 * though an uploader could as easily delete the line. This pins what a labelled list
 * reads: whole-line predicates miss their lines, so runRequestEvidenceCapped misses the
 * consent line. That is why a report-level list must not be handed over, not something a
 * caller does.
 */
function checkLabelledLines(module: Eligibility, lines: readonly string[]): number {
  let cases = 0;
  const labels = publicStringPolicyInputs().warningLabels;
  for (const predicate of predicateNames(module)) {
    for (const line of lines) {
      for (const label of labels) {
        cases += 1;
        holds(
          "a-label-keeps-a-substring-reading-and-hides-a-whole-line",
          matches(module, predicate, `${label}: ${line}`) === readsUnderALabel(predicate, line),
          () => ({ predicate, line, label })
        );
      }
    }
  }
  return cases;
}

const eligibilityPath = require.resolve("./comparison-eligibility");
const variant = (...edits: SourceEdit[]) => loadVariant<Eligibility>(eligibilityPath, edits);
const LINES = domainLines();

test("the domain is what the policy admits, under the pattern version its forms were written against", () => {
  const inputs = publicStringPolicyInputs();
  assert.equal(
    inputs.dynamicWarningPatterns,
    PATTERN_VERSION_THE_FORMS_FOLLOW,
    "A new warning pattern moves what this domain must cover. Add its forms here, then move this pin."
  );
  assert.ok(inputs.fixedWarnings.length >= 62, `only ${inputs.fixedWarnings.length} fixed lines`);
  // The forms below, each outside the fixed list: 54, plus, per mode, the unclicked line, the labelled click and one per banner.
  assert.equal(LINES.length, inputs.fixedWarnings.length + 54 + 2 * (2 + CONSENT_CMP_SELECTORS.length));
  for (const line of LINES) {
    assert.deepEqual(redactScannerWarnings([line], new RedactionPass()), [line], `not an admitted line: ${line}`);
  }
});

test("the one consent click form left out of the domain is one the policy refuses", () => {
  for (const mode of MODES) {
    const bare = consentInteractionWarning({ mode, clicked: true });
    assert.notDeepEqual(redactScannerWarnings([bare], new RedactionPass()), [bare], "Now admitted: add it to the domain.");
  }
});

test("every consent outcome and every catalogued banner is in the domain", () => {
  assert.deepEqual(new Set(CONSENT_PROBE_OUTCOMES), new Set(["budget-unavailable", "scan-failed", "engine-unavailable", "search-interrupted", "frames-unreadable", "dispatch-unconfirmed", null]));
  assert.equal(consentFailureLines.length, 12);
  assert.ok(CONSENT_CMP_SELECTORS.length > 0);
});

test("every predicate has a pinned row, and every row reads something", () => {
  assert.deepEqual(predicateNames(productionEligibility), Object.keys(EXPECTED_LINES).sort());
  assert.equal(Object.keys(EXPECTED_LINES).length, 35);
  for (const [predicate, lines] of Object.entries(EXPECTED_LINES)) assert.ok(lines.length > 0, `${predicate} reads nothing`);
});

test("CL6: every predicate reads exactly its pinned lines, over every admitted line", () => {
  assert.equal(checkMatrix(productionEligibility, LINES), 35 * LINES.length);
});

test("CL6: a predicate reads its line anywhere in a run, and nothing from the others", () => {
  const pinned = Object.values(EXPECTED_LINES).reduce((sum, lines) => sum + lines.length, 0);
  assert.equal(checkMixedRuns(productionEligibility, LINES), 35 + 2 * pinned);
});

test("CL6: a comparison's label keeps every substring reading and hides a whole line", () => {
  const labels = publicStringPolicyInputs().warningLabels.length;
  assert.equal(checkLabelledLines(productionEligibility, LINES), 35 * LINES.length * labels);
});

for (const [name, property, find, replace] of [
  [
    "the worker line's fragment shortens to what the frame line shares",
    "a-predicate-reads-no-other-line",
    'FINGERPRINT_WORKER_REALM_WARNING_FRAGMENT = "could not read one or more Web Workers the page started"',
    'FINGERPRINT_WORKER_REALM_WARNING_FRAGMENT = "could not read one or more"'
  ],
  [
    "the canvas line's fragment shortens to the opening both canvas lines share",
    "a-predicate-reads-no-other-line",
    'FINGERPRINT_CANVAS_EVIDENCE_WARNING_FRAGMENT = "used more canvases or drew more canvas text than it keeps"',
    'FINGERPRINT_CANVAS_EVIDENCE_WARNING_FRAGMENT = "read every frame, but one or more"'
  ],
  [
    "the withheld line's fragment shortens to a clause the listener line shares",
    "a-predicate-reads-no-other-line",
    '"input-monitoring detections were withheld from this report"',
    '"for this visit are incomplete"'
  ],
  [
    "a probe fragment shortens to the opening every probe line shares",
    "a-predicate-reads-no-other-line",
    'KEYSTROKE_PROBE_INCOMPLETE_WARNING_FRAGMENT = "synthetic form-input probe ended before it finished"',
    'KEYSTROKE_PROBE_INCOMPLETE_WARNING_FRAGMENT = "synthetic form-input probe"'
  ],
  [
    "the consent list gains a phrase a completed search shares",
    "a-predicate-reads-no-other-line",
    '"the scan\'s time budget ran out before the banner search could run",',
    '"on a cookie/consent banner",'
  ],
  [
    "a fragment drifts from its line",
    "a-predicate-still-reads-its-own-line",
    'FINGERPRINT_OBSERVER_WARNING_FRAGMENT = "in-page fingerprint observer could not read one or more frames"',
    'FINGERPRINT_OBSERVER_WARNING_FRAGMENT = "in-page fingerprint observer could not read every frame"'
  ],
  [
    "the consent list loses a sentence",
    "a-predicate-still-reads-its-own-line",
    '"no frame could be read to search for one",\n',
    ""
  ],
  [
    "request evidence stops reading a line that censors it",
    "a-predicate-still-reads-its-own-line",
    "runHitUploadByteCap(run) ||\n        ",
    ""
  ],
  [
    "request evidence starts reading a claim-scoped line",
    "a-predicate-reads-no-other-line",
    "runHitUploadByteCap(run) ||\n        ",
    "runHitUploadByteCap(run) ||\n        runHitStorageSnapshotCaptureLoss(run) ||\n        "
  ]
] as const) {
  test(`CL6 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkMatrix(variant({ find, replace }), LINES));
  });
}

for (const [name, property, find, replace] of [
  [
    "a predicate needs every line to match",
    "a-predicate-reads-its-line-among-others",
    "function runHitUploadByteCap(run) {\n    return run.warnings.some(",
    "function runHitUploadByteCap(run) {\n    return run.warnings.every("
  ],
  [
    "a predicate reads only a run's first line",
    "a-predicate-reads-its-line-among-others",
    "function runConsentBannerIncomplete(run) {\n    return run.warnings.some(",
    "function runConsentBannerIncomplete(run) {\n    return run.warnings.slice(0, 1).some("
  ],
  [
    "a long run reads as a loss",
    "a-predicate-reads-nothing-from-other-lines",
    "function runHitUploadByteCap(run) {\n    return run.warnings.some(",
    "function runHitUploadByteCap(run) {\n    return run.warnings.length > 5 || run.warnings.some("
  ]
] as const) {
  test(`CL6 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkMixedRuns(variant({ find, replace }), LINES));
  });
}

test("CL6 catches a new admitted line a fragment would silently read", async () => {
  const newLine = "The scan stopped loading additional response bytes for a reason a later version adds.";
  await assertCaughtBy("a new line", "a-predicate-reads-no-other-line", () => checkMatrix(productionEligibility, [...LINES, newLine]));
});

test("CL6 catches a new predicate with no pinned row", async () => {
  const broken = variant({ find: "exports.runHitUploadByteCap = runHitUploadByteCap;", replace: "exports.runHitUploadByteCap = runHitUploadByteCap;\nexports.runHitSomethingNew = () => false;" });
  await assertCaughtBy("a new predicate", "every-predicate-has-a-pinned-row", () => checkMatrix(broken, LINES));
});

test("CL6 catches a variant: a whole-line predicate starts reading substrings", async () => {
  const broken = variant({
    find: "return run.warnings.includes(active_probe_subject_warnings_1.CONSENT_RELOAD_SUBJECT_WARNING);\n}\nfunction runRequestEvidenceCapped",
    replace: "return run.warnings.some((warning) => warning.includes(active_probe_subject_warnings_1.CONSENT_RELOAD_SUBJECT_WARNING));\n}\nfunction runRequestEvidenceCapped"
  });
  await assertCaughtBy("a whole-line predicate reads substrings", "a-label-keeps-a-substring-reading-and-hides-a-whole-line", () => checkLabelledLines(broken, LINES));
});
