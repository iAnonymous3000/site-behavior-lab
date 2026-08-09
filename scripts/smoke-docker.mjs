#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  readResponseJsonWithinLimit,
  readResponseTextWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";
import { savedReportRetainsScreenshot } from "./smoke-deployed-scanner-report.mjs";
import { startSmokeR2Server } from "./smoke-r2-server.mjs";

process.on("uncaughtException", (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

const execFileAsync = promisify(execFile);
const dockerBin = process.env.DOCKER_BIN || "docker";
const image = process.env.DOCKER_SMOKE_IMAGE || "site-behavior-lab:smoke";
const token = process.env.DOCKER_SMOKE_SCAN_ACCESS_TOKEN || "docker-smoke-token";
const skipBuild = /^(1|true|yes|on)$/i.test(process.env.DOCKER_SMOKE_SKIP_BUILD || "");
const publicR2Smoke = /^(1|true|yes|on)$/i.test(process.env.DOCKER_SMOKE_PUBLIC_R2 || "");
const healthRequestTimeoutMs = 10_000;
const healthResponseMaxBytes = 256 * 1024;
// Declared here, with the other module constants, because the top-level await
// below calls into functions that read it. A const declared further down the
// file is still in its temporal dead zone at that point: the function
// declaration hoists, the binding does not, and the smoke died on exactly that.
const printableRouteMaxBytes = 8 * 1024 * 1024;
// Playwright's version-pinned default Docker seccomp profile plus the user-
// namespace syscalls Chromium's sandbox needs. Keep it in lockstep with the
// Playwright image/package pin rather than removing syscall filtering or
// disabling Chromium's own sandbox.
const seccompProfile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "playwright-seccomp-profile.json");

const runningContainers = new Set();
let smokeR2 = null;

try {
  await assertDockerAvailable();
  if (!skipBuild) {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
    const buildCommit = stdout.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(buildCommit)) throw new Error("Could not identify the Docker smoke source revision.");
    const proofResult = await execFileAsync(process.execPath, [
      path.resolve("scripts", "measurement-candidate-build-proof.mjs")
    ]);
    const measurementCandidateProof = proofResult.stdout.trim();
    await run(dockerBin, [
      "build",
      "--build-arg",
      `SITE_BEHAVIOR_LAB_BUILD_COMMIT=${buildCommit}`,
      "--build-arg",
      `SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF=${measurementCandidateProof}`,
      "-t",
      image,
      "."
    ]);
  }

  await runV1ImageSmoke();
  if (publicR2Smoke) await runPublicR2ImageSmoke();
} finally {
  for (const containerId of runningContainers) {
    await execFileAsync(dockerBin, ["stop", containerId]).catch(() => undefined);
  }
  await smokeR2?.close().catch(() => undefined);
}

async function runV1ImageSmoke() {
  const scanner = await startScannerContainer([
    // This label is in the frozen v1 redaction allowlist; an invented suffix
    // would be intentionally generalized and make the smoke test its own
    // source of invalid methodology metadata.
    "SITE_BEHAVIOR_LAB_SCANNER_EGRESS=docker-smoke",
    "SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX=1"
  ]);
  try {
    assertSandboxEnabled(scanner.health);
    if (scanner.health.storage !== "filesystem") {
      throw new Error("Default Docker smoke did not retain the filesystem/v1 report lane.");
    }
    await run("node", ["scripts/smoke-test.mjs"], {
      BASE_URL: scanner.baseUrl,
      SMOKE_SCAN_ACCESS_TOKEN: token
    });
    console.log(`Docker v1/filesystem smoke passed for ${image} at ${scanner.baseUrl}.`);
  } catch (error) {
    await printScannerLogs(scanner.containerId);
    throw error;
  } finally {
    await stopScannerContainer(scanner.containerId);
  }
}

