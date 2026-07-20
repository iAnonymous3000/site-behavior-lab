export type ReportProducerCapability = {
  producer: "node" | "cloudflare-worker" | "pagegraph";
  runtime: string;
  emitsScanReport: boolean;
  singleScan: boolean;
  gpcComparison: boolean;
  shieldsComparison: boolean;
  consentComparison: boolean;
  asyncJobs: boolean;
  dnsGuard: "node-connect-time-proxy" | "edge-doh-preflight-only" | "not-applicable-local-artifact";
  trackerCatalog: "hand-curated-service-catalog" | "none";
  reportStore: "filesystem-or-r2" | "kv-or-r2" | "caller-managed";
};

export type ReportProducerId = ReportProducerCapability["producer"];

export const REPORT_PRODUCER_CAPABILITIES: readonly ReportProducerCapability[] = [
  {
    producer: "node",
    runtime: "Next.js / Playwright Chromium",
    emitsScanReport: true,
    singleScan: true,
    gpcComparison: true,
    shieldsComparison: true,
    consentComparison: true,
    asyncJobs: true,
    dnsGuard: "node-connect-time-proxy",
    trackerCatalog: "hand-curated-service-catalog",
    reportStore: "filesystem-or-r2"
  },
  {
    producer: "cloudflare-worker",
    runtime: "Cloudflare Worker / Browser Run",
    emitsScanReport: true,
    singleScan: true,
    gpcComparison: true,
    shieldsComparison: false,
    consentComparison: false,
    asyncJobs: false,
    dnsGuard: "edge-doh-preflight-only",
    trackerCatalog: "none",
    reportStore: "kv-or-r2"
  },
  {
    producer: "pagegraph",
    runtime: "Paired GraphML + sidecar r2 import",
    emitsScanReport: true,
    singleScan: true,
    gpcComparison: false,
    shieldsComparison: false,
    consentComparison: false,
    asyncJobs: false,
    dnsGuard: "not-applicable-local-artifact",
    trackerCatalog: "hand-curated-service-catalog",
    reportStore: "caller-managed"
  }
] as const;

/** Authoritative capability row for a producer; the source of truth for runtime health and UI gating. */
export function producerCapability(producer: ReportProducerId): ReportProducerCapability {
  const capability = REPORT_PRODUCER_CAPABILITIES.find((entry) => entry.producer === producer);
  if (!capability) {
    throw new Error(`Unknown report producer: ${producer}`);
  }
  return capability;
}
