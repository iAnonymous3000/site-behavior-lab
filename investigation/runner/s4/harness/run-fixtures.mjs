// S4 fixture driver. Runs on the base's Node inside the runner container; the recorder runs on the
// second Node. Two phases:
//   schema   : `rea --version` and `rea <command> --schema --json` for each website command. No browser.
//   fixtures : the plan in /in/plan.json (read-only input), against the fixture origin on loopback.
// Everything is written to /work (a size-limited tmpfs) and copied to /out at the end. A stop
// (run-control.mjs) kills the running recorder and the browser at once; the driver then starts
// nothing else, writes the summary, copies and exits 3. Nothing is retried.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { startGuardProxy } from "./guard-proxy.mjs";
import { startFixtureServer } from "./fixture-server.mjs";
import { launchArgs } from "./chromium-args.mjs";
import { createRunControl } from "./run-control.mjs";
import { createDriverCore, deriveJsonFile } from "./driver-core.mjs";

const PHASE = process.argv[2];
const WORK = "/work";
const OUT = "/out";
const FIXTURE_PORT = 8081;
const PROXY_PORT = 8899;
const DEBUG_PORT = 9222;
const ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const CDP_ORIGIN = `http://127.0.0.1:${DEBUG_PORT}`;
const STDOUT_CAP = 64 * 1024 * 1024; // per recorder invocation
const STDERR_CAP = 1024 * 1024;
const COMMAND_DEADLINE_MS = 60_000; // per recorder invocation; the container's own 30-minute kill is separate
// Every wait of the driver's own (CDP socket open, CDP reply, discovery fetch) has a deadline. A wait
// past it is a stop naming the step and the call, not a hang that only the wall clock ends.
const DRIVER_WAIT_MS = 10_000;
const REA = ["/opt/rea-node/bin/node", "/opt/rea/node_modules/rea-agents/scripts/rea.mjs"];
const WEBSITE_COMMANDS = [
  "observe-web-execution", "observe-web-session", "inspect-web-page", "capture-web-screenshot",
  "export-web-scripts", "analyze-web-bundle", "trace-web-source-location", "trace-web-module-imports",
  "compare-web-captures", "compare-web-screenshots", "capture-browser-scenario"
];

mkdirSync(`${WORK}/results`, { recursive: true });
mkdirSync("/tmp/home", { recursive: true });
const control = createRunControl({ workDir: WORK });
let probeActive = false;
const results = [];
// Progress copied out after every step, a deadline on every driver wait, the CDP client and the
// crash-counting rule live in driver-core.mjs, where the harness tests exercise them.
const core = createDriverCore({ workDir: WORK, outDir: OUT, control, waitMs: DRIVER_WAIT_MS });
const progress = core.progress;

// The recorder's environment, written out in full: nothing is inherited.
function reaEnv() {
  return {
    PATH: "/opt/rea-node/bin:/usr/bin:/bin",
    HOME: "/tmp/home", TMPDIR: "/tmp", XDG_CACHE_HOME: "/tmp/cache",
    NO_UPDATE_NOTIFIER: "1", CI: "1",
    // Route the recorder's own Node HTTP through the guard so any fetch it makes is recorded.
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: `http://127.0.0.1:${PROXY_PORT}`, HTTPS_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
    NO_PROXY: `127.0.0.1:${DEBUG_PORT}`,
    REA_BROWSER_EXECUTABLE: process.env.SBL_CHROMIUM
  };
}

