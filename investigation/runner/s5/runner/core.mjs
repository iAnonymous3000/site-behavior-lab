// One attempt, in a one-attempt container: the S5c runner. Both entries call runAttempt; what differs
// between them comes in through `world` (G-6): the fixture entry alone adds the scanner's test options
// and its stand-in, and this file names neither.
//
// The order, as the case machine and the record force it:
//  1. Ask for the token once, before the browser launches; keep it in memory only (D-8). A refusal
//     launches nothing, writes nothing and exits non-zero (B-5).
//  2. Start. A failed start is retried inside this process (attempt-start-retried), never by asking
//     for the token again: a second request revokes it (S5b).
//  3. capture-began, then source-recorded: the image's build commit and the identity digest checked
//     against the plan (O-4).
//  4. One scanner visit. A baseline carries an empty seam (D-3). An instrumented visit carries the hook
//     only: at pageReady a one-time listener for the first main-frame navigation commit, which starts
//     the recorder's observe (R-a); afterEnvelope waits for it, then runs inspect.
//  5. Only once the visit and the recorder both ended cleanly (B-3): capture-finished, each bundled
//     object stored (runner-object), one row per object, one instrument-recorded per instrument, the
//     outcome usable. Then the browser is closed and cleanup-confirmed written (D-5).
//  6. On a break (a page crash, a browser lost, an observation the page ended): no object, no row. The
//     outcome failed, cleanup-unconfirmed, the browser killed, exit non-zero (B-1 to B-3, D-4).
// Every write names the head the last answer gave (O-1). A conflict hands back the current head; the
// write is sent once more on it, and a second conflict ends the attempt.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { LABELS, labelInspectScripts, labelScripts } from "./labels.mjs";
import { findPortP2, pageTargetId, shellProcesses } from "./port-finder.mjs";
import { COMMANDS, recorderEnv, runRecorder } from "./recorder.mjs";

export const CAPTURE_RECORD_VERSION = "s5c-capture-record@1";
/** Instruments, by the slug each row and instrument record carries. */
export const INSTRUMENTS = Object.freeze({ scanner: "scanner", observe: "rea-observe", inspect: "rea-inspect", record: "runner" });
const MAX_START_TRIES = 3; // the first start and the machine's two retries (MAX_START_RETRIES = 2)
const AFTER_ENVELOPE_MS = 120_000;
const CLOSE_WAIT_MS = 10_000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const TOKEN = /^[0-9a-f]{64}$/;

export const EXIT = Object.freeze({ ok: 0, failed: 1, tokenRefused: 2, writeRefused: 3, broken: 4 });

/** Where the run is, for the progress file. Never a token, never script text. */
function progressOf(world) {
  return (event, detail = {}) => world.progress({ t: new Date().toISOString(), event, ...detail });
}

