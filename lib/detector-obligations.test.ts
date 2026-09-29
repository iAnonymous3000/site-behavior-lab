import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DETECTOR_OBLIGATION_CONTRACT_VERSION,
  DETECTOR_OBLIGATION_REGISTRY,
  DETECTOR_OBLIGATION_REGISTRY_DIGEST,
  DETECTOR_OBLIGATION_TARGET_REGISTRIES,
  DETECTOR_OBLIGATION_TARGET_REGISTRY,
  HISTORICAL_DETECTOR_OBLIGATION_CONTRACT_VERSION,
  HISTORICAL_DETECTOR_OBLIGATION_REGISTRY,
  HISTORICAL_DETECTOR_OBLIGATION_TARGET_REGISTRY,
  HISTORICAL_SERVICE_ROLE_DETECTOR_OBLIGATION_TARGET_REGISTRY,
  HISTORICAL_WRAPPED_VISIT_DETECTOR_OBLIGATION_TARGET_REGISTRY,
  detectorObligationContractVersion,
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
import { buildFingerprints, canonicalJson } from "./scan-report-v2-fingerprints";
import { evaluateQuality, BUDGET_FAMILIES } from "./scan-report-v2-evaluators";
import { HISTORICAL_SERVICE_ROLE_V1_NODE_R2_DETECTOR_OBLIGATIONS } from "./scan-report-v2-r2-producer-contract";
import { sha256Hex } from "./sha256";

const EPOCH = {
  detectorRegistryVersion: DETECTOR_REGISTRY_VERSION,
  detectorRegistryDigest: DETECTOR_REGISTRY_DIGEST
} as const;

// The last closed accountability epoch, spelled out: every epoch before v12
// hashed detector-obligations-v1 into its registry digest.
const NODE_V11_EPOCH = {
  detectorRegistryVersion: "node-detectors-v11",
  detectorRegistryDigest: "80209bf72ba24bc29b3f3526fe4ed9cbc09c4e230fbdb3be0ad61092683ae22a"
} as const;
// The node-detectors-v12 epoch, spelled out so a later epoch that renames the
// live target cannot move it to another contract unnoticed.
const NODE_V12_EPOCH = {
  detectorRegistryVersion: "node-detectors-v12",
  detectorRegistryDigest: "30a670c81952b0bac4c9bf668867fbce6cb868e39b9ffd6a3970e3b605dcda88"
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
      detectorRegistryVersion: "node-detectors-v6",
      detectorRegistryDigest: "81866718b36e35239f0418cc543eee845660e686849da1b816d937a601c1528b"
    },
    {
      detectorRegistryVersion: "node-detectors-v7",
      detectorRegistryDigest: "e019df75386c8f89584f5d14b4b191fa00f76a4ddb88f79a5875e7d07c72c89b"
    },
    {
      detectorRegistryVersion: "node-detectors-v8",
      detectorRegistryDigest: "fcd25504e7d18811478b440fbd738a01cacfdb8e4811099edc5be62d84402947"
    },
    {
      detectorRegistryVersion: "node-detectors-v9",
      detectorRegistryDigest: "b15c8281f0db49b91a46427ffee63e44bf7bbbfc0a9878069c2bb1098b6d4715"
    },
    {
      detectorRegistryVersion: "node-detectors-v10",
      detectorRegistryDigest: "6f8d32c39564e962b50e18ac72c414752154d533df1d1157131feed703e55657"
    },
    {
      detectorRegistryVersion: "node-detectors-v11",
      detectorRegistryDigest: "80209bf72ba24bc29b3f3526fe4ed9cbc09c4e230fbdb3be0ad61092683ae22a"
    },
    {
      detectorRegistryVersion: "node-detectors-v12",
      detectorRegistryDigest: "30a670c81952b0bac4c9bf668867fbce6cb868e39b9ffd6a3970e3b605dcda88"
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
  assert.equal(DETECTOR_OBLIGATION_TARGET_REGISTRIES[9], DETECTOR_OBLIGATION_TARGET_REGISTRY);
  assert.equal(Object.isFrozen(DETECTOR_OBLIGATION_TARGET_REGISTRIES), true);
});

function onEpoch(run: ScanRunV2, epoch: typeof EPOCH | typeof NODE_V11_EPOCH | typeof NODE_V12_EPOCH): ScanRunV2 {
  run.provenance.detectorRegistry = {
    version: epoch.detectorRegistryVersion,
    digest: epoch.detectorRegistryDigest
  };
  return run;
}

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

