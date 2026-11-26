import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateFailOnRulesV3,
  formatDiffMarkdownV3,
  formatReportMarkdownV3,
  verifyReportV3Json
} from "./v3/cli/formatters";
import { runSblCli } from "./v3/cli/index";
import { diffToSarifV3, reportToSarifV3 } from "./v3/cli/sarif";
import { redactScanReportV3 } from "./v3/redaction";
import { diffScanReportsV3 } from "./v3/runtime/watch-diff";
import type { ScanReportV3 } from "./v3/schema";

function makeFixtureReport(opts: {
  reportId: string;
  domain: string;
  thirdPartyDomains: number;
  darkPatternScore: number;
  keystrokeLeaks?: number;
  cnameCloaks?: number;
  sgtm?: boolean;
  beaconPii?: boolean;
  fingerprinting?: boolean;
  extraEntity?: string;
}): ScanReportV3 {
  const ks = opts.keystrokeLeaks ?? 0;
  const cn = opts.cnameCloaks ?? 0;
  const sgtm = opts.sgtm ?? false;
  const fp = opts.fingerprinting ?? false;
  const topEntities: ScanReportV3["leadArm"]["summary"]["topEntities"] = [
    {
      entity: "Google Analytics",
      parentOrg: "Alphabet",
      category: "analytics",
      requests: 4,
      domains: 1
    }
  ];
  if (opts.extraEntity) {
    topEntities.push({
      entity: opts.extraEntity,
      parentOrg: opts.extraEntity,
      category: "advertising",
      requests: 3,
      domains: 1
    });
  }

  return redactScanReportV3({
    schemaVersion: 3,
    reportId: opts.reportId,
    scannedAt: "2026-11-25T15:00:00.000Z",
    targetUrl: `https://${opts.domain}/`,
    finalUrl: `https://${opts.domain}/`,
    canonicalDomain: opts.domain,
    provenance: {
      schemaVersion: 3,
      scannerVersion: "sbl-v3.0.0",
      buildCommit: "test-sha",
      engineVersions: {
        chromium: "159.0.0.0",
        playwright: "1.65.1",
        adblockRust: "0.12.5",
        filterListsDigest: "abc",
        entityCatalogDigest: "def"
      },
      egressRegion: "us-east",
      locale: "en-US",
      timezone: "America/New_York",
      acquisition: "cli"
    },
    leadArm: {
      armId: "baseline",
      label: "Baseline visit",
      conditions: {
        device: "desktop",
        gpcEnabled: false,
        shieldsMode: "off",
        consentMode: "observe",
        scrollCheck: true,
        activeInputProbe: true,
        policyCheck: true
      },
      finalUrl: `https://${opts.domain}/`,
      httpStatus: 200,
      loadOutcome: "ok",
      durationMs: 2100,
      phases: [{ name: "passive-load", startedAtMs: 0, endedAtMs: 1200, status: "completed" }],
      probes: {
        network: { status: "complete" },
        websockets: { status: "complete" },
        serviceWorkers: { status: "complete" },
        cookies: { status: "complete" },
        storage: { status: "complete" },
        beacons: { status: "complete" },
        cname: { status: "complete" },
        fingerprinting: { status: "complete" },
        keystrokes: { status: "complete" },
        consent: { status: "complete" },
        policy: { status: "complete" }
      },
      network: [],
      websockets: [],
      serviceWorkers: [],
      cookies: [],
      storage: [],
      beacons: [
        {
          platform: "Google Analytics 4",
          product: "GA4",
          format: "ga4",
          endpointHost: sgtm ? `metrics.${opts.domain}` : "www.google-analytics.com",
          firstPartyEndpoint: sgtm,
          serverSideTagging: sgtm,
          phases: ["passive-load"],
          events: ["page_view"],
          scrollDepths: [75],
          consentModeSignals: [],
          identifierCategories: opts.beaconPii ? ["email", "external_id"] : ["external_id"],
          requests: 2,
          complete: true
        }
      ],
      cnameCloaks: Array.from({ length: cn }, () => ({
        host: `t.${opts.domain}`,
        cnameChain: [`t.${opts.domain}`, "collector.criteo.com"],
        targetDomain: "criteo.com",
        entity: {
          entity: "Criteo",
          parentOrg: "Criteo",
          category: "advertising",
          region: "EU",
          confidence: "cname-uncloaked",
          matchedDomain: "criteo.com"
        },
        shieldsMatched: true,
        requestCount: 3
      })),
      fingerprinting: fp
        ? [
            {
              kind: "mutation-observer-replay",
              count: 4,
              realms: ["main"],
              apis: ["MutationObserver.observe"],
              scriptDomains: ["cdn.replay.example"],
              evidence: { wholeDocument: true }
            }
          ]
        : [],
      keystrokes: {
        fieldsTyped: 1,
        iframeFieldsTyped: 0,
        shadowDomFieldsTyped: 1,
        fieldTypes: ["email"],
        leaks: Array.from({ length: ks }, () => ({
          domain: "collect.replay.example",
          registrableDomain: "replay.example",
          thirdParty: true,
          transport: "http-body-gzip",
          encoding: "plain",
          phase: "active-input"
        }))
      },
      consent: {
        mode: "observe",
        banner: {
          detected: opts.darkPatternScore > 0,
          cmp: opts.darkPatternScore > 0 ? "OneTrust" : null,
          hasFirstLayerAccept: opts.darkPatternScore > 0,
          hasFirstLayerReject: opts.darkPatternScore < 25,
          hasSettingsEntry: opts.darkPatternScore > 0,
          clicksToAccept: opts.darkPatternScore > 0 ? 1 : null,
          clicksToReject: opts.darkPatternScore >= 35 ? 3 : 1,
          darkPatternFlags: opts.darkPatternScore >= 35 ? ["reject-hidden-in-settings", "asymmetric-clicks"] : [],
          darkPatternScore: opts.darkPatternScore
        },
        interaction: { attempted: false, clicked: false, layer: null },
        verification: {
          tcf: { present: false, gdprApplies: null, eventStatus: null, state: "unavailable" },
          gpp: { present: false, applicableSections: [], state: "unavailable" },
          usp: { present: false, optOutSale: null },
          googleConsentMode: [],
          cmpCookies: [],
          consistency: "unavailable"
        }
      },
      policy: {
        url: `https://${opts.domain}/privacy`,
        language: "en",
        textLength: 1500,
        fromIframe: false,
        claims: [],
        mentionedEntities: ["Google Analytics"],
        unmentionedEntities: opts.extraEntity ? [opts.extraEntity] : []
      },
      summary: {
        totalRequests: 20,
        thirdPartyRequests: 10,
        thirdPartyDomains: opts.thirdPartyDomains,
        trackingRequests: 8,
        shieldsMatchedRequests: 8,
        shieldsBlockedStandard: 7,
        shieldsBlockedAggressive: 8,
        distinctEntities: topEntities.length,
        distinctParentOrgs: topEntities.length,
        cookiesTotal: 4,
        thirdPartyCookies: 1,
        longLivedCookies: 2,
        partitionedCookies: 0,
        storageKeysTotal: 2,
        websocketsTotal: 0,
        serviceWorkersTotal: 0,
        beaconPlatforms: 1,
        serverSideTaggingEndpoints: sgtm ? 1 : 0,
        cnameCloaksCount: cn,
        fingerprintKindsCount: fp ? 1 : 0,
        keystrokeLeaksCount: ks,
        darkPatternScore: opts.darkPatternScore,
        topEntities
      }
    },
    comparisonArms: [],
    comparisons: [],
    highlights: [
      {
        id: "h1",
        severity: ks > 0 ? "critical" : "medium",
        category: ks > 0 ? "keystrokes" : "third-parties",
        title: `${opts.domain} contacted ${opts.thirdPartyDomains} third-party domains`,
        detail: "Observed in controlled visit."
      }
    ]
  });
}