export async function runAttempt(world) {
  const { plan, client, build } = world;
  const progress = progressOf(world);
  const slot = plan.slot;

  // 1. The token, before anything starts.
  const handed = await client.token(plan.caseId, plan.attemptId);
  if (handed?.ok !== true || typeof handed.token !== "string" || !TOKEN.test(handed.token) || typeof handed.head !== "string") {
    progress("token-refused", { refusal: String(handed?.refusal ?? "malformed-answer").slice(0, 40) });
    return { exit: EXIT.tokenRefused, outcome: null };
  }
  const token = handed.token;
  let head = handed.head;
  const writes = [];

  const write = async (event) => {
    let answer = await client.write(plan.caseId, token, head, event);
    if (answer?.ok === false && answer.refusal === "conflict" && typeof answer.head === "string") {
      progress("write-conflict", { type: event.type });
      head = answer.head;
      answer = await client.write(plan.caseId, token, head, event);
    }
    writes.push({ type: event.type, ok: answer?.ok === true, refusal: answer?.ok === true ? null : String(answer?.refusal ?? "no-answer").slice(0, 40) });
    if (answer?.ok !== true || typeof answer.head !== "string") throw Object.assign(new Error(`write refused: ${event.type}`), { writeRefused: true });
    head = answer.head;
    return answer;
  };
  const store = async (bytes) => {
    const answer = await client.object(plan.caseId, token, bytes);
    const digest = sha256(bytes);
    if (answer?.ok !== true || answer.digest !== digest) throw Object.assign(new Error("object refused"), { writeRefused: true });
    return digest;
  };

  try {
    // 2. Start: the identity check (O-4) and the entry's own readiness, retried inside this process.
    if (plan.identity !== build.identityDigest) throw Object.assign(new Error("the plan's identity is not this image's"), { identity: true });
    for (let tries = 1; ; tries += 1) {
      try {
        await world.start?.(tries);
        break;
      } catch (error) {
        progress("start-failed", { tries, reason: String(error?.message ?? error).slice(0, 120) });
        if (tries >= MAX_START_TRIES) {
          // No browser was launched, so there is nothing left open to clean up.
          await write({ type: "attempt-finished", data: { slot, outcome: "failed", reason: "start-failed" } });
          await write({ type: "cleanup-confirmed", data: { slot } });
          return { exit: EXIT.failed, outcome: "failed", writes };
        }
        await write({ type: "attempt-start-retried", data: { slot } });
      }
    }

    // 3.
    await write({ type: "capture-began", data: { slot } });
    await write({ type: "source-recorded", data: { slot, commit: build.buildCommit, identity: build.identityDigest } });

    // 4.
    const visit = await runVisit(world, progress);

    // 6. A break: nothing stored, no row.
    if (visit.broken !== null) {
      progress("break", { reason: visit.broken });
      await write({ type: "attempt-finished", data: { slot, outcome: "failed", reason: visit.broken } });
      await write({ type: "cleanup-unconfirmed", data: { slot } });
      killBrowser();
      return { exit: EXIT.broken, outcome: "failed", writes, visit: visit.summary };
    }
    if (visit.failed !== null) {
      progress("visit-failed", { reason: visit.failed });
      await write({ type: "attempt-finished", data: { slot, outcome: "failed", reason: visit.failed } });
      const closed = await closeBrowser();
      await write({ type: closed ? "cleanup-confirmed" : "cleanup-unconfirmed", data: { slot } });
      return { exit: EXIT.failed, outcome: "failed", writes, visit: visit.summary };
    }

    // 5. Clean: capture-finished, then the objects, then a row for each, then the instrument records.
    await write({ type: "capture-finished", data: { slot } });
    const environment = environmentCheck(token);
    const objects = bundle(world, visit, environment);
    const rows = [];
    for (const object of objects) {
      const digest = await store(object.bytes);
      rows.push({ id: `${slot.toLowerCase()}-${object.instrument}`, slot, instrument: object.instrument, state: "present", window: object.window, limits: [], digest, observation: null });
    }
    for (const row of rows) await write({ type: "evidence-recorded", data: { row } });
    for (const object of objects) await write({ type: "instrument-recorded", data: { slot, instrument: object.instrument, completeness: "complete", reason: null } });
    await write({ type: "attempt-finished", data: { slot, outcome: "usable", reason: null } });
    const closed = await closeBrowser();
    await write({ type: closed ? "cleanup-confirmed" : "cleanup-unconfirmed", data: { slot } });
    return { exit: closed ? EXIT.ok : EXIT.failed, outcome: "usable", writes, visit: visit.summary, objects: objects.map((o) => ({ instrument: o.instrument, bytes: o.bytes.length })) };
  } catch (error) {
    progress("attempt-error", { writeRefused: error?.writeRefused === true, identity: error?.identity === true, message: String(error?.message ?? error).slice(0, 200) });
    killBrowser();
    return { exit: error?.writeRefused === true ? EXIT.writeRefused : EXIT.failed, outcome: null, writes };
  }
}

