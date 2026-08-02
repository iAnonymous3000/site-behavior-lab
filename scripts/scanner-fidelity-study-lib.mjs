import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);
let sharedCanonicalSerializer;

export const METRICS = Object.freeze([
  "totalRequests",
  "thirdPartyRequests",
  "knownTrackerRequests",
  "thirdPartyDomains"
]);
export const SCANNER_FIDELITY_LEDGER_KIND =
  "site-behavior-scanner-fidelity-attempt-ledger";
export const SCANNER_FIDELITY_LEDGER_VERSION = 3;
const SHA256 = /^[0-9a-f]{64}$/;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const CANONICAL_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TARGET_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MINIMUM_REPEATABILITY_RUNS = 2;

export function boundedInteger(value, fallback, { min, max, label }) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(String(value))) {
    throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  }
  return parsed;
}

export function selectShard(sites, shardIndex, shardCount) {
  if (!Array.isArray(sites)) throw new TypeError("Fidelity sites must be an array.");
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 32) {
    throw new Error("Shard count must be an integer from 1 through 32.");
  }
  if (!Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error("Shard index must be inside the configured shard count.");
  }
  return sites.filter((_, index) => index % shardCount === shardIndex);
}

/**
 * Parse either the legacy fidelity catalog (`{ sites: [...] }`) or the frozen
 * release-grade A/A target frame (`[{ targetId, url }]`). The caller hashes
 * the original file bytes before JSON parsing; this projection never rewrites
 * the frame whose digest the ledger records.
 */
export function scannerFidelitySitesOf(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error("A/A target frame must be a non-empty array.");
    const targetIds = new Set();
    const urls = new Set();
    return value.map((target, index) => {
      const label = `A/A target frame entry ${index + 1}`;
      if (
        !isRecord(target) ||
        JSON.stringify(Object.keys(target).sort()) !==
          JSON.stringify(["targetId", "url"])
      ) {
        throw new Error(`${label} must contain exactly targetId and url.`);
      }
      if (
        typeof target.targetId !== "string" ||
        !TARGET_ID.test(target.targetId) ||
        targetIds.has(target.targetId)
      ) {
        throw new Error(`${label} has an invalid or duplicate targetId.`);
      }
      targetIds.add(target.targetId);
      let canonicalUrl = null;
      try {
        const parsed = new URL(target.url);
        if (
          parsed.protocol === "https:" &&
          parsed.username === "" &&
          parsed.password === "" &&
          parsed.hash === "" &&
          parsed.toString() === target.url
        ) {
          canonicalUrl = target.url;
        }
      } catch {
        // Report the single canonical URL error below.
      }
      if (canonicalUrl === null || urls.has(canonicalUrl)) {
        throw new Error(`${label} has a non-canonical or duplicate HTTPS URL.`);
      }
      urls.add(canonicalUrl);
      return { url: canonicalUrl, shape: "aa" };
    });
  }

  if (!isRecord(value) || !Array.isArray(value.sites) || value.sites.length === 0) {
    throw new Error("Scanner-fidelity sites file must contain a non-empty sites array.");
  }
  return value.sites.map((site, index) => {
    if (!isRecord(site) || !nonEmptyString(site.url) || !nonEmptyString(site.shape)) {
      throw new Error(
        `Legacy scanner-fidelity site ${index + 1} must contain non-empty url and shape strings.`
      );
    }
    return { url: site.url, shape: site.shape };
  });
}