test("SARIF 2.1.0 exporter emits valid rules & results for reports and regressions", () => {
  const base = makeFixtureReport({
    reportId: "20261120-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    domain: "app.example",
    thirdPartyDomains: 4,
    darkPatternScore: 0
  });
  const risky = makeFixtureReport({
    reportId: "20261125-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    domain: "staging.app.example",
    thirdPartyDomains: 14,
    darkPatternScore: 55,
    keystrokeLeaks: 1,
    cnameCloaks: 1,
    sgtm: true,
    beaconPii: true,
    fingerprinting: true,
    extraEntity: "Criteo"
  });

  const diff = diffScanReportsV3(base, risky);
  const sarif = reportToSarifV3(risky, diff);
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0].tool.driver.name, "Site Behavior Lab");

  const ruleIds = new Set(sarif.runs[0].results.map((r) => r.ruleId));
  assert.ok(ruleIds.has("SBL-KEYSTROKE-EXFIL"));
  assert.ok(ruleIds.has("SBL-CNAME-CLOAK"));
  assert.ok(ruleIds.has("SBL-SGTM-ENDPOINT"));
  assert.ok(ruleIds.has("SBL-BEACON-PII"));
  assert.ok(ruleIds.has("SBL-FINGERPRINTING"));
  assert.ok(ruleIds.has("SBL-DARK-PATTERNS"));
  assert.ok(ruleIds.has("SBL-POLICY-GAP"));
  assert.ok(ruleIds.has("SBL-REGRESSION"));

  const diffOnlySarif = diffToSarifV3(diff);
  assert.equal(diffOnlySarif.version, "2.1.0");
  assert.ok(diffOnlySarif.runs[0].results.length > 0);
});

