import { readFile } from "node:fs/promises";
import path from "node:path";
import { readManagedReport } from "./managed-report-reader";
import { parseTransparencyLog, verifyTransparencyLogChain } from "./publication-transparency-log";
import { REPORT_ID_PATTERN } from "./report-validation";
import { sha256Hex } from "./sha256";
import { readVerifyArtifactTextWithinLimit } from "./verify-published-report-fetch";

/**
 * One command that checks a published report end to end, for a reader who
 * does not trust us.
 *
 * The verification steps already existed, spread across docs/verify-a-report.md
 * as curl, shasum, a gh artifact download, and a Python snippet. That is a
 * procedure people read and do not run. The whole claim of this project is
 * that anyone can re-derive what it publishes, and a claim nobody exercises is
 * indistinguishable from one that does not hold.
 *
 * It deliberately reuses the production managed reader rather than
 * reimplementing the checks. A second implementation would be a second
 * contract, free to disagree with the one that actually serves reports, and
 * the disagreement would surface as a reader being told their correct report
 * is invalid.
 *
 * What it proves is bounded, and the output says so. Bytes matching their
 * published digests says these are the bytes we published. It says nothing
 * about whether those bytes describe what the site did, which is a
 * methodology question, nor does it cover the Sigstore attestation over CI
 * evidence, which needs the gh CLI and stays a separate documented step.
 *
 * Node-only CLI: never imported by app, worker, or browser code.
 */

const DEFAULT_ORIGIN = "https://sitebehavior.org";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 32 * 1024 * 1024;

type Source =
  | { readonly kind: "origin"; readonly origin: string }
  | { readonly kind: "directory"; readonly dir: string };

type Options = {
  readonly reportId: string;
  readonly source: Source;
};

type Check = { readonly ok: boolean; readonly label: string; readonly detail: string };

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const checks: Check[] = [];

  const reportWire = await readArtifact(options.source, `${options.reportId}.json`);
  checks.push({
    ok: true,
    label: "report bytes read",
    detail: `${new TextEncoder().encode(reportWire).byteLength} bytes`
  });

  const sidecarWire = await readArtifact(options.source, `${options.reportId}.provenance.json`);
  checks.push({ ok: true, label: "provenance sidecar read", detail: "present" });

  // The manifest is an independent statement about the same bytes, so a
  // report that matches its own sidecar but not the published index is still
  // a mismatch worth surfacing.
  const wireDigest = sha256Hex(reportWire);
  const manifestDigest = await publishedWireDigest(options.source, options.reportId);
  if (manifestDigest.kind === "absent" && options.source.kind === "directory") {
    // docs/evidence-custody.md tells a reader to save the report and its
    // sidecar and re-verify them later with --from. It never tells them to save
    // reports/index.json, and the printed footer does not either, so failing
    // here made the documented custody workflow report NOT VERIFIED on an
    // untampered pair. Absent is "not checked"; a manifest that IS present and
    // disagrees still fails below.
    checks.push({
      ok: true,
      label: "wire digest vs published index",
      detail: "not checked: no reports/index.json in this directory"
    });
  } else if (manifestDigest.kind === "absent" || manifestDigest.digest === null) {
    // Either the origin served no manifest, or a manifest that exists does not
    // list this report. Both are reportable: an id missing from a manifest that
    // IS present stays a failure even in directory mode.
    checks.push({
      ok: false,
      label: "wire digest vs published index",
      detail: "this report id is not listed in reports/index.json"
    });
  } else {
    const listed = manifestDigest.digest;
    checks.push({
      ok: listed === wireDigest,
      label: "wire digest vs published index",
      detail: listed === wireDigest ? wireDigest : `index says ${listed}, these bytes are ${wireDigest}`
    });
  }

  const sidecar = parseSidecar(sidecarWire);
  const managed = readManagedReport({
    reportId: options.reportId,
    reportContents: reportWire,
    sidecarContents: sidecarWire,
    retention: sidecar ? { createdAt: sidecar.createdAt, expiresAt: null } : null
  });

  if (managed.ok) {
    checks.push({
      ok: true,
      label: "canonical digest vs sidecar",
      detail: `${sidecar?.publicDigest ?? "matched"} (${sidecar?.canonicalizationVersion ?? "canonical"})`
    });
    checks.push({
      ok: true,
      label: "schema and redaction validity",
      detail: `readable as published, redaction v${sidecar?.redactionVersion ?? "?"}`
    });
  } else {
    checks.push({
      ok: false,
      label: "managed report validation",
      detail: `${managed.reason}${managed.violations?.length ? `: ${managed.violations[0]}` : ""}`
    });
  }

  // The four checks above all read from ONE origin. A reader who does not trust
  // the operator gains nothing from them alone: the sidecar's publicDigest and
  // the manifest's reportWireSha256 are both derived from whatever bytes that
  // origin chose to serve, so they are trivially made mutually consistent.
  //
  // The append-only transparency log committed in this clone is the independent
  // statement. It is a plain local file read: no network, and the reader is
  // already running this from a checkout of the repository.
  const chained = await transparencyChainCheck(options.reportId, wireDigest);
  checks.push(chained.check);

  report(options, checks, chained.independent);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

