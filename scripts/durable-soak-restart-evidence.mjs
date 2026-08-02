#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseStrictJson } from "../lib/strict-json.ts";
import {
  SCAN_ADMISSION_CAPABILITY_HEADER,
  SCAN_ADMISSION_COMMITMENT_HEADER,
  prepareScanAdmission
} from "./scan-admission.mjs";
import {
  DURABLE_RESTART_EVIDENCE_FILES,
  DURABLE_RESTART_FIXED_TARGET,
  DURABLE_RESTART_MAX_FILE_BYTES,
  DURABLE_RESTART_MAX_REPORT_BYTES,
  DurableRestartProviderUnavailableError,
  captureDurableRestartEvidence,
  normalizeCloudflareRuntimeObservation,
  parseDurableRestartEvidence,
  selectCloudflareContainerApplication,
  serializeDurableRestartEvidence,
  verifyDurableRestartEvidenceSet
} from "./durable-soak-restart-evidence-lib.mjs";
import {
  canonicalEvidenceDigest,
  sha256Bytes
} from "./operator-evidence-common.mjs";
import {
  readResponseBytesWithinLimit,
  readResponseJsonWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";
import {
  createDurableRestartControlAuthorization,
  isDurableRestartGithubRunId
} from "../lib/durable-restart-control-auth.ts";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const WRANGLER_CONFIG = path.join(
  REPOSITORY_ROOT,
  "wrangler.container.jsonc"
);
const PROVIDER_RESPONSE_MAX_BYTES = 1024 * 1024;
const HTTP_JSON_MAX_BYTES = 1024 * 1024;
const HTTP_OPERATION_TIMEOUT_MS = 20_000;
const PROVIDER_READ_TIMEOUT_MS = 30_000;
const PRODUCTION_ORIGIN = "https://scan.sitebehavior.org";
const MONITOR_TOKEN_HEADER =
  "x-site-behavior-lab-synthetic-monitor-token";
const RESTART_REPORT_ID_HEADER =
  "x-site-behavior-lab-durable-restart-report-id";
const RESTART_RUN_ID_HEADER =
  "x-site-behavior-lab-durable-restart-run-id";
const RESTART_AUTHORIZATION_HEADER =
  "x-site-behavior-lab-durable-restart-authorization";
const STRONG_HEADER_SECRET = /^[\x21-\x7e]{32,256}$/;
const RETRYABLE_PROVIDER_DESTROY_STATUSES = Object.freeze(
  Array.from({ length: 100 }, (_unused, index) => 500 + index)
);
const textDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true
});

class ProviderReadUnavailableError extends Error {}

function usage() {
  return [
    "Usage:",
    "  node scripts/durable-soak-restart-evidence.mjs --capture --output-dir <new-directory>",
    "  node scripts/durable-soak-restart-evidence.mjs --verify --directory <directory>"
  ].join("\n");
}

