/**
 * Top-level Site Behavior Lab v3 scanner orchestrator.
 *
 * - Validates target URL through the live fail-closed Verus IP safety kernel
 * - Uses connect-time DNS-pinning `PublicScanProxy` for public scans
 * - Executes lead arm + requested comparison arms CONCURRENTLY in isolated
 *   BrowserContexts sharing immutable CNAME & privacy-policy caches (~2× faster!)
 * - Applies strict persistence-boundary redaction and structural validation
 *   before returning a clean `ScanReportV3`
 */

import { randomBytes } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { adblockListMeta, getDetailedAdblockEngine } from "../../adblock-engine";
import { partyKey } from "../../domain-utils";
import { NODE_ADBLOCK_ENGINE_VERSION, NODE_PLAYWRIGHT_VERSION } from "../../legacy-methodology";
import { startPublicScanProxy, type PublicScanProxy } from "../../public-scan-proxy";
import { assertPublicHttpUrl, normalizeUrl } from "../../url-safety";
import { GLOBAL_ENTITY_CATALOG_V3_STATS } from "../entity-catalog";
import { assertNoUnredactedSecretsV3, redactScanReportV3 } from "../redaction";
import {
  SCAN_REPORT_V3_SCHEMA_VERSION,
  validateScanReportV3,
  type ArmConditionsV3,
  type ComparisonAxisV3,
  type ConsentModeV3,
  type ScanDeviceV3,
  type ScanReportV3,
  type ShieldsModeV3
} from "../schema";
import type { CnameResolverFnV3 } from "../probes/cname-probe";
import { runScanArmV3, type SharedArmCachesV3 } from "./run-arm";
import { buildComparisonDeltaV3, buildReportHighlightsV3 } from "./summary";

export const SCANNER_V3_VERSION = "sbl-v3.0.0";

export type ScanRequestV3 = {
  url: string;
  device?: ScanDeviceV3;
  gpcEnabled?: boolean;
  shieldsMode?: ShieldsModeV3;
  consentMode?: ConsentModeV3;
  scrollCheck?: boolean;
  activeInputProbe?: boolean;
  policyCheck?: boolean;
  /** Optional comparison arms executed concurrently alongside the lead arm. */
  comparisons?: readonly ComparisonAxisV3[];
  locale?: string;
  timezone?: string;
  egressRegion?: string;
  acquisition?: "live-api" | "cli" | "ci-corpus" | "watch";
};

export type ScanSiteV3Deps = {
  browser?: Browser;
  /** Explicit test-only escape hatch for scanning local 127.0.0.1 fixture servers. */
  allowLoopbackFixture?: boolean;
  resolveCnameChain?: CnameResolverFnV3;
  navigationTimeoutMs?: number;
  passiveDwellMs?: number;
  scrollDwellMs?: number;
  inputDwellMs?: number;
};

let sharedBrowserPromise: Promise<Browser> | null = null;

async function acquireSharedBrowser(): Promise<Browser> {
  if (!sharedBrowserPromise) {
    const useSandbox = process.env.SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX !== "0";
    sharedBrowserPromise = chromium.launch({
      headless: true,
      chromiumSandbox: useSandbox,
      args: ["--disable-background-networking", "--disable-sync", "--metrics-recording-only"]
    });
    sharedBrowserPromise.catch(() => {
      sharedBrowserPromise = null;
    });
  }
  const browser = await sharedBrowserPromise;
  if (!browser.isConnected()) {
    sharedBrowserPromise = null;
    return acquireSharedBrowser();
  }
  return browser;
}

export async function closeSharedBrowserV3(): Promise<void> {
  if (!sharedBrowserPromise) return;
  const p = sharedBrowserPromise;
  sharedBrowserPromise = null;
  try {
    const b = await p;
    await b.close();
  } catch {}
}

