import {
  serializeContainerImagePackageInventory
} from "./container-image-package-inventory-lib.mjs";
import {
  parseContainerLegalEvidenceRef,
  validateContainerPackageReviewReadiness
} from "./container-image-package-reviews-lib.mjs";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  canonicalEvidenceDigest,
  exactKeys,
  requireCanonicalInstant,
  requireCommit,
  requireSha256,
  serializeCanonicalEvidence,
  sha256Bytes
} from "./operator-evidence-common.mjs";

export const CONTAINER_LICENSING_EVIDENCE_KIND =
  "site-behavior-container-image-licensing-receipt";
export const CONTAINER_LICENSING_EVIDENCE_SCHEMA_VERSION = 1;
export const CONTAINER_LICENSING_EVIDENCE_PATH =
  "research/ops-evidence/container-image-licensing.json";
export const CONTAINER_PACKAGE_INVENTORY_PATH =
  "research/measurement-candidate/site-behavior-lab-container-package-inventory.json";
export const CONTAINER_PACKAGE_REVIEW_LEDGER_PATH =
  "CONTAINER_IMAGE_PACKAGE_REVIEWS.json";

const RECEIPT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "candidateCommit",
  "deploymentCommit",
  "capturedAt",
  "inputs",
  "containerImageDigest",
  "packageInventoryDigest",
  "packageSetDigest",
  "reviewLedgerDigest",
  "legalEvidence",
  "reviewSummary"
];
const INPUTS_KEYS = ["inventory", "reviewLedger"];
const INPUT_KEYS = ["path", "sha256"];
const SUMMARY_KEYS = ["total", "reviewed", "unreviewed"];
const LEGAL_EVIDENCE_KEYS = [
  "kind",
  "reference",
  "repositoryPath",
  "sha256"
];
const MAX_LOCAL_LEGAL_EVIDENCE_BYTES = 8 * 1024 * 1024;

export function containerPackageInventoryDigest(inventoryBytes) {
  return sha256Bytes(inventoryBytes);
}

export function containerReviewLedgerDigest(ledgerBytes) {
  return sha256Bytes(ledgerBytes);
}

function canonicalReviewLedgerBytes(ledger) {
  const canonical = {
    schemaVersion: ledger?.schemaVersion,
    artifactKind: ledger?.artifactKind,
    inventoryPackageSetDigest: ledger?.inventoryPackageSetDigest,
    notice: ledger?.notice,
    reviews: Array.isArray(ledger?.reviews)
      ? ledger.reviews.map((row) => ({
          key: row?.key,
          inventoryEvidenceDigest: row?.inventoryEvidenceDigest,
          status: row?.status,
          determinedLicense: row?.determinedLicense,
          licenseEvidenceRefs: row?.licenseEvidenceRefs,
          obligations: Array.isArray(row?.obligations)
            ? row.obligations.map((obligation) => ({
                requirement: obligation?.requirement,
                disposition: obligation?.disposition,
                evidenceRefs: obligation?.evidenceRefs
              }))
            : row?.obligations,
          reviewer: row?.reviewer,
          reviewedAt: row?.reviewedAt,
          notes: row?.notes
        }))
      : ledger?.reviews
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function legalEvidenceRefs(ledger) {
  const refs = [];
  for (const row of Array.isArray(ledger?.reviews) ? ledger.reviews : []) {
    if (row?.status !== "reviewed") continue;
    if (Array.isArray(row.licenseEvidenceRefs)) {
      refs.push(...row.licenseEvidenceRefs);
    }
    for (const obligation of Array.isArray(row.obligations)
      ? row.obligations
      : []) {
      if (Array.isArray(obligation?.evidenceRefs)) {
        refs.push(...obligation.evidenceRefs);
      }
    }
  }
  return [...new Set(refs)].sort((left, right) => left.localeCompare(right));
}

function legalEvidenceBindings(ledger) {
  return legalEvidenceRefs(ledger).map((reference) => {
    const parsed = parseContainerLegalEvidenceRef(reference);
    if (!parsed.ok) {
      throw new Error(`invalid legal evidence reference ${JSON.stringify(reference)}`);
    }
    return {
      kind: parsed.kind,
      reference,
      repositoryPath:
        parsed.kind === "repository-file" ? parsed.path : null,
      sha256: parsed.sha256
    };
  });
}

function runGit(root, args, { maximumBytes = 64 * 1024 } = {}) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: null,
    maxBuffer: maximumBytes
  });
}

