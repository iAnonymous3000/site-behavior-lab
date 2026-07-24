/**
 * Semantic-layer regressions for the frozen v1 read path. The evaluator has to
 * keep rejecting forged conclusions (a hand-edited summary must never publish
 * fabricated counts as ranked findings) without ruling an honestly redacted or
 * older-generation report "inconsistent", which blocks both rendering and
 * persistence.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeDomains } from "./domain-summaries";
import { INVALID_HOST_MARKER, INVALID_URL_MARKER } from "./redaction-v2";
import { scanReportV1SemanticViolations } from "./scan-report-v1-evaluators";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanReport } from "./types";

type AnyRecord = Record<string, any>;

/** A single run with one third-party request and a reconciling summary. */
function makeRun(apply: (draft: AnyRecord) => void = () => {}): ScanReport {
  const draft = makeScanReportV1() as unknown as AnyRecord;
  draft.requests = [
    {
      id: 1,
      url: "https://tracker.example/pixel",
      domain: "tracker.example",
      method: "GET",
      resourceType: "image",
      status: 200,
      thirdParty: true,
      tracker: null,
      blockedByShields: false,
      startedAtMs: 12
    }
  ];
  draft.domains = summarizeDomains(draft.requests);
  draft.summary.totalRequests = 1;
  draft.summary.thirdPartyRequests = 1;
  draft.summary.thirdPartyDomains = 1;
  apply(draft);
  return draft as unknown as ScanReport;
}

test("the evaluator reads the same redaction sentinels the sanitizer emits", () => {
  // The evaluator spells these locally to keep the sanitizer's allowlist tables
  // off the read path, so pin the two spellings against their source.
  assert.equal(INVALID_URL_MARKER, "{invalid-url}");
  assert.equal(INVALID_HOST_MARKER, "{invalid-host}");
});

test("a redacted first-party identity is unprovable, not inconsistent", () => {
  // Any host that is itself a public suffix (httpbin.org, github.io, pages.dev)
  // has no registrable domain, so an ordinary 200 scan of one lands on the
  // sentinels; the raw-URL and raw-host caps fire independently of each other,
  // so either side can be a sentinel on its own.
  const redactions: Array<[string, (draft: AnyRecord) => void]> = [
    ["no registrable domain on either side", (draft) => {
      draft.conditions.finalUrl = INVALID_URL_MARKER;
      draft.summary.firstPartyDomain = INVALID_HOST_MARKER;
    }],
    ["raw URL over the sanitizer cap", (draft) => (draft.conditions.finalUrl = INVALID_URL_MARKER)],
    ["raw host over the sanitizer cap", (draft) => (draft.summary.firstPartyDomain = INVALID_HOST_MARKER)]
  ];
  for (const [label, apply] of redactions) {
    assert.deepEqual(scanReportV1SemanticViolations(makeRun(apply)), [], label);
  }

  // A generalized subdomain is not a sentinel: both sides carry the same
  // marker label, so the identity is still provable and still asserted.
  assert.deepEqual(
    scanReportV1SemanticViolations(
      makeRun((draft) => {
        draft.conditions.finalUrl = "https://{label}.example.com/";
        draft.summary.firstPartyDomain = "{label}.example.com";
      })
    ),
    []
  );
  assert.deepEqual(
    scanReportV1SemanticViolations(
      makeRun((draft) => {
        draft.conditions.finalUrl = "https://{label}.example.com/";
        draft.summary.firstPartyDomain = "{label}.other.example";
      })
    ),
    ["run: summary.firstPartyDomain does not match conditions.finalUrl"]
  );
});

test("an unredacted first-party identity is still bound to the recorded URL", () => {
  const mismatches: Array<[string, (draft: AnyRecord) => void]> = [
    ["another site's URL", (draft) => (draft.conditions.finalUrl = "https://other.example/path")],
    ["another site's declared host", (draft) => (draft.summary.firstPartyDomain = "other.example")],
    ["a non-HTTP final URL", (draft) => (draft.conditions.finalUrl = "ftp://example.com/")],
    ["an unparseable final URL", (draft) => (draft.conditions.finalUrl = "not a url")]
  ];
  for (const [label, apply] of mismatches) {
    assert.deepEqual(
      scanReportV1SemanticViolations(makeRun(apply)),
      ["run: summary.firstPartyDomain does not match conditions.finalUrl"],
      label
    );
  }
});

