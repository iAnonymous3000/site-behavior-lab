#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  canonicalPrettyJson,
  createCalibrationAcquisition,
  detectorPredictionFromRun,
  sha256Hex,
  validateCalibrationCandidateFiles,
  validateCalibrationCaseInputs,
  writeCalibrationAcquisition
} from "./calibration-study-lib.mjs";
import {
  validateCalibrationLabelRosterRunSelectionSnapshot
} from "./calibration-label-roster-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const candidateCommit = requiredEnv("CALIBRATION_CANDIDATE_COMMIT").toLowerCase();
const carrierCommit = requiredEnv("CALIBRATION_CARRIER_COMMIT").toLowerCase();
const acquisitionAuthorization = requiredBase64Json(
  "CALIBRATION_ACQUISITION_AUTHORIZATION_BASE64"
);
const rosterSelectionSnapshot =
  validateCalibrationLabelRosterRunSelectionSnapshot(
    requiredBase64Json(
      "CALIBRATION_ROSTER_SELECTION_SNAPSHOT_BASE64"
    ),
    {
      studyId: options.studyId,
      candidateCommit,
      carrierCommit,
      caseInputRootSha256:
        acquisitionAuthorization.caseInputRootSha256,
      selectedRunId: acquisitionAuthorization.roster.runId
    }
  );
const rosterSelectionSnapshotSha256 = requiredDigestEnv(
  "CALIBRATION_ROSTER_SELECTION_SNAPSHOT_SHA256"
);
if (
  sha256Hex(canonicalPrettyJson(rosterSelectionSnapshot)) !==
    rosterSelectionSnapshotSha256
) {
  throw new Error(
    "roster selection snapshot bytes do not match the hosted preflight digest"
  );
}
const checkoutCommit = git(["rev-parse", "HEAD"]).toLowerCase();
if (checkoutCommit !== candidateCommit) {
  throw new Error(
    `Calibration acquisition checkout ${checkoutCommit} does not equal frozen candidate ${candidateCommit}`
  );
}
if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("Frozen candidate checkout is dirty before acquisition");
}
const candidate = validateCalibrationCandidateFiles(rootDir, options.studyId);
if (candidate.detector !== options.detector) {
  throw new Error("Detector input does not match candidate preregistration");
}
const caseInputs = validateCalibrationCaseInputs({
  candidate,
  caseInputRoot: options.caseInputRoot
});
const requireFromRoot = createRequire(import.meta.url);
const reportView = requireFromRoot(
  path.join(rootDir, "dist", "schema", "lib", "scan-report-view.js")
);
const calibrationRuntime = requireFromRoot(
  path.join(
    rootDir,
    "dist",
    "calibration",
    "lib",
    "calibration-scan-runtime.js"
  )
);
const packageManifest = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));

const startedAt = new Date().toISOString();
const browser = await chromium.launch({ headless: true });
const browserVersion = browser.version();
await browser.close();
const runtime = {
  observer: "node-playwright",
  automation: "playwright-chromium",
  nodeVersion: packageManifest.engines.node,
  playwrightVersion: packageManifest.dependencies.playwright,
  browserName: "chromium",
  browserVersion,
  operatingSystem: process.platform,
  architecture: process.arch
};
if (process.versions.node !== runtime.nodeVersion) {
  throw new Error(
    `Executing Node ${process.versions.node} does not match candidate engine ${runtime.nodeVersion}`
  );
}

