import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { replaceUtf8FileAtomically } from "./exact-atomic-file";
import {
  appendTransparencyLogEntries,
  assertTransparencyLogHistory,
  buildTransparencyLog,
  parseTransparencyLog,
  verifyTransparencyLogChain,
  type ParsedTransparencyLog,
  type TransparencyLogAddition
} from "./publication-transparency-log";
import { acquireReportCorpusLock } from "./report-corpus-lock";
import { TRANSPARENCY_LOG_JSON_MAX_BYTES } from "./report-resource-limits";
import { listStaticReportCandidateIds, readStaticReportBundle } from "./static-report-files";
import { sha256Hex } from "./sha256";

/**
 * Generates, checks, and history-gates the publication transparency log.
 *
 * The log is derived from the committed bundles themselves, deliberately NOT
 * from `public/reports/index.json`, even though the manifest already carries
 * `reportWireSha256`. Two independent derivations from the same ground truth
 * can be cross-checked against each other; a log copied out of the manifest
 * would inherit a manifest bug silently and prove nothing.
 *
 * Node-only CLI: never imported by app, worker, or browser code.
 */

const LOG_PATH = "public/transparency-log.json";
const MAX_GIT_BLOB_BYTES = 64 * 1024 * 1024;

type Mode = { readonly kind: "write" } | { readonly kind: "check" } | { readonly kind: "history"; readonly base: string };

async function main(): Promise<void> {
  const mode = parseMode();
  const rootDir = process.cwd();
  const logPath = path.join(rootDir, LOG_PATH);

  if (mode.kind === "history") {
    verifyHistory(rootDir, mode.base);
    return;
  }

  const reportsDir = path.join(rootDir, "public", "reports");
  const lock = await acquireReportCorpusLock(reportsDir, "publication-transparency-log");
  try {
    const existing = await readExistingLog(logPath);
    const published = await readPublishedBundles(reportsDir);
    const entries = appendTransparencyLogEntries(existing.entries, published.additions);
    const rebuilt = buildTransparencyLog(entries, existing.anchors);
    verifyTransparencyLogChain(rebuilt);
    assertPresentBundlesMatch(rebuilt, published.byReportId);

    const wire = `${JSON.stringify(rebuilt, null, 2)}\n`;
    if (mode.kind === "check") {
      const committed = await readFile(logPath, "utf8").catch(() => null);
      if (committed === null) {
        throw new Error(`${LOG_PATH} is missing; run \`npm run transparency:log\` and commit the result.`);
      }
      if (committed !== wire) {
        const added = rebuilt.entries.length - existing.entries.length;
        throw new Error(
          added > 0
            ? `${LOG_PATH} is stale: ${added} published report${added === 1 ? " is" : "s are"} not yet logged. Run \`npm run transparency:log\` and commit the result.`
            : `${LOG_PATH} does not match the committed corpus. Run \`npm run transparency:log\` and commit the result.`
        );
      }
      console.log(
        `Transparency log verified: ${rebuilt.entryCount} chained publication${rebuilt.entryCount === 1 ? "" : "s"}, ` +
          `head ${rebuilt.head ?? "(empty)"}, ${published.byReportId.size} present bundle${published.byReportId.size === 1 ? "" : "s"} re-derived, ` +
          `${rebuilt.anchors.length} external anchor${rebuilt.anchors.length === 1 ? "" : "s"}.`
      );
      return;
    }

    await replaceUtf8FileAtomically(logPath, wire, TRANSPARENCY_LOG_JSON_MAX_BYTES);
    const added = rebuilt.entries.length - existing.entries.length;
    console.log(
      `Transparency log written: ${rebuilt.entryCount} chained publication${rebuilt.entryCount === 1 ? "" : "s"} ` +
        `(${added} appended), head ${rebuilt.head ?? "(empty)"}.`
    );
  } finally {
    await lock.release();
  }
}

function parseMode(): Mode {
  const args = process.argv.slice(2);
  if (args.length === 0) return { kind: "write" };
  if (args[0] === "--check" && args.length === 1) return { kind: "check" };
  if (args[0] === "--verify-history" && args.length <= 2) {
    const base = args[1] ?? process.env.TRANSPARENCY_LOG_BASE_REVISION ?? "HEAD^";
    if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}^~+-]*$/.test(base)) {
      throw new Error("The Git base revision contains unsupported characters.");
    }
    return { kind: "history", base };
  }
  throw new Error("Usage: publication-transparency-log-cli [--check | --verify-history [base-revision]]");
}

