export { featuredSiteUnavailability, FEATURED_UNAVAILABILITY_MAX_DAYS } from "../lib/featured-scan-availability.ts";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { FEATURED_READJUDICATION_REASONS } from "./featured-readjudication-lib.mjs";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const URL_PATTERN = /https?:\/\/\S+/gi;
const MAX_DIAGNOSTIC_LENGTH = 500;
const MAX_PUBLIC_SUMMARY_BYTES = 4 * 1024;
/**
 * The canonical refresh issue is scoped PER CATALOG.
 *
 * Both scheduled legs are authoritative, and the seed leg always runs after the
 * gallery leg. With one shared marker the later leg closed whatever the earlier
 * one had filed, so a genuinely failing gallery refresh was silently marked
 * resolved two hours later by an unrelated healthy seed run.
 */
const FEATURED_REFRESH_MARKER = "<!-- site-behavior-lab:featured-corpus-refresh -->";

export const FEATURED_SEED_CATALOG = "public/corpus-seed-sites.json";

/** Stable slug for the catalog a refresh leg walked. */
export function featuredRefreshCatalogSlug(environment) {
  return (environment.FEATURED_SITES_FILE?.trim() ?? "") === FEATURED_SEED_CATALOG ? "seed" : "gallery";
}

/** The per-catalog body marker the reconcile step selects on. */
export function featuredRefreshMarker(catalogSlug) {
  return `<!-- site-behavior-lab:featured-corpus-refresh:${catalogSlug} -->`;
}
export const FEATURED_CATALOG_VERSION_FLOOR = 2;
export const FEATURED_CATALOG_COVERAGE_FLOOR = 0.8;
export const FEATURED_ACTIVE_SITE_FLOOR = 50;
/**
 * The largest share of eligible targets that may refuse an automated visit
 * before a refresh goes red. Fixed, like the coverage floors, so a run cannot
 * make itself green by reclassifying its own failures.
 */
export const FEATURED_REFUSAL_CEILING = 0.35;

/**
 * Preserve the child scanner's final public-safe error without copying an
 * unbounded stderr stream into the workflow summary or diagnostics artifact.
 * URLs are redacted defensively: scan targets must never leak through a future
 * child error message even though the current CI scanner already avoids them.
 */
export function failureDiagnosticFromStderr(stderr) {
  if (typeof stderr !== "string" || stderr.trim() === "") return null;

  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI_ESCAPE_PATTERN, "").replace(CONTROL_CHARACTER_PATTERN, " ").trim())
    .filter(Boolean);
  const finalLine = lines.at(-1);
  if (!finalLine) return null;

  const redacted = finalLine.replace(URL_PATTERN, "[redacted URL]");
  if (redacted.length <= MAX_DIAGNOSTIC_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}

function boundedCount(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function boundedRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function featuredMinimumSuccessRate(raw, fallback = 0.9, floor = 0.8) {
  const normalized = typeof raw === "string" ? raw.trim() : "";
  const value = normalized === "" ? fallback : Number(normalized);
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(floor) ||
    floor < 0 ||
    floor > 1 ||
    value < floor ||
    value > 1
  ) {
    throw new Error(`FEATURED_MIN_SUCCESS_RATE must be a number from ${floor} to 1.`);
  }
  return value;
}

export function featuredTransientRetryLimit(raw, fallback = 1, maximum = 2) {
  const normalized = typeof raw === "string" ? raw.trim() : "";
  const value = normalized === "" ? fallback : Number(normalized);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`FEATURED_TRANSIENT_RETRIES must be an integer from 0 to ${maximum}.`);
  }
  return value;
}

/**
 * Classify the final public-safe child diagnostic conservatively. A retry is
 * allowed only for explicit capacity/transport failures, scan deadlines, HTTP
 * 429, or HTTP 5xx. Bot/challenge pages, sparse/capped observations, permanent
 * HTTP errors, and validation/publishing failures are never retried.
 */