const caseResults = [];
for (const [index, calibrationCase] of caseInputs.entries()) {
  const label = `${index + 1}/${caseInputs.length} ${calibrationCase.caseId}`;
  process.stdout.write(`Acquiring ${label} ... `);
  try {
    const scanned = await calibrationRuntime.scanCalibrationCase(
      {
        url: calibrationCase.selection.url,
        device: calibrationCase.condition.request.device,
        gpcEnabled: calibrationCase.condition.request.gpcEnabled,
        consentMode: calibrationCase.condition.request.consentMode
      },
      candidate.detector
    );
    const publicReport = reportView.publicWireForExportOrPersistence(
      scanned.report
    );
    const sourceReportText = canonicalPrettyJson(publicReport);
    const recordedAt = new Date().toISOString();
    if (
      publicReport.schemaVersion !== 2 ||
      publicReport.schemaRevision !== 2 ||
      publicReport.reportType !== "single"
    ) {
      caseResults.push(
        censored(
          calibrationCase,
          "artifact-unreadable",
          sourceReportText,
          null,
          recordedAt
        )
      );
      console.log("censored (not a v2/r2 single report)");
      continue;
    }
    const run = publicReport.run;
    assertRunIdentity(
      run,
      candidateCommit,
      calibrationCase.selection.url,
      calibrationCase.condition.request,
      requiredEnv("CALIBRATION_EGRESS_REGION")
    );
    const reportSha256 = sha256Hex(sourceReportText);
    const detectorObservationText =
      candidate.detector === "consent-banner" &&
      scanned.consentBannerObservation !== null
        ? canonicalPrettyJson({
            schemaVersion: 1,
            artifactKind:
              "site-behavior-detector-calibration-private-observation",
            studyId: candidate.studyId,
            detector: candidate.detector,
            caseId: calibrationCase.caseId,
            sourceReportSha256: reportSha256,
            observation: scanned.consentBannerObservation
          })
        : null;
    const prediction =
      candidate.detector === "consent-banner"
        ? scanned.consentBannerPrediction
        : detectorPredictionFromRun(run, candidate.detector);
    if (prediction.outcome === "censored") {
      caseResults.push(
        censored(
          calibrationCase,
          prediction.reason,
          sourceReportText,
          detectorObservationText,
          recordedAt
        )
      );
      console.log(`censored (${prediction.reason})`);
      continue;
    }
    if (run.conditions.browser.version !== browserVersion) {
      throw fatal(
        `${calibrationCase.caseId} report browser ${run.conditions.browser.version} does not match independently observed runtime ${browserVersion}`
      );
    }
    caseResults.push({
      caseId: calibrationCase.caseId,
      outcome: "complete",
      selectionText: calibrationCase.selectionText,
      conditionText: calibrationCase.conditionText,
      selectionDigest: calibrationCase.selectionDigest,
      conditionDigest: calibrationCase.conditionDigest,
      prediction: prediction.value,
      sourceReportSha256: reportSha256,
      sourceReportText,
      detectorObservationText,
      recordedAt
    });
    console.log(prediction.value);
  } catch (error) {
    if (
      error?.fatal === true ||
      error?.code === "CALIBRATION_MEASUREMENT_INVALID"
    ) {
      throw error;
    }
    const recordedAt = new Date().toISOString();
    caseResults.push(
      censored(calibrationCase, "capture-failed", null, null, recordedAt)
    );
    console.log(
      `censored (capture-failed: ${
        error instanceof Error ? error.message.slice(0, 160) : "unknown error"
      })`
    );
  }
}

const created = createCalibrationAcquisition({
  candidate,
  candidateCommit,
  carrierCommit,
  acquisitionAuthorization,
  rosterSelectionSnapshot,
  rosterSelectionSnapshotSha256,
  workflowRun: {
    workflow:
      "iAnonymous3000/site-behavior-lab/.github/workflows/calibration-study.yml@refs/heads/main",
    id: positiveIntegerEnv("GITHUB_RUN_ID"),
    attempt: positiveIntegerEnv("GITHUB_RUN_ATTEMPT"),
    headCommit: carrierCommit
  },
  runner: {
    labelSha256: requiredEnv("CALIBRATION_RUNNER_LABEL_SHA256"),
    identitySha256: requiredEnv("CALIBRATION_RUNNER_IDENTITY_SHA256"),
    environment: "ephemeral-self-hosted"
  },
  egress: {
    identity: requiredEnv("CALIBRATION_EGRESS_IDENTITY"),
    regionSha256: requiredEnv("CALIBRATION_EGRESS_REGION_SHA256")
  },
  runtime,
  caseResults,
  startedAt,
  completedAt: new Date().toISOString()
});
writeCalibrationAcquisition(options.outputDir, created);
console.log(
  `Prepared label-free calibration acquisition: ${caseResults.filter((entry) => entry.outcome === "complete").length} complete, ` +
    `${caseResults.filter((entry) => entry.outcome === "censored").length} censored.`
);

