import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assertCorrectionsLedgerHistory,
  parseCorrectionsLedger,
  parsedCorrectionsLedgerPrivacyRemovedReportIds,
  parsedCorrectionsLedgerReportIds,
  type CorrectionsPinnedBundles,
  type ParsedCorrectionsLedger
} from "./corrections-ledger";
import { planPrivacyReplacement } from "./privacy-replacement";
import { readStoredScanReport } from "./scan-report-reader";

const root = process.cwd();
const ledgerPath = "public/corrections.json";
const maxGitBlobBytes = 64 * 1024 * 1024;

function main(): void {
  const base = baseRevision();
  const currentValue = parseJson(readFileSync(path.join(root, ledgerPath)), ledgerPath);
  const current = parseCorrectionsLedger(currentValue);

  if (!gitObjectExists(`${base}^{commit}`)) {
    if (current.entries.length > 0 || gitObjectExists("HEAD^{commit}")) {
      throw new Error(
        `Git base revision ${base} is unavailable; refusing to verify because repository or ledger history exists.`
      );
    }
    console.log(`Corrections history initialized with an empty ledger; base revision ${base} is unavailable.`);
    return;
  }

  const previousWire = gitBlobIfPresent(base, ledgerPath);
  if (previousWire === null) {
    if (current.entries.length > 0) {
      throw new Error(
        `${ledgerPath} is absent at Git base ${base}; refusing to verify a non-empty corrections history without its base.`
      );
    }
    console.log(`Corrections history initialized with an empty ledger; ${ledgerPath} is absent at ${base}.`);
    return;
  }

  const previousValue = parseJson(previousWire, `${base}:${ledgerPath}`);
  const previous = parseCorrectionsLedger(previousValue);
  const previousBundles = gitBundles(base, parsedCorrectionsLedgerReportIds(previous));
  const currentBundles = workingTreeBundles(
    parsedCorrectionsLedgerReportIds(current),
    parsedCorrectionsLedgerPrivacyRemovedReportIds(current)
  );

  assertCorrectionsLedgerHistory(previousValue, currentValue, previousBundles, currentBundles);
  assertPrivacyReplacementsAreRedactedCopies(base, previous, current, currentBundles);
  // After the gate passes, a base pin absent from the working tree can only be
  // an original that a privacy-superseded event removed.
  const removed = [...previousBundles.keys()].filter((reportId) => !currentBundles.has(reportId)).length;
  const unchanged = previousBundles.size - removed;
  console.log(
    `Corrections history verified against ${base}: ${previous.entries.length} prior ` +
      `event${previous.entries.length === 1 ? "" : "s"} and ${unchanged} pinned ` +
      `bundle${unchanged === 1 ? " is" : "s are"} unchanged` +
      (removed === 0 ? "." : `; ${removed} privacy-superseded bundle${removed === 1 ? " was" : "s were"} removed.`)
  );
}

/**
 * The ledger pairs each original with its replacement by position, and the
 * parser holds only that the two share a scan date. A privacy event appended
 * in this change must also name a replacement that IS its original's redacted
 * copy: the same creation clock, and exactly the bytes a privacy replacement
 * writes for the original at the base (lib/privacy-replacement.ts). Otherwise
 * a swapped pair, an unrelated report of the same day, or a copy that also
 * changed its findings would pass every other check. An event already in the
 * base was verified in the change that appended it.
 */
function assertPrivacyReplacementsAreRedactedCopies(
  base: string,
  previous: ParsedCorrectionsLedger,
  current: ParsedCorrectionsLedger,
  currentBundles: CorrectionsPinnedBundles
): void {
  for (const event of current.entries.slice(previous.entries.length)) {
    if (event.state !== "privacy-superseded") continue;
    for (const [position, originalId] of event.reportIds.entries()) {
      const replacementId = (event.replacementReportIds ?? [])[position];
      const replacement = currentBundles.get(replacementId);
      if (replacement === undefined) {
        throw new Error(`Privacy replacement ${replacementId} is missing its report or provenance sidecar bytes`);
      }
      const originalWire = requiredGitBlob(base, `public/reports/${originalId}.json`);
      const originalSidecar = requiredGitBlob(base, `public/reports/${originalId}.provenance.json`);
      const originalCreatedAt = sidecarCreatedAt(originalSidecar, `${base}:${originalId}.provenance.json`);
      if (sidecarCreatedAt(replacement.sidecar, `${replacementId}.provenance.json`) !== originalCreatedAt) {
        throw new Error(
          `Privacy replacement ${replacementId} does not keep the creation clock of ${originalId} (${originalCreatedAt})`
        );
      }
      const read = readStoredScanReport(parseJson(originalWire, `${base}:${originalId}.json`));
      if (!read.ok || read.stored.schemaVersion !== 1) {
        throw new Error(`${originalId} at ${base} is not a frozen v1 report, which is the only kind with a reviewed privacy replacement`);
      }
      if (Buffer.from(replacement.report).toString("utf8") !== planPrivacyReplacement(read.stored.report, replacementId).wire) {
        throw new Error(
          `Privacy replacement ${replacementId} is not the current redaction of ${originalId} with its share moved`
        );
      }
    }
  }
}