export function featuredScanRetryReason(diagnostic) {
  if (typeof diagnostic !== "string") return null;
  const message = diagnostic.trim();
  if (!message) return null;

  if (
    /bot-block|challenge page|likely failed or was blocked|request(?:-| )cap|capped|invalid|publishable report|quality evaluator marked the run failed/i.test(
      message
    )
  ) {
    return null;
  }
  if (/\bHTTP 429\b/i.test(message)) return "HTTP 429";
  const serverStatus = message.match(/\bHTTP (5\d\d)\b/i);
  if (serverStatus) return `HTTP ${serverStatus[1]}`;
  const nonJsonServerStatus = message.match(/\bExpected JSON\b.*\bgot (5\d\d)\b/i);
  if (nonJsonServerStatus) return `HTTP ${nonJsonServerStatus[1]}`;
  if (/page did not load before the scan timeout|scan exceeded the maximum scan duration/i.test(message)) {
    return "scan deadline";
  }
  if (/scanner (?:is busy|queue is full|execution capacity is full)/i.test(message)) {
    return "scanner capacity";
  }
  if (/scan job status remained temporarily unavailable/i.test(message)) {
    return "scan status transport";
  }
  if (/\bfetch failed\b|\bECONN(?:RESET|REFUSED|ABORTED)\b|\bEAI_AGAIN\b|\bUND_ERR_[A-Z_]+\b|\b(?:net::)?ERR_HTTP2_PROTOCOL_ERROR\b|socket hang up/i.test(message)) {
    return "transport failure";
  }
  return null;
}

/**
 * Availability metadata can only alter a versioned catalog. Requiring an
 * actual integer prevents strings, fractions and NaN-like values from
 * silently passing a numeric coercion check.
 */
export function featuredCatalogVersion(value) {
  if (!Number.isSafeInteger(value) || value < FEATURED_CATALOG_VERSION_FLOOR) {
    throw new Error(
      `Featured-site catalogs with scanAvailability metadata must use an integer version of ${FEATURED_CATALOG_VERSION_FLOOR} or newer.`
    );
  }
  return value;
}

/**
 * Keep the full-catalog denominator honest. These floors are deliberately
 * constants rather than environment options: a run cannot make itself green
 * by temporarily excluding more catalog entries.
 */
export function featuredCatalogEligibility(catalogTotal, eligibleTotal, enforceFloor = false) {
  const catalog = boundedCount(catalogTotal);
  const eligible = boundedCount(eligibleTotal, catalog ?? -1);
  if (catalog === null || catalog === 0 || eligible === null) {
    throw new Error("Featured catalog coverage requires positive, internally consistent counts.");
  }
  const catalogCoverage = eligible / catalog;
  const meetsFloor =
    eligible >= FEATURED_ACTIVE_SITE_FLOOR && catalogCoverage >= FEATURED_CATALOG_COVERAGE_FLOOR;
  if (enforceFloor && !meetsFloor) {
    throw new Error(
      `Refusing the full featured catalog: ${eligible}/${catalog} entries remain eligible (${Math.round(
        catalogCoverage * 100
      )}%); fixed policy requires at least ${FEATURED_ACTIVE_SITE_FLOOR} eligible sites and ${Math.round(
        FEATURED_CATALOG_COVERAGE_FLOOR * 100
      )}% whole-catalog coverage.`
    );
  }
  return {
    catalogCoverage,
    requiredCatalogCoverage: FEATURED_CATALOG_COVERAGE_FLOOR,
    minimumEligibleSites: FEATURED_ACTIVE_SITE_FLOOR,
    meetsFloor
  };
}

function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(typeof value === "string" ? value.trim() : "");
}

/**
 * The committed catalogs a SCHEDULED corpus refresh may walk.
 *
 * The corpus is two disjoint lists and the weekly refresh covers both, so both
 * are authoritative sources of scan failures. They stay separate from
 * {@link isFullFeaturedCatalogSelection}, which additionally gates the
 * full-catalog completeness floor that only the gallery is sized for.
 */
const SCHEDULED_CORPUS_CATALOGS = new Set(["", "public/featured-sites.json", "public/corpus-seed-sites.json"]);

export function isScheduledCorpusCatalogSelection(environment) {
  const sitesFile = environment.FEATURED_SITES_FILE?.trim() ?? "";
  return (
    SCHEDULED_CORPUS_CATALOGS.has(sitesFile) &&
    (environment.FEATURED_CATEGORIES?.trim() ?? "") === "" &&
    (environment.FEATURED_LIMIT?.trim() ?? "") === "" &&
    !isEnabled(environment.FEATURED_INCLUDE_UNAVAILABLE)
  );
}

