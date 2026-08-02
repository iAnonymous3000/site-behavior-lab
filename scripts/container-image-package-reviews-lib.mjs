import { createHash } from "node:crypto";
import {
  serializeContainerImagePackageInventory,
  validateContainerImagePackageInventory
} from "./container-image-package-inventory-lib.mjs";

export const CONTAINER_PACKAGE_REVIEWS_ARTIFACT_KIND =
  "site-behavior-container-image-package-review-ledger";
export const CONTAINER_PACKAGE_REVIEWS_SCHEMA_VERSION = 1;
export const CONTAINER_PACKAGE_REVIEWS_NOTICE =
  "Rows are synchronized from an exact smoke-tested container OS-package inventory. New or changed package evidence is unreviewed until a human records a substantive license determination and resolves every distribution obligation. Scanner output is evidence, not a legal conclusion.";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REVIEWER_LENGTH = 200;
const MAX_LICENSE_LENGTH = 512;
const MAX_NOTES_LENGTH = 4096;
const MAX_OBLIGATIONS = 64;
const MAX_REQUIREMENT_LENGTH = 512;
const MAX_EVIDENCE_REFS = 32;
const MAX_EVIDENCE_REF_LENGTH = 1024;
const REVIEW_ROW_FIELDS = [
  "key",
  "inventoryEvidenceDigest",
  "status",
  "determinedLicense",
  "licenseEvidenceRefs",
  "obligations",
  "reviewer",
  "reviewedAt",
  "notes"
];
const PLACEHOLDER_LICENSE =
  /^(?:\?|unknown|unk|tbd|todo|pending|n\/?a|none|noassertion|not[- _]?reviewed|unreviewed|undetermined|unspecified)(?:\b|[\s:;,_-].*)?$/i;
const EVIDENCE_DIGEST_FRAGMENT = /^sha256=([a-f0-9]{64})$/;
const REPOSITORY_EVIDENCE_REF =
  /^repo:([A-Za-z0-9][A-Za-z0-9._/-]{0,899})#sha256=([a-f0-9]{64})$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedCanonicalString(value, maximumLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * Legal evidence references are content-addressed, not labels. Accepted forms:
 * - repo:<relative-posix-path>#sha256=<64 lowercase hex>
 * - canonical https://...#sha256=<64 lowercase hex>
 */
export function parseContainerLegalEvidenceRef(value) {
  if (!boundedCanonicalString(value, MAX_EVIDENCE_REF_LENGTH)) {
    return {
      ok: false,
      problem: "must be a trimmed, non-empty bounded evidence reference"
    };
  }
  const repository = value.match(REPOSITORY_EVIDENCE_REF);
  if (repository) {
    const evidencePath = repository[1];
    const components = evidencePath.split("/");
    if (
      evidencePath.startsWith("/") ||
      evidencePath.includes("\\") ||
      components.some(
        (component) =>
          component.length === 0 || component === "." || component === ".."
      )
    ) {
      return {
        ok: false,
        problem:
          "repository evidence path must be a normalized relative POSIX path"
      };
    }
    return {
      ok: true,
      kind: "repository-file",
      path: evidencePath,
      sha256: repository[2]
    };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      problem:
        "must use repo:<path>#sha256=<digest> or canonical HTTPS#sha256=<digest>"
    };
  }
  const digestMatch = parsed.hash.slice(1).match(EVIDENCE_DIGEST_FRAGMENT);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.pathname === "/" ||
    parsed.hostname === "localhost" ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      parsed.hostname
    ) ||
    digestMatch === null ||
    parsed.href !== value
  ) {
    return {
      ok: false,
      problem:
        "HTTPS evidence reference must be canonical, credential-free, query-free, and end in #sha256=<64 lowercase hex>"
    };
  }
  return {
    ok: true,
    kind: "https",
    url: value,
    sha256: digestMatch[1]
  };
}

function exactKeysProblem(value, expected, label) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    return `${label} must contain exactly the canonical fields`;
  }
  return null;
}

function isCanonicalReviewDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const instant = Date.UTC(year, month - 1, day);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function canonicalToday(now) {
  const instant = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error("review validation now must identify a valid instant");
  }
  return instant.toISOString().slice(0, 10);
}

function emptyReview(pkg) {
  return {
    key: pkg.key,
    inventoryEvidenceDigest: pkg.evidenceDigest,
    status: "unreviewed",
    determinedLicense: null,
    licenseEvidenceRefs: [],
    obligations: [],
    reviewer: null,
    reviewedAt: null,
    notes: null
  };
}