/** The scanner's visit, and in the instrumented arm the recorder. Returns what was seen, never throws. */
async function runVisit(world, progress) {
  const { plan, scanner } = world;
  const t0 = Date.now();
  const timeline = [];
  const at = (event, extra = {}) => { timeline.push({ ms: Date.now() - t0, event, ...extra }); progress(event, extra); };
  const seen = { crash: false, disconnected: false, navigationRequestAtMs: null, envelopeAtMs: null, p2: null, target: null, guardRefusals: 0 };
  const runs = { observe: null, inspect: null };
  let commitWork = null;
  let recorderGuard = null;

  const instrumented = plan.arm === "instrumented";
  const watch = (page) => {
    page.on("crash", () => { seen.crash = true; at("page-crash"); });
    page.context().browser()?.on("disconnected", () => { seen.disconnected = true; at("browser-disconnected"); });
    page.on("request", (request) => {
      if (seen.navigationRequestAtMs === null && request.isNavigationRequest() && request.frame() === page.mainFrame() && /^https?:/.test(request.url())) {
        seen.navigationRequestAtMs = Date.now();
        at("main-frame-navigation-request");
      }
    });
  };
  const startRecorder = async (page, name) => {
    const record = await runRecorder(name, {
      cdpPort: seen.p2.port, guardPort: recorderGuard.port, target: seen.target, origin: plan.origin, observeMs: plan.observeMs,
      browserExecutable: world.browserExecutable,
      onSpawn: () => at("recorder-spawned", { command: name })
    });
    at("recorder-ended", { command: name, exit: record.exit, signal: record.signal ?? null });
    return record;
  };

  let seam;
  if (world.withoutSeam === true) seam = undefined;
  else if (!instrumented) seam = {};
  else {
    seam = {
      pageReady: async (page) => {
        at("pageReady");
        watch(page);
        // R-a: only a one-time listener here; pageReady returns at once and blocks nothing.
        commitWork = new Promise((settle) => {
          let fired = false;
          const onNav = (frame) => {
            if (fired || frame !== page.mainFrame() || !/^https?:/.test(frame.url())) return;
            fired = true;
            page.off("framenavigated", onNav);
            at("main-frame-committed");
            (async () => {
              await world.atCommit?.(page);
              seen.p2 = findPortP2();
              at("p2", { port: seen.p2.port, error: seen.p2.error });
              if (seen.p2.port === null) return;
              seen.target = await pageTargetId(page);
              recorderGuard = await world.startRecorderGuard({ cdpPort: seen.p2.port, onRefusal: () => { seen.guardRefusals += 1; } });
              runs.observe = startRecorder(page, "observe");
            })().catch((e) => at("commit-work-error", { message: String(e?.message ?? e).slice(0, 200) })).finally(settle);
          };
          page.on("framenavigated", onNav);
        });
      },
      afterEnvelope: async () => {
        seen.envelopeAtMs = Date.now();
        at("afterEnvelope");
        if (commitWork) await commitWork;
        if (runs.observe) runs.observe = await runs.observe;
        if (runs.observe && runs.observe.exit === 0 && !seen.crash && !seen.disconnected) runs.inspect = await startRecorder(null, "inspect");
      },
      afterEnvelopeTimeoutMs: AFTER_ENVELOPE_MS
    };
  }

  let envelope = null;
  let visitError = null;
  const visitStartMs = Date.now();
  try {
    const options = { ...world.visitOptions, signal: AbortSignal.timeout(plan.visitDeadlineMs) };
    if (seam !== undefined) options.investigationSeam = seam;
    envelope = await scanner.scanSiteWithMeasurement(plan.payload, options);
    at("visit-resolved");
  } catch (error) {
    visitError = String(error?.message ?? error).slice(0, 300);
    at("visit-threw", { message: visitError });
  }
  const visitEndMs = Date.now();
  if (runs.observe && typeof runs.observe.then === "function") runs.observe = await runs.observe;
  recorderGuard?.close?.();

  const recorder = instrumented ? readRecorderRuns(world, runs) : null;
  const summary = { timeline, visitError, p2: seen.p2, recorder: recorder?.summary ?? null };
  let broken = null;
  if (seen.crash) broken = "page-crashed";
  else if (seen.disconnected) broken = "browser-lost";
  else if (recorder?.observationEnded) broken = "observation-ended";
  let failed = null;
  if (broken === null) {
    if (visitError !== null || envelope === null) failed = "visit-failed";
    else if (instrumented && !recorder.clean) failed = recorder.failure ?? "recorder-failed";
    else if (seen.guardRefusals > 0) failed = "recorder-request-refused";
  }
  return { broken, failed, envelope, runs, recorder, seen, timeline, visitStartMs, visitEndMs, t0, summary };
}

/**
 * The recorder's two runs as the 6.8.0 shapes read them (test 2). A failure object that says the
 * recorder could not confirm its cleanup, or that a budget refused what the page sent, is an
 * observation the page ended (D-4): a break.
 */
