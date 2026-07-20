#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import {
  CANARY_CONFIRMATION,
  CANARY_ORIGIN,
  assertHealthGate,
  assertPanel,
  assertPanelCatalogMembership,
  buildReceipt,
  canonicalJson,
  compareReceipts,
  extractCapturedRun,
  requireAccessToken,
  requireCanaryOrigin,
  requireCommitSha
} from "./toolchain-canary-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelPath = path.join(root, "scripts", "fixtures", "toolchain-canary-panel.json");
const schemaPath = path.join(root, "public", "schemas", "scan-report.v2.r2.schema.json");
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 180;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const AUTH_HEADER = "x-site-behavior-lab-access-token";

await main().catch((error) => fail(error instanceof Error ? error.message : "Toolchain canary failed."));

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "capture") return capture(parseFlags(argv, new Set(["expected-build", "out", "confirm", "order", "base-url"])));
  if (command === "compare") return compare(parseFlags(argv, new Set(["baseline", "candidate"])));
  throw new Error(`Usage: toolchain-canary.mjs capture --expected-build <sha> --out <file> --confirm ${CANARY_CONFIRMATION} --order forward|reverse | compare --baseline <file> --candidate <file>`);
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

  const { panel, panelDigest } = await loadPanel();
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
      runs.push(extractCapturedRun(saved.report, { reportId: saved.reportId, expectedBuild, panelCase, sequence, repetition, reportWireSha256: sha256(saved.wire) }));
    }
  }
  await readHealth(baseUrl, token, expectedBuild);
  const receipt = buildReceipt({ createdAt: new Date().toISOString(), expectedBuild, order, panel, panelDigest, runs });
  await writeFile(out, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`PASS wrote create-only local receipt ${out}`);
}

async function compare(flags) {
  const { panel, panelDigest } = await loadPanel();
  const baseline = await readLocalJson(required(flags, "baseline"));
  const candidate = await readLocalJson(required(flags, "candidate"));
  const result = compareReceipts(baseline, candidate, panel, panelDigest);
  for (const row of result.results) {
    if (!row.pass) console.error(`FAIL ${row.caseId}.${row.metric}: median ${row.baseline} -> ${row.candidate}; delta ${row.delta} > ${row.allowed}`);
  }
  if (!result.pass) throw new Error("Toolchain canary metric tolerances failed.");
  console.log(`PASS ${result.baselineBuild} -> ${result.candidateBuild}: all fixed-panel medians are within tolerance.`);
}

async function captureOne(input) {
  const submissionResponse = await request(`${input.baseUrl}/api/scan`, input.token, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ url: input.panelCase.url, device: "desktop", gpcEnabled: true, consentMode: "observe" })
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
  const wire = await response.text();
  if (Buffer.byteLength(wire) > MAX_REPORT_BYTES) throw new Error(`${label} exceeded the public report byte ceiling.`);
  try { return { value: JSON.parse(wire), wire }; } catch { throw new Error(`${label} returned invalid JSON.`); }
}

function queuedSubmission(value) {
  return value?.ok === true && value.status === "queued" && /^[0-9]{8}-[0-9a-f]{32}$/.test(value.jobId) && /^[0-9]{8}-[0-9a-f]{32}$/.test(value.reportId) && value.jobId !== value.reportId && value.statusPath === `/api/scans/${value.jobId}`;
}

async function loadPanel() {
  const panel = assertPanel(JSON.parse(await readFile(panelPath, "utf8")));
  const catalogs = {};
  for (const source of new Set(panel.cases.map((entry) => entry.catalog))) catalogs[source] = JSON.parse(await readFile(path.join(root, source), "utf8"));
  assertPanelCatalogMembership(panel, catalogs);
  return { panel, panelDigest: sha256(canonicalJson(panel)) };
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
