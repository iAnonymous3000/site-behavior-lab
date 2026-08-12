import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  aaPreregistrationIssues,
  aaTargetFramePath,
  evaluateAaStudy
} from "./aa-study-lib.mjs";
import {
  canonicalize,
  scannerFidelityAttemptLedgerIssues,
  scannerFidelitySitesOf,
  sha256Hex
} from "./scanner-fidelity-study-lib.mjs";

export const AA_PRODUCER_REPOSITORY = "iAnonymous3000/site-behavior-lab";
export const AA_PRODUCER_WORKFLOW_PATH = ".github/workflows/aa-study.yml";
export const AA_PRODUCER_WORKFLOW =
  `${AA_PRODUCER_REPOSITORY}/${AA_PRODUCER_WORKFLOW_PATH}@refs/heads/main`;
export const AA_ARCHIVE_WORKFLOW_PATH =
  ".github/workflows/archive-aa-study.yml";
export const AA_ARCHIVE_WORKFLOW =
  `${AA_PRODUCER_REPOSITORY}/${AA_ARCHIVE_WORKFLOW_PATH}@refs/heads/main`;
export const AA_ARTIFACT_KIND = "site-behavior-aa-study-artifact";
export const AA_PRODUCER_RECEIPT_KIND =
  "site-behavior-aa-producer-receipt";
export const AA_ARTIFACT_MANIFEST_FILE = "aa-artifact.json";
export const AA_PRODUCER_RECEIPT_FILE = "producer-receipt.json";
export const AA_PRODUCER_BUNDLE_FILE =
  "producer-receipt.sigstore.json";
export const AA_ORDER_POLICY = "alternating-ab-ba-by-repetition";
export const AA_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const CANONICAL_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ARTIFACT_NAME =
  /^site-behavior-aa-study-([a-z0-9][a-z0-9._-]{0,99})-([1-9][0-9]*)-([1-9][0-9]*)$/;
const EVIDENCE_FILES = Object.freeze([
  "attempt-ledger.json",
  "evaluation.json",
  "preregistration.json",
  "target-frame.json"
]);
const CONDITIONS_KEYS = Object.freeze([
  "consentMode",
  "device",
  "gpcEnabled",
  "mode"
]);
const COMPARISON_MODES = new Set(["consent", "gpc", "shields"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  requireValue(isRecord(value), `${label} must be an object`);
  requireValue(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort()),
    `${label} must contain exactly: ${[...expected].sort().join(", ")}`
  );
}

function canonicalInstant(value, label) {
  requireValue(
    typeof value === "string" &&
      CANONICAL_INSTANT.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(value)).toISOString() === value,
    `${label} must be a canonical UTC instant`
  );
  return value;
}

function fullSha(value, label) {
  requireValue(typeof value === "string" && FULL_SHA.test(value), `${label} must be a full lowercase Git SHA`);
  return value;
}

function digest(value, label) {
  requireValue(typeof value === "string" && SHA256.test(value), `${label} must be a lowercase sha256 digest`);
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed =
    typeof value === "string" && /^[1-9][0-9]*$/.test(value)
      ? Number(value)
      : value;
  requireValue(
    Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum,
    `${label} must be a bounded positive integer`
  );
  return parsed;
}

