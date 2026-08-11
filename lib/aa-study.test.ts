import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  evaluateAaStudy: (input: {
    preregistration: unknown;
    targetFrame: unknown;
    targetFrameText: string;
    ledger: unknown;
  }) => AaEvaluation;
  aaPreregistrationIssues: (preregistration: unknown) => string[];
};
type FidelityStudyLib = {
  buildAttemptLedger: (input: unknown) => Record<string, unknown>;
  scannerFidelitySitesOf: (
    value: unknown
  ) => Array<{ url: string; shape: string }>;
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
const MEASUREMENT_IDENTITY_DIGEST = "1".repeat(64);
const STUDY_ID = "aa-2026-08-frozen-frame";
const SITES_FILE = `research/aa-studies/${STUDY_ID}/target-frame.json`;
const TARGET_FRAME = [
  { targetId: "one-example", url: "https://one.example/" },
  { targetId: "two-example", url: "https://two.example/" }
];
const TARGET_FRAME_TEXT = `${JSON.stringify(TARGET_FRAME, null, 2)}\n`;
const FRAME_DIGEST = createHash("sha256")
  .update(TARGET_FRAME_TEXT)
  .digest("hex");
const CONDITIONS = { device: "desktop", gpcEnabled: false, consentMode: "observe" };

function preregistration(overrides: Record<string, unknown> = {}) {
  return {
    kind: "site-behavior-aa-preregistration",
    studyVersion: 2,
    studyId: STUDY_ID,
    declaredAt: "2026-08-01T00:00:00.000Z",
    measurementIdentityManifestPath:
      "research/measurement-candidate/measurement-identity.json",
    measurementIdentityDigest: MEASUREMENT_IDENTITY_DIGEST,
    sitesFile: SITES_FILE,
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

function comparisonAttempt(
  url: string,
  repetition: number,
  order: "AB" | "BA"
) {
  const arm = (thirdPartyRequests: number) => ({
    runOutcome: "complete",
    requestOutcome: "complete",
    counts: {
      ...STABLE_COUNTS,
      thirdPartyRequests
    },
    thirdPartyDomains: [...DOMAINS],
    producerRuntime: producerRuntime()
  });
  return {
    url,
    shape: "aa",
    repetition,
    outcome: "pass",
    censoredFamilies: [],
    observation: {
      schemaVersion: 2,
      reportType: "comparison",
      order,
      arms: {
        baseline: arm(20),
        variant: arm(18)
      }
    }
  };
}

function collectedLedger(
  fidelityStudyLib: FidelityStudyLib,
  input: {
    attempts: Array<Record<string, unknown>>;
    repetitions: number;
    selectedTargets: number;
  }
) {
  return fidelityStudyLib.buildAttemptLedger({
    createdAt: "2026-08-01T06:00:00.000Z",
    collection: {
      startedAt: "2026-08-01T05:00:00.000Z",
      completedAt: "2026-08-01T05:59:00.000Z"
    },
    baseOrigin: "http://127.0.0.1:3000",
    sitesFile: SITES_FILE,
    conditions: CONDITIONS,
    repetitions: input.repetitions,
    selectedTargets: input.selectedTargets,
    shardIndex: 0,
    shardCount: 1,
    attempts: input.attempts,
    acceptanceThresholds: { minimumAnsweringTargets: 1, minimumRepeatableTargets: 1 },
    provenance: {
      expectedBuildCommit: BUILD,
      measurementIdentityDigest: MEASUREMENT_IDENTITY_DIGEST,
      sitesFileDigest: FRAME_DIGEST,
      driverRuntime: { nodeVersion: "v24.14.1", platform: "linux", architecture: "x64" }
    }
  });
}

const DOMAINS = ["a.example", "b.example", "c.example"];
const STABLE_COUNTS = {
  totalRequests: 40,
  thirdPartyRequests: 20,
  knownTrackerRequests: 5,
  // Derived, not a literal. This said 8 while DOMAINS listed 3, and nothing
  // noticed: the ledger states this quantity twice and no check compared them,
  // so a fixture that contradicted itself exercised the study happily.
  thirdPartyDomains: DOMAINS.length
};

function stableAttempts() {
  const attempts = [];
  for (const url of ["https://one.example/", "https://two.example/"]) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      attempts.push(attempt(url, repetition, { ...STABLE_COUNTS }, [...DOMAINS]));
    }
  }
  return attempts;
}

function evaluateAa(
  aaStudyLib: AaStudyLib,
  input: { preregistration: unknown; ledger: unknown },
  targetFrame: unknown = TARGET_FRAME,
  targetFrameText: string = TARGET_FRAME_TEXT
) {
  return aaStudyLib.evaluateAaStudy({
    ...input,
    targetFrame,
    targetFrameText
  });
}

test("a stable preregistered study passes and digests both sides", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const evaluation = evaluateAa(aaStudyLib, {
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

test("release-grade comparison counterbalancing requires exactly equal non-zero AB and BA counts", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const thresholds = {
    ...preregistration().thresholds,
    requireCounterbalancedOrders: true
  };
  const balancedAttempts = TARGET_FRAME.flatMap(({ url }) =>
    [1, 2, 3, 4].map((repetition) =>
      comparisonAttempt(url, repetition, repetition % 2 === 1 ? "AB" : "BA")
    )
  );
  const balanced = evaluateAa(aaStudyLib, {
    preregistration: preregistration({
      repetitionsPerTarget: 4,
      thresholds
    }),
    ledger: collectedLedger(fidelityStudyLib, {
      attempts: balancedAttempts,
      repetitions: 4,
      selectedTargets: 2
    })
  });
  assert.equal(balanced.status, "pass", JSON.stringify(balanced));

  const imbalancedAttempts = structuredClone(balancedAttempts);
  imbalancedAttempts[1].observation.order = "AB";
  const imbalanced = evaluateAa(aaStudyLib, {
    preregistration: preregistration({
      repetitionsPerTarget: 4,
      thresholds
    }),
    ledger: collectedLedger(fidelityStudyLib, {
      attempts: imbalancedAttempts,
      repetitions: 4,
      selectedTargets: 2
    })
  });
  assert.equal(imbalanced.status, "fail");
  assert.match(
    imbalanced.failingTargets?.[0]?.failures.join("; ") ?? "",
    /equal non-zero AB and BA/
  );
});

test("a raw readiness-compatible target frame reaches the ledger and evaluator without byte rewriting", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const frameBytes = Buffer.from(
    `${JSON.stringify(
      [
        { targetId: "one-example", url: "https://one.example/" },
        { targetId: "two-example", url: "https://two.example/" }
      ],
      null,
      2
    )}\n`
  );
  const frameDigest = createHash("sha256").update(frameBytes).digest("hex");
  const sites = fidelityStudyLib.scannerFidelitySitesOf(
    JSON.parse(frameBytes.toString("utf8"))
  );
  assert.deepEqual(sites, [
    { url: "https://one.example/", shape: "aa" },
    { url: "https://two.example/", shape: "aa" }
  ]);

  const attempts = sites.flatMap((site) =>
    [1, 2, 3].map((repetition) =>
      attempt(
        site.url,
        repetition,
        { ...STABLE_COUNTS },
        [...DOMAINS]
      )
    )
  );
  const ledger = fidelityStudyLib.buildAttemptLedger({
    createdAt: "2026-08-01T06:00:00.000Z",
    collection: {
      startedAt: "2026-08-01T05:00:00.000Z",
      completedAt: "2026-08-01T05:59:00.000Z"
    },
    baseOrigin: "http://127.0.0.1:3000",
    sitesFile: SITES_FILE,
    conditions: CONDITIONS,
    repetitions: 3,
    selectedTargets: sites.length,
    shardIndex: 0,
    shardCount: 1,
    attempts,
    acceptanceThresholds: {
      minimumAnsweringTargets: 1,
      minimumRepeatableTargets: 1
    },
    provenance: {
      expectedBuildCommit: BUILD,
      measurementIdentityDigest: MEASUREMENT_IDENTITY_DIGEST,
      sitesFileDigest: frameDigest,
      driverRuntime: {
        nodeVersion: "v24.14.1",
        platform: "linux",
        architecture: "x64"
      }
    }
  });
  assert.equal(
    (ledger.provenance as Record<string, unknown>).sitesFileDigest,
    frameDigest
  );
  const evaluation = evaluateAa(
    aaStudyLib,
    {
    preregistration: preregistration({ sitesFileDigest: frameDigest }),
    ledger
    },
    JSON.parse(frameBytes.toString("utf8")),
    frameBytes.toString("utf8")
  );
  assert.equal(evaluation.status, "pass", JSON.stringify(evaluation));
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
  const evaluation = evaluateAa(aaStudyLib, {
    preregistration: preregistration(),
    ledger: collectedLedger(fidelityStudyLib, { attempts, repetitions: 3, selectedTargets: 2 })
  });
  assert.equal(evaluation.status, "fail");
  assert.equal(evaluation.failingTargets?.length, 1);
  assert.match(evaluation.failingTargets?.[0]?.failures[0] ?? "", /thirdPartyRequests/);
});

test("a ledger from a different measurement identity or frame is an identity violation, never a threshold failure", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const ledger = collectedLedger(fidelityStudyLib, {
    attempts: stableAttempts(),
    repetitions: 3,
    selectedTargets: 2
  });
  const wrongIdentity = evaluateAa(aaStudyLib, {
    preregistration: preregistration({ measurementIdentityDigest: "9".repeat(64) }),
    ledger
  });
  assert.equal(wrongIdentity.status, "identity-violation");
  const wrongFrame = evaluateAa(aaStudyLib, {
    preregistration: preregistration({ sitesFileDigest: "9".repeat(64) }),
    ledger
  });
  assert.equal(wrongFrame.status, "identity-violation");
});

test("v2 preregistration is exact, canonical, and has no build-SHA coupling", async () => {
  const { aaStudyLib } = await loadModules();
  assert.deepEqual(aaStudyLib.aaPreregistrationIssues(preregistration()), []);
  assert.equal(
    aaStudyLib.aaPreregistrationIssues({
      ...preregistration(),
      buildCommit: BUILD
    }).some((issue) => /contain exactly/.test(issue)),
    true
  );
  assert.equal(
    aaStudyLib.aaPreregistrationIssues({
      ...preregistration(),
      studyVersion: 1
    }).some((issue) => /studyVersion must be 2/.test(issue)),
    true
  );
  assert.equal(
    aaStudyLib.aaPreregistrationIssues({
      ...preregistration(),
      declaredAt: "2026-08-01T00:00:00Z"
    }).some((issue) => /canonical UTC/.test(issue)),
    true
  );
});

test("ledger receipt and provenance digest tampering is invalid, not scoreable", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const ledger = collectedLedger(fidelityStudyLib, {
    attempts: stableAttempts(),
    repetitions: 3,
    selectedTargets: 2
  });
  (ledger.provenance as Record<string, unknown>).unexpected = true;
  const extraProvenance = evaluateAa(aaStudyLib, {
    preregistration: preregistration(),
    ledger
  });
  assert.equal(extraProvenance.status, "invalid");
  assert.equal(
    extraProvenance.issues.some((issue) => /provenance.*exactly/.test(issue)),
    true
  );

  delete (ledger.provenance as Record<string, unknown>).unexpected;
  ledger.receiptDigest = "0".repeat(64);
  const badDigest = evaluateAa(aaStudyLib, {
    preregistration: preregistration(),
    ledger
  });
  assert.equal(badDigest.status, "invalid");
  assert.equal(badDigest.issues.some((issue) => /receiptDigest/.test(issue)), true);
});

