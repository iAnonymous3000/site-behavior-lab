import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildEvidenceHash,
  domainRequestDeltas,
  findingEvidenceLink,
  parseEvidenceHash,
  requestTimingSummary
} from "./report-evidence-navigation";
import type { DomainSummary, NetworkRequestRecord, TrackerMatch } from "./types";

const tracker: TrackerMatch = {
  domain: "analytics.example",
  entity: "Example Analytics",
  category: "analytics",
  confidence: "curated"
};

function domain(
  name: string,
  requests: number,
  options: { thirdParty?: boolean; tracker?: TrackerMatch | null } = {}
): DomainSummary {
  return {
    domain: name,
    requests,
    thirdParty: options.thirdParty ?? true,
    tracker: options.tracker ?? null,
    statuses: [200],
    resourceTypes: ["script"]
  };
}

function request(id: number, startedAtMs: number): NetworkRequestRecord {
  return {
    id,
    url: `https://cdn.example/${id}.js`,
    domain: "cdn.example",
    method: "GET",
    resourceType: "script",
    status: 200,
    thirdParty: true,
    tracker: null,
    startedAtMs
  };
}

test("evidence fragments round-trip arm and request filters without reloading the report route", () => {
  const hash = buildEvidenceHash({
    section: "requests",
    arm: "variant",
    query: "cdn.example/a?b",
    signal: "provenance"
  });

  assert.equal(hash, "#evidence=requests&arm=variant&query=cdn.example%2Fa%3Fb&signal=provenance");
  assert.deepEqual(parseEvidenceHash(hash), {
    section: "requests",
    arm: "variant",
    query: "cdn.example/a?b",
    signal: "provenance"
  });
  assert.deepEqual(parseEvidenceHash("#evidence=domains&arm=baseline&query=metrics.example&signal=provenance"), {
    section: "domains",
    arm: "baseline",
    query: "metrics.example"
  });
  assert.deepEqual(parseEvidenceHash("#evidence=requests&signal=unknown"), { section: "requests" });
  assert.equal(parseEvidenceHash("#evidence=sidebar"), null);
});

test("fragment-controlled search text is bounded", () => {
  const parsed = parseEvidenceHash(`#evidence=requests&query=${"x".repeat(700)}`);
  assert.equal(parsed?.query?.length, 500);
});

test("per-domain request deltas include shared and one-arm domains and rank by absolute contribution", () => {
  const changes = domainRequestDeltas(
    [
      domain("largest.example", 10, { tracker }),
      domain("growing.example", 2),
      domain("baseline-only.example", 4),
      domain("unchanged.example", 5)
    ],
    [
      domain("largest.example", 3),
      domain("growing.example", 7),
      domain("variant-only.example", 4),
      domain("unchanged.example", 5)
    ]
  );

  assert.deepEqual(
    changes.map((change) => [change.domain, change.baselineRequests, change.variantRequests, change.delta]),
    [
      ["largest.example", 10, 3, -7],
      ["growing.example", 2, 7, 5],
      ["baseline-only.example", 4, 0, -4],
      ["variant-only.example", 0, 4, 4]
    ]
  );
  assert.equal(changes[0].tracker?.entity, "Example Analytics", "baseline metadata survives when a domain disappears");
});

test("findings link only to evidence tables that contain their supporting rows", () => {
  assert.deepEqual(findingEvidenceLink("shields-comparison", "variant"), {
    label: "Show matched requests",
    target: { section: "requests", signal: "shields-blocked", arm: "variant" }
  });
  assert.deepEqual(findingEvidenceLink("cname-cloaking", "baseline"), {
    label: "Open domain evidence",
    target: { section: "domains", arm: "baseline" }
  });
  assert.equal(findingEvidenceLink("privacy-policy", "baseline"), null);
});

test("the request timeline has a concise text equivalent", () => {
  assert.equal(requestTimingSummary([]), null);
  assert.equal(
    requestTimingSummary([request(1, 1250), request(2, 75), request(3, 900)]),
    "3 requests were recorded from 75 ms to 1,250 ms."
  );
  assert.equal(requestTimingSummary([request(1, 12)]), "1 request was recorded from 12 ms to 12 ms.");
});

test("report components wire neutral comparisons, deep-link filters, and a non-duplicated timeline equivalent", () => {
  const root = process.cwd();
  const comparison = readFileSync(path.join(root, "app", "_components", "comparison-panel.tsx"), "utf8");
  const overview = readFileSync(path.join(root, "app", "_components", "report-overview.tsx"), "utf8");
  const tables = readFileSync(path.join(root, "app", "_components", "report-tables.tsx"), "utf8");
  const renderer = readFileSync(path.join(root, "app", "_components", "report-renderer.tsx"), "utf8");

  assert.match(comparison, /Every signed change is \{labels\.variant\} minus \{labels\.baseline\}/);
  assert.doesNotMatch(comparison, /delta-\$\{direction\}/);
  assert.doesNotMatch(comparison, /change-\$\{tone\}/);
  assert.match(comparison, /<DomainRequestDeltaList changes=\{perDomainDeltas\} labels=\{labels\} \/>/);

  const timeline = overview.slice(overview.indexOf("function RequestTimeline"));
  assert.match(timeline, /aria-hidden="true"/);
  assert.match(timeline, /focusable="false"/);
  assert.doesNotMatch(timeline, /role="img"/);
  assert.match(timeline, /Open the request log for exact timing and request details/);

  assert.match(tables, /id="domain-evidence"/);
  assert.match(tables, /id="request-evidence"/);
  assert.match(tables, /setSignalFilter\(evidenceTarget\.signal \?\? "all"\)/);
  assert.match(tables, /detailsRef\.current\.open = true/);

  assert.match(renderer, /selectLinkedEvidenceArm\(window\.location\.hash\)/);
  assert.match(renderer, /setSelectedArm\(target\.arm\)/);
  assert.match(renderer, /document\.addEventListener\("click", selectRepeatedLinkedEvidenceArm\)/);
  assert.match(renderer, /aria-label="Supporting report evidence"/);
});