function repositoryEvidenceProblems(
  ledger,
  repositoryRoot,
  candidateCommit
) {
  const problems = [];
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    return [
      "repositoryRoot is required to verify repository legal evidence against the accepted candidate"
    ];
  }
  let rootReal;
  try {
    rootReal = realpathSync(path.resolve(repositoryRoot));
  } catch {
    return ["repositoryRoot must identify an existing real directory"];
  }
  const topLevel = runGit(rootReal, ["rev-parse", "--show-toplevel"]);
  if (topLevel.status !== 0) {
    return ["repositoryRoot must identify a Git repository root"];
  }
  let gitRoot;
  try {
    gitRoot = realpathSync(
      Buffer.from(topLevel.stdout ?? Buffer.alloc(0))
        .toString("utf8")
        .trim()
    );
  } catch {
    return ["repositoryRoot must identify a Git repository root"];
  }
  if (gitRoot !== rootReal) {
    return ["repositoryRoot must be the exact Git repository root"];
  }
  for (const evidenceRef of legalEvidenceRefs(ledger)) {
    const parsed = parseContainerLegalEvidenceRef(evidenceRef);
    if (!parsed.ok || parsed.kind !== "repository-file") continue;
    const requested = path.resolve(rootReal, parsed.path);
    const relative = path.relative(rootReal, requested);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      problems.push(`${evidenceRef} escapes the repository root`);
      continue;
    }
    let resolved;
    try {
      resolved = realpathSync(requested);
    } catch {
      problems.push(`${evidenceRef} does not identify an existing local file`);
      continue;
    }
    if (resolved !== requested) {
      problems.push(
        `${evidenceRef} must identify a real regular file without symbolic links`
      );
      continue;
    }
    let descriptor;
    try {
      descriptor = openSync(
        requested,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      );
      const info = fstatSync(descriptor);
      if (!info.isFile()) {
        problems.push(`${evidenceRef} must identify a real regular file`);
        continue;
      }
      if (info.size < 1 || info.size > MAX_LOCAL_LEGAL_EVIDENCE_BYTES) {
        problems.push(
          `${evidenceRef} must contain 1 through ${MAX_LOCAL_LEGAL_EVIDENCE_BYTES} bytes`
        );
        continue;
      }
      const bytes = readFileSync(descriptor);
      const finalPathInfo = lstatSync(requested);
      if (
        finalPathInfo.isSymbolicLink() ||
        finalPathInfo.dev !== info.dev ||
        finalPathInfo.ino !== info.ino ||
        realpathSync(requested) !== requested
      ) {
        problems.push(`${evidenceRef} changed while it was being verified`);
        continue;
      }
      const digest = sha256Bytes(bytes);
      if (digest !== parsed.sha256) {
        problems.push(`${evidenceRef} digest does not match the local file bytes`);
      }
    } catch {
      problems.push(
        `${evidenceRef} could not be opened without following a symbolic link`
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    const objectRef = `${candidateCommit}:${parsed.path}`;
    const objectType = runGit(rootReal, ["cat-file", "-t", objectRef]);
    if (
      objectType.status !== 0 ||
      Buffer.from(objectType.stdout ?? Buffer.alloc(0))
        .toString("utf8")
        .trim() !== "blob"
    ) {
      problems.push(
        `${evidenceRef} must identify a Git-tracked blob at candidateCommit`
      );
      continue;
    }
    const candidateBlob = runGit(
      rootReal,
      ["cat-file", "blob", objectRef],
      { maximumBytes: MAX_LOCAL_LEGAL_EVIDENCE_BYTES + 1 }
    );
    if (
      candidateBlob.status !== 0 ||
      !(candidateBlob.stdout instanceof Uint8Array)
    ) {
      problems.push(
        `${evidenceRef} candidate Git blob could not be read exactly`
      );
      continue;
    }
    const candidateBytes = Buffer.from(candidateBlob.stdout);
    if (
      candidateBytes.length < 1 ||
      candidateBytes.length > MAX_LOCAL_LEGAL_EVIDENCE_BYTES
    ) {
      problems.push(
        `${evidenceRef} candidate Git blob must contain 1 through ${MAX_LOCAL_LEGAL_EVIDENCE_BYTES} bytes`
      );
      continue;
    }
    if (sha256Bytes(candidateBytes) !== parsed.sha256) {
      problems.push(
        `${evidenceRef} digest does not match the candidate Git blob bytes`
      );
    }
  }
  return problems;
}