export function isFullFeaturedCatalogSelection(environment) {
  const sitesFile = environment.FEATURED_SITES_FILE?.trim() ?? "";
  return (
    (sitesFile === "" || sitesFile === "public/featured-sites.json") &&
    (environment.FEATURED_CATEGORIES?.trim() ?? "") === "" &&
    (environment.FEATURED_LIMIT?.trim() ?? "") === "" &&
    !isEnabled(environment.FEATURED_INCLUDE_UNAVAILABLE)
  );
}

/**
 * Extract only aggregate, public-safe fields from the detailed diagnostics
 * artifact. Per-target names and child failure reasons stay in the artifact;
 * they are deliberately never copied into the public tracking issue.
 */
export function publicFeaturedScanSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const total = boundedCount(value.total);
  const succeeded = boundedCount(value.succeeded, total ?? -1);
  const failed = boundedCount(value.failed, total ?? -1);
  const successRate = boundedRate(value.successRate);
  const requiredSuccessRate = boundedRate(value.requiredSuccessRate);
  const hasAvailabilityCounts = value.catalogTotal !== undefined || value.unavailable !== undefined;
  const catalogTotal = hasAvailabilityCounts ? boundedCount(value.catalogTotal) : total;
  const unavailable = hasAvailabilityCounts ? boundedCount(value.unavailable, catalogTotal ?? -1) : 0;
  const fullCatalog = value.fullCatalog === true;
  if (
    total === null ||
    total === 0 ||
    succeeded === null ||
    failed === null ||
    succeeded + failed !== total ||
    successRate === null ||
    requiredSuccessRate === null ||
    Math.abs(successRate - succeeded / total) > 1e-12 ||
    catalogTotal === null ||
    unavailable === null ||
    catalogTotal !== total + unavailable
  ) {
    return null;
  }
  const eligibility = featuredCatalogEligibility(catalogTotal, total);
  if (
    value.catalogCoverage !== undefined &&
    (boundedRate(value.catalogCoverage) === null ||
      Math.abs(value.catalogCoverage - eligibility.catalogCoverage) > 1e-12)
  ) {
    return null;
  }
  if (
    value.requiredCatalogCoverage !== undefined &&
    value.requiredCatalogCoverage !== FEATURED_CATALOG_COVERAGE_FLOOR
  ) {
    return null;
  }
  if (value.minimumEligibleSites !== undefined && value.minimumEligibleSites !== FEATURED_ACTIVE_SITE_FLOOR) {
    return null;
  }
  if (fullCatalog) {
    try {
      featuredCatalogVersion(value.catalogVersion);
    } catch {
      return null;
    }
    if (
      value.catalogCoverage === undefined ||
      value.requiredCatalogCoverage === undefined ||
      value.minimumEligibleSites === undefined
    ) {
      return null;
    }
  }
  // Counts only, and only when they agree with `failed`. A summary that
  // predates the taxonomy, or carries a malformed one, keeps every other
  // aggregate rather than becoming unpublishable over an explanatory field.
  const failureTaxonomy = publicFailureTaxonomy(value.failureTaxonomy, failed)?.counts ?? null;
  // Re-derived from the counts, never read from a rate the summary asserts.
  const health = featuredBatchHealth({ total, succeeded, failed, failureTaxonomy, requiredSuccessRate });

  return {
    catalogVersion: fullCatalog ? value.catalogVersion : null,
    fullCatalog,
    catalogTotal,
    unavailable,
    total,
    succeeded,
    failed,
    successRate,
    requiredSuccessRate,
    failureTaxonomy,
    ...health,
    ...eligibility
  };
}

/**
 * Judge the scanner, not the sites.
 *
 * A site that declines an undisguised automated browser is an honest
 * observation this project will never evade, so it leaves the success-rate
 * denominator: the required rate applies to the targets the scanner could
 * actually be judged on. Everything else stays counted against the scanner,
 * including timeouts, unverified page subjects and unrecognized failures.
 *
 * Refusals are not free. Past {@link FEATURED_REFUSAL_CEILING} of the eligible
 * targets the run is red on its own, because a catalog that has decayed into
 * refusals no longer refreshes the corpus however well the scanner behaves.
 *
 * The refused count comes ONLY from a taxonomy that {@link publicFailureTaxonomy}
 * accepts. Without one it is zero, the strictest reading: a summary cannot get
 * greener by losing its explanation.
 */