test("evaluateFailOnRulesV3 enforces every CI privacy gate cleanly", () => {
  const clean = makeFixtureReport({
    reportId: "20261120-11111111111111111111111111111111",
    domain: "clean.example",
    thirdPartyDomains: 3,
    darkPatternScore: 0
  });
  assert.deepEqual(
    evaluateFailOnRulesV3(clean, null, [
      "keystrokes",
      "cname",
      "sgtm",
      "fingerprinting",
      "beacon-pii",
      "dark-patterns>=35",
      "third-parties>10"
    ]),
    []
  );

  const risky = makeFixtureReport({
    reportId: "20261125-22222222222222222222222222222222",
    domain: "risky.example",
    thirdPartyDomains: 15,
    darkPatternScore: 45,
    keystrokeLeaks: 1,
    cnameCloaks: 1,
    sgtm: true,
    beaconPii: true,
    fingerprinting: true,
    extraEntity: "Criteo"
  });
  const diff = diffScanReportsV3(clean, risky);
  const violations = evaluateFailOnRulesV3(risky, diff, [
    "keystrokes",
    "cname",
    "sgtm",
    "fingerprinting",
    "beacon-pii",
    "dark-patterns>=35",
    "third-parties>10",
    "new-entities",
    "regressions"
  ]);
  assert.equal(violations.length, 9);
});

test("verifyReportV3Json passes redacted reports and rejects unredacted secrets", () => {
  const clean = makeFixtureReport({
    reportId: "20261125-33333333333333333333333333333333",
    domain: "verify.example",
    thirdPartyDomains: 4,
    darkPatternScore: 0
  });
  const res = verifyReportV3Json(JSON.stringify(clean));
  assert.equal(res.ok, true, res.issues.join("; "));
  assert.equal(res.redactionIdempotent, true);
  assert.match(res.digest ?? "", /^[a-f0-9]{64}$/);

  // Tamper by injecting a raw query string secret
  const tampered = structuredClone(clean);
  tampered.finalUrl = "https://verify.example/checkout?token=secret_abc123";
  const badRes = verifyReportV3Json(JSON.stringify(tampered));
  assert.equal(badRes.ok, false);
  assert.ok(badRes.issues.length > 0);
});