/**
 * Cross-check the computed wire digest against the committed transparency log.
 *
 * Three outcomes, and the middle one matters most: an id the chain never
 * recorded is NOT a failure (a share-store report or one newer than this
 * clone), but it does mean provenance is unproven, so the verdict must stop
 * claiming it.
 */
async function transparencyChainCheck(
  reportId: string,
  wireDigest: string
): Promise<{ check: Check; independent: boolean }> {
  const label = "wire digest vs transparency log";
  let raw: string;
  try {
    raw = await readFile(path.join(process.cwd(), "public", "transparency-log.json"), "utf8");
  } catch {
    return {
      check: { ok: true, label, detail: "not checked: no public/transparency-log.json in this working directory" },
      independent: false
    };
  }

  let log: ReturnType<typeof parseTransparencyLog>;
  try {
    log = parseTransparencyLog(JSON.parse(raw));
    verifyTransparencyLogChain(log);
  } catch (error) {
    return {
      check: { ok: false, label, detail: `the committed log is unusable: ${(error as Error).message}` },
      independent: false
    };
  }

  const entry = log.entries.find((candidate) => candidate.reportId === reportId);
  if (!entry) {
    return {
      check: { ok: true, label, detail: "not checked: this id is not in the committed chain" },
      independent: false
    };
  }
  if (entry.reportWireSha256 !== wireDigest) {
    return {
      check: {
        ok: false,
        label,
        detail: `the chain recorded ${entry.reportWireSha256}, these bytes are ${wireDigest}`
      },
      independent: false
    };
  }
  return {
    check: { ok: true, label, detail: `entry ${entry.sequence} of ${log.entries.length}` },
    independent: true
  };
}

function report(options: Options, checks: readonly Check[], independent: boolean): void {
  const where = options.source.kind === "origin" ? options.source.origin : options.source.dir;
  console.log(`\nVerifying ${options.reportId} from ${where}\n`);
  for (const check of checks) {
    console.log(`  ${check.ok ? "ok  " : "FAIL"}  ${check.label.padEnd(32)} ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0 && independent) {
    console.log(
      "\nVerified: these bytes are exactly what this project published for this report,\n" +
        "they are internally consistent with their own provenance sidecar, and the\n" +
        "append-only transparency log in this clone records the same digest.\n"
    );
  } else if (failed.length === 0) {
    // Every check passed, but all of them read from the same origin. Saying
    // "exactly what this project published" here would assert provenance from
    // self-consistency, which is precisely what a reader who does not trust the
    // operator cannot rely on.
    console.log(
      `\nConsistent: these bytes agree with the provenance sidecar and manifest served by\n` +
        `${options.source.kind === "origin" ? options.source.origin : options.source.dir}. ` +
        `Provenance is NOT established: see the boundary below.\n`
    );
  } else {
    console.log(`\nNOT VERIFIED: ${failed.length} check${failed.length === 1 ? "" : "s"} failed.\n`);
  }

  // Stating the boundary is part of the result. A verifier that prints only
  // "verified" invites the reading that everything about the report is
  // settled, which is the exact overclaim this project exists to avoid.
  console.log("This command does not prove:");
  console.log("  - that the published bytes describe what the site actually did.");
  console.log("    That is a methodology question: https://sitebehavior.org/methodology/");
  console.log("  - Sigstore attestation over the CI evidence manifest.");
  console.log("    That needs the gh CLI; see docs/verify-a-report.md step 3.");
  // The transparency log binds the report bytes and the canonical digest, not
  // the sidecar. Its createdAt/writtenAt are copied from the sidecar into the
  // reader's own retention input, so a rewritten publication date verifies
  // against itself. Say so, or a green verdict reads as covering the clock.
  console.log("  - the sidecar's own timestamps (createdAt, writtenAt).");
  console.log("    The transparency log covers the report bytes and the canonical digest only;");
  console.log("    the sidecar bytes are bound only by the CI evidence manifest (steps 2 to 4 of that doc).");
  if (!independent) {
    console.log("  - that the origin serving these bytes is the one that published them.");
    console.log("    Nothing above cross-checked an independent record; run this from a");
    console.log("    clone whose public/transparency-log.json contains this report id.");
  }
  console.log("  - anything about behavior this scanner does not measure.");
  console.log("    The published boundary: https://sitebehavior.org/catalog/#coverage-boundary\n");
}

function parseArgs(argv: readonly string[]): Options {
  let reportId: string | undefined;
  let origin = DEFAULT_ORIGIN;
  let dir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from") {
      dir = argv[index + 1];
      index += 1;
    } else if (arg === "--origin") {
      origin = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}. Usage: verify:report -- <report-id> [--origin <url> | --from <dir>]`);
    } else if (reportId === undefined) {
      reportId = arg;
    } else {
      throw new Error("Provide exactly one report id.");
    }
  }

  if (reportId === undefined) {
    throw new Error("Usage: npm run verify:report -- <report-id> [--origin <url> | --from <dir>]");
  }
  // Accept a full report URL for convenience: it is what a reader has in hand.
  const fromUrl = /\/reports\/([0-9]{8}-[0-9a-f]{32})(?:\.json)?\/?$/.exec(reportId);
  if (fromUrl) reportId = fromUrl[1];
  if (!REPORT_ID_PATTERN.test(reportId)) {
    throw new Error(`"${reportId}" is not a report id (expected YYYYMMDD-<32 hex>).`);
  }

  if (dir !== undefined) return { reportId, source: { kind: "directory", dir } };

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`--origin must be an absolute URL, got "${origin}".`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("--origin must be https, or a localhost address for testing.");
  }
  return { reportId, source: { kind: "origin", origin: parsed.origin } };
}

