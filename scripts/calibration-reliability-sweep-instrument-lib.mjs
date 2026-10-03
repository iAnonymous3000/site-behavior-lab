/**
 * The instrument checks the reliability-sweep driver runs around every scan,
 * so that a round records a row only while the instrument itself was sound.
 *
 * WHY THIS EXISTS. The response classifier
 * (calibration-reliability-sweep-response-lib.mjs) decides from the server's
 * declared answer, and three of the answers it may file as site outcomes are
 * also exactly what the instrument produces when its own path fails:
 *
 *   - target-unreachable: lib/url-safety.ts treats getaddrinfo ENOTFOUND as an
 *     authoritative "no such name", and a Mac whose network is down or whose
 *     resolver daemon is unreachable answers ENOTFOUND for every name, in
 *     milliseconds, without charging any rate limit;
 *   - the cause-less 502: lib/scanner.ts keeps only the proxy's
 *     non-public-address block, so a proxy that could not resolve or reach
 *     the upstream becomes the generic navigation failure;
 *   - page-load-timeout: the scanner's 45 s budget is wall-clock
 *     (lib/scan-runtime.ts), so a scan that spans a machine sleep times out.
 *
 * Inside one answer none of those can be told from a site outcome. A round
 * driven through a 30-second Wi-Fi drop could file most of its cases as
 * unreachable sites in seconds and still exit 0 and validate. So the driver
 * establishes the instrument's state around each answer instead, and stops
 * the round when it cannot:
 *
 *   1. Egress. A probe that resolves a host NAME through the operating
 *      system resolver (the gate's own path) and opens a fresh connection
 *      runs before case 1 and after every answer. A failed probe stops the
 *      round, whatever the answer was.
 *   2. The clock. A scan whose wall-clock duration differs from the process's
 *      monotonic duration by more than SWEEP_CLOCK_DRIFT_TOLERANCE_MS (the
 *      machine slept, or its clock was stepped) or exceeds the driver's own
 *      scan deadline stops the round, reports included.
 *
 * What neither can see: an outage that begins and ends strictly inside one
 * scan, and an awake instrument too slow to finish inside the scanner's
 * budget. Both are still recorded as site outcomes; the design document
 * (docs/reliability-sweep-cluster-design.md) names them as residuals.
 *
 * The checkout binding lives here too, because it is the same question asked
 * once per round: is the code that runs this round the build the round
 * artifact will claim?
 */

import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/** How long one egress probe may take before it counts as failed. */
export const SWEEP_EGRESS_PROBE_TIMEOUT_MS = 10_000;

/**
 * How far wall-clock and monotonic time may disagree across one scan before
 * the scan is treated as having spanned a sleep or a clock step. Clock-rate
 * disagreement on an awake machine is parts per million, well under a second
 * across the driver's whole 180 s deadline; a sleep is minutes.
 */
export const SWEEP_CLOCK_DRIFT_TOLERANCE_MS = 5_000;

function describeNetworkError(error) {
  const message = String(error?.message ?? error);
  const code = error?.code ?? error?.cause?.code;
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

/**
 * Parse SWEEP_EGRESS_PROBE_URL. It must be an http or https URL without
 * credentials whose host is a NAME: an address literal would skip the
 * resolver, and a dead resolver is the first outage this probe exists to see.
 */
export function parseEgressProbeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SWEEP_EGRESS_PROBE_URL is not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`SWEEP_EGRESS_PROBE_URL must be an http or https URL, not ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("SWEEP_EGRESS_PROBE_URL must not carry credentials");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    throw new Error(
      `SWEEP_EGRESS_PROBE_URL must name its host, not the address ${host}: the probe has to exercise the resolver the scanner's gate uses`
    );
  }
  return url;
}

/**
 * One egress probe: a HEAD request on a FRESH connection (agent: false), so
 * every probe performs its own getaddrinfo lookup and its own connect, and
 * over https its own certificate check. A pooled keep-alive connection would
 * answer while the resolver is dead, which is exactly the outage this exists
 * to catch. Any HTTP answer, whatever its status, proves resolution and
 * egress worked; no answer within the timeout, or any connection or TLS
 * error, is a failure. Never throws.
 */