/** Execute a full v3 scan (lead arm + concurrent comparison arms) and return a redacted ScanReportV3. */
export async function scanSiteV3(request: ScanRequestV3, deps: ScanSiteV3Deps = {}): Promise<ScanReportV3> {
  let targetUrl: string;
  if (deps.allowLoopbackFixture) {
    const parsed = new URL(request.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Target URL must use http or https");
    }
    targetUrl = parsed.toString();
  } else {
    const parsed = normalizeUrl(request.url);
    await assertPublicHttpUrl(parsed);
    targetUrl = parsed.toString();
  }

  let proxy: PublicScanProxy | null = null;
  if (!deps.allowLoopbackFixture) {
    proxy = await startPublicScanProxy();
  }

  const adblockEngine = await getDetailedAdblockEngine();
  const browser = deps.browser ?? (await acquireSharedBrowser());

  const leadConditions: ArmConditionsV3 = {
    device: request.device ?? "desktop",
    gpcEnabled: request.gpcEnabled ?? false,
    shieldsMode: request.shieldsMode ?? "off",
    consentMode: request.consentMode ?? "observe",
    scrollCheck: request.scrollCheck ?? true,
    activeInputProbe: request.activeInputProbe ?? true,
    policyCheck: request.policyCheck ?? true
  };

  const sharedCaches: SharedArmCachesV3 = {
    cnameByHost: new Map(),
    policyByUrl: new Map()
  };

  const armSpecs: { armId: string; label: string; axis?: ComparisonAxisV3; conditions: ArmConditionsV3 }[] = [
    { armId: "baseline", label: "Baseline visit", conditions: leadConditions }
  ];

  for (const axis of request.comparisons ?? []) {
    if (axis === "shields-standard") {
      armSpecs.push({
        armId: "shields-standard",
        label: "Brave Shields (Standard)",
        axis,
        conditions: { ...leadConditions, shieldsMode: "standard", policyCheck: false }
      });
    } else if (axis === "shields-aggressive") {
      armSpecs.push({
        armId: "shields-aggressive",
        label: "Brave Shields (Aggressive)",
        axis,
        conditions: { ...leadConditions, shieldsMode: "aggressive", policyCheck: false }
      });
    } else if (axis === "gpc") {
      armSpecs.push({
        armId: "gpc-enabled",
        label: "Global Privacy Control (Sec-GPC: 1)",
        axis,
        conditions: { ...leadConditions, gpcEnabled: true, policyCheck: false }
      });
    } else if (axis === "consent-accept") {
      armSpecs.push({
        armId: "consent-accept",
        label: "Consent: Accept All",
        axis,
        conditions: { ...leadConditions, consentMode: "accept-all", policyCheck: false }
      });
    } else if (axis === "consent-reject") {
      armSpecs.push({
        armId: "consent-reject",
        label: "Consent: Reject All",
        axis,
        conditions: { ...leadConditions, consentMode: "reject-all", policyCheck: false }
      });
    }
  }

  try {
    // Run baseline + all comparison arms CONCURRENTLY in isolated BrowserContexts!
    const armResults = await Promise.all(
      armSpecs.map((spec) =>
        runScanArmV3({
          armId: spec.armId,
          label: spec.label,
          targetUrl,
          conditions: spec.conditions,
          browser,
          adblockEngine,
          proxyServer: proxy?.server,
          locale: request.locale,
          timezone: request.timezone,
          navigationTimeoutMs: deps.navigationTimeoutMs,
          passiveDwellMs: deps.passiveDwellMs,
          scrollDwellMs: deps.scrollDwellMs,
          inputDwellMs: deps.inputDwellMs,
          resolveCnameChain: deps.resolveCnameChain,
          sharedCaches
        })
      )
    );

    const [leadResult, ...comparisonResults] = armResults;
    const allSentinels = armResults.flatMap((r) => r.sentinelsUsed);
    const comparisons = comparisonResults.map((res, idx) =>
      buildComparisonDeltaV3(leadResult.arm, res.arm, armSpecs[idx + 1].axis ?? "custom")
    );
    const highlights = buildReportHighlightsV3(leadResult.arm);

    const finalParsed = new URL(leadResult.arm.finalUrl || targetUrl);
    const canonicalDomain = partyKey(finalParsed.hostname).toLowerCase();
    const listMeta = adblockListMeta();

    const now = new Date();
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
    const reportId = `${ymd}-${randomBytes(16).toString("hex")}`;

    const rawReport: ScanReportV3 = {
      schemaVersion: SCAN_REPORT_V3_SCHEMA_VERSION,
      reportId,
      scannedAt: now.toISOString(),
      targetUrl,
      finalUrl: leadResult.arm.finalUrl,
      canonicalDomain,
      provenance: {
        schemaVersion: SCAN_REPORT_V3_SCHEMA_VERSION,
        scannerVersion: SCANNER_V3_VERSION,
        buildCommit: process.env.SITE_BEHAVIOR_LAB_BUILD_COMMIT || "local-dev",
        engineVersions: {
          chromium: browser.version(),
          playwright: NODE_PLAYWRIGHT_VERSION,
          adblockRust: NODE_ADBLOCK_ENGINE_VERSION,
          filterListsDigest: listMeta?.manifestDigest ?? "unknown",
          entityCatalogDigest: GLOBAL_ENTITY_CATALOG_V3_STATS.digest
        },
        egressRegion: request.egressRegion ?? process.env.SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION ?? "local",
        locale: request.locale ?? "en-US",
        timezone: request.timezone ?? "America/New_York",
        acquisition: request.acquisition ?? "live-api"
      },
      leadArm: leadResult.arm,
      comparisonArms: comparisonResults.map((r) => r.arm),
      comparisons,
      highlights
    };

    const redacted = redactScanReportV3(rawReport);
    assertNoUnredactedSecretsV3(redacted, allSentinels);
    const issues = validateScanReportV3(redacted);
    if (issues.length > 0) {
      throw new Error(`Invalid ScanReportV3 produced: ${issues.join("; ")}`);
    }

    return redacted;
  } finally {
    if (proxy) {
      await proxy.close().catch(() => {});
    }
  }
}
