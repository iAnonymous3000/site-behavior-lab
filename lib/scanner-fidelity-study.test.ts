import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

type ProducerRuntime = {
  buildCommit: string;
  observer: string;
  methodologyVersion: string;
  detectorRegistry: { version: string; digest: string };
  fingerprints: {
    execution: string;
    measurementEnvironment: string;
    condition: string;
  };
  runtime: {
    automation: string;
    browser: { name: string; version: string };
    device: { kind: string };
    locale: string;
    language: string;
    timezone: string;
    egress: { label: string };
    headless: boolean;
  };
};
type ArmObservation = {
  runOutcome: "complete" | "failed";
  requestOutcome: "complete" | "censored";
  counts: Record<string, number>;
  thirdPartyDomains: string[];
  producerRuntime: ProducerRuntime;
};
type Observation = {
  schemaVersion: number;
  reportType: "single" | "comparison";
  arms: Record<string, ArmObservation>;
  order: "AB" | "BA" | null;
};
type Attempt = {
  url: string;
  shape: string;
  repetition: number;
  outcome: "pass" | "invariant-failure" | "scan-failure";
  reason: string | null;
  censoredFamilies: string[];
  observation: Observation | null;
};
type StudyHelpers = {
  boundedInteger(
    value: unknown,
    fallback: number,
    bounds: { min: number; max: number; label: string }
  ): number;
  selectShard<T>(sites: T[], index: number, count: number): T[];
  sanitizeAttemptReason(value: unknown): string;
  summarizeRepeatability(attempts: Attempt[]): {
    eligibleTargets: number;
    excludedTargets: Array<Record<string, any>>;
    targets: Array<Record<string, any>>;
  };
  buildAttemptLedger(input: Record<string, any>): Record<string, any>;
};
type InvariantHelpers = {
  fidelityObservationOf(wire: Record<string, any>): Observation;
};

const BUILD_COMMIT = "a".repeat(40);
const RECEIPT_PROVENANCE = {
  expectedBuildCommit: BUILD_COMMIT,
  sitesFileDigest: "b".repeat(64),
  driverRuntime: {
    nodeVersion: "24.14.1",
    platform: "linux",
    architecture: "x64"
  }
};
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<unknown>;
const helpers = dynamicImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "scanner-fidelity-study-lib.mjs")).href
) as Promise<StudyHelpers>;
const invariantHelpers = dynamicImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "scanner-fidelity-invariants.mjs")).href
) as Promise<InvariantHelpers>;

function producerRuntime(): ProducerRuntime {
  return {
    buildCommit: BUILD_COMMIT,
    observer: "node-playwright",
    methodologyVersion: "methodology-v1",
    detectorRegistry: { version: "registry-v1", digest: "1".repeat(64) },
    fingerprints: {
      execution: "2".repeat(64),
      measurementEnvironment: "3".repeat(64),
      condition: "4".repeat(64)
    },
    runtime: {
      automation: "playwright-chromium",
      browser: { name: "chromium", version: "145.0.0.0" },
      device: { kind: "desktop" },
      locale: "en-US",
      language: "en-US",
      timezone: "UTC",
      egress: { label: "fixture-egress" },
      headless: true
    }
  };
}

function armObservation(thirdPartyRequests: number, domains: string[]): ArmObservation {
  return {
    runOutcome: "complete",
    requestOutcome: "complete",
    counts: {
      totalRequests: thirdPartyRequests + 10,
      thirdPartyRequests,
      knownTrackerRequests: Math.floor(thirdPartyRequests / 2),
      thirdPartyDomains: domains.length
    },
    thirdPartyDomains: domains,
    producerRuntime: producerRuntime()
  };
}

function singleObservation(thirdPartyRequests: number, domains: string[]): Observation {
  return {
    schemaVersion: 2,
    reportType: "single",
    arms: { run: armObservation(thirdPartyRequests, domains) },
    order: null
  };
}

function comparisonObservation(
  baselineRequests: number,
  variantRequests: number,
  domains: string[],
  order: "AB" | "BA"
): Observation {
  return {
    schemaVersion: 2,
    reportType: "comparison",
    arms: {
      baseline: armObservation(baselineRequests, domains),
      variant: armObservation(variantRequests, domains)
    },
    order
  };
}