function assertRunIdentity(run, candidate, requestedUrl, request, egressRegion) {
  if (
    run?.provenance?.buildCommit !== candidate ||
    run?.provenance?.observer !== "node-playwright" ||
    run?.provenance?.acquisition !== "ci-workflow"
  ) {
    throw fatal("scan provenance does not bind the frozen Node/Playwright candidate");
  }
  if (
    run?.conditions?.device?.kind !== request.device ||
    run?.conditions?.gpc !== request.gpcEnabled ||
    run?.conditions?.consent !== request.consentMode
  ) {
    throw fatal("scan conditions do not equal the frozen case condition");
  }
  if (
    run?.conditions?.egress?.region !== egressRegion ||
    run?.conditions?.browser?.name !== "chromium"
  ) {
    throw fatal("scan runtime egress or browser identity does not match the controlled lane");
  }
  const requested = new URL(requestedUrl);
  if (run?.subject?.requested?.registrableDomain !== registrableDomainHint(requested.hostname)) {
    // The canonical report identity remains authoritative. This conservative
    // suffix check catches the dangerous cross-case mix-up without attempting
    // to duplicate tldts/public-suffix normalization in this script.
    if (
      typeof run?.subject?.requested?.registrableDomain !== "string" ||
      !requested.hostname.endsWith(run.subject.requested.registrableDomain)
    ) {
      throw fatal("scan report subject does not match the frozen selection URL");
    }
  }
}

function registrableDomainHint(hostname) {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  return labels.length >= 2 ? labels.slice(-2).join(".") : hostname;
}

function censored(
  calibrationCase,
  reason,
  sourceReportText,
  detectorObservationText,
  recordedAt
) {
  return {
    caseId: calibrationCase.caseId,
    outcome: "censored",
    reason,
    selectionText: calibrationCase.selectionText,
    conditionText: calibrationCase.conditionText,
    selectionDigest: calibrationCase.selectionDigest,
    conditionDigest: calibrationCase.conditionDigest,
    sourceReportSha256:
      sourceReportText === null ? null : sha256Hex(sourceReportText),
    sourceReportText,
    detectorObservationText,
    recordedAt
  };
}

function fatal(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

function parseOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const argument = args[index];
    const value = args[index + 1];
    if (
      ![
        "--study-id",
        "--detector",
        "--case-input-root",
        "--output-dir",
      ].includes(
        argument
      ) ||
      !value ||
      value.startsWith("--") ||
      values.has(argument)
    ) {
      throw new Error(`Invalid acquisition argument ${argument ?? "(missing)"}`);
    }
    values.set(argument, value);
  }
  for (const name of [
    "--study-id",
    "--detector",
    "--case-input-root",
    "--output-dir"
  ]) {
    if (!values.has(name)) throw new Error(`Missing required argument ${name}`);
  }
  if (
    !path.isAbsolute(values.get("--case-input-root")) ||
    !path.isAbsolute(values.get("--output-dir"))
  ) {
    throw new Error("case input and output directories must be absolute");
  }
  return {
    studyId: values.get("--study-id"),
    detector: values.get("--detector"),
    caseInputRoot: values.get("--case-input-root"),
    outputDir: values.get("--output-dir")
  };
}

function positiveIntegerEnv(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredDigestEnv(name) {
  const value = requiredEnv(name).replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a sha256 digest`);
  }
  return value;
}

function requiredBase64Json(name) {
  const encoded = requiredEnv(name);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error(`${name} must be unpadded base64url`);
  }
  let text;
  try {
    text = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error(`${name} is not valid base64url`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${name} does not contain JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must contain one JSON object`);
  }
  return value;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}
