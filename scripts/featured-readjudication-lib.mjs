import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export const FEATURED_READJUDICATION_DOMAINS = Object.freeze([
  "cnn.com",
  "coinbase.com",
  "drugs.com",
  "etsy.com",
  "goodrx.com",
  "macys.com",
  "match.com",
  "mayoclinic.org",
  "okcupid.com",
  "reddit.com",
  "reuters.com",
  "wayfair.com",
  "zocdoc.com"
]);
export const FEATURED_READJUDICATION_REASONS = Object.freeze([
  "access-denied",
  "authentication-required",
  "automation-blocked",
  "navigation-incomplete",
  "rate-limited"
]);
export const FEATURED_READJUDICATION_CYCLE_KIND =
  "site-behavior-featured-readjudication-outcomes";
export const FEATURED_READJUDICATION_RECEIPT_KIND =
  "site-behavior-featured-readjudication-receipt";
export const FEATURED_READJUDICATION_RECEIPT_PATH =
  "research/ops-receipts/featured-readjudication.json";
export const FEATURED_READJUDICATION_ARTIFACT_FILE =
  "featured-readjudication-outcomes.json";
export const FEATURED_READJUDICATION_REPOSITORY =
  "iAnonymous3000/site-behavior-lab";
export const FEATURED_READJUDICATION_WORKFLOW =
  ".github/workflows/scan-featured.yml";
export const FEATURED_READJUDICATION_SCHEDULE = "23 5 * * 1";
export const FEATURED_READJUDICATION_CATALOG =
  "public/featured-sites.json";
export const FEATURED_READJUDICATION_DATES = Object.freeze([
  "2026-08-03",
  "2026-08-10"
]);
export const FEATURED_READJUDICATION_ACTIVATION_MAX_AGE_DAYS = 28;

const SHA256 = /^[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const REPORT_ID = /^[0-9]{8}-[0-9a-f]{32}$/;
const DOMAIN = /^[a-z0-9.-]{1,253}$/;
const MAX_JSON_BYTES = 256 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const CYCLE_KEYS = [
  "schemaVersion",
  "artifactKind",
  "repository",
  "workflow",
  "actionsRun",
  "catalog",
  "complete",
  "outcomes"
];
const RUN_KEYS = ["id", "attempt", "headSha", "event", "schedule"];
const CATALOG_KEYS = ["path", "sha256", "targetsSha256", "version"];
const AVAILABLE_KEYS = ["domain", "status", "reportId", "attemptCount"];
const UNAVAILABLE_KEYS = ["domain", "status", "reason"];
const NOT_ATTEMPTED_KEYS = ["domain", "status"];
const RECEIPT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "repository",
  "workflow",
  "schedule",
  "cycles",
  "finalFeaturedSites",
  "dispositions"
];
const RECEIPT_CYCLE_KEYS = [
  "date",
  "actionsRun",
  "artifact",
  "catalog",
  "complete",
  "outcomes"
];
const ARTIFACT_KEYS = ["id", "name", "sha256"];
const FINAL_CATALOG_KEYS = ["path", "sha256", "targetsSha256", "version"];
const ACTIVE_DISPOSITION_KEYS = ["domain", "status"];
const DEFERRED_DISPOSITION_KEYS = ["domain", "status", "scanAvailability"];
const AVAILABILITY_KEYS = [
  "status",
  "reason",
  "observedAt",
  "reviewAfter",
  "workflowRunIds"
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value) {
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
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])])
  );
}

