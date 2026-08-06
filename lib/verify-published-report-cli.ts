import { readFile } from "node:fs/promises";
import path from "node:path";
import { readManagedReport } from "./managed-report-reader";
import { REPORT_ID_PATTERN } from "./report-validation";
import { sha256Hex } from "./sha256";

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
  if (manifestDigest === null) {
    checks.push({
      ok: false,
      label: "wire digest vs published index",
      detail: "this report id is not listed in reports/index.json"
    });
  } else {
    checks.push({
      ok: manifestDigest === wireDigest,
      label: "wire digest vs published index",
      detail: manifestDigest === wireDigest ? wireDigest : `index says ${manifestDigest}, these bytes are ${wireDigest}`
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

  report(options, checks);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

function report(options: Options, checks: readonly Check[]): void {
  const where = options.source.kind === "origin" ? options.source.origin : options.source.dir;
  console.log(`\nVerifying ${options.reportId} from ${where}\n`);
  for (const check of checks) {
    console.log(`  ${check.ok ? "ok  " : "FAIL"}  ${check.label.padEnd(32)} ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) {
    console.log(
      "\nVerified: these bytes are exactly what this project published for this report,\n" +
        "and they are internally consistent with their own provenance sidecar.\n"
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

async function publishedWireDigest(source: Source, reportId: string): Promise<string | null> {
  let wire: string;
  try {
    wire =
      source.kind === "directory"
        ? await readFile(path.join(source.dir, "index.json"), "utf8")
        : await fetchText(`${source.origin}/reports/index.json`);
  } catch {
    return null;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(wire) as unknown;
  } catch {
    return null;
  }
  const reports = (manifest as { reports?: unknown }).reports;
  if (!Array.isArray(reports)) return null;
  for (const entry of reports) {
    const row = entry as { id?: unknown; reportWireSha256?: unknown };
    if (row.id === reportId && typeof row.reportWireSha256 === "string") return row.reportWireSha256;
  }
  return null;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
      throw new Error(`${url} declares ${declared} bytes, above the ${MAX_FETCH_BYTES} ceiling.`);
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_FETCH_BYTES) {
      throw new Error(`${url} exceeded the ${MAX_FETCH_BYTES} byte ceiling.`);
    }
    return text;
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
