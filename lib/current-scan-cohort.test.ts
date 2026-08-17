import assert from "node:assert/strict";
import { test } from "node:test";
import { corpusCohortIdentityForView } from "./corpus-cohort";
import { CORPUS_MIN_SAMPLE, type CorpusStats, type CorpusStatsCohort } from "./corpus-stats";
import {
  currentScanCohortComponents,
  currentScanCohortId,
  currentScanRankingSentence,
  currentScanUsableCohortSampleSize,
  loadCommittedCorpusStats
} from "./current-scan-cohort";
import { DETECTOR_VERSIONS } from "./measurement-kernel";
import type { DetectorLedger } from "./scan-report-v2";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import { toReportView } from "./scan-report-views";
import {
  buildNodeScanReportV2R2,
  type NodeScanReportV2R2Input
} from "./scan-result-v2-r2-builder";

process.env.SITE_BEHAVIOR_LAB_BUILD_COMMIT = "a".repeat(40);

function detectorLedger(): DetectorLedger {
  return {
    "fingerprint-heuristics": { version: DETECTOR_VERSIONS["fingerprint-heuristics"], status: "complete" },
    "keystroke-exfiltration": {
      version: DETECTOR_VERSIONS["keystroke-exfiltration"],
      status: "skipped",
      reason: "probe-disabled"
    },
    "cname-uncloaking": { version: DETECTOR_VERSIONS["cname-uncloaking"], status: "complete" },
    "pixel-events": { version: DETECTOR_VERSIONS["pixel-events"], status: "complete" },
    "consent-banner": { version: DETECTOR_VERSIONS["consent-banner"], status: "complete" },
    "privacy-policy": {
      version: DETECTOR_VERSIONS["privacy-policy"],
      status: "skipped",
      reason: "probe-disabled"
    }
  };
}

/** A minimal valid producer input, driven through the REAL Node r2 builder. */
function producerInput(gpc: boolean): NodeScanReportV2R2Input {
  const host = "shop.example.com";
  return {
    runId: `run-current-scan-cohort-${gpc ? "gpc-on" : "gpc-off"}`,
    startedAt: "2026-08-16T18:00:00.000Z",
    requestedUrl: `https://${host}/`,
    observedUrl: `https://${host}/`,
    conditions: {
      gpc,
      shields: "classification",
      consent: "observe",
      device: { kind: "desktop", viewport: { width: 1440, height: 980, isMobile: false } },
      probes: { keystroke: false, policyVisit: false },
      locale: "en-US",
      language: "en-US",
      timezone: "UTC",
      egress: { label: "production-scanner", region: "us-west" },
      browser: { name: "chromium", version: "136.0.0.0" },
      headless: true,
      automation: "playwright-chromium"
    },
    acquisition: "public-api",
    adblockEngineLoaded: true,
    measurement: {
      phases: [{ phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 1000 }],
      detectors: detectorLedger(),
      qualityFacts: {
        status: 200,
        botWallTitleMatched: false,
        navigationSettled: true,
        budgetsExhausted: [],
        captureLoss: []
      }
    },
    evidence: {
      requests: [
        {
          id: 1,
          url: `https://${host}/`,
          domain: host,
          method: "GET",
          resourceType: "document",
          status: 200,
          thirdParty: false,
          tracker: null,
          blockedByShields: false,
          startedAtMs: 20,
          phaseId: 0
        }
      ],
      cookieMutations: [],
      cookiesFinal: [],
      storageMutations: [],
      storageFinal: [],
      fingerprintEvents: [],
      fingerprintDetections: [],
      cnameCloaks: [],
      pixelEvents: []
    },
    summary: { pageTitle: "Example Shop", durationMs: 1000 },
    warnings: [],
    screenshot: "data:image/png;base64,PRIVATE_SCREENSHOT"
  };
}

test("the current-scan tuple restates exactly what the real Node producer emits", () => {
  // The components are a deliberate restatement of the active producer
  // constants, so they are pinned to a report built by the REAL builder and
  // read through the REAL view pipeline, not to a fixture that would share
  // this module's aliases. If production moves (schema revision, methodology,
  // observer string, catalog digest, taxonomy, metric contract, or how the
  // requested GPC state reaches the cohort key), this fails until the
  // restatement moves with it.
  for (const gpc of [false, true]) {
    const report = buildNodeScanReportV2R2(producerInput(gpc));
    const view = toReportView({
      schemaVersion: 2,
      schemaRevision: 2,
      report: toPublicScanReportR2(report)
    });
    const identity = corpusCohortIdentityForView(view);
    assert.deepEqual(identity, {
      id: currentScanCohortId(gpc),
      ...currentScanCohortComponents(gpc)
    });
  }
  assert.notEqual(currentScanCohortId(false), currentScanCohortId(true));
});