function attempt(repetition: number, observed: Observation): Attempt {
  return {
    url: "https://example.com/",
    shape: "fixture",
    repetition,
    outcome: "pass",
    reason: null,
    censoredFamilies: [],
    observation: observed
  };
}

test("scanner fidelity shards cover every target exactly once", async () => {
  const { boundedInteger, selectShard } = await helpers;
  const sites = Array.from({ length: 11 }, (_, index) => index);
  const shards = [0, 1, 2].flatMap((index) => selectShard(sites, index, 3));

  assert.deepEqual([...shards].sort((left, right) => left - right), sites);
  assert.equal(new Set(shards).size, sites.length);
  assert.equal(boundedInteger("3", 1, { min: 1, max: 5, label: "repetitions" }), 3);
  assert.throws(
    () => boundedInteger("1.5", 1, { min: 1, max: 5, label: "repetitions" }),
    /integer from 1 through 5/
  );
  assert.throws(() => selectShard(sites, 3, 3), /inside the configured shard count/);
});

test("comparison repeatability measures both arms and excludes a censored variant", async () => {
  const { summarizeRepeatability } = await helpers;
  const censored = comparisonObservation(14, 9, ["a.example", "c.example"], "AB");
  censored.arms.variant.requestOutcome = "censored";
  const attempts: Attempt[] = [
    attempt(1, comparisonObservation(10, 7, ["a.example", "b.example"], "AB")),
    attempt(2, comparisonObservation(12, 8, ["a.example", "b.example"], "BA")),
    attempt(3, censored)
  ];

  const summary = summarizeRepeatability(attempts);

  assert.equal(summary.eligibleTargets, 1);
  assert.equal(summary.targets[0].eligibleRuns, 2);
  assert.equal(summary.targets[0].excludedRuns, 1);
  assert.deepEqual(summary.targets[0].arms.baseline.metrics.thirdPartyRequests, {
    median: 11,
    min: 10,
    max: 12,
    range: 2,
    relativeRange: 2 / 11
  });
  assert.deepEqual(summary.targets[0].arms.variant.metrics.thirdPartyRequests, {
    median: 7.5,
    min: 7,
    max: 8,
    range: 1,
    relativeRange: 1 / 7.5
  });
  assert.deepEqual(summary.targets[0].interventionOrders, {
    AB: 1,
    BA: 1,
    counterbalanced: true
  });
});

test("a comparison target is excluded when only the baseline arm repeats cleanly", async () => {
  const { summarizeRepeatability } = await helpers;
  const incomplete = comparisonObservation(12, 8, ["a.example"], "BA");
  incomplete.arms.variant.requestOutcome = "censored";
  const summary = summarizeRepeatability([
    attempt(1, comparisonObservation(10, 7, ["a.example"], "AB")),
    attempt(2, incomplete)
  ]);

  assert.equal(summary.eligibleTargets, 0);
  assert.equal(summary.excludedTargets[0].eligibleRuns, 1);
  assert.equal(summary.excludedTargets[0].reasons.includes("variant-requests-incomplete"), true);
  assert.equal(summary.excludedTargets[0].reasons.includes("fewer-than-2-eligible-repetitions"), true);
});

test("producer, runtime, execution, environment, and condition drift exclude A/A pooling", async () => {
  const { summarizeRepeatability } = await helpers;
  const drifted = singleObservation(12, ["a.example"]);
  drifted.arms.run.producerRuntime.runtime.browser.version = "999.0.0.0";
  drifted.arms.run.producerRuntime.fingerprints.execution = "5".repeat(64);
  drifted.arms.run.producerRuntime.fingerprints.measurementEnvironment = "6".repeat(64);
  drifted.arms.run.producerRuntime.fingerprints.condition = "7".repeat(64);

  const summary = summarizeRepeatability([
    attempt(1, singleObservation(10, ["a.example"])),
    attempt(2, drifted)
  ]);

  assert.equal(summary.eligibleTargets, 0);
  const reasons = summary.excludedTargets[0].reasons;
  assert.equal(reasons.includes("run-execution-identity-drift"), true);
  assert.equal(reasons.includes("run-measurementEnvironment-identity-drift"), true);
  assert.equal(reasons.includes("run-condition-identity-drift"), true);
  assert.equal(reasons.includes("run-producer-runtime-identity-drift"), true);
});

