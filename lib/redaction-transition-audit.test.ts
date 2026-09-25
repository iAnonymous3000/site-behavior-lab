import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeDomains } from "./domain-summaries";
import { redactScanResultV1 } from "./redact-scan-report-v1";
import {
  REDACTION_TRANSITION_AUDIT_VERSION,
  redactionTransitionAudit
} from "./redaction-transition-audit";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { NetworkRequestRecord, ScanResult } from "./types";

test("transition audit accounts title, explicit-port, and IP-literal field changes separately", () => {
  const before = {
    summary: { pageTitle: "Alice private account" },
    subject: { origin: "https://shop.example.com:8443" },
    request: {
      url: "http://192.168.1.4:8080/private",
      domain: "192.168.1.4",
      host: "cdn.example.com:9443"
    }
  };
  const after = {
    summary: { pageTitle: "" },
    subject: { origin: "https://shop.example.com" },
    request: { url: "{invalid-url}", domain: "{invalid-host}", host: "cdn.example.com" }
  };
  assert.deepEqual(redactionTransitionAudit(before, after), {
    version: REDACTION_TRANSITION_AUDIT_VERSION,
    pageTitlesWithheld: 1,
    explicitPortFieldsRemoved: 3,
    ipLiteralFieldsRejected: 2,
    privateSuffixTenantLabelsGeneralized: 0,
    policyQuoteIdentifierSpansScrubbed: 0,
    policyClaimsMadeUncheckable: 0
  });
});

test("fixed points and canonical default ports do not inflate transition accounting", () => {
  const fixed = { summary: { pageTitle: "" }, url: "https://example.com/path" };
  assert.deepEqual(redactionTransitionAudit(fixed, fixed), {
    version: REDACTION_TRANSITION_AUDIT_VERSION,
    pageTitlesWithheld: 0,
    explicitPortFieldsRemoved: 0,
    ipLiteralFieldsRejected: 0,
    privateSuffixTenantLabelsGeneralized: 0,
    policyQuoteIdentifierSpansScrubbed: 0,
    policyClaimsMadeUncheckable: 0
  });
  assert.equal(
    redactionTransitionAudit({ url: "https://example.com:443/path" }, { url: "https://example.com/path" })
      .explicitPortFieldsRemoved,
    0
  );
});

test("transition audit covers provenance domains, hostname arrays, and leading-dot IP markers", () => {
  const before = {
    provenance: {
      initiatorDomain: "192.168.1.2",
      scriptDomain: "[fd00::1]",
      injectedByDomain: ".10.0.0.2"
    },
    evidence: {
      thirdPartyOrigins: ["http://[::1]:8080/private"],
      recipients: [".127.0.0.1"]
    }
  };
  const after = {
    provenance: {
      initiatorDomain: "{invalid-host}",
      scriptDomain: "{invalid-host}",
      injectedByDomain: ".{invalid-host}"
    },
    evidence: {
      thirdPartyOrigins: ["{invalid-url}"],
      recipients: [".{invalid-host}"]
    }
  };
  assert.deepEqual(redactionTransitionAudit(before, after), {
    version: REDACTION_TRANSITION_AUDIT_VERSION,
    pageTitlesWithheld: 0,
    explicitPortFieldsRemoved: 1,
    ipLiteralFieldsRejected: 5,
    privateSuffixTenantLabelsGeneralized: 0,
    policyQuoteIdentifierSpansScrubbed: 0,
    policyClaimsMadeUncheckable: 0
  });
});

