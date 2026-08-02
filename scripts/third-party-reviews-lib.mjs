// Human review ledger over THIRD_PARTY_INVENTORY.json.
//
// The inventory is deliberately evidence-only: versions, digests, and declared
// license strings, with no place to record that a human determined a license,
// an obligation, or a notice requirement. The legal review therefore had no
// structure to land in, and CI could only verify inventory freshness, not
// review coverage. This ledger adds exactly that missing structure:
//
// - one row per inventory item, keyed by ecosystem + name + version (a bump
//   is a NEW row, so every version change re-enters review);
// - rows are created as "unreviewed" by --sync and promoted to "reviewed" by
//   a human adding reviewer, date, license determination, and obligations;
// - --check fails when the ledger and inventory drift (a new dependency
//   cannot merge without at least an explicit unreviewed row), while REVIEW
//   completeness is reported, not gated: it becomes a release-readiness
//   assertion, not a per-commit one.
export const REVIEWS_ARTIFACT_KIND = "site-behavior-third-party-review-ledger";
export const REVIEWS_SCHEMA_VERSION = 1;
export const INVENTORY_ARTIFACT_KIND = "deterministic-third-party-inventory-and-notice-evidence";
export const INVENTORY_SCHEMA_VERSION = 1;
const MAX_REVIEWER_LENGTH = 200;
const MAX_LICENSE_LENGTH = 512;
const MAX_OBLIGATIONS = 64;
const MAX_OBLIGATION_LENGTH = 512;
const PLACEHOLDER_LICENSE =
  /^(?:\?|unknown|unk|tbd|todo|pending|n\/?a|none|noassertion|not[- _]?reviewed|unreviewed|undetermined|unspecified)(?:\b|[\s:;,_-].*)?$/i;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalReviewDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const instant = Date.UTC(year, month - 1, day);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
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

function reviewedRowProblems(row, now) {
  const problems = [];
  if (!boundedCanonicalString(row.reviewer, MAX_REVIEWER_LENGTH)) {
    problems.push("reviewer must be a trimmed, non-empty bounded string");
  }
  if (!isCanonicalReviewDate(row.reviewedAt)) {
    problems.push("reviewedAt must be a canonical YYYY-MM-DD calendar date");
  } else if (row.reviewedAt > new Date(now).toISOString().slice(0, 10)) {
    problems.push("reviewedAt cannot be in the future");
  }
  if (
    !boundedCanonicalString(row.determinedLicense, MAX_LICENSE_LENGTH) ||
    !/[\p{L}\p{N}]/u.test(row.determinedLicense) ||
    PLACEHOLDER_LICENSE.test(row.determinedLicense)
  ) {
    problems.push("determinedLicense must be a meaningful, non-placeholder bounded string");
  }
  if (!Array.isArray(row.obligations)) {
    problems.push("obligations must be an array (use [] only after reviewing and finding no obligations)");
  } else if (row.obligations.length > MAX_OBLIGATIONS) {
    problems.push(`obligations must contain at most ${MAX_OBLIGATIONS} entries`);
  } else {
    const seen = new Set();
    for (const obligation of row.obligations) {
      if (!boundedCanonicalString(obligation, MAX_OBLIGATION_LENGTH)) {
        problems.push("every obligation must be a trimmed, non-empty bounded string");
        break;
      }
      if (seen.has(obligation)) {
        problems.push(`obligations contains a duplicate entry: ${obligation}`);
        break;
      }
      seen.add(obligation);
    }
  }
  return problems;
}

