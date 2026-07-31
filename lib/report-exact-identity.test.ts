import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { directoryReportPresentationForView } from "./corpus-overview";
import { summarizeDomains } from "./domain-summaries";
import {
  buildReportFacts,
  identifiedHostCatalogMatchLabel
} from "./report-facts";
import { buildFindings } from "./report-findings";
import { buildReportHeadline } from "./report-headline";
import { readStoredScanReport } from "./scan-report-reader";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { viewFromV1Report, type ReportView } from "./scan-report-views";
import type {
  NetworkRequestRecord,
  ScanResult,
  TrackerMatch
} from "./types";

const SENTRY: TrackerMatch = {
  domain: "sentry.io",
  entity: "Sentry",
  category: "error monitoring",
  confidence: "curated"
};

const META: TrackerMatch = {
  domain: "facebook.net",
  entity: "Meta",
  category: "social / advertising pixel",
  confidence: "curated"
};

const VWO: TrackerMatch = {
  domain: "visualwebsiteoptimizer.com",
  entity: "VWO",
  category: "experimentation / behavior analytics",
  confidence: "curated"
};

test("reader-valid Sentry plus Meta shared-host rows reach facts, findings, headline, and directory", () => {
  const view = readerValidSharedHostView([SENTRY, META], true);
  const facts = buildReportFacts(view);
  const identity = facts.display.identity;

  assert.deepEqual(identity.catalogEntities, [
    {
      entity: "Meta",
      requests: 1,
      domains: 1,
      categories: ["social / advertising pixel"]
    },
    {
      entity: "Sentry",
      requests: 1,
      domains: 1,
      categories: ["error monitoring"]
    }
  ]);
  assert.deepEqual(
    identity.trackingEntities.map((entity) => entity.entity),
    ["Meta"]
  );
  assert.deepEqual(
    identity.operationalEntities.map((entity) => entity.entity),
    ["Sentry"]
  );
  assert.deepEqual(identity.unclassifiedEntities, []);
  assert.deepEqual(
    identity.ownership.otherOrUnreviewed.map((entity) => entity.entity),
    ["Meta", "Sentry"]
  );
  assert.deepEqual(
    identity.hosts[0]?.namers.filter((namer) => namer.source === "catalog"),
    [
      { source: "catalog", name: "Meta" },
      { source: "catalog", name: "Sentry" }
    ]
  );
  assert.equal(
    identifiedHostCatalogMatchLabel(identity.hosts[0]),
    "Meta: social / advertising pixel; Sentry: error monitoring (multiple exact matches; see request rows)"
  );

  // CNAME identity stays separate from direct request-row classification: it
  // remains named, but does not inflate the two direct catalog entities.
  assert.deepEqual(identity.cnameNames, ["Eulerian"]);
  assert.deepEqual(identity.allNames, ["Eulerian", "Meta", "Sentry"]);
  assert.equal(identity.coverage.thirdPartyHosts, 1);

  const findings = buildFindings(view, null, facts);
  const services = findings.find(
    (finding) => finding.id === "third-party-services"
  );
  assert.ok(services);
  assert.match(services.lead, /Meta/);
  assert.match(services.detail, /Sentry/);
  assert.doesNotMatch(services.lead, /Sentry appeared/);

  const headline = buildReportHeadline(view, facts);
  assert.match(headline.headline, /catalogued Meta domains/);
  assert.match(
    headline.subhead,
    /1 distinct catalogued tracking-service entity/
  );

  const directory = directoryReportPresentationForView(view);
  assert.equal(directory.headline, headline.headline);
  assert.equal(directory.cataloguedServiceRequests, 2);
  assert.equal(directory.trackerRequests, 1);
});

test("reader-valid Meta plus VWO shared-host rows never inherit the summary's Meta identity", () => {
  const view = readerValidSharedHostView([META, VWO]);
  const facts = buildReportFacts(view);
  const identity = facts.display.identity;

  // summarizeDomains necessarily retains the first exact match in its one-slot
  // compatibility field. Facts must still keep both entities at one row each.
  assert.equal(view.runs[0].evidence.domains[0]?.tracker?.entity, "Meta");
  assert.equal(view.runs[0].evidence.domains[0]?.requests, 2);
  assert.deepEqual(
    identity.catalogEntities.map((entity) => [
      entity.entity,
      entity.requests,
      entity.categories
    ]),
    [
      ["Meta", 1, ["social / advertising pixel"]],
      ["VWO", 1, ["experimentation / behavior analytics"]]
    ]
  );
  assert.deepEqual(
    identity.trackingEntities.map((entity) => entity.entity),
    ["Meta", "VWO"]
  );
  assert.deepEqual(identity.operationalEntities, []);
  assert.deepEqual(identity.unclassifiedEntities, []);

  const findings = buildFindings(view, null, facts);
  const services = findings.find(
    (finding) => finding.id === "third-party-services"
  );
  assert.ok(services);
  assert.match(services.lead, /Meta and VWO/);

  const headline = buildReportHeadline(view, facts);
  assert.match(headline.headline, /catalogued Meta domains/);
  assert.match(headline.subhead, /2 distinct catalogued tracking-service entities/);

  const directory = directoryReportPresentationForView(view);
  assert.equal(directory.headline, headline.headline);
  assert.equal(directory.cataloguedServiceRequests, 2);
  assert.equal(directory.trackerRequests, 2);
});