test("stably malformed producer provenance never enters the repeatability denominator", async () => {
  const { summarizeRepeatability } = await helpers;
  const first = singleObservation(10, ["a.example"]);
  const second = singleObservation(12, ["a.example"]);
  first.arms.run.producerRuntime.detectorRegistry.digest = "not-a-digest";
  second.arms.run.producerRuntime.detectorRegistry.digest = "not-a-digest";

  const summary = summarizeRepeatability([attempt(1, first), attempt(2, second)]);

  assert.equal(summary.eligibleTargets, 0);
  assert.equal(
    summary.excludedTargets[0].reasons.includes("run-producer-runtime-unbound"),
    true
  );
});

test("the fidelity receipt retains every attempt, provenance, thresholds, and no raw domain inventory", async () => {
  const { buildAttemptLedger } = await helpers;
  const attempts: Attempt[] = [
    attempt(1, singleObservation(10, ["private-to-the-study.example"])),
    {
      url: "https://example.net/",
      shape: "failure",
      repetition: 1,
      outcome: "scan-failure",
      reason: "blocked\u0000\nby target",
      censoredFamilies: [],
      observation: null
    }
  ];

  const ledger = buildAttemptLedger({
    createdAt: "2026-07-28T00:00:00.000Z",
    baseOrigin: "http://127.0.0.1:3000",
    sitesFile: "public/scanner-fidelity-sites.json",
    shardIndex: 0,
    shardCount: 1,
    conditions: { mode: "single" },
    provenance: RECEIPT_PROVENANCE,
    acceptanceThresholds: {
      minimumAnsweringTargets: 1,
      minimumRepeatableTargets: 0
    },
    repetitions: 1,
    selectedTargets: 2,
    attempts
  });

  assert.equal(ledger.receiptVersion, 2);
  assert.equal(ledger.plannedRuns, 2);
  assert.equal(ledger.attemptedRuns, 2);
  assert.equal(ledger.answeredTargets, 1);
  assert.equal(ledger.passedRuns, 1);
  assert.equal(ledger.scanFailedRuns, 1);
  assert.equal(ledger.attempts[1].reason, "blocked by target");
  assert.equal(ledger.acceptance.outcome, "pass");
  assert.deepEqual(ledger.acceptance.reasons, []);
  assert.equal(ledger.acceptance.thresholds.minimumRepeatableTargets, 0);
  assert.equal(ledger.provenance.expectedBuildCommit, BUILD_COMMIT);
  assert.equal(ledger.provenance.driverRuntimeDigest.length, 64);
  assert.equal(ledger.attempts[0].observation.arms.run.producerRuntime.identityDigest.length, 64);
  assert.equal(ledger.receiptDigest.length, 64);
  assert.equal(JSON.stringify(ledger).includes("private-to-the-study.example"), false);
});

test("the fidelity receipt fails explicitly on impossible repeatability and wrong producer provenance", async () => {
  const { buildAttemptLedger } = await helpers;
  const wrongBuild = singleObservation(10, ["a.example"]);
  wrongBuild.arms.run.producerRuntime.buildCommit = "c".repeat(40);
  const ledger = buildAttemptLedger({
    createdAt: "2026-07-28T00:00:00.000Z",
    baseOrigin: "http://127.0.0.1:3000",
    sitesFile: "public/scanner-fidelity-sites.json",
    shardIndex: 0,
    shardCount: 1,
    conditions: { mode: "single" },
    provenance: RECEIPT_PROVENANCE,
    acceptanceThresholds: {
      minimumAnsweringTargets: 1,
      minimumRepeatableTargets: 1
    },
    repetitions: 1,
    selectedTargets: 1,
    attempts: [attempt(1, wrongBuild)]
  });

  assert.equal(ledger.acceptance.outcome, "fail");
  assert.equal(
    ledger.acceptance.reasons.some((reason: string) => reason.includes("requires at least 2 repetitions")),
    true
  );
  assert.equal(
    ledger.acceptance.reasons.some((reason: string) => reason.includes("lacked digest-bound producer/runtime")),
    true
  );
  assert.equal(ledger.provenanceMissingRuns, 1);
});