test("the optional Shields flag may be absent from a v1 domain row", () => {
  // blockedByShields is optional in the frozen type and missing from
  // older-generation exports, while the derivation always materializes it.
  assert.deepEqual(
    scanReportV1SemanticViolations(
      makeRun((draft) => {
        for (const request of draft.requests) delete request.blockedByShields;
        for (const domain of draft.domains) delete domain.blockedByShields;
      })
    ),
    []
  );

  // Present-and-false is the same claim as absent, in either direction.
  assert.deepEqual(
    scanReportV1SemanticViolations(makeRun((draft) => delete draft.domains[0].blockedByShields)),
    []
  );

  // A row that claims a block the request evidence does not support still fails.
  assert.deepEqual(
    scanReportV1SemanticViolations(makeRun((draft) => (draft.domains[0].blockedByShields = true))),
    ["run: domains do not reconcile with the request evidence"]
  );
});

test("fabricated summary counts are still reported as forged conclusions", () => {
  const forgeries: Array<[string, (draft: AnyRecord) => void]> = [
    ["thirdPartyRequests", (draft) => (draft.summary.thirdPartyRequests += 7)],
    ["thirdPartyDomains", (draft) => (draft.summary.thirdPartyDomains += 3)],
    ["thirdPartyCookies", (draft) => (draft.summary.thirdPartyCookies += 2)],
    ["knownTrackerRequests", (draft) => (draft.summary.knownTrackerRequests += 5)],
    ["totalRequests", (draft) => (draft.summary.totalRequests += 100)],
    ["storageEntries", (draft) => (draft.summary.storageEntries += 1)],
    ["fingerprintEvents", (draft) => (draft.summary.fingerprintEvents += 9)]
  ];
  for (const [field, apply] of forgeries) {
    assert.deepEqual(
      scanReportV1SemanticViolations(makeRun(apply)),
      [`run: summary.${field} does not reconcile with the evidence`],
      field
    );
  }

  // Redaction tolerance does not buy a forger anything: a sentinel identity
  // still carries the count reconciliation.
  assert.deepEqual(
    scanReportV1SemanticViolations(
      makeRun((draft) => {
        draft.conditions.finalUrl = INVALID_URL_MARKER;
        draft.summary.firstPartyDomain = INVALID_HOST_MARKER;
        draft.summary.thirdPartyRequests += 7;
      })
    ),
    ["run: summary.thirdPartyRequests does not reconcile with the evidence"]
  );
});

test("the domain table is still reconstructed from the request evidence", () => {
  const forgeries: Array<[string, (draft: AnyRecord) => void]> = [
    ["inflated request count", (draft) => (draft.domains[0].requests += 4)],
    ["smuggled status", (draft) => draft.domains[0].statuses.push(418)],
    ["smuggled resource type", (draft) => draft.domains[0].resourceTypes.push("script")],
    ["flipped party flag", (draft) => (draft.domains[0].thirdParty = false)],
    ["invented row", (draft) => draft.domains.push({ ...draft.domains[0], domain: "invented.example" })]
  ];
  for (const [label, apply] of forgeries) {
    assert.equal(
      scanReportV1SemanticViolations(makeRun(apply)).includes("run: domains do not reconcile with the request evidence"),
      true,
      label
    );
  }

  // Producer ordering inside the sets is not evidence and must not fail.
  assert.deepEqual(
    scanReportV1SemanticViolations(
      makeRun((draft) => {
        draft.requests.push({ ...draft.requests[0], id: 2, status: 204, resourceType: "xhr", startedAtMs: 13 });
        draft.domains = [
          { ...summarizeDomains(draft.requests)[0], statuses: [204, 200], resourceTypes: ["xhr", "image"] }
        ];
        draft.summary.totalRequests = 2;
        draft.summary.thirdPartyRequests = 2;
      })
    ),
    []
  );
});