function unreviewedRowProblems(row) {
  const problems = [];
  for (const field of ["determinedLicense", "reviewer", "reviewedAt"]) {
    if (row[field] !== null) problems.push(`${field} must remain null while status is unreviewed`);
  }
  if (!Array.isArray(row.licenseEvidenceRefs) || row.licenseEvidenceRefs.length !== 0) {
    problems.push("licenseEvidenceRefs must remain [] while status is unreviewed");
  }
  if (!Array.isArray(row.obligations) || row.obligations.length !== 0) {
    problems.push("obligations must remain [] while status is unreviewed");
  }
  if (
    row.notes !== null &&
    !boundedCanonicalString(row.notes, MAX_NOTES_LENGTH)
  ) {
    problems.push("notes must be null or a trimmed, non-empty bounded string");
  }
  return problems;
}

function reviewedRowProblems(row, today) {
  const problems = [];
  if (!boundedCanonicalString(row.reviewer, MAX_REVIEWER_LENGTH)) {
    problems.push("reviewer must be a trimmed, non-empty bounded string");
  }
  if (!isCanonicalReviewDate(row.reviewedAt)) {
    problems.push("reviewedAt must be a canonical YYYY-MM-DD calendar date");
  } else if (row.reviewedAt > today) {
    problems.push(`reviewedAt must not be in the future relative to ${today}`);
  }
  if (
    !boundedCanonicalString(row.determinedLicense, MAX_LICENSE_LENGTH) ||
    !/[\p{L}\p{N}]/u.test(row.determinedLicense) ||
    PLACEHOLDER_LICENSE.test(row.determinedLicense)
  ) {
    problems.push("determinedLicense must be a meaningful, non-placeholder bounded string");
  }
  if (
    !Array.isArray(row.licenseEvidenceRefs) ||
    row.licenseEvidenceRefs.length === 0 ||
    row.licenseEvidenceRefs.length > MAX_EVIDENCE_REFS
  ) {
    problems.push(
      `licenseEvidenceRefs must contain 1-${MAX_EVIDENCE_REFS} authoritative evidence references`
    );
  } else {
    const licenseRefs = new Set();
    for (const evidenceRef of row.licenseEvidenceRefs) {
      const parsed = parseContainerLegalEvidenceRef(evidenceRef);
      if (!parsed.ok) {
        problems.push(
          `licenseEvidenceRefs entry ${JSON.stringify(evidenceRef)} ${parsed.problem}`
        );
        break;
      }
      if (licenseRefs.has(evidenceRef)) {
        problems.push(`licenseEvidenceRefs contains duplicate ${evidenceRef}`);
        break;
      }
      licenseRefs.add(evidenceRef);
    }
  }
  if (
    row.notes !== null &&
    !boundedCanonicalString(row.notes, MAX_NOTES_LENGTH)
  ) {
    problems.push("notes must be null or a trimmed, non-empty bounded string");
  }
  if (!Array.isArray(row.obligations)) {
    problems.push(
      "obligations must be an array (use [] only after review finds no distribution obligations)"
    );
    return problems;
  }
  if (row.obligations.length > MAX_OBLIGATIONS) {
    problems.push(`obligations must contain at most ${MAX_OBLIGATIONS} entries`);
    return problems;
  }
  const requirements = new Set();
  for (const [index, obligation] of row.obligations.entries()) {
    if (!isRecord(obligation)) {
      problems.push(`obligation ${index} must be an object`);
      continue;
    }
    const keysProblem = exactKeysProblem(
      obligation,
      ["requirement", "disposition", "evidenceRefs"],
      `obligation ${index}`
    );
    if (keysProblem) problems.push(keysProblem);
    if (!boundedCanonicalString(obligation.requirement, MAX_REQUIREMENT_LENGTH)) {
      problems.push(`obligation ${index}.requirement must be a trimmed, non-empty bounded string`);
    } else if (requirements.has(obligation.requirement)) {
      problems.push(`obligations contains duplicate requirement ${obligation.requirement}`);
    } else {
      requirements.add(obligation.requirement);
    }
    if (!["satisfied", "not-applicable"].includes(obligation.disposition)) {
      problems.push(
        `obligation ${index}.disposition must be satisfied or not-applicable`
      );
    }
    if (
      !Array.isArray(obligation.evidenceRefs) ||
      obligation.evidenceRefs.length === 0 ||
      obligation.evidenceRefs.length > MAX_EVIDENCE_REFS
    ) {
      problems.push(
        `obligation ${index}.evidenceRefs must contain 1-${MAX_EVIDENCE_REFS} entries`
      );
      continue;
    }
    const refs = new Set();
    for (const evidenceRef of obligation.evidenceRefs) {
      const parsed = parseContainerLegalEvidenceRef(evidenceRef);
      if (!parsed.ok) {
        problems.push(
          `obligation ${index}.evidenceRefs entry ${JSON.stringify(
            evidenceRef
          )} ${parsed.problem}`
        );
        break;
      }
      if (refs.has(evidenceRef)) {
        problems.push(`obligation ${index}.evidenceRefs contains duplicate ${evidenceRef}`);
        break;
      }
      refs.add(evidenceRef);
    }
  }
  return problems;
}