test("runSblCli executes scan, diff, verify, catalog, and CI exit codes end-to-end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-cli-test-"));
  try {
    const baseline = makeFixtureReport({
      reportId: "20261120-44444444444444444444444444444444",
      domain: "shop.example",
      thirdPartyDomains: 5,
      darkPatternScore: 10
    });
    const staging = makeFixtureReport({
      reportId: "20261125-55555555555555555555555555555555",
      domain: "staging.shop.example",
      thirdPartyDomains: 12,
      darkPatternScore: 45,
      keystrokeLeaks: 1,
      extraEntity: "Criteo"
    });

    const baselinePath = path.join(dir, "baseline.json");
    const stagingPath = path.join(dir, "staging.json");
    const sarifPath = path.join(dir, "out.sarif");
    await writeFile(baselinePath, JSON.stringify(baseline), "utf8");

    let stdout = "";
    let stderr = "";
    const code = await runSblCli(
      [
        "scan",
        "https://staging.shop.example/",
        "--region",
        "eu-central",
        "--compare",
        "shields-standard,gpc",
        "--diff",
        baselinePath,
        "--format",
        "sarif",
        "--output",
        sarifPath,
        "--save-report",
        stagingPath,
        "--fail-on",
        "keystrokes,regressions"
      ],
      {
        scanImpl: async (req) => {
          assert.equal(req.locale, "de-DE");
          assert.deepEqual(req.comparisons, ["shields-standard", "gpc"]);
          return staging;
        },
        closeBrowserImpl: async () => {},
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        }
      }
    );

    assert.equal(code, 2, "Expected exit code 2 when --fail-on gate triggers");
    assert.match(stderr, /Policy gate failed/);
    const sarifWritten = JSON.parse(await readFile(sarifPath, "utf8"));
    assert.equal(sarifWritten.version, "2.1.0");
    assert.ok(sarifWritten.runs[0].results.some((r: { ruleId: string }) => r.ruleId === "SBL-KEYSTROKE-EXFIL"));

    // Verify saved report offline
    stdout = "";
    stderr = "";
    const verifyCode = await runSblCli(["verify", stagingPath, "--json"], {
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      }
    });
    assert.equal(verifyCode, 0, stderr);
    const verifyOut = JSON.parse(stdout);
    assert.equal(verifyOut.ok, true);
    assert.equal(verifyOut.reportId, staging.reportId);

    // Diff command with markdown output + regression exit code
    stdout = "";
    stderr = "";
    const diffCode = await runSblCli(["diff", baselinePath, stagingPath, "--fail-on-regression"], {
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      }
    });
    assert.equal(diffCode, 2);
    assert.match(stdout, /Baseline Diff/);
    assert.match(stdout, /Regression Alerts/);

    // Catalog CLI search
    stdout = "";
    const catCode = await runSblCli(["catalog", "Alphabet", "--json"], {
      stdout: (s) => {
        stdout += s;
      }
    });
    assert.equal(catCode, 0);
    const catJson = JSON.parse(stdout);
    assert.ok(catJson.total >= 5);

    // Markdown formatter smoke check
    const md = formatReportMarkdownV3(staging, diffScanReportsV3(baseline, staging));
    assert.match(md, /Site Behavior Lab v3/);
    assert.match(formatDiffMarkdownV3(diffScanReportsV3(baseline, staging)), /Entities added.*Criteo/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("action.yml defines the reusable composite GitHub Action backed by bin/sbl.mjs", async () => {
  const root = process.cwd();
  const actionYml = await readFile(path.join(root, "action.yml"), "utf8");
  assert.match(actionYml, /using:\s*"composite"/);
  assert.match(actionYml, /bin\/sbl\.mjs/);
  assert.match(actionYml, /--format sarif/);
  assert.match(actionYml, /GITHUB_STEP_SUMMARY/);

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.bin?.sbl, "./bin/sbl.mjs");
  assert.match(actionYml, /fail-on-insufficient-evidence/);
  assert.match(actionYml, /baseline-comparability/);
  assert.match(actionYml, /--fail-on-insufficient-evidence/);
  assert.match(actionYml, /insufficient-evidence/);
});