test("missing or malformed preregistration fields are invalid before any scoring", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const noThresholds = preregistration();
  delete (noThresholds as Record<string, unknown>).thresholds;
  const evaluation = evaluateAa(aaStudyLib, {
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

test("a preregistration declared after collection began is an identity violation", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const evaluation = evaluateAa(aaStudyLib, {
    // Collection starts at 05:00; declaring at 08:00 the same day is
    // curve-fitting, not preregistration.
    preregistration: preregistration({ declaredAt: "2026-08-01T08:00:00.000Z" }),
    ledger: collectedLedger(fidelityStudyLib, {
      attempts: stableAttempts(),
      repetitions: 3,
      selectedTargets: 2
    })
  });
  assert.equal(evaluation.status, "identity-violation");
  assert.equal(
    evaluation.checks.find((check) => check.id === "preregistration-precedes-collection")?.ok,
    false
  );
});

test("every attempt must be preserved: a trimmed denominator refuses to score", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const evaluation = evaluateAa(aaStudyLib, {
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

test("a duplicate pair cannot replace a missing preregistered target repetition", async () => {
  const { aaStudyLib, fidelityStudyLib } = await loadModules();
  const attempts = stableAttempts();
  attempts[attempts.length - 1] = attempt(
    "https://one.example/",
    1,
    { ...STABLE_COUNTS },
    [...DOMAINS]
  );
  const evaluation = evaluateAa(aaStudyLib, {
    preregistration: preregistration({
      thresholds: {
        ...preregistration().thresholds,
        minimumEligibleTargets: 1
      }
    }),
    ledger: collectedLedger(fidelityStudyLib, {
      attempts,
      repetitions: 3,
      selectedTargets: 2
    })
  });
  assert.equal(evaluation.status, "identity-violation");
  assert.equal(
    evaluation.checks.find(
      (check) => check.id === "target-frame-attempt-set"
    )?.ok,
    false
  );
  assert.match(evaluation.issues.join("; "), /duplicates|not set-equal/);
});
