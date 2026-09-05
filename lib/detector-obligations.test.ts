import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DETECTOR_OBLIGATION_CONTRACT_VERSION,
  DETECTOR_OBLIGATION_REGISTRY,
  DETECTOR_OBLIGATION_TARGET_REGISTRIES,
  DETECTOR_OBLIGATION_TARGET_REGISTRY,
  HISTORICAL_DETECTOR_OBLIGATION_TARGET_REGISTRY,
  HISTORICAL_SERVICE_ROLE_DETECTOR_OBLIGATION_TARGET_REGISTRY,
  HISTORICAL_WRAPPED_VISIT_DETECTOR_OBLIGATION_TARGET_REGISTRY,
  detectorObligationViolations,
  type DetectorObligationRule
} from "./detector-obligations";
import { DETECTOR_REASON_CODES } from "./detector-status-contract";
import {
  DETECTOR_REGISTRY_DIGEST,
  DETECTOR_REGISTRY_VERSION
} from "./measurement-kernel";
import {
  DETECTOR_IDS,
  type CaptureLossEntry,
  type DetectorStatus,
  type ScanRunV2
} from "./scan-report-v2";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";
import {
  makePublicSingleReportV2R2,
  makeScanRunV2R2
} from "./scan-report-v2-r2-fixtures";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import { evaluateQuality, BUDGET_FAMILIES } from "./scan-report-v2-evaluators";

const EPOCH = {
  detectorRegistryVersion: DETECTOR_REGISTRY_VERSION,
  detectorRegistryDigest: DETECTOR_REGISTRY_DIGEST
} as const;

test("the obligation contract keeps every accountability registry epoch active", () => {
  assert.deepEqual(DETECTOR_OBLIGATION_TARGET_REGISTRIES, [
    {
      detectorRegistryVersion: "node-detectors-v3",
      detectorRegistryDigest: "ad2971a6c3eff3a0ba537529ba91cb28686a5101bf2f2c290e47c176cd23c38b"
    },
    {
      detectorRegistryVersion: "node-detectors-v4",
      detectorRegistryDigest: "100de91713270067dff4f5ecebeea61d330982c7a5aa33395bae3dd604adedd2"
    },
    {
      detectorRegistryVersion: "node-detectors-v5",
      detectorRegistryDigest: "65547960bf03ca7d6d7b8279aa8b5ffed3a995bed2f36a64535d4179743ce204"
    },
    {
      detectorRegistryVersion: "node-detectors-v7",
      detectorRegistryDigest: "e019df75386c8f89584f5d14b4b191fa00f76a4ddb88f79a5875e7d07c72c89b"
    }
  ]);
  assert.equal(
    DETECTOR_OBLIGATION_TARGET_REGISTRIES[0],
    HISTORICAL_DETECTOR_OBLIGATION_TARGET_REGISTRY
  );
  assert.equal(
    DETECTOR_OBLIGATION_TARGET_REGISTRIES[1],
    HISTORICAL_SERVICE_ROLE_DETECTOR_OBLIGATION_TARGET_REGISTRY
  );
  assert.equal(
    DETECTOR_OBLIGATION_TARGET_REGISTRIES[2],
    HISTORICAL_WRAPPED_VISIT_DETECTOR_OBLIGATION_TARGET_REGISTRY
  );
  assert.equal(DETECTOR_OBLIGATION_TARGET_REGISTRIES[3], DETECTOR_OBLIGATION_TARGET_REGISTRY);
  assert.equal(Object.isFrozen(DETECTOR_OBLIGATION_TARGET_REGISTRIES), true);
});

function configureRule(rule: DetectorObligationRule): ScanRunV2 {
  const run = makeScanRunV2R2();
  if (rule.detector === "keystroke-exfiltration") {
    run.conditions.probes.keystroke = rule.silent === "probe-off" ? false : true;
  }
  if (rule.detector === "privacy-policy") {
    run.conditions.probes.policyVisit = rule.silent === "probe-off" ? false : true;
  }
  run.detectors[rule.detector] = {
    version: run.detectors[rule.detector].version,
    status: rule.status,
    reason: rule.reason,
    ...(!rule.silent || rule.loss ? { phaseId: 0 } : {})
  };
  if (rule.silent === "failed-page") {
    run.qualityFacts.status = 403;
    delete run.detectors[rule.detector].phaseId;
  } else if (rule.loss) {
    run.qualityFacts.captureLoss.push({
      family: rule.loss.family,
      phaseId: run.detectors[rule.detector].phaseId ?? null,
      kind: rule.loss.kinds[0],
      count: 1,
      detail: rule.loss.detail
    });
  }
  return run;
}

