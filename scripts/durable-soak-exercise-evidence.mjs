#!/usr/bin/env node

import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isSupportedDeployedReport,
  savedReportRetainsScreenshot
} from "./smoke-deployed-scanner-report.mjs";
import {
  readResponseTextWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";
import { parseStrictJson } from "../lib/strict-json.ts";
import {
  canonicalEvidenceDigest,
  sha256Bytes
} from "./operator-evidence-common.mjs";
import { prepareScanAdmission } from "./scan-admission.mjs";
import {
  DURABLE_SOAK_EXERCISE_CONFIG_PATH,
  DURABLE_SOAK_EXERCISE_FILE,
  DURABLE_SOAK_EXERCISE_HEALTH_FILE,
  DURABLE_SOAK_EXERCISE_KIND,
  DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES,
  DURABLE_SOAK_EXERCISE_POST_HEALTH_FILE,
  DURABLE_SOAK_EXERCISE_SCHEMA_VERSION,
  parseDurableSoakExerciseEvidence,
  serializeDurableSoakExerciseEvidence,
  verifyDurableSoakExerciseEvidence,
  verifyDurableSoakExerciseHealth
} from "./durable-soak-exercise-evidence-lib.mjs";

const SYNTHETIC_MONITOR_HEADER =
  "x-site-behavior-lab-synthetic-monitor-token";
const NORMAL_TARGET = "https://www.iana.org/domains/reserved";
const CANCELLATION_TARGET = "https://www.w3.org/TR/";
const RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 45_000;
const TOTAL_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 1_000;
const REPORT_ID = /^[0-9]{8}-[0-9a-f]{32}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalNow(now) {
  return new Date(now()).toISOString();
}

function exactOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SCAN_BASE_URL must be an absolute scanner origin");
  }
  requireValue(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "SCAN_BASE_URL must be an exact credential-free HTTPS origin"
  );
  return url.origin;
}

function acceptedSubmission(value, label) {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.ok === true &&
      value.status === "queued" &&
      typeof value.jobId === "string" &&
      REPORT_ID.test(value.jobId) &&
      typeof value.reportId === "string" &&
      REPORT_ID.test(value.reportId) &&
      value.jobId !== value.reportId &&
      value.statusPath === `/api/scans/${value.jobId}` &&
      Object.keys(value).length === 5,
    `${label} did not return the exact durable queued-submission contract`
  );
  return {
    jobId: value.jobId,
    reportId: value.reportId,
    statusPath: value.statusPath
  };
}

function sameSubmission(left, right) {
  return (
    left.jobId === right.jobId &&
    left.reportId === right.reportId &&
    left.statusPath === right.statusPath
  );
}

function fixedReport(
  value,
  reportId,
  target,
  expectedDeploymentCommit,
  label
) {
  requireValue(
    isSupportedDeployedReport(value) &&
      value.schemaVersion === 2 &&
      value.schemaRevision === 2 &&
      value.reportType === "single" &&
      value.share?.id === reportId &&
      value.share?.jsonPath === `/api/reports/${reportId}` &&
      value.run?.subject?.requested?.origin ===
        new URL(target).origin &&
      value.run?.conditions?.gpc === true &&
      value.run?.conditions?.consent === "observe" &&
      value.run?.conditions?.device?.kind === "desktop" &&
      value.run?.conditions?.device?.viewport?.isMobile === false &&
      value.run?.provenance?.buildCommit ===
        expectedDeploymentCommit &&
      !savedReportRetainsScreenshot(value),
    `${label} did not return the exact fixed-target durable r2 report on the expected deployment`
  );
  return canonicalEvidenceDigest(value);
}