async function runPublicR2ImageSmoke() {
  const bucket = "site-behavior-lab-smoke";
  smokeR2 = await startSmokeR2Server({ bucket, host: await dockerR2BindHost() });
  const scanner = await startScannerContainer(
    [
      "SITE_BEHAVIOR_LAB_SCANNER_EGRESS=docker-smoke",
      "SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION=docker-smoke",
      "SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX=1",
      "SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION=1",
      "SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS=1",
      "SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND=r2",
      `SITE_BEHAVIOR_LAB_R2_BUCKET=${bucket}`,
      `SITE_BEHAVIOR_LAB_R2_ENDPOINT=http://host.docker.internal:${smokeR2.port}`,
      "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID=smoke-access-key",
      "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY=smoke-secret-key",
      "SITE_BEHAVIOR_LAB_R2_PREFIX=reports/"
    ],
    true
  );
  try {
    assertSandboxEnabled(scanner.health);
    if (
      scanner.health.storage !== "r2" ||
      scanner.health.checks?.reportStore?.kind !== "r2" ||
      scanner.health.checks?.reportStore?.configuredPath !== true ||
      scanner.health.checks?.publicR2Reports?.status !== "enabled" ||
      scanner.health.checks?.consentVerification !== "enabled"
    ) {
      throw new Error("Docker health did not confirm the production public-v2/R2 posture.");
    }
    await run("node", ["scripts/smoke-deployed-scanner.mjs"], {
      SCAN_BASE_URL: scanner.baseUrl,
      SMOKE_SCAN_ACCESS_TOKEN: token,
      SMOKE_EXPECTED_STORAGE: "r2"
    });
    assertPublicR2Bundles(smokeR2.snapshot());
    await assertPrintableReportRoute(scanner.baseUrl, smokeR2.snapshot());
    console.log(`Docker public-v2/R2 smoke passed for ${image} at ${scanner.baseUrl}.`);
  } catch (error) {
    await printScannerLogs(scanner.containerId);
    throw error;
  } finally {
    await stopScannerContainer(scanner.containerId);
  }
}

async function dockerR2BindHost() {
  // Docker Desktop forwards host.docker.internal to the host loopback. Native
  // Linux instead reaches the host through the default bridge gateway, so bind
  // only that interface rather than exposing the unauthenticated fixture on
  // every runner interface.
  if (process.platform !== "linux") return "127.0.0.1";
  const { stdout } = await execFileAsync(dockerBin, [
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}"
  ]);
  const gateway = stdout.trim();
  if (!net.isIPv4(gateway) || gateway === "0.0.0.0") {
    throw new Error(`Docker default bridge did not expose one narrow IPv4 gateway: ${JSON.stringify(gateway)}.`);
  }
  return gateway;
}

async function startScannerContainer(environment, addHostGateway = false) {
  const port = await freePort();
  const args = [
    "run",
    "--rm",
    "--init",
    "--ipc=host",
    "--security-opt",
    `seccomp=${seccompProfile}`,
    "-d",
    "-p",
    `127.0.0.1:${port}:3000`
  ];
  if (addHostGateway) args.push("--add-host", "host.docker.internal:host-gateway");
  args.push("-e", `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN=${token}`);
  for (const value of environment) args.push("-e", value);
  args.push(image);

  const runResult = await execFileAsync(dockerBin, args);
  const containerId = runResult.stdout.trim();
  if (!containerId) throw new Error("Docker did not return a container id.");
  runningContainers.add(containerId);
  const baseUrl = `http://127.0.0.1:${port}`;
  return { containerId, baseUrl, health: await waitForHealth(baseUrl) };
}

async function stopScannerContainer(containerId) {
  if (!runningContainers.delete(containerId)) return;
  await execFileAsync(dockerBin, ["stop", containerId]).catch(() => undefined);
}

async function printScannerLogs(containerId) {
  const result = await execFileAsync(dockerBin, ["logs", "--tail", "200", containerId]).catch(() => null);
  if (!result) return;
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output) console.error(`Scanner container logs (${containerId.slice(0, 12)}):\n${output}`);
}

/**
 * The printable route, rendered by the real container.
 *
 * Everything else that covers this route reads source text or drives a
 * hand-written fixture, so the route could throw at runtime, or ReportRenderer's
 * printComplete path could regress, with every gate still green. It is also the
 * only surface where the container and the static export deliberately differ,
 * and it exists on exactly one of them.
 */