async function readArtifact(source: Source, filename: string): Promise<string> {
  if (source.kind === "directory") {
    try {
      return await readFile(path.join(source.dir, filename), "utf8");
    } catch {
      throw new Error(`Cannot read ${filename} in ${source.dir}.`);
    }
  }
  return fetchText(`${source.origin}/reports/${filename}`);
}

/**
 * `absent` means no manifest was readable at all; `null` inside `present` means
 * a manifest exists and does not list this id. Collapsing those two into one
 * value made a saved-evidence directory with NO index indistinguishable from a
 * manifest that omits the report, so treating the first as "not checked" would
 * have silently accepted the second.
 */
type ManifestLookup = { readonly kind: "absent" } | { readonly kind: "present"; readonly digest: string | null };

async function publishedWireDigest(source: Source, reportId: string): Promise<ManifestLookup> {
  let wire: string;
  try {
    wire =
      source.kind === "directory"
        ? await readFile(path.join(source.dir, "index.json"), "utf8")
        : await fetchText(`${source.origin}/reports/index.json`);
  } catch {
    return { kind: "absent" };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(wire) as unknown;
  } catch {
    return { kind: "present", digest: null };
  }
  const reports = (manifest as { reports?: unknown }).reports;
  if (!Array.isArray(reports)) return { kind: "present", digest: null };
  for (const entry of reports) {
    const row = entry as { id?: unknown; reportWireSha256?: unknown };
    if (row.id === reportId && typeof row.reportWireSha256 === "string") {
      return { kind: "present", digest: row.reportWireSha256 };
    }
  }
  // A manifest that IS readable but does not list this id.
  return { kind: "present", digest: null };
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
    return await readVerifyArtifactTextWithinLimit(response, url, MAX_FETCH_BYTES);
  } finally {
    clearTimeout(timer);
  }
}

function parseSidecar(
  wire: string
): { createdAt: string; publicDigest: string; canonicalizationVersion: string; redactionVersion: number } | null {
  try {
    const value = JSON.parse(wire) as Record<string, unknown>;
    if (
      typeof value.createdAt === "string" &&
      typeof value.publicDigest === "string" &&
      typeof value.canonicalizationVersion === "string" &&
      typeof value.redactionVersion === "number"
    ) {
      return {
        createdAt: value.createdAt,
        publicDigest: value.publicDigest,
        canonicalizationVersion: value.canonicalizationVersion,
        redactionVersion: value.redactionVersion
      };
    }
  } catch {
    // The managed reader owns the authoritative refusal; this is display only.
  }
  return null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