function requireValidInventory(inventory) {
  const verdict = validateContainerImagePackageInventory(inventory);
  if (!verdict.ok) {
    throw new Error(`Container package inventory is invalid: ${verdict.problems.join("; ")}`);
  }
}

/** Synchronize exact package coverage without inventing any legal determination. */
export function syncContainerPackageReviewLedger(inventory, ledger) {
  requireValidInventory(inventory);
  if (ledger !== null && ledger !== undefined) {
    if (
      !isRecord(ledger) ||
      ledger.schemaVersion !== CONTAINER_PACKAGE_REVIEWS_SCHEMA_VERSION ||
      ledger.artifactKind !== CONTAINER_PACKAGE_REVIEWS_ARTIFACT_KIND ||
      !Array.isArray(ledger.reviews)
    ) {
      throw new Error("Existing container package review ledger has the wrong schema");
    }
    const keysProblem = exactKeysProblem(
      ledger,
      [
        "schemaVersion",
        "artifactKind",
        "inventoryPackageSetDigest",
        "notice",
        "reviews"
      ],
      "existing container package review ledger"
    );
    if (keysProblem) throw new Error(keysProblem);
    const seen = new Set();
    for (const [index, row] of ledger.reviews.entries()) {
      if (!isRecord(row) || !boundedCanonicalString(row.key, MAX_EVIDENCE_REF_LENGTH)) {
        throw new Error(`Existing review row ${index} has no valid key`);
      }
      if (seen.has(row.key)) throw new Error(`Existing review ledger has duplicate row ${row.key}`);
      seen.add(row.key);
    }
  }
  const previousRows =
    isRecord(ledger) && Array.isArray(ledger.reviews) ? ledger.reviews : [];
  const existing = new Map();
  for (const row of previousRows) {
    if (isRecord(row) && typeof row.key === "string" && !existing.has(row.key)) {
      existing.set(row.key, row);
    }
  }
  const currentKeys = new Set(inventory.packages.map((pkg) => pkg.key));
  const added = [];
  const reset = [];
  const reviews = inventory.packages.map((pkg) => {
    const row = existing.get(pkg.key);
    if (!row) {
      added.push(pkg.key);
      return emptyReview(pkg);
    }
    if (row.inventoryEvidenceDigest !== pkg.evidenceDigest) {
      reset.push(pkg.key);
      return emptyReview(pkg);
    }
    const rowKeysProblem = exactKeysProblem(row, REVIEW_ROW_FIELDS, `review row ${row.key}`);
    if (rowKeysProblem) {
      if (row.status === "unreviewed") {
        reset.push(pkg.key);
        return emptyReview(pkg);
      }
      throw new Error(
        `${rowKeysProblem}; refusing to discard a reviewed row during synchronization`
      );
    }
    return row;
  });
  const removed = [...existing.keys()].filter((key) => !currentKeys.has(key));
  return {
    ledger: {
      schemaVersion: CONTAINER_PACKAGE_REVIEWS_SCHEMA_VERSION,
      artifactKind: CONTAINER_PACKAGE_REVIEWS_ARTIFACT_KIND,
      inventoryPackageSetDigest: inventory.packageSetDigest,
      notice: CONTAINER_PACKAGE_REVIEWS_NOTICE,
      reviews
    },
    added,
    reset,
    removed
  };
}

/**
 * Fail on package/evidence/review-shape mismatch. Unreviewed rows are reported
 * separately so bootstrapping never fabricates a legal determination.
 */