function cnameCapRun(loss?: Partial<CaptureLossEntry>): ScanRunV2 {
  const run = makeScanRunV2R2();
  run.detectors["cname-uncloaking"] = {
    version: run.detectors["cname-uncloaking"].version,
    status: "partial",
    reason: "evidence-cap-reached",
    phaseId: 0
  };
  if (loss) {
    run.qualityFacts.captureLoss.push({
      family: loss.family ?? "detector-output",
      phaseId: loss.phaseId === undefined ? 0 : loss.phaseId,
      kind: loss.kind ?? "cap",
      count: loss.count ?? 1,
      detail: loss.detail ?? "cname-lookups"
    });
  }
  return run;
}

test("the immutable obligation registry accepts every registered causal row", () => {
  assert.equal(DETECTOR_OBLIGATION_CONTRACT_VERSION, "detector-obligations-v1");
  assert.equal(Object.isFrozen(DETECTOR_OBLIGATION_REGISTRY), true);
  for (const rule of DETECTOR_OBLIGATION_REGISTRY) {
    if (rule.loss) {
      assert.ok(
        rule.loss.phaseRule === "detector-phase" ||
          rule.loss.phaseRule === "captured-request-phase" ||
          rule.loss.phaseRule === "fingerprint-coverage-phase",
        `${rule.detector}/${rule.status}/${rule.reason} must declare its phase rule`
      );
    }
    assert.deepEqual(
      detectorObligationViolations(configureRule(rule), "run", EPOCH),
      [],
      `${rule.detector}/${rule.status}/${rule.reason}`
    );
  }
});

test("every detector status/reason row is either registered or rejected", () => {
  const statuses: readonly Exclude<DetectorStatus, "complete">[] = [
    "partial",
    "skipped",
    "unsupported",
    "failed"
  ];
  const registered = new Set(
    DETECTOR_OBLIGATION_REGISTRY.map(
      (rule) => `${rule.detector}/${rule.status}/${rule.reason}`
    )
  );
  for (const detector of DETECTOR_IDS) {
    for (const status of statuses) {
      for (const reason of DETECTOR_REASON_CODES) {
        const key = `${detector}/${status}/${reason}`;
        const rule = DETECTOR_OBLIGATION_REGISTRY.find(
          (candidate) =>
            candidate.detector === detector &&
            candidate.status === status &&
            candidate.reason === reason
        );
        const run = rule
          ? configureRule(rule)
          : (() => {
              const value = makeScanRunV2R2();
              value.detectors[detector] = {
                version: value.detectors[detector].version,
                status,
                reason,
                phaseId: 0
              };
              return value;
            })();
        assert.equal(
          detectorObligationViolations(run, "run", EPOCH).length === 0,
          registered.has(key),
          key
        );
      }
    }
  }
});

test("causal satisfaction is exact by detector, family, detail, kind, and phase", () => {
  const mutants: Array<[string, Partial<CaptureLossEntry> | undefined]> = [
    ["missing", undefined],
    ["wrong family", { family: "requests" }],
    ["wrong detail", { detail: "pixel-decode" }],
    ["wrong kind", { kind: "dropped" }],
    ["wrong phase", { phaseId: null }],
    ["unrelated sibling", { detail: "policy-visit" }]
  ];
  for (const [label, loss] of mutants) {
    assert.match(
      detectorObligationViolations(cnameCapRun(loss), "run", EPOCH).join("\n"),
      /cname-uncloaking lacks causal detector-output\/cname-lookups loss/,
      label
    );
  }

  const wrongDetector = makeScanRunV2R2();
  wrongDetector.detectors["pixel-events"] = {
    version: wrongDetector.detectors["pixel-events"].version,
    status: "partial",
    reason: "evidence-cap-reached",
    phaseId: 0
  };
  wrongDetector.qualityFacts.captureLoss.push({
    family: "detector-output",
    phaseId: 0,
    kind: "cap",
    count: 1,
    detail: "cname-lookups"
  });
  assert.match(
    detectorObligationViolations(wrongDetector, "run", EPOCH).join("\n"),
    /pixel-events lacks causal detector-output\/pixel-decode loss/
  );
});

test("pixel decode loss follows its captured request phase, not the detector snapshot phase", () => {
  const run = makeScanRunV2R2();
  run.phases.push({
    phaseId: 1,
    kind: "active-probe",
    startedAtMs: 5_000,
    endedAtMs: 5_100
  });
  run.detectors["pixel-events"] = {
    version: run.detectors["pixel-events"].version,
    status: "partial",
    reason: "evidence-cap-reached",
    phaseId: 1
  };
  run.qualityFacts.captureLoss.push({
    family: "detector-output",
    phaseId: 0,
    kind: "truncated",
    count: 1,
    detail: "pixel-decode"
  });
  assert.deepEqual(detectorObligationViolations(run, "pixel", EPOCH), []);
});