export function featuredBatchHealth({ total, succeeded, failed, failureTaxonomy, requiredSuccessRate }) {
  const eligible = boundedCount(total);
  const successes = boundedCount(succeeded, eligible ?? -1);
  const failures = boundedCount(failed, eligible ?? -1);
  const required = boundedRate(requiredSuccessRate);
  if (
    eligible === null ||
    eligible === 0 ||
    successes === null ||
    failures === null ||
    successes + failures !== eligible ||
    required === null
  ) {
    throw new Error("Featured batch health requires positive, internally consistent counts.");
  }
  const taxonomy = publicFailureTaxonomy(failureTaxonomy, failures);
  const refused = taxonomy?.refused ?? 0;
  const scannerJudged = eligible - refused;
  const scannerSuccessRate = scannerJudged === 0 ? 0 : successes / scannerJudged;
  const refusalRate = refused / eligible;
  return {
    refusalsCounted: taxonomy !== null || failures === 0,
    refused,
    scannerJudged,
    scannerSuccessRate,
    refusalRate,
    refusalCeiling: FEATURED_REFUSAL_CEILING,
    meetsSuccessRate: successes > 0 && scannerSuccessRate >= required,
    meetsRefusalCeiling: refusalRate <= FEATURED_REFUSAL_CEILING
  };
}

const percent = (rate) => `${Math.round(rate * 100)}%`;

/**
 * The gate lines of a projected summary, each number beside its threshold.
 * Shared by the canonical issue and the runner's step summary so the two cannot
 * describe one run differently. The raw eligible rate stays as context: it is
 * the number earlier runs published, and it is no longer what is gated.
 */
export function featuredBatchHealthLines(aggregate) {
  const lines = [
    `- Eligible scan success (context, not a gate): **${aggregate.succeeded}/${aggregate.total}** (${percent(aggregate.successRate)})`,
    `- Scanner success, excluding sites that refused an automated visit: **${aggregate.succeeded}/${aggregate.scannerJudged}** (${percent(aggregate.scannerSuccessRate)})`,
    `- Required scanner success rate: **${percent(aggregate.requiredSuccessRate)}**`,
    `- Eligible targets that refused an automated visit: **${aggregate.refused}/${aggregate.total}** (${percent(aggregate.refusalRate)})`,
    `- Fixed refusal ceiling: **${percent(aggregate.refusalCeiling)} of eligible targets**`,
    `- Failed eligible targets: **${aggregate.failed}**`,
    `- Active eligible catalog coverage: **${aggregate.total}/${aggregate.catalogTotal}** (${percent(aggregate.catalogCoverage)})`,
    `- Fixed full-catalog coverage gate: **${percent(aggregate.requiredCatalogCoverage)} and at least ${aggregate.minimumEligibleSites} active sites**`,
    `- Catalog entries temporarily unavailable: **${aggregate.unavailable}/${aggregate.catalogTotal}**`
  ];
  if (!aggregate.refusalsCounted) {
    lines.push("- Refusals could not be counted, so every failure is held against the scanner.");
  }
  lines.push("- Scope note: passing these gates does not mean every catalog entry was freshly scanned.");
  return lines;
}

/**
 * What curating each scheduled catalog means. Only a catalog of version
 * {@link FEATURED_CATALOG_VERSION_FLOOR} or newer accepts `scanAvailability`
 * deferrals, and the seed list is older: a deferral added to it as written
 * would stop its next run before a single scan, turning a red run that still
 * publishes into one that publishes nothing.
 */
const CATALOG_CURATION = new Map([
  ["gallery", "defer or replace the refusing entries rather than changing the scanner."],
  [
    "seed",
    "replace the refusing entries rather than changing the scanner. The seed list takes no deferrals: a " +
      "scanAvailability entry stops its next run before any scan unless the list first moves to version " +
      `${FEATURED_CATALOG_VERSION_FLOOR}.`
  ]
]);

/**
 * The public-safe sentences for each gate a batch missed, in counts only.
 * Shared by the runner's console, its step summary and the canonical issue so
 * the three cannot describe one run differently. Each sentence carries its
 * counts, because a rounded percentage alone can read as equal to the
 * threshold it failed.
 *
 * The catalog is required rather than defaulted: the curation advice differs
 * by catalog, and a caller that forgot it would hand the seed leg the gallery's.
 */
