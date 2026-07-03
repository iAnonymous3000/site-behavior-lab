import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getDomain } from "tldts";
import {
  buildCorpusFacts,
  corpusFactsToCsvTables,
  CROSS_SITE_STORAGE_SQL,
  DUCKDB_BOOTSTRAP_SQL,
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
  for (const file of options.files) {
    const graphml = readFileSync(file, "utf8");
    const pageId = path.basename(file).replace(/\.graphml$/i, "");
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
  const tables = corpusFactsToCsvTables(corpus);
  for (const [name, csv] of Object.entries(tables)) {
    writeFileSync(path.join(options.out, name), csv);
  }
  writeFileSync(path.join(options.out, "bootstrap.sql"), DUCKDB_BOOTSTRAP_SQL);
  writeFileSync(path.join(options.out, "query-rule-impact.sql"), RULE_IMPACT_SQL);
  writeFileSync(path.join(options.out, "query-cross-site-storage.sql"), CROSS_SITE_STORAGE_SQL);

  // directly_blocked.csv always exists so bootstrap.sql loads unconditionally;
  // without --rule it is just the header (an empty seed set).
  let blockedCsv = "page_id,node_id\r\n";
  if (options.rule) {
    const matches = loadAdblockMatcher(options.rule);
    const report = simulateRuleImpact(corpus, (request, page) => matches(request, page.url));
    for (const page of report.pages) {
      for (const blocked of page.directlyBlocked) {
        blockedCsv += `${page.pageId},${blocked.nodeId}\r\n`;
      }
    }
    writeFileSync(path.join(options.out, "impact-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    const { summary } = report;
    console.log(
      `Rule impact of ${JSON.stringify(options.rule)}: ${summary.pagesAffected}/${summary.pagesAnalyzed} pages affected, ` +
        `${summary.directlyBlocked} directly blocked, ${summary.downstreamRequests} downstream requests, ` +
        `${summary.removedStorageOps} storage writes and ${summary.removedJsCalls} JS calls removed, ` +
        `${summary.breakageRiskPages} pages with first-party breakage risk.`
    );
  }
  writeFileSync(path.join(options.out, "directly_blocked.csv"), blockedCsv);

  console.log(
    `Wrote ${corpus.length} page${corpus.length === 1 ? "" : "s"} of corpus fact tables to ${options.out} ` +
      "(load with: duckdb corpus.duckdb < bootstrap.sql)."
  );
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