function readRecorderRuns(world, runs) {
  const { shapes } = world;
  const read = (run, reader, file) => {
    if (!run || run.refused) return { ran: false };
    let value = null;
    try { value = JSON.parse(run.stdout.toString("utf8")); } catch { return { ran: true, exit: run.exit, parsed: false }; }
    const view = reader(file, value);
    if (!shapes.isShapeRefusal(view)) return { ran: true, exit: run.exit, parsed: true, value, view };
    const failure = shapes.readRecorderFailure(file, value);
    return { ran: true, exit: run.exit, parsed: true, value, refusal: view, failure: shapes.isShapeRefusal(failure) ? null : failure };
  };
  const observe = read(runs.observe, shapes.readObserveOutput680, "observe.json");
  const inspect = read(runs.inspect, shapes.readInspectOutput680, "inspect.json");
  const failures = [observe.failure, inspect.failure].filter(Boolean);
  const observationEnded = failures.some((f) => f.outcome === "cleanup-unconfirmed" || f.outcome === "budget-refused") || (observe.view !== undefined && observe.view.cleanup !== "confirmed");
  const clean = observe.exit === 0 && observe.view !== undefined && observe.view.endReason === "window_elapsed" && observe.view.cleanup === "confirmed" && inspect.exit === 0 && inspect.view !== undefined;
  const failure = !observe.ran ? "recorder-not-started" : failures.length > 0 ? `recorder-${failures[0].outcome}` : clean ? null : "recorder-failed";
  const summary = {
    observe: runs.observe ? { exit: observe.exit ?? null, read: observe.view !== undefined, failure: observe.failure?.code ?? null, spawnedAtMs: runs.observe.spawnedAtMs ?? null, endedAtMs: runs.observe.endedAtMs ?? null } : null,
    inspect: runs.inspect ? { exit: inspect.exit ?? null, read: inspect.view !== undefined, failure: inspect.failure?.code ?? null, spawnedAtMs: runs.inspect.spawnedAtMs ?? null, endedAtMs: runs.inspect.endedAtMs ?? null } : null
  };
  return { observe, inspect, observationEnded, clean, failure, summary };
}

/** The bundled objects of a clean attempt, each with its instrument and its row's window. */
function bundle(world, visit, environment) {
  const { plan } = world;
  const objects = [];
  const json = (value) => Buffer.from(JSON.stringify(value), "utf8");
  objects.push({ instrument: INSTRUMENTS.scanner, bytes: json(JSON.parse(JSON.stringify(visit.envelope.result))), window: { clock: "wall", startMs: visit.visitStartMs, endMs: visit.visitEndMs } });
  let labels = null;
  if (plan.arm === "instrumented") {
    // Each recorder output is stored as the recorder wrote it, byte for byte (B-4, the Q-4 ruling).
    // Only what the runner writes of its own carries no script text: labels, digests, lengths, URLs.
    const context = { references: world.references, siteKey: world.siteKey, partyKey: world.partyKey };
    labels = { observe: labelScripts(visit.recorder.observe.value, context), inspect: labelInspectScripts(visit.recorder.inspect.value, context) };
    objects.push({ instrument: INSTRUMENTS.observe, bytes: visit.runs.observe.stdout, window: { clock: "wall", startMs: visit.recorder.observe.view.armedAtMs, endMs: visit.recorder.observe.view.endedAtMs } });
    objects.push({ instrument: INSTRUMENTS.inspect, bytes: visit.runs.inspect.stdout, window: { clock: "wall", startMs: visit.runs.inspect.spawnedAtMs, endMs: visit.runs.inspect.endedAtMs } });
  }
  objects.push({ instrument: INSTRUMENTS.record, bytes: json(captureRecord(world, visit, labels, environment)), window: { clock: null, note: "the-attempt" } });
  return objects;
}

