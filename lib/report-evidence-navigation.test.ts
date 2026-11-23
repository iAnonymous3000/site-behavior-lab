import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { summarizeDomains } from "./domain-summaries";
import {
  buildEvidenceHash,
  domainRequestDeltas,
  evidenceTargetForPrintedVisit,
  findingEvidenceLink,
  parseEvidenceHash,
  printedFilterLine,
  printedRequestRef,
  printedVisitArm,
  requestTimingSummary,
  retainedRowPositions,
  type EvidenceTarget
} from "./report-evidence-navigation";
import { pixelEventLabel } from "./report-insights";
import { requestMatchesTextFilter } from "./request-log-filters";
import { requireIndex } from "./source-markers";
import { displayHost } from "./text-format";
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
  assert.deepEqual(findingEvidenceLink("named-platforms", "variant"), {
    label: "Show catalog-matched requests",
    target: { section: "requests", signal: "known-service", arm: "variant" }
  });
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
  // Each exact-delta gate is its own blocker list, and the note prints that
  // list: no fixed sentence can stand in for the cause that closed the gate.
  assert.match(comparison, /const fingerprintBlockers = comparisonExactClaimDeltaBlockers\(view, facts, "fingerprint-apis", labels\)/);
  assert.match(comparison, /const pixelBlockers = comparisonExactClaimDeltaBlockers\(view, facts, "pixel-events", labels\)/);
  assert.match(comparison, /const fingerprintDeltaAllowed = fingerprintBlockers\.length === 0;/);
  assert.match(comparison, /const pixelDeltaAllowed = pixelBlockers\.length === 0;/);
  assert.match(comparison, /label: "Fingerprinting deltas",\s*mode: "raw-only",\s*reasons: fingerprintBlockers\b/);
  assert.match(comparison, /label: "Ad-pixel deltas",\s*mode: "raw-only",\s*reasons: pixelBlockers\b/);
  assert.doesNotMatch(comparison, /At least one visit did not complete the (fingerprint|pixel) measurement/);
  // Both pixel lists name events through the one label that marks a
  // withdrawn one, and the change lists are told whether a correction applies.
  assert.equal(pixelEventLabel("X", "Purchase", true), "Purchase (unsupported historical label; see correction)");
  assert.equal(pixelEventLabel("X", "Purchase", false), "Purchase");
  assert.equal(pixelEventLabel("Meta", "Purchase", true), "Purchase");
  assert.match(comparison, /const corrected = publishedReportCorrections\(view\.reportId\)\.suppressIndexing;/);
  assert.equal(comparison.match(/<PixelEventChangeList\b[^>]*\bcorrected=\{corrected\} \/>/g)?.length, 2);
  assert.equal(comparison.match(/<PixelEventChangeList\b/g)?.length, 2);
  assert.match(comparison, /change\.events\.map\(\(event\) => pixelEventLabel\(change\.platform, event, corrected\)\)/);
  assert.doesNotMatch(comparison, /change\.events\.join/);
  assert.match(tables, /pixel\.events\.map\(\(event\) => pixelEventLabel\(pixel\.platform, event, corrected\)\)/);
  // Both domain lists print the catalog label with its scope note, so a
  // label that covers part of a host's requests is never shown bare.
  assert.equal(comparison.match(/`\$\{change\.tracker\.entity\} · \$\{change\.tracker\.category\}\$\{(?:change\.)?matchScope \? ` · \$\{(?:change\.)?matchScope\}` : ""\}`/g)?.length, 2);
  assert.equal(comparison.match(/\$\{change\.tracker\.entity\}/g)?.length, 2, "no domain list prints a bare catalog label");
  assert.equal(comparison.match(/hostCatalogMatchScope\(/g)?.length, 2);
  // Storage tiles and lists read their own gate, never raw-counts alone.
  assert.match(comparison, /const storageDeltaAllowed = comparisonSupportsStorageDelta\(view, facts\)/);
  assert.match(comparison, /storageDeltaAllowed \? \[\{ label: "Storage keys", metric: diff\.storageEntries \}\]/);
  assert.equal(comparison.match(/label: "Storage keys"/g)?.length, 1, "no second, ungated storage tile");
  assert.match(comparison, /\{storageDeltaAllowed && \(\s*<>\s*<StorageChangeList/);
  assert.equal(comparison.match(/<StorageChangeList\b/g)?.length, 2);
  assert.match(comparison, /Catalog-matched request and entity deltas/);
  assert.doesNotMatch(comparison, /Known-service and entity deltas/);
  assert.match(renderer, /<ComparisonPanel view=\{reportView\} facts=\{reportFacts\} \/>/);

  const timeline = overview.slice(overview.indexOf("function RequestTimeline"));
  assert.match(timeline, /aria-hidden="true"/);
  assert.match(timeline, /focusable="false"/);
  assert.doesNotMatch(timeline, /role="img"/);
  assert.match(timeline, /Open the request log for exact timing and request details/);

  assert.match(tables, /id=\{evidenceId\("domain-evidence"\)\}/);
  assert.match(tables, /id=\{evidenceId\("request-evidence"\)\}/);
  assert.match(tables, /setSignalFilter\(evidenceTarget\.signal \?\? "all"\)/);
  assert.match(tables, /detailsRef\.current\.open = true/);

  // The address bar is read once, when the report mounts. After that each
  // navigation names its own target; see the listener test below.
  assert.match(renderer, /selectLinkedEvidenceArm\(window\.location\.hash\);/);
  assert.match(tables, /readTarget\(window\.location\.hash\);/);
  assert.match(renderer, /setSelectedArm\(target\.arm\)/);
  assert.match(renderer, /document\.addEventListener\("click", selectRepeatedLinkedEvidenceArm\)/);
  assert.match(renderer, /aria-label="Supporting report evidence"/);
});

/**
 * Every evidence reader's hashchange listener, by the definition its
 * registration names. On the home page ScheduledRescans can run first and,
 * inside the same dispatch, write a retained `#watch=` management link back
 * into the address, so a listener that read location.hash saw the capability
 * and dropped the evidence link: the log stayed closed and the arm unswitched.
 * A source contract cannot see listener order; scripts/smoke-static-site.mjs
 * follows the links in a browser with a retained capability.
 */
test("evidence readers take each navigation's target from its hashchange event", () => {
  const root = process.cwd();
  for (const file of ["report-tables.tsx", "report-renderer.tsx"]) {
    const label = `app/_components/${file}`;
    const source = readFileSync(path.join(root, "app", "_components", file), "utf8");
    const listeners = [...source.matchAll(/window\.addEventListener\("hashchange", (\w+)\)/g)].map((match) => match[1]);
    assert.equal(listeners.length, 1, `${label} registers one hashchange listener`);
    const start = requireIndex(source, `const ${listeners[0]} = (event: HashChangeEvent) =>`, label);
    const definition = source.slice(start, requireIndex(source, ";\n", label, start));
    assert.match(definition, /\(new URL\(event\.newURL\)\.hash\)$/, `${label}: ${definition}`);
    assert.doesNotMatch(definition, /location/, `${label} reads the address bar in its hashchange listener`);
    assert.match(source, new RegExp(`window\\.removeEventListener\\("hashchange", ${listeners[0]}\\)`));
  }
});

/**
 * The pair is the drill-down's identity, so its round trip and its refusals are
 * pinned. A half-specified pair degrading into a one-sided filter is the exact
 * over-count this field exists to replace.
 */
test("an attribution pair round-trips, and a half-specified one is refused", () => {
  const target = {
    section: "requests" as const,
    arm: "baseline" as const,
    pair: { actor: "apnews.com", destination: "*.primis.tech" }
  };
  const hash = buildEvidenceHash(target);
  assert.match(hash, /actor=apnews.com/);
  assert.match(hash, /destination=/);
  assert.deepEqual(parseEvidenceHash(hash), target);

  assert.equal(
    parseEvidenceHash("#evidence=requests&actor=apnews.com")?.pair,
    undefined,
    "an actor with no destination must not become a one-sided filter"
  );
  assert.equal(
    parseEvidenceHash("#evidence=requests&destination=*.primis.tech")?.pair,
    undefined,
    "a destination with no actor must not become a one-sided filter"
  );
  assert.equal(
    parseEvidenceHash("#evidence=requests&actor=%20&destination=x")?.pair,
    undefined,
    "whitespace is not an endpoint"
  );

  // The pair is a requests-section concept; the domains board has no edges.
  assert.equal(
    buildEvidenceHash({
      section: "domains",
      pair: { actor: "a.example", destination: "b.example" }
    }).includes("actor="),
    false
  );

  // Fragment-controlled values stay bounded, like query.
  const long = "a".repeat(900);
  const parsed = parseEvidenceHash(
    `#evidence=requests&actor=${long}&destination=${long}`
  );
  assert.equal(parsed?.pair?.actor.length, 500);
  assert.equal(parsed?.pair?.destination.length, 500);
});


test("a printed visit's evidence links and targets name that visit's arm", () => {
  assert.equal(printedVisitArm("baseline"), "baseline");
  assert.equal(printedVisitArm("variant"), "variant");
  assert.equal(printedVisitArm(""), undefined, "on screen no arm is printed");
  const variantOnly = parseEvidenceHash("#evidence=requests&arm=variant&signal=third-party");
  const armless = parseEvidenceHash("#evidence=requests&signal=third-party");
  assert.equal(evidenceTargetForPrintedVisit(variantOnly, "baseline"), null, "the baseline log ignores a variant link");
  assert.deepEqual(evidenceTargetForPrintedVisit(variantOnly, "variant"), variantOnly);
  assert.deepEqual(evidenceTargetForPrintedVisit(armless, "baseline"), armless, "an armless link still applies on paper");
  assert.deepEqual(evidenceTargetForPrintedVisit(variantOnly, ""), variantOnly, "on screen every target applies");
});

test("the request timeline's log link and the request log's target both go through the printed arm", () => {
  const root = process.cwd();
  const overview = readFileSync(path.join(root, "app", "_components", "report-overview.tsx"), "utf8");
  const tables = readFileSync(path.join(root, "app", "_components", "report-tables.tsx"), "utf8");
  const timeline = overview.slice(requireIndex(overview, "function RequestTimeline("), requireIndex(overview, "</a>", "RequestTimeline", requireIndex(overview, "function RequestTimeline(")));
  assert.match(timeline, /const printVisit = usePrintVisit\(\);/);
  assert.match(timeline, /const arm = printedVisitArm\(printVisit\);/);
  assert.match(timeline, /buildEvidenceHash\(\{ section: "requests", \.\.\.\(arm \? \{ arm \} : \{\}\) \}\)/);
  const hook = tables.slice(requireIndex(tables, "function useEvidenceTarget("));
  assert.match(hook.slice(0, hook.indexOf("\nfunction ")), /return evidenceTargetForPrintedVisit\(target, printVisit\);/);
});

function componentSource(name: string): string {
  return readFileSync(path.join(process.cwd(), "app", "_components", `${name}.tsx`), "utf8");
}

function requestLogSource(): string {
  const tables = componentSource("report-tables");
  return tables.slice(requireIndex(tables, "function RequestTable("), requireIndex(tables, "function RequestLogRows("));
}

/** The one line of the request log's source that holds `marker`, so a failure prints that line and not the file. */
function logLine(marker: string): string {
  const lines = requestLogSource().split("\n").filter((line) => line.includes(marker));
  assert.equal(lines.length, 1, `the request log has ${lines.length} lines with ${marker}`);
  return lines[0].trim();
}

/** The host-match line of the request log's source, with the condition it renders on. */
function hostMatchLine(): string {
  return requestLogSource().match(/\{exactHost[^\n{]*&& \(\n\s*<p className="attribution-active-filter">[\s\S]*?<\/p>/)?.[0] ?? "";
}

/** The rows the request log keeps for the text side of a link's target. */
function linkedRows(rows: readonly NetworkRequestRecord[], target: EvidenceTarget | null): NetworkRequestRecord[] {
  const query = target?.query ?? "";
  const exactHost = target?.exactHost ? query : null;
  return rows.filter((row) => requestMatchesTextFilter(row, query, exactHost));
}

function hostRow(id: number, host: string, options: Partial<NetworkRequestRecord> = {}): NetworkRequestRecord {
  return { ...request(id, id), domain: host, url: `https://${host}/${id}.js`, ...options };
}

test("the change list's link asks for the exact host", () => {
  const panel = componentSource("comparison-panel");
  const link = panel.slice(requireIndex(panel, "function EvidenceLink("));
  assert.equal(
    link.match(/href=\{buildEvidenceHash\([^\n]*/)?.[0],
    'href={buildEvidenceHash({ section: "requests", arm, query: domain, exactHost: true })}>',
    "the change list's link does not ask for the exact host"
  );
});

test("an exact-host target round-trips", () => {
  const target = { section: "requests" as const, arm: "baseline" as const, query: "{label}.cdn.example", exactHost: true as const };
  const hash = buildEvidenceHash(target);
  assert.equal(hash, "#evidence=requests&arm=baseline&query=%7Blabel%7D.cdn.example&match=host", "the link does not carry match=host");
  assert.deepEqual(parseEvidenceHash(hash), target, "an exact-host target does not survive its own address");
});

test("a change list's link selects exactly the rows its count counts", () => {
  const short = "{label}.{label}.vendor.example";
  const longer = "{label}.{label}.{label}.vendor.example";
  const visits = {
    baseline: [
      hostRow(1, short),
      hostRow(2, short),
      hostRow(3, longer),
      hostRow(4, "other.example", { url: `https://other.example/${short}` }),
      hostRow(5, "third.example", { provenance: { initiatorDomain: short } })
    ],
    variant: [hostRow(6, longer), hostRow(7, "third.example")]
  };
  const changes = domainRequestDeltas(summarizeDomains(visits.baseline), summarizeDomains(visits.variant));
  assert.ok(changes.some((change) => change.domain === short), "the fixture lost its over-matched host");
  for (const change of changes) {
    for (const arm of ["baseline", "variant"] as const) {
      const target = parseEvidenceHash(buildEvidenceHash({ section: "requests", arm, query: change.domain, exactHost: true }));
      assert.equal(
        linkedRows(visits[arm], target).length,
        change[`${arm}Requests`],
        `the rows of ${change.domain} in the ${arm} visit are not the rows its count counts`
      );
    }
  }
});

test("match needs the requests section, an arm and a whole query", () => {
  const exact = (hash: string) => parseEvidenceHash(hash)?.exactHost;
  assert.equal(exact(`#evidence=requests&arm=baseline&query=${"a".repeat(500)}&match=host`), true, "a whole query of 500 characters loses the match");
  assert.equal(exact("#evidence=requests&query=cdn.example&match=host"), undefined, "a match with no arm is read");
  assert.equal(exact("#evidence=domains&arm=baseline&query=cdn.example&match=host"), undefined, "a match outside the request log is read");
  assert.equal(exact("#evidence=requests&arm=baseline&match=host"), undefined, "a match with no query is read");
  assert.equal(exact("#evidence=requests&arm=baseline&query=cdn.example&match=prefix"), undefined, "a match with another value is read");
  assert.equal(exact(`#evidence=requests&arm=baseline&query=${"a".repeat(501)}&match=host`), undefined, "a match on a truncated query is read");
});

test("an old free-text fragment filters as before", () => {
  const rows = [hostRow(1, "cdn.example"), hostRow(2, "a.cdn.example")];
  const target = parseEvidenceHash("#evidence=requests&arm=baseline&query=cdn.example");
  assert.deepEqual(target, { section: "requests", arm: "baseline", query: "cdn.example" }, "an old fragment gained a match");
  assert.equal(linkedRows(rows, target).length, 2, "an old fragment no longer searches free text");
});

test("two wire hosts with one display form stay apart", () => {
  const rows = [hostRow(1, "{label}.site.example"), hostRow(2, "*.site.example")];
  assert.equal(displayHost(rows[0].domain), displayHost(rows[1].domain), "the fixture's hosts no longer share a display form");
  assert.deepEqual(
    rows.filter((row) => requestMatchesTextFilter(row, rows[0].domain, rows[0].domain)).map((row) => row.id),
    [1],
    "the match compares display forms, not recorded hosts"
  );
});

test("a count of 0 opens no rows", () => {
  const rows = [hostRow(1, "a.cdn.example")];
  assert.deepEqual(rows.filter((row) => requestMatchesTextFilter(row, "cdn.example", "cdn.example")), [], "a host with no row in the visit opens other hosts' rows");
  assert.match(
    logLine("filterRequestLog(requests"),
    /pair: attributionPair, exactHost \}, destinationByHost\)/,
    "the log does not apply the match as the link set it, whatever rows the visit holds"
  );
});

test("the match stays through a visit change", () => {
  assert.deepEqual(
    (requestLogSource().match(/setExactHost\([^\n]*/g) ?? []).sort(),
    [
      "setExactHost(evidenceTarget.exactHost ? evidenceTarget.query ?? null : null);",
      "setExactHost(null);",
      "setExactHost(null);"
    ],
    "something other than the link, typing and Clear filters sets the match"
  );
  const renderer = componentSource("report-renderer");
  const mounts = renderer.match(/<RequestTable[\s\S]*?\/>/g) ?? [];
  assert.ok(mounts.length > 0, "the renderer no longer mounts the request log");
  for (const mount of mounts) assert.doesNotMatch(mount, /\skey=/, "a visit change would remount the request log");
  // The log's state also dies with the per-visit evidence that holds it.
  const evidence = renderer.match(/<RunEvidence[\s\S]*?\/>/g) ?? [];
  assert.equal(evidence.length, 2, "the renderer no longer mounts one visit's evidence for paper and one for the screen");
  for (const mount of evidence) assert.doesNotMatch(mount, /\skey=/, "a visit change would remount the visit's evidence");
});

test("another evidence link replaces the match", () => {
  const log = requestLogSource();
  const start = requireIndex(log, "if (!evidenceTarget) return;");
  const effect = log.slice(start, requireIndex(log, "}, [evidenceTarget]);", "the target effect", start));
  assert.equal(
    effect.match(/[^\n]*setExactHost[^\n]*/)?.[0].trim(),
    "setExactHost(evidenceTarget.exactHost ? evidenceTarget.query ?? null : null);",
    "a link without the match keeps the old one"
  );
});

test("the match stays through chip, status and type changes", () => {
  assert.doesNotMatch(logLine("setSignalFilter(filter.value)"), /setExactHost/, "a chip change ends the match");
  assert.doesNotMatch(logLine("setStatusFilter(event.currentTarget.value"), /setExactHost/, "a status change ends the match");
  assert.doesNotMatch(logLine("setResourceFilter(event.currentTarget.value"), /setExactHost/, "a type change ends the match");
});

test("typing in the search box ends the match", () => {
  const log = requestLogSource();
  const start = requireIndex(log, 'aria-label="Filter requests"');
  assert.match(log.slice(start, requireIndex(log, "/>", "the search box", start)), /setExactHost\(null\);/, "typing in the search box does not end the match");
});

test("clearing the filters ends the match", () => {
  const log = requestLogSource();
  const start = requireIndex(log, "function resetFilters()");
  assert.match(log.slice(start, requireIndex(log, "useEffect(", "resetFilters", start)), /setExactHost\(null\);/, "Clear filters does not end the match");
});

test("an exact match is named above the table", () => {
  const line = hostMatchLine();
  assert.notEqual(line, "", "no line names the exact match");
  assert.equal(line.split("\n")[0], "{exactHost && (", "the line depends on more than the match");
  assert.match(line, /onClick=\{resetFilters\}/, "the line offers no Clear filters");
  const log = requestLogSource();
  assert.ok(log.indexOf(line) < requireIndex(log, "className={`table-wrap request-table"), "the line is not above the table");
});

test("the line is the listed sentence, word for word", () => {
  const words = (hostMatchLine().match(/<span>([\s\S]*?)<\/span>/)?.[1] ?? "")
    .replace(/\{[^{}]*\}/g, "<host>")
    .replace(/<\/?strong>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  assert.equal(words, "Showing only requests with this recorded host: <host>.", "the line is not the listed sentence");
});

test("the line names the host as the report displays it", () => {
  assert.equal(hostMatchLine().match(/<strong>[^\n]*<\/strong>/)?.[0], "<strong>{displayHost(exactHost)}</strong>", "the line does not show the host's display form");
});

test("a printed request reference names the row's place in the stored log, whatever the filter shows", () => {
  // The rows of the audit's case: a first-party document, then the first cross-site row.
  const stored = [
    { domain: "www.site.example", thirdParty: false },
    { domain: "fonts.example.net", thirdParty: true },
    { domain: "www.site.example", thirdParty: false },
    { domain: "cdn.example.org", thirdParty: true }
  ];
  const positions = retainedRowPositions(stored);
  const filtered = stored.filter((row) => row.thirdParty);
  assert.deepEqual(filtered.map((row) => printedRequestRef("baseline", positions.get(row)!)), ["B:R0002", "B:R0004"]);
  assert.deepEqual(stored.map((row) => printedRequestRef("", positions.get(row)!)), ["S:R0001", "S:R0002", "S:R0003", "S:R0004"]);
  assert.equal(printedRequestRef("variant", 12), "V:R0012");
  // Two rows with equal content are still two rows.
  const twins = [{ id: 7 }, { id: 7 }];
  assert.deepEqual(twins.map((row) => retainedRowPositions(twins).get(row)), [1, 2]);
});

test("the request log prints each reference from the stored log's positions, never a filtered index", () => {
  const tables = readFileSync(path.join(process.cwd(), "app", "_components", "report-tables.tsx"), "utf8");
  assert.match(tables, /const positions = useMemo\(\(\) => retainedRowPositions\(requests\), \[requests\]\);/);
  assert.match(tables, /printedRequestRef\(printVisit, positions\.get\(request\) \?\? Number\.NaN\)/);
  assert.doesNotMatch(tables, /:R\$\{String\(index \+ 1\)/, "a reference from the row's index in the shown list");
});

test("a filtered printed log says so, and that each reference still names its stored row", () => {
  assert.equal(
    printedFilterLine(14, 122),
    "This printed log is filtered and shows 14 of 122 retained rows; each reference still names its row in the stored JSON."
  );
  assert.equal(printedFilterLine(1, 1234), "This printed log is filtered and shows 1 of 1,234 retained rows; each reference still names its row in the stored JSON.");
  const tables = readFileSync(path.join(process.cwd(), "app", "_components", "report-tables.tsx"), "utf8");
  assert.match(tables, /\{printComplete && filtersActive && <p className="print-row-key">\{printedFilterLine\(shown\.length, requests\.length\)\}<\/p>\}/);
});