test("pixel decode loss rejects null, policy-analysis, and uncaptured phases", () => {
  for (const [label, phaseId, phaseKind] of [
    ["null", null, null],
    ["policy", 1, "policy-analysis"],
    ["uncaptured", 1, "active-probe"]
  ] as const) {
    const run = makeScanRunV2R2();
    if (phaseKind !== null) {
      run.phases.push({
        phaseId: 1,
        kind: phaseKind,
        startedAtMs: 5_000,
        endedAtMs: 5_100
      });
    }
    if (label === "policy") {
      run.evidence.requests[0] = {
        ...run.evidence.requests[0],
        phaseId: 1
      };
    }
    run.detectors["pixel-events"] = {
      version: run.detectors["pixel-events"].version,
      status: "partial",
      reason: "evidence-cap-reached",
      phaseId: 0
    };
    run.qualityFacts.captureLoss.push({
      family: "detector-output",
      phaseId,
      kind: "truncated",
      count: 1,
      detail: "pixel-decode"
    });
    assert.match(
      detectorObligationViolations(run, label, EPOCH).join("\n"),
      /pixel-events lacks causal detector-output\/pixel-decode loss/,
      label
    );
  }
});

test("fingerprint coverage may cite the completed passive boundary before a consent snapshot", () => {
  const run = makeScanRunV2R2();
  run.phases = [
    {
      phaseId: 0,
      kind: "passive-load",
      startedAtMs: 0,
      endedAtMs: 2_000
    },
    {
      phaseId: 1,
      kind: "consent-interaction",
      startedAtMs: 2_000,
      endedAtMs: 3_000
    }
  ];
  run.detectors["fingerprint-heuristics"] = {
    version: run.detectors["fingerprint-heuristics"].version,
    status: "partial",
    reason: "scan-failed",
    phaseId: 1
  };
  run.qualityFacts.captureLoss.push({
    family: "fingerprinting",
    phaseId: 0,
    kind: "dropped",
    count: 1,
    detail: "fingerprint-observer"
  });
  assert.deepEqual(detectorObligationViolations(run, "fingerprint", EPOCH), []);
});

test("fingerprint coverage rejects null, post-probe, policy, and overlapping prior phases", () => {
  const cases = [
    {
      label: "null",
      phases: [
        { phaseId: 0, kind: "passive-load" as const, startedAtMs: 0, endedAtMs: 2_000 },
        { phaseId: 1, kind: "consent-interaction" as const, startedAtMs: 2_000, endedAtMs: 3_000 }
      ],
      detectorPhaseId: 1,
      lossPhaseId: null
    },
    {
      label: "active-probe",
      phases: [
        { phaseId: 0, kind: "passive-load" as const, startedAtMs: 0, endedAtMs: 2_000 },
        { phaseId: 1, kind: "consent-interaction" as const, startedAtMs: 2_000, endedAtMs: 3_000 },
        { phaseId: 2, kind: "active-probe" as const, startedAtMs: 3_000, endedAtMs: 4_000 }
      ],
      detectorPhaseId: 1,
      lossPhaseId: 2
    },
    {
      label: "policy-analysis",
      phases: [
        { phaseId: 0, kind: "passive-load" as const, startedAtMs: 0, endedAtMs: 2_000 },
        { phaseId: 1, kind: "consent-interaction" as const, startedAtMs: 2_000, endedAtMs: 3_000 },
        { phaseId: 2, kind: "policy-analysis" as const, startedAtMs: 3_000, endedAtMs: 4_000 }
      ],
      detectorPhaseId: 1,
      lossPhaseId: 2
    },
    {
      label: "overlapping-passive",
      phases: [
        { phaseId: 0, kind: "passive-load" as const, startedAtMs: 0, endedAtMs: 2_500 },
        { phaseId: 1, kind: "consent-interaction" as const, startedAtMs: 2_000, endedAtMs: 3_000 }
      ],
      detectorPhaseId: 1,
      lossPhaseId: 0
    },
    {
      label: "active-detector",
      phases: [
        { phaseId: 0, kind: "passive-load" as const, startedAtMs: 0, endedAtMs: 2_000 },
        { phaseId: 1, kind: "active-probe" as const, startedAtMs: 2_000, endedAtMs: 3_000 }
      ],
      detectorPhaseId: 1,
      lossPhaseId: 1
    }
  ];

  for (const fixture of cases) {
    const run = makeScanRunV2R2();
    run.phases = fixture.phases;
    run.detectors["fingerprint-heuristics"] = {
      version: run.detectors["fingerprint-heuristics"].version,
      status: "partial",
      reason: "scan-failed",
      phaseId: fixture.detectorPhaseId
    };
    run.qualityFacts.captureLoss.push({
      family: "fingerprinting",
      phaseId: fixture.lossPhaseId,
      kind: "dropped",
      count: 1,
      detail: "fingerprint-observer"
    });
    assert.match(
      detectorObligationViolations(run, fixture.label, EPOCH).join("\n"),
      /fingerprint-heuristics lacks causal fingerprinting\/fingerprint-observer loss/,
      fixture.label
    );
  }
});