test("CLI, SARIF, and Markdown make unevaluable baselines explicit with exit code 3 instead of a silent pass", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-cli-unevaluable-"));
  try {
    const leakBaseline = makeFixtureReport({
      reportId: "20261120-aaaa1111111111111111111111111111",
      domain: "shop.example",
      thirdPartyDomains: 5,
      darkPatternScore: 10,
      keystrokeLeaks: 1
    });
    const zeroFieldsCurrent = makeFixtureReport({
      reportId: "20261125-bbbb2222222222222222222222222222",
      domain: "staging.shop.example",
      thirdPartyDomains: 5,
      darkPatternScore: 10,
      keystrokeLeaks: 0
    });
    zeroFieldsCurrent.leadArm.keystrokes.fieldsTyped = 0;
    zeroFieldsCurrent.leadArm.keystrokes.shadowDomFieldsTyped = 0;
    zeroFieldsCurrent.leadArm.probes.keystrokes = { status: "skipped", reason: "no-eligible-input-fields" };

    const baselinePath = path.join(dir, "baseline.json");
    const currentPath = path.join(dir, "current.json");
    const sarifPath = path.join(dir, "unevaluable.sarif");
    await writeFile(baselinePath, JSON.stringify(leakBaseline), "utf8");
    await writeFile(currentPath, JSON.stringify(zeroFieldsCurrent), "utf8");

    // 1. sbl diff --fail-on-regression MUST exit 3 (not 0) when keystroke comparison has insufficient evidence
    let stdout = "";
    let stderr = "";
    const diffCode = await runSblCli(["diff", baselinePath, currentPath, "--fail-on-regression"], {
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      }
    });
    assert.equal(diffCode, 3, `Expected exit code 3 for unevaluable baseline diff, got ${diffCode}`);
    assert.match(stdout, /#### Insufficient Evidence/);
    assert.match(stdout, /typed into 0 fields/i);
    assert.doesNotMatch(stdout, /No privacy regressions detected relative to baseline\./);
    assert.match(stderr, /insufficient evidence/i);

    // 2. Reverse order (0 fields -> leak) with sbl diff --fail-on-regression also exits 3 (insufficient evidence)
    stderr = "";
    const reverseDiffCode = await runSblCli(["diff", currentPath, baselinePath, "--fail-on-regression"], {
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      }
    });
    assert.equal(reverseDiffCode, 3);
    assert.match(stderr, /baseline typed into 0 fields/i);

    // 3. sbl scan --diff --fail-on regressions exits 3 and emits SBL-DIFF-INSUFFICIENT-EVIDENCE in SARIF
    stdout = "";
    stderr = "";
    const scanCode = await runSblCli(
      [
        "scan",
        "https://staging.shop.example/",
        "--diff",
        baselinePath,
        "--format",
        "sarif",
        "--output",
        sarifPath,
        "--fail-on",
        "regressions"
      ],
      {
        scanImpl: async () => zeroFieldsCurrent,
        closeBrowserImpl: async () => {},
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        }
      }
    );
    assert.equal(scanCode, 3, `Expected exit code 3 for unevaluable --fail-on regressions, got ${scanCode}`);
    assert.match(stderr, /insufficient evidence/i);
    const sarif = JSON.parse(await readFile(sarifPath, "utf8"));
    assert.ok(
      sarif.runs[0].results.some((r: { ruleId: string }) => r.ruleId === "SBL-DIFF-INSUFFICIENT-EVIDENCE"),
      "SARIF must emit SBL-DIFF-INSUFFICIENT-EVIDENCE warning"
    );

    // 4. --fail-on-insufficient-evidence exits 3 even when --fail-on only checks single-report rules (as in action.yml)
    const actionModeCode = await runSblCli(
      [
        "scan",
        "https://staging.shop.example/",
        "--diff",
        baselinePath,
        "--fail-on",
        "keystrokes,cname",
        "--fail-on-insufficient-evidence"
      ],
      {
        scanImpl: async () => zeroFieldsCurrent,
        closeBrowserImpl: async () => {},
        stdout: () => {},
        stderr: () => {}
      }
    );
    assert.equal(actionModeCode, 3);

    // 5. Standalone diffToSarifV3 also carries SBL-DIFF-INSUFFICIENT-EVIDENCE
    const standaloneSarif = diffToSarifV3(diffScanReportsV3(leakBaseline, zeroFieldsCurrent));
    assert.ok(
      standaloneSarif.runs[0].results.some((r) => r.ruleId === "SBL-DIFF-INSUFFICIENT-EVIDENCE")
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