function sidecarCreatedAt(wire: Uint8Array, label: string): string {
  const sidecar = parseJson(wire, label);
  const createdAt = typeof sidecar === "object" && sidecar !== null
    ? (sidecar as { createdAt?: unknown }).createdAt
    : undefined;
  if (typeof createdAt !== "string") throw new Error(`${label} has no createdAt.`);
  return createdAt;
}

function baseRevision(): string {
  if (process.argv.length > 3) throw new Error("Usage: corrections-ledger-history-cli [base-revision]");
  const value = process.argv[2] ?? process.env.CORRECTIONS_BASE_REVISION ?? "HEAD^";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}^~+-]*$/.test(value)) {
    throw new Error("The Git base revision contains unsupported characters.");
  }
  return value;
}

function gitBundles(base: string, reportIds: ReadonlySet<string>): CorrectionsPinnedBundles {
  const bundles = new Map<string, { report: Uint8Array; sidecar: Uint8Array }>();
  for (const reportId of reportIds) {
    bundles.set(reportId, {
      report: requiredGitBlob(base, `public/reports/${reportId}.json`),
      sidecar: requiredGitBlob(base, `public/reports/${reportId}.provenance.json`)
    });
  }
  return bundles;
}

function workingTreeBundles(
  reportIds: ReadonlySet<string>,
  privacyRemovedReportIds: ReadonlySet<string>
): CorrectionsPinnedBundles {
  const bundles = new Map<string, { report: Uint8Array; sidecar: Uint8Array }>();
  for (const reportId of reportIds) bundles.set(reportId, workingTreeBundle(reportId));
  // A privacy-removed original is no longer pinned, but any bytes of it that
  // remain are read, so the gate refuses a changed or still-published original
  // instead of never seeing it. A half-removed bundle fails the read here.
  for (const reportId of privacyRemovedReportIds) {
    const bundlePaths = workingTreeBundlePaths(reportId);
    if (existsSync(bundlePaths.report) || existsSync(bundlePaths.sidecar)) {
      bundles.set(reportId, workingTreeBundle(reportId));
    }
  }
  return bundles;
}

function workingTreeBundle(reportId: string): { report: Uint8Array; sidecar: Uint8Array } {
  const bundlePaths = workingTreeBundlePaths(reportId);
  return { report: readFileSync(bundlePaths.report), sidecar: readFileSync(bundlePaths.sidecar) };
}

function workingTreeBundlePaths(reportId: string): { report: string; sidecar: string } {
  return {
    report: path.join(root, "public", "reports", `${reportId}.json`),
    sidecar: path.join(root, "public", "reports", `${reportId}.provenance.json`)
  };
}

function requiredGitBlob(base: string, repoPath: string): Uint8Array {
  const value = gitBlobIfPresent(base, repoPath);
  if (value === null) throw new Error(`Correction-linked artifact ${base}:${repoPath} is unavailable.`);
  return value;
}

function gitBlobIfPresent(base: string, repoPath: string): Buffer | null {
  if (!gitObjectExists(`${base}:${repoPath}`)) return null;
  const result = runGit(["show", `${base}:${repoPath}`]);
  if (result.status !== 0) {
    throw new Error(`Cannot read ${base}:${repoPath}: ${gitError(result.stderr)}`);
  }
  return result.stdout;
}

function gitObjectExists(object: string): boolean {
  return runGit(["cat-file", "-e", object]).status === 0;
}

function runGit(args: string[]) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: maxGitBlobBytes
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0)
  };
}

function parseJson(wire: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(wire).toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function gitError(stderr: Uint8Array): string {
  return Buffer.from(stderr).toString("utf8").trim() || "unknown Git error";
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