export function inventoryItemKeys(inventory) {
  if (!isRecord(inventory)) throw new Error("inventory must be an object");
  const keys = [];
  for (const entry of inventory.npm ?? []) {
    keys.push({
      key: `npm:${entry.name}@${entry.version}`,
      ecosystem: "npm",
      name: entry.name,
      version: entry.version,
      declaredLicense: entry.license ?? null,
      runtime: entry.developmentOnly !== true
    });
  }
  for (const entry of inventory.cargo ?? []) {
    // The workspace crate is first-party source, not a third-party item.
    if (entry.kind !== "third-party") continue;
    keys.push({
      key: `cargo:${entry.name}@${entry.version}`,
      ecosystem: "cargo",
      name: entry.name,
      version: entry.version,
      declaredLicense: entry.license === "UNKNOWN" ? null : (entry.license ?? null),
      runtime: true
    });
  }
  for (const source of inventory.filterLists?.sources ?? []) {
    keys.push({
      key: `filter-list:${source.url}@sha256:${source.sha256}`,
      ecosystem: "filter-list",
      name: source.url,
      version: `sha256:${source.sha256}`,
      declaredLicense: source.license === "UNKNOWN" ? null : (source.license ?? null),
      runtime: true
    });
  }
  for (const tool of inventory.downloadedTools ?? []) {
    if (
      typeof tool.id !== "string" ||
      tool.id.length === 0 ||
      typeof tool.name !== "string" ||
      tool.name.length === 0 ||
      typeof tool.version !== "string" ||
      tool.version.length === 0 ||
      typeof tool.sourceUrl !== "string" ||
      !tool.sourceUrl.startsWith("https://") ||
      tool.usage !== "build-only" ||
      tool.runtime !== false ||
      tool.redistributed !== false
    ) {
      throw new Error(
        "downloadedTools entries must declare a stable id, name, version, HTTPS sourceUrl, build-only usage, runtime=false, and redistributed=false"
      );
    }
    keys.push({
      key: `downloaded-tool:${tool.id}@${tool.version}`,
      ecosystem: "downloaded-tool",
      name: tool.name,
      version: tool.version,
      declaredLicense: tool.license === "UNKNOWN" ? null : (tool.license ?? null),
      runtime: false,
      redistributed: false,
      usage: "build-only",
      sourceUrl: tool.sourceUrl
    });
  }
  return keys;
}

function emptyRow(item) {
  const row = {
    key: item.key,
    ecosystem: item.ecosystem,
    name: item.name,
    version: item.version,
    runtime: item.runtime,
    status: "unreviewed",
    declaredLicense: item.declaredLicense,
    determinedLicense: null,
    obligations: [],
    reviewer: null,
    reviewedAt: null,
    notes: null
  };
  for (const field of ["redistributed", "usage", "sourceUrl"]) {
    if (Object.hasOwn(item, field)) row[field] = item[field];
  }
  return row;
}

/** Bring the ledger in line with the inventory; reviewed rows are preserved verbatim. */
export function syncReviewLedger(inventory, ledger) {
  const existing = new Map(
    (isRecord(ledger) && Array.isArray(ledger.reviews) ? ledger.reviews : []).map((row) => [row.key, row])
  );
  const items = inventoryItemKeys(inventory);
  const itemKeys = new Set(items.map((item) => item.key));
  const reviews = items.map((item) => existing.get(item.key) ?? emptyRow(item));
  const removed = [...existing.keys()].filter((key) => !itemKeys.has(key));
  const added = items.filter((item) => !existing.has(item.key)).map((item) => item.key);
  return {
    ledger: {
      schemaVersion: REVIEWS_SCHEMA_VERSION,
      artifactKind: REVIEWS_ARTIFACT_KIND,
      notice:
        "Rows are created unreviewed by scripts/third-party-reviews.mjs --sync. A human review fills reviewer, reviewedAt, determinedLicense, and obligations, and sets status to reviewed. A version bump is a new row and re-enters review.",
      reviews
    },
    added,
    removed
  };
}

