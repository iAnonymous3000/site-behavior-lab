#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import {
  CANARY_CONFIRMATION,
  CANARY_ORIGIN,
  COMMITTED_PANEL_DIRECTORY,
  assertCurrentPanelCommitted,
  assertHealthGate,
  assertPanel,
  assertPanelCatalogMembership,
  buildReceipt,
  compareReceipts,
  extractCapturedRun,
  panelDigest,
  readCommittedPanels,
  replayNotice,
  requireAccessToken,
  requireCanaryOrigin,
  requireCommitSha,
  selectComparisonPanel
} from "./toolchain-canary-lib.mjs";
import { prepareScanAdmission } from "./scan-admission.mjs";
import { readResponseTextWithinLimit } from "./http-response.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelPath = path.join(root, "scripts", "fixtures", "toolchain-canary-panel.json");
const committedPanelDirectory = path.join(root, ...COMMITTED_PANEL_DIRECTORY.split("/"));
const schemaPath = path.join(root, "public", "schemas", "scan-report.v2.r2.schema.json");
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 180;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const AUTH_HEADER = "x-site-behavior-lab-access-token";
// A replay starts every line it prints with REPLAY, and its result line says
// once more what it is, so no line of a replay can be quoted as a line of a
// release comparison.
const REPLAY_MARK = "REPLAY ";
const REPLAY_TAIL = "This is a replay on the panel named in the REPLAY line, not a release comparison.";
const COMPARE_FLAGS = new Set(["baseline", "candidate"]);

await main().catch((error) => fail(error instanceof Error ? error.message : "Toolchain canary failed."));

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "capture") return capture(parseFlags(argv, new Set(["expected-build", "out", "confirm", "order", "base-url"])));
  if (command === "compare") return compareOn(parseFlags(argv, COMPARE_FLAGS), false, "");
  if (command === "replay") return replay(argv);
  throw new Error(`Usage: toolchain-canary.mjs capture --expected-build <sha> --out <file> --confirm ${CANARY_CONFIRMATION} --order forward|reverse | compare --baseline <file> --candidate <file> | replay --baseline <file> --candidate <file>`);
}

async function capture(flags) {
  const baseUrl = requireCanaryOrigin(flags.get("base-url") ?? CANARY_ORIGIN);
  const expectedBuild = requireCommitSha(required(flags, "expected-build"));
  if (required(flags, "confirm") !== CANARY_CONFIRMATION) throw new Error(`--confirm must be exactly ${CANARY_CONFIRMATION}.`);
  const order = required(flags, "order");
  if (order !== "forward" && order !== "reverse") throw new Error("--order must be forward or reverse.");
  const token = requireAccessToken(process.env.TOOLCHAIN_CANARY_ACCESS_TOKEN);
  const out = path.resolve(required(flags, "out"));
  if (isInside(path.join(root, "public"), out)) throw new Error("Canary receipts must never be written under public/.");
  await assertCreateOnlyTarget(out);

  const { current } = await loadPanels();
  const panel = current.panel;
  const validateReport = await reportValidator();
  await readHealth(baseUrl, token, expectedBuild);
  const cases = order === "forward" ? panel.cases : [...panel.cases].reverse();
  const runs = [];
  let sequence = 0;
  for (const panelCase of cases) {
    for (let repetition = 1; repetition <= panel.repetitions; repetition += 1) {
      sequence += 1;
      console.log(`[${sequence}/${panel.cases.length * panel.repetitions}] ${panelCase.id} repetition ${repetition}`);
      const saved = await captureOne({ baseUrl, token, expectedBuild, panelCase, sequence, repetition });
      if (!validateReport(saved.report)) {
        const detail = (validateReport.errors ?? []).slice(0, 3).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
        throw new Error(`Saved report ${saved.reportId} failed the committed deep JSON Schema (${detail}).`);
      }
      runs.push(extractCapturedRun(saved.report, { reportId: saved.reportId, expectedBuild, order, panelCase, sequence, repetition, reportWireSha256: sha256(saved.wire) }));
    }
  }
  await readHealth(baseUrl, token, expectedBuild);
  const receipt = buildReceipt({ createdAt: new Date().toISOString(), expectedBuild, order, panel, panelDigest: current.digest, runs });
  await writeFile(out, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`PASS wrote create-only local receipt ${out}`);
}

