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
import { browserProcessEnvironment } from "../../browser-process-env";
import { chromiumSandboxEnabled } from "../../chromium-sandbox";
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
  armDeadlineMs?: number;
  signal?: AbortSignal;
};

const MAX_CONCURRENT_ARMS_PER_SCAN = 3;
const SHARED_BROWSER_IDLE_SHUTDOWN_MS = 90_000;

let sharedBrowserPromise: Promise<Browser> | null = null;
let sharedBrowserIdleTimer: ReturnType<typeof setTimeout> | null = null;
let activeScansV3 = 0;

function scheduleSharedBrowserIdleShutdown(): void {
  if (sharedBrowserIdleTimer) clearTimeout(sharedBrowserIdleTimer);
  sharedBrowserIdleTimer = setTimeout(() => {
    sharedBrowserIdleTimer = null;
    if (activeScansV3 > 0) return;
    void closeSharedBrowserV3();
  }, SHARED_BROWSER_IDLE_SHUTDOWN_MS);
  sharedBrowserIdleTimer.unref?.();
}

async function acquireSharedBrowser(): Promise<Browser> {
  if (sharedBrowserIdleTimer) {
    clearTimeout(sharedBrowserIdleTimer);
    sharedBrowserIdleTimer = null;
  }
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = chromium.launch({
      headless: true,
      chromiumSandbox: chromiumSandboxEnabled(),
      env: browserProcessEnvironment(),
      args: [
        "--disable-background-networking",
        "--disable-sync",
        "--metrics-recording-only",
        // Block non-proxied WebRTC UDP ICE/STUN so scanned pages cannot probe
        // RFC1918/loopback/internal container addresses outside PublicScanProxy.
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
      ]
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
  if (sharedBrowserIdleTimer) {
    clearTimeout(sharedBrowserIdleTimer);
    sharedBrowserIdleTimer = null;
  }
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

  activeScansV3 += 1;
  try {
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

    const leadLabel =
      leadConditions.consentMode === "accept-all"
        ? "Consent: Accept All"
        : leadConditions.consentMode === "reject-all"
          ? "Consent: Reject All"
          : "Baseline visit";
    const armSpecs: { armId: string; label: string; axis?: ComparisonAxisV3; conditions: ArmConditionsV3 }[] = [
      { armId: "baseline", label: leadLabel, conditions: leadConditions }
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

    // Run arms in bounded concurrency batches with Promise.allSettled so sibling
    // contexts always finish teardown cleanly before the proxy closes.
    const armResults: Awaited<ReturnType<typeof runScanArmV3>>[] = [];
    for (let i = 0; i < armSpecs.length; i += MAX_CONCURRENT_ARMS_PER_SCAN) {
      const batch = armSpecs.slice(i, i + MAX_CONCURRENT_ARMS_PER_SCAN);
      const settled = await Promise.allSettled(
        batch.map((spec) =>
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
            armDeadlineMs: deps.armDeadlineMs,
            signal: deps.signal,
            resolveCnameChain: deps.resolveCnameChain,
            sharedCaches
          })
        )
      );
      const firstRejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (firstRejected) throw firstRejected.reason;
      for (const r of settled) {
        if (r.status === "fulfilled") armResults.push(r.value);
      }
    }

    // Surface proxy traffic/byte-budget truncation or local socket failures into
    // probe coverage so truncated visits are never falsely marked "complete".
    if (proxy) {
      const diag = proxy.getDiagnostics();
      const proxyLossCount =
        (diag.trafficBudget.captureLoss?.count ?? 0) +
        (diag.responseByteBudget.captureLoss?.count ?? 0) +
        (diag.uploadByteBudget.captureLoss?.count ?? 0);
      const localProxyFailures = proxy.blockedTargets.filter(
        (b) => b.reason === "local-upstream-failure" || b.reason === "resource-limit"
      ).length;
      const nonPublicBlocks = proxy.blockedTargets.filter((b) => b.reason === "non-public-address").length;
      const totalProxyImpact = proxyLossCount + localProxyFailures;
      if (totalProxyImpact > 0 || nonPublicBlocks > 0) {
        const reason =
          proxyLossCount > 0
            ? "proxy-capture-limit-reached"
            : localProxyFailures > 0
              ? "proxy-upstream-failure"
              : "proxy-non-public-target-blocked";
        for (const res of armResults) {
          const prevOmitted = res.arm.probes.network.omittedCount ?? 0;
          if (res.arm.probes.network.status === "complete") {
            res.arm.probes.network = {
              status: "partial",
              reason,
              omittedCount: prevOmitted + totalProxyImpact + nonPublicBlocks
            };
          } else {
            res.arm.probes.network = {
              ...res.arm.probes.network,
              omittedCount: prevOmitted + totalProxyImpact + nonPublicBlocks
            };
          }
        }
      }
    }

    const [leadResult, ...comparisonResults] = armResults;
    const allSentinels = armResults.flatMap((r) => r.sentinelsUsed);
    const comparisons = comparisonResults.map((res, idx) =>
      buildComparisonDeltaV3(leadResult.arm, res.arm, armSpecs[idx + 1].axis ?? "custom")
    );

    const resolveSafeCanonicalDomain = (finalUrlCandidate: string, fallbackTarget: string): string => {
      for (const candidate of [finalUrlCandidate, fallbackTarget]) {
        try {
          const u = new URL(candidate);
          if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".")) {
            const key = partyKey(u.hostname).toLowerCase();
            if (/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])$/i.test(key) && key.includes(".")) {
              return key;
            }
          }
        } catch {}
      }
      return new URL(fallbackTarget).hostname.toLowerCase();
    };
    const canonicalDomain = resolveSafeCanonicalDomain(leadResult.arm.finalUrl, targetUrl);
    const listMeta = adblockListMeta();

    const now = new Date();
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
    const reportId = `${ymd}-${randomBytes(16).toString("hex")}`;

    const preRedactedReport: ScanReportV3 = redactScanReportV3(
      {
        schemaVersion: SCAN_REPORT_V3_SCHEMA_VERSION,
        reportId,
        scannedAt: now.toISOString(),
        targetUrl,
        finalUrl: leadResult.arm.finalUrl,
        canonicalDomain,
        provenance: {
          schemaVersion: SCAN_REPORT_V3_SCHEMA_VERSION,
          scannerVersion: SCANNER_V3_VERSION,
          buildCommit: process.env.SITE_BEHAVIOR_LAB_BUILD_COMMIT?.trim() || "local-dev",
          engineVersions: {
            chromium: browser.version(),
            playwright: NODE_PLAYWRIGHT_VERSION,
            adblockRust: NODE_ADBLOCK_ENGINE_VERSION,
            filterListsDigest: listMeta?.manifestDigest ?? "unknown",
            entityCatalogDigest: GLOBAL_ENTITY_CATALOG_V3_STATS.digest
          },
          egressRegion:
            request.egressRegion?.trim() ||
            process.env.SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION?.trim() ||
            "local",
          locale: request.locale ?? "en-US",
          timezone: request.timezone ?? "America/New_York",
          acquisition: request.acquisition ?? "live-api"
        },
        leadArm: leadResult.arm,
        comparisonArms: comparisonResults.map((r) => r.arm),
        comparisons,
        highlights: []
      },
      allSentinels
    );

    // Build highlights AFTER arm redaction so policy URLs & prose never carry raw query strings
    const redacted: ScanReportV3 = redactScanReportV3(
      {
        ...preRedactedReport,
        highlights: buildReportHighlightsV3(preRedactedReport.leadArm)
      },
      allSentinels
    );
    assertNoUnredactedSecretsV3(redacted, allSentinels);
    const issues = validateScanReportV3(redacted);
    if (issues.length > 0) {
      throw new Error(`Invalid ScanReportV3 produced: ${issues.join("; ")}`);
    }

    return redacted;
  } finally {
    activeScansV3 = Math.max(0, activeScansV3 - 1);
    if (activeScansV3 === 0 && !deps.browser) {
      scheduleSharedBrowserIdleShutdown();
    }
    if (proxy) {
      await proxy.close().catch(() => {});
    }
  }
}