/** The capture record (S5d answer 7): its own bundled object, with one row of its own. */
function captureRecord(world, visit, labels, environment) {
  const { plan } = world;
  const instrumented = plan.arm === "instrumented";
  const nav = visit.seen.navigationRequestAtMs;
  const env = visit.seen.envelopeAtMs;
  const rel = (ms) => (ms === null || ms === undefined ? null : { fromNavigationStartMs: nav === null ? null : ms - nav, fromEnvelopeMs: env === null ? null : ms - env });
  const observe = visit.runs.observe;
  const armedLine = observe?.progressLines?.find((l) => /armed/i.test(l.line)) ?? null;
  return {
    version: CAPTURE_RECORD_VERSION,
    attempt: { caseId: plan.caseId, attemptId: plan.attemptId, slot: plan.slot, arm: plan.arm },
    recorder: instrumented ? { release: world.build.recorderRelease, commands: Object.values(COMMANDS).map((c) => c.cli) } : null,
    times: {
      navigationStart: { atMs: nav, what: "the runner's clock when Playwright reported the main frame's navigation request" },
      envelope: { atMs: env, what: "the runner's clock when afterEnvelope was called" },
      // R-a as amended for a runner with no relay (Q-2): neither time is when the first message
      // reached the browser, and neither is called that.
      recorder: instrumented
        ? {
            "recorder started": { ...rel(observe?.spawnedAtMs ?? null), what: "the spawn of observe: a lower bound, since nothing it sends can precede it" },
            "recorder reported armed": armedLine === null ? { absent: true, what: "observe printed no armed line" } : { ...rel(armedLine.atMs), what: "the runner's clock when observe's own stderr line saying it armed arrived" }
          }
        : null
    },
    scope: { siteKey: world.siteKey, rule: "partyKey of the plan URL's host, as the scanner computes first party" },
    scripts: instrumented
      ? {
          referenceSetSha256: world.references.sha256,
          references: world.references.references.length,
          labels: LABELS,
          worlds: "the main frame's default world only: the recorder's sources exclude isolated worlds, Playwright's utility world among them",
          observe: labels.observe,
          inspect: labels.inspect
        }
      : null,
    domains: instrumented ? world.domains : null,
    logger: { wrappedApiNames: [], globalOrBindingNames: [], note: "S5c has no logger and adds none" },
    p2: visit.seen.p2,
    environment
  };
}

/** Test 7's reading: which environments held the token, and any credential-like names, by name only. */
function environmentCheck(token) {
  const CREDENTIAL = /(?:^|_)(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIALS?|AUTH)(?:_|$)|^(?:AWS|R2|CLOUDFLARE|CF)_/i;
  const processes = [];
  for (const proc of [{ pid: "self", kind: "runner" }, ...shellProcesses().map((p) => ({ pid: String(p.pid), kind: p.browser ? "browser" : "browser-child" }))]) {
    let text;
    try { text = readFileSync(`/proc/${proc.pid}/environ`, "utf8"); } catch (e) { processes.push({ kind: proc.kind, readable: false, error: String(e?.code ?? "error").slice(0, 20) }); continue; }
    const names = text.split("\0").filter(Boolean).map((pair) => pair.split("=")[0]);
    processes.push({ kind: proc.kind, readable: true, names: names.length, tokenPresent: text.includes(token), credentialNames: names.filter((n) => CREDENTIAL.test(n)) });
  }
  // /proc/self/environ holds only the environment the process started with; a value set later in
  // process.env (which every child the runner starts inherits unless given its own) is read here.
  const ownNames = Object.keys(process.env);
  processes.push({ kind: "runner-now", readable: true, names: ownNames.length, tokenPresent: Object.values(process.env).some((v) => typeof v === "string" && v.includes(token)), credentialNames: ownNames.filter((n) => CREDENTIAL.test(n)) });
  const recorderNames = Object.keys(recorderEnv({ guardPort: 0, cdpPort: 0, browserExecutable: "" }));
  return { processes, recorderEnvironmentNames: recorderNames, recorderCredentialNames: recorderNames.filter((n) => CREDENTIAL.test(n)) };
}

/** Close the browser: SIGTERM to the browser process, then wait for every shell process to go. */
async function closeBrowser() {
  for (const p of shellProcesses().filter((p) => p.browser)) { try { process.kill(p.pid, "SIGTERM"); } catch {} }
  const until = Date.now() + CLOSE_WAIT_MS;
  while (Date.now() < until) {
    if (shellProcesses().length === 0) return true;
    await sleep(100);
  }
  killBrowser();
  return false;
}

function killBrowser() {
  for (const p of shellProcesses()) { try { process.kill(p.pid, "SIGKILL"); } catch {} }
}
