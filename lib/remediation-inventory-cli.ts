import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { publicReportDigest } from "./canonical-json";
import {
  inventoryStoredReport,
  summarizeInventories,
  type ReportRemediationInventory
} from "./remediation-inventory";
import { readStoredScanReport } from "./scan-report-reader";
import {
  R2RedactionRemediationError,
  r2ReportRedactionVersion,
  redactPublicScanReportV2R2
} from "./scan-report-v2-r2-remediation";
import { REDACTION_ALLOWLISTS_VERSION, REDACTION_VERSION } from "./redaction-v2";

/**
 * DRY-RUN remediation inventory over the committed corpus (RFC 9.6 step 1:
 * audit first). Reads `public/reports/*.json`, computes what the v2
 * default-deny sanitizer changes in URLs and names/keys, prints the aggregate, and (with
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
  const r2 = { reports: 0, v3: 0, v4: 0, rewrites: 0, rejected: 0, policyQuoteIdentifiers: 0 };
  for (const file of files) {
    const parsed: unknown = JSON.parse(await readFile(path.join(reportsDir, file), "utf8"));
    const read = readStoredScanReport(parsed);
    if (!read.ok) {
      skipped.push(`${file}: unreadable (${read.error})`);
      continue;
    }
    // Which inventory a schema gets is decided by inventoryStoredReport, not
    // by the shape of this loop, so the routing can be tested directly instead
    // of inferred from control flow.
    const stored = read.stored;
    const inventoried = inventoryStoredReport(REPORT_FILE_PATTERN.exec(file)![1], stored);
    if (inventoried.schema === "unsupported") {
      skipped.push(
        `${file}: schemaVersion ${inventoried.schemaVersion} revision ${inventoried.schemaRevision} has no reviewed migration`
      );
      continue;
    }
    if (inventoried.schema === "v1") {
      entries.push(inventoried.entry);
      continue;
    }

    r2.reports += 1;
    r2.policyQuoteIdentifiers += inventoried.policyQuoteIdentifiers;
    // Re-narrowed for the remediation probes below. inventoryStoredReport has
    // already established this is schemaVersion 2 revision 2; this restates it
    // for the type system rather than asserting.
    if (stored.schemaVersion !== 2 || stored.schemaRevision !== 2) continue;
    try {
      const version = r2ReportRedactionVersion(stored.report);
      if (version === 3) r2.v3 += 1;
      if (version === REDACTION_VERSION) r2.v4 += 1;
      const redacted = redactPublicScanReportV2R2(stored.report);
      if (publicReportDigest(redacted) !== publicReportDigest(stored.report)) r2.rewrites += 1;
    } catch (error) {
      r2.rejected += 1;
      skipped.push(
        `${file}: schema-r2 remediation rejected (${error instanceof R2RedactionRemediationError ? error.reason : "unknown error"})`
      );
    }
  }

  const totals = summarizeInventories(entries);
  console.log(`Redaction dry-run inventory (sanitizer v${REDACTION_VERSION}, allowlists ${REDACTION_ALLOWLISTS_VERSION})`);
  console.log(`Reports analyzed: ${totals.reports}${skipped.length ? `, skipped ${skipped.length}` : ""}`);
  console.log(`Reports with URL or name/key changes: ${totals.reportsWithUrlOrNameChanges} (not a full-transform rewrite count)`);
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
      `${totals.riskSignals.unallowlistedSubdomainLabels.toLocaleString("en-US")} non-allowlisted subdomain labels generalized, ` +
      `${totals.riskSignals.policyQuoteIdentifiers} policy quotes carrying an identifier shape`
  );
  console.log(
    `Schema-r2: ${r2.reports} report(s), ${r2.v3} v3, ${r2.v4} v${REDACTION_VERSION}, ` +
      `${r2.rewrites} transform rewrite(s), ${r2.rejected} rejected, ` +
      `${r2.policyQuoteIdentifiers} policy quote(s) carrying an identifier shape. ` +
      `Use reports:remediate for sidecar/clock proof.`
  );
  for (const line of skipped) console.log(`Skipped ${line}`);

  if (outFile) {
    await writeFile(
      outFile,
      `${JSON.stringify({ redactionVersion: REDACTION_VERSION, allowlists: REDACTION_ALLOWLISTS_VERSION, generatedAt: new Date().toISOString(), totals, r2, reports: entries }, null, 2)}\n`
    );
    console.log(`Full inventory (with before/after examples) written to ${outFile}. Operator artifact: contains stored URLs; do not commit.`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
