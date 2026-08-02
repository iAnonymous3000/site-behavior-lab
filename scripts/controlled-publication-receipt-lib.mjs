import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTROLLED_PUBLICATION_SCHEMA_VERSION = 1;
export const CONTROLLED_PUBLICATION_ARTIFACT_KIND =
  "site-behavior-controlled-r2-publication-receipt";
export const CONTROLLED_PUBLICATION_KIND = "featured";
export const CONTROLLED_PUBLICATION_REPORT_MODE = "r2";
export const CONTROLLED_PUBLICATION_ROOT =
  "research/controlled-publications";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPORT_ID = /^[0-9]{8}-[0-9a-f]{32}$/;
const ARTIFACT_NAME =
  /^site-behavior-featured-publication-([1-9][0-9]*)-([1-9][0-9]*)$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
// Mirror the authoritative publication-validator ceilings. The receipt layer
// must never reject an artifact solely because its duplicate local bounds
// drifted below the contract that already validated it.
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 16 * 1024;
const MAX_ARCHIVE_BYTES = 528 * 1024 * 1024;
const MAX_REPORTS = 10_000;
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const TRUSTED_ARCHIVE_CLI = path.join(
  REPOSITORY_ROOT,
  "dist",
  "schema",
  "lib",
  "report-publication-archive-cli.js"
);
let trustedArchiveParserReady = false;

const RECEIPT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "publicationKind",
  "reportMode",
  "actionsRun",
  "publicationArtifact",
  "reports"
];
const ACTIONS_RUN_KEYS = ["id", "attempt", "sourceCommit"];
const PUBLICATION_ARTIFACT_KEYS = [
  "id",
  "name",
  "archiveSha256",
  "manifestSha256"
];
const REPORT_KEYS = [
  "id",
  "reportPath",
  "reportSha256",
  "provenancePath",
  "provenanceSha256"
];
const MANIFEST_KEYS = [
  "schemaVersion",
  "sourceCommit",
  "publicationKind",
  "reportMode",
  "expectedReportIds",
  "files"
];
const MANIFEST_FILE_KEYS = ["path", "bytes", "sha256"];
const CREATE_INPUT_KEYS = [
  "checkoutRoot",
  "metadataPath",
  "archivePath",
  "artifactId",
  "artifactName",
  "artifactDigest",
  "runId",
  "sourceCommit",
  "outputDirectory"
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactKeys(value, expected, label, issues) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    issues.push(`${label} must contain exactly: ${wanted.join(", ")}`);
    return false;
  }
  return true;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])])
  );
}