test("the invariant observer records both comparison arms with their exact identities", async () => {
  const { fidelityObservationOf } = await invariantHelpers;
  const observed = fidelityObservationOf({
    schemaVersion: 2,
    reportType: "comparison",
    baseline: wireRun(10, "baseline.example"),
    variant: wireRun(7, "variant.example"),
    experiment: { kind: "intervention", order: "BA" }
  });

  assert.equal(observed.reportType, "comparison");
  assert.deepEqual(Object.keys(observed.arms).sort(), ["baseline", "variant"]);
  assert.equal(observed.arms.baseline.counts.thirdPartyRequests, 10);
  assert.equal(observed.arms.variant.counts.thirdPartyRequests, 7);
  assert.equal(observed.arms.baseline.producerRuntime.buildCommit, BUILD_COMMIT);
  assert.equal(observed.arms.variant.producerRuntime.fingerprints.execution, "2".repeat(64));
  assert.equal(observed.order, "BA");
});

test("the scheduled fidelity workflow handles one-off manual runs and pins attempted-run provenance", () => {
  const workflow = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "scanner-fidelity.yml"),
    "utf8"
  );
  assert.match(workflow, /shard: \[0, 1\]/);
  assert.match(workflow, /SCANNER_FIDELITY_SHARD_COUNT: "2"/);
  assert.match(workflow, /SCANNER_FIDELITY_MODE: \$\{\{ inputs\.mode \|\| 'single' \}\}/);
  assert.match(workflow, /SCANNER_FIDELITY_DEVICE: \$\{\{ inputs\.device \|\| 'desktop' \}\}/);
  assert.match(workflow, /SCANNER_FIDELITY_REPETITIONS: \$\{\{ inputs\.repetitions \|\| '2' \}\}/);
  assert.match(
    workflow,
    /SCANNER_FIDELITY_MIN_REPEATABLE_TARGETS: \$\{\{ inputs\.repetitions == '1' && '0' \|\| '1' \}\}/
  );
  assert.match(workflow, /SCANNER_FIDELITY_OUTPUT:/);
  const startStep = workflow.slice(
    workflow.indexOf("- name: Start the scanner"),
    workflow.indexOf("- name: Assert scanner invariants against real sites")
  );
  const assertStep = workflow.slice(
    workflow.indexOf("- name: Assert scanner invariants against real sites"),
    workflow.indexOf("- name: Upload the complete attempted-run ledger")
  );
  assert.match(startStep, /SITE_BEHAVIOR_LAB_BUILD_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.match(assertStep, /SITE_BEHAVIOR_LAB_BUILD_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.equal(
    [...workflow.matchAll(/SITE_BEHAVIOR_LAB_BUILD_COMMIT: \$\{\{ github\.sha \}\}/g)].length,
    2
  );
  assert.match(workflow, /kernel\.apparmor_restrict_unprivileged_userns=0/);
  assert.ok(
    workflow.indexOf("kernel.apparmor_restrict_unprivileged_userns=0") <
      workflow.indexOf("npx playwright install --with-deps chromium")
  );
  assert.doesNotMatch(workflow, /--no-sandbox/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
});

function wireRun(thirdPartyRequests: number, domain: string) {
  const identity = producerRuntime();
  return {
    summary: {
      counts: {
        totalRequests: thirdPartyRequests + 10,
        thirdPartyRequests,
        knownTrackerRequests: Math.floor(thirdPartyRequests / 2),
        thirdPartyDomains: 1
      }
    },
    quality: {
      run: { outcome: "complete" },
      byFamily: { requests: { outcome: "complete" } }
    },
    evidence: {
      requests: [{ thirdParty: true, domain }]
    },
    provenance: {
      buildCommit: identity.buildCommit,
      observer: identity.observer,
      methodologyVersion: identity.methodologyVersion,
      detectorRegistry: identity.detectorRegistry
    },
    fingerprints: identity.fingerprints,
    conditions: identity.runtime
  };
}