test("rebuilt domain rows are accounted individually, not by array position", () => {
  // v1 redaction regroups `domains` from the sanitized requests, so three
  // IP-literal rows collapse into one {invalid-host} row and the survivors
  // re-sort. Only one row keeps its index; the rest must still be counted.
  const request = (
    id: number,
    url: string,
    domain: string,
    thirdParty: boolean
  ): NetworkRequestRecord => ({
    id,
    url,
    domain,
    method: "GET",
    resourceType: "script",
    status: 200,
    thirdParty,
    tracker: null,
    startedAtMs: id
  });
  const before = makeScanReportV1() as ScanResult;
  before.summary.pageTitle = "Alice private dashboard";
  before.requests = [
    request(1, "https://example.com/one", "example.com", false),
    request(2, "https://example.com/two", "example.com", false),
    request(3, "https://example.com/three", "example.com", false),
    request(4, "http://192.168.1.4:8080/one", "192.168.1.4", true),
    request(5, "http://192.168.1.4:8080/two", "192.168.1.4", true),
    request(6, "http://10.0.0.7:9443/three", "10.0.0.7", true),
    request(7, "http://172.16.3.9/four", "172.16.3.9", true)
  ];
  before.domains = summarizeDomains(before.requests);
  const after = redactScanResultV1(before).report;

  assert.deepEqual(
    before.domains.map((row) => row.domain),
    ["192.168.1.4", "10.0.0.7", "172.16.3.9", "example.com"]
  );
  assert.deepEqual(
    after.domains.map((row) => row.domain),
    ["{invalid-host}", "example.com"]
  );
  assert.deepEqual(redactionTransitionAudit(before, after), {
    version: REDACTION_TRANSITION_AUDIT_VERSION,
    pageTitlesWithheld: 1,
    explicitPortFieldsRemoved: 3,
    // requests[].url on 4 IP-literal rows, requests[].domain on the same 4,
    // and all 3 rebuilt domains[].domain rows.
    ipLiteralFieldsRejected: 11,
    privateSuffixTenantLabelsGeneralized: 0,
    policyQuoteIdentifierSpansScrubbed: 0,
    policyClaimsMadeUncheckable: 0
  });
});

test("transition audit names generalized private-suffix tenants and scrubbed policy quotes", () => {
  const address = "192-0-2-41_s-198-51-100-43_ts-1767225600-clienttons-s.akamaihd.net";
  const token = "qwert2yuiop3asdfg4hj-zxc5v6-79b48c136-clientnsv4-s.akamaihd.net";
  const stable = "trial-eum-clienttons-s.akamaihd.net";
  const checkable =
    "We do not sell or share your personal information, email privacy@acme.com; we reply within 30 days.";
  const before = {
    request: {
      url: `https://${address}/beacon`,
      domain: address,
      tracker: { domain: address, entity: address, confidence: "shields-list" }
    },
    stableRequest: { domain: stable, tracker: { domain: stable, entity: stable } },
    privacyPolicy: {
      unmentionedEntities: [token],
      claims: [
        { kind: "no-selling-or-sharing", quote: checkable },
        { kind: "honors-gpc", quote: "We honor GPC; call 415.555.0100." },
        { kind: "no-cookies", quote: "We do not use cookies." }
      ]
    }
  };
  const after = {
    request: {
      url: "https://{label}.akamaihd.net/{seg}",
      domain: "{label}.akamaihd.net",
      tracker: { domain: "{label}.akamaihd.net", entity: "{label}.akamaihd.net", confidence: "shields-list" }
    },
    stableRequest: { domain: stable, tracker: { domain: stable, entity: stable } },
    privacyPolicy: {
      unmentionedEntities: ["{label}.akamaihd.net"],
      claims: [
        {
          kind: "no-selling-or-sharing",
          quote: "We do not sell or share your personal information, email [redacted]; we reply within 30 days..."
        },
        { kind: "honors-gpc", quote: "We honor GPC; call [redacted]..." },
        { kind: "no-cookies", quote: "We do not use cookies." }
      ]
    }
  };
  assert.deepEqual(redactionTransitionAudit(before, after), {
    version: REDACTION_TRANSITION_AUDIT_VERSION,
    pageTitlesWithheld: 0,
    explicitPortFieldsRemoved: 0,
    ipLiteralFieldsRejected: 0,
    // url, domain, tracker domain, tracker entity, and the policy entity.
    privateSuffixTenantLabelsGeneralized: 5,
    policyQuoteIdentifierSpansScrubbed: 2,
    // Only the sell-or-share claim was checkable; GPC claims never are.
    policyClaimsMadeUncheckable: 1
  });
  assert.deepEqual(redactionTransitionAudit(after, after), {
    version: REDACTION_TRANSITION_AUDIT_VERSION,
    pageTitlesWithheld: 0,
    explicitPortFieldsRemoved: 0,
    ipLiteralFieldsRejected: 0,
    privateSuffixTenantLabelsGeneralized: 0,
    policyQuoteIdentifierSpansScrubbed: 0,
    policyClaimsMadeUncheckable: 0
  });
});
