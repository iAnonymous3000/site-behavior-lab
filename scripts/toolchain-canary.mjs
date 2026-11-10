#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
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
  assertQualificationApplies,
  assertQualificationPanel,
  assertQualificationPanelCatalogMembership,
  buildQualificationReceipt,
  buildReceipt,
  captureQualification,
  compareReceipts,
  extractCapturedRun,
  formatQualificationVerdict,
  judgeQualification,
  panelDigest,
  qualificationReceiptPath,
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
const qualificationPanelPath = path.join(root, "scripts", "fixtures", "toolchain-canary-qualification-panel.json");
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

// What is read again, and what is not. A health read that fails as a read
// (the request, the HTTP status, the JSON) is tried up to GET_TRIES times,
// GET_BACKOFF_MS apart. A status poll or a read of the saved report that
// fails is read again at the next poll, POLL_INTERVAL_MS later, inside the
// window of MAX_POLLS reads, so a failed read ends no scan before its window
// does. A submission is a POST and is never sent twice: a second submission
// would be a second visit to the site.
const GET_TRIES = 3;
const GET_BACKOFF_MS = Object.freeze([1_000, 2_000]);

// A scan that left no report to read, with which of the ways in JOB_FACTS
// (in the library) it ended. A comparison capture stops on it as on any other
// error. A qualifying capture records it against its run.
class ScanLeftNoReport extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// The answers to a submission that are taken to say the server queued no
// job: the request was not well formed (400, 413, 422), was not let in (401,
// 403), or was over a rate limit (429). No other answer is read that way. A
// 5xx status, or the 499 the Worker gives a request that ended during
// admission, does not say whether a job was queued: the Worker answers 503
// when a durable admission passes its deadline.
const SUBMISSION_REFUSAL_STATUSES = new Set([400, 401, 403, 413, 422, 429]);

class SubmissionRefused extends Error {}

await main().catch((error) => fail(error instanceof Error ? error.message : "Toolchain canary failed."));

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "capture") return capture(parseFlags(argv, new Set(["expected-build", "out", "confirm", "order", "base-url"])));
  if (command === "compare") return compareOn(parseFlags(argv, COMPARE_FLAGS), false, "");
  if (command === "replay") return replay(argv);
  if (command === "qualify") return qualify(parseFlags(argv, new Set(["expected-build", "confirm", "base-url"])));
  if (command === "verdict") return verdict(parseFlags(argv, new Set(["receipt", "panel-out"])));
  throw new Error(`Usage: toolchain-canary.mjs capture --expected-build <sha> --out <file> --confirm ${CANARY_CONFIRMATION} --order forward|reverse | compare --baseline <file> --candidate <file> | replay --baseline <file> --candidate <file> | qualify --expected-build <sha> --confirm ${CANARY_CONFIRMATION} | verdict [--receipt <file>] [--panel-out <file>]`);
}