// The active contract under the live epoch, and v1 under the last closed one.
const CONTRACTS = [
  { label: "active", epoch: EPOCH, version: "detector-obligations-v2", registry: DETECTOR_OBLIGATION_REGISTRY },
  { label: "node-detectors-v11", epoch: NODE_V11_EPOCH, version: "detector-obligations-v1", registry: HISTORICAL_DETECTOR_OBLIGATION_REGISTRY }
] as const;

test("the immutable obligation registry accepts every registered causal row", () => {
  assert.equal(DETECTOR_OBLIGATION_CONTRACT_VERSION, "detector-obligations-v2");
  assert.equal(HISTORICAL_DETECTOR_OBLIGATION_CONTRACT_VERSION, "detector-obligations-v1");
  for (const { label, epoch, version, registry } of CONTRACTS) {
    assert.equal(detectorObligationContractVersion(epoch), version, label);
    assert.equal(Object.isFrozen(registry), true, label);
    for (const rule of registry) {
      if (rule.loss) {
        assert.ok(
          rule.loss.phaseRule === "detector-phase" ||
            rule.loss.phaseRule === "captured-request-phase" ||
            rule.loss.phaseRule === "fingerprint-coverage-phase",
          `${rule.detector}/${rule.status}/${rule.reason} must declare its phase rule`
        );
      }
      assert.deepEqual(
        detectorObligationViolations(onEpoch(configureRule(rule), epoch), "run", epoch),
        [],
        `${label} ${rule.detector}/${rule.status}/${rule.reason}`
      );
    }
  }
});

test("every detector status/reason row is either registered or rejected", () => {
  const statuses: readonly Exclude<DetectorStatus, "complete">[] = [
    "partial",
    "skipped",
    "unsupported",
    "failed"
  ];
  for (const { label, epoch, version, registry } of CONTRACTS) {
    const registered = new Set(
      registry.map(
        (rule) => `${rule.detector}/${rule.status}/${rule.reason}`
      )
    );
    for (const detector of DETECTOR_IDS) {
      for (const status of statuses) {
        for (const reason of DETECTOR_REASON_CODES) {
          const key = `${detector}/${status}/${reason}`;
          const rule = registry.find(
            (candidate) =>
              candidate.detector === detector &&
              candidate.status === status &&
              candidate.reason === reason
          );
          const run = onEpoch(
            rule
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
                })(),
            epoch
          );
          const violations = detectorObligationViolations(run, "run", epoch);
          assert.equal(violations.length === 0, registered.has(key), `${label} ${key}`);
          if (!rule) assert.match(violations.join("\n"), new RegExp(`uses an outcome outside ${version}$`), `${label} ${key}`);
        }
      }
    }
  }
});