function dependencyProblems({
  receipt,
  inventory,
  ledger,
  inventoryBytes,
  ledgerBytes,
  now,
  repositoryRoot
}) {
  const problems = [];
  if (inventory === undefined || ledger === undefined) {
    problems.push("exact inventory and review ledger objects are required");
    return { problems, review: null };
  }
  let canonicalInventoryBytes;
  try {
    canonicalInventoryBytes = serializeContainerImagePackageInventory(inventory);
  } catch (error) {
    problems.push(
      `container inventory is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { problems, review: null };
  }
  const canonicalLedgerBytes = canonicalReviewLedgerBytes(ledger);
  if (inventoryBytes !== canonicalInventoryBytes) {
    problems.push("container inventory bytes are not the canonical inventory serialization");
  }
  if (ledgerBytes !== canonicalLedgerBytes) {
    problems.push("container review-ledger bytes are not the canonical ledger serialization");
  }
  const review = validateContainerPackageReviewReadiness(inventory, ledger, { now });
  if (!review.ok || !review.bindings) {
    problems.push(
      `container package review is incomplete: ${review.problems.join("; ")}`
    );
    return { problems, review };
  }
  problems.push(
    ...repositoryEvidenceProblems(
      ledger,
      repositoryRoot,
      review.bindings.candidateCommit
    )
  );
  let expectedLegalEvidence = null;
  try {
    expectedLegalEvidence = legalEvidenceBindings(ledger);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (
    expectedLegalEvidence !== null &&
    JSON.stringify(receipt.legalEvidence) !==
      JSON.stringify(expectedLegalEvidence)
  ) {
    problems.push(
      "legalEvidence must enumerate the exact content-addressed review evidence set"
    );
  }
  const inventoryDigest = containerPackageInventoryDigest(canonicalInventoryBytes);
  const ledgerDigest = containerReviewLedgerDigest(canonicalLedgerBytes);
  const expected = {
    candidateCommit: review.bindings.candidateCommit,
    deploymentCommit: review.bindings.candidateCommit,
    containerImageDigest: review.bindings.containerImageDigest,
    packageInventoryDigest: inventoryDigest,
    packageSetDigest: review.bindings.packageSetDigest,
    reviewLedgerDigest: ledgerDigest
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (receipt[field] !== expectedValue) {
      problems.push(`${field} must be derived from the exact container evidence`);
    }
  }
  if (receipt.inputs?.inventory?.path !== CONTAINER_PACKAGE_INVENTORY_PATH) {
    problems.push(`inputs.inventory.path must be exactly ${CONTAINER_PACKAGE_INVENTORY_PATH}`);
  }
  if (receipt.inputs?.inventory?.sha256 !== inventoryDigest) {
    problems.push("inputs.inventory.sha256 must hash the exact canonical inventory bytes");
  }
  if (receipt.inputs?.reviewLedger?.path !== CONTAINER_PACKAGE_REVIEW_LEDGER_PATH) {
    problems.push(
      `inputs.reviewLedger.path must be exactly ${CONTAINER_PACKAGE_REVIEW_LEDGER_PATH}`
    );
  }
  if (receipt.inputs?.reviewLedger?.sha256 !== ledgerDigest) {
    problems.push("inputs.reviewLedger.sha256 must hash the exact canonical review-ledger bytes");
  }
  const summary = review.summary;
  if (
    receipt.reviewSummary?.total !== summary.total ||
    receipt.reviewSummary?.reviewed !== summary.reviewed ||
    receipt.reviewSummary?.unreviewed !== summary.unreviewed
  ) {
    problems.push("reviewSummary must be derived from the complete exact-image review");
  }
  return { problems, review };
}

export function validateContainerImageLicensingEvidence(
  value,
  {
    inventory,
    ledger,
    inventoryBytes,
    ledgerBytes,
    now,
    repositoryRoot
  } = {}
) {
  const problems = [];
  if (!exactKeys(value, RECEIPT_KEYS, "container licensing receipt", problems)) {
    return { ok: false, problems, bindings: null, receiptDigest: null };
  }
  if (value.schemaVersion !== CONTAINER_LICENSING_EVIDENCE_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be exactly ${CONTAINER_LICENSING_EVIDENCE_SCHEMA_VERSION}`
    );
  }
  if (value.artifactKind !== CONTAINER_LICENSING_EVIDENCE_KIND) {
    problems.push(`artifactKind must be exactly ${CONTAINER_LICENSING_EVIDENCE_KIND}`);
  }
  requireCommit(value.candidateCommit, "candidateCommit", problems);
  requireCommit(value.deploymentCommit, "deploymentCommit", problems);
  requireCanonicalInstant(value.capturedAt, "capturedAt", problems);
  if (exactKeys(value.inputs, INPUTS_KEYS, "inputs", problems)) {
    for (const field of INPUTS_KEYS) {
      if (exactKeys(value.inputs[field], INPUT_KEYS, `inputs.${field}`, problems)) {
        requireSha256(value.inputs[field].sha256, `inputs.${field}.sha256`, problems);
      }
    }
  }
  for (const field of [
    "containerImageDigest",
    "packageInventoryDigest",
    "packageSetDigest",
    "reviewLedgerDigest"
  ]) {
    requireSha256(value[field], field, problems);
  }
  if (!Array.isArray(value.legalEvidence) || value.legalEvidence.length < 1) {
    problems.push("legalEvidence must enumerate at least one evidence reference");
  } else {
    for (const [index, entry] of value.legalEvidence.entries()) {
      const label = `legalEvidence[${index}]`;
      if (!exactKeys(entry, LEGAL_EVIDENCE_KEYS, label, problems)) continue;
      const parsed = parseContainerLegalEvidenceRef(entry.reference);
      if (!parsed.ok) {
        problems.push(`${label}.reference ${parsed.problem}`);
        continue;
      }
      if (
        entry.kind !== parsed.kind ||
        entry.sha256 !== parsed.sha256 ||
        entry.repositoryPath !==
          (parsed.kind === "repository-file" ? parsed.path : null)
      ) {
        problems.push(`${label} must be derived from its canonical reference`);
      }
    }
  }
  if (exactKeys(value.reviewSummary, SUMMARY_KEYS, "reviewSummary", problems)) {
    for (const field of SUMMARY_KEYS) {
      if (!Number.isSafeInteger(value.reviewSummary[field]) || value.reviewSummary[field] < 0) {
        problems.push(`reviewSummary.${field} must be a non-negative integer`);
      }
    }
    if (
      value.reviewSummary.reviewed + value.reviewSummary.unreviewed !==
      value.reviewSummary.total
    ) {
      problems.push("reviewSummary reviewed + unreviewed must equal total");
    }
    if (value.reviewSummary.unreviewed !== 0) {
      problems.push("reviewSummary.unreviewed must be zero");
    }
  }
  const dependency = dependencyProblems({
    receipt: value,
    inventory,
    ledger,
    inventoryBytes,
    ledgerBytes,
    now: now ?? value.capturedAt,
    repositoryRoot
  });
  problems.push(...dependency.problems);
  const ok = problems.length === 0;
  return {
    ok,
    problems,
    bindings: ok
      ? {
          candidateCommit: value.candidateCommit,
          deploymentCommit: value.deploymentCommit,
          containerImageDigest: value.containerImageDigest,
          packageInventoryDigest: value.packageInventoryDigest,
          legalEvidenceDigest: canonicalEvidenceDigest(value.legalEvidence)
        }
      : null,
    receiptDigest: ok ? canonicalEvidenceDigest(value) : null
  };
}