function usableCurrentCohort(gpc: boolean, sampleSize: number): CorpusStatsCohort {
  return {
    ...currentScanCohortComponents(gpc),
    id: currentScanCohortId(gpc),
    sampleSize,
    latestRunAt: null,
    metrics: {}
  };
}

/** The committed artifact with every current-tuple cohort removed. */
function withoutCurrentCohorts(committed: CorpusStats): CorpusStats {
  const currentIds = new Set([currentScanCohortId(false), currentScanCohortId(true)]);
  return {
    ...committed,
    cohorts: (committed.cohorts ?? []).filter((cohort) => !currentIds.has(cohort.id))
  } as CorpusStats;
}

test("the scan-run-today sentence follows the corpus state instead of pinning an epoch", async () => {
  const committed = await loadCommittedCorpusStats();
  assert.ok(committed, "public/corpus-stats.json must exist and parse; this guard is vacuous without it");

  // Branch 1: no usable current-tuple cohort. Derived from the committed
  // artifact by REMOVING the current cohorts, so it exercises the fixed
  // branch regardless of which epoch the live corpus is in.
  const fixed = withoutCurrentCohorts(committed);
  assert.equal(currentScanUsableCohortSampleSize(fixed, false), null);
  assert.equal(currentScanUsableCohortSampleSize(fixed, true), null);
  const fixedSentence = currentScanRankingSentence(fixed, null);
  assert.match(fixedSentence, /ranked against\s+fixed thresholds and not against this number\.$/);
  assert.doesNotMatch(fixedSentence, /-site cohort/);

  // The floor is a real gate: one site short of CORPUS_MIN_SAMPLE stays fixed.
  const underFloor = {
    ...fixed,
    cohorts: [...(fixed.cohorts ?? []), usableCurrentCohort(false, CORPUS_MIN_SAMPLE - 1)]
  } as CorpusStats;
  assert.equal(currentScanUsableCohortSampleSize(underFloor, false), null);
  assert.match(currentScanRankingSentence(underFloor, null), /fixed thresholds and not against this number\.$/);

  // Branch 2: a usable committed cohort for one requested-GPC state. The
  // sample size is deliberately NOT the floor, so the cohort's rendered count
  // cannot be satisfied by the floor number leaking into the sentence.
  const offSample = CORPUS_MIN_SAMPLE + 7;
  const usable = {
    ...fixed,
    cohorts: [...(fixed.cohorts ?? []), usableCurrentCohort(false, offSample)]
  } as CorpusStats;
  assert.equal(currentScanUsableCohortSampleSize(usable, false), offSample);
  assert.equal(currentScanUsableCohortSampleSize(usable, true), null);
  const usableSentence = currentScanRankingSentence(usable, null);
  assert.match(usableSentence, /its ranking follows the same rule/);
  assert.match(
    usableSentence,
    new RegExp(`did not request GPC is ranked against its own committed ${offSample}-site cohort, not against this number`)
  );
  assert.match(usableSentence, /requested GPC is ranked against fixed thresholds/);
  assert.doesNotMatch(usableSentence, /under either requested-GPC state/);

  // Both states usable renders both cohort clauses.
  const bothSample = CORPUS_MIN_SAMPLE + 11;
  const both = {
    ...usable,
    cohorts: [...(usable.cohorts ?? []), usableCurrentCohort(true, bothSample)]
  } as CorpusStats;
  const bothSentence = currentScanRankingSentence(both, null);
  assert.match(bothSentence, new RegExp(`${offSample}-site cohort`));
  assert.match(bothSentence, new RegExp(`${bothSample}-site cohort`));
  assert.doesNotMatch(bothSentence, /fixed thresholds/);

  // When the usable cohort IS the aggregate the paragraph counts, "not against
  // this number" would be false, so that state says the opposite.
  const aggregateMatch = currentScanRankingSentence(usable, currentScanCohortId(false));
  assert.match(aggregateMatch, /did not request GPC is ranked against this same cohort/);
  assert.doesNotMatch(aggregateMatch, /own committed \d+-site cohort/);

  // Live consistency, conditioned on the committed corpus rather than pinning
  // its current epoch: whichever branch the artifact selects, the sentence must
  // be that branch's.
  const liveSentence = currentScanRankingSentence(committed, committed.primaryCohortId ?? null);
  const liveUsable =
    currentScanUsableCohortSampleSize(committed, false) !== null ||
    currentScanUsableCohortSampleSize(committed, true) !== null;
  if (liveUsable) {
    assert.match(liveSentence, /its ranking follows the same rule/);
  } else {
    assert.match(liveSentence, /fixed thresholds and not against this number\.$/);
  }
});
