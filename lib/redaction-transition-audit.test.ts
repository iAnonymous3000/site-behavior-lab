import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REDACTION_TRANSITION_AUDIT_VERSION,
  redactionTransitionAudit
} from "./redaction-transition-audit";

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
    ipLiteralFieldsRejected: 2
  });
});

test("fixed points and canonical default ports do not inflate transition accounting", () => {
  const fixed = { summary: { pageTitle: "" }, url: "https://example.com/path" };
  assert.deepEqual(redactionTransitionAudit(fixed, fixed), {
    version: REDACTION_TRANSITION_AUDIT_VERSION,
    pageTitlesWithheld: 0,
    explicitPortFieldsRemoved: 0,
    ipLiteralFieldsRejected: 0
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
    ipLiteralFieldsRejected: 5
  });
});