// The compare command is the release comparison: it runs on the current panel
// and refuses a receipt captured on any other committed panel. The replay
// command reads two receipts against the committed panel they both carry. It
// prints which panel that is before anything else and marks every line it
// prints, a refusal included, so its output cannot pass for a release
// comparison. Its options are read inside the marked path too, so a replay
// that is refused for an option says so on a marked line.
async function replay(argv) {
  try {
    await compareOn(parseFlags(argv, COMPARE_FLAGS), true, REPLAY_MARK);
  } catch (error) {
    console.error(`${REPLAY_MARK}FAIL ${error instanceof Error ? error.message : "Toolchain canary failed."}`);
    process.exitCode = 1;
  }
}

async function compareOn(flags, replay, mark) {
  const out = (line) => console.log(`${mark}${line}`);
  const err = (line) => console.error(`${mark}${line}`);
  const { current, committed } = await loadPanels();
  const baseline = await readLocalJson(required(flags, "baseline"));
  const candidate = await readLocalJson(required(flags, "candidate"));
  const selection = selectComparisonPanel({ replay, baseline, candidate, current, committed });
  // The notice starts with the mark itself.
  if (replay) console.log(replayNotice(selection, current));
  const result = compareReceipts(baseline, candidate, selection.panel, selection.digest);
  const builds = `${result.baselineBuild} -> ${result.candidateBuild}`;
  // A comparison that reaches the medians names its rule first, so a verdict
  // on a median cannot be read as a result of the earlier rule, whose output
  // has no RULE line. A refusal above judged no median and prints none.
  out(`RULE ${result.rule}`);
  for (const row of result.results) {
    // A failure on separated ranges says what was seen, because it can stand
    // beside spreads that would otherwise make the metric inconclusive.
    if (row.outcome === "fail") err(`FAIL ${row.caseId}.${row.metric}: median ${row.baseline} -> ${row.candidate}; delta ${row.delta} > ${row.allowed}${row.separated ? `; every run of one build differs from every run of the other by more than the tolerance (the nearest two by ${row.separation}): baseline runs ${row.baselineValues.join(", ")}, candidate runs ${row.candidateValues.join(", ")}` : ""}`);
  }
  const inconclusive = result.results.filter((row) => row.outcome === "inconclusive");
  for (const row of inconclusive) {
    err(`INCONCLUSIVE ${row.caseId}.${row.metric}: baseline runs ${row.baselineValues.join(", ")} (spread ${row.baselineSpread}), candidate runs ${row.candidateValues.join(", ")} (spread ${row.candidateSpread}), tolerance ${row.allowed}; the page varied within one build by more than the tolerance, so medians ${row.baseline} -> ${row.candidate} say nothing about the toolchain for this metric`);
  }
  for (const row of result.excluded) {
    out(`LEFT OUT ${row.caseId}.${row.metric}: every run of both builds records ${row.family} capture loss`);
  }
  for (const row of result.noted) {
    out(`NOTED ${row.caseId}: ${row.signature} capture loss on ${row.baselineRuns} of ${row.baselineTotal} baseline and ${row.candidateRuns} of ${row.candidateTotal} candidate runs; recorded, not compared: its family feeds no canary metric`);
  }
  if (result.outcome === "fail") {
    if (!replay) throw new Error("Toolchain canary metric tolerances failed.");
    err(`FAIL ${builds}: ${result.results.filter((row) => row.outcome === "fail").length} of ${result.results.length} compared fixed-panel medians failed. ${REPLAY_TAIL}`);
    process.exitCode = 1;
    return;
  }
  if (result.outcome === "inconclusive") {
    // Exit 2 keeps this apart from a pass (0) and from a failure (1): nothing
    // failed, and the named metrics are no evidence for the toolchain or
    // against it, so a caller that reads only the status cannot take it for
    // either.
    err(`INCONCLUSIVE ${builds}: not a pass. No compared fixed-panel median failed, but for ${inconclusive.length} of ${result.results.length} the page varied within one build by more than the tolerance, so the comparison says nothing about the toolchain for ${inconclusive.map((row) => `${row.caseId}.${row.metric}`).join(", ")}. ${replay ? REPLAY_TAIL : "The release decision has to record each inconclusive metric by name with its values above."}`);
    process.exitCode = 2;
    return;
  }
  out(`PASS ${builds}: all ${result.results.length} compared fixed-panel medians are within tolerance${result.excluded.length ? `; ${result.excluded.length} left out for shared capture loss` : ""}${result.noted.length ? `; ${result.noted.length} capture-loss signature${result.noted.length === 1 ? "" : "s"} noted and not compared` : ""}.${replay ? ` ${REPLAY_TAIL}` : ""}`);
}