export function buildContainerImageLicensingEvidence({
  inventory,
  ledger,
  inventoryBytes,
  ledgerBytes,
  capturedAt,
  now,
  repositoryRoot
}) {
  const effectiveNow = now ?? capturedAt;
  const review = validateContainerPackageReviewReadiness(inventory, ledger, {
    now: effectiveNow
  });
  if (!review.ok || !review.bindings) {
    throw new Error(
      `Container package review is incomplete: ${review.problems.join("; ")}`
    );
  }
  const canonicalInventoryBytes = serializeContainerImagePackageInventory(inventory);
  const canonicalLedgerBytes = canonicalReviewLedgerBytes(ledger);
  if (inventoryBytes !== canonicalInventoryBytes) {
    throw new Error("inventory input is not in canonical inventory serialization");
  }
  if (ledgerBytes !== canonicalLedgerBytes) {
    throw new Error("review-ledger input is not in canonical ledger serialization");
  }
  const packageInventoryDigest =
    containerPackageInventoryDigest(canonicalInventoryBytes);
  const reviewLedgerDigest = containerReviewLedgerDigest(canonicalLedgerBytes);
  const receipt = {
    schemaVersion: CONTAINER_LICENSING_EVIDENCE_SCHEMA_VERSION,
    artifactKind: CONTAINER_LICENSING_EVIDENCE_KIND,
    candidateCommit: review.bindings.candidateCommit,
    deploymentCommit: review.bindings.candidateCommit,
    capturedAt,
    inputs: {
      inventory: {
        path: CONTAINER_PACKAGE_INVENTORY_PATH,
        sha256: packageInventoryDigest
      },
      reviewLedger: {
        path: CONTAINER_PACKAGE_REVIEW_LEDGER_PATH,
        sha256: reviewLedgerDigest
      }
    },
    containerImageDigest: review.bindings.containerImageDigest,
    packageInventoryDigest,
    packageSetDigest: review.bindings.packageSetDigest,
    reviewLedgerDigest,
    legalEvidence: legalEvidenceBindings(ledger),
    reviewSummary: review.summary
  };
  const verdict = validateContainerImageLicensingEvidence(receipt, {
    inventory,
    ledger,
    inventoryBytes,
    ledgerBytes,
    now: effectiveNow,
    repositoryRoot
  });
  if (!verdict.ok) {
    throw new Error(`Invalid container licensing evidence: ${verdict.problems.join("; ")}`);
  }
  return receipt;
}

export function serializeContainerImageLicensingEvidence(
  value,
  dependencies
) {
  const verdict = validateContainerImageLicensingEvidence(value, dependencies);
  if (!verdict.ok) throw new Error(verdict.problems.join("; "));
  return serializeCanonicalEvidence(value);
}
