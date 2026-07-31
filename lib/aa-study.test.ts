import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// The evaluator lives beside summarizeRepeatability in scripts/ so the two
// halves of the A/A contract share one implementation (import precedent:
// brave-list-fetch.test.ts). Loaded inside the tests because the compiled
// test output is CJS, where top-level await is unavailable.
type AaEvaluation = {
  status: string;
  issues: string[];
  checks: { id: string; ok: boolean; detail: string }[];
  eligibleTargets?: number;
  failingTargets?: { url: string; failures: string[] }[];
  preregistrationDigest?: string;
  evaluationDigest?: string;
  inference?: { scope: string };
};
type AaStudyLib = {
  evaluateAaStudy: (input: { preregistration: unknown; ledger: unknown }) => AaEvaluation;
  aaPreregistrationIssues: (preregistration: unknown) => string[];
};
type FidelityStudyLib = {
  buildAttemptLedger: (input: unknown) => Record<string, unknown>;
};

// A literal `import()` would be downleveled to require() in the CommonJS test
// build, which cannot load file:// URLs; the Function wrapper keeps it native
// (same technique as brave-list-fetch.test.ts).
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<unknown>;

let modules: Promise<{ aaStudyLib: AaStudyLib; fidelityStudyLib: FidelityStudyLib }> | undefined;
function loadModules() {
  modules ??= (async () => ({
    aaStudyLib: (await nativeImport(
      pathToFileURL(path.join(process.cwd(), "scripts", "aa-study-lib.mjs")).href
    )) as AaStudyLib,
    fidelityStudyLib: (await nativeImport(
      pathToFileURL(path.join(process.cwd(), "scripts", "scanner-fidelity-study-lib.mjs")).href
    )) as FidelityStudyLib
  }))();
  return modules;
}

const BUILD = "a".repeat(40);
const FRAME_DIGEST = "b".repeat(64);
const CONDITIONS = { device: "desktop", gpcEnabled: false, consentMode: "observe" };

function preregistration(overrides: Record<string, unknown> = {}) {
  return {
    kind: "site-behavior-aa-preregistration",
    studyVersion: 1,
    studyId: "aa-2026-08-frozen-frame",
    declaredAt: "2026-08-01T00:00:00.000Z",
    buildCommit: BUILD,
    sitesFileDigest: FRAME_DIGEST,
    targetCount: 2,
    repetitionsPerTarget: 3,
    conditions: CONDITIONS,
    thresholds: {
      minimumEligibleTargets: 2,
      maximumFailingTargetFraction: 0,
      maximumMetricRelativeRange: {
        totalRequests: 0.25,
        thirdPartyRequests: 0.25,
        knownTrackerRequests: 0.5,
        thirdPartyDomains: 0.25
      },
      minimumThirdPartyDomainJaccard: 0.7,
      requireCounterbalancedOrders: false
    },
    ...overrides
  };
}

function producerRuntime() {
  return {
    buildCommit: BUILD,
    observer: "node-playwright",
    methodologyVersion: "methodology-x",
    detectorRegistry: { version: "registry-x", digest: "c".repeat(64) },
    fingerprints: {
      execution: "d".repeat(64),
      measurementEnvironment: "e".repeat(64),
      condition: "f".repeat(64)
    },
    runtime: {
      automation: "playwright-chromium",
      browser: { name: "chromium", version: "140.0.0.0" },
      device: { viewport: "1280x800" },
      locale: "en-US",
      language: "en",
      timezone: "UTC",
      egress: { label: "github-actions-ubuntu" },
      headless: true
    }
  };
}

function attempt(url: string, repetition: number, counts: Record<string, number>, domains: string[]) {
  return {
    url,
    shape: "aa",
    repetition,
    outcome: "pass",
    censoredFamilies: [],
    observation: {
      schemaVersion: 2,
      reportType: "single",
      order: null,
      arms: {
        run: {
          runOutcome: "complete",
          requestOutcome: "complete",
          counts,
          thirdPartyDomains: domains,
          producerRuntime: producerRuntime()
        }
      }
    }
  };
}

function collectedLedger(
  fidelityStudyLib: FidelityStudyLib,
  input: { attempts: ReturnType<typeof attempt>[]; repetitions: number; selectedTargets: number }
) {
  return fidelityStudyLib.buildAttemptLedger({
    createdAt: "2026-08-01T06:00:00.000Z",
    baseOrigin: "http://127.0.0.1:3000",
    sitesFile: "public/scanner-fidelity-sites.json",
    conditions: CONDITIONS,
    repetitions: input.repetitions,
    selectedTargets: input.selectedTargets,
    shardIndex: 0,
    shardCount: 1,
    attempts: input.attempts,
    acceptanceThresholds: { minimumAnsweringTargets: 1, minimumRepeatableTargets: 1 },
    provenance: {
      expectedBuildCommit: BUILD,
      sitesFileDigest: FRAME_DIGEST,
      driverRuntime: { nodeVersion: "v24.14.1", platform: "linux", architecture: "x64" }
    }
  });
}