test("a party named only by a host summary still joins the identity union, dispatched-only", () => {
  // The stored reader's reconciliation rule forbids a domain summary that
  // names an entity no retained row carries, so this shape never comes from
  // readStoredScanReport. Presentation code still renders locally constructed
  // views (the consistency gate exists precisely for them), and on such a
  // view the summary's entity must reach catalogEntities, the host namers,
  // and allNames; but the summary's host-level statuses must NOT prove that
  // this entity responded, because a shared host aggregates statuses across
  // rows of other entities.
  const report = structuredClone(makeScanReportV1()) as ScanResult;
  report.summary.firstPartyDomain = "news.example";
  report.conditions.requestedUrl = "https://news.example/";
  report.conditions.finalUrl = "https://news.example/";
  report.requests = [
    {
      id: 1,
      url: "https://news.example/app.js",
      domain: "news.example",
      method: "GET",
      resourceType: "script",
      status: 200,
      thirdParty: false,
      tracker: null,
      startedAtMs: 1
    }
  ];
  report.domains = [
    {
      domain: "metrics.vendor.example",
      requests: 3,
      thirdParty: true,
      tracker: SENTRY,
      statuses: [200],
      resourceTypes: ["script"]
    }
  ];
  report.summary.totalRequests = 4;
  report.summary.thirdPartyRequests = 3;
  report.summary.knownTrackerRequests = 3;
  report.summary.thirdPartyDomains = 1;

  const view = viewFromV1Report(report);

  const facts = buildReportFacts(view);
  const identity = facts.display.identity;
  assert.deepEqual(identity.catalogEntities, [
    { entity: "Sentry", requests: 3, domains: 1, categories: ["error monitoring"] }
  ]);
  assert.deepEqual(identity.hosts[0]?.namers, [{ source: "catalog", name: "Sentry" }]);
  assert.deepEqual(identity.hosts[0]?.tracker, {
    entity: "Sentry",
    requests: 3,
    domains: 1,
    categories: ["error monitoring"]
  });
  assert.ok(identity.allNames.includes("Sentry"));
  assert.equal(identity.respondedEntities.has("Sentry"), false);

  const services = buildFindings(view, null, facts).find(
    (finding) => finding.id === "third-party-services"
  );
  assert.ok(services);
  assert.match(services.lead, /Sentry/);
  assert.notEqual(
    services.title,
    "Catalogued service domains recorded responses during this visit"
  );
});

test("domain and top-party summaries consume the exact per-host catalog seam", () => {
  const source = readFileSync(
    path.join(
      process.cwd(),
      "app",
      "_components",
      "report-tables.tsx"
    ),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /domain\.tracker/,
    "host summaries must not render the lossy one-match domain slot"
  );
  assert.ok(
    source.match(/identifiedHostCatalogMatchLabel/g)?.length === 3,
    "both domain-table and top-party render paths must use the exact host label helper"
  );
});

function readerValidSharedHostView(
  trackers: readonly TrackerMatch[],
  withCname = false
): ReportView {
  const report = structuredClone(makeScanReportV1()) as ScanResult;
  report.summary.firstPartyDomain = "news.example";
  report.conditions.requestedUrl = "https://news.example/";
  report.conditions.finalUrl = "https://news.example/";
  report.requests = trackers.map(
    (tracker, index): NetworkRequestRecord => ({
      id: index + 1,
      url: `https://shared.vendor.example/request-${index + 1}`,
      domain: "shared.vendor.example",
      method: "GET",
      resourceType: "script",
      status: 204,
      thirdParty: true,
      tracker,
      startedAtMs: index + 1
    })
  );
  report.domains = summarizeDomains(report.requests);
  report.summary.totalRequests = report.requests.length;
  report.summary.thirdPartyRequests = report.requests.length;
  report.summary.knownTrackerRequests = report.requests.length;
  report.summary.thirdPartyDomains = 1;
  if (withCname) {
    report.cnameCloaks = [
      {
        host: "metrics.news.example",
        cname: "shop.eulerian.net",
        tracker: {
          domain: "eulerian.net",
          entity: "Eulerian",
          category: "advertising",
          confidence: "curated"
        }
      }
    ];
  }

  const read = readStoredScanReport(report);
  assert.equal(
    read.ok,
    true,
    read.ok ? undefined : `reader rejected fixture: ${read.error}`
  );
  if (!read.ok || read.stored.schemaVersion !== 1) {
    assert.fail("expected a reader-valid v1 report");
  }
  return viewFromV1Report(read.stored.report);
}