async function assertPrintableReportRoute(baseUrl, objects) {
  const reportKey = objects
    .map(({ key }) => key)
    .find((key) => /^reports\/[0-9]{8}-[0-9a-f]{32}\.json$/.test(key));
  if (!reportKey) throw new Error("Printable-route smoke found no persisted report to render.");
  const reportId = reportKey.slice("reports/".length, -".json".length);

  // Bounded in time as well as bytes: a container that returns headers and
  // then stalls its body would otherwise hang CI rather than fail it. The
  // health probe below uses the same deadline wrapper.
  // Both the headers AND the body inside one deadline: reading the body after
  // the wrapper returns leaves a stalled body unbounded in time, which is the
  // hang this was meant to prevent.
  const html = await withHttpOperationDeadline(
    { timeoutMs: 30_000, label: "printable report route" },
    async (signal) => {
      const response = await fetch(`${baseUrl}/reports/${reportId}/print`, {
        headers: { accept: "text/html" },
        redirect: "manual",
        signal
      });
      if (response.status !== 200) {
        throw new Error(`Printable report route answered ${response.status}; expected 200.`);
      }
      return readResponseTextWithinLimit(response, {
        maxBytes: printableRouteMaxBytes,
        label: "printable report route"
      });
    }
  );

  // Present because the page is the complete rendering.
  for (const [needle, why] of [
    ["print-evidence-footer", "the printed evidence footer"],
    ["Exact evidence bytes", "the wire digest sentence"],
    ["Approved use", "the approved use boundary"],
    ["app-footer-caveat", "the standing scope caveat"],
    ["request-evidence", "the request log the interactive route defers"]
  ]) {
    if (!html.includes(needle)) {
      throw new Error(`Printable report route did not render ${why} (${needle}).`);
    }
  }

  // Absent because the whole point is that it does NOT defer its evidence.
  if (html.includes("report-evidence-loader")) {
    throw new Error("Printable report route rendered the lazy evidence prompt instead of the evidence.");
  }
  if (!/<meta[^>]+name="robots"[^>]+noindex/i.test(html)) {
    throw new Error("Printable report route is missing its noindex robots directive.");
  }

  // The rendered row count is the property that separates this route from the
  // interactive one; a summary-only regression would still satisfy the strings
  // above. The interactive route renders none of these before a click.
  const renderedRows = (html.match(/<tr\b/g) ?? []).length;
  if (renderedRows < 2) {
    throw new Error(`Printable report route rendered ${renderedRows} table rows; expected the evidence tables.`);
  }
  console.log(`Printable report route rendered ${renderedRows} evidence rows for ${reportId}.`);
}

function assertSandboxEnabled(health) {
  if (health.checks?.chromiumSandbox !== "enabled") {
    throw new Error("Docker health did not confirm that the Chromium sandbox is enabled.");
  }
}

function assertPublicR2Bundles(objects) {
  const reports = objects.filter(({ key }) => /^reports\/[0-9]{8}-[0-9a-f]{32}\.json$/.test(key));
  if (reports.length < 2) {
    throw new Error("Public-v2/R2 Docker smoke did not persist both single and comparison reports.");
  }
  const keys = new Set(objects.map(({ key }) => key));
  for (const object of reports) {
    const report = JSON.parse(object.body);
    if (report.schemaVersion !== 2 || report.schemaRevision !== 2 || savedReportRetainsScreenshot(report)) {
      throw new Error(`R2 smoke object ${object.key} was not a screenshot-free public v2/r2 report.`);
    }
    if (!keys.has(`${object.key}.provenance.json`)) {
      throw new Error(`R2 smoke object ${object.key} is missing its provenance sidecar.`);
    }
  }
}

async function assertDockerAvailable() {
  try {
    await run(dockerBin, ["version"]);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("Docker is required for this smoke test. Install Docker or set DOCKER_BIN to the Docker CLI path.");
    }
    throw error;
  }
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 90_000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const timeoutMs = Math.max(1, Math.min(healthRequestTimeoutMs, deadline - Date.now()));
      const { response, health } = await withHttpOperationDeadline(
        { timeoutMs, label: "Docker scanner health" },
        async (signal) => {
          const response = await fetch(`${baseUrl}/api/health`, {
            cache: "no-store",
            redirect: "error",
            signal
          });
          const health = await readResponseJsonWithinLimit(response, {
            maxBytes: healthResponseMaxBytes,
            label: "Docker scanner health"
          });
          return { response, health };
        }
      );
      if (response.ok && health.ok === true) return health;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_500);
  }

  throw new Error(`Docker container did not become healthy: ${lastError}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Could not allocate a smoke-test port."));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