function required(name, maximum = 4096) {
  const value = process.env[name]?.trim() ?? "";
  if (
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} is required and must be a bounded printable value`);
  }
  return value;
}

function productionConfiguration() {
  const provider = required("DURABLE_RESTART_PROVIDER_KIND", 64);
  if (provider !== "cloudflare-containers") {
    throw new Error(
      "DURABLE_RESTART_PROVIDER_KIND must be exactly cloudflare-containers"
    );
  }
  const baseUrl = required("SCAN_BASE_URL", 256);
  if (baseUrl !== PRODUCTION_ORIGIN) {
    throw new Error(`SCAN_BASE_URL must be exactly ${PRODUCTION_ORIGIN}`);
  }
  const accountId = required("CLOUDFLARE_ACCOUNT_ID", 64);
  if (!/^[0-9a-f]{32}$/.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a lowercase account id");
  }
  const expectedCommit = required("EXPECTED_PRODUCTION_SHA", 40);
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
    throw new Error(
      "EXPECTED_PRODUCTION_SHA must be a full lowercase Git commit"
    );
  }
  const monitorToken = required(
    "PRODUCTION_SYNTHETIC_MONITOR_TOKEN",
    256
  );
  if (!STRONG_HEADER_SECRET.test(monitorToken)) {
    throw new Error(
      "PRODUCTION_SYNTHETIC_MONITOR_TOKEN must be a strong printable ASCII header secret"
    );
  }
  const restartControlToken = required(
    "DURABLE_RESTART_CONTROL_TOKEN",
    256
  );
  if (
    !STRONG_HEADER_SECRET.test(restartControlToken) ||
    restartControlToken === monitorToken
  ) {
    throw new Error(
      "DURABLE_RESTART_CONTROL_TOKEN must be a distinct strong ceremony secret"
    );
  }
  const apiToken = required(
    "DURABLE_RESTART_PROVIDER_API_TOKEN",
    2048
  );
  if (restartControlToken === apiToken) {
    throw new Error(
      "the restart control and provider readback credentials must be distinct"
    );
  }
  const githubRunId = required(
    "DURABLE_RESTART_GITHUB_RUN_ID",
    20
  );
  if (!isDurableRestartGithubRunId(githubRunId)) {
    throw new Error(
      "DURABLE_RESTART_GITHUB_RUN_ID must be the canonical GitHub run id"
    );
  }
  return Object.freeze({
    accountId,
    apiToken,
    baseUrl,
    expectedCommit,
    githubRunId,
    monitorToken,
    restartControlToken
  });
}

async function exactLocalWranglerEntrypoint() {
  const expectedPackage = await realpath(
    path.join(REPOSITORY_ROOT, "node_modules", "wrangler")
  );
  const entrypoint = await realpath(
    path.join(expectedPackage, "bin", "wrangler.js")
  );
  const relative = path.relative(expectedPackage, entrypoint);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "the local Wrangler entrypoint must resolve inside node_modules/wrangler"
    );
  }
  return entrypoint;
}

function providerEnvironment(configuration) {
  return {
    CI: "true",
    CLOUDFLARE_ACCOUNT_ID: configuration.accountId,
    CLOUDFLARE_API_TOKEN: configuration.apiToken,
    HOME: process.env.HOME ?? "",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    WRANGLER_SEND_METRICS: "false"
  };
}

function runWranglerJson(entrypoint, args, configuration, label) {
  const result = spawnSync(
    process.execPath,
    [
      entrypoint,
      ...args,
      "--config",
      WRANGLER_CONFIG,
      "--json"
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "buffer",
      env: providerEnvironment(configuration),
      input: Buffer.alloc(0),
      maxBuffer: PROVIDER_RESPONSE_MAX_BYTES,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: PROVIDER_READ_TIMEOUT_MS
    }
  );
  if (
    result.error ||
    result.signal !== null ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.byteLength === 0 ||
    result.stdout.byteLength > PROVIDER_RESPONSE_MAX_BYTES
  ) {
    throw new ProviderReadUnavailableError(
      `${label} failed or exceeded its bounded provider read contract`
    );
  }
  let text;
  try {
    text = textDecoder.decode(result.stdout);
  } catch {
    throw new Error(`${label} did not return valid UTF-8`);
  }
  try {
    return Object.freeze({
      bytes: result.stdout,
      value: parseStrictJson(text, PROVIDER_RESPONSE_MAX_BYTES)
    });
  } catch {
    throw new Error(`${label} did not return strict bounded JSON`);
  }
}

async function readProviderRuntime(
  entrypoint,
  configuration,
  { transient = false } = {}
) {
  try {
    const applications = runWranglerJson(
      entrypoint,
      ["containers", "list", "--per-page", "100"],
      configuration,
      "Cloudflare Containers application read"
    );
    const application = selectCloudflareContainerApplication(
      applications.value
    );
    const instances = runWranglerJson(
      entrypoint,
      [
        "containers",
        "instances",
        application.id,
        "--per-page",
        "100"
      ],
      configuration,
      "Cloudflare Containers instance read"
    );
    return normalizeCloudflareRuntimeObservation({
      application,
      instances: instances.value,
      sourceSha256: canonicalEvidenceDigest({
        domain:
          "site-behavior-lab/cloudflare-container-provider-source/v1",
        applicationsSha256: sha256Bytes(applications.bytes),
        instancesSha256: sha256Bytes(instances.bytes)
      }),
      capturedAt: new Date().toISOString()
    });
  } catch (error) {
    if (
      transient &&
      (error instanceof ProviderReadUnavailableError ||
        error instanceof DurableRestartProviderUnavailableError)
    ) {
      return null;
    }
    throw error;
  }
}

async function guardedJsonRequest(
  url,
  init,
  {
    expectedStatus,
    label,
    maximumBytes = HTTP_JSON_MAX_BYTES,
    transientStatuses = []
  }
) {
  try {
    return await withHttpOperationDeadline(
      {
        timeoutMs: HTTP_OPERATION_TIMEOUT_MS,
        label
      },
      async (signal) => {
        const response = await fetch(url, {
          ...init,
          cache: "no-store",
          redirect: "error",
          signal
        });
        if (transientStatuses.includes(response.status)) {
          await readResponseBytesWithinLimit(response, {
            maxBytes: maximumBytes,
            label
          });
          return null;
        }
        if (response.status !== expectedStatus) {
          await readResponseBytesWithinLimit(response, {
            maxBytes: maximumBytes,
            label
          });
          throw new Error(`${label} returned HTTP ${response.status}`);
        }
        const contentType =
          response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.includes("application/json")) {
          await readResponseBytesWithinLimit(response, {
            maxBytes: maximumBytes,
            label
          });
          throw new Error(`${label} returned a non-JSON response`);
        }
        return readResponseJsonWithinLimit(response, {
          maxBytes: maximumBytes,
          label
        });
      }
    );
  } catch (error) {
    if (
      transientStatuses.length > 0 &&
      (error instanceof TypeError ||
        (error instanceof DOMException &&
          ["AbortError", "TimeoutError"].includes(error.name)))
    ) {
      return null;
    }
    throw error;
  }
}

async function readReport(configuration, reportId) {
  return withHttpOperationDeadline(
    {
      timeoutMs: HTTP_OPERATION_TIMEOUT_MS,
      label: "durable restart report readback"
    },
    async (signal) => {
      const response = await fetch(
        `${configuration.baseUrl}/api/reports/${reportId}`,
        {
          cache: "no-store",
          redirect: "error",
          signal
        }
      );
      if (response.status !== 200) {
        await readResponseBytesWithinLimit(response, {
          maxBytes: DURABLE_RESTART_MAX_REPORT_BYTES,
          label: "durable restart report readback"
        });
        throw new Error(
          `durable restart report readback returned HTTP ${response.status}`
        );
      }
      const bytes = await readResponseBytesWithinLimit(response, {
        maxBytes: DURABLE_RESTART_MAX_REPORT_BYTES,
        label: "durable restart report readback"
      });
      let text;
      try {
        text = textDecoder.decode(bytes);
      } catch {
        throw new Error(
          "durable restart report readback was not valid UTF-8"
        );
      }
      let value;
      try {
        value = parseStrictJson(
          text,
          DURABLE_RESTART_MAX_REPORT_BYTES
        );
      } catch {
        throw new Error(
          "durable restart report readback was not strict bounded JSON"
        );
      }
      return Object.freeze({ bytes, value });
    }
  );
}

function monitorHeaders(configuration, extra = undefined) {
  return {
    [MONITOR_TOKEN_HEADER]: configuration.monitorToken,
    ...(extra ?? {})
  };
}

async function capture(configuration) {
  const entrypoint = await exactLocalWranglerEntrypoint();
  const admission = prepareScanAdmission({
    url: DURABLE_RESTART_FIXED_TARGET,
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    consentMode: "observe"
  });
  return captureDurableRestartEvidence(
    {
      expectedCommit: configuration.expectedCommit,
      admission
    },
    {
      now: () => new Date(),
      wait: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
      readHealth: ({ transient = false } = {}) =>
        guardedJsonRequest(
          `${configuration.baseUrl}/api/health`,
          {
            headers: monitorHeaders(configuration),
            method: "GET"
          },
          {
            expectedStatus: 200,
            label: "production durable health",
            transientStatuses: transient
              ? [502, 503, 504]
              : []
          }
        ),
      readRuntime: (options = undefined) =>
        readProviderRuntime(entrypoint, configuration, options),
      submitScan: async (preparedAdmission) =>
        guardedJsonRequest(
          `${configuration.baseUrl}/api/scan`,
          {
            body: JSON.stringify(preparedAdmission.body),
            headers: monitorHeaders(configuration, {
              ...preparedAdmission.headers,
              "content-type": "application/json"
            }),
            method: "POST"
          },
          {
            expectedStatus: 202,
            label: "durable restart scan admission"
          }
        ),
      readJobEvidence: (preparedAdmission, expectedJob) =>
        guardedJsonRequest(
          `${configuration.baseUrl}/api/scans/${expectedJob.jobId}/restart-evidence`,
          {
            headers: monitorHeaders(configuration, {
              [SCAN_ADMISSION_CAPABILITY_HEADER]:
                preparedAdmission.headers[
                  SCAN_ADMISSION_CAPABILITY_HEADER
                ],
              [SCAN_ADMISSION_COMMITMENT_HEADER]:
                preparedAdmission.headers[
                  SCAN_ADMISSION_COMMITMENT_HEADER
                ],
              [RESTART_REPORT_ID_HEADER]: expectedJob.reportId
            }),
            method: "GET"
          },
          {
            expectedStatus: 200,
            label: "bounded durable restart job evidence"
          }
        ),
      restartRuntime: async (preparedAdmission, expectedJob) =>
        guardedJsonRequest(
          `${configuration.baseUrl}/api/scans/${expectedJob.jobId}/restart-runtime`,
          {
            headers: monitorHeaders(configuration, {
              [SCAN_ADMISSION_CAPABILITY_HEADER]:
                preparedAdmission.headers[
                  SCAN_ADMISSION_CAPABILITY_HEADER
                ],
              [SCAN_ADMISSION_COMMITMENT_HEADER]:
                preparedAdmission.headers[
                  SCAN_ADMISSION_COMMITMENT_HEADER
                ],
              [RESTART_REPORT_ID_HEADER]: expectedJob.reportId,
              [RESTART_RUN_ID_HEADER]:
                configuration.githubRunId,
              [RESTART_AUTHORIZATION_HEADER]:
                await createDurableRestartControlAuthorization(
                  configuration.restartControlToken,
                  {
                    githubRunId: configuration.githubRunId,
                    jobId: expectedJob.jobId,
                    reportId: expectedJob.reportId
                  }
                )
            }),
            method: "POST"
          },
          {
            expectedStatus: 200,
            label: "provider-native durable runtime destroy",
            transientStatuses:
              RETRYABLE_PROVIDER_DESTROY_STATUSES
          }
        ),
      readReport: (reportId) =>
        readReport(configuration, reportId)
    }
  );
}

async function verifyDirectory(directory, { announce = true } = {}) {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(
      "durable restart evidence path must be a real directory"
    );
  }
  const names = await readdir(directory, { withFileTypes: true });
  if (
    names.some(
      (entry) => !entry.isFile() || entry.isSymbolicLink()
    ) ||
    JSON.stringify(names.map((entry) => entry.name).sort()) !==
      JSON.stringify([...DURABLE_RESTART_EVIDENCE_FILES])
  ) {
    throw new Error(
      "durable restart directory must contain exactly the four canonical regular files"
    );
  }
  const bytes = new Map();
  for (const name of DURABLE_RESTART_EVIDENCE_FILES) {
    const filePath = path.join(directory, name);
    const info = await lstat(filePath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 1 ||
      info.size > DURABLE_RESTART_MAX_FILE_BYTES
    ) {
      throw new Error(
        `${name} must be a bounded canonical regular file`
      );
    }
    bytes.set(name, await readFile(filePath));
  }
  const preHealth = parseDurableRestartEvidence(
    bytes.get("pre-health.json"),
    "pre-health"
  );
  const postHealth = parseDurableRestartEvidence(
    bytes.get("post-health.json"),
    "post-health"
  );
  const recovery = parseDurableRestartEvidence(
    bytes.get("queued-work-recovery.json"),
    "queued-work-recovery"
  );
  const restart = parseDurableRestartEvidence(
    bytes.get("restart-evidence.json"),
    "restart-evidence"
  );
  const result = verifyDurableRestartEvidenceSet({
    preHealth,
    postHealth,
    recovery,
    restart,
    recoverySha256: sha256Bytes(
      bytes.get("queued-work-recovery.json")
    )
  });
  if (announce) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, ...result })}\n`
    );
  }
  return result;
}

async function writeEvidenceDirectory(outputDirectory, evidence) {
  await mkdir(outputDirectory, { mode: 0o700 });
  for (const name of DURABLE_RESTART_EVIDENCE_FILES) {
    const kind = name.slice(0, -".json".length);
    const bytes = serializeDurableRestartEvidence(
      evidence[name],
      kind
    );
    await writeFile(path.join(outputDirectory, name), bytes, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  }
  return verifyDirectory(outputDirectory, { announce: false });
}

const args = process.argv.slice(2);
try {
  if (
    args.length === 3 &&
    args[0] === "--verify" &&
    args[1] === "--directory"
  ) {
    await verifyDirectory(path.resolve(args[2]));
  } else if (
    args.length === 3 &&
    args[0] === "--capture" &&
    args[1] === "--output-dir"
  ) {
    // Capture all remote evidence in memory before creating any artifact path.
    const evidence = await capture(productionConfiguration());
    const result = await writeEvidenceDirectory(
      path.resolve(args[2]),
      evidence
    );
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        deploymentCommit: result.deploymentCommit,
        evidenceDigest: result.evidenceDigest
      })}\n`
    );
  } else {
    throw new Error(usage());
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
}