function readRegularNoFollow(filePath, maximumBytes, label) {
  let descriptor;
  try {
    descriptor = openSync(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    const info = fstatSync(descriptor);
    requireValue(
      info.isFile() &&
        info.size > 0 &&
        info.size <= maximumBytes,
      `${label} must be a bounded regular file`
    );
    const bytes = readFileSync(descriptor);
    requireValue(
      bytes.byteLength === info.size,
      `${label} changed while it was read`
    );
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function responseJson(response, label, maximumBytes) {
  requireValue(
    (response.headers.get("content-type") ?? "").includes(
      "application/json"
    ),
    `${label} returned non-JSON content`
  );
  const text = await readResponseTextWithinLimit(response, {
    maxBytes: maximumBytes,
    label
  });
  let value;
  try {
    value = parseStrictJson(text, maximumBytes);
  } catch {
    throw new Error(`${label} returned malformed or ambiguous JSON`);
  }
  return { value, bytes: Buffer.from(text, "utf8") };
}

export async function captureDurableSoakExercises(
  configuration,
  dependencies = {}
) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ??
    ((delayMs) =>
      new Promise((resolve) => setTimeout(resolve, delayMs)));
  const baseUrl = exactOrigin(configuration.baseUrl);
  requireValue(
    typeof configuration.monitorToken === "string" &&
      /^[\x21-\x7e]{32,256}$/.test(configuration.monitorToken),
    "the production synthetic monitor token is invalid"
  );
  requireValue(
    FULL_SHA.test(configuration.sourceCommit),
    "the exercise source commit must be a full lowercase Git commit"
  );
  requireValue(
    FULL_SHA.test(configuration.expectedDeploymentCommit),
    "the expected durable deployment must be a full lowercase Git commit"
  );
  requireValue(
    configuration.sourceCommit ===
      configuration.expectedDeploymentCommit,
    "the exercise workflow must run from the exact durable deployment commit"
  );
  requireValue(
    Buffer.isBuffer(configuration.configBytes) &&
      configuration.configBytes
        .toString("utf8")
        .includes('"SITE_BEHAVIOR_LAB_DURABLE_JOBS": "1"') &&
      !configuration.configBytes
        .toString("utf8")
        .includes('"SITE_BEHAVIOR_LAB_DURABLE_JOBS": "0"'),
    "the captured source does not preserve durable jobs enabled"
  );
  const sessionStartedAt = canonicalNow(now);
  const totalDeadline = now() + TOTAL_TIMEOUT_MS;
  const monitorHeaders = {
    [SYNTHETIC_MONITOR_HEADER]: configuration.monitorToken
  };

  async function request(pathname, init, label, maximumBytes = RESPONSE_MAX_BYTES) {
    requireValue(now() < totalDeadline, "durable soak exercises exceeded their total deadline");
    const url = new URL(pathname, `${baseUrl}/`);
    requireValue(
      url.origin === baseUrl &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      `${label} escaped the exact scanner origin`
    );
    return withHttpOperationDeadline(
      { timeoutMs: REQUEST_TIMEOUT_MS, label },
      async (signal) => {
        const response = await fetchImpl(url.href, {
          ...init,
          redirect: "error",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal
        });
        return {
          response,
          ...(await responseJson(
            response,
            label,
            maximumBytes
          ))
        };
      }
    );
  }

  const healthResult = await request(
    "/api/health",
    { method: "GET" },
    "durable soak production health",
    DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES
  );
  requireValue(
    healthResult.response.status === 200,
    `durable soak production health returned ${healthResult.response.status}`
  );
  verifyDurableSoakExerciseHealth(
    healthResult.value,
    configuration.expectedDeploymentCommit
  );
  const healthObservedAt = canonicalNow(now);

  async function submit(target, admission) {
    return request(
      "/api/scan",
      {
        method: "POST",
        headers: {
          ...monitorHeaders,
          "content-type": "application/json",
          ...admission.headers
        },
        body: JSON.stringify(admission.body)
      },
      `durable soak scan admission for ${target}`
    );
  }

  async function status(job, method = "GET") {
    return request(
      job.statusPath,
      { method },
      `durable soak ${method} ${job.statusPath}`
    );
  }

  const normalAdmission = prepareScanAdmission({
    url: NORMAL_TARGET,
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });
  const first = await submit(NORMAL_TARGET, normalAdmission);
  requireValue(
    first.response.status === 202,
    `normal durable admission returned ${first.response.status}`
  );
  const normalJob = acceptedSubmission(
    first.value,
    "normal durable admission"
  );
  const replay = await submit(NORMAL_TARGET, normalAdmission);
  requireValue(
    replay.response.status === 202,
    `duplicate durable admission returned ${replay.response.status}`
  );
  const replayJob = acceptedSubmission(
    replay.value,
    "duplicate durable admission"
  );
  requireValue(
    sameSubmission(normalJob, replayJob),
    "duplicate durable admission minted a second job/report identity"
  );
  const duplicateObservedAt = canonicalNow(now);

  let terminal;
  while (now() < totalDeadline) {
    const polled = await status(normalJob);
    requireValue(
      polled.response.status === 200,
      `normal durable status returned ${polled.response.status}`
    );
    if (polled.value?.status === "succeeded") {
      terminal = polled.value;
      break;
    }
    requireValue(
      polled.value?.status === "queued" ||
        polled.value?.status === "running",
      `normal durable job ended ${String(polled.value?.status)}`
    );
    await wait(POLL_INTERVAL_MS);
  }
  requireValue(terminal, "normal durable job did not finish inside the exercise deadline");
  const normalReportSha256 = fixedReport(
    terminal.report,
    normalJob.reportId,
    NORMAL_TARGET,
    configuration.expectedDeploymentCommit,
    "normal durable completion"
  );
  const normalObservedAt = canonicalNow(now);

  const recovered = await status(normalJob);
  requireValue(
    recovered.response.status === 200 &&
      recovered.value?.status === "succeeded",
    "completed durable status could not recover its saved report"
  );
  const recoveredReportSha256 = fixedReport(
    recovered.value.report,
    normalJob.reportId,
    NORMAL_TARGET,
    configuration.expectedDeploymentCommit,
    "completed durable report recovery"
  );
  requireValue(
    recoveredReportSha256 === normalReportSha256,
    "completed durable report recovery changed report bytes"
  );
  const direct = await request(
    `/api/reports/${normalJob.reportId}`,
    { method: "GET" },
    "completed durable report direct readback"
  );
  requireValue(
    direct.response.status === 200 &&
      fixedReport(
        direct.value,
        normalJob.reportId,
        NORMAL_TARGET,
        configuration.expectedDeploymentCommit,
        "completed durable report direct readback"
      ) === normalReportSha256,
    "completed durable report recovery did not match direct persisted readback"
  );
  const recoveredObservedAt = canonicalNow(now);

  const cancellationAdmission = prepareScanAdmission({
    url: CANCELLATION_TARGET,
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });
  const cancellationSubmitted = await submit(
    CANCELLATION_TARGET,
    cancellationAdmission
  );
  requireValue(
    cancellationSubmitted.response.status === 202,
    `cancellation durable admission returned ${cancellationSubmitted.response.status}`
  );
  const cancellationJob = acceptedSubmission(
    cancellationSubmitted.value,
    "cancellation durable admission"
  );
  requireValue(
    !sameSubmission(normalJob, cancellationJob),
    "cancellation admission reused the completed job/report identity"
  );
  const cancelled = await status(cancellationJob, "DELETE");
  requireValue(
    cancelled.response.status === 200 &&
      cancelled.value?.ok === true &&
      cancelled.value?.jobId === cancellationJob.jobId &&
      cancelled.value?.status === "cancelled",
    "durable cancellation did not produce an authoritative cancelled status"
  );
  const cancelledReadback = await status(cancellationJob);
  requireValue(
    cancelledReadback.response.status === 200 &&
      cancelledReadback.value?.ok === true &&
      cancelledReadback.value?.jobId === cancellationJob.jobId &&
      cancelledReadback.value?.status === "cancelled" &&
      !("report" in cancelledReadback.value),
    "durable cancellation was not stable on status readback"
  );
  const cancellationObservedAt = canonicalNow(now);
  const postHealthResult = await request(
    "/api/health",
    { method: "GET" },
    "durable soak post-exercise production health",
    DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES
  );
  requireValue(
    postHealthResult.response.status === 200,
    `durable soak post-exercise production health returned ${postHealthResult.response.status}`
  );
  verifyDurableSoakExerciseHealth(
    postHealthResult.value,
    configuration.expectedDeploymentCommit
  );
  const postHealthObservedAt = canonicalNow(now);
  const sessionCompletedAt = canonicalNow(now);

  const evidence = {
    schemaVersion: DURABLE_SOAK_EXERCISE_SCHEMA_VERSION,
    artifactKind: DURABLE_SOAK_EXERCISE_KIND,
    sourceCommit: configuration.sourceCommit,
    deploymentCommit: configuration.expectedDeploymentCommit,
    durableConfig: {
      path: DURABLE_SOAK_EXERCISE_CONFIG_PATH,
      sha256: sha256Bytes(configuration.configBytes)
    },
    health: {
      observedAt: healthObservedAt,
      sha256: sha256Bytes(healthResult.bytes)
    },
    postHealth: {
      observedAt: postHealthObservedAt,
      sha256: sha256Bytes(postHealthResult.bytes)
    },
    session: {
      startedAt: sessionStartedAt,
      completedAt: sessionCompletedAt
    },
    behaviors: [
      {
        id: "normal-completion",
        observedAt: normalObservedAt,
        jobId: normalJob.jobId,
        reportId: normalJob.reportId,
        reportSha256: normalReportSha256
      },
      {
        id: "cancellation",
        observedAt: cancellationObservedAt,
        jobId: cancellationJob.jobId,
        reportId: cancellationJob.reportId,
        status: "cancelled",
        responseSha256: canonicalEvidenceDigest(
          cancelledReadback.value
        )
      },
      {
        id: "completed-report-recovery",
        observedAt: recoveredObservedAt,
        jobId: normalJob.jobId,
        reportId: normalJob.reportId,
        reportSha256: recoveredReportSha256
      },
      {
        id: "duplicate-prevention",
        observedAt: duplicateObservedAt,
        jobId: normalJob.jobId,
        reportId: normalJob.reportId,
        firstStatus: first.response.status,
        replayStatus: replay.response.status,
        requestCommitmentSha256: sha256Bytes(
          normalAdmission.credential.requestCommitment
        )
      }
    ]
  };
  verifyDurableSoakExerciseEvidence(evidence, {
    healthBytes: healthResult.bytes,
    postHealthBytes: postHealthResult.bytes
  });
  return {
    evidence,
    evidenceBytes: Buffer.from(
      serializeDurableSoakExerciseEvidence(evidence),
      "utf8"
    ),
    healthBytes: healthResult.bytes,
    postHealthBytes: postHealthResult.bytes
  };
}

export function parseOptions(args) {
  requireValue(
    args[0] === "--capture" || args[0] === "--verify",
    "choose exactly --capture or --verify"
  );
  const mode = args[0].slice(2);
  const expected = mode === "capture"
    ? new Set(["--output-dir", "--expected-deployment"])
    : new Set(["--directory"]);
  const values = new Map();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    requireValue(
      expected.has(flag) &&
        typeof value === "string" &&
        value.length > 0 &&
        !values.has(flag),
      `invalid or duplicate option ${String(flag)}`
    );
    values.set(flag, value);
  }
  requireValue(
    values.size === expected.size &&
      [...expected].every((flag) => values.has(flag)),
    `${mode} requires exactly ${[...expected].join(", ")}`
  );
  if (mode === "capture") {
    requireValue(
      FULL_SHA.test(values.get("--expected-deployment")),
      "--expected-deployment must be a full lowercase Git commit"
    );
    return {
      mode,
      outputDirectory: path.resolve(values.get("--output-dir")),
      expectedDeploymentCommit: values.get("--expected-deployment")
    };
  }
  return {
    mode,
    directory: path.resolve(values.get("--directory"))
  };
}

function writeExclusive(filePath, bytes) {
  writeFileSync(filePath, bytes, {
    flag: "wx",
    mode: 0o600
  });
}

function verifyDirectory(directory) {
  const evidenceBytes = readRegularNoFollow(
    path.join(directory, DURABLE_SOAK_EXERCISE_FILE),
    DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES,
    "durable soak exercise evidence"
  );
  const healthBytes = readRegularNoFollow(
    path.join(directory, DURABLE_SOAK_EXERCISE_HEALTH_FILE),
    DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES,
    "durable soak exercise health"
  );
  const postHealthBytes = readRegularNoFollow(
    path.join(
      directory,
      DURABLE_SOAK_EXERCISE_POST_HEALTH_FILE
    ),
    DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES,
    "durable soak exercise post-health"
  );
  const evidence = parseDurableSoakExerciseEvidence(
    evidenceBytes.toString("utf8")
  );
  return verifyDurableSoakExerciseEvidence(evidence, {
    healthBytes,
    postHealthBytes
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.mode === "verify") {
    const verified = verifyDirectory(options.directory);
    process.stdout.write(
      `${JSON.stringify({ ok: true, ...verified })}\n`
    );
    return;
  }

  const root = process.cwd();
  const configBytes = readRegularNoFollow(
    path.join(root, DURABLE_SOAK_EXERCISE_CONFIG_PATH),
    DURABLE_SOAK_EXERCISE_MAX_FILE_BYTES,
    "durable production config"
  );
  const sourceCommit = (process.env.GITHUB_SHA ?? "").trim();
  const result = await captureDurableSoakExercises({
    baseUrl: (process.env.SCAN_BASE_URL ?? "").trim(),
    monitorToken: (
      process.env.PRODUCTION_SYNTHETIC_MONITOR_TOKEN ?? ""
    ).trim(),
    sourceCommit,
    expectedDeploymentCommit: options.expectedDeploymentCommit,
    configBytes
  });
  mkdirSync(options.outputDirectory, {
    recursive: false,
    mode: 0o700
  });
  try {
    writeExclusive(
      path.join(options.outputDirectory, DURABLE_SOAK_EXERCISE_FILE),
      result.evidenceBytes
    );
    writeExclusive(
      path.join(
        options.outputDirectory,
        DURABLE_SOAK_EXERCISE_HEALTH_FILE
      ),
      result.healthBytes
    );
    writeExclusive(
      path.join(
        options.outputDirectory,
        DURABLE_SOAK_EXERCISE_POST_HEALTH_FILE
      ),
      result.postHealthBytes
    );
  } catch (error) {
    throw new Error(
      `could not write a complete durable soak exercise directory: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const verified = verifyDirectory(options.outputDirectory);
  process.stdout.write(
    `${JSON.stringify({ ok: true, ...verified })}\n`
  );
}

const invokedPath =
  process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `FAIL ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
