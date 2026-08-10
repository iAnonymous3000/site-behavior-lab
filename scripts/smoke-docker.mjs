#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  readResponseBytesWithinLimit,
  readResponseJsonWithinLimit,
  readResponseTextWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";
import {
  savedReportRetainsScreenshot,
  singleReportTotalRequests
} from "./smoke-deployed-scanner-report.mjs";
import { pdfPageCount, pdfText, pdfTextIncludes } from "./pdf-text-lib.mjs";
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
// Matches REPORT_PDF_MAX_BYTES in lib/report-pdf.ts: the route refuses anything
// larger, so a response above this is a contract violation, not a big report.
const reportPdfMaxBytes = 24 * 1024 * 1024;
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
  const storedReports = objects
    .filter(({ key }) => /^reports\/[0-9]{8}-[0-9a-f]{32}\.json$/.test(key))
    .map((object) => ({ ...object, report: JSON.parse(object.body) }));
  const storedSingle = storedReports.find(
    ({ report }) => singleReportTotalRequests(report) !== null
  );
  if (!storedSingle) {
    throw new Error("Printable-route smoke found no persisted single report to render.");
  }
  const reportKey = storedSingle.key;
  const reportId = reportKey.slice("reports/".length, -".json".length);
  const expectedRequestRows = singleReportTotalRequests(storedSingle.report);
  if (
    !Number.isSafeInteger(expectedRequestRows) ||
    expectedRequestRows < 0
  ) {
    throw new Error(
      `Printable-route smoke report records an invalid request count: ${String(expectedRequestRows)}.`
    );
  }

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

  // Count the request-table body, not every table header on the page. The
  // report's recorded request count is the completeness contract: a route that
  // rendered two token rows would satisfy the old floor while silently losing
  // almost all of its printable evidence.
  const renderedRows = renderedRequestRowCount(html);
  if (renderedRows !== expectedRequestRows) {
    throw new Error(
      `Printable report route rendered ${renderedRows} request rows; ` +
        `the stored report records ${expectedRequestRows}.`
    );
  }
  console.log(`Printable report route rendered all ${renderedRows} request rows for ${reportId}.`);

  await assertReportPdfRoute(baseUrl, reportId, storedSingle.body, expectedRequestRows);
}

/**
 * The PDF export, rendered by the real container.
 *
 * "200, application/pdf, non-zero bytes" is satisfied by a two-page summary
 * that dropped every request row, which is precisely the regression the
 * printable route exists to prevent. So this reads the text back out of the
 * document and checks the evidence is in it. It runs against the same report
 * the printable check just validated, so a disagreement between the two is a
 * disagreement about the SAME page rather than about which page was rendered.
 */
async function assertReportPdfRoute(baseUrl, reportId, wire, expectedRequestRows) {
  const { bytes, disposition } = await withHttpOperationDeadline(
    { timeoutMs: 120_000, label: "report PDF route" },
    async (signal) => {
      const response = await fetch(`${baseUrl}/api/reports/${reportId}/pdf`, {
        headers: { accept: "application/pdf" },
        redirect: "manual",
        signal
      });
      if (response.status !== 200) {
        throw new Error(`Report PDF route answered ${response.status}; expected 200.`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("application/pdf")) {
        throw new Error(`Report PDF route served content-type ${contentType || "(none)"}.`);
      }
      return {
        disposition: response.headers.get("content-disposition") ?? "",
        bytes: await readResponseBytesWithinLimit(response, {
          maxBytes: reportPdfMaxBytes,
          label: "report PDF route"
        })
      };
    }
  );

  // A reader who saves this must end up with a file named after the report, not
  // "pdf" or the bare route segment.
  if (!/^attachment;\s*filename="[^"]+\.pdf"$/.test(disposition)) {
    throw new Error(`Report PDF route sent an unusable content-disposition: ${disposition || "(none)"}.`);
  }
  if (!disposition.includes(reportId)) {
    throw new Error(`Report PDF filename does not name the report: ${disposition}.`);
  }

  const pages = pdfPageCount(bytes);
  const text = pdfText(bytes);
  const undecodable = (text.match(/�/g) ?? []).length;
  if (undecodable > 0) {
    throw new Error(`Report PDF contained ${undecodable} glyphs this reader could not decode.`);
  }

  // The printed exhibit must carry the digest of the exact bytes it was made
  // from. Recomputed here from the stored wire rather than read off the page,
  // so a report rendered from the wrong bytes cannot satisfy it.
  const wireSha256 = createHash("sha256").update(wire).digest("hex");
  if (!text.includes(wireSha256)) {
    throw new Error(`Report PDF does not carry the wire digest ${wireSha256} of the report it renders.`);
  }

  for (const [phrase, why] of [
    ["Approved use", "the approved use boundary"],
    ["Exact evidence bytes", "the wire digest sentence"],
    ["Verify independently", "the independent verification pointer"],
    ["Evidence receipt", "the evidence receipt"]
  ]) {
    if (!pdfTextIncludes(text, phrase)) {
      throw new Error(`Report PDF is missing ${why} ("${phrase}").`);
    }
  }

  // The completeness contract, same one the HTML check uses: every recorded
  // request renders its URL, so the document must carry at least that many.
  // A summary-only regression collapses this to a handful.
  const renderedUrls = (text.match(/https?:\/\//g) ?? []).length;
  if (renderedUrls < expectedRequestRows) {
    throw new Error(
      `Report PDF rendered ${renderedUrls} request URLs across ${pages} pages; ` +
        `the stored report records ${expectedRequestRows} requests.`
    );
  }

  console.log(
    `Report PDF route rendered ${pages} pages carrying ${renderedUrls} request URLs ` +
      `and the wire digest for ${reportId}.`
  );
}

function renderedRequestRowCount(html) {
  const requestTableStart = html.search(
    /<div\b[^>]*class="[^"]*\brequest-table\b[^"]*"[^>]*>/i
  );
  if (requestTableStart < 0) {
    throw new Error("Printable report route did not render the request table.");
  }
  const bodyStart = html.indexOf("<tbody", requestTableStart);
  const bodyOpenEnd = bodyStart < 0 ? -1 : html.indexOf(">", bodyStart);
  const bodyEnd = bodyOpenEnd < 0 ? -1 : html.indexOf("</tbody>", bodyOpenEnd + 1);
  if (bodyStart < 0 || bodyOpenEnd < 0 || bodyEnd < 0) {
    throw new Error("Printable report route rendered an incomplete request table body.");
  }
  return (html.slice(bodyOpenEnd + 1, bodyEnd).match(/<tr\b/gi) ?? []).length;
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