export function featuredBatchHealthFailures(
  {
    succeeded,
    requiredSuccessRate,
    refused,
    scannerJudged,
    scannerSuccessRate,
    refusalRate,
    refusalCeiling,
    refusalsCounted,
    meetsSuccessRate,
    meetsRefusalCeiling
  },
  catalogSlug
) {
  const curation = CATALOG_CURATION.get(catalogSlug);
  if (!curation) throw new Error("Featured batch health failures require the catalog slug: gallery or seed.");
  const reasons = [];
  if (!meetsRefusalCeiling) {
    reasons.push(
      `${refused} of ${refused + scannerJudged} eligible targets (${percent(refusalRate)}) refused an automated ` +
        `visit, above the fixed ${percent(refusalCeiling)} ceiling. The catalog needs curation: ${curation} ` +
        "If the rise is sudden rather than gradual, rule out the runner's own network first, because an " +
        "unreachable load is counted as a refusal."
    );
  }
  if (!meetsSuccessRate) {
    reasons.push(
      `The scanner succeeded on ${succeeded} of the ${scannerJudged} eligible targets ` +
        (refusalsCounted ? "that did not refuse an automated visit" : "it was judged on, with no refusal excused") +
        ` (${percent(scannerSuccessRate)}), below the required ${percent(requiredSuccessRate)}.`
    );
  }
  return reasons;
}

/**
 * Keep batch health separate from report publication. A below-threshold batch
 * must stay red, but any reports it did produce can still refresh the corpus
 * after the workflow independently revalidates them. No failed target is
 * counted as a success, and a zero-success or malformed summary publishes
 * nothing.
 */
export function featuredPublicationDecision(value, scanOutcome) {
  const summary = publicFeaturedScanSummary(value);
  const publishable = summary !== null && summary.succeeded > 0;
  const healthy =
    publishable &&
    scanOutcome === "success" &&
    summary.meetsSuccessRate &&
    summary.meetsRefusalCeiling &&
    (!summary.fullCatalog || summary.meetsFloor);
  return { publishable, healthy };
}

function inlineCode(value, fallback) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._/-]{1,200}$/.test(normalized) ? normalized : fallback;
}

function workflowRunUrl({ serverUrl, repository, runId }) {
  const server = typeof serverUrl === "string" && /^https:\/\/github\.com\/?$/.test(serverUrl.trim())
    ? serverUrl.trim().replace(/\/$/, "")
    : "https://github.com";
  const repo = typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.trim())
    ? repository.trim()
    : null;
  const id = typeof runId === "string" && /^\d+$/.test(runId.trim()) ? runId.trim() : null;
  return repo && id ? `${server}/${repo}/actions/runs/${id}` : null;
}

/**
 * Group failures by what a maintainer should DO about them.
 *
 * The success rate is one number over two populations that need opposite
 * responses. A 403, a 429, a bot wall or an unreachable load is the site
 * declining an undisguised automated visit: a real observation, not a bug, and
 * unfixable without the evasion this project refuses. A timeout or a subject
 * that could not be verified is ours.
 *
 * READS THE UNAMBIGUOUS STRUCTURED REASONS FIRST. `botBlockUnavailableReason`
 * classifies from report facts rather than from its own English, and four of
 * the five values it can return name the site declining and nothing else.
 * Classifying the diagnostic sentence instead threw that away: a Cloudflare
 * challenge page ("landing page title matches a bot-block/challenge page") and
 * a recorded soft block matched no regex and landed in `unclassified`, which is
 * counted as scanner-attributable, publishing bot-walled sites among the "N
 * attributable to this scanner and worth investigating".
 *
 * `navigation-incomplete` IS NOT ONE OF THEM, and treating it as one inverted
 * the same claim in the other direction. It is the producer's catch-all: a
 * missing HTTP response and a one-request navigation share it with three
 * outcomes that are OURS -- a navigation that did not settle, a run the quality
 * evaluator failed, and a page subject our own check could not verify. Mapping
 * the whole reason to "refused" published a scanner-side verification failure
 * as a site refusing an honest browser, which is precisely what this taxonomy
 * exists to prevent. Those keep going through the sentence, which does separate
 * them.
 *
 * THIS NOW MOVES THE GATE. The `target-refused` bucket leaves the success-rate
 * denominator and is held to its own ceiling (see {@link featuredBatchHealth}),
 * so every sentence that lands there is a sentence the scanner is no longer
 * judged on. Anything unrecognized stays `unclassified`, which is counted
 * against the scanner, never assumed to be the site declining.
 *
 * So each sentence is anchored to the TARGET'S OWN ANSWER. The scanner's
 * control plane speaks HTTP too: a bare "HTTP 429" also matched "Scan job
 * status remained temporarily unavailable (HTTP 429).", our own status route's
 * rate limit, and excused it as a site refusing the browser. A bare "could not
 * be loaded" also matched the scanner's private-address guard, which is a DNS
 * or catalog problem rather than the site declining. Both now stay counted.
 */