export function probeEgress(url, { timeoutMs = SWEEP_EGRESS_PROBE_TIMEOUT_MS } = {}) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    let request = null;
    const finish = (result, { destroy }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (destroy) request?.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, detail: `no answer within ${timeoutMs} ms` }, { destroy: true }),
      timeoutMs
    );
    try {
      request = transport.request(
        url,
        { method: "HEAD", agent: false, headers: { "cache-control": "no-cache" } },
        (response) => {
          response.on("error", () => undefined);
          response.resume();
          finish({ ok: true, detail: `HTTP ${response.statusCode}` }, { destroy: false });
        }
      );
      request.on("error", (error) => finish({ ok: false, detail: describeNetworkError(error) }, { destroy: true }));
      request.end();
    } catch (error) {
      finish({ ok: false, detail: describeNetworkError(error) }, { destroy: true });
    }
  });
}

function seconds(ms) {
  return (ms / 1000).toFixed(1);
}

/**
 * Whether one scan's timing lets its answer stand. Null when it does; the
 * reason to stop when it does not. Two independent rules, so the verdict
 * holds whichever way the platform's monotonic clock treats a sleep:
 *
 *   - Drift: Node's monotonic clock does not advance while macOS sleeps, and
 *     the wall clock does. A difference beyond the tolerance means the scan
 *     spanned a sleep or a clock step, and the scanner's wall-clock budget
 *     may have expired for a reason the site never caused.
 *   - Deadline: no awake scan outlives the driver's own fetch deadline,
 *     which is four times the scanner's 45 s budget. If a platform's
 *     monotonic clock does count a sleep, the drift rule sees nothing, and a
 *     server answer that wins the race with the fetch deadline on wake would
 *     otherwise be recorded.
 */
export function caseClockVerdict({ wallElapsedMs, monotonicElapsedMs, deadlineMs, toleranceMs = SWEEP_CLOCK_DRIFT_TOLERANCE_MS }) {
  for (const [name, value] of Object.entries({ wallElapsedMs, monotonicElapsedMs, deadlineMs, toleranceMs })) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`caseClockVerdict requires a finite ${name}`);
    }
  }
  const drift = wallElapsedMs - monotonicElapsedMs;
  if (Math.abs(drift) > toleranceMs) {
    return (
      `the wall clock moved ${seconds(wallElapsedMs)} s while this process ran ${seconds(monotonicElapsedMs)} s: ` +
      "the machine slept, or its clock was stepped, while this scan was in flight. The scanner's budget is wall-clock, " +
      "so the answer may be the instrument's own timeout and cannot be recorded as the site's"
    );
  }
  if (wallElapsedMs > deadlineMs) {
    return (
      `the scan took ${seconds(wallElapsedMs)} s of wall-clock time, beyond the driver's ${seconds(deadlineMs)} s deadline ` +
      "that no awake scan reaches: the instrument stalled or the machine slept, and the answer cannot be recorded as the site's"
    );
  }
  return null;
}

/**
 * Whether the driver's checkout may collect under the declared build. Null
 * when it may; the reason to refuse when it may not.
 */
export function checkoutBindingVerdict({ head, dirtyPaths, buildCommit }) {
  if (head !== buildCommit) {
    return (
      `the driver's checkout is at ${head}, not the declared SITE_BEHAVIOR_LAB_BUILD_COMMIT ${buildCommit}; ` +
      "the round artifact would claim a build that did not run it. Collect from an isolated worktree checked out at exactly the collection SHA"
    );
  }
  if (dirtyPaths.length > 0) {
    const shown = dirtyPaths.slice(0, 20).join(", ");
    const more = dirtyPaths.length > 20 ? ` and ${dirtyPaths.length - 20} more` : "";
    return (
      `the driver's checkout has ${dirtyPaths.length} tracked change(s) against ${buildCommit} (${shown}${more}); ` +
      "a modified tree is not the declared build. Restore it, or collect from a fresh worktree"
    );
  }
  return null;
}

/**
 * Read the git checkout that CONTAINS `fromDir` (the driver resolves this from
 * its own file, never from the working directory). Every GIT_* variable is
 * removed from git's environment, so GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE
 * left in a shell cannot point the check at another repository. Untracked
 * files are not changes: the server's log and build output live in the tree.
 */
export function readDriverCheckout(fromDir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (args, cwd) =>
    execFileSync("git", ["--no-optional-locks", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], fromDir).trim();
  } catch (error) {
    throw new Error(
      `the sweep driver must run from a git checkout of the collection SHA, and ${fromDir} is not inside one (${String(error?.stderr ?? error?.message ?? error).trim()})`
    );
  }
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"], root).trim().toLowerCase();
  const dirtyPaths = git(["status", "--porcelain=v1", "--untracked-files=no"], root)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));
  return { root, head, dirtyPaths };
}
