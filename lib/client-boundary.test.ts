import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

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
      /finding-look-closer|report-site-history|request-log-filters|corpus-overview"/,
      `${parts.join("/")} imports a module a Look closer view is built from`
    );
  }
  // The view module reads only the evidence-hash helpers and, as a type, the
  // card: no React, no scan form, no corpus read.
  const module = read("lib", "finding-look-closer.ts");
  const imports = [...module.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm)];
  assert.deepEqual(imports.map((match) => match[2]).sort(), ["./report-evidence-navigation", "./report-findings"]);
  holds(imports.find((match) => match[2] === "./report-findings")?.[1] ?? "", /^type\s/, "the view module imports the card only as a type");
  // One renderer, the shared server-safe board markup.
  const list = read("app", "_components", "findings-list.tsx");
  holds(
    list,
    /^import \{ findingLookCloser, LOOK_CLOSER_NAME \} from "@\/lib\/finding-look-closer";$/m,
    "the shared board markup renders the views"
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
  holds(page, /lookCloser=\{\{ siteHistoryHref \}\}/, "the summary board renders the views");
  holds(
    read("app", "reports", "[id]", "saved-report-client.tsx"),
    /<LazyReportRenderer[^>]*siteHistoryHref=\{siteHistoryHref\}/,
    "the saved-report client passes the history target to the explorer"
  );
  holds(
    read("app", "_components", "report-renderer.tsx"),
    /<FindingsBoard [^>]*siteHistoryHref=\{siteHistoryHref\}/,
    "the explorer passes it to its board"
  );
  holds(
    read("app", "_components", "report-overview.tsx"),
    /const printComplete = usePrintComplete\(\);[\s\S]*?lookCloser=\{printComplete \? undefined : \{ siteHistoryHref \}\}/,
    "the explorer's board renders no view on paper"
  );
  const print = read("app", "reports", "[id]", "print", "page.tsx");
  never(print, /siteHistoryHref|lookCloser/, "the printable route hands its board a Look closer input");
  holds(print, /<ReportRenderer[\s\S]*?printComplete\s/, "the printable route renders its board for paper");
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