export function classifyFeaturedFailures(failures) {
  const kindOf = (failure) => {
    if (UNAMBIGUOUS_TARGET_REFUSALS.has(failure?.unavailableReason)) return "target-refused";
    const text = String(failure?.message ?? "");
    if (/main navigation returned HTTP (401|403|429)\b/i.test(text)) return "target-refused";
    if (/down, unreachable, or blocking automated visits/i.test(text)) return "target-refused";
    if (/only \d+ network request/i.test(text)) return "target-refused";
    if (/main navigation produced no HTTP response/i.test(text)) return "target-refused";
    if (/main navigation returned HTTP 5\d\d/i.test(text)) return "target-refused";
    if (/exceeded the maximum scan duration|did not load before/i.test(text)) return "scanner-timeout";
    if (/verify the rendered page subject/i.test(text)) return "subject-unverified";
    return "unclassified";
  };
  const groups = new Map();
  for (const failure of failures) {
    const kind = kindOf(failure);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(failure);
  }
  // Refusals first: they are the large, expected group, and burying them under
  // one-off scanner faults is what makes a rate look like a regression.
  const order = ["target-refused", "scanner-timeout", "subject-unverified", "unclassified"];
  return new Map([...groups].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])));
}

/**
 * The reasons that mean the SITE declined, and only that.
 *
 * Deliberately a subset of FEATURED_READJUDICATION_REASONS rather than that
 * list: `navigation-incomplete` is the producer's catch-all and covers three
 * scanner-side outcomes, so it cannot short-circuit a judgement about who is at
 * fault. A guard asserts this stays a strict subset.
 */
export const UNAMBIGUOUS_TARGET_REFUSALS = new Set([
  "access-denied",
  "authentication-required",
  "automation-blocked",
  "rate-limited"
]);

const FAILURE_KIND_LABELS = new Map([
  ["target-refused", "sites that refused an automated visit"],
  ["scanner-timeout", "scanner timeouts"],
  ["subject-unverified", "unverified page subjects"],
  ["unclassified", "unrecognized failures"]
]);

/**
 * Reduce classified failures to publishable counts: no names, no messages, no URLs.
 *
 * COMPUTED ON THE TRUSTED SIDE, DELIBERATELY. The alerting job never sees raw
 * per-target diagnostics; it receives only the sanitized `public_summary`
 * cross-job output. So the split has to be carried through that projection
 * rather than recomputed where the issue is written, or it would silently
 * render nothing.
 */
export function summarizeFailureTaxonomy(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return null;
  if (failures.some((failure) => !failure || typeof failure !== "object")) return null;
  const groups = classifyFeaturedFailures(failures);
  return [...groups].map(([kind, group]) => ({ kind, count: group.length }));
}

/**
 * Validate a taxonomy that arrived over the untrusted cross-job boundary.
 *
 * Returns null rather than throwing, so a malformed taxonomy costs the issue
 * its explanatory section and nothing else. It must never be able to
 * contradict the counts already published beside it, so the parts are required
 * to sum to `failed`.
 */
export function publicFailureTaxonomy(value, failed) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const counts = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { kind, count } = entry;
    if (!FAILURE_KIND_LABELS.has(kind) || seen.has(kind)) return null;
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    seen.add(kind);
    counts.push({ kind, count });
  }
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  if (total !== failed) return null;
  const refused = counts.find((entry) => entry.kind === "target-refused")?.count ?? 0;
  return { counts, refused, scannerAttributable: total - refused, total };
}