const STABLE_COUNTS = {
  totalRequests: 40,
  thirdPartyRequests: 20,
  knownTrackerRequests: 5,
  thirdPartyDomains: 8
};
const DOMAINS = ["a.example", "b.example", "c.example"];

function stableAttempts() {
  const attempts = [];
  for (const url of ["https://one.example/", "https://two.example/"]) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      attempts.push(attempt(url, repetition, { ...STABLE_COUNTS }, [...DOMAINS]));
    }
  }
  return attempts;
}

test("a stable preregistered study passes and digests both sides", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const evaluation = aaStudyLib.evaluateAaStudy({
    preregistration: preregistration(),
    ledger: collectedLedger(fidelityStudyLib, {
      attempts: stableAttempts(),
      repetitions: 3,
      selectedTargets: 2
    })
  });
  assert.equal(evaluation.status, "pass", JSON.stringify(evaluation.checks));
  assert.equal(evaluation.eligibleTargets, 2);
  assert.deepEqual(evaluation.failingTargets, []);
  assert.match(evaluation.preregistrationDigest ?? "", /^[0-9a-f]{64}$/);
  assert.match(evaluation.evaluationDigest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(evaluation.inference?.scope, "recorded-attempts-only");
});

test("a threshold breach fails the study but preserves the evaluation", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const attempts = stableAttempts();
  // One noisy repetition on target one: relative range on thirdPartyRequests
  // becomes (30-20)/20 = 0.5 > 0.25.
  attempts[2] = attempt(
    "https://one.example/",
    3,
    { ...STABLE_COUNTS, thirdPartyRequests: 30 },
    [...DOMAINS]
  );
  const evaluation = aaStudyLib.evaluateAaStudy({
    preregistration: preregistration(),
    ledger: collectedLedger(fidelityStudyLib, { attempts, repetitions: 3, selectedTargets: 2 })
  });
  assert.equal(evaluation.status, "fail");
  assert.equal(evaluation.failingTargets?.length, 1);
  assert.match(evaluation.failingTargets?.[0]?.failures[0] ?? "", /thirdPartyRequests/);
});

test("a ledger from a different build or frame is an identity violation, never a threshold failure", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const ledger = collectedLedger(fidelityStudyLib, {
    attempts: stableAttempts(),
    repetitions: 3,
    selectedTargets: 2
  });
  const wrongBuild = aaStudyLib.evaluateAaStudy({
    preregistration: preregistration({ buildCommit: "9".repeat(40) }),
    ledger
  });
  assert.equal(wrongBuild.status, "identity-violation");
  const wrongFrame = aaStudyLib.evaluateAaStudy({
    preregistration: preregistration({ sitesFileDigest: "9".repeat(64) }),
    ledger
  });
  assert.equal(wrongFrame.status, "identity-violation");
});

test("missing or malformed preregistration fields are invalid before any scoring", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const noThresholds = preregistration();
  delete (noThresholds as Record<string, unknown>).thresholds;
  const evaluation = aaStudyLib.evaluateAaStudy({
    preregistration: noThresholds,
    ledger: collectedLedger(fidelityStudyLib, {
      attempts: stableAttempts(),
      repetitions: 3,
      selectedTargets: 2
    })
  });
  assert.equal(evaluation.status, "invalid");
  assert.equal(evaluation.issues.length > 0, true);

  const singleRepetition = aaStudyLib.aaPreregistrationIssues(
    preregistration({ repetitionsPerTarget: 1 })
  );
  assert.equal(singleRepetition.some((issue) => /at least 2/.test(issue)), true);
});

test("every attempt must be preserved: a trimmed denominator refuses to score", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const evaluation = aaStudyLib.evaluateAaStudy({
    preregistration: preregistration(),
    ledger: collectedLedger(fidelityStudyLib, {
      attempts: stableAttempts().slice(0, 5),
      repetitions: 3,
      selectedTargets: 2
    })
  });
  assert.equal(evaluation.status, "identity-violation");
  assert.equal(
    evaluation.checks.find((check) => check.id === "attempt-denominator")?.ok,
    false
  );
});