export function canonicalControlledPublicationReceiptText(receipt) {
  return `${JSON.stringify(canonicalValue(receipt), null, 2)}\n`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedDigest(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a sha256 digest`);
  const normalized = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!SHA256.test(normalized)) throw new Error(`${label} must be a sha256 digest`);
  return normalized;
}

function safeId(value, label) {
  const string = String(value);
  if (!/^[1-9][0-9]*$/.test(string)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(string);
  if (!positiveSafeInteger(parsed)) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function readRegularNoFollow(file, maximum, label) {
  let descriptor;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size <= 0 || info.size > maximum) {
      throw new Error(`${label} must be a non-empty regular file no larger than ${maximum} bytes`);
    }
    const contents = readFileSync(descriptor);
    if (contents.byteLength !== info.size) throw new Error(`${label} changed while being read`);
    return contents;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function strictUtf8Json(buffer, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  try {
    return { value: JSON.parse(text), text };
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function parsePublicationManifest(buffer, expectedSourceCommit) {
  const { value, text } = strictUtf8Json(buffer, "publication manifest");
  const issues = [];
  if (!exactKeys(value, MANIFEST_KEYS, "publication manifest", issues)) {
    throw new Error(issues.join("; "));
  }
  if (value.schemaVersion !== 1) throw new Error("publication manifest schemaVersion must be 1");
  if (value.sourceCommit !== expectedSourceCommit) {
    throw new Error("publication manifest sourceCommit does not match the expected producer commit");
  }
  if (value.publicationKind !== CONTROLLED_PUBLICATION_KIND) {
    throw new Error("publication manifest publicationKind must be featured");
  }
  if (value.reportMode !== CONTROLLED_PUBLICATION_REPORT_MODE) {
    throw new Error("publication manifest reportMode must be r2");
  }
  if (
    !Array.isArray(value.expectedReportIds) ||
    value.expectedReportIds.length === 0 ||
    value.expectedReportIds.length > MAX_REPORTS ||
    value.expectedReportIds.some((id) => typeof id !== "string" || !REPORT_ID.test(id))
  ) {
    throw new Error("publication manifest expectedReportIds must be a non-empty bounded report-id array");
  }
  const expectedReportIds = [...value.expectedReportIds].sort();
  if (
    new Set(expectedReportIds).size !== expectedReportIds.length ||
    JSON.stringify(value.expectedReportIds) !== JSON.stringify(expectedReportIds)
  ) {
    throw new Error("publication manifest expectedReportIds must be unique and sorted");
  }
  if (
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_REPORTS * 2 + 2
  ) {
    throw new Error("publication manifest files must be a non-empty bounded array");
  }
  const paths = [];
  for (const [index, entry] of value.files.entries()) {
    const entryIssues = [];
    if (!exactKeys(entry, MANIFEST_FILE_KEYS, `publication manifest files[${index}]`, entryIssues)) {
      throw new Error(entryIssues.join("; "));
    }
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.length > 100 ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`publication manifest files[${index}].path is invalid`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      throw new Error(`publication manifest files[${index}].bytes must be positive`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      throw new Error(`publication manifest files[${index}].sha256 is invalid`);
    }
    paths.push(entry.path);
  }
  if (
    new Set(paths).size !== paths.length ||
    JSON.stringify(paths) !== JSON.stringify([...paths].sort())
  ) {
    throw new Error("publication manifest file paths must be unique and sorted");
  }

  // Reconstruct the acquisition writer's schema order instead of serializing
  // the parsed object's input order. This catches duplicate keys, alternate
  // key ordering, trailing data, and other byte-level ambiguity before those
  // exact bytes are archived.
  const canonicalManifest = {
    schemaVersion: value.schemaVersion,
    sourceCommit: value.sourceCommit,
    publicationKind: value.publicationKind,
    reportMode: value.reportMode,
    expectedReportIds: value.expectedReportIds,
    files: value.files.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256
    }))
  };
  if (text !== `${JSON.stringify(canonicalManifest, null, 2)}\n`) {
    throw new Error("publication manifest bytes are not canonical acquisition JSON");
  }
  return value;
}

function reportEntriesFromManifest({
  manifest,
  artifactDir,
  checkoutRoot
}) {
  const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  return manifest.expectedReportIds.map((id) => {
    const reportArtifactPath = `reports/${id}.json`;
    const provenanceArtifactPath = `reports/${id}.provenance.json`;
    const reportDeclaration = byPath.get(reportArtifactPath);
    const provenanceDeclaration = byPath.get(provenanceArtifactPath);
    if (!reportDeclaration || !provenanceDeclaration) {
      throw new Error(`publication manifest is missing the expected report pair for ${id}`);
    }
    if (artifactDir !== undefined) {
      const artifactReport = readRegularNoFollow(
        path.join(artifactDir, ...reportArtifactPath.split("/")),
        MAX_REPORT_BYTES,
        `artifact report ${id}`
      );
      const artifactProvenance = readRegularNoFollow(
        path.join(artifactDir, ...provenanceArtifactPath.split("/")),
        MAX_PROVENANCE_BYTES,
        `artifact provenance ${id}`
      );
      if (
        artifactReport.byteLength !== reportDeclaration.bytes ||
        sha256Hex(artifactReport) !== reportDeclaration.sha256
      ) {
        throw new Error(`artifact report ${id} does not match publication.json`);
      }
      if (
        artifactProvenance.byteLength !== provenanceDeclaration.bytes ||
        sha256Hex(artifactProvenance) !== provenanceDeclaration.sha256
      ) {
        throw new Error(`artifact provenance ${id} does not match publication.json`);
      }
    }

    const reportPath = `public/reports/${id}.json`;
    const provenancePath = `public/reports/${id}.provenance.json`;
    const publishedReport = readRegularNoFollow(
      path.join(checkoutRoot, ...reportPath.split("/")),
      MAX_REPORT_BYTES,
      `published report ${id}`
    );
    const publishedProvenance = readRegularNoFollow(
      path.join(checkoutRoot, ...provenancePath.split("/")),
      MAX_PROVENANCE_BYTES,
      `published provenance ${id}`
    );
    if (
      publishedReport.byteLength !== reportDeclaration.bytes ||
      sha256Hex(publishedReport) !== reportDeclaration.sha256
    ) {
      throw new Error(`published report ${id} differs from the validated artifact`);
    }
    if (
      publishedProvenance.byteLength !== provenanceDeclaration.bytes ||
      sha256Hex(publishedProvenance) !== provenanceDeclaration.sha256
    ) {
      throw new Error(`published provenance ${id} differs from the validated artifact`);
    }
    return {
      id,
      reportPath,
      reportSha256: reportDeclaration.sha256,
      provenancePath,
      provenanceSha256: provenanceDeclaration.sha256
    };
  });
}

function ensureTrustedArchiveParser() {
  if (trustedArchiveParserReady) return;
  // This entry point authenticates publication bytes for governed evidence.
  // A caller-controlled "dist ready" environment value must never authorize
  // stale compiled parser code. Compile the trusted source once per process,
  // then permit only that just-built output in the child extractor.
  execFileSync(
    process.execPath,
    [
      path.join(REPOSITORY_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      "tsconfig.schema.json"
    ],
    {
      cwd: REPOSITORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000
    }
  );
  trustedArchiveParserReady = true;
}

function extractAuthenticatedPublicationArchive({
  metadataPath,
  archivePath,
  artifactId,
  artifactName,
  artifactDigest,
  runId,
  sourceCommit
}) {
  ensureTrustedArchiveParser();
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "sbl-controlled-publication-")
  );
  chmodSync(temporaryRoot, 0o700);
  const artifactDir = path.join(temporaryRoot, "artifact");
  try {
    execFileSync(
      process.execPath,
      [
        TRUSTED_ARCHIVE_CLI,
        "--extract",
        "--metadata",
        metadataPath,
        "--archive",
        archivePath,
        "--artifact-dir",
        artifactDir,
        "--artifact-id",
        String(artifactId),
        "--artifact-name",
        artifactName,
        "--run-id",
        String(runId),
        "--source-commit",
        sourceCommit,
        "--digest",
        artifactDigest
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY: "1"
        },
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 2 * 1024 * 1024
      }
    );
    return {
      artifactDir,
      cleanup() {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    const detail =
      Buffer.isBuffer(error?.stderr)
        ? error.stderr.toString("utf8").trim().slice(0, 500)
        : "";
    throw new Error(
      `trusted publication archive extraction failed${
        detail ? `: ${detail}` : ""
      }`
    );
  }
}

function expectedControlledPublicationDirectory(checkoutRoot, runId, runAttempt) {
  return path.join(
    checkoutRoot,
    CONTROLLED_PUBLICATION_ROOT,
    `${runId}-${runAttempt}`
  );
}

function assertExactArchiveDirectory(directory) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("controlled publication archive must be a real directory");
  }
  const entries = readdirSync(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(["publication.json", "receipt.json"])
  ) {
    throw new Error(
      "controlled publication archive must contain exactly publication.json and receipt.json"
    );
  }
  if (
    entries.some(
      (entry) => !entry.isFile() || entry.isSymbolicLink()
    )
  ) {
    throw new Error("controlled publication archive entries must be regular files");
  }
}

function ensureOutputParent(checkoutRoot) {
  const research = path.join(checkoutRoot, "research");
  const researchInfo = lstatSync(research);
  if (!researchInfo.isDirectory() || researchInfo.isSymbolicLink()) {
    throw new Error("checkout research path must be a real directory");
  }
  const root = path.join(checkoutRoot, CONTROLLED_PUBLICATION_ROOT);
  try {
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("controlled publication root must be a real directory");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(root, { recursive: false, mode: 0o700 });
  }
  return root;
}

export function controlledPublicationReceiptIssues(receipt, options = {}) {
  const issues = [];
  const push = (message) => issues.push(message);
  if (!exactKeys(receipt, RECEIPT_KEYS, "receipt", issues)) return issues;
  if (receipt.schemaVersion !== CONTROLLED_PUBLICATION_SCHEMA_VERSION) {
    push("schemaVersion must be exactly 1");
  }
  if (receipt.artifactKind !== CONTROLLED_PUBLICATION_ARTIFACT_KIND) {
    push(`artifactKind must be exactly ${CONTROLLED_PUBLICATION_ARTIFACT_KIND}`);
  }
  if (receipt.publicationKind !== CONTROLLED_PUBLICATION_KIND) {
    push("publicationKind must be exactly featured");
  }
  if (receipt.reportMode !== CONTROLLED_PUBLICATION_REPORT_MODE) {
    push("reportMode must be exactly r2");
  }

  if (exactKeys(receipt.actionsRun, ACTIONS_RUN_KEYS, "actionsRun", issues)) {
    if (!positiveSafeInteger(receipt.actionsRun.id)) push("actionsRun.id must be positive");
    if (!positiveSafeInteger(receipt.actionsRun.attempt)) push("actionsRun.attempt must be positive");
    if (
      typeof receipt.actionsRun.sourceCommit !== "string" ||
      !FULL_SHA.test(receipt.actionsRun.sourceCommit)
    ) {
      push("actionsRun.sourceCommit must be a full lowercase Git commit");
    }
  }
  if (
    exactKeys(
      receipt.publicationArtifact,
      PUBLICATION_ARTIFACT_KEYS,
      "publicationArtifact",
      issues
    )
  ) {
    if (!positiveSafeInteger(receipt.publicationArtifact.id)) {
      push("publicationArtifact.id must be positive");
    }
    const expectedName =
      positiveSafeInteger(receipt.actionsRun?.id) &&
      positiveSafeInteger(receipt.actionsRun?.attempt)
        ? `site-behavior-featured-publication-${receipt.actionsRun.id}-${receipt.actionsRun.attempt}`
        : "";
    if (receipt.publicationArtifact.name !== expectedName) {
      push("publicationArtifact.name must bind the exact run id and attempt");
    }
    for (const field of ["archiveSha256", "manifestSha256"]) {
      if (
        typeof receipt.publicationArtifact[field] !== "string" ||
        !SHA256.test(receipt.publicationArtifact[field])
      ) {
        push(`publicationArtifact.${field} must be a lowercase sha256 digest`);
      }
    }
  }

  if (
    !Array.isArray(receipt.reports) ||
    receipt.reports.length === 0 ||
    receipt.reports.length > MAX_REPORTS
  ) {
    push("reports must be a non-empty bounded array");
  } else {
    let priorId = "";
    const ids = new Set();
    for (const [index, report] of receipt.reports.entries()) {
      const label = `reports[${index}]`;
      if (!exactKeys(report, REPORT_KEYS, label, issues)) continue;
      if (
        typeof report.id !== "string" ||
        !REPORT_ID.test(report.id) ||
        ids.has(report.id) ||
        (priorId && report.id <= priorId)
      ) {
        push(`${label}.id must be a unique sorted report id`);
      }
      ids.add(report.id);
      priorId = report.id;
      if (report.reportPath !== `public/reports/${report.id}.json`) {
        push(`${label}.reportPath must bind its exact report id`);
      }
      if (
        report.provenancePath !==
        `public/reports/${report.id}.provenance.json`
      ) {
        push(`${label}.provenancePath must bind its exact report id`);
      }
      for (const field of ["reportSha256", "provenanceSha256"]) {
        if (typeof report[field] !== "string" || !SHA256.test(report[field])) {
          push(`${label}.${field} must be a lowercase sha256 digest`);
        }
      }
    }
  }

  for (const [actual, expected, label] of [
    [receipt.actionsRun?.id, options.expectedRunId, "actionsRun.id"],
    [
      receipt.actionsRun?.attempt,
      options.expectedRunAttempt,
      "actionsRun.attempt"
    ],
    [
      receipt.actionsRun?.sourceCommit,
      options.expectedSourceCommit,
      "actionsRun.sourceCommit"
    ],
    [
      receipt.publicationArtifact?.id,
      options.expectedArtifactId,
      "publicationArtifact.id"
    ],
    [
      receipt.publicationArtifact?.archiveSha256,
      options.expectedArchiveSha256,
      "publicationArtifact.archiveSha256"
    ],
    [
      receipt.publicationArtifact?.manifestSha256,
      options.expectedManifestSha256,
      "publicationArtifact.manifestSha256"
    ]
  ]) {
    if (expected !== undefined && actual !== expected) {
      push(`${label} does not match the expected value`);
    }
  }
  if (
    options.expectedReportIds !== undefined &&
    JSON.stringify(
      Array.isArray(receipt.reports)
        ? receipt.reports.map((entry) =>
            isRecord(entry) ? entry.id : null
          )
        : null
    ) !==
      JSON.stringify(options.expectedReportIds)
  ) {
    push("reports do not match expectedReportIds");
  }
  return issues;
}

export function parseAndVerifyControlledPublicationReceipt(text, options = {}) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    return { ok: false, issues: ["receipt is not valid JSON"], receipt: null };
  }
  const issues = [];
  if (text !== canonicalControlledPublicationReceiptText(receipt)) {
    issues.push("receipt bytes are not canonical sorted two-space JSON with one trailing newline");
  }
  issues.push(...controlledPublicationReceiptIssues(receipt, options));
  return { ok: issues.length === 0, issues, receipt };
}

export function verifyControlledPublicationDirectory(input) {
  const checkoutRoot = path.resolve(input.checkoutRoot);
  const runId = safeId(input.runId, "run id");
  const runAttempt = safeId(input.runAttempt, "run attempt");
  if (
    typeof input.sourceCommit !== "string" ||
    !FULL_SHA.test(input.sourceCommit)
  ) {
    throw new Error("source commit must be a full lowercase Git commit");
  }
  const directory = path.resolve(input.directory);
  if (
    directory !==
    expectedControlledPublicationDirectory(checkoutRoot, runId, runAttempt)
  ) {
    throw new Error("controlled publication directory does not match the run id and attempt");
  }
  assertExactArchiveDirectory(directory);
  const publicationBytes = readRegularNoFollow(
    path.join(directory, "publication.json"),
    MAX_MANIFEST_BYTES,
    "archived publication manifest"
  );
  const manifest = parsePublicationManifest(
    publicationBytes,
    input.sourceCommit
  );
  const receiptBytes = readRegularNoFollow(
    path.join(directory, "receipt.json"),
    MAX_MANIFEST_BYTES,
    "controlled publication receipt"
  );
  const receiptText = new TextDecoder("utf-8", { fatal: true }).decode(
    receiptBytes
  );
  const result = parseAndVerifyControlledPublicationReceipt(receiptText, {
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
    expectedSourceCommit: input.sourceCommit,
    expectedArtifactId:
      input.artifactId === undefined
        ? undefined
        : safeId(input.artifactId, "artifact id"),
    expectedArchiveSha256:
      input.archiveSha256 === undefined
        ? undefined
        : normalizedDigest(input.archiveSha256, "archive digest"),
    expectedManifestSha256: sha256Hex(publicationBytes),
    expectedReportIds: manifest.expectedReportIds
  });
  if (!result.ok) throw new Error(result.issues.join("; "));

  const derivedReports = reportEntriesFromManifest({
    manifest,
    checkoutRoot
  });
  // The archived directory intentionally contains publication.json and
  // receipt.json only, not a second copy of every report. Re-bind the report
  // bytes through their committed public paths instead.
  if (
    JSON.stringify(canonicalValue(result.receipt.reports)) !==
    JSON.stringify(canonicalValue(derivedReports))
  ) {
    throw new Error("receipt report pairs do not match publication.json and committed bytes");
  }
  return {
    receipt: result.receipt,
    manifest,
    receiptSha256: sha256Hex(receiptBytes),
    manifestSha256: sha256Hex(publicationBytes)
  };
}

/**
 * Re-derive a committed controlled-publication receipt from the exact raw
 * GitHub artifact metadata and ZIP retained by hosted-evidence provenance.
 * This is read-only: unlike createControlledPublicationArchive it never
 * writes a receipt or trusts an already-extracted artifact directory.
 */
export function verifyControlledPublicationArtifact(input) {
  const checkoutRoot = path.resolve(input.checkoutRoot);
  const receipt = input.receipt;
  const receiptIssues = controlledPublicationReceiptIssues(receipt);
  if (receiptIssues.length > 0) {
    throw new Error(receiptIssues.join("; "));
  }
  const authenticated = extractAuthenticatedPublicationArchive({
    metadataPath: input.metadataPath,
    archivePath: input.archivePath,
    artifactId: receipt.publicationArtifact.id,
    artifactName: receipt.publicationArtifact.name,
    artifactDigest: receipt.publicationArtifact.archiveSha256,
    runId: receipt.actionsRun.id,
    sourceCommit: receipt.actionsRun.sourceCommit
  });
  try {
    const archive = readRegularNoFollow(
      input.archivePath,
      MAX_ARCHIVE_BYTES,
      "publication archive"
    );
    if (
      sha256Hex(archive) !==
      receipt.publicationArtifact.archiveSha256
    ) {
      throw new Error(
        "publication archive bytes changed after authenticated extraction"
      );
    }
    const publicationBytes = readRegularNoFollow(
      path.join(authenticated.artifactDir, "publication.json"),
      MAX_MANIFEST_BYTES,
      "authenticated publication manifest"
    );
    const manifest = parsePublicationManifest(
      publicationBytes,
      receipt.actionsRun.sourceCommit
    );
    const reports = reportEntriesFromManifest({
      manifest,
      artifactDir: authenticated.artifactDir,
      checkoutRoot
    });
    if (
      receipt.publicationArtifact.manifestSha256 !==
        sha256Hex(publicationBytes) ||
      JSON.stringify(canonicalValue(receipt.reports)) !==
        JSON.stringify(canonicalValue(reports))
    ) {
      throw new Error(
        "controlled publication receipt does not derive from the retained authenticated artifact"
      );
    }
    return {
      receipt,
      manifest,
      reports,
      archiveSha256: sha256Hex(archive),
      manifestSha256: sha256Hex(publicationBytes)
    };
  } finally {
    authenticated.cleanup();
  }
}

export function createControlledPublicationArchive(input) {
  const inputIssues = [];
  if (!exactKeys(input, CREATE_INPUT_KEYS, "create input", inputIssues)) {
    throw new Error(inputIssues.join("; "));
  }
  const checkoutRoot = path.resolve(input.checkoutRoot);
  const runId = safeId(input.runId, "run id");
  const artifactId = safeId(input.artifactId, "artifact id");
  const archiveSha256 = normalizedDigest(
    input.artifactDigest,
    "artifact digest"
  );
  if (typeof input.sourceCommit !== "string" || !FULL_SHA.test(input.sourceCommit)) {
    throw new Error("source commit must be a full lowercase Git commit");
  }
  const nameMatch = ARTIFACT_NAME.exec(input.artifactName ?? "");
  if (!nameMatch || Number(nameMatch[1]) !== runId) {
    throw new Error("artifact name must bind the exact featured run id");
  }
  const runAttempt = safeId(nameMatch[2], "artifact run attempt");
  const authenticated = extractAuthenticatedPublicationArchive({
    metadataPath: input.metadataPath,
    archivePath: input.archivePath,
    artifactId,
    artifactName: input.artifactName,
    artifactDigest: archiveSha256,
    runId,
    sourceCommit: input.sourceCommit
  });

  try {
    // Hash the same authenticated raw archive again for the committed receipt.
    // All manifest and report bytes below come only from its fresh, bounded
    // extraction; no caller-supplied artifact directory is accepted.
    const archive = readRegularNoFollow(
      input.archivePath,
      MAX_ARCHIVE_BYTES,
      "publication archive"
    );
    if (sha256Hex(archive) !== archiveSha256) {
      throw new Error(
        "publication archive bytes changed after authenticated extraction"
      );
    }
    const publicationBytes = readRegularNoFollow(
      path.join(authenticated.artifactDir, "publication.json"),
      MAX_MANIFEST_BYTES,
      "authenticated publication manifest"
    );
    const manifest = parsePublicationManifest(
      publicationBytes,
      input.sourceCommit
    );
    const reports = reportEntriesFromManifest({
      manifest,
      artifactDir: authenticated.artifactDir,
      checkoutRoot
    });
    const receipt = {
      schemaVersion: CONTROLLED_PUBLICATION_SCHEMA_VERSION,
      artifactKind: CONTROLLED_PUBLICATION_ARTIFACT_KIND,
      publicationKind: CONTROLLED_PUBLICATION_KIND,
      reportMode: CONTROLLED_PUBLICATION_REPORT_MODE,
      actionsRun: {
        id: runId,
        attempt: runAttempt,
        sourceCommit: input.sourceCommit
      },
      publicationArtifact: {
        id: artifactId,
        name: input.artifactName,
        archiveSha256,
        manifestSha256: sha256Hex(publicationBytes)
      },
      reports
    };
    const receiptIssues = controlledPublicationReceiptIssues(receipt, {
      expectedReportIds: manifest.expectedReportIds
    });
    if (receiptIssues.length > 0) throw new Error(receiptIssues.join("; "));

    const root = ensureOutputParent(checkoutRoot);
    const outputDirectory = path.join(root, `${runId}-${runAttempt}`);
    if (path.resolve(input.outputDirectory) !== outputDirectory) {
      throw new Error("output directory must be the exact controlled-publication run path");
    }
    mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
    writeFileSync(
      path.join(outputDirectory, "publication.json"),
      publicationBytes,
      { flag: "wx", mode: 0o600 }
    );
    const receiptText = canonicalControlledPublicationReceiptText(receipt);
    writeFileSync(path.join(outputDirectory, "receipt.json"), receiptText, {
      flag: "wx",
      mode: 0o600
    });
    return {
      outputDirectory,
      relativePath: path
        .relative(checkoutRoot, outputDirectory)
        .split(path.sep)
        .join("/"),
      receipt,
      receiptSha256: sha256Hex(receiptText),
      manifestSha256: sha256Hex(publicationBytes)
    };
  } finally {
    authenticated.cleanup();
  }
}