export function buildFeaturedRefreshIssueReport({ failed, summary, branch, serverUrl, repository, runId, catalogSlug }) {
  const aggregate = publicFeaturedScanSummary(summary);
  const runUrl = workflowRunUrl({ serverUrl, repository, runId });
  const safeBranch = inlineCode(branch, "default branch");
  const slug = catalogSlug === "seed" ? "seed" : "gallery";
  const catalogName = slug === "seed" ? "corpus de-bias seed list" : "featured gallery catalog";
  const lines = [
    featuredRefreshMarker(slug),
    // Kept so an issue filed before the markers were scoped is still
    // discoverable by the leg that adopts it.
    FEATURED_REFRESH_MARKER,
    "",
    `# Featured corpus refresh status (${catalogName})`,
    "",
    failed
      ? "The authoritative featured-corpus run did not meet every health gate."
      : "The authoritative featured-corpus run met its health gates.",
    "",
    `- Branch: \`${safeBranch}\``
  ];
  if (runUrl) lines.push(`- Workflow run: [view run](${runUrl})`);
  if (aggregate) {
    lines.push(...featuredBatchHealthLines(aggregate));
    for (const reason of featuredBatchHealthFailures(aggregate, slug)) {
      lines.push("", reason);
    }
  } else {
    lines.push("- Aggregate scan summary: **unavailable or invalid**");
  }

  // Without this the issue is a rate under a threshold, and a rate cannot
  // distinguish a broken scanner from a web that declines automated visits.
  // Those need opposite responses, and only one of them is a defect to fix.
  const taxonomy = aggregate ? publicFailureTaxonomy(aggregate.failureTaxonomy, aggregate.failed) : null;
  if (taxonomy) {
    lines.push("", "## Which kind of red", "");
    for (const entry of taxonomy.counts) {
      lines.push(`- ${FAILURE_KIND_LABELS.get(entry.kind) ?? entry.kind}: **${entry.count}**`);
    }
    lines.push(
      "",
      `${taxonomy.refused} of ${taxonomy.total} failures are sites refusing an undisguised automated browser. ` +
        "That is an honest observation, not a scanner defect, and it is not fixable without the evasion this " +
        "project refuses. Refusals are left out of the scanner success rate and held to the refusal ceiling instead.",
      `${taxonomy.scannerAttributable} ${taxonomy.scannerAttributable === 1 ? "is" : "are"} attributable to this ` +
        `scanner and ${taxonomy.scannerAttributable === 1 ? "is" : "are"} worth investigating.`
    );
  }

  lines.push("");
  lines.push(
    failed
      ? "Per-target names and failure reasons are intentionally omitted from this public issue. " +
          "Repository maintainers can inspect the private workflow logs linked from this run."
      : "Per-target diagnostic details are intentionally omitted from this public issue."
  );
  return `${lines.join("\n")}\n`;
}


export function isAuthoritativeFeaturedRefresh(environment) {
  return (
    environment.GITHUB_REF_TYPE === "branch" &&
    environment.GITHUB_REF_NAME === environment.FEATURED_DEFAULT_BRANCH &&
    // Both scheduled catalogs are authoritative for alerting. Requiring the
    // full-gallery selection here would have made a failed de-bias refresh
    // silent, which is how the seed half could fall an era behind unnoticed.
    isScheduledCorpusCatalogSelection(environment) &&
    environment.FEATURED_COMPARE_SHIELDS === "true" &&
    environment.FEATURED_COMPARE_CONSENT === "false" &&
    environment.FEATURED_COMPARE_GPC === "false" &&
    environment.FEATURED_DEVICE === "desktop"
  );
}

/**
 * Whether a refresh leg should raise the repair issue and fail the workflow.
 *
 * Exported and pure so the decision is testable without driving the CLI, and
 * so it cannot drift from {@link featuredPublicationDecision}, which scopes the
 * same completeness floor for publication.
 *
 * The floor belongs to the leg it was sized for. Both scheduled catalogs are
 * authoritative for ALERTING, because a broken seed refresh must not be silent,
 * but only the gallery is sized to clear the floor: the seed list is
 * deliberately smaller, so a flawless seed run reports fullCatalog=false and
 * meetsFloor=false. Applying the floor to every authoritative leg made the
 * Monday seed refresh open a repair issue and exit non-zero every week no
 * matter how well it went, which teaches an operator to ignore the alarm. Real
 * seed failures still surface through the scan outcome, batch health, and job
 * status, exactly as they do for the gallery leg.
 */