function runRea(name, args, { signalAfterMs, signal } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(REA[0], [REA[1], ...args], { env: reaEnv(), cwd: "/tmp", stdio: ["ignore", "pipe", "pipe"] });
    control.state.child = child;
    const out = []; let outBytes = 0; const err = []; let errBytes = 0; let capped = false;
    child.stdout.on("data", (d) => {
      outBytes += d.length;
      if (outBytes > STDOUT_CAP) { capped = true; control.stop("output-over-budget", `${name}: stdout over ${STDOUT_CAP} bytes`); return; }
      out.push(d);
    });
    child.stderr.on("data", (d) => { if (errBytes < STDERR_CAP) { err.push(d); errBytes += d.length; } });
    const deadline = setTimeout(() => child.kill("SIGKILL"), COMMAND_DEADLINE_MS);
    const sig = signalAfterMs ? setTimeout(() => child.kill(signal), signalAfterMs) : null;
    child.on("close", (code, killedBy) => {
      clearTimeout(deadline); if (sig) clearTimeout(sig);
      control.state.child = null;
      const stderrText = Buffer.concat(err).toString("utf8");
      const record = { name, args, exit: code, signal: killedBy, ms: Date.now() - started, stdoutBytes: outBytes, capped };
      try {
        writeFileSync(`${WORK}/results/${name}.stdout.json`, Buffer.concat(out));
        writeFileSync(`${WORK}/results/${name}.stderr.txt`, stderrText);
        writeFileSync(`${WORK}/results/${name}.run.json`, JSON.stringify(record, null, 2));
      } catch (e) {
        control.stop("output-write-failed", `${name}: ${e.code ?? e.message}`); // ENOSPC: the 512 MiB budget is spent
      }
      control.scanStderr(name, stderrText);
      results.push(record);
      resolve(record);
    });
  });
}

function deriveJson(name, from, pointer, to) {
  const record = { name, derive: { from, pointer, to }, ...deriveJsonFile({ from, pointer, to }) };
  writeFileSync(`${WORK}/results/${name}.derive.json`, JSON.stringify(record, null, 2));
  results.push(record);
}

// A minimal CDP client for the driver's own session (navigation, crash, emulation), over loopback.
async function cdpPage(targetId) {
  const client = core.cdpClient(new WebSocket(`ws://127.0.0.1:${DEBUG_PORT}/devtools/page/${targetId}`));
  await client.opened;
  return client;
}
async function pageTarget() {
  const list = await (await fetch(`${CDP_ORIGIN}/json/list`, { signal: AbortSignal.timeout(DRIVER_WAIT_MS) })).json();
  return list.find((t) => t.type === "page");
}

async function startBrowser() {
  const profileDir = `/tmp/profile-${Date.now()}`;
  const browser = spawn(process.env.SBL_CHROMIUM, launchArgs({ debuggingPort: DEBUG_PORT, profileDir, proxyPort: PROXY_PORT }),
    { env: { PATH: "/usr/bin:/bin", HOME: "/tmp/home", TMPDIR: "/tmp" }, stdio: ["ignore", "ignore", "ignore"] });
  control.state.browser = browser;
  for (let i = 0; i < 100 && !control.state.stopped; i += 1) {
    try { if (await pageTarget()) return; } catch {}
    await sleep(100);
  }
  control.stop("browser-did-not-start", "no page target within 10 s");
}
const browserAlive = () => control.state.browser && control.state.browser.exitCode === null && control.state.browser.signalCode === null;

async function navigate(page) {
  const t = await pageTarget();
  const s = await cdpPage(t.id);
  await s.send("Page.enable");
  await s.send("Page.navigate", { url: `${ORIGIN}/${page}` });
  await sleep(1500);
  return { target: t, session: s };
}

async function phaseSchema() {
  // The guard runs here too: any fetch the recorder's Node makes through the proxy variables is
  // recorded and stops the run.
  await startGuardProxy({
    port: PROXY_PORT, allowedOrigins: [ORIGIN, CDP_ORIGIN], logPath: `${WORK}/guard.jsonl`,
    onRefusal: (r) => control.stop("connection-outside-fixture-origin", r)
  });
  await runRea("version", ["--version", "--json"]);
  for (const c of WEBSITE_COMMANDS) {
    if (control.state.stopped) break;
    await runRea(`schema-${c}`, [c, "--schema", "--json"]);
  }
}