async function readExistingLog(logPath: string): Promise<ParsedTransparencyLog> {
  const wire = await readFile(logPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (wire === null) return buildTransparencyLog([], []);

  let value: unknown;
  try {
    value = JSON.parse(wire) as unknown;
  } catch {
    throw new Error(`${LOG_PATH} is not valid JSON.`);
  }
  const parsed = parseTransparencyLog(value);
  // A corrupted chain must never be silently extended: appending onto a broken
  // prefix would bury the break under valid-looking new entries.
  verifyTransparencyLogChain(parsed);
  return parsed;
}

async function readPublishedBundles(reportsDir: string): Promise<{
  readonly additions: TransparencyLogAddition[];
  readonly byReportId: ReadonlyMap<string, TransparencyLogAddition>;
}> {
  const byReportId = new Map<string, TransparencyLogAddition>();
  // Sorted so the order new publications enter the chain is deterministic
  // across machines; existing entries keep their recorded order regardless.
  for (const id of (await listStaticReportCandidateIds(reportsDir)).slice().sort()) {
    const read = await readStaticReportBundle(reportsDir, id);
    if (read.outcome !== "found") {
      throw new Error(`Committed report ${id} is not a readable managed bundle; refusing to log an unverified publication.`);
    }
    byReportId.set(id, {
      reportId: id,
      reportWireSha256: sha256Hex(read.wire),
      publicDigest: read.provenance.publicDigest
    });
  }
  return { additions: [...byReportId.values()], byReportId };
}

/**
 * Entries outlive their reports by design, so absence is not a failure. What
 * is a failure is a report that is still committed under a digest the log
 * already recorded differently: that is a silent edit to published evidence.
 */
function assertPresentBundlesMatch(
  log: ParsedTransparencyLog,
  present: ReadonlyMap<string, TransparencyLogAddition>
): void {
  for (const entry of log.entries) {
    const bundle = present.get(entry.reportId);
    if (bundle === undefined) continue;
    if (bundle.reportWireSha256 !== entry.reportWireSha256) {
      throw new Error(
        `Committed report ${entry.reportId} has wire digest ${bundle.reportWireSha256} but the transparency log recorded ${entry.reportWireSha256}; published evidence cannot be edited.`
      );
    }
    if (bundle.publicDigest !== entry.publicDigest) {
      throw new Error(
        `Committed report ${entry.reportId} has canonical digest ${bundle.publicDigest} but the transparency log recorded ${entry.publicDigest}; published evidence cannot be edited.`
      );
    }
  }
}

function verifyHistory(rootDir: string, base: string): void {
  const currentWire = readFileSyncOrNull(path.join(rootDir, LOG_PATH));
  if (currentWire === null) throw new Error(`${LOG_PATH} is missing; refusing to verify an absent log.`);
  const currentValue = parseJson(currentWire, LOG_PATH);

  if (!gitObjectExists(`${base}^{commit}`)) {
    const current = parseTransparencyLog(currentValue);
    if (current.entries.length > 0 || gitObjectExists("HEAD^{commit}")) {
      throw new Error(`Git base revision ${base} is unavailable; refusing to verify because repository or log history exists.`);
    }
    console.log(`Transparency log initialized empty; base revision ${base} is unavailable.`);
    return;
  }

  const previousWire = gitBlobIfPresent(base, LOG_PATH);
  if (previousWire === null) {
    const current = parseTransparencyLog(currentValue);
    verifyTransparencyLogChain(current);
    console.log(
      `Transparency log introduced at this revision with ${current.entryCount} entr${current.entryCount === 1 ? "y" : "ies"}; ${LOG_PATH} is absent at ${base}.`
    );
    return;
  }

  const previousValue = parseJson(previousWire, `${base}:${LOG_PATH}`);
  assertTransparencyLogHistory(previousValue, currentValue);
  const previous = parseTransparencyLog(previousValue);
  const current = parseTransparencyLog(currentValue);
  console.log(
    `Transparency log history verified against ${base}: ${previous.entryCount} prior ` +
      `entr${previous.entryCount === 1 ? "y" : "ies"} unchanged, ${current.entryCount - previous.entryCount} appended.`
  );
}

function readFileSyncOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseJson(wire: string, label: string): unknown {
  try {
    return JSON.parse(wire) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function gitObjectExists(revision: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", revision]) !== null;
}

function gitBlobIfPresent(revision: string, filePath: string): string | null {
  return git(["show", `${revision}:${filePath}`]);
}

function git(args: readonly string[]): string | null {
  const result = spawnSync("git", [...args], { encoding: "utf8", maxBuffer: MAX_GIT_BLOB_BYTES });
  return result.status === 0 ? result.stdout : null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