test("each accountability epoch is held to the obligation contract its registry digest hashed", () => {
  // Every closed epoch recorded detector-obligations-v1 at fb8bd077...22a3,
  // and the registry the reader holds them to still hashes to exactly that.
  assert.equal(
    sha256Hex(canonicalJson({
      version: HISTORICAL_DETECTOR_OBLIGATION_CONTRACT_VERSION,
      rules: HISTORICAL_DETECTOR_OBLIGATION_REGISTRY
    })),
    "fb8bd07786fdb71c02ffdf1eca40a73b8974c691c6d4ef3c89230ad5314c22a3"
  );
  assert.deepEqual(HISTORICAL_SERVICE_ROLE_V1_NODE_R2_DETECTOR_OBLIGATIONS, {
    version: HISTORICAL_DETECTOR_OBLIGATION_CONTRACT_VERSION,
    digest: "fb8bd07786fdb71c02ffdf1eca40a73b8974c691c6d4ef3c89230ad5314c22a3"
  });
  assert.equal(
    DETECTOR_OBLIGATION_REGISTRY_DIGEST,
    "502d149030a4b771031a41ec71760e02d801a569ef0fe9725b01036351b10f2b"
  );
  // v2 is v1 with exactly one more row, in place: a CNAME lookup that failed
  // beside a found cloak, with the dropped lookups as its loss.
  const added = DETECTOR_OBLIGATION_REGISTRY.filter((rule) => !HISTORICAL_DETECTOR_OBLIGATION_REGISTRY.includes(rule));
  assert.deepEqual(added, [{
    detector: "cname-uncloaking",
    status: "partial",
    reason: "scan-failed",
    loss: { family: "detector-output", detail: "cname-lookups", kinds: ["dropped"], phaseRule: "detector-phase" }
  }]);
  assert.equal(HISTORICAL_DETECTOR_OBLIGATION_REGISTRY.length, DETECTOR_OBLIGATION_REGISTRY.length - 1);
  // Every closed epoch keeps v1; node-detectors-v12 alone is held to v2.
  assert.deepEqual(
    DETECTOR_OBLIGATION_TARGET_REGISTRIES.map((epoch) => [epoch.detectorRegistryVersion, detectorObligationContractVersion(epoch)]),
    [
      ["node-detectors-v3", "detector-obligations-v1"],
      ["node-detectors-v4", "detector-obligations-v1"],
      ["node-detectors-v5", "detector-obligations-v1"],
      ["node-detectors-v6", "detector-obligations-v1"],
      ["node-detectors-v7", "detector-obligations-v1"],
      ["node-detectors-v8", "detector-obligations-v1"],
      ["node-detectors-v9", "detector-obligations-v1"],
      ["node-detectors-v10", "detector-obligations-v1"],
      ["node-detectors-v11", "detector-obligations-v1"],
      ["node-detectors-v12", "detector-obligations-v2"]
    ]
  );
  assert.equal(detectorObligationContractVersion(NODE_V12_EPOCH), "detector-obligations-v2");
  // An epoch outside the target list has no contract to be held to.
  assert.throws(
    () => detectorObligationContractVersion({ detectorRegistryVersion: "node-detectors-v12", detectorRegistryDigest: "0".repeat(64) }),
    /is not a detector obligation target epoch/
  );
});

test("a failed CNAME lookup beside a found cloak is partial only from node-detectors-v12", () => {
  const partialLookupFailure = (epoch: typeof NODE_V11_EPOCH | typeof NODE_V12_EPOCH): ScanRunV2 => {
    const run = onEpoch(makeScanRunV2R2(), epoch);
    run.detectors["cname-uncloaking"] = {
      version: run.detectors["cname-uncloaking"].version,
      status: "partial",
      reason: "scan-failed",
      phaseId: 0
    };
    run.qualityFacts.captureLoss.push({
      family: "detector-output",
      phaseId: 0,
      kind: "dropped",
      count: 1,
      detail: "cname-lookups"
    });
    return run;
  };
  assert.deepEqual(detectorObligationViolations(partialLookupFailure(NODE_V12_EPOCH), "v12", NODE_V12_EPOCH), []);
  // node-detectors-v11 failed the detector there, so a v11 report may not say
  // partial, causal loss or not.
  assert.deepEqual(detectorObligationViolations(partialLookupFailure(NODE_V11_EPOCH), "v11", NODE_V11_EPOCH), [
    "v11: detector cname-uncloaking uses an outcome outside detector-obligations-v1"
  ]);
  // v12 still demands the causal loss.
  const withoutLoss = partialLookupFailure(NODE_V12_EPOCH);
  withoutLoss.qualityFacts.captureLoss = [];
  assert.match(
    detectorObligationViolations(withoutLoss, "v12", NODE_V12_EPOCH).join("\n"),
    /cname-uncloaking lacks causal detector-output\/cname-lookups loss/
  );
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

test("every accountability epoch still rejects an unexplained partial pixel detector", () => {
  for (const epoch of DETECTOR_OBLIGATION_TARGET_REGISTRIES) {
    const run = makeScanRunV2R2();
    run.provenance.detectorRegistry = {
      version: epoch.detectorRegistryVersion,
      digest: epoch.detectorRegistryDigest
    };
    run.detectors["pixel-events"] = {
      ...run.detectors["pixel-events"], status: "partial", reason: "scan-failed", phaseId: 0
    };
    assert.match(detectorObligationViolations(run, "run", epoch).join("\n"),
      /pixel-events lacks causal detector-output\/pixel-decode loss/, epoch.detectorRegistryVersion);
    run.qualityFacts.captureLoss.push({ family: "detector-output", phaseId: 0, kind: "dropped", count: 1, detail: "pixel-decode" });
    assert.deepEqual(detectorObligationViolations(run, "run", epoch), []);
  }
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