// Each plan step: { name, page, args: [...] with "{target}", "{endpoint}", "{origin}", "{results}" filled in,
// page null for a step that works only from earlier output files (no navigation, no target),
// optional signal: { after_ms, kind: "SIGINT"|"SIGTERM"|"crash"|"kill-browser" }, optional
// emulation: true, optional probe: true, optional control: true }.
async function phaseFixtures() {
  const plan = JSON.parse(readFileSync("/in/plan.json", "utf8"));
  await startFixtureServer({ port: FIXTURE_PORT });
  await startGuardProxy({
    port: PROXY_PORT, allowedOrigins: [ORIGIN, CDP_ORIGIN], logPath: `${WORK}/guard.jsonl`,
    onRefusal: (r) => { if (!probeActive) control.stop("connection-outside-fixture-origin", r); }
  });
  await startBrowser();
  let freshBrowserNext = false;
  for (const step of plan.steps) {
    if (control.state.stopped) break;
    core.setStep(step.name);
    progress("begin");
    // After a step that crashed the page or killed the browser, start a new browser rather than
    // reattach to a crashed target.
    if (freshBrowserNext && browserAlive()) { control.state.browser.kill("SIGKILL"); await sleep(500); }
    freshBrowserNext = false;
    if (!browserAlive()) await startBrowser();
    if (control.state.stopped) break;
    probeActive = step.probe === true;
    // A derive step runs no recorder: it reads an earlier output as bounded, untrusted JSON, takes the
    // object at a JSON pointer, and writes it as its own file for a later step's input.
    if (step.derive) {
      const fillFiles = (a) => a.replaceAll("{results}", `${WORK}/results`);
      deriveJson(step.name, fillFiles(step.derive.from), step.derive.pointer, fillFiles(step.derive.to));
      progress("end");
      continue;
    }
    if (step.page === null) {
      const fillFiles = (a) => a.replaceAll("{results}", `${WORK}/results`).replaceAll("{origin}", ORIGIN);
      await runRea(step.name, step.args.map(fillFiles));
      probeActive = false;
      progress("end");
      continue;
    }
    const { target, session } = await navigate(step.page);
    if (step.emulation) await session.send("Emulation.setTimezoneOverride", { timezoneId: "Pacific/Kiritimati" });
    const fill = (a) => a.replaceAll("{target}", target.id).replaceAll("{endpoint}", CDP_ORIGIN).replaceAll("{origin}", ORIGIN).replaceAll("{results}", `${WORK}/results`);
    const args = step.args.map(fill);
    let pending;
    if (step.signal?.kind === "SIGINT" || step.signal?.kind === "SIGTERM") {
      pending = runRea(step.name, args, { signalAfterMs: step.signal.after_ms, signal: step.signal.kind });
    } else {
      pending = runRea(step.name, args);
      // Page.crash never answers by design: fired, with no reply awaited, so no deadline applies.
      if (step.signal?.kind === "crash") setTimeout(() => session.fire("Page.crash"), step.signal.after_ms);
      if (step.signal?.kind === "kill-browser") setTimeout(() => control.state.browser?.kill("SIGKILL"), step.signal.after_ms);
      // A trigger fires one expression into the page during the window, after the recorder is watching.
      if (step.trigger) setTimeout(() => session.fire("Runtime.evaluate", { expression: step.trigger.expression }), step.trigger.after_ms);
    }
    const rec = await pending;
    if (control.state.stopped) break;
    if (step.emulation && browserAlive()) {
      const after = await session.send("Runtime.evaluate", { expression: "window.zoneNow()", returnByValue: true });
      writeFileSync(`${WORK}/results/${step.name}.emulation-after.json`, JSON.stringify(after.result ?? after, null, 2));
    }
    session.close();
    if (step.control && rec.exit !== 0) control.stop("control-failed", `${step.name} exit ${rec.exit}; a decision about a second browser goes to the owner`);
    freshBrowserNext = core.afterStep(step, browserAlive()).freshBrowserNext;
    probeActive = false;
    progress("end");
  }
}

try {
  if (PHASE === "schema") await phaseSchema();
  else if (PHASE === "fixtures") await phaseFixtures();
  else control.stop("bad-phase", String(PHASE));
} catch (e) {
  control.stop("driver-error", String(e?.stack ?? e).slice(0, 4000));
}
if (browserAlive()) control.state.browser.kill("SIGKILL");
writeFileSync(`${WORK}/summary.json`, JSON.stringify({ phase: PHASE, rea: process.env.REA_VERSION, stopped: control.state.stopped, results }, null, 2));
cpSync(WORK, OUT, { recursive: true });
process.exit(control.state.stopped ? 3 : 0);
