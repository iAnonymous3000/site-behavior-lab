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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return keys;
}

function emptyRow(item) {
  return {
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
export function checkReviewLedger(inventory, ledger) {
  const problems = [];
  if (!isRecord(ledger) || ledger.artifactKind !== REVIEWS_ARTIFACT_KIND) {
    return { ok: false, problems: ["review ledger is missing or not a review-ledger artifact"], summary: null };
  }
  const rows = Array.isArray(ledger.reviews) ? ledger.reviews : [];
  const rowKeys = new Set(rows.map((row) => row.key));
  const items = inventoryItemKeys(inventory);
  const itemKeys = new Set(items.map((item) => item.key));
  for (const item of items) {
    if (!rowKeys.has(item.key)) problems.push(`missing ledger row: ${item.key}`);
  }
  for (const row of rows) {
    if (!itemKeys.has(row.key)) problems.push(`orphaned ledger row (item left the inventory): ${row.key}`);
    if (row.status === "reviewed") {
      for (const field of ["reviewer", "reviewedAt", "determinedLicense"]) {
        if (typeof row[field] !== "string" || row[field].trim().length === 0) {
          problems.push(`reviewed row ${row.key} is missing ${field}`);
        }
      }
      if (!Array.isArray(row.obligations)) {
        problems.push(`reviewed row ${row.key} must declare obligations (possibly empty)`);
      }
    } else if (row.status !== "unreviewed") {
      problems.push(`row ${row.key} has unknown status ${JSON.stringify(row.status)}`);
    }
  }
  const summary = {};
  for (const item of items) {
    const row = rows.find((candidate) => candidate.key === item.key);
    const bucket = (summary[item.ecosystem] ??= { total: 0, reviewed: 0, unreviewedRuntime: 0 });
    bucket.total += 1;
    if (row?.status === "reviewed") bucket.reviewed += 1;
    else if (item.runtime) bucket.unreviewedRuntime += 1;
  }
  return { ok: problems.length === 0, problems, summary };
}