async function captureOne(input) {
  const admission = prepareScanAdmission({
    url: input.panelCase.url,
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });
  const submissionResponse = await request(`${input.baseUrl}/api/scan`, input.token, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...admission.headers },
    body: JSON.stringify(admission.body)
  });
  const submission = await json(submissionResponse, "/api/scan");
  if (submissionResponse.status !== 202 || !queuedSubmission(submission)) throw new Error(`/api/scan did not return the required 202 queued single scan (${submissionResponse.status}).`);
  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    const statusUrl = new URL(submission.statusPath, `${input.baseUrl}/`);
    if (statusUrl.origin !== input.baseUrl) throw new Error("Job status path escaped the canary origin.");
    const response = await request(statusUrl, input.token);
    const status = await json(response, "/api/scans/:id");
    if (!response.ok || status?.ok !== true) throw new Error("Canary job status read failed.");
    if (status.status === "succeeded") break;
    if (["failed", "expired", "cancelled"].includes(status.status)) throw new Error(`Canary job ${status.status}.`);
    if (poll === MAX_POLLS - 1) throw new Error("Canary job timed out.");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const reportId = submission.reportId;
  const reportResponse = await request(`${input.baseUrl}/api/reports/${reportId}`, input.token);
  const { value: report, wire } = await jsonWire(reportResponse, `/api/reports/${reportId}`);
  if (!reportResponse.ok) throw new Error(`Saved report read failed (${reportResponse.status}).`);
  return { reportId, report, wire };
}

async function readHealth(baseUrl, token, expectedBuild) {
  const response = await request(`${baseUrl}/api/health`, token);
  const health = await json(response, "/api/health");
  if (!response.ok) throw new Error(`Authenticated staging health returned ${response.status}.`);
  assertHealthGate(health, expectedBuild);
  return health;
}

async function request(url, token, init = {}) {
  try {
    return await fetch(url, {
      ...init,
      headers: { [AUTH_HEADER]: token, ...(init.headers ?? {}) },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new Error(`Request to ${new URL(url).pathname} failed.`);
  }
}

async function json(response, label) { return (await jsonWire(response, label)).value; }
async function jsonWire(response, label) {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new Error(`${label} returned non-JSON content.`);
  let wire;
  try {
    wire = await readResponseTextWithinLimit(response, { maxBytes: MAX_REPORT_BYTES, label });
  } catch (error) {
    if (error instanceof RangeError) throw new Error(`${label} exceeded the public report byte ceiling.`);
    throw error;
  }
  try { return { value: JSON.parse(wire), wire }; } catch { throw new Error(`${label} returned invalid JSON.`); }
}

function queuedSubmission(value) {
  return value?.ok === true && value.status === "queued" && /^[0-9]{8}-[0-9a-f]{32}$/.test(value.jobId) && /^[0-9]{8}-[0-9a-f]{32}$/.test(value.reportId) && value.jobId !== value.reportId && value.statusPath === `/api/scans/${value.jobId}`;
}

async function readCatalogs(cases) {
  const catalogs = {};
  for (const source of new Set(cases.map((entry) => entry.catalog))) catalogs[source] = JSON.parse(await readFile(path.join(root, source), "utf8"));
  return catalogs;
}

// The current panel, pinned in its catalogs, and every committed panel. Every
// command needs the current panel to be one of the committed ones: a receipt
// captured on a panel that is not kept there could not be replayed once the
// current panel file changes.
async function loadPanels() {
  const panel = assertPanel(JSON.parse(await readFile(panelPath, "utf8")));
  assertPanelCatalogMembership(panel, await readCatalogs(panel.cases));
  const current = { panel, digest: panelDigest(panel) };
  const files = [];
  for (const name of (await readdir(committedPanelDirectory)).sort()) files.push({ name, text: await readFile(path.join(committedPanelDirectory, name), "utf8") });
  const committed = readCommittedPanels(files);
  assertCurrentPanelCommitted(current, committed);
  return { current, committed };
}

async function reportValidator() {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  return new Ajv({ allErrors: true, strict: false }).compile(schema);
}

function parseFlags(argv, allowed) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith("--") ? argv[index].slice(2) : "";
    const value = argv[index + 1];
    if (!allowed.has(name) || !value || value.startsWith("--") || flags.has(name)) throw new Error(`Invalid or duplicate option ${argv[index] ?? ""}.`);
    flags.set(name, value);
  }
  return flags;
}
function required(flags, name) { const value = flags.get(name); if (!value) throw new Error(`Missing --${name}.`); return value; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function isInside(directory, target) { const relative = path.relative(directory, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
async function assertCreateOnlyTarget(target) { try { await access(target); throw new Error(`Refusing to overwrite existing receipt ${target}.`); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
async function readLocalJson(file) { return JSON.parse(await readFile(path.resolve(file), "utf8")); }
function fail(message) { console.error(`FAIL ${message}`); process.exitCode = 1; }
