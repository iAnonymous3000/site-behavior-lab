import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getDomain } from "tldts";
import {
  buildPageGraphExportManifest,
  buildCorpusFacts,
  corpusFactsToCsvTables,
  CROSS_SITE_STORAGE_SQL,
  DUCKDB_BOOTSTRAP_SQL,
  redactRuleImpactReportForExport,
  RULE_IMPACT_SQL,
  simulateRuleImpact,
  type CorpusFacts,
  type CorpusRequestRow
} from "./pagegraph-corpus";

/**
 * PageGraph corpus Phase 0 CLI (docs/pagegraph-corpus-phase0.md):
 *
 *   npm run corpus:pagegraph -- --out <dir> [--rule "<adblock filter>"] <file.graphml ...>
 *
 * Ingests PageGraph GraphML files into the corpus fact tables, writes them as
 * DuckDB-loadable CSVs plus bootstrap.sql and the two flagship queries, and,
 * when --rule is given, matches it with the vendored Brave adblock engine and
 * writes directly_blocked.csv plus impact-report.json (the TypeScript closure;
 * the SQL closure over the same tables must agree).
 *
 * Node-only CLI: never imported by app, worker, or browser code.
 */

type CliOptions = {
  out: string;
  rule: string | null;
  files: string[];
};

/** Map PageGraph resource types onto the adblock engine's request types. */
function engineRequestType(resourceType: string): string {
  const normalized = resourceType.toLowerCase();
  if (normalized === "fetch" || normalized === "xhr") return "xmlhttprequest";
  if (normalized === "sub frame" || normalized === "subframe" || normalized === "iframe") return "subdocument";
  return normalized;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { out: ".pagegraph-corpus", rule: null, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      options.out = argv[++index] ?? options.out;
    } else if (arg === "--rule") {
      options.rule = argv[++index] ?? null;
    } else if (arg) {
      options.files.push(arg);
    }
  }
  return options;
}

function loadAdblockMatcher(rule: string): (request: CorpusRequestRow, pageUrl: string) => boolean {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  const { AdblockEngine } = require(path.join(process.cwd(), "lib", "adblock-wasm", "sbl_adblock_wasm.js")) as {
    AdblockEngine: new (rules: string) => { check: (url: string, sourceUrl: string, requestType: string) => boolean };
  };
  const engine = new AdblockEngine(rule);
  return (request, pageUrl) => engine.check(request.url, pageUrl, engineRequestType(request.resourceType));
}

export function main(argv = process.argv.slice(2)): number {
  const options = parseArgs(argv);
  if (options.files.length === 0) {
    console.error('Usage: npm run corpus:pagegraph -- --out <dir> [--rule "<adblock filter>"] <file.graphml ...>');
    return 1;
  }

  const corpus: CorpusFacts[] = [];
  for (const [index, file] of options.files.entries()) {
    let graphml: string;
    try {
      graphml = readFileSync(file, "utf8");
    } catch {
      console.error(`Could not read PageGraph input ${index + 1}.`);
      return 1;
    }
    // Source filenames can contain customer/site names. The exported join key
    // is deterministic by input order and reveals nothing about local paths.
    const pageId = `page-${String(index + 1).padStart(6, "0")}`;
    const facts = buildCorpusFacts(graphml, {
      pageId,
      registrableDomain: (host) => getDomain(host)
    });
    for (const warning of facts.warnings) {
      console.warn(`${pageId}: ${warning}`);
    }
    corpus.push(facts);
  }

  mkdirSync(options.out, { recursive: true });
  const exportFiles: Record<string, string> = {
    ...corpusFactsToCsvTables(corpus),
    "bootstrap.sql": DUCKDB_BOOTSTRAP_SQL,
    "query-rule-impact.sql": RULE_IMPACT_SQL,
    "query-cross-site-storage.sql": CROSS_SITE_STORAGE_SQL
  };

  // directly_blocked.csv always exists so bootstrap.sql loads unconditionally;
  // without --rule it is just the header (an empty seed set).
  let blockedCsv = "page_id,node_id\r\n";
  if (options.rule) {
    const matches = loadAdblockMatcher(options.rule);
    // Match against raw PageGraph URLs first; sanitize only the terminal
    // report. Redacting before the engine would change filter semantics.
    const rawReport = simulateRuleImpact(corpus, (request, page) => matches(request, page.url));
    const report = redactRuleImpactReportForExport(rawReport, corpus);
    for (const page of report.pages) {
      for (const blocked of page.directlyBlocked) {
        blockedCsv += `${page.pageId},${blocked.nodeId}\r\n`;
      }
    }
    exportFiles["impact-report.json"] = `${JSON.stringify(report, null, 2)}\n`;
    const { summary } = report;
    console.log(
      `Rule impact: ${summary.pagesAffected}/${summary.pagesAnalyzed} pages affected, ` +
        `${summary.directlyBlocked} directly blocked, ${summary.downstreamRequests} downstream requests reachable from the blocked set (upper bound), ` +
        `${summary.removedStorageOps} storage writes and ${summary.removedJsCalls} JS calls in that reachable set, ` +
        `${summary.breakageRiskPages} pages with first-party breakage risk.`
    );
  }
  exportFiles["directly_blocked.csv"] = blockedCsv;

  for (const [name, contents] of Object.entries(exportFiles)) {
    writeFileSync(path.join(options.out, name), contents);
  }
  const manifest = buildPageGraphExportManifest({
    files: exportFiles,
    generatedAt: new Date().toISOString(),
    pages: corpus.length
  });
  writeFileSync(path.join(options.out, "export-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `Wrote ${corpus.length} page${corpus.length === 1 ? "" : "s"} of sanitized corpus fact tables ` +
      "(load with: duckdb corpus.duckdb < bootstrap.sql)."
  );
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