function strictJson(buffer, label) {
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  try {
    return { value: JSON.parse(decoded), text: decoded };
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function readRegular(file, maximum, label) {
  let descriptor;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    requireValue(
      info.isFile() && info.size > 0 && info.size <= maximum,
      `${label} must be a non-empty bounded regular file`
    );
    const bytes = readFileSync(descriptor);
    requireValue(bytes.byteLength === info.size, `${label} changed while being read`);
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function canonicalAaJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function aaArtifactName(studyId, runId, runAttempt) {
  requireValue(typeof studyId === "string" && TOKEN.test(studyId), "A/A study id is invalid");
  return `site-behavior-aa-study-${studyId}-${positiveInteger(runId, "run id")}-${positiveInteger(runAttempt, "run attempt", 100)}`;
}

/**
 * Private, trusted-process scheduling seam. The public API continues drawing
 * comparison order randomly. Only this dedicated producer injects the arm
 * selection directly into executePreparedScan.
 */
export function aaComparisonFirstArm(repetition) {
  const value = positiveInteger(repetition, "repetition", 1_000_000);
  return value % 2 === 1 ? "baseline" : "variant";
}

export function aaExecutionPlan(preregistration) {
  const issues = aaPreregistrationIssues(preregistration);
  requireValue(issues.length === 0, `A/A preregistration is invalid: ${issues.join("; ")}`);
  exactKeys(preregistration.conditions, CONDITIONS_KEYS, "A/A conditions");
  const { mode, device, gpcEnabled, consentMode } = preregistration.conditions;
  requireValue(
    mode === "single" || COMPARISON_MODES.has(mode),
    "A/A conditions.mode must be single, shields, gpc, or consent"
  );
  requireValue(device === "desktop" || device === "mobile", "A/A conditions.device is invalid");
  requireValue(typeof gpcEnabled === "boolean", "A/A conditions.gpcEnabled must be boolean");
  requireValue(consentMode === "observe", "A/A conditions.consentMode must be observe");
  const comparison = COMPARISON_MODES.has(mode);
  requireValue(
    preregistration.thresholds.requireCounterbalancedOrders === comparison,
    comparison
      ? "comparison A/A studies must preregister counterbalanced orders"
      : "single-run A/A studies cannot require comparison counterbalancing"
  );
  requireValue(
    !comparison ||
      (preregistration.repetitionsPerTarget >= 2 &&
        preregistration.repetitionsPerTarget % 2 === 0),
    "comparison A/A studies require an even number of at least two repetitions for exact AB/BA balance"
  );
  return {
    mode,
    device,
    gpcEnabled,
    consentMode,
    compareGpc: mode === "gpc",
    compareShields: mode === "shields",
    compareConsent: mode === "consent",
    rateLimitCost: comparison ? 2 : 1,
    orderPolicy: comparison ? AA_ORDER_POLICY : "not-applicable"
  };
}

export function createAaArtifact({
  studyId,
  candidateCommit,
  carrierCommit,
  runId,
  runAttempt,
  runner,
  egress,
  preregistrationText,
  targetFrameText,
  ledger,
  evaluation
}) {
  requireValue(TOKEN.test(studyId), "A/A study id is invalid");
  const candidate = fullSha(candidateCommit, "candidate commit");
  const carrier = fullSha(carrierCommit, "carrier commit");
  const run = positiveInteger(runId, "run id");
  const attempt = positiveInteger(runAttempt, "run attempt", 100);
  const preregistration = strictJson(Buffer.from(preregistrationText), "preregistration").value;
  const targetFrame = strictJson(Buffer.from(targetFrameText), "target frame").value;
  requireValue(preregistration.studyId === studyId, "preregistration study id does not match");
  requireValue(
    preregistration.sitesFile === aaTargetFramePath(studyId),
    "preregistration target frame path is not study-local"
  );
  aaExecutionPlan(preregistration);
  scannerFidelitySitesOf(targetFrame);
  const rederived = evaluateAaStudy({
    preregistration,
    targetFrame,
    targetFrameText,
    ledger
  });
  requireValue(
    rederived.status === "pass" &&
      JSON.stringify(evaluation) === JSON.stringify(rederived),
    "A/A evaluation must be a passing exact recomputation"
  );
  requireValue(
    scannerFidelityAttemptLedgerIssues(ledger, {
      requireMeasurementIdentityDigest: true
    }).length === 0,
    "A/A attempt ledger is malformed"
  );
  requireValue(
    ledger.provenance.expectedBuildCommit === candidate,
    "A/A ledger producer build does not equal the candidate"
  );
  requireValue(
    ledger.shard.index === 0 && ledger.shard.count === 1,
    "A/A producer must collect the complete frame unsharded"
  );
  const startedAt = canonicalInstant(ledger.collection.startedAt, "collection.startedAt");
  const completedAt = canonicalInstant(ledger.collection.completedAt, "collection.completedAt");
  requireValue(
    Date.parse(startedAt) <= Date.parse(completedAt) &&
      Date.parse(completedAt) <= Date.parse(ledger.createdAt),
    "A/A collection chronology is invalid"
  );
  exactKeys(runner, ["environment", "identitySha256", "labelSha256"], "runner");
  requireValue(runner.environment === "ephemeral-self-hosted", "A/A collection runner must be ephemeral-self-hosted");
  digest(runner.identitySha256, "runner identity");
  digest(runner.labelSha256, "runner label");
  exactKeys(egress, ["identity", "regionSha256"], "egress");
  requireValue(egress.identity === "controlled-self-hosted", "A/A collection egress identity is invalid");
  digest(egress.regionSha256, "egress region");

  const texts = new Map([
    ["preregistration.json", preregistrationText],
    ["target-frame.json", targetFrameText],
    ["attempt-ledger.json", canonicalAaJson(ledger)],
    ["evaluation.json", canonicalAaJson(evaluation)]
  ]);
  const files = [...texts.entries()]
    .map(([filePath, fileText]) => ({
      path: filePath,
      bytes: Buffer.byteLength(fileText),
      sha256: sha256Hex(fileText)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: 1,
    artifactKind: AA_ARTIFACT_KIND,
    studyId,
    candidateCommit: candidate,
    producer: {
      workflow: AA_PRODUCER_WORKFLOW,
      runId: run,
      runAttempt: attempt,
      runHeadCommit: carrier,
      checkoutCommit: candidate
    },
    runner: structuredClone(runner),
    egress: structuredClone(egress),
    collection: { startedAt, completedAt },
    execution: {
      shardIndex: 0,
      shardCount: 1,
      exactAttemptSet: true,
      orderPolicy: aaExecutionPlan(preregistration).orderPolicy
    },
    files
  };
  return {
    manifest,
    manifestText: canonicalAaJson(manifest),
    files: [...texts.entries()].map(([filePath, fileText]) => ({
      path: filePath,
      text: fileText
    }))
  };
}

export function writeAaArtifact(outputDirectory, created) {
  requireValue(!existsSync(outputDirectory), "A/A artifact output already exists");
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  for (const file of created.files) {
    writeFileSync(path.join(outputDirectory, file.path), file.text, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  }
  writeFileSync(
    path.join(outputDirectory, AA_ARTIFACT_MANIFEST_FILE),
    created.manifestText,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
}

export function inspectAaArtifact(directory, expected = {}) {
  const root = realpathSync(directory);
  const observed = readRegular(
    path.join(root, AA_ARTIFACT_MANIFEST_FILE),
    4 * 1024 * 1024,
    "A/A artifact manifest"
  );
  const parsed = strictJson(observed, "A/A artifact manifest");
  const manifest = parsed.value;
  requireValue(parsed.text === canonicalAaJson(manifest), "A/A artifact manifest is not canonical JSON");
  exactKeys(
    manifest,
    [
      "artifactKind",
      "candidateCommit",
      "collection",
      "egress",
      "execution",
      "files",
      "producer",
      "runner",
      "schemaVersion",
      "studyId"
    ],
    "A/A artifact manifest"
  );
  requireValue(
    manifest.schemaVersion === 1 && manifest.artifactKind === AA_ARTIFACT_KIND,
    "A/A artifact manifest identity is invalid"
  );
  requireValue(TOKEN.test(manifest.studyId), "A/A artifact study id is invalid");
  fullSha(manifest.candidateCommit, "A/A artifact candidate");
  exactKeys(
    manifest.producer,
    ["checkoutCommit", "runAttempt", "runHeadCommit", "runId", "workflow"],
    "A/A artifact producer"
  );
  requireValue(manifest.producer.workflow === AA_PRODUCER_WORKFLOW, "A/A artifact workflow is invalid");
  requireValue(manifest.producer.checkoutCommit === manifest.candidateCommit, "A/A artifact checkout does not equal candidate");
  fullSha(manifest.producer.runHeadCommit, "A/A artifact run head");
  positiveInteger(manifest.producer.runId, "A/A artifact run id");
  positiveInteger(manifest.producer.runAttempt, "A/A artifact run attempt", 100);
  exactKeys(manifest.collection, ["completedAt", "startedAt"], "A/A artifact collection");
  canonicalInstant(manifest.collection.startedAt, "A/A artifact collection.startedAt");
  canonicalInstant(manifest.collection.completedAt, "A/A artifact collection.completedAt");
  requireValue(
    Date.parse(manifest.collection.startedAt) <= Date.parse(manifest.collection.completedAt),
    "A/A artifact collection chronology is invalid"
  );
  exactKeys(
    manifest.execution,
    ["exactAttemptSet", "orderPolicy", "shardCount", "shardIndex"],
    "A/A artifact execution"
  );
  requireValue(
    manifest.execution.shardIndex === 0 &&
      manifest.execution.shardCount === 1 &&
      manifest.execution.exactAttemptSet === true &&
      (manifest.execution.orderPolicy === AA_ORDER_POLICY ||
        manifest.execution.orderPolicy === "not-applicable"),
    "A/A artifact must prove one complete, unsharded, deterministic execution"
  );
  requireValue(Array.isArray(manifest.files) && manifest.files.length === 4, "A/A artifact must enumerate four evidence files");
  const directoryEntries = readdirSync(root, { withFileTypes: true });
  requireValue(
    directoryEntries.every((entry) => entry.isFile()) &&
      JSON.stringify(directoryEntries.map((entry) => entry.name).sort()) ===
        JSON.stringify([AA_ARTIFACT_MANIFEST_FILE, ...EVIDENCE_FILES].sort()),
    "A/A artifact directory must contain exactly five regular files"
  );
  const declaredPaths = manifest.files.map((entry) => entry?.path);
  requireValue(
    JSON.stringify(declaredPaths) === JSON.stringify(EVIDENCE_FILES),
    "A/A artifact evidence files are not the exact sorted set"
  );
  const values = new Map();
  let aggregateBytes = observed.byteLength;
  for (const entry of manifest.files) {
    exactKeys(entry, ["bytes", "path", "sha256"], `A/A artifact ${entry.path}`);
    digest(entry.sha256, `A/A artifact ${entry.path} digest`);
    requireValue(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= AA_ARTIFACT_MAX_BYTES, `A/A artifact ${entry.path} size is invalid`);
    const bytes = readRegular(path.join(root, entry.path), AA_ARTIFACT_MAX_BYTES, `A/A artifact ${entry.path}`);
    aggregateBytes += bytes.byteLength;
    requireValue(
      aggregateBytes <= AA_ARTIFACT_MAX_BYTES,
      "A/A artifact uncompressed aggregate exceeds its 64 MiB bound"
    );
    requireValue(bytes.byteLength === entry.bytes && sha256Hex(bytes) === entry.sha256, `A/A artifact ${entry.path} bytes do not match the manifest`);
    values.set(entry.path, strictJson(bytes, `A/A artifact ${entry.path}`));
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined) requireValue(manifest[key] === expectedValue, `A/A artifact ${key} does not match`);
  }
  const preregistration = values.get("preregistration.json");
  const targetFrame = values.get("target-frame.json");
  const ledger = values.get("attempt-ledger.json");
  const evaluation = values.get("evaluation.json");
  requireValue(preregistration && targetFrame && ledger && evaluation, "A/A artifact values are incomplete");
  requireValue(
    ledger.text === canonicalAaJson(ledger.value),
    "A/A attempt ledger is not canonical JSON"
  );
  requireValue(
    preregistration.value.studyId === manifest.studyId &&
      ledger.value.collection.startedAt === manifest.collection.startedAt &&
      ledger.value.collection.completedAt === manifest.collection.completedAt,
    "A/A artifact manifest disagrees with its study or collection"
  );
  const rederived = evaluateAaStudy({
    preregistration: preregistration.value,
    targetFrame: targetFrame.value,
    targetFrameText: targetFrame.text,
    ledger: ledger.value
  });
  requireValue(
    rederived.status === "pass" &&
      evaluation.text === canonicalAaJson(rederived),
    "A/A artifact evaluation is not a passing exact recomputation"
  );
  requireValue(
    ledger.value.shard?.index === 0 &&
      ledger.value.shard?.count === 1 &&
      ledger.value.provenance?.expectedBuildCommit ===
        manifest.candidateCommit,
    "A/A artifact ledger does not prove unsharded candidate collection"
  );
  return {
    root,
    manifest,
    manifestSha256: sha256Hex(observed),
    preregistration: preregistration.value,
    targetFrame: targetFrame.value,
    targetFrameText: targetFrame.text,
    ledger: ledger.value,
    evaluation: evaluation.value,
    files: manifest.files
  };
}

export function validateAaGithubMetadata(input) {
  const runId = positiveInteger(input.runId, "run id");
  const runAttempt = positiveInteger(input.runAttempt, "run attempt", 100);
  const artifactId = positiveInteger(input.artifactId, "artifact id");
  const expectedName = aaArtifactName(input.studyId, runId, runAttempt);
  requireValue(input.artifactName === expectedName && ARTIFACT_NAME.test(expectedName), "A/A artifact name is invalid");
  const archiveSha256 = digest(
    String(input.archiveSha256).replace(/^sha256:/, ""),
    "A/A archive digest"
  );
  const run = strictJson(
    readRegular(input.runMetadataPath, 1024 * 1024, "Actions run metadata"),
    "Actions run metadata"
  ).value;
  requireValue(
    run?.id === runId &&
      run?.run_attempt === runAttempt &&
      run?.event === "workflow_dispatch" &&
      run?.path === AA_PRODUCER_WORKFLOW_PATH &&
      run?.head_branch === "main" &&
      run?.head_sha === input.runHeadCommit &&
      run?.status === "completed" &&
      run?.conclusion === "success" &&
      run?.repository?.full_name === AA_PRODUCER_REPOSITORY,
    "Actions run metadata does not identify one successful governed A/A workflow run on main"
  );
  const artifactResponse = strictJson(
    readRegular(input.artifactMetadataPath, 1024 * 1024, "Actions artifact metadata"),
    "Actions artifact metadata"
  ).value;
  const artifacts = Array.isArray(artifactResponse?.artifacts)
    ? artifactResponse.artifacts
    : [artifactResponse];
  if (Array.isArray(artifactResponse?.artifacts)) {
    requireValue(
      Number.isSafeInteger(artifactResponse.total_count) &&
        artifactResponse.total_count === artifacts.length &&
        artifacts.length <= 100,
      "Actions A/A artifact metadata is malformed or paginated"
    );
  }
  const matches = artifacts.filter(
    (artifact) =>
      artifact?.id === artifactId && artifact?.name === expectedName
  );
  requireValue(matches.length === 1, "Actions metadata does not identify exactly one A/A artifact");
  const artifact = matches[0];
  requireValue(
    artifact.expired === false &&
      artifact.workflow_run?.id === runId &&
      artifact.workflow_run?.head_sha === input.runHeadCommit &&
      digest(String(artifact.digest).replace(/^sha256:/, ""), "live A/A artifact digest") === archiveSha256 &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= AA_ARTIFACT_MAX_BYTES,
    "Actions artifact metadata does not bind the expected A/A archive"
  );
  return { runId, runAttempt, artifactId, artifactName: expectedName, archiveSha256 };
}

export function createAaProducerReceipt({
  artifactInspection,
  metadata,
  attesterCommit,
  recordedAt
}) {
  const { manifest, ledger, evaluation } = artifactInspection;
  const timestamp = canonicalInstant(recordedAt, "producer receipt recordedAt");
  requireValue(
    Date.parse(manifest.collection.completedAt) <= Date.parse(timestamp),
    "producer receipt must be recorded after collection"
  );
  const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  return {
    schemaVersion: 1,
    artifactKind: AA_PRODUCER_RECEIPT_KIND,
    studyId: manifest.studyId,
    producer: {
      ...structuredClone(manifest.producer),
      conclusion: "success"
    },
    attester: {
      workflow: AA_ARCHIVE_WORKFLOW,
      sourceCommit: fullSha(attesterCommit, "A/A attester commit")
    },
    artifact: {
      id: metadata.artifactId,
      name: metadata.artifactName,
      archiveSha256: metadata.archiveSha256,
      manifestPath: AA_ARTIFACT_MANIFEST_FILE,
      manifestSha256: artifactInspection.manifestSha256
    },
    collection: structuredClone(manifest.collection),
    execution: {
      ...structuredClone(manifest.execution),
      runner: structuredClone(manifest.runner),
      egress: structuredClone(manifest.egress)
    },
    evidence: {
      preregistration: {
        path: "preregistration.json",
        sha256: byPath.get("preregistration.json").sha256
      },
      targetFrame: {
        path: "target-frame.json",
        sha256: byPath.get("target-frame.json").sha256
      },
      attemptLedger: {
        path: "attempt-ledger.json",
        sha256: byPath.get("attempt-ledger.json").sha256,
        receiptDigest: ledger.receiptDigest
      },
      evaluation: {
        path: "evaluation.json",
        sha256: byPath.get("evaluation.json").sha256,
        evaluationDigest: evaluation.evaluationDigest
      }
    },
    recordedAt: timestamp
  };
}

export function aaProducerReceiptIssues(receipt) {
  const issues = [];
  try {
    exactKeys(
      receipt,
      [
        "artifact",
        "artifactKind",
        "attester",
        "collection",
        "evidence",
        "execution",
        "producer",
        "recordedAt",
        "schemaVersion",
        "studyId"
      ],
      "A/A producer receipt"
    );
    requireValue(receipt.schemaVersion === 1 && receipt.artifactKind === AA_PRODUCER_RECEIPT_KIND, "A/A producer receipt identity is invalid");
    requireValue(typeof receipt.studyId === "string" && TOKEN.test(receipt.studyId), "A/A producer receipt study id is invalid");
    exactKeys(receipt.producer, ["checkoutCommit", "conclusion", "runAttempt", "runHeadCommit", "runId", "workflow"], "A/A producer receipt producer");
    requireValue(receipt.producer.workflow === AA_PRODUCER_WORKFLOW && receipt.producer.conclusion === "success", "A/A producer receipt workflow or conclusion is invalid");
    fullSha(receipt.producer.checkoutCommit, "A/A producer receipt checkout");
    fullSha(receipt.producer.runHeadCommit, "A/A producer receipt run head");
    positiveInteger(receipt.producer.runId, "A/A producer receipt run id");
    positiveInteger(receipt.producer.runAttempt, "A/A producer receipt run attempt", 100);
    exactKeys(receipt.attester, ["sourceCommit", "workflow"], "A/A producer receipt attester");
    requireValue(receipt.attester.workflow === AA_ARCHIVE_WORKFLOW, "A/A producer receipt attester workflow is invalid");
    fullSha(receipt.attester.sourceCommit, "A/A producer receipt attester source commit");
    exactKeys(receipt.artifact, ["archiveSha256", "id", "manifestPath", "manifestSha256", "name"], "A/A producer receipt artifact");
    positiveInteger(receipt.artifact.id, "A/A producer receipt artifact id");
    requireValue(
      receipt.artifact.name ===
        aaArtifactName(receipt.studyId, receipt.producer.runId, receipt.producer.runAttempt),
      "A/A producer receipt artifact name is invalid"
    );
    digest(receipt.artifact.archiveSha256, "A/A producer receipt archive digest");
    requireValue(receipt.artifact.manifestPath === AA_ARTIFACT_MANIFEST_FILE, "A/A producer receipt manifest path is invalid");
    digest(receipt.artifact.manifestSha256, "A/A producer receipt manifest digest");
    exactKeys(receipt.collection, ["completedAt", "startedAt"], "A/A producer receipt collection");
    const startedAt = canonicalInstant(receipt.collection.startedAt, "A/A producer receipt collection.startedAt");
    const completedAt = canonicalInstant(receipt.collection.completedAt, "A/A producer receipt collection.completedAt");
    const recordedAt = canonicalInstant(receipt.recordedAt, "A/A producer receipt recordedAt");
    requireValue(
      Date.parse(startedAt) <= Date.parse(completedAt) &&
        Date.parse(completedAt) <= Date.parse(recordedAt),
      "A/A producer receipt chronology is invalid"
    );
    exactKeys(receipt.execution, ["egress", "exactAttemptSet", "orderPolicy", "runner", "shardCount", "shardIndex"], "A/A producer receipt execution");
    requireValue(receipt.execution.shardIndex === 0 && receipt.execution.shardCount === 1 && receipt.execution.exactAttemptSet === true, "A/A producer receipt must prove exact unsharded execution");
    requireValue(receipt.execution.orderPolicy === AA_ORDER_POLICY || receipt.execution.orderPolicy === "not-applicable", "A/A producer receipt order policy is invalid");
    exactKeys(receipt.execution.runner, ["environment", "identitySha256", "labelSha256"], "A/A producer receipt runner");
    requireValue(receipt.execution.runner.environment === "ephemeral-self-hosted", "A/A producer receipt runner is not ephemeral self-hosted");
    digest(receipt.execution.runner.identitySha256, "A/A producer receipt runner identity");
    digest(receipt.execution.runner.labelSha256, "A/A producer receipt runner label");
    exactKeys(receipt.execution.egress, ["identity", "regionSha256"], "A/A producer receipt egress");
    requireValue(receipt.execution.egress.identity === "controlled-self-hosted", "A/A producer receipt egress is invalid");
    digest(receipt.execution.egress.regionSha256, "A/A producer receipt egress region");
    exactKeys(receipt.evidence, ["attemptLedger", "evaluation", "preregistration", "targetFrame"], "A/A producer receipt evidence");
    const evidenceShapes = {
      preregistration: ["path", "sha256"],
      targetFrame: ["path", "sha256"],
      attemptLedger: ["path", "receiptDigest", "sha256"],
      evaluation: ["evaluationDigest", "path", "sha256"]
    };
    const expectedPaths = {
      preregistration: "preregistration.json",
      targetFrame: "target-frame.json",
      attemptLedger: "attempt-ledger.json",
      evaluation: "evaluation.json"
    };
    for (const [key, keys] of Object.entries(evidenceShapes)) {
      exactKeys(receipt.evidence[key], keys, `A/A producer receipt evidence.${key}`);
      requireValue(receipt.evidence[key].path === expectedPaths[key], `A/A producer receipt evidence.${key} path is invalid`);
      digest(receipt.evidence[key].sha256, `A/A producer receipt evidence.${key} digest`);
    }
    digest(receipt.evidence.attemptLedger.receiptDigest, "A/A ledger receipt digest");
    digest(receipt.evidence.evaluation.evaluationDigest, "A/A evaluation digest");
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return issues;
}

export function verifyAaProducerReceiptAgainstArtifact(receipt, inspection) {
  const issues = aaProducerReceiptIssues(receipt);
  requireValue(issues.length === 0, issues.join("; "));
  const expected = createAaProducerReceipt({
    artifactInspection: inspection,
    metadata: {
      artifactId: receipt.artifact.id,
      artifactName: receipt.artifact.name,
      archiveSha256: receipt.artifact.archiveSha256
    },
    attesterCommit: receipt.attester.sourceCommit,
    recordedAt: receipt.recordedAt
  });
  requireValue(
    canonicalize(receipt) === canonicalize(expected),
    "A/A producer receipt does not exactly describe the archived artifact"
  );
  return expected;
}

export function addAaStudyEvidenceToMeasurementBinding(
  rootDirectory,
  studyId,
  receipt
) {
  const root = realpathSync(rootDirectory);
  const bindingPath = path.join(root, "research", "measurement-candidate-binding.json");
  const bindingRead = strictJson(
    readRegular(bindingPath, 16 * 1024 * 1024, "measurement candidate binding"),
    "measurement candidate binding"
  );
  const binding = bindingRead.value;
  requireValue(bindingRead.text === canonicalAaJson(binding), "measurement candidate binding is not canonical JSON");
  requireValue(isRecord(binding) && Array.isArray(binding.evidence), "measurement candidate binding has no evidence array");
  requireValue(binding.candidateCommit === receipt.producer.checkoutCommit, "A/A receipt candidate does not match the measurement binding");
  const rootPath = `research/aa-studies/${studyId}`;
  const entries = [
    {
      category: "aa-attempt-ledger",
      path: `${rootPath}/attempt-ledger.json`,
      change: "added",
      sha256: receipt.evidence.attemptLedger.sha256
    },
    {
      category: "aa-evaluation",
      path: `${rootPath}/evaluation.json`,
      change: "added",
      sha256: receipt.evidence.evaluation.sha256
    },
    {
      category: "aa-producer-receipt",
      path: `${rootPath}/${AA_PRODUCER_RECEIPT_FILE}`,
      change: "added",
      sha256: sha256Hex(canonicalAaJson(receipt))
    },
    {
      category: "aa-producer-attestation",
      path: `${rootPath}/${AA_PRODUCER_BUNDLE_FILE}`,
      change: "added",
      sha256: sha256Hex(
        readRegular(
          path.join(root, rootPath, AA_PRODUCER_BUNDLE_FILE),
          16 * 1024 * 1024,
          "A/A producer attestation bundle"
        )
      )
    }
  ];
  const existingPaths = new Set(binding.evidence.map((entry) => entry?.path));
  requireValue(entries.every((entry) => !existingPaths.has(entry.path)), "measurement binding already enumerates this A/A study");
  binding.evidence.push(...entries);
  binding.evidence.sort((left, right) =>
    String(left.path).localeCompare(String(right.path))
  );
  let descriptor;
  try {
    descriptor = openSync(
      bindingPath,
      fsConstants.O_WRONLY |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW
    );
    writeFileSync(descriptor, canonicalAaJson(binding), "utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return entries;
}