export function canonicalFeaturedReadjudicationText(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

export function featuredReadjudicationSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function featuredReadjudicationWorkflowIssues(source) {
  if (typeof source !== "string" || source.length === 0) {
    return ["featured workflow source must be non-empty"];
  }
  const required = [
    '- cron: "23 5 * * 1"',
    "Canonicalize featured re-adjudication outcomes",
    "Upload featured re-adjudication outcomes",
    "github.event.schedule == '23 5 * * 1'",
    "FEATURED_SITES_FILE: public/featured-sites.json",
    "node scripts/featured-readjudication.mjs",
    "--cycle",
    "featured-readjudication-outcomes-${{ github.run_id }}-${{ github.run_attempt }}",
    "path: ${{ runner.temp }}/featured-readjudication-outcomes.json",
    "if-no-files-found: error",
    "retention-days: 45"
  ];
  return required
    .filter((fragment) => !source.includes(fragment))
    .map(
      (fragment) =>
        `featured workflow is missing re-adjudication fragment: ${fragment}`
    );
}

export function featuredReadjudicationOutcomesSha256(cycle) {
  return featuredReadjudicationSha256(
    canonicalFeaturedReadjudicationText(cycle.outcomes)
  );
}

export function featuredReadjudicationDispositionsSha256(receipt) {
  return featuredReadjudicationSha256(
    canonicalFeaturedReadjudicationText(receipt.dispositions)
  );
}

function strictJsonBytes(bytes, label) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_JSON_BYTES
  ) {
    throw new Error(`${label} must be non-empty and no larger than ${MAX_JSON_BYTES} bytes`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  try {
    return { value: JSON.parse(text), text };
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function catalogIdentity(bytes) {
  const { value } = strictJsonBytes(bytes, "featured-sites catalog");
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 2 ||
    !Array.isArray(value.sites)
  ) {
    throw new Error("featured-sites catalog must have an integer version and sites array");
  }
  const sites = new Map();
  for (const site of value.sites) {
    if (
      !isRecord(site) ||
      typeof site.domain !== "string" ||
      !DOMAIN.test(site.domain) ||
      sites.has(site.domain)
    ) {
      throw new Error("featured-sites catalog has an invalid or duplicate domain");
    }
    sites.set(site.domain, site);
  }
  for (const domain of FEATURED_READJUDICATION_DOMAINS) {
    if (!sites.has(domain)) {
      throw new Error(`featured-sites catalog is missing re-adjudication domain ${domain}`);
    }
  }
  const targets = FEATURED_READJUDICATION_DOMAINS.map((domain) => {
    const site = sites.get(domain);
    return Object.fromEntries(
      Object.entries(site)
        .filter(([key]) => key !== "scanAvailability")
        .sort(([left], [right]) => left.localeCompare(right))
    );
  });
  return {
    version: value.version,
    sha256: featuredReadjudicationSha256(bytes),
    targetsSha256: featuredReadjudicationSha256(
      canonicalFeaturedReadjudicationText(targets)
    ),
    sites
  };
}

export function featuredReadjudicationCatalogBinding(bytes) {
  const identity = catalogIdentity(bytes);
  return {
    version: identity.version,
    sha256: identity.sha256,
    targetsSha256: identity.targetsSha256
  };
}

export function featuredReadjudicationActivationFreshnessIssues(
  receipt,
  activatedAt
) {
  const issues = [];
  const activationTime = Date.parse(activatedAt);
  if (
    typeof activatedAt !== "string" ||
    !Number.isFinite(activationTime) ||
    new Date(activationTime).toISOString() !== activatedAt
  ) {
    return ["measurement-freeze activation time must be one canonical UTC instant"];
  }
  const finalCycleDate = FEATURED_READJUDICATION_DATES.at(-1);
  const finalCycleStart = Date.parse(`${finalCycleDate}T00:00:00.000Z`);
  const latestActivation =
    finalCycleStart +
    (FEATURED_READJUDICATION_ACTIVATION_MAX_AGE_DAYS + 1) * DAY_MS -
    1;
  if (activationTime < finalCycleStart) {
    issues.push(
      `measurement-freeze activation must not precede the ${finalCycleDate} re-adjudication cycle`
    );
  }
  if (activationTime > latestActivation) {
    issues.push(
      `measurement-freeze activation must occur within ${FEATURED_READJUDICATION_ACTIVATION_MAX_AGE_DAYS} calendar days after ${finalCycleDate}`
    );
  }
  if (receipt !== undefined) {
    if (!isRecord(receipt) || !Array.isArray(receipt.dispositions)) {
      issues.push("featured re-adjudication receipt has no dispositions for activation freshness");
    } else {
      for (const disposition of receipt.dispositions) {
        if (disposition?.status !== "deferred") continue;
        const reviewAfter = disposition.scanAvailability?.reviewAfter;
        const reviewTime =
          typeof reviewAfter === "string"
            ? Date.parse(`${reviewAfter}T00:00:00.000Z`)
            : Number.NaN;
        if (!Number.isFinite(reviewTime) || reviewTime <= activationTime) {
          issues.push(
            `deferred re-adjudication domain ${String(disposition?.domain)} must retain a reviewAfter date later than activation`
          );
        }
      }
    }
  }
  return issues;
}

function sanitizeCycleOutcomes(summary) {
  const entries = Array.isArray(summary?.scanResults)
    ? summary.scanResults
    : [];
  const byDomain = new Map();
  const duplicates = new Set();
  for (const entry of entries) {
    if (
      isRecord(entry) &&
      typeof entry.domain === "string" &&
      FEATURED_READJUDICATION_DOMAINS.includes(entry.domain)
    ) {
      if (byDomain.has(entry.domain)) duplicates.add(entry.domain);
      else byDomain.set(entry.domain, entry);
    }
  }
  return FEATURED_READJUDICATION_DOMAINS.map((domain) => {
    if (duplicates.has(domain)) return { domain, status: "not-attempted" };
    const entry = byDomain.get(domain);
    if (
      entry?.status === "available" &&
      typeof entry.reportId === "string" &&
      REPORT_ID.test(entry.reportId) &&
      positiveInteger(entry.attemptCount) &&
      entry.attemptCount <= 3
    ) {
      return {
        domain,
        status: "available",
        reportId: entry.reportId,
        attemptCount: entry.attemptCount
      };
    }
    if (
      entry?.status === "unavailable" &&
      FEATURED_READJUDICATION_REASONS.includes(entry.reason)
    ) {
      return { domain, status: "unavailable", reason: entry.reason };
    }
    return { domain, status: "not-attempted" };
  });
}

export function buildFeaturedReadjudicationCycle(input) {
  const catalog = catalogIdentity(input.catalogBytes);
  const outcomes = sanitizeCycleOutcomes(input.summary);
  return {
    schemaVersion: 1,
    artifactKind: FEATURED_READJUDICATION_CYCLE_KIND,
    repository: input.repository,
    workflow: input.workflow,
    actionsRun: {
      id: input.runId,
      attempt: input.runAttempt,
      headSha: input.headSha,
      event: input.event,
      schedule: input.schedule
    },
    catalog: {
      path: input.catalogPath,
      sha256: catalog.sha256,
      targetsSha256: catalog.targetsSha256,
      version: catalog.version
    },
    complete: outcomes.every((outcome) => outcome.status !== "not-attempted"),
    outcomes
  };
}

export function featuredReadjudicationCycleIssues(cycle) {
  const issues = [];
  if (!exactKeys(cycle, CYCLE_KEYS, "cycle", issues)) return issues;
  if (cycle.schemaVersion !== 1) issues.push("cycle schemaVersion must be exactly 1");
  if (cycle.artifactKind !== FEATURED_READJUDICATION_CYCLE_KIND) {
    issues.push(`cycle artifactKind must be exactly ${FEATURED_READJUDICATION_CYCLE_KIND}`);
  }
  if (cycle.repository !== FEATURED_READJUDICATION_REPOSITORY) {
    issues.push(`cycle repository must be exactly ${FEATURED_READJUDICATION_REPOSITORY}`);
  }
  if (cycle.workflow !== FEATURED_READJUDICATION_WORKFLOW) {
    issues.push(`cycle workflow must be exactly ${FEATURED_READJUDICATION_WORKFLOW}`);
  }
  if (exactKeys(cycle.actionsRun, RUN_KEYS, "cycle.actionsRun", issues)) {
    if (!positiveInteger(cycle.actionsRun.id)) issues.push("cycle actions run id must be positive");
    if (!positiveInteger(cycle.actionsRun.attempt)) issues.push("cycle actions run attempt must be positive");
    if (!FULL_SHA.test(cycle.actionsRun.headSha ?? "")) issues.push("cycle head SHA must be full lowercase");
    if (cycle.actionsRun.event !== "schedule") issues.push("cycle event must be exactly schedule");
    if (cycle.actionsRun.schedule !== FEATURED_READJUDICATION_SCHEDULE) {
      issues.push(`cycle schedule must be exactly ${FEATURED_READJUDICATION_SCHEDULE}`);
    }
  }
  if (exactKeys(cycle.catalog, CATALOG_KEYS, "cycle.catalog", issues)) {
    if (cycle.catalog.path !== FEATURED_READJUDICATION_CATALOG) {
      issues.push(`cycle catalog path must be exactly ${FEATURED_READJUDICATION_CATALOG}`);
    }
    if (!SHA256.test(cycle.catalog.sha256 ?? "")) issues.push("cycle catalog sha256 is invalid");
    if (!SHA256.test(cycle.catalog.targetsSha256 ?? "")) {
      issues.push("cycle catalog targetsSha256 is invalid");
    }
    if (!Number.isSafeInteger(cycle.catalog.version) || cycle.catalog.version < 2) {
      issues.push("cycle catalog version must be an integer of at least 2");
    }
  }
  if (
    !Array.isArray(cycle.outcomes) ||
    cycle.outcomes.length !== FEATURED_READJUDICATION_DOMAINS.length
  ) {
    issues.push("cycle outcomes must contain exactly the fixed 13 domains");
  } else {
    for (const [index, outcome] of cycle.outcomes.entries()) {
      const domain = FEATURED_READJUDICATION_DOMAINS[index];
      const keys =
        outcome?.status === "available"
          ? AVAILABLE_KEYS
          : outcome?.status === "unavailable"
            ? UNAVAILABLE_KEYS
            : NOT_ATTEMPTED_KEYS;
      if (!exactKeys(outcome, keys, `cycle.outcomes[${index}]`, issues)) continue;
      if (outcome.domain !== domain) issues.push(`cycle.outcomes[${index}].domain must be ${domain}`);
      if (outcome.status === "available") {
        if (!REPORT_ID.test(outcome.reportId ?? "")) issues.push(`cycle outcome ${domain} reportId is invalid`);
        if (!positiveInteger(outcome.attemptCount) || outcome.attemptCount > 3) {
          issues.push(`cycle outcome ${domain} attemptCount must be 1 through 3`);
        }
      } else if (outcome.status === "unavailable") {
        if (!FEATURED_READJUDICATION_REASONS.includes(outcome.reason)) {
          issues.push(`cycle outcome ${domain} must have a closed unavailable reason`);
        }
      } else if (outcome.status !== "not-attempted") {
        issues.push(`cycle outcome ${domain} must have a closed unavailable reason`);
      }
    }
  }
  if (typeof cycle.complete !== "boolean") {
    issues.push("cycle complete must be a boolean");
  } else if (
    Array.isArray(cycle.outcomes) &&
    cycle.complete !==
      cycle.outcomes.every((outcome) => outcome?.status !== "not-attempted")
  ) {
    issues.push("cycle complete must exactly reflect whether all 13 domains were attempted");
  }
  return issues;
}

export function parseFeaturedReadjudicationCycle(text) {
  let cycle;
  try {
    cycle = JSON.parse(text);
  } catch {
    throw new Error("re-adjudication cycle is not valid JSON");
  }
  const issues = featuredReadjudicationCycleIssues(cycle);
  if (text !== canonicalFeaturedReadjudicationText(cycle)) {
    issues.unshift("re-adjudication cycle bytes are not canonical JSON");
  }
  if (issues.length > 0) throw new Error(issues.join("; "));
  return cycle;
}

function validateAvailability(value, runIds) {
  const issues = [];
  if (!exactKeys(value, AVAILABILITY_KEYS, "scanAvailability", issues)) {
    throw new Error(issues.join("; "));
  }
  if (
    value.status !== "temporarily-unavailable" ||
    !FEATURED_READJUDICATION_REASONS.includes(value.reason) ||
    value.observedAt !== FEATURED_READJUDICATION_DATES[1]
  ) {
    throw new Error("deferred scanAvailability has invalid status, reason, or observedAt");
  }
  const review = Date.parse(`${value.reviewAfter}T00:00:00.000Z`);
  const observed = Date.parse(`${value.observedAt}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value.reviewAfter ?? "") ||
    !Number.isFinite(review) ||
    new Date(review).toISOString().slice(0, 10) !== value.reviewAfter ||
    review <= observed ||
    review - observed > 28 * DAY_MS
  ) {
    throw new Error("deferred scanAvailability reviewAfter must be 1 through 28 days after observedAt");
  }
  if (JSON.stringify(value.workflowRunIds) !== JSON.stringify(runIds.map(String))) {
    throw new Error("deferred scanAvailability must reference exactly both cycle run ids");
  }
  return value;
}

function deriveDispositions(cycles, sites) {
  if (
    cycles.some(
      (cycle) =>
        cycle.complete !== true ||
        cycle.outcomes.some((outcome) => outcome.status === "not-attempted")
    )
  ) {
    throw new Error(
      "both re-adjudication cycles must attempt all fixed 13 domains"
    );
  }
  const runIds = cycles.map((cycle) => cycle.actionsRun.id);
  return FEATURED_READJUDICATION_DOMAINS.map((domain, index) => {
    const outcomes = cycles.map((cycle) => cycle.outcomes[index]);
    const bothUnavailable = outcomes.every((outcome) => outcome.status === "unavailable");
    const site = sites.get(domain);
    const repeatedSameReason =
      bothUnavailable && outcomes[0].reason === outcomes[1].reason;
    if (!repeatedSameReason) {
      if (site.scanAvailability !== undefined) {
        throw new Error(`active re-adjudication domain ${domain} must not retain scanAvailability`);
      }
      return { domain, status: "active" };
    }
    const availability = validateAvailability(site.scanAvailability, runIds);
    if (availability.reason !== outcomes[0].reason) {
      throw new Error(`scanAvailability reason does not match both cycles for ${domain}`);
    }
    return {
      domain,
      status: "deferred",
      scanAvailability: availability
    };
  });
}

export function buildFeaturedReadjudicationReceipt(input) {
  if (!Array.isArray(input.cycles) || input.cycles.length !== 2) {
    throw new Error("aggregate receipt requires exactly two cycle bindings");
  }
  const catalog = catalogIdentity(input.featuredSitesBytes);
  const cycles = input.cycles.map((binding, index) => {
    const cycle =
      typeof binding.cycleText === "string"
        ? parseFeaturedReadjudicationCycle(binding.cycleText)
        : binding.cycle;
    const cycleIssues = featuredReadjudicationCycleIssues(cycle);
    if (cycleIssues.length > 0) throw new Error(cycleIssues.join("; "));
    const expectedName =
      `featured-readjudication-outcomes-${cycle.actionsRun.id}-${cycle.actionsRun.attempt}`;
    if (
      !positiveInteger(binding.artifactId) ||
      binding.artifactName !== expectedName ||
      !SHA256.test(binding.artifactSha256 ?? "")
    ) {
      throw new Error(`cycle ${index + 1} artifact identity is invalid`);
    }
    const expectedReportDate =
      FEATURED_READJUDICATION_DATES[index].replaceAll("-", "");
    if (
      cycle.outcomes.some(
        (outcome) =>
          outcome.status === "available" &&
          !outcome.reportId.startsWith(`${expectedReportDate}-`)
      )
    ) {
      throw new Error(
        `cycle ${index + 1} available report ids must match ${FEATURED_READJUDICATION_DATES[index]}`
      );
    }
    return {
      date: FEATURED_READJUDICATION_DATES[index],
      actionsRun: cycle.actionsRun,
      artifact: {
        id: binding.artifactId,
        name: binding.artifactName,
        sha256: binding.artifactSha256
      },
      catalog: cycle.catalog,
      complete: cycle.complete,
      outcomes: cycle.outcomes
    };
  });
  if (
    cycles[0].actionsRun.id === cycles[1].actionsRun.id ||
    cycles[0].artifact.id === cycles[1].artifact.id
  ) {
    throw new Error("re-adjudication cycles must have distinct run and artifact ids");
  }
  if (cycles[0].catalog.targetsSha256 !== cycles[1].catalog.targetsSha256) {
    throw new Error(
      "re-adjudication cycles must bind identical fixed-domain target identities"
    );
  }
  if (cycles[0].catalog.targetsSha256 !== catalog.targetsSha256) {
    throw new Error(
      "final featured catalog must preserve the two-cycle fixed-domain target identities"
    );
  }
  const dispositions = deriveDispositions(cycles, catalog.sites);
  return {
    schemaVersion: 1,
    artifactKind: FEATURED_READJUDICATION_RECEIPT_KIND,
    repository: FEATURED_READJUDICATION_REPOSITORY,
    workflow: FEATURED_READJUDICATION_WORKFLOW,
    schedule: FEATURED_READJUDICATION_SCHEDULE,
    cycles,
    finalFeaturedSites: {
      path: FEATURED_READJUDICATION_CATALOG,
      sha256: catalog.sha256,
      targetsSha256: catalog.targetsSha256,
      version: catalog.version
    },
    dispositions
  };
}

export function featuredReadjudicationReceiptIssues(receipt, featuredSitesBytes) {
  const issues = [];
  if (!exactKeys(receipt, RECEIPT_KEYS, "receipt", issues)) return issues;
  if (receipt.schemaVersion !== 1) issues.push("receipt schemaVersion must be exactly 1");
  if (receipt.artifactKind !== FEATURED_READJUDICATION_RECEIPT_KIND) {
    issues.push(`receipt artifactKind must be exactly ${FEATURED_READJUDICATION_RECEIPT_KIND}`);
  }
  if (receipt.repository !== FEATURED_READJUDICATION_REPOSITORY) issues.push("receipt repository is invalid");
  if (receipt.workflow !== FEATURED_READJUDICATION_WORKFLOW) issues.push("receipt workflow is invalid");
  if (receipt.schedule !== FEATURED_READJUDICATION_SCHEDULE) issues.push("receipt schedule is invalid");
  if (!Array.isArray(receipt.cycles) || receipt.cycles.length !== 2) {
    issues.push("receipt cycles must contain exactly Aug 3 and Aug 10");
    return issues;
  }
  let catalog;
  try {
    catalog = catalogIdentity(featuredSitesBytes);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return issues;
  }
  if (exactKeys(receipt.finalFeaturedSites, FINAL_CATALOG_KEYS, "finalFeaturedSites", issues)) {
    if (
      receipt.finalFeaturedSites.path !== FEATURED_READJUDICATION_CATALOG ||
      receipt.finalFeaturedSites.sha256 !== catalog.sha256 ||
      receipt.finalFeaturedSites.targetsSha256 !== catalog.targetsSha256 ||
      receipt.finalFeaturedSites.version !== catalog.version
    ) {
      issues.push("finalFeaturedSites does not bind the exact candidate catalog");
    }
  }
  const runIds = new Set();
  const artifactIds = new Set();
  const cycleTargetDigests = new Set();
  for (const [index, cycle] of receipt.cycles.entries()) {
    if (!exactKeys(cycle, RECEIPT_CYCLE_KEYS, `cycles[${index}]`, issues)) continue;
    if (cycle.date !== FEATURED_READJUDICATION_DATES[index]) {
      issues.push(`cycles[${index}].date must be ${FEATURED_READJUDICATION_DATES[index]}`);
    }
    const pseudo = {
      schemaVersion: 1,
      artifactKind: FEATURED_READJUDICATION_CYCLE_KIND,
      repository: receipt.repository,
      workflow: receipt.workflow,
      actionsRun: cycle.actionsRun,
      catalog: cycle.catalog,
      complete: cycle.complete,
      outcomes: cycle.outcomes
    };
    issues.push(
      ...featuredReadjudicationCycleIssues(pseudo).map(
        (issue) => `cycles[${index}]: ${issue}`
      )
    );
    if (exactKeys(cycle.artifact, ARTIFACT_KEYS, `cycles[${index}].artifact`, issues)) {
      const expectedName =
        `featured-readjudication-outcomes-${cycle.actionsRun?.id}-${cycle.actionsRun?.attempt}`;
      if (
        !positiveInteger(cycle.artifact.id) ||
        cycle.artifact.name !== expectedName ||
        !SHA256.test(cycle.artifact.sha256 ?? "")
      ) {
        issues.push(`cycles[${index}].artifact identity is invalid`);
      }
      if (artifactIds.has(cycle.artifact.id)) issues.push("cycle artifact ids must be distinct");
      artifactIds.add(cycle.artifact.id);
    }
    if (runIds.has(cycle.actionsRun?.id)) issues.push("cycle run ids must be distinct");
    runIds.add(cycle.actionsRun?.id);
    if (SHA256.test(cycle.catalog?.targetsSha256 ?? "")) {
      cycleTargetDigests.add(cycle.catalog.targetsSha256);
    }
  }
  if (cycleTargetDigests.size !== 1) {
    issues.push(
      "re-adjudication cycles must bind identical fixed-domain target identities"
    );
  } else if (
    receipt.finalFeaturedSites?.targetsSha256 !==
    [...cycleTargetDigests][0]
  ) {
    issues.push(
      "final featured catalog must preserve the two-cycle fixed-domain target identities"
    );
  }
  let derived;
  try {
    derived = deriveDispositions(receipt.cycles, catalog.sites);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  if (
    derived &&
    JSON.stringify(canonicalValue(receipt.dispositions)) !==
      JSON.stringify(canonicalValue(derived))
  ) {
    issues.push("receipt dispositions do not match the two cycles and final featured catalog");
  }
  if (
    !Array.isArray(receipt.dispositions) ||
    receipt.dispositions.length !== FEATURED_READJUDICATION_DOMAINS.length
  ) {
    issues.push("receipt dispositions must contain exactly the fixed 13 domains");
  } else {
    for (const [index, disposition] of receipt.dispositions.entries()) {
      const keys =
        disposition?.status === "deferred"
          ? DEFERRED_DISPOSITION_KEYS
          : ACTIVE_DISPOSITION_KEYS;
      if (!exactKeys(disposition, keys, `dispositions[${index}]`, issues)) continue;
      if (disposition.domain !== FEATURED_READJUDICATION_DOMAINS[index]) {
        issues.push(`dispositions[${index}] domain is out of order`);
      }
      if (!["active", "deferred"].includes(disposition.status)) {
        issues.push(`dispositions[${index}] status is invalid`);
      }
    }
  }
  return issues;
}

export function parseFeaturedReadjudicationReceipt(text, featuredSitesBytes) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw new Error("featured re-adjudication receipt is not valid JSON");
  }
  const issues = featuredReadjudicationReceiptIssues(receipt, featuredSitesBytes);
  if (text !== canonicalFeaturedReadjudicationText(receipt)) {
    issues.unshift("featured re-adjudication receipt bytes are not canonical JSON");
  }
  if (issues.length > 0) throw new Error(issues.join("; "));
  return receipt;
}

// Strict single-file ZIP reader for immutable Actions artifacts downloaded by
// id. It accepts only one caller-declared, sanitized filename and bounded store
// or deflate data; traversal, comments, ZIP64, encryption, extra entries, gaps,
// and local/central disagreement are refused.
export function extractExactSingleFileArtifactZip(
  archiveBytes,
  expectedFilename
) {
  if (
    typeof expectedFilename !== "string" ||
    expectedFilename === "." ||
    expectedFilename === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(expectedFilename)
  ) {
    throw new Error("expected artifact filename must be one sanitized basename");
  }
  if (!(archiveBytes instanceof Uint8Array)) {
    throw new Error("artifact ZIP must be exact bytes");
  }
  const archive = Buffer.from(archiveBytes);
  if (archive.length < 22 || archive.length > 1024 * 1024) {
    throw new Error("artifact ZIP size is invalid");
  }
  const eocd = archive.length - 22;
  if (archive.readUInt32LE(eocd) !== 0x06054b50) throw new Error("artifact ZIP EOCD is invalid");
  if (
    archive.readUInt16LE(eocd + 4) !== 0 ||
    archive.readUInt16LE(eocd + 6) !== 0 ||
    archive.readUInt16LE(eocd + 8) !== 1 ||
    archive.readUInt16LE(eocd + 10) !== 1 ||
    archive.readUInt16LE(eocd + 20) !== 0
  ) {
    throw new Error("artifact ZIP must contain exactly one entry without ZIP64/comment");
  }
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize !== eocd || centralSize < 46) {
    throw new Error("artifact ZIP central directory is invalid");
  }
  if (archive.readUInt32LE(centralOffset) !== 0x02014b50) {
    throw new Error("artifact ZIP central header is invalid");
  }
  const madeBy = archive.readUInt16LE(centralOffset + 4);
  const needed = archive.readUInt16LE(centralOffset + 6);
  const flags = archive.readUInt16LE(centralOffset + 8);
  const method = archive.readUInt16LE(centralOffset + 10);
  const checksum = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
  const nameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const commentLength = archive.readUInt16LE(centralOffset + 32);
  const diskStart = archive.readUInt16LE(centralOffset + 34);
  const externalAttributes = archive.readUInt32LE(centralOffset + 38);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  if (
    needed > 20 ||
    (flags & ~((1 << 11) | (1 << 3))) !== 0 ||
    (method !== 0 && method !== 8) ||
    compressedSize === 0xffffffff ||
    uncompressedSize === 0xffffffff ||
    uncompressedSize <= 0 ||
    uncompressedSize > MAX_JSON_BYTES ||
    (method === 0 && compressedSize !== uncompressedSize) ||
    compressedSize > MAX_JSON_BYTES ||
    extraLength !== 0 ||
    commentLength !== 0 ||
    diskStart !== 0 ||
    localOffset !== 0 ||
    46 + nameLength + extraLength !== centralSize
  ) {
    throw new Error("artifact ZIP entry flags, sizes, or layout are invalid");
  }
  if ((externalAttributes & 0x10) !== 0) {
    throw new Error("artifact ZIP directory entries are forbidden");
  }
  if ((madeBy >>> 8) === 3) {
    const fileType = (externalAttributes >>> 16) & 0xf000;
    if (fileType !== 0 && fileType !== 0x8000) {
      throw new Error("artifact ZIP entry must be a regular file");
    }
  }
  let centralName;
  try {
    centralName = new TextDecoder("utf-8", { fatal: true }).decode(
      archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength)
    );
  } catch {
    throw new Error("artifact ZIP filename must be valid UTF-8");
  }
  if (centralName !== expectedFilename) {
    throw new Error("artifact ZIP contains an unexpected filename");
  }
  if (archive.readUInt32LE(0) !== 0x04034b50) throw new Error("artifact ZIP local header is invalid");
  const localFlags = archive.readUInt16LE(6);
  const localMethod = archive.readUInt16LE(8);
  const localNameLength = archive.readUInt16LE(26);
  const localExtraLength = archive.readUInt16LE(28);
  let localName;
  try {
    localName = new TextDecoder("utf-8", { fatal: true }).decode(
      archive.subarray(30, 30 + localNameLength)
    );
  } catch {
    throw new Error("artifact ZIP local filename must be valid UTF-8");
  }
  if (
    localFlags !== flags ||
    localMethod !== method ||
    localName !== centralName ||
    localNameLength !== nameLength ||
    localExtraLength !== extraLength
  ) {
    throw new Error("artifact ZIP local and central headers disagree");
  }
  const dataStart = 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > centralOffset) throw new Error("artifact ZIP data overlaps central directory");
  const descriptor = (flags & (1 << 3)) !== 0;
  let recordEnd = dataEnd;
  if (descriptor) {
    const signed = archive.readUInt32LE(dataEnd) === 0x08074b50;
    const offset = signed ? 4 : 0;
    if (
      dataEnd + offset + 12 > centralOffset ||
      archive.readUInt32LE(dataEnd + offset) !== checksum ||
      archive.readUInt32LE(dataEnd + offset + 4) !== compressedSize ||
      archive.readUInt32LE(dataEnd + offset + 8) !== uncompressedSize
    ) {
      throw new Error("artifact ZIP data descriptor is invalid");
    }
    recordEnd = dataEnd + offset + 12;
  } else if (
    archive.readUInt32LE(14) !== checksum ||
    archive.readUInt32LE(18) !== compressedSize ||
    archive.readUInt32LE(22) !== uncompressedSize
  ) {
    throw new Error("artifact ZIP local sizes or CRC disagree");
  }
  if (recordEnd !== centralOffset) throw new Error("artifact ZIP contains gaps or hidden data");
  let contents;
  try {
    if (method === 0) {
      contents = Buffer.from(archive.subarray(dataStart, dataEnd));
    } else {
      const compressed = archive.subarray(dataStart, dataEnd);
      const result = inflateRawSync(compressed, {
        maxOutputLength: uncompressedSize,
        info: true
      });
      if (result.engine.bytesWritten !== compressed.byteLength) {
        throw new Error("deflate stream did not consume its exact extent");
      }
      contents = result.buffer;
    }
  } catch {
    throw new Error("artifact ZIP deflate data is invalid");
  }
  if (
    contents.length !== uncompressedSize ||
    crc32(contents) !== checksum
  ) {
    throw new Error("artifact ZIP extracted length or CRC is invalid");
  }
  return contents;
}

export function extractFeaturedReadjudicationArtifactZip(archiveBytes) {
  return extractExactSingleFileArtifactZip(
    archiveBytes,
    FEATURED_READJUDICATION_ARTIFACT_FILE
  );
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value) {
  let checksum = 0xffffffff;
  for (const byte of value) {
    checksum = CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