/** Drift and integrity check; review completeness is summarized, never gated here. */
export function checkReviewLedger(inventory, ledger, now = Date.now()) {
  const problems = [];
  if (!Number.isFinite(now)) {
    return { ok: false, problems: ["review clock must be a finite instant"], summary: null };
  }
  if (!isRecord(ledger)) {
    return { ok: false, problems: ["review ledger is missing or not a review-ledger artifact"], summary: null };
  }
  if (ledger.artifactKind !== REVIEWS_ARTIFACT_KIND) {
    problems.push(`review ledger artifactKind must be ${REVIEWS_ARTIFACT_KIND}`);
  }
  if (ledger.schemaVersion !== REVIEWS_SCHEMA_VERSION) {
    problems.push(`review ledger schemaVersion must be ${REVIEWS_SCHEMA_VERSION}`);
  }
  if (!isRecord(inventory)) {
    problems.push("third-party inventory must be an object");
  } else {
    if (inventory.artifactKind !== INVENTORY_ARTIFACT_KIND) {
      problems.push(`third-party inventory artifactKind must be ${INVENTORY_ARTIFACT_KIND}`);
    }
    if (inventory.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
      problems.push(`third-party inventory schemaVersion must be ${INVENTORY_SCHEMA_VERSION}`);
    }
  }
  if (problems.length > 0) return { ok: false, problems, summary: null };
  const rows = Array.isArray(ledger.reviews) ? ledger.reviews : [];
  if (!Array.isArray(ledger.reviews)) {
    problems.push("review ledger reviews must be an array");
  }
  const validRows = [];
  const rowKeys = new Set();
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) {
      problems.push(`review row ${index} must be an object`);
      continue;
    }
    if (typeof row.key !== "string" || row.key.length === 0) {
      problems.push(`review row ${index} has no valid key`);
      continue;
    }
    if (rowKeys.has(row.key)) problems.push(`duplicate ledger row: ${row.key}`);
    rowKeys.add(row.key);
    validRows.push(row);
  }
  const items = inventoryItemKeys(inventory);
  const itemKeys = new Set(items.map((item) => item.key));
  for (const item of items) {
    if (!rowKeys.has(item.key)) problems.push(`missing ledger row: ${item.key}`);
  }
  const itemsByKey = new Map(items.map((item) => [item.key, item]));
  const invalidReviewedKeys = new Set();
  for (const row of validRows) {
    if (!itemKeys.has(row.key)) problems.push(`orphaned ledger row (item left the inventory): ${row.key}`);
    const item = itemsByKey.get(row.key);
    if (item) {
      // Every copied identity field is inventory truth. Letting only the key
      // match can mislabel which component a human actually reviewed.
      const copiedIdentityFields = [
        "ecosystem",
        "name",
        "version",
        "runtime",
        "declaredLicense",
        ...["redistributed", "usage", "sourceUrl"].filter(
          (field) => Object.hasOwn(item, field) || Object.hasOwn(row, field)
        )
      ];
      for (const field of copiedIdentityFields) {
        if (row[field] !== item[field]) {
          problems.push(
            `row ${row.key} declares ${field}=${JSON.stringify(row[field])} but the inventory says ${JSON.stringify(item[field])}`
          );
        }
      }
    }
    if (row.status === "reviewed") {
      const reviewProblems = reviewedRowProblems(row, now);
      if (reviewProblems.length > 0) invalidReviewedKeys.add(row.key);
      for (const problem of reviewProblems) {
        problems.push(`reviewed row ${row.key} ${problem}`);
      }
    } else if (row.status !== "unreviewed") {
      problems.push(`row ${row.key} has unknown status ${JSON.stringify(row.status)}`);
    }
  }
  const summary = {};
  for (const item of items) {
    const row = validRows.find((candidate) => candidate.key === item.key);
    const bucket = (summary[item.ecosystem] ??= { total: 0, reviewed: 0, unreviewedRuntime: 0 });
    bucket.total += 1;
    if (row?.status === "reviewed" && !invalidReviewedKeys.has(item.key)) bucket.reviewed += 1;
    else if (item.runtime) bucket.unreviewedRuntime += 1;
  }
  return { ok: problems.length === 0, problems, summary };
}
