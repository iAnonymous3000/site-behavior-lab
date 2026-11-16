// The recorder (rea-agents, the base image's release) as the runner starts it: two commands only,
// observe-web-execution and inspect-web-page (answer 5). No other command is spelled here, and the
// runner starts the recorder through runRecorder alone, which refuses any name not in COMMANDS.
// trace-web-module-imports is refused in S5: it starts its own Chromium.
//
// The recorder runs on its own Node with a literal environment: nothing of the runner's environment is
// passed on, so no token or credential can reach it that way. Its HTTP(S) goes to the recorder's guard
// (the S4 guard proxy), which lets through the browser's DevTools origin only. What it writes is
// untrusted data: kept bounded, parsed as JSON, never executed and never opened in a browser.
import { spawn } from "node:child_process";

export const RECORDER_NODE = "/opt/rea-node/bin/node";
export const RECORDER_CLI = "/opt/rea/node_modules/rea-agents/scripts/rea.mjs";
const STDOUT_CAP = 64 * 1024 * 1024;
const STDERR_CAP = 256 * 1024;
const COMMAND_DEADLINE_MS = 60_000;

/** The runner's whole command list, by its own names. A test holds it to exactly these two. */
export const COMMANDS = Object.freeze({
  observe: Object.freeze({ cli: "observe-web-execution", args: (endpoint, target, origin, ms) => [endpoint, target, "--observation-ms", String(ms), "--allowed-origins", origin, "--json"] }),
  inspect: Object.freeze({ cli: "inspect-web-page", args: (endpoint, target, origin) => [endpoint, target, "--include-script-sources", "--include-console-text", "--include-storage-keys", "--allowed-origins", origin, "--json"] })
});

/** The recorder's environment, written out in full. */
export function recorderEnv({ guardPort, cdpPort, browserExecutable }) {
  return {
    PATH: "/opt/rea-node/bin:/usr/bin:/bin",
    HOME: "/tmp/home",
    TMPDIR: "/tmp",
    XDG_CACHE_HOME: "/tmp/cache",
    NO_UPDATE_NOTIFIER: "1",
    CI: "1",
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: `http://127.0.0.1:${guardPort}`,
    HTTPS_PROXY: `http://127.0.0.1:${guardPort}`,
    NO_PROXY: `127.0.0.1:${cdpPort}`,
    REA_BROWSER_EXECUTABLE: browserExecutable
  };
}

/**
 * Run one command to its end. Resolves with what the run left: exit, signal, times, the bytes of
 * stdout (bounded) and the times the recorder's own progress lines arrived on stderr. Never rejects.
 */
export function runRecorder(name, { cdpPort, guardPort, target, origin, observeMs, browserExecutable, onSpawn }) {
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (command === null) return Promise.resolve({ name, refused: "not-a-runner-command", exit: null });
  const args = [RECORDER_CLI, command.cli, ...command.args(`http://127.0.0.1:${cdpPort}`, target, origin, observeMs)];
  return new Promise((resolve) => {
    const spawnedAtMs = Date.now();
    const child = spawn(RECORDER_NODE, args, { env: recorderEnv({ guardPort, cdpPort, browserExecutable }), cwd: "/tmp", stdio: ["ignore", "pipe", "pipe"] });
    onSpawn?.(child);
    const out = [];
    let outBytes = 0;
    let overCap = false;
    const err = [];
    let errBytes = 0;
    const progressLines = [];
    let pending = "";
    child.stdout.on("data", (d) => {
      outBytes += d.length;
      if (outBytes > STDOUT_CAP) { overCap = true; child.kill("SIGKILL"); return; }
      out.push(d);
    });
    child.stderr.on("data", (d) => {
      const at = Date.now();
      if (errBytes < STDERR_CAP) { err.push(d); errBytes += d.length; }
      pending += d.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (progressLines.length < 64) progressLines.push({ atMs: at, line: line.slice(0, 300) });
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), COMMAND_DEADLINE_MS);
    child.on("close", (exit, signal) => {
      clearTimeout(deadline);
      resolve({ name, cli: command.cli, exit, signal, overCap, spawnedAtMs, endedAtMs: Date.now(), stdout: Buffer.concat(out), stdoutBytes: outBytes, stderr: Buffer.concat(err).toString("utf8"), progressLines });
    });
    child.on("error", () => undefined);
  });
}
