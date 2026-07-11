import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inventoryV1Report, summarizeInventories, type ReportRemediationInventory } from "./remediation-inventory";
import { readStoredScanReport } from "./scan-report-reader";
import { REDACTION_ALLOWLISTS_VERSION, REDACTION_VERSION } from "./redaction-v2";

/**
 * DRY-RUN remediation inventory over the committed corpus (RFC 9.6 step 1:
 * audit first). Reads `public/reports/*.json`, computes what the v2
 * default-deny sanitizer WOULD change, prints the aggregate, and (with
 * `--out <file>`) writes the full per-report inventory including before/after
 * URL examples for operator review. NEVER writes to the corpus, the store, or
 * anything else; the remediation pass is a separate, later decision.
 *
 * The R2 share store is inventoried by the same pure analysis when that pass
 * is scheduled; this CLI deliberately touches only the local working tree so
 * it can run anywhere without credentials.
 */

const REPORT_FILE_PATTERN = /^([0-9]{8}-[0-9a-f]{32})\.json$/;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
  if (outIndex >= 0 && !outFile) {
    console.error("--out requires a file path");
    process.exitCode = 1;
    return;
  }

  const reportsDir = path.join(process.cwd(), "public", "reports");
  const files = (await readdir(reportsDir)).filter((file) => REPORT_FILE_PATTERN.test(file)).sort();

  const entries: ReportRemediationInventory[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const parsed: unknown = JSON.parse(await readFile(path.join(reportsDir, file), "utf8"));
    const read = readStoredScanReport(parsed);
    if (!read.ok) {
      skipped.push(`${file}: unreadable (${read.error})`);
      continue;
    }
    if (read.stored.schemaVersion !== 1) {
      // v2 reports were redacted by the v2 sanitizer at write time by
      // definition; the remediation inventory audits v1-era artifacts.
      skipped.push(`${file}: schemaVersion 2 (not a v1-era artifact)`);
      continue;
    }
    entries.push(inventoryV1Report(REPORT_FILE_PATTERN.exec(file)![1], read.stored.report));
  }

  const totals = summarizeInventories(entries);
  console.log(`Redaction v2 dry-run inventory (sanitizer v${REDACTION_VERSION}, allowlists ${REDACTION_ALLOWLISTS_VERSION})`);
  console.log(`Reports analyzed: ${totals.reports} (${totals.changedReports} would change)${skipped.length ? `, skipped ${skipped.length}` : ""}`);
  console.log(`URL fields: ${totals.changedUrlFields.toLocaleString("en-US")} of ${totals.totalUrlFields.toLocaleString("en-US")} would change`);
  console.log(
    `Would generalize: ${totals.counters.pathSegmentsGeneralized.toLocaleString("en-US")} path segments, ` +
      `${totals.counters.subdomainLabelsGeneralized.toLocaleString("en-US")} subdomain labels, ` +
      `${totals.counters.queryKeysRedacted.toLocaleString("en-US")} query keys, ` +
      `${totals.counters.matrixParamsStripped.toLocaleString("en-US")} matrix params, ` +
      `${totals.counters.malformedUrlsDropped.toLocaleString("en-US")} malformed URLs`
  );
  console.log(
    `Names: ${totals.cookieNames.wouldRedact.toLocaleString("en-US")} of ${totals.cookieNames.total.toLocaleString("en-US")} cookie names, ` +
      `${totals.storageKeys.wouldRedact.toLocaleString("en-US")} of ${totals.storageKeys.total.toLocaleString("en-US")} storage keys would redact`
  );
  console.log(
    `Risk signals (RFC 9.6 step-2 audit basis): ${totals.riskSignals.emailLikeStrings} email-like strings, ` +
      `${totals.riskSignals.tokenLikePathSegments.toLocaleString("en-US")} token-shaped path segments, ` +
      `${totals.riskSignals.tokenLikeSubdomainLabels.toLocaleString("en-US")} token-shaped subdomain labels`
  );
  for (const line of skipped) console.log(`Skipped ${line}`);

  if (outFile) {
    await writeFile(
      outFile,
      `${JSON.stringify({ redactionVersion: REDACTION_VERSION, allowlists: REDACTION_ALLOWLISTS_VERSION, generatedAt: new Date().toISOString(), totals, reports: entries }, null, 2)}\n`
    );
    console.log(`Full inventory (with before/after examples) written to ${outFile}. Operator artifact: contains stored URLs; do not commit.`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