export function sanitizeAttemptReason(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function jaccard(left, right) {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / union.size;
}

function metricSummary(values) {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const center = median(values);
  return {
    median: center,
    min: minimum,
    max: maximum,
    range: maximum - minimum,
    relativeRange: (maximum - minimum) / Math.max(1, Math.abs(center))
  };
}

function armNames(reportType) {
  return reportType === "comparison" ? ["baseline", "variant"] : ["run"];
}

function classifyObservation(attempt) {
  if (attempt.outcome !== "pass") return { ok: false, reason: `attempt-${attempt.outcome}` };
  const observation = attempt.observation;
  if (!isRecord(observation)) return { ok: false, reason: "missing-observation" };
  if (observation.reportType !== "single" && observation.reportType !== "comparison") {
    return { ok: false, reason: "unknown-report-type" };
  }
  if (!isRecord(observation.arms)) return { ok: false, reason: "missing-run-arms" };
  for (const armName of armNames(observation.reportType)) {
    const arm = observation.arms[armName];
    if (!isRecord(arm)) return { ok: false, reason: `${armName}-missing` };
    if (arm.runOutcome !== "complete") return { ok: false, reason: `${armName}-run-incomplete` };
    if (arm.requestOutcome !== "complete") return { ok: false, reason: `${armName}-requests-incomplete` };
    if (
      !isRecord(arm.counts) ||
      !METRICS.every(
        (metric) =>
          Number.isSafeInteger(arm.counts[metric]) &&
          arm.counts[metric] >= 0
      )
    ) {
      return { ok: false, reason: `${armName}-metrics-incomplete` };
    }
    if (!Array.isArray(arm.thirdPartyDomains) || arm.thirdPartyDomains.some((entry) => typeof entry !== "string")) {
      return { ok: false, reason: `${armName}-domains-incomplete` };
    }
    if (!validProducerRuntime(arm.producerRuntime)) {
      return { ok: false, reason: `${armName}-producer-runtime-unbound` };
    }
  }
  return { ok: true, observation };
}

function summarizeArm(arms) {
  const pairwiseJaccard = [];
  for (let left = 0; left < arms.length; left += 1) {
    for (let right = left + 1; right < arms.length; right += 1) {
      pairwiseJaccard.push(
        jaccard(
          new Set(arms[left].thirdPartyDomains),
          new Set(arms[right].thirdPartyDomains)
        )
      );
    }
  }
  return {
    metrics: Object.fromEntries(
      METRICS.map((metric) => [
        metric,
        metricSummary(arms.map((arm) => arm.counts[metric]))
      ])
    ),
    thirdPartyDomainJaccard: {
      min: Math.min(...pairwiseJaccard),
      median: median(pairwiseJaccard)
    }
  };
}

/**
 * Summarize repeated observations without turning instability thresholds into
 * claims about site truth. A comparison repetition is eligible only when BOTH
 * arms are invariant-clean and request-complete; every excluded attempt stays
 * in the machine-readable ledger with a reason.
 */
export function summarizeRepeatability(attempts) {
  const byTarget = new Map();
  for (const attempt of attempts) {
    const list = byTarget.get(attempt.url) ?? [];
    list.push(attempt);
    byTarget.set(attempt.url, list);
  }

  const targets = [];
  const excludedTargets = [];
  for (const [url, targetAttempts] of [...byTarget].sort(([left], [right]) => left.localeCompare(right))) {
    const eligible = [];
    const reasons = new Set();
    for (const attempt of targetAttempts) {
      const classified = classifyObservation(attempt);
      if (classified.ok) eligible.push(classified.observation);
      else reasons.add(classified.reason);
    }
    const reportTypes = new Set(eligible.map((observation) => observation.reportType));
    if (reportTypes.size > 1) {
      reasons.add("report-type-drift");
      eligible.length = 0;
    }
    if (eligible.length > 1) {
      const reportType = eligible[0].reportType;
      let identityDrift = false;
      for (const armName of armNames(reportType)) {
        for (const fingerprint of ["execution", "measurementEnvironment", "condition"]) {
          const identities = new Set(
            eligible.map(
              (observation) =>
                observation.arms[armName].producerRuntime.fingerprints[fingerprint]
            )
          );
          if (identities.size > 1) {
            reasons.add(`${armName}-${fingerprint}-identity-drift`);
            identityDrift = true;
          }
        }
        const producerRuntimeIdentities = new Set(
          eligible.map((observation) => canonicalize(observation.arms[armName].producerRuntime))
        );
        if (producerRuntimeIdentities.size > 1) {
          reasons.add(`${armName}-producer-runtime-identity-drift`);
          identityDrift = true;
        }
      }
      if (identityDrift) eligible.length = 0;
    }
    if (eligible.length < MINIMUM_REPEATABILITY_RUNS) {
      reasons.add(`fewer-than-${MINIMUM_REPEATABILITY_RUNS}-eligible-repetitions`);
      excludedTargets.push({
        url,
        recordedRuns: targetAttempts.length,
        eligibleRuns: eligible.length,
        reasons: [...reasons].sort()
      });
      continue;
    }

    const reportType = eligible[0].reportType;
    const orders = eligible
      .map((observation) => observation.order)
      .filter((order) => order === "AB" || order === "BA");
    targets.push({
      url,
      reportType,
      eligibleRuns: eligible.length,
      excludedRuns: targetAttempts.length - eligible.length,
      arms: Object.fromEntries(
        armNames(reportType).map((armName) => [
          armName,
          summarizeArm(eligible.map((observation) => observation.arms[armName]))
        ])
      ),
      interventionOrders: {
        AB: orders.filter((order) => order === "AB").length,
        BA: orders.filter((order) => order === "BA").length,
        counterbalanced: orders.includes("AB") && orders.includes("BA")
      }
    });
  }
  return {
    minimumEligibleRunsPerTarget: MINIMUM_REPEATABILITY_RUNS,
    recordedTargets: byTarget.size,
    eligibleTargets: targets.length,
    excludedTargets,
    targets
  };
}

function validProducerRuntime(value, expectedBuildCommit = null) {
  return (
    isRecord(value) &&
    typeof value.buildCommit === "string" &&
    FULL_GIT_SHA.test(value.buildCommit) &&
    (expectedBuildCommit === null || value.buildCommit === expectedBuildCommit) &&
    nonEmptyString(value.observer) &&
    nonEmptyString(value.methodologyVersion) &&
    isRecord(value.detectorRegistry) &&
    nonEmptyString(value.detectorRegistry.version) &&
    typeof value.detectorRegistry.digest === "string" &&
    SHA256.test(value.detectorRegistry.digest) &&
    isRecord(value.fingerprints) &&
    ["execution", "measurementEnvironment", "condition"].every(
      (field) => typeof value.fingerprints[field] === "string" && SHA256.test(value.fingerprints[field])
    ) &&
    isRecord(value.runtime) &&
    nonEmptyString(value.runtime.automation) &&
    isRecord(value.runtime.browser) &&
    nonEmptyString(value.runtime.browser.name) &&
    nonEmptyString(value.runtime.browser.version) &&
    isRecord(value.runtime.device) &&
    nonEmptyString(value.runtime.locale) &&
    nonEmptyString(value.runtime.language) &&
    nonEmptyString(value.runtime.timezone) &&
    isRecord(value.runtime.egress) &&
    nonEmptyString(value.runtime.egress.label) &&
    typeof value.runtime.headless === "boolean"
  );
}

function producerRuntimeRecord(value, expectedBuildCommit) {
  if (!validProducerRuntime(value, expectedBuildCommit)) {
    return null;
  }
  const record = {
    buildCommit: value.buildCommit,
    observer: value.observer,
    methodologyVersion: value.methodologyVersion,
    detectorRegistry: structuredClone(value.detectorRegistry),
    fingerprints: structuredClone(value.fingerprints),
    runtime: structuredClone(value.runtime)
  };
  return {
    ...record,
    identityDigest: sha256Hex(canonicalize(record))
  };
}

function publicObservation(observation, expectedBuildCommit) {
  if (!isRecord(observation) || !isRecord(observation.arms)) return null;
  const reportType = observation.reportType === "comparison" ? "comparison" : "single";
  const arms = {};
  for (const armName of armNames(reportType)) {
    const arm = observation.arms[armName];
    if (!isRecord(arm)) {
      arms[armName] = null;
      continue;
    }
    arms[armName] = {
      runOutcome: arm.runOutcome ?? null,
      requestOutcome: arm.requestOutcome ?? null,
      counts: isRecord(arm.counts) ? structuredClone(arm.counts) : null,
      producerRuntime: producerRuntimeRecord(arm.producerRuntime, expectedBuildCommit)
    };
  }
  return {
    schemaVersion: observation.schemaVersion ?? null,
    reportType,
    order: observation.order === "AB" || observation.order === "BA" ? observation.order : null,
    arms
  };
}

function observationHasDigestBoundProvenance(observation, expectedBuildCommit) {
  const publicValue = publicObservation(observation, expectedBuildCommit);
  return (
    publicValue !== null &&
    armNames(publicValue.reportType).every(
      (armName) => isRecord(publicValue.arms[armName]?.producerRuntime)
    )
  );
}

export function buildAttemptLedger(input) {
  const repetitions = requiredInteger(input.repetitions, "repetitions", 1);
  const selectedTargets = requiredInteger(input.selectedTargets, "selectedTargets", 1);
  const minimumAnsweringTargets = requiredInteger(
    input.acceptanceThresholds?.minimumAnsweringTargets,
    "minimumAnsweringTargets",
    0
  );
  const minimumRepeatableTargets = requiredInteger(
    input.acceptanceThresholds?.minimumRepeatableTargets,
    "minimumRepeatableTargets",
    0
  );
  const expectedBuildCommit =
    typeof input.provenance?.expectedBuildCommit === "string"
      ? input.provenance.expectedBuildCommit
      : "";
  const measurementIdentityDigest =
    typeof input.provenance?.measurementIdentityDigest === "string"
      ? input.provenance.measurementIdentityDigest
      : null;
  const attempts = input.attempts.map((attempt) => ({
    url: attempt.url,
    shape: attempt.shape,
    repetition: attempt.repetition,
    outcome: attempt.outcome,
    reason: attempt.reason ? sanitizeAttemptReason(attempt.reason) : null,
    censoredFamilies: [...new Set(attempt.censoredFamilies ?? [])].sort(),
    observation: publicObservation(attempt.observation, expectedBuildCommit)
  }));
  const repeatability = summarizeRepeatability(input.attempts);
  const answeredTargets = new Set(
    input.attempts.filter((attempt) => attempt.outcome !== "scan-failure").map((attempt) => attempt.url)
  ).size;
  const passedRuns = attempts.filter((attempt) => attempt.outcome === "pass").length;
  const invariantFailedRuns = attempts.filter((attempt) => attempt.outcome === "invariant-failure").length;
  const scanFailedRuns = attempts.filter((attempt) => attempt.outcome === "scan-failure").length;
  const provenanceMissingRuns = input.attempts.filter(
    (attempt) =>
      attempt.outcome === "pass" &&
      !observationHasDigestBoundProvenance(attempt.observation, expectedBuildCommit)
  ).length;
  const plannedRuns = repetitions * selectedTargets;
  const collectionStartedAt = input.collection?.startedAt;
  const collectionCompletedAt = input.collection?.completedAt;
  const reasons = [];
  if (attempts.length !== plannedRuns) {
    reasons.push(`attempt denominator mismatch: recorded ${attempts.length}, planned ${plannedRuns}`);
  }
  if (
    !canonicalTimestamp(collectionStartedAt) ||
    !canonicalTimestamp(collectionCompletedAt) ||
    Date.parse(collectionStartedAt) > Date.parse(collectionCompletedAt) ||
    !canonicalTimestamp(input.createdAt) ||
    Date.parse(collectionCompletedAt) > Date.parse(input.createdAt)
  ) {
    reasons.push(
      "collection chronology must be canonical startedAt <= completedAt <= createdAt"
    );
  }
  if (invariantFailedRuns > 0) {
    reasons.push(`${invariantFailedRuns} answered run(s) failed scanner invariants`);
  }
  if (answeredTargets < minimumAnsweringTargets) {
    reasons.push(
      `only ${answeredTargets} of ${selectedTargets} targets answered; ${minimumAnsweringTargets} required`
    );
  }
  if (repetitions < MINIMUM_REPEATABILITY_RUNS && minimumRepeatableTargets > 0) {
    reasons.push(
      `repeatability threshold requires at least ${MINIMUM_REPEATABILITY_RUNS} repetitions; recorded ${repetitions}`
    );
  }
  if (repeatability.eligibleTargets < minimumRepeatableTargets) {
    reasons.push(
      `only ${repeatability.eligibleTargets} targets had ${MINIMUM_REPEATABILITY_RUNS} digest-bound, invariant-clean, request-complete repetitions; ${minimumRepeatableTargets} required`
    );
  }
  if (!FULL_GIT_SHA.test(expectedBuildCommit)) {
    reasons.push("expected producer build commit is missing or malformed");
  }
  if (typeof input.provenance?.sitesFileDigest !== "string" || !SHA256.test(input.provenance.sitesFileDigest)) {
    reasons.push("site-frame digest is missing or malformed");
  }
  if (!validDriverRuntime(input.provenance?.driverRuntime)) {
    reasons.push("driver runtime provenance is missing or malformed");
  }
  if (provenanceMissingRuns > 0) {
    reasons.push(`${provenanceMissingRuns} passing run(s) lacked digest-bound producer/runtime provenance`);
  }

  const driverRuntime = validDriverRuntime(input.provenance?.driverRuntime)
    ? structuredClone(input.provenance.driverRuntime)
    : null;
  const core = {
    receiptVersion: SCANNER_FIDELITY_LEDGER_VERSION,
    kind: SCANNER_FIDELITY_LEDGER_KIND,
    createdAt: input.createdAt,
    collection: {
      startedAt: collectionStartedAt ?? null,
      completedAt: collectionCompletedAt ?? null
    },
    baseOrigin: input.baseOrigin,
    sitesFile: input.sitesFile,
    provenance: {
      expectedBuildCommit: FULL_GIT_SHA.test(expectedBuildCommit) ? expectedBuildCommit : null,
      measurementIdentityDigest:
        typeof measurementIdentityDigest === "string" && SHA256.test(measurementIdentityDigest)
          ? measurementIdentityDigest
          : null,
      sitesFileDigest:
        typeof input.provenance?.sitesFileDigest === "string" && SHA256.test(input.provenance.sitesFileDigest)
          ? input.provenance.sitesFileDigest
          : null,
      driverRuntime,
      driverRuntimeDigest: driverRuntime === null ? null : sha256Hex(canonicalize(driverRuntime))
    },
    shard: { index: input.shardIndex, count: input.shardCount },
    conditions: structuredClone(input.conditions),
    repetitions,
    selectedTargets,
    plannedRuns,
    attemptedRuns: attempts.length,
    answeredTargets,
    answeredRuns: attempts.filter((attempt) => attempt.outcome !== "scan-failure").length,
    passedRuns,
    invariantFailedRuns,
    scanFailedRuns,
    provenanceMissingRuns,
    attempts,
    repeatability,
    acceptance: {
      thresholds: {
        minimumAnsweringTargets,
        minimumRepeatableTargets,
        minimumEligibleRunsPerRepeatableTarget: MINIMUM_REPEATABILITY_RUNS,
        requireCompleteAttemptDenominator: true,
        requireNoInvariantFailures: true,
        requireDigestBoundProducerRuntime: true
      },
      outcome: reasons.length === 0 ? "pass" : "fail",
      reasons
    }
  };
  return {
    ...core,
    receiptDigest: scannerFidelityAttemptLedgerDigest(core)
  };
}

export function scannerFidelityAttemptLedgerDigest(ledger) {
  if (!isRecord(ledger)) throw new TypeError("scanner-fidelity ledger must be an object");
  const unsigned = { ...ledger };
  delete unsigned.receiptDigest;
  return sha256Hex(canonicalize(unsigned));
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

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function attemptLedgerObservationIssues(
  observation,
  label,
  expectedBuildCommit,
  issues
) {
  if (
    !exactKeys(
      observation,
      ["schemaVersion", "reportType", "order", "arms"],
      label,
      issues
    )
  ) {
    return;
  }
  if (observation.schemaVersion !== 2) issues.push(`${label}.schemaVersion must be 2`);
  if (observation.reportType !== "single" && observation.reportType !== "comparison") {
    issues.push(`${label}.reportType must be single or comparison`);
    return;
  }
  const expectedArmNames = armNames(observation.reportType);
  if (!exactKeys(observation.arms, expectedArmNames, `${label}.arms`, issues)) return;
  const allowedOrder =
    observation.reportType === "comparison"
      ? observation.order === "AB" || observation.order === "BA"
      : observation.order === null;
  if (!allowedOrder) {
    issues.push(
      `${label}.order must be AB or BA for a comparison and null for a single report`
    );
  }
  for (const armName of expectedArmNames) {
    const arm = observation.arms[armName];
    const armLabel = `${label}.arms.${armName}`;
    if (
      !exactKeys(
        arm,
        ["runOutcome", "requestOutcome", "counts", "producerRuntime"],
        armLabel,
        issues
      )
    ) {
      continue;
    }
    if (typeof arm.runOutcome !== "string" && arm.runOutcome !== null) {
      issues.push(`${armLabel}.runOutcome must be a string or null`);
    }
    if (typeof arm.requestOutcome !== "string" && arm.requestOutcome !== null) {
      issues.push(`${armLabel}.requestOutcome must be a string or null`);
    }
    if (arm.counts !== null) {
      if (exactKeys(arm.counts, METRICS, `${armLabel}.counts`, issues)) {
        for (const metric of METRICS) {
          if (!nonNegativeSafeInteger(arm.counts[metric])) {
            issues.push(`${armLabel}.counts.${metric} must be a non-negative integer`);
          }
        }
      }
    }
    const runtime = arm.producerRuntime;
    if (
      !exactKeys(
        runtime,
        [
          "buildCommit",
          "observer",
          "methodologyVersion",
          "detectorRegistry",
          "fingerprints",
          "runtime",
          "identityDigest"
        ],
        `${armLabel}.producerRuntime`,
        issues
      )
    ) {
      continue;
    }
    if (!validProducerRuntime(runtime)) {
      issues.push(`${armLabel}.producerRuntime must contain valid producer/runtime provenance`);
    }
    if (runtime.buildCommit !== expectedBuildCommit) {
      issues.push(
        `${armLabel}.producerRuntime.buildCommit must equal ledger.provenance.expectedBuildCommit`
      );
    }
    const unsignedRuntime = { ...runtime };
    delete unsignedRuntime.identityDigest;
    if (
      typeof runtime.identityDigest !== "string" ||
      !SHA256.test(runtime.identityDigest) ||
      runtime.identityDigest !== sha256Hex(canonicalize(unsignedRuntime))
    ) {
      issues.push(`${armLabel}.producerRuntime.identityDigest does not match its exact identity`);
    }
  }
}

function attemptLedgerRepeatabilityIssues(repeatability, issues) {
  if (
    !exactKeys(
      repeatability,
      [
        "minimumEligibleRunsPerTarget",
        "recordedTargets",
        "eligibleTargets",
        "excludedTargets",
        "targets"
      ],
      "ledger.repeatability",
      issues
    )
  ) {
    return;
  }
  if (repeatability.minimumEligibleRunsPerTarget !== MINIMUM_REPEATABILITY_RUNS) {
    issues.push(
      `ledger.repeatability.minimumEligibleRunsPerTarget must be ${MINIMUM_REPEATABILITY_RUNS}`
    );
  }
  for (const field of ["recordedTargets", "eligibleTargets"]) {
    if (!nonNegativeSafeInteger(repeatability[field])) {
      issues.push(`ledger.repeatability.${field} must be a non-negative integer`);
    }
  }
  if (!Array.isArray(repeatability.excludedTargets)) {
    issues.push("ledger.repeatability.excludedTargets must be an array");
  } else {
    for (const [index, excluded] of repeatability.excludedTargets.entries()) {
      const label = `ledger.repeatability.excludedTargets[${index}]`;
      if (
        !exactKeys(
          excluded,
          ["url", "recordedRuns", "eligibleRuns", "reasons"],
          label,
          issues
        )
      ) {
        continue;
      }
      if (!nonEmptyString(excluded.url)) issues.push(`${label}.url must be non-empty`);
      if (!nonNegativeSafeInteger(excluded.recordedRuns)) {
        issues.push(`${label}.recordedRuns must be a non-negative integer`);
      }
      if (!nonNegativeSafeInteger(excluded.eligibleRuns)) {
        issues.push(`${label}.eligibleRuns must be a non-negative integer`);
      }
      if (
        !Array.isArray(excluded.reasons) ||
        excluded.reasons.some((reason) => !nonEmptyString(reason))
      ) {
        issues.push(`${label}.reasons must be an array of non-empty strings`);
      }
    }
  }
  if (!Array.isArray(repeatability.targets)) {
    issues.push("ledger.repeatability.targets must be an array");
    return;
  }
  if (repeatability.eligibleTargets !== repeatability.targets.length) {
    issues.push("ledger.repeatability.eligibleTargets must equal targets.length");
  }
  for (const [index, target] of repeatability.targets.entries()) {
    const label = `ledger.repeatability.targets[${index}]`;
    if (
      !exactKeys(
        target,
        [
          "url",
          "reportType",
          "eligibleRuns",
          "excludedRuns",
          "arms",
          "interventionOrders"
        ],
        label,
        issues
      )
    ) {
      continue;
    }
    if (!nonEmptyString(target.url)) issues.push(`${label}.url must be non-empty`);
    if (target.reportType !== "single" && target.reportType !== "comparison") {
      issues.push(`${label}.reportType must be single or comparison`);
      continue;
    }
    if (!nonNegativeSafeInteger(target.eligibleRuns)) {
      issues.push(`${label}.eligibleRuns must be a non-negative integer`);
    }
    if (!nonNegativeSafeInteger(target.excludedRuns)) {
      issues.push(`${label}.excludedRuns must be a non-negative integer`);
    }
    const expectedArmNames = armNames(target.reportType);
    if (exactKeys(target.arms, expectedArmNames, `${label}.arms`, issues)) {
      for (const armName of expectedArmNames) {
        const arm = target.arms[armName];
        const armLabel = `${label}.arms.${armName}`;
        if (
          !exactKeys(
            arm,
            ["metrics", "thirdPartyDomainJaccard"],
            armLabel,
            issues
          )
        ) {
          continue;
        }
        if (exactKeys(arm.metrics, METRICS, `${armLabel}.metrics`, issues)) {
          for (const metric of METRICS) {
            const summary = arm.metrics[metric];
            const summaryLabel = `${armLabel}.metrics.${metric}`;
            if (
              exactKeys(
                summary,
                ["median", "min", "max", "range", "relativeRange"],
                summaryLabel,
                issues
              ) &&
              Object.values(summary).some(
                (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0
              )
            ) {
              issues.push(`${summaryLabel} values must be finite non-negative numbers`);
            }
          }
        }
        const jaccard = arm.thirdPartyDomainJaccard;
        if (
          exactKeys(jaccard, ["min", "median"], `${armLabel}.thirdPartyDomainJaccard`, issues)
        ) {
          for (const field of ["min", "median"]) {
            if (
              typeof jaccard[field] !== "number" ||
              !Number.isFinite(jaccard[field]) ||
              jaccard[field] < 0 ||
              jaccard[field] > 1
            ) {
              issues.push(
                `${armLabel}.thirdPartyDomainJaccard.${field} must be a fraction from 0 through 1`
              );
            }
          }
        }
      }
    }
    const orders = target.interventionOrders;
    if (
      exactKeys(
        orders,
        ["AB", "BA", "counterbalanced"],
        `${label}.interventionOrders`,
        issues
      )
    ) {
      if (!nonNegativeSafeInteger(orders.AB) || !nonNegativeSafeInteger(orders.BA)) {
        issues.push(`${label}.interventionOrders AB and BA must be non-negative integers`);
      }
      if (typeof orders.counterbalanced !== "boolean") {
        issues.push(`${label}.interventionOrders.counterbalanced must be boolean`);
      }
    }
  }
}

/**
 * Strictly validate the public scanner-fidelity ledger. Generic health runs
 * may predate a measurement candidate and therefore carry a literal null
 * measurementIdentityDigest; release-grade A/A evaluation opts into requiring
 * a concrete digest.
 */
export function scannerFidelityAttemptLedgerIssues(
  ledger,
  { requireMeasurementIdentityDigest = false } = {}
) {
  const issues = [];
  if (
    !exactKeys(
      ledger,
      [
        "receiptVersion",
        "kind",
        "createdAt",
        "collection",
        "baseOrigin",
        "sitesFile",
        "provenance",
        "shard",
        "conditions",
        "repetitions",
        "selectedTargets",
        "plannedRuns",
        "attemptedRuns",
        "answeredTargets",
        "answeredRuns",
        "passedRuns",
        "invariantFailedRuns",
        "scanFailedRuns",
        "provenanceMissingRuns",
        "attempts",
        "repeatability",
        "acceptance",
        "receiptDigest"
      ],
      "ledger",
      issues
    )
  ) {
    return issues;
  }
  if (ledger.receiptVersion !== SCANNER_FIDELITY_LEDGER_VERSION) {
    issues.push(`ledger.receiptVersion must be ${SCANNER_FIDELITY_LEDGER_VERSION}`);
  }
  if (ledger.kind !== SCANNER_FIDELITY_LEDGER_KIND) {
    issues.push(`ledger.kind must be ${SCANNER_FIDELITY_LEDGER_KIND}`);
  }
  if (!canonicalTimestamp(ledger.createdAt)) {
    issues.push("ledger.createdAt must be a canonical UTC timestamp");
  }
  if (
    exactKeys(
      ledger.collection,
      ["startedAt", "completedAt"],
      "ledger.collection",
      issues
    )
  ) {
    if (
      !canonicalTimestamp(ledger.collection.startedAt) ||
      !canonicalTimestamp(ledger.collection.completedAt) ||
      Date.parse(ledger.collection.startedAt) >
        Date.parse(ledger.collection.completedAt) ||
      (canonicalTimestamp(ledger.createdAt) &&
        Date.parse(ledger.collection.completedAt) >
          Date.parse(ledger.createdAt))
    ) {
      issues.push(
        "ledger.collection must prove canonical startedAt <= completedAt <= createdAt"
      );
    }
  }
  if (!nonEmptyString(ledger.baseOrigin)) issues.push("ledger.baseOrigin must be non-empty");
  if (!nonEmptyString(ledger.sitesFile)) issues.push("ledger.sitesFile must be non-empty");

  const provenance = ledger.provenance;
  if (
    exactKeys(
      provenance,
      [
        "expectedBuildCommit",
        "measurementIdentityDigest",
        "sitesFileDigest",
        "driverRuntime",
        "driverRuntimeDigest"
      ],
      "ledger.provenance",
      issues
    )
  ) {
    if (!FULL_GIT_SHA.test(provenance.expectedBuildCommit)) {
      issues.push("ledger.provenance.expectedBuildCommit must be a full lowercase Git SHA");
    }
    if (
      provenance.measurementIdentityDigest !== null &&
      !SHA256.test(provenance.measurementIdentityDigest)
    ) {
      issues.push(
        "ledger.provenance.measurementIdentityDigest must be a lowercase sha256 digest or null"
      );
    }
    if (
      requireMeasurementIdentityDigest &&
      !SHA256.test(provenance.measurementIdentityDigest)
    ) {
      issues.push(
        "ledger.provenance.measurementIdentityDigest must be a lowercase sha256 digest for release-grade A/A"
      );
    }
    if (!SHA256.test(provenance.sitesFileDigest)) {
      issues.push("ledger.provenance.sitesFileDigest must be a lowercase sha256 digest");
    }
    if (
      exactKeys(
        provenance.driverRuntime,
        ["nodeVersion", "platform", "architecture"],
        "ledger.provenance.driverRuntime",
        issues
      ) &&
      !validDriverRuntime(provenance.driverRuntime)
    ) {
      issues.push("ledger.provenance.driverRuntime is malformed");
    }
    if (
      typeof provenance.driverRuntimeDigest !== "string" ||
      !SHA256.test(provenance.driverRuntimeDigest) ||
      provenance.driverRuntimeDigest !==
        sha256Hex(canonicalize(provenance.driverRuntime))
    ) {
      issues.push(
        "ledger.provenance.driverRuntimeDigest does not match the exact driver runtime"
      );
    }
  }

  if (exactKeys(ledger.shard, ["index", "count"], "ledger.shard", issues)) {
    if (
      !nonNegativeSafeInteger(ledger.shard.index) ||
      !Number.isSafeInteger(ledger.shard.count) ||
      ledger.shard.count < 1 ||
      ledger.shard.index >= ledger.shard.count
    ) {
      issues.push("ledger.shard must name a valid zero-based shard inside its count");
    }
  }
  if (!isRecord(ledger.conditions)) issues.push("ledger.conditions must be an object");

  for (const field of [
    "repetitions",
    "selectedTargets",
    "plannedRuns",
    "attemptedRuns",
    "answeredTargets",
    "answeredRuns",
    "passedRuns",
    "invariantFailedRuns",
    "scanFailedRuns",
    "provenanceMissingRuns"
  ]) {
    if (!nonNegativeSafeInteger(ledger[field])) {
      issues.push(`ledger.${field} must be a non-negative integer`);
    }
  }
  if (ledger.repetitions < 1 || ledger.selectedTargets < 1) {
    issues.push("ledger.repetitions and selectedTargets must be positive");
  }
  if (ledger.plannedRuns !== ledger.repetitions * ledger.selectedTargets) {
    issues.push("ledger.plannedRuns must equal repetitions times selectedTargets");
  }
  if (!Array.isArray(ledger.attempts)) {
    issues.push("ledger.attempts must be an array");
  } else {
    if (ledger.attemptedRuns !== ledger.attempts.length) {
      issues.push("ledger.attemptedRuns must equal attempts.length");
    }
    for (const [index, attempt] of ledger.attempts.entries()) {
      const label = `ledger.attempts[${index}]`;
      if (
        !exactKeys(
          attempt,
          [
            "url",
            "shape",
            "repetition",
            "outcome",
            "reason",
            "censoredFamilies",
            "observation"
          ],
          label,
          issues
        )
      ) {
        continue;
      }
      if (!nonEmptyString(attempt.url)) issues.push(`${label}.url must be non-empty`);
      if (!nonEmptyString(attempt.shape)) issues.push(`${label}.shape must be non-empty`);
      if (!Number.isSafeInteger(attempt.repetition) || attempt.repetition < 1) {
        issues.push(`${label}.repetition must be a positive integer`);
      }
      if (
        !new Set(["pass", "invariant-failure", "scan-failure"]).has(attempt.outcome)
      ) {
        issues.push(`${label}.outcome is not recognized`);
      }
      if (attempt.reason !== null && !nonEmptyString(attempt.reason)) {
        issues.push(`${label}.reason must be a non-empty string or null`);
      }
      if (
        !Array.isArray(attempt.censoredFamilies) ||
        attempt.censoredFamilies.some((family) => !nonEmptyString(family))
      ) {
        issues.push(`${label}.censoredFamilies must be an array of non-empty strings`);
      }
      if (attempt.observation !== null) {
        attemptLedgerObservationIssues(
          attempt.observation,
          `${label}.observation`,
          ledger.provenance?.expectedBuildCommit,
          issues
        );
      }
    }
  }

  attemptLedgerRepeatabilityIssues(ledger.repeatability, issues);

  const acceptance = ledger.acceptance;
  if (
    exactKeys(acceptance, ["thresholds", "outcome", "reasons"], "ledger.acceptance", issues)
  ) {
    if (
      exactKeys(
        acceptance.thresholds,
        [
          "minimumAnsweringTargets",
          "minimumRepeatableTargets",
          "minimumEligibleRunsPerRepeatableTarget",
          "requireCompleteAttemptDenominator",
          "requireNoInvariantFailures",
          "requireDigestBoundProducerRuntime"
        ],
        "ledger.acceptance.thresholds",
        issues
      )
    ) {
      if (
        !nonNegativeSafeInteger(acceptance.thresholds.minimumAnsweringTargets) ||
        !nonNegativeSafeInteger(acceptance.thresholds.minimumRepeatableTargets)
      ) {
        issues.push("ledger.acceptance target floors must be non-negative integers");
      }
      if (
        acceptance.thresholds.minimumEligibleRunsPerRepeatableTarget !==
        MINIMUM_REPEATABILITY_RUNS
      ) {
        issues.push(
          `ledger.acceptance minimumEligibleRunsPerRepeatableTarget must be ${MINIMUM_REPEATABILITY_RUNS}`
        );
      }
      for (const field of [
        "requireCompleteAttemptDenominator",
        "requireNoInvariantFailures",
        "requireDigestBoundProducerRuntime"
      ]) {
        if (acceptance.thresholds[field] !== true) {
          issues.push(`ledger.acceptance.thresholds.${field} must be literally true`);
        }
      }
    }
    if (acceptance.outcome !== "pass" && acceptance.outcome !== "fail") {
      issues.push("ledger.acceptance.outcome must be pass or fail");
    }
    if (
      !Array.isArray(acceptance.reasons) ||
      acceptance.reasons.some((reason) => !nonEmptyString(reason))
    ) {
      issues.push("ledger.acceptance.reasons must be an array of non-empty strings");
    }
  }

  if (
    typeof ledger.receiptDigest !== "string" ||
    !SHA256.test(ledger.receiptDigest) ||
    ledger.receiptDigest !== scannerFidelityAttemptLedgerDigest(ledger)
  ) {
    issues.push("ledger.receiptDigest does not match the exact unsigned ledger");
  }
  return issues;
}

function validDriverRuntime(value) {
  return (
    isRecord(value) &&
    nonEmptyString(value.nodeVersion) &&
    nonEmptyString(value.platform) &&
    nonEmptyString(value.architecture)
  );
}

function requiredInteger(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 1_000_000) {
    throw new Error(`${label} must be a safe integer from ${minimum} through 1000000.`);
  }
  return value;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1000;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalize(value) {
  if (sharedCanonicalSerializer === undefined) {
    const candidates = [
      "../dist/schema/lib/canonical-json.js",
      "../.unit-test-dist/lib/canonical-json.js"
    ];
    for (const candidate of candidates) {
      try {
        const loaded = requireFromHere(candidate);
        if (typeof loaded.canonicalJson === "function") {
          sharedCanonicalSerializer = loaded.canonicalJson;
          break;
        }
      } catch {
        // The production fidelity driver builds dist/schema before it needs a
        // receipt; unit tests have the same module in .unit-test-dist.
      }
    }
    if (sharedCanonicalSerializer === undefined) {
      throw new Error("The shared canonical JSON module is unavailable; build the schema artifact first.");
    }
  }
  return sharedCanonicalSerializer(value);
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
