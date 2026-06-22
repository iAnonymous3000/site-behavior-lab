import { adblockEngineStatus, type AdblockEngineStatus } from "./adblock-engine";
import { scanAccessTokenConfigured } from "./access-control";
import { reportStoreStatus } from "./report-store";
import type { ReportStoreKind } from "./report-store-backend";
import { producerCapability } from "./report-producers";
import { asScanRuntimeHealth, type ScanRuntimeCapabilities } from "./scan-runtime-health";

const SCANNER_EGRESS_ENV = "SITE_BEHAVIOR_LAB_SCANNER_EGRESS";

// Backend-agnostic public projection: never exposes a filesystem path or an R2
// bucket/endpoint to /api/health, only the backend kind and shared policy.
type PublicReportStoreStatus = {
  kind: ReportStoreKind;
  configuredPath: boolean;
  maxAgeDays: number;
  maxCount: number;
};
type RuntimeStatusAdblockCheck = AdblockEngineStatus;

export type RuntimeStatus = {
  ok: boolean;
  status: "ok" | "degraded";
  timestamp: string;
  authenticated: boolean;
  openAccess: boolean;
  turnstile: boolean;
  checks: {
    adblock: RuntimeStatusAdblockCheck;
    scanAccess: "configured" | "open";
    dnsRebindingGuard: "connect-time-proxy";
    reportStore: PublicReportStoreStatus;
    scannerEgress: "configured" | "default";
  };
  capabilities: ScanRuntimeCapabilities;
  warnings: string[];
};

export async function runtimeStatus(
  getAdblockStatus: () => Promise<RuntimeStatusAdblockCheck> = adblockEngineStatus
): Promise<RuntimeStatus> {
  const adblock = await getAdblockStatus();
  const capability = producerCapability("node");
  const authenticated = scanAccessTokenConfigured();
  const warnings = productionWarnings();
  const reportStore = publicReportStoreStatus();
  if (!adblock.active) {
    warnings.push("Brave Shields classification is unavailable; tracker labels use the curated catalog only.");
  }

  return asScanRuntimeHealth({
    ok: true,
    status: warnings.length === 0 ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    // The static Pages UI reads these to gate the access-key field and open-access
    // behaviour when it points at this container (Option B two-origin topology).
    // A gated container that omitted `authenticated` would make the UI skip the
    // key it requires, 401-ing every scan. Node has no Turnstile (edge-only).
    authenticated,
    openAccess: !authenticated,
    turnstile: false,
    checks: {
      adblock,
      scanAccess: authenticated ? "configured" : "open",
      dnsRebindingGuard: "connect-time-proxy",
      reportStore,
      scannerEgress: process.env[SCANNER_EGRESS_ENV]?.trim() ? "configured" : "default"
    },
    capabilities: {
      singleScan: capability.singleScan,
      gpcComparison: capability.gpcComparison,
      // Shields block-simulation needs the Brave ad-block engine; advertise it
      // only when the engine actually loaded so the static UI's toggle reflects
      // real capability instead of enabling a degraded mode.
      shieldsComparison: capability.shieldsComparison && adblock.active,
      savedReports: true,
      // The full Next app serves /reports/:id pages, so live-scanned reports have
      // a shareable permalink on this origin.
      savedReportPages: true
    },
    warnings
  });
}

function publicReportStoreStatus(): PublicReportStoreStatus {
  const status = reportStoreStatus();
  return {
    kind: status.kind,
    configuredPath: status.configuredPath,
    maxAgeDays: status.maxAgeDays,
    maxCount: status.maxCount
  };
}

function unauthenticatedScansAllowed(): boolean {
  return process.env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS === "1";
}

function productionWarnings(): string[] {
  const warnings: string[] = [];
  const reportStore = reportStoreStatus();

  // No token means anyone can scan. That is a warning when it looks accidental,
  // but an explicit `ALLOW_UNAUTHENTICATED_SCANS=1` is a deliberate open posture
  // (e.g. the public Containers scanner, gated by Turnstile + rate limiting at
  // the edge), so it should not degrade health.
  if (!scanAccessTokenConfigured() && !unauthenticatedScansAllowed()) {
    warnings.push("SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN is not configured; public visitors can start scans.");
  }

  if (!reportStore.configuredPath) {
    warnings.push("SITE_BEHAVIOR_LAB_REPORT_STORE_DIR is not configured; reports use the app working directory.");
  }

  if (!process.env[SCANNER_EGRESS_ENV]?.trim()) {
    warnings.push("SITE_BEHAVIOR_LAB_SCANNER_EGRESS is not configured; reports use the generic scanner egress label.");
  }

  return warnings;
}