export function featuredRefreshAlertDecision(environment, aggregate) {
  const authoritative = isAuthoritativeFeaturedRefresh(environment);
  const completenessGated = authoritative && isFullFeaturedCatalogSelection(environment);
  const failed =
    environment.FEATURED_SCAN_OUTCOME !== "success" ||
    environment.FEATURED_BATCH_HEALTHY === "false" ||
    environment.FEATURED_JOB_STATUS !== "success" ||
    aggregate === null ||
    (completenessGated && (!aggregate.fullCatalog || !aggregate.meetsFloor));
  return { authoritative, completenessGated, failed };
}

async function prepareAlertFromEnvironment() {
  const summaryPath = process.env.FEATURED_SUMMARY_PATH?.trim();
  const reportPath = process.env.FEATURED_ALERT_REPORT_PATH?.trim();
  if (!reportPath) throw new Error("FEATURED_ALERT_REPORT_PATH is required.");

  let summary = null;
  const publicSummaryWire = process.env.FEATURED_PUBLIC_SUMMARY_JSON;
  if (publicSummaryWire !== undefined) {
    if (Buffer.byteLength(publicSummaryWire, "utf8") <= MAX_PUBLIC_SUMMARY_BYTES) {
      try {
        summary = JSON.parse(publicSummaryWire);
      } catch {
        // Cross-job output is untrusted. Invalid aggregate JSON becomes an
        // explicit failed refresh and is never interpolated into the issue.
      }
    }
  } else if (summaryPath) {
    try {
      summary = JSON.parse(await readFile(summaryPath, "utf8"));
    } catch {
      // Missing or malformed diagnostics are represented explicitly in the
      // safe issue report instead of copying parser or filesystem details.
    }
  }
  const aggregate = publicFeaturedScanSummary(summary);
  const { authoritative, failed } = featuredRefreshAlertDecision(process.env, aggregate);
  const catalogSlug = featuredRefreshCatalogSlug(process.env);
  const report = buildFeaturedRefreshIssueReport({
    failed,
    catalogSlug,
    summary: aggregate,
    branch: process.env.GITHUB_REF_NAME,
    serverUrl: process.env.GITHUB_SERVER_URL,
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID
  });
  await writeFile(reportPath, report, "utf8");

  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (outputPath) {
    await appendFile(
      outputPath,
      `failed=${failed}\nauthoritative=${authoritative}\ncatalog=${catalogSlug}\nmarker=${featuredRefreshMarker(catalogSlug)}\n`,
      "utf8"
    );
  }
}

async function classifyPublicationFromEnvironment() {
  const summaryPath = process.env.FEATURED_SUMMARY_PATH?.trim();
  let summary = null;
  if (summaryPath) {
    try {
      summary = JSON.parse(await readFile(summaryPath, "utf8"));
    } catch {
      // A missing or malformed summary is safely non-publishable. The alert
      // preparer later records the same condition without exposing paths.
    }
  }

  const decision = featuredPublicationDecision(summary, process.env.FEATURED_SCAN_OUTCOME);
  const aggregate = publicFeaturedScanSummary(summary);
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (outputPath) {
    const publicSummaryWire = JSON.stringify(aggregate);
    if (Buffer.byteLength(publicSummaryWire, "utf8") > MAX_PUBLIC_SUMMARY_BYTES) {
      throw new Error("Public featured summary exceeded its fixed cross-job output bound.");
    }
    await appendFile(
      outputPath,
      `publishable=${decision.publishable}\nhealthy=${decision.healthy}\npublic_summary=${publicSummaryWire}\n`,
      "utf8"
    );
  }
  console.log(
    decision.publishable
      ? `Valid scan reports are available for publication (batch healthy: ${decision.healthy}).`
      : "No valid scan reports are available for publication."
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const mode = process.argv.length === 3 ? process.argv[2] : null;
  if (mode !== "--prepare-alert" && mode !== "--classify-publication") {
    console.error(
      "Usage: run-featured-scans-diagnostics.mjs --prepare-alert | --classify-publication"
    );
    process.exitCode = 1;
  } else {
    const operation =
      mode === "--prepare-alert" ? prepareAlertFromEnvironment : classifyPublicationFromEnvironment;
    operation().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