test("no public projection marker can satisfy a detector's causal obligation", () => {
  const publicMarkers = Object.keys(BUDGET_FAMILIES).filter((detail) =>
    detail.startsWith("public-")
  );
  assert.ok(publicMarkers.length > 0);
  for (const detail of publicMarkers) {
    const family = BUDGET_FAMILIES[detail];
    const violations = detectorObligationViolations(
      cnameCapRun({ family, detail }),
      "run",
      EPOCH
    );
    assert.equal(violations.length, 1, detail);
  }
});

test("privacy silent paths are narrow, including the Zillow-style error interstitial", () => {
  const zillow = makeScanRunV2R2();
  zillow.conditions.probes.policyVisit = true;
  zillow.qualityFacts.status = 403;
  zillow.qualityFacts.botWallTitleMatched = true;
  zillow.detectors["privacy-policy"] = {
    version: zillow.detectors["privacy-policy"].version,
    status: "skipped",
    reason: "load-failed"
  };
  assert.deepEqual(detectorObligationViolations(zillow, "zillow", EPOCH), []);
  assert.equal(
    zillow.qualityFacts.captureLoss.some(
      (loss) => loss.detail === "policy-visit" || loss.detail === "policy-link-candidates"
    ),
    false
  );

  const unverified = makeScanRunV2R2();
  unverified.conditions.probes.policyVisit = true;
  unverified.detectors["privacy-policy"] = {
    version: unverified.detectors["privacy-policy"].version,
    status: "skipped",
    reason: "load-failed"
  };
  assert.match(
    detectorObligationViolations(unverified, "unverified", EPOCH).join("\n"),
    /privacy-policy lacks causal detector-output\/policy-visit/
  );
  unverified.qualityFacts.captureLoss.push({
    family: "detector-output",
    phaseId: null,
    kind: "dropped",
    count: 1,
    detail: "policy-visit"
  });
  assert.deepEqual(detectorObligationViolations(unverified, "unverified", EPOCH), []);
});

test("pre-accountability registry identities do not inherit an obligation epoch", () => {
  const historical = cnameCapRun();
  historical.provenance.detectorRegistry = {
    version: "node-detectors-v2",
    digest: "1".repeat(64)
  };
  assert.deepEqual(detectorObligationViolations(historical, "historical", EPOCH), []);
});

test("the shared r2 semantic reader still rejects missing obligations in historical v3 reports", () => {
  const report = makePublicSingleReportV2R2();
  report.run.provenance.methodologyVersion =
    "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.0+subject-validity-v2+detector-coverage-v2+phase-kernel-v2+boundary-state-v1+consent-r2-v4+resource-budget-v1+proxy-traffic-v1+service-worker-block-v1+detector-accountability-v1";
  report.run.provenance.detectorRegistry = {
    version: "node-detectors-v3",
    digest: "ad2971a6c3eff3a0ba537529ba91cb28686a5101bf2f2c290e47c176cd23c38b"
  };
  report.run.detectors["cname-uncloaking"] = {
    version: "dns-cname-chain@3",
    status: "partial",
    reason: "evidence-cap-reached",
    phaseId: 0
  };
  report.run.detectors["privacy-policy"] = {
    ...report.run.detectors["privacy-policy"],
    version: "policy-text-cross-check@3"
  };
  report.run.fingerprints = buildFingerprints({
    conditions: report.run.conditions,
    provenance: report.run.provenance,
    toolchain: report.run.toolchain,
    detectors: report.run.detectors
  });
  report.run.quality = evaluateQuality(report.run.qualityFacts, {
    observedRequests: report.run.evidence.requests.length
  });
  assert.match(
    scanReportV2R2SemanticViolations(report).join("\n"),
    /cname-uncloaking lacks causal detector-output\/cname-lookups loss/
  );
});

test("the shared r2 semantic reader rejects a missing active-epoch obligation", () => {
  const report = makePublicSingleReportV2R2();
  report.run.detectors["cname-uncloaking"] = {
    version: report.run.detectors["cname-uncloaking"].version,
    status: "partial",
    reason: "evidence-cap-reached",
    phaseId: 0
  };
  report.run.fingerprints = buildFingerprints({
    conditions: report.run.conditions,
    provenance: report.run.provenance,
    toolchain: report.run.toolchain,
    detectors: report.run.detectors
  });
  report.run.quality = evaluateQuality(report.run.qualityFacts, {
    observedRequests: report.run.evidence.requests.length
  });
  assert.match(
    scanReportV2R2SemanticViolations(report).join("\n"),
    /cname-uncloaking lacks causal detector-output\/cname-lookups loss/
  );
});
