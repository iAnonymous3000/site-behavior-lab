import { adblockEngineStatus, type AdblockEngineStatus } from "./adblock-engine";
import { recordedBuildCommit } from "./build-provenance";
import { scanAccessTokenConfigured } from "./access-control";
import { chromiumSandboxEnabled } from "./chromium-sandbox";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import { reportStoreStatus } from "./report-store";
import type { ReportStoreKind } from "./report-store-backend";
import { producerCapability } from "./report-producers";
import {
  publicR2ReportsReadiness,
  type PublicR2ReportsReadiness
} from "./runtime-scan-report";
import { asScanRuntimeHealth, type ScanRuntimeCapabilities } from "./scan-runtime-health";
import {
  V2_SHADOW_DIR_ENV,
  V2_SHADOW_EMISSION_ENV,
  v2ShadowStoreStatus
} from "./scan-report-v2-shadow-store";
import { resolveScannerEgressRegion, SCANNER_EGRESS_REGION_ENV } from "./scanner-egress";

const SCANNER_EGRESS_ENV = "SITE_BEHAVIOR_LAB_SCANNER_EGRESS";

// Backend-agnostic public projection: never exposes a filesystem path or an R2
// bucket/endpoint to /api/health, only the backend kind and shared policy.
// "unavailable" = the configured backend could not even be constructed
// (e.g. SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND=r2 with missing credentials).
type PublicReportStoreStatus = {
  kind: ReportStoreKind | "unavailable";
  configuredPath: boolean;
  maxAgeDays: number;
  maxCount: number;
};
type RuntimeStatusAdblockCheck = AdblockEngineStatus;