// A comparison capture is whole or it is nothing. Its receipt file is opened,
// create-only, before the first request, so a path that cannot be written is
// found out before a scan is spent. It is empty until the one write at the
// end, and a capture that fails takes it away. A capture that is stopped from
// outside cannot: it leaves the empty file, which is no receipt and which the
// operator removes.
async function capture(flags) {
  const baseUrl = requireCanaryOrigin(flags.get("base-url") ?? CANARY_ORIGIN);
  const expectedBuild = requireCommitSha(required(flags, "expected-build"));
  if (required(flags, "confirm") !== CANARY_CONFIRMATION) throw new Error(`--confirm must be exactly ${CANARY_CONFIRMATION}.`);
  const order = required(flags, "order");
  if (order !== "forward" && order !== "reverse") throw new Error("--order must be forward or reverse.");
  const token = requireAccessToken(process.env.TOOLCHAIN_CANARY_ACCESS_TOKEN);
  const target = await realTarget(required(flags, "out"), "receipt");
  if (isInside(await publicDirectory(), target.real)) throw new Error("Canary receipts must never be written under public/.");
  const { current } = await loadPanels();
  const panel = current.panel;
  const validateReport = await reportValidator();
  const handle = await openCreateOnly(target, "receipt", 0o600);
  try {
    await readHealth(baseUrl, token, expectedBuild);
    const cases = order === "forward" ? panel.cases : [...panel.cases].reverse();
    const runs = [];
    let sequence = 0;
    for (const panelCase of cases) {
      for (let repetition = 1; repetition <= panel.repetitions; repetition += 1) {
        sequence += 1;
        console.log(`[${sequence}/${panel.cases.length * panel.repetitions}] ${panelCase.id} repetition ${repetition}`);
        const saved = await captureOne({ baseUrl, token, expectedBuild, panelCase, sequence, repetition });
        assertSchemaValid(validateReport, saved);
        runs.push(extractCapturedRun(saved.report, { reportId: saved.reportId, expectedBuild, order, panelCase, sequence, repetition, reportWireSha256: sha256(saved.wire) }));
      }
    }
    await readHealth(baseUrl, token, expectedBuild);
    const receipt = buildReceipt({ createdAt: new Date().toISOString(), expectedBuild, order, panel, panelDigest: current.digest, runs });
    await writeOnce(handle, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    await handle.close();
    await rm(target.real, { force: true });
    throw error;
  }
  await handle.close();
  console.log(`PASS wrote create-only local receipt ${target.given}`);
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

// The one qualifying capture of the committed qualification panel, on one
// build. It keeps the gates of a comparison capture: the confirmation string,
// the staging origin and token, the health gate against the expected build
// before the first scan, and the committed report schema.
//
// It differs in what it does once a scan has been submitted: nothing it has
// seen is thrown away. Its receipt goes to one fixed path, created empty and
// create-only before the first request, so a second capture for the same
// qualification panel is refused in this worktree while that file exists. A
// clone without the file is not held by it. The receipt is replaced whole
// before every scan and again after the last, marked as not finished, so
// each run is on disk before the next request. A scan that left no report,
// and a saved report that is not a complete observation, is recorded against
// its case and the capture goes on. A report that is not what the canary
// asked for, or a submission that is refused, ends the capture with its
// reason in the receipt. The health read after the last scan is recorded,
// pass or fail. The receipt is not a verdict: the verdict command reads it.
async function qualify(flags) {
  const baseUrl = requireCanaryOrigin(flags.get("base-url") ?? CANARY_ORIGIN);
  const expectedBuild = requireCommitSha(required(flags, "expected-build"));
  if (required(flags, "confirm") !== CANARY_CONFIRMATION) throw new Error(`--confirm must be exactly ${CANARY_CONFIRMATION}.`);
  const token = requireAccessToken(process.env.TOOLCHAIN_CANARY_ACCESS_TOKEN);
  const { current } = await loadPanels();
  const qualification = await loadQualificationPanel();
  // Before any scan: a capture the rule could not read would be spent for nothing.
  assertQualificationApplies(qualification.panel, current.panel);
  const validateReport = await reportValidator();
  const place = qualificationReceiptPath(qualification.panel);
  const target = await qualificationTarget(place);
  // The capture is taken by creating its receipt, empty: the open itself
  // refuses a file that is there. The file stays empty until the first
  // receipt is written, which is before the first scan is submitted, so an
  // empty receipt can only mean that no scan was submitted.
  await (await openCreateOnly(target, "qualification receipt", 0o600)).close();
  const total = qualification.panel.cases.length * qualification.panel.repetitions;
  const createdAt = new Date().toISOString();
  const write = (state) => replaceWhole(target.real, `${JSON.stringify(buildQualificationReceipt({ createdAt, expectedBuild, panel: qualification.panel, fromPanel: current.panel, ...state }), null, 2)}\n`, 0o600);
  // The command removes the file it created in two cases only, the two in
  // which nothing was spent: the health gate fails before the first scan, or
  // the server refuses the first submission. Then the capture has not been
  // used, and no file is left in the way of running it.
  const leaveNothing = async () => {
    await rm(target.real, { force: true });
    await rm(partialOf(target.real), { force: true });
    await rmdir(path.dirname(target.real)).catch(() => {});
  };
  try {
    await readHealth(baseUrl, token, expectedBuild);
  } catch (error) {
    await leaveNothing();
    throw new Error(`${error instanceof Error ? error.message : "The health read failed."} No scan was submitted and no receipt is kept: the qualifying capture has not been used.`);
  }
  // The capture is used from the first scan the server accepts, which is the
  // first job it acknowledges, not the first request sent. A first submission
  // that the server refuses spent nothing. A first submission that got no
  // answer at all is another matter and keeps its receipt: the request may
  // have reached the server and been accepted before the answer was lost, so
  // a scan may have run. The same holds for an answer that is neither an
  // acknowledged job nor one of the refusals above.
  let accepted = 0;
  let refusedBeforeAnyScan = null;
  const { runs, incompleteRuns, endedEarly } = await captureQualification({
    panel: qualification.panel,
    expectedBuild,
    log: (line) => console.log(line),
    // The receipt is on disk, with every scan so far, before the next scan is submitted.
    onProgress: (recorded) => write({ ...recorded, finished: false }),
    scanOne: async ({ panelCase, sequence, repetition }) => {
      let saved;
      try {
        saved = await captureOne({ baseUrl, token, expectedBuild, panelCase, sequence, repetition, onAccepted: () => { accepted += 1; } });
      } catch (error) {
        if (error instanceof ScanLeftNoReport) return { noReport: error.kind };
        if (error instanceof SubmissionRefused && accepted === 0) refusedBeforeAnyScan = error.message;
        throw error;
      }
      assertSchemaValid(validateReport, saved);
      return { reportId: saved.reportId, report: saved.report, reportWireSha256: sha256(saved.wire) };
    }
  });
  if (refusedBeforeAnyScan !== null) {
    await leaveNothing();
    throw new Error(`${refusedBeforeAnyScan} The server refused the first submission, so no scan was accepted and no receipt is kept: the qualifying capture has not been used.`);
  }
  const recorded = `${runs.length + incompleteRuns.length} of ${total} scans recorded`;
  if (endedEarly !== null) {
    await write({ runs, incompleteRuns, finished: false, endedEarly });
    console.error(`FAIL The qualifying capture did not finish: ${endedEarly} The receipt so far is ${place} (${recorded}). Commit and push it, and ask the owner. Do not run the capture again.`);
    process.exitCode = 1;
    return;
  }
  // The last scan is on disk before the health read that follows it, so a
  // command that is stopped during that read has lost no run.
  await write({ runs, incompleteRuns, finished: false });
  let healthAfter = { ok: true };
  try {
    await readHealth(baseUrl, token, expectedBuild);
  } catch (error) {
    healthAfter = { ok: false, reason: error instanceof Error ? error.message : "The health read failed." };
  }
  await write({ runs, incompleteRuns, finished: true, healthAfter });
  if (!healthAfter.ok) console.log(`HEALTH after the last scan did not pass and is recorded in the receipt: ${healthAfter.reason}`);
  console.log(`WROTE qualification receipt ${place}: ${runs.length} complete and ${incompleteRuns.length} incomplete runs, ${recorded}. Commit and push it now, whatever it holds, before anything else. It is not a verdict: read it with the verdict command.`);
}

// The verdict of the committed qualification rule on one qualification
// receipt: the committed one unless --receipt names another file. It exits 0
// whenever it reaches a verdict, whether or not the panel changes, and 1 when
// it refuses the receipt. It reads the committed panel the receipt names, not
// the current one, so it gives the same verdict after the next panel is
// current.
async function verdict(flags) {
  const { committed } = await loadPanels();
  const qualification = await loadQualificationPanel();
  const place = qualificationReceiptPath(qualification.panel);
  const receiptFile = flags.has("receipt") ? path.resolve(flags.get("receipt")) : path.join(root, ...place.split("/"));
  let text;
  try {
    text = await readFile(receiptFile, "utf8");
  } catch {
    throw new Error(`There is no qualification receipt to read at ${flags.has("receipt") ? receiptFile : place}.`);
  }
  // The capture creates its receipt empty and writes it first before its
  // first scan is submitted, so an empty receipt is one that nothing was
  // submitted for.
  if (text === "") throw new Error(`The qualification receipt at ${flags.has("receipt") ? receiptFile : place} is empty. The capture was stopped before its first scan was submitted, so it has not been used: remove the empty file.`);
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw new Error(`The qualification receipt at ${flags.has("receipt") ? receiptFile : place} is not JSON. If it is the committed receipt, do not repair it by hand: ask the owner.`);
  }
  const result = judgeQualification(receipt, { qualificationPanel: qualification.panel, committedPanels: committed });
  const lines = formatQualificationVerdict(result);
  if (!flags.has("panel-out")) {
    for (const line of lines) console.log(line);
    return;
  }
  if (result.panel === null) {
    for (const line of lines) console.log(line);
    console.log(`NOT WRITTEN ${path.resolve(flags.get("panel-out"))}: the panel does not change`);
    return;
  }
  // The next panel is written once, to a file that did not exist: the open
  // itself refuses a file that is there, so nothing is printed over a
  // refusal and nothing committed is overwritten.
  const target = await realTarget(flags.get("panel-out"), "panel file");
  if (isInside(await publicDirectory(), target.real)) throw new Error("A panel file must never be written under public/.");
  const handle = await openCreateOnly(target, "panel file", 0o644);
  try {
    await writeOnce(handle, result.panelText);
  } catch (error) {
    await handle.close();
    await rm(target.real, { force: true });
    throw error;
  }
  await handle.close();
  for (const line of lines) console.log(line);
  console.log(`WROTE ${target.given}`);
}

async function captureOne(input) {
  const admission = prepareScanAdmission({
    url: input.panelCase.url,
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });
  // The one request that is never repeated.
  const submissionResponse = await request(`${input.baseUrl}/api/scan`, input.token, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...admission.headers },
    body: JSON.stringify(admission.body)
  });
  if (SUBMISSION_REFUSAL_STATUSES.has(submissionResponse.status)) throw new SubmissionRefused(`/api/scan did not return the required 202 queued single scan (${submissionResponse.status}).`);
  const submission = await json(submissionResponse, "/api/scan");
  if (submissionResponse.status !== 202 || !queuedSubmission(submission)) throw new Error(`/api/scan did not return the required 202 queued single scan (${submissionResponse.status}).`);
  // The server has acknowledged a job: from here the scan counts as accepted.
  input.onAccepted?.();
  const statusUrl = new URL(submission.statusPath, `${input.baseUrl}/`);
  if (statusUrl.origin !== input.baseUrl) throw new Error("Job status path escaped the canary origin.");
  // The poll window is MAX_POLLS reads of the job status, POLL_INTERVAL_MS
  // apart. A read that fails is one of them, and the status is read again at
  // the next: the job may be running still. The scan is given up only when
  // the window ends, as unreadable if its last poll could not be read and as
  // timed out if it could.
  let succeeded = false;
  let lastPollRead = false;
  for (let poll = 0; poll < MAX_POLLS && !succeeded; poll += 1) {
    if (poll > 0) await sleep(POLL_INTERVAL_MS);
    const status = (await getJsonOnce(statusUrl, input.token, "/api/scans/:id", (response, value) => response.ok && value?.ok === true)).read?.value;
    lastPollRead = status !== undefined;
    if (status?.status === "failed") throw new ScanLeftNoReport("failed", "Canary job failed.");
    if (status?.status === "expired" || status?.status === "cancelled") throw new ScanLeftNoReport(status.status, `Canary job ${status.status}.`);
    succeeded = status?.status === "succeeded";
  }
  if (!succeeded) throw lastPollRead ? new ScanLeftNoReport("timedOut", "Canary job timed out.") : new ScanLeftNoReport("statusUnreadable", "Canary job status read failed.");
  // The saved report is read with the same patience, in a window of its own
  // of the same size: the job has succeeded, so the report is saved, and a
  // read that fails says only that it could not be read this time.
  const reportId = submission.reportId;
  let failure;
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    if (attempt > 0) await sleep(POLL_INTERVAL_MS);
    const saved = await getJsonOnce(`${input.baseUrl}/api/reports/${reportId}`, input.token, `/api/reports/${reportId}`);
    if (saved.read) return { reportId, report: saved.read.value, wire: saved.read.wire };
    failure = saved.failure;
  }
  throw new ScanLeftNoReport("reportUnreadable", `Saved report read failed: ${failure}`);
}