export function checkContainerPackageReviewLedger(inventory, ledger, { now } = {}) {
  const problems = [];
  let today;
  try {
    today = canonicalToday(now);
  } catch (error) {
    return {
      ok: false,
      complete: false,
      problems: [error instanceof Error ? error.message : String(error)],
      summary: null
    };
  }
  try {
    requireValidInventory(inventory);
  } catch (error) {
    return {
      ok: false,
      complete: false,
      problems: [error instanceof Error ? error.message : String(error)],
      summary: null
    };
  }
  if (
    !isRecord(ledger) ||
    ledger.schemaVersion !== CONTAINER_PACKAGE_REVIEWS_SCHEMA_VERSION ||
    ledger.artifactKind !== CONTAINER_PACKAGE_REVIEWS_ARTIFACT_KIND
  ) {
    return {
      ok: false,
      complete: false,
      problems: ["container package review ledger is missing or has the wrong schema"],
      summary: null
    };
  }
  const ledgerKeysProblem = exactKeysProblem(
    ledger,
    [
      "schemaVersion",
      "artifactKind",
      "inventoryPackageSetDigest",
      "notice",
      "reviews"
    ],
    "container package review ledger"
  );
  if (ledgerKeysProblem) problems.push(ledgerKeysProblem);
  if (ledger.notice !== CONTAINER_PACKAGE_REVIEWS_NOTICE) {
    problems.push("container package review ledger notice is not canonical");
  }
  if (
    typeof ledger.inventoryPackageSetDigest !== "string" ||
    !SHA256_PATTERN.test(ledger.inventoryPackageSetDigest) ||
    ledger.inventoryPackageSetDigest !== inventory.packageSetDigest
  ) {
    problems.push("container package review ledger package-set digest does not match the inventory");
  }
  const rows = Array.isArray(ledger.reviews) ? ledger.reviews : [];
  if (!Array.isArray(ledger.reviews)) {
    problems.push("container package review ledger reviews must be an array");
  }
  const rowsByKey = new Map();
  const validRows = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) {
      problems.push(`review row ${index} must be an object`);
      continue;
    }
    if (!boundedCanonicalString(row.key, MAX_EVIDENCE_REF_LENGTH)) {
      problems.push(`review row ${index} has no valid key`);
      continue;
    }
    const rowKeysProblem = exactKeysProblem(
      row,
      REVIEW_ROW_FIELDS,
      `review row ${row.key}`
    );
    if (rowKeysProblem) problems.push(rowKeysProblem);
    if (rowsByKey.has(row.key)) problems.push(`duplicate review row: ${row.key}`);
    else rowsByKey.set(row.key, row);
    validRows.push(row);
  }
  const packagesByKey = new Map(inventory.packages.map((pkg) => [pkg.key, pkg]));
  for (const pkg of inventory.packages) {
    if (!rowsByKey.has(pkg.key)) problems.push(`missing review row: ${pkg.key}`);
  }
  let reviewed = 0;
  let unreviewed = 0;
  for (const row of validRows) {
    const pkg = packagesByKey.get(row.key);
    if (!pkg) {
      problems.push(`orphaned review row: ${row.key}`);
      continue;
    }
    if (
      typeof row.inventoryEvidenceDigest !== "string" ||
      !SHA256_PATTERN.test(row.inventoryEvidenceDigest) ||
      row.inventoryEvidenceDigest !== pkg.evidenceDigest
    ) {
      problems.push(`review row ${row.key} does not match the package evidence digest`);
    }
    let rowProblems;
    if (row.status === "reviewed") {
      rowProblems = reviewedRowProblems(row, today);
      if (rowProblems.length === 0) reviewed += 1;
    } else if (row.status === "unreviewed") {
      rowProblems = unreviewedRowProblems(row);
      unreviewed += 1;
    } else {
      rowProblems = [`status must be reviewed or unreviewed, got ${JSON.stringify(row.status)}`];
    }
    for (const problem of rowProblems) {
      problems.push(`review row ${row.key} ${problem}`);
    }
  }
  const summary = {
    total: inventory.packages.length,
    reviewed,
    unreviewed
  };
  return {
    ok: problems.length === 0,
    complete: problems.length === 0 && reviewed === inventory.packages.length,
    problems,
    summary
  };
}

/**
 * Release-readiness seam: one strict verdict plus the exact subject bindings
 * that an operator attestation must carry. Ordinary PR CI uses the structural
 * checker above; readiness additionally requires every row to be reviewed.
 */
export function validateContainerPackageReviewReadiness(
  inventory,
  ledger,
  { now } = {}
) {
  const verdict = checkContainerPackageReviewLedger(inventory, ledger, { now });
  if (!verdict.ok) {
    return {
      ok: false,
      complete: false,
      problems: verdict.problems,
      summary: verdict.summary,
      bindings: null
    };
  }
  const inventoryBytes = serializeContainerImagePackageInventory(inventory);
  const bindings = {
    candidateCommit: inventory.source.commit,
    containerImageDigest: inventory.image.digest,
    containerImageId: inventory.image.id,
    packageInventoryDigest: createHash("sha256").update(inventoryBytes).digest("hex"),
    packageSetDigest: inventory.packageSetDigest
  };
  if (!verdict.complete) {
    return {
      ok: false,
      complete: false,
      problems: [
        `${verdict.summary.unreviewed} exact-image OS package review(s) remain unreviewed`
      ],
      summary: verdict.summary,
      bindings
    };
  }
  return {
    ok: true,
    complete: true,
    problems: [],
    summary: verdict.summary,
    bindings
  };
}