export type RuntimeStatus = {
  ok: boolean;
  status: "ok" | "degraded";
  timestamp: string;
  /** Full source SHA for production images, otherwise "unknown". */
  deployment: string;
  authenticated: boolean;
  openAccess: boolean;
  turnstile: boolean;
  scansAvailable: boolean;
  checks: {
    adblock: RuntimeStatusAdblockCheck;
    chromiumSandbox: "enabled" | "disabled";
    scanAccess: "configured" | "open";
    dnsRebindingGuard: "connect-time-proxy";
    reportStore: PublicReportStoreStatus;
    scannerEgress: "configured" | "default";
    scannerEgressRegion: "configured" | "unrecorded" | "misconfigured";
    consentVerification: "enabled" | "disabled" | "misconfigured";
    publicR2Reports: Pick<PublicR2ReportsReadiness, "status">;
    v2ShadowEmission: {
      status: "enabled" | "disabled" | "misconfigured";
      backend: "filesystem" | "r2" | "none";
    };
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
  // A misconfigured store backend (e.g. r2 selected with missing credentials)
  // must degrade health, never crash it: /api/health is exactly the endpoint an
  // operator checks when the configuration is broken.
  const store = safeReportStoreStatus();
  const warnings = productionWarnings(store.status);
  const shadow = shadowRuntimeCheck();
  warnings.push(...shadow.warnings);
  const publicR2Config = publicR2ReportsReadiness();
  let publicR2Status = publicR2Config.status;
  if (publicR2Config.status === "misconfigured") {
    warnings.push(...publicR2Config.issues.map((issue) => `Public r2 reports are not ready: ${issue}`));
  }
  if (publicR2Config.status === "enabled" && store.error !== null) {
    publicR2Status = "misconfigured";
    warnings.push("Public r2 reports are not ready because required report persistence is unavailable.");
  }
  const egressRegion = resolveScannerEgressRegion();
  if (egressRegion.status === "misconfigured") {
    warnings.push(
      `${SCANNER_EGRESS_REGION_ENV} must be an r2-safe stable region, or Cloudflare must provide the full region/location/country placement tuple.`
    );
  } else if (publicR2Config.status === "enabled" && egressRegion.status === "unrecorded") {
    warnings.push(
      "Public r2 comparisons cannot emit comparable deltas because the scanner egress region is unrecorded."
    );
  }
  const reportStore = store.public;
  if (store.error !== null) {
    warnings.push(`The report store backend is misconfigured and unavailable: ${store.error}`);
  }
  if (!adblock.active) {
    warnings.push("Brave Shields classification is unavailable; tracker labels use the curated catalog only.");
  }

  return asScanRuntimeHealth({
    ok: true,
    status: warnings.length === 0 ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    deployment: scannerBuildCommit(),
    // The static Pages UI reads these to gate the access-key field and open-access
    // behaviour when it points at this container (Option B two-origin topology).
    // A gated container that omitted `authenticated` would make the UI skip the
    // key it requires, 401-ing every scan. Node has no Turnstile (edge-only).
    authenticated,
    openAccess: !authenticated,
    turnstile: false,
    scansAvailable: publicR2Status !== "misconfigured",
    // Top-level `storage` is the shared-contract field the client status text
    // reads; the Browser Run worker already emits it, and without it here the
    // Node scanner's status line never says where reports live.
    storage: store.public.kind,
    checks: {
      adblock,
      chromiumSandbox: chromiumSandboxEnabled() ? "enabled" : "disabled",
      scanAccess: authenticated ? "configured" : "open",
      dnsRebindingGuard: "connect-time-proxy",
      reportStore,
      scannerEgress: process.env[SCANNER_EGRESS_ENV]?.trim() ? "configured" : "default",
      scannerEgressRegion: egressRegion.status,
      consentVerification: shadow.consentVerification,
      publicR2Reports: { status: publicR2Status },
      v2ShadowEmission: shadow.emission
    },
    capabilities: {
      singleScan: capability.singleScan,
      gpcComparison: capability.gpcComparison,
      // Shields block-simulation needs the Brave ad-block engine; advertise it
      // only when the engine actually loaded so the static UI's toggle reflects
      // real capability instead of enabling a degraded mode.
      shieldsComparison: capability.shieldsComparison && adblock.active,
      consentComparison: capability.consentComparison,
      // A broken store backend cannot save or serve reports; the UI must not
      // offer share links it cannot honor.
      savedReports: store.error === null,
      // The full Next app serves /reports/:id pages, so live-scanned reports have
      // a shareable permalink on this origin.
      savedReportPages: true
    },
    warnings
  });
}

function shadowRuntimeCheck(): {
  consentVerification: "enabled" | "disabled" | "misconfigured";
  emission: RuntimeStatus["checks"]["v2ShadowEmission"];
  warnings: string[];
} {
  const warnings: string[] = [];
  const consentFlag = binaryFlagStatus(process.env[CONSENT_VERIFICATION_ENV]);
  const emissionFlag = binaryFlagStatus(process.env[V2_SHADOW_EMISSION_ENV]);
  const store = v2ShadowStoreStatus();
  const consentVerification = consentFlag;
  let emissionStatus: RuntimeStatus["checks"]["v2ShadowEmission"]["status"] = emissionFlag;

  if (consentFlag === "misconfigured") {
    warnings.push(`${CONSENT_VERIFICATION_ENV} must be 0, 1, or unset.`);
  }
  if (emissionFlag === "misconfigured") {
    warnings.push(`${V2_SHADOW_EMISSION_ENV} must be 0, 1, or unset.`);
  }
  if (emissionFlag === "enabled" && store.error !== null) {
    emissionStatus = "misconfigured";
    warnings.push(`The v2 shadow store is misconfigured and unavailable: ${store.error}`);
  }
  if (emissionFlag === "enabled" && consentFlag === "disabled") {
    warnings.push(
      `${CONSENT_VERIFICATION_ENV} is disabled; observe-mode r2 shadows cannot record the always-on consent detector outcome.`
    );
  }
  if (
    emissionFlag === "enabled" &&
    store.sink === "filesystem" &&
    process.env.NODE_ENV === "production" &&
    !process.env[V2_SHADOW_DIR_ENV]?.trim()
  ) {
    warnings.push("Production filesystem shadow emission requires an explicit writable shadow directory.");
  }

  return {
    consentVerification,
    emission: {
      status: emissionStatus,
      backend: store.sink === "unavailable" ? "none" : store.sink
    },
    warnings
  };
}

function binaryFlagStatus(value: string | undefined): "enabled" | "disabled" | "misconfigured" {
  if (value === undefined || value === "" || value === "0") return "disabled";
  if (value === "1") return "enabled";
  return "misconfigured";
}

type SafeReportStoreStatus = {
  status: ReturnType<typeof reportStoreStatus> | null;
  public: PublicReportStoreStatus;
  error: string | null;
};

function safeReportStoreStatus(): SafeReportStoreStatus {
  try {
    const status = reportStoreStatus();
    return {
      status,
      public: {
        kind: status.kind,
        configuredPath: status.configuredPath,
        maxAgeDays: status.maxAgeDays,
        maxCount: status.maxCount
      },
      error: null
    };
  } catch (error) {
    return {
      status: null,
      public: { kind: "unavailable", configuredPath: false, maxAgeDays: 0, maxCount: 0 },
      error: error instanceof Error ? error.message : "unknown configuration error"
    };
  }
}

function unauthenticatedScansAllowed(): boolean {
  return process.env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS === "1";
}

function scannerBuildCommit(): string {
  return recordedBuildCommit() ?? "unknown";
}

function productionWarnings(reportStore: ReturnType<typeof reportStoreStatus> | null): string[] {
  const warnings: string[] = [];

  // No token means anyone can scan. That is a warning when it looks accidental,
  // but an explicit `ALLOW_UNAUTHENTICATED_SCANS=1` is a deliberate open posture
  // (e.g. the public Containers scanner, gated by Turnstile + rate limiting at
  // the edge), so it should not degrade health.
  if (!scanAccessTokenConfigured() && !unauthenticatedScansAllowed()) {
    warnings.push("SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN is not configured; public visitors can start scans.");
  }

  if (reportStore !== null && !reportStore.configuredPath) {
    warnings.push("SITE_BEHAVIOR_LAB_REPORT_STORE_DIR is not configured; reports use the app working directory.");
  }

  if (!process.env[SCANNER_EGRESS_ENV]?.trim()) {
    warnings.push("SITE_BEHAVIOR_LAB_SCANNER_EGRESS is not configured; reports use the generic scanner egress label.");
  }

  if (process.env.NODE_ENV === "production" && scannerBuildCommit() === "unknown") {
    warnings.push("SITE_BEHAVIOR_LAB_BUILD_COMMIT is missing; this scanner image cannot identify its source revision.");
  }

  return warnings;
}