// One GET, read as JSON, once. It gives the value with its wire text, or why
// there is none: the request failed, the body is not JSON, or the answer is
// not one the caller accepts.
async function getJsonOnce(url, token, label, accepted = (response) => response.ok) {
  try {
    const response = await request(url, token);
    const read = await jsonWire(response, label);
    return accepted(response, read.value) ? { read } : { failure: `${label} returned ${response.status}.` };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : "no reason given" };
  }
}

// One health read: the GET, tried up to GET_TRIES times while the read itself
// fails (the request, the HTTP status, the JSON), and then the gate, applied
// once to the first health that was read. The gate is outside the retried
// part: a health that reports another build or a warning is the answer, and
// staging is not asked again in the hope of a better one.
async function readHealth(baseUrl, token, expectedBuild) {
  let failure;
  for (let attempt = 0; attempt < GET_TRIES; attempt += 1) {
    if (attempt > 0) await sleep(GET_BACKOFF_MS[attempt - 1]);
    let health;
    try {
      const response = await request(`${baseUrl}/api/health`, token);
      health = await json(response, "/api/health");
      if (!response.ok) throw new Error(`Authenticated staging health returned ${response.status}.`);
    } catch (error) {
      failure = error;
      continue;
    }
    return assertHealthGate(health, expectedBuild);
  }
  throw failure;
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

function assertSchemaValid(validateReport, saved) {
  if (validateReport(saved.report)) return;
  const detail = (validateReport.errors ?? []).slice(0, 3).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
  throw new Error(`Saved report ${saved.reportId} failed the committed deep JSON Schema (${detail}).`);
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

async function loadQualificationPanel() {
  const panel = assertQualificationPanel(JSON.parse(await readFile(qualificationPanelPath, "utf8")));
  assertQualificationPanelCatalogMembership(panel, await readCatalogs(panel.cases));
  return { panel, digest: panelDigest(panel) };
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
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

// Where a file the command is about to create really is: its directory with
// every symbolic link resolved, so a path that reaches public/ through a link,
// or through another name for the same directory, is judged as the place it
// is. A directory that does not exist is refused here, before anything is
// spent on a capture that could not be written.
async function realTarget(file, what) {
  const given = path.resolve(file);
  let directory;
  try {
    directory = await realpath(path.dirname(given));
  } catch {
    throw new Error(`The directory for the ${what} does not exist: ${path.dirname(given)}.`);
  }
  return { given, real: path.join(directory, path.basename(given)) };
}

async function publicDirectory() { return realpath(path.join(root, "public")); }

// The one place a qualification receipt may be: its fixed path inside this
// worktree. A link that leads anywhere else is refused, and each directory on
// the way is checked before the next is made, so nothing is created on the
// far side of such a link.
async function qualificationTarget(place) {
  const parts = place.split("/");
  const cannot = (code) => new Error(`Cannot create the directory for the qualification receipt ${place} (${code ?? "unknown error"}).`);
  let directory = await realpath(root);
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    let made = true;
    try {
      await mkdir(directory);
    } catch (error) {
      if (error?.code !== "EEXIST") throw cannot(error?.code);
      made = false;
    }
    if (made) continue;
    if ((await realpath(directory).catch(() => null)) !== directory) throw new Error(`The qualification receipt belongs at ${place} inside this worktree, and that path leads elsewhere.`);
    if (!(await stat(directory)).isDirectory()) throw cannot("EEXIST");
  }
  return { given: place, real: path.join(directory, parts.at(-1)) };
}

// The file is created by this open or not at all: an existing file, a
// dangling link included, is refused by the open itself, with no window
// between a check and the write.
async function openCreateOnly(target, what, mode) {
  try {
    return await open(target.real, "wx", mode);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Refusing to overwrite existing ${what} ${target.given}.`);
    throw new Error(`Cannot create the ${what} ${target.given} (${error?.code ?? "unknown error"}).`);
  }
}

// The one write of a file this command created empty: the whole text, however
// many writes that takes, and flushed.
async function writeOnce(handle, text) {
  await handle.writeFile(text, "utf8");
  await handle.sync();
}

// A file that is rewritten is replaced whole or not at all. The text goes to
// a sibling file, created by this write with the same mode, and is flushed
// there. The rename then puts it in the file's place in one step, so a write
// that is cut short leaves the file as it was. A sibling that an earlier
// command left when it was stopped is removed first, and one that this write
// could not finish is removed after: it is never read as the file.
function partialOf(file) { return `${file}.partial`; }
async function replaceWhole(file, text, mode) {
  const partial = partialOf(file);
  await rm(partial, { force: true });
  try {
    const handle = await open(partial, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
async function readLocalJson(file) { return JSON.parse(await readFile(path.resolve(file), "utf8")); }
function fail(message) { console.error(`FAIL ${message}`); process.exitCode = 1; }
