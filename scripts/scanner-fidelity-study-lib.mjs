import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);
let sharedCanonicalSerializer;

const METRICS = Object.freeze([
  "totalRequests",
  "thirdPartyRequests",
  "knownTrackerRequests",
  "thirdPartyDomains"
]);
const SHA256 = /^[0-9a-f]{64}$/;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
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
  const reasons = [];
  if (attempts.length !== plannedRuns) {
    reasons.push(`attempt denominator mismatch: recorded ${attempts.length}, planned ${plannedRuns}`);
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
    receiptVersion: 2,
    kind: "site-behavior-scanner-fidelity-attempt-ledger",
    createdAt: input.createdAt,
    baseOrigin: input.baseOrigin,
    sitesFile: input.sitesFile,
    provenance: {
      expectedBuildCommit: FULL_GIT_SHA.test(expectedBuildCommit) ? expectedBuildCommit : null,
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
    receiptDigest: sha256Hex(canonicalize(core))
  };
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

function canonicalize(value) {
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

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
