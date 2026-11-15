// Stop handling for one S4 run. A stop is final: it records the reason, kills the running recorder
// child and the browser with SIGKILL at once, and the driver then finishes (summary, copy, exit 3)
// without starting anything else. Nothing is retried.
import { writeFileSync } from "node:fs";

// Socket and resolver failures that mean something tried to reach a host. Under --network none a
// direct attempt fails this way without reaching the guard proxy, so stderr is the second detector.
const NETWORK_FAILURE = /\b(EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT)\b[^\n]{0,240}/g;
const LOOPBACK = /\b(127\.0\.0\.1|localhost|\[::1\])\b/;

export function createRunControl({ workDir }) {
  const state = { stopped: null, child: null, browser: null, unexpectedBrowserExits: 0 };

  function kill(proc) {
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }

  function stop(reason, detail) {
    if (state.stopped) return;
    state.stopped = { reason, detail, at: new Date().toISOString() };
    writeFileSync(`${workDir}/STOPPED.json`, JSON.stringify(state.stopped, null, 2));
    kill(state.child);
    kill(state.browser);
  }

  // One counter for the whole run, not per browser process: a browser exit the step did not cause
  // counts, and the second one stops the run.
  function browserExitedUnexpectedly(stepName) {
    state.unexpectedBrowserExits += 1;
    if (state.unexpectedBrowserExits > 1) stop("repeated-crash", stepName);
  }

  function scanStderr(stepName, text) {
    for (const match of text.matchAll(NETWORK_FAILURE)) {
      if (!LOOPBACK.test(match[0])) {
        stop("connection-attempt-in-stderr", `${stepName}: ${match[0].slice(0, 300)}`);
        return;
      }
    }
  }

  return { state, stop, browserExitedUnexpectedly, scanStderr };
}
