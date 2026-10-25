import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clientImportTrails } from "./client-import-graph";

const root = process.cwd();

test("report permalinks do not import the scanner, gallery, watches, or import workbench", () => {
  const client = readFileSync(path.join(root, "app", "reports", "[id]", "saved-report-client.tsx"), "utf8");
  for (const forbidden of [
    "site-behavior-app",
    "scan-controls",
    "static-gallery",
    "scheduled-rescans",
    "file-upload-button",
    "use-scan-runtime",
    "pagegraph-client-import"
  ]) {
    assert.doesNotMatch(client, new RegExp(forbidden), `saved report client imports ${forbidden}`);
  }
  assert.match(client, /lazy\(\(\) =>[\s\S]*report-renderer/);
  assert.match(client, /fetchBytesResponseWithPolicy\(evidenceHref[\s\S]*maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES/);
  assert.match(client, /parseDigestBoundReportJson\([\s\S]*expectedEvidenceSha256/);
  assert.match(client, /fetchBytesResponseWithPolicy\(evidenceHref[\s\S]*Explore full evidence/);
});

test("homepage keeps the evidence renderer outside its initial route module", () => {
  const app = readFileSync(path.join(root, "app", "site-behavior-app.tsx"), "utf8");
  assert.match(app, /lazy\(\(\) =>[\s\S]*report-renderer/);
  assert.match(app, /<LazyReportRenderer/);
  assert.doesNotMatch(app, /from "\.\/_components\/(?:report-header|report-overview|report-tables|comparison-panel|causality-graph)"/);
});

test("homepage reads cohort differences without the corpus-cohort report graph", () => {
  // corpus-cohort imports the version-aware report views and the comparison
  // modules; one runtime import of it cost the homepage about 15,900 gzip bytes.
  const importClauses = (source: string, specifier: RegExp) =>
    [...source.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm)]
      .filter((match) => specifier.test(match[2]))
      .map((match) => match[1]);
  const app = readFileSync(path.join(root, "app", "site-behavior-app.tsx"), "utf8");
  assert.deepEqual(importClauses(app, /^@\/lib\/corpus-cohort-differences$/), ["{ corpusCohortDifferences }"]);
  for (const clause of importClauses(app, /^@\/lib\/corpus-cohort$/)) {
    assert.match(clause, /^type\s/, "the homepage may import corpus-cohort only as a type");
  }
  const differences = readFileSync(path.join(root, "lib", "corpus-cohort-differences.ts"), "utf8");
  for (const clause of importClauses(differences, /./)) {
    assert.match(clause, /^type\s/, "corpus-cohort-differences must stay free of runtime imports");
  }
  assert.match(
    readFileSync(path.join(root, "lib", "corpus-cohort.ts"), "utf8"),
    /^export \{ corpusCohortDifferences \} from "\.\/corpus-cohort-differences";$/m
  );
});

test("Look closer views are built on the server or in the renderer chunk, never in an initial bundle", () => {
  const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
  // Each check fails with a sentence, never with the source it read: a failed
  // match carrying a whole file as its actual value has been seen to stall
  // the test runner's parent process while it parses the report.
  const holds = (source: string, pattern: RegExp, expectation: string) =>
    assert.ok(pattern.test(source), `expected ${expectation}`);
  const never = (source: string, pattern: RegExp, violation: string) => assert.ok(!pattern.test(source), violation);
  // The permalink's controller and the homepage's entry points import none of
  // the modules a view is built from, so neither initial bundle grows.
  for (const parts of [
    ["app", "reports", "[id]", "saved-report-client.tsx"],
    ["app", "site-behavior-app.tsx"],
    ["app", "_hooks", "use-scan-runtime.ts"]
  ]) {
    never(
      read(...parts),
      /finding-look-closer|report-site-history|report-rescan-targets|request-log-filters|corpus-overview"/,
      `${parts.join("/")} imports a module a Look closer view is built from`
    );
  }
  // The view module reads only the evidence-hash helpers, the scan link
  // builder and, as types, the card and the run modes: no React, no scan
  // form, no corpus read.
  const module = read("lib", "finding-look-closer.ts");
  const imports = [...module.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm)];
  assert.deepEqual(
    imports.map((match) => match[2]).sort(),
    ["./report-evidence-navigation", "./report-findings", "./run-mode-copy", "./scan-prefill"]
  );
  holds(imports.find((match) => match[2] === "./report-findings")?.[1] ?? "", /^type\s/, "the view module imports the card only as a type");
  holds(imports.find((match) => match[2] === "./run-mode-copy")?.[1] ?? "", /^type\s/, "the view module imports the run modes only as a type");
  // A new visit's page comes from the light rescan-target module, which the
  // report header's rescan links read too. It reads neither the site
  // identity nor the public-suffix list, which reportActivation's history
  // path needs, so the explorer's chunk does not grow by them.
  const targets = read("lib", "report-rescan-targets.ts");
  assert.deepEqual(
    [...targets.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm)].map((match) => match[2]).sort(),
    ["./report-url", "./scan-report-views"]
  );
  // One renderer, the shared server-safe board markup.
  const list = read("app", "_components", "findings-list.tsx");
  holds(
    list,
    /^import \{ findingLookCloser, findingNewVisit, LOOK_CLOSER_NAME \} from "@\/lib\/finding-look-closer";$/m,
    "the shared board markup renders the views and the new visits"
  );
  never(list, /"use client"/, "the shared board markup became a client module");
  // The permalink reads the site's history once, on the server, and hands the
  // same value to its summary board and its explorer, which renders it unless
  // the page is for paper. The printable route hands it nothing.
  const page = read("app", "reports", "[id]", "page.tsx");
  assert.equal(page.match(/siteHistoryLookCloserHref\(/g)?.length, 1, "the permalink reads the history target once");
  holds(
    page,
    /pdfExportQuery=\{reportPdfExportQuery\(id, result\.wireSha256\)\}\s*siteHistoryHref=\{siteHistoryHref\}/,
    "the permalink hands the history target to its explorer"
  );
  holds(page, /<ReportPageSummary[\s\S]*?siteHistoryHref=\{siteHistoryHref\}[\s\S]*?\/>/, "the permalink hands it to its summary");
  holds(
    page,
    /lookCloser=\{\{ siteHistoryHref, newVisitTarget, newVisitFrom, basePath: sitePagesBasePath\(\) \}\}/,
    "the summary board renders the views and the new visits"
  );
  const client = read("app", "reports", "[id]", "saved-report-client.tsx");
  holds(client, /<LazyReportRenderer[^>]*siteHistoryHref=\{siteHistoryHref\}/, "the saved-report client passes the history target to the explorer");
  const renderer = read("app", "_components", "report-renderer.tsx");
  holds(renderer, /<FindingsBoard [^>]*siteHistoryHref=\{siteHistoryHref\}/, "the explorer passes it to its board");
  holds(
    read("app", "_components", "report-overview.tsx"),
    /const printComplete = usePrintComplete\(\);[\s\S]*?lookCloser=\{printComplete \? undefined : \{ siteHistoryHref, newVisitTarget, newVisitFrom, basePath: STATIC_BASE_PATH \}\}/,
    "the explorer's board renders no view or new visit on paper"
  );
  // The fresh input reaches both boards: the permalink decides it once, from
  // where it read the report, and builds its summary board's target from it;
  // the explorer, on the permalink and on the homepage, builds its own from
  // the same value and the same view through the same function.
  assert.equal(page.match(/result\.origin === "share-store"/g)?.length, 1, "the permalink decides freshness once");
  holds(page, /const freshResult = result\.origin === "share-store";\s*const newVisitTarget = reportNewVisitTarget\(view, freshResult\);/, "the permalink builds the summary board's target from that freshness");
  holds(page, /<ReportPageSummary[\s\S]*?newVisitTarget=\{newVisitTarget\}[\s\S]*?\/>/, "the permalink hands the target to its summary");
  holds(page, /siteHistoryHref=\{siteHistoryHref\}\s*freshResult=\{freshResult\}/, "the permalink hands its freshness to the explorer");
  holds(client, /<LazyReportRenderer[^>]*freshResult=\{freshResult\}/, "the saved-report client passes the freshness on");
  holds(renderer, /const newVisitTarget = reportNewVisitTarget\(reportView, freshResult\);/, "the explorer builds its target from the freshness");
  holds(renderer, /<FindingsBoard [^>]*newVisitTarget=\{newVisitTarget\}/, "the explorer's board gets that target");
  holds(renderer, /freshResult = false/, "a renderer is not fresh unless told");
  // The share a new visit's link names travels the same way: one function of
  // the same view and the same freshness on every board, so the permalink's
  // two boards name the same share and its client gains no prop.
  assert.equal(page.match(/reportNewVisitFrom\(/g)?.length, 1, "the permalink names the share once");
  holds(
    page,
    /const newVisitTarget = reportNewVisitTarget\(view, freshResult\);\s*const newVisitFrom = reportNewVisitFrom\(view, freshResult\);/,
    "the permalink names its summary board's share from the same view and freshness"
  );
  holds(page, /<ReportPageSummary[\s\S]*?newVisitFrom=\{newVisitFrom\}[\s\S]*?\/>/, "the permalink hands the share to its summary");
  never(client, /newVisitFrom|reportNewVisitFrom/, "the saved-report client carries the share a new visit names");
  const clientProps = page.slice(page.indexOf("<SavedReportClient"), page.indexOf("context={", page.indexOf("<SavedReportClient")));
  holds(clientProps, /freshResult=\{freshResult\}/, "the permalink's client props to be the ones read here");
  never(clientProps, /newVisitFrom/, "the permalink hands its client the share a new visit names, a prop every committed page would serialize");
  holds(renderer, /const newVisitFrom = reportNewVisitFrom\(reportView, freshResult\);/, "the explorer names the share from its own view and the freshness");
  holds(renderer, /<FindingsBoard [^>]*newVisitFrom=\{newVisitFrom\}/, "the explorer's board gets that share");
  // On the homepage, only the result this tab's live scan returned is fresh.
  const app = read("app", "site-behavior-app.tsx");
  holds(app, /<LazyReportRenderer [^>]*freshResult=\{freshScanResult\}/, "the homepage hands its result's freshness to the explorer");
  const hook = read("app", "_hooks", "use-scan-runtime.ts");
  holds(
    hook,
    /freshScanResult: liveScan !== null && loaded === liveScan\.result && liveScan\.scrollCheck === null,/,
    "freshness is the live scan's own result, by identity, and never a check's, which offers no new visit"
  );
  // Only showLiveScanResult records a live result, or clears one for a check
  // shell no submit asked for.
  const showLive = hook.slice(hook.indexOf("function showLiveScanResult("), hook.indexOf("function releaseActiveScanSession("));
  assert.equal(hook.match(/setLiveScan\(/g)?.length, 2, "only showLiveScanResult records or clears a live result");
  assert.equal(showLive.match(/setLiveScan\(/g)?.length, 2, "only showLiveScanResult records or clears a live result");
  assert.equal(hook.match(/showLiveScanResult\(nextLoaded[,)]/g)?.length, 4, "submit, resume, restore and admission recovery show a live result");
  // Only the submit hands over the inspection it asked for: the status poll
  // re-serves the same shell to a resumed or restored tab, which shows none.
  assert.equal(hook.match(/showLiveScanResult\(nextLoaded\)/g)?.length, 3, "resume, restore and admission recovery hand over no inspection");
  holds(
    hook,
    /assertClientOperationOwner\(operationOwnerRef\.current, operation\);\s*showLiveScanResult\(nextLoaded, inspectionArrival, scrollCheckArrival\);/,
    "the submit path hands over the inspection or the check its request asked for"
  );
  holds(hook, /inspection: liveScan !== null && loaded === liveScan\.result \? liveScan\.inspection : null,/, "the inspection reaches the page only while its own result is shown");
  // A check's result shows only from that submit: nothing from it is saved,
  // so a resumed, restored or recovered shell that carries one shows nothing.
  holds(
    hook,
    /if \(checked === null && carriesScrollCheck\(next\)\) \{\s*setLoaded\(null\);\s*setLiveScan\(null\);\s*return;\s*\}\s*setLoaded\(next\);/,
    "a check's result shell reaching any other path is dropped before it is shown"
  );
  holds(hook, /scrollCheck: shownScrollCheck\(next, checked\)\s*\}\);/, "the check shown is the one the submit asked for");
  holds(hook, /scrollCheck: liveScan !== null && loaded === liveScan\.result \? liveScan\.scrollCheck : null,/, "the check reaches the page only while its own result is shown");
  holds(app, /<LazyReportRenderer [^>]*scrollCheck=\{scrollCheck\}/, "the homepage hands its result's check to the explorer");
  holds(renderer, /scrollCheck = null/, "a renderer shows no check unless told");
  holds(
    renderer,
    /\{scrollCheck && !printComplete && \(\s*<>\s*<ScrollCheckPanel evidence=\{scrollCheck\.evidence\} earlierResultHref=\{checkedFromHref\} \/>\s*<p className="scroll-check-report-note">\{scrollCheckReportNote\(scrollCheck\.evidence\)\}<\/p>\s*<\/>\s*\)\}\s*<ReportHeader/,
    "the check's panel and its one sentence render from the handed-over check, ahead of the report, never on paper"
  );
  holds(renderer, /exportsOffered=\{scrollCheck === null\}/, "a check's result offers no export");
  holds(renderer, /sharingOffered=\{scrollCheck === null\}/, "a check's result offers no headline to post or copy");
  holds(read("app", "_components", "report-overview.tsx"), /\{sharingOffered && \(\s*<div className="headline-actions">/, "a banner that offers no sharing renders no share actions");
  const header = read("app", "_components", "report-header.tsx");
  holds(header, /\{exportsOffered && pdfHref && \(/, "a result that offers no export offers no PDF");
  holds(header, /\{exportsOffered && \(\s*<>\s*<button\s*aria-describedby="csv-export-description"/, "a result that offers no export offers no CSV or JSON");
  holds(app, /<LazyReportRenderer [^>]*inspection=\{inspection\}/, "the homepage hands its result's inspection to the explorer");
  holds(renderer, /inspection = null/, "a renderer shows no inspection unless told");
  holds(
    renderer,
    /\{inspection && !printComplete && \(\s*<ConnectionInspectionPanel evidence=\{inspection\.evidence\} earlierResultHref=\{inspectedFromHref\} \/>\s*\)\}/,
    "the panel renders from the handed-over inspection, never on paper"
  );
  never(hook, /setLoaded\(nextLoaded\)/, "a live scan result reached the result region without being recorded as fresh");
  const print = read("app", "reports", "[id]", "print", "page.tsx");
  never(print, /siteHistoryHref|lookCloser|freshResult|newVisitTarget|newVisitFrom|earlierResultId/, "the printable route hands its board a Look closer input");
  holds(print, /<ReportRenderer[\s\S]*?printComplete\s/, "the printable route renders its board for paper");
  // The link back to an earlier result: the homepage hands its connected
  // result's id to the renderer, the only place it renders, and resolves it
  // as a freshly produced report's share; a permalink, its client and the
  // printable route hand none, and nothing else renders the line.
  holds(renderer, /earlierResultId = null/, "a renderer links back to nothing unless told");
  holds(
    renderer,
    /const earlierResultHref = earlierResultId\s*\? locateReport\(earlierResultId, \{ \.\.\.clientReportRuntime\(\), liveApiServesReportPages \}\)\.pagePath\s*: null;/,
    "the back-link resolves as a freshly produced report's share permalink"
  );
  holds(renderer, /\{earlierResultHref && \(\s*<div className="earlier-result-note">/, "the line renders only with a share to link to");
  for (const [source, where] of [[page, "the permalink"], [client, "the saved-report client"]] as const) {
    never(source, /earlierResultId|earlier-result/, `${where} hands its explorer an earlier result`);
    never(source, /inspection=|ConnectionInspection/, `${where} hands its explorer an inspection`);
    never(source, /scrollCheck=|ScrollCheckPanel|scroll-check-result/, `${where} hands its explorer a check`);
  }
  never(print, /inspection=|ConnectionInspection/, "the printable route hands its board an inspection");
  never(print, /scrollCheck|ScrollCheck|scroll-check/, "the printable route hands its board a check");
  for (const parts of [["app", "site-behavior-app.tsx"], ["app", "_hooks", "use-scan-runtime.ts"], ["app", "_components", "findings-list.tsx"]]) {
    never(read(...parts), /earlier-result-note|EARLIER_RESULT_LINK/, `${parts.join("/")} renders the back-link line`);
  }
});

test("Inspect this connection keeps the public-suffix list and the recorder out of every client bundle", () => {
  const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
  const importsOf = (source: string) =>
    [...source.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm)].map((match) => ({ clause: match[1], from: match[2] }));
  // The request contract the homepage bundles is dependency-free, and the
  // evidence validator readers use reads only it and the shared guards.
  assert.deepEqual(importsOf(read("lib", "connection-inspection-address.ts")), []);
  assert.deepEqual(
    importsOf(read("lib", "connection-inspection-evidence.ts")).map((entry) => entry.from).sort(),
    ["./connection-inspection-address", "./guards"]
  );
  const copyImports = importsOf(read("lib", "connection-inspection-copy.ts"));
  assert.deepEqual(copyImports.map((entry) => entry.from).sort(), ["./connection-inspection-evidence", "./text-format"]);
  assert.ok(
    /^type\s/.test(copyImports.find((entry) => entry.from === "./connection-inspection-evidence")?.clause ?? ""),
    "the copy module imports the evidence only as a type"
  );
  // The hook's reading of a result's inspection imports nothing at run time.
  for (const entry of importsOf(read("lib", "connection-inspection-result.ts"))) {
    assert.ok(/^type\s/.test(entry.clause), `connection-inspection-result.ts imports ${entry.from} at run time`);
  }
  // The row link's one minter reads the request contract, its copy and the
  // scan link builder, and the row only as a type.
  const linkImports = importsOf(read("lib", "request-inspection-link.ts"));
  assert.deepEqual(
    linkImports.map((entry) => entry.from).sort(),
    ["./connection-inspection-address", "./connection-inspection-copy", "./scan-prefill", "./types"]
  );
  assert.ok(/^type\s/.test(linkImports.find((entry) => entry.from === "./types")?.clause ?? ""), "the minter imports the row only as a type");
  // The prefill parser checks an address by its shape only, and a check by
  // the request contract's one value, which imports nothing.
  assert.deepEqual(
    importsOf(read("lib", "scan-prefill.ts")).map((entry) => entry.from).sort(),
    ["./connection-inspection-address", "./report-validation", "./run-mode-copy", "./scroll-check-request"]
  );
  assert.deepEqual(importsOf(read("lib", "scroll-check-request.ts")), []);
  // No client entry point or component reaches the recorder, which holds the
  // raw stacks and imports the redaction pass with its public-suffix list.
  for (const parts of [
    ["app", "site-behavior-app.tsx"],
    ["app", "_hooks", "use-scan-runtime.ts"],
    ["app", "_components", "scan-controls.tsx"],
    ["app", "_components", "report-tables.tsx"],
    ["app", "_components", "report-renderer.tsx"],
    ["app", "reports", "[id]", "saved-report-client.tsx"],
    ["lib", "scan-client-orchestration.ts"],
    ["lib", "known-site-evidence.ts"]
  ]) {
    const source = read(...parts);
    assert.ok(
      !/["']@\/lib\/connection-inspection["']|["']\.\/connection-inspection["']|call-stack-publisher|redaction-v2/.test(source),
      `${parts.join("/")} reaches the recorder, the stack publisher or the redaction pass`
    );
  }
  // The one stack publisher reads the redaction pass and sha256, and the
  // recorder holds raw stacks: neither reaches any client bundle, by any
  // trail of imports.
  for (const module of ["lib/call-stack-publisher.ts", "lib/connection-inspection.ts"]) {
    assert.deepEqual(clientImportTrails(module), [], `${module} must not reach a client bundle`);
  }
  // The homepage's own code reads only the request contract and the
  // type-only result reader; the row link, the panel and their copy live in
  // the explorer's lazy chunk.
  for (const parts of [["app", "site-behavior-app.tsx"], ["app", "_hooks", "use-scan-runtime.ts"], ["app", "_components", "scan-controls.tsx"]]) {
    assert.ok(
      !/connection-inspection-copy|connection-inspection-evidence|connection-inspection-panel|request-inspection-link/.test(read(...parts)),
      `${parts.join("/")} bundles reader copy, the panel or the validator`
    );
  }
});

test("the client import walk follows named, dynamic and side-effect imports alike", () => {
  // A side-effect import bundles its module as surely as a named one, so a
  // walk that missed it would let a server-only module into a client bundle
  // unseen.
  const tree = mkdtempSync(path.join(tmpdir(), "sbl-client-graph-"));
  try {
    mkdirSync(path.join(tree, "app"));
    mkdirSync(path.join(tree, "lib"));
    writeFileSync(
      path.join(tree, "app", "panel.tsx"),
      '"use client";\nimport { named } from "../lib/named";\nimport "@/lib/effect";\nconst later = () => import("../lib/dynamic");\nexport { later };\n'
    );
    for (const module of ["named", "effect", "dynamic", "unreached"]) writeFileSync(path.join(tree, "lib", `${module}.ts`), "export const named = 1;\n");
    assert.deepEqual(clientImportTrails("lib/named.ts", tree), ["app/panel.tsx -> lib/named.ts"]);
    assert.deepEqual(clientImportTrails("lib/effect.ts", tree), ["app/panel.tsx -> lib/effect.ts"]);
    assert.deepEqual(clientImportTrails("lib/dynamic.ts", tree), ["app/panel.tsx -> lib/dynamic.ts"]);
    assert.deepEqual(clientImportTrails("lib/unreached.ts", tree), []);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("Check after scrolling keeps its recorder off the client, and its panel out of the homepage's own code", () => {
  const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
  const importsOf = (source: string) =>
    [...source.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm)].map((match) => ({ clause: match[1], from: match[2] }));
  // The recorder holds raw hostnames and reads the redaction pass with its
  // public-suffix list; the entry's minter is the permalink's, on the server.
  for (const module of ["lib/scroll-check.ts", "lib/scroll-check-entry.ts"]) {
    assert.deepEqual(clientImportTrails(module), [], `${module} must not reach a client bundle`);
  }
  // The evidence validator reads the published-host shape and the shared
  // guards; the copy reads the evidence's bounds and the text formatter; the
  // hook's reading of a result's check imports nothing at run time.
  assert.deepEqual(importsOf(read("lib", "scroll-check-evidence.ts")).map((entry) => entry.from).sort(), ["./connection-inspection-evidence", "./guards"]);
  assert.deepEqual(importsOf(read("lib", "scroll-check-copy.ts")).map((entry) => entry.from).sort(), ["./scroll-check-evidence", "./text-format"]);
  for (const entry of importsOf(read("lib", "scroll-check-result.ts"))) {
    assert.ok(/^type\s/.test(entry.clause), `scroll-check-result.ts imports ${entry.from} at run time`);
  }
  // The homepage's own code reads the request contract, the result reader
  // and the form's line only; the panel and its copy live in the explorer's
  // lazy chunk.
  for (const parts of [
    ["app", "site-behavior-app.tsx"],
    ["app", "_hooks", "use-scan-runtime.ts"],
    ["app", "_components", "scan-controls.tsx"],
    ["lib", "known-site-evidence.ts"],
    ["lib", "scan-prefill.ts"],
    ["lib", "scan-client-orchestration.ts"]
  ]) {
    assert.ok(
      !/scroll-check-copy|scroll-check-evidence|scroll-check-panel|scroll-check-entry/.test(read(...parts)),
      `${parts.join("/")} bundles the check's panel, its copy or its validator`
    );
  }
});

test("the scan form's known-site note reads no retention default and keeps its imports light", () => {
  const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
  const importsOf = (source: string) =>
    [...source.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm)].map((match) => ({ clause: match[1], from: match[2] }));
  // The copy module the homepage bundles: three small copy and text modules,
  // and the known site only as a type.
  const copy = importsOf(read("lib", "known-site-evidence.ts"));
  assert.deepEqual(
    copy.map((entry) => entry.from).sort(),
    ["./homepage-discovery", "./live-rescan-copy", "./run-mode-copy", "./text-format"]
  );
  assert.ok(
    /^type\s/.test(copy.find((entry) => entry.from === "./homepage-discovery")?.clause ?? ""),
    "the copy module imports the known site only as a type"
  );
  assert.deepEqual(importsOf(read("lib", "live-rescan-copy.ts")), [], "the shared clause module imports nothing");
  // A number reaches the note only from the scanner's health. The build's
  // default is the privacy page's statement about the reference deployment,
  // never this scanner's answer.
  for (const parts of [
    ["lib", "known-site-evidence.ts"],
    ["lib", "scan-runtime-health.ts"],
    ["lib", "scan-client-orchestration.ts"],
    ["app", "_components", "scan-controls.tsx"],
    ["app", "_hooks", "use-scan-runtime.ts"],
    ["app", "site-behavior-app.tsx"]
  ]) {
    assert.ok(
      !/report-share-retention|DEFAULT_REPORT_MAX_AGE_DAYS/.test(read(...parts)),
      `${parts.join("/")} reads the build's retention default`
    );
  }
});

test("report pages pass compact server output instead of serializing stored evidence into the client", () => {
  const page = readFileSync(path.join(root, "app", "reports", "[id]", "page.tsx"), "utf8");
  assert.doesNotMatch(page, /stored=\{result\.stored\}/);
  // The summary slot carries the headline and the findings board, both built
  // on the server from the view; the raw evidence still crosses the network
  // only through the explorer's digest-bound fetch.
  assert.match(page, /summary=\{\s*<ReportPageSummary/);
  assert.match(page, /const findings = buildFindings\(view, await loadCommittedCorpusStats\(\), facts, evidenceArm\)/);
  assert.match(page, /evidenceHref=\{evidenceHref\}/);
  assert.match(page, /expectedEvidenceSha256=\{result\.wireSha256\}/);
});
