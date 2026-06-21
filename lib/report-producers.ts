export type ReportProducerCapability = {
  producer: "node" | "cloudflare-worker" | "pagegraph";
  runtime: string;
  emitsScanReport: boolean;
  singleScan: boolean;
  gpcComparison: boolean;
  shieldsComparison: boolean;
  asyncJobs: boolean;
  dnsGuard: "node-connect-time-proxy" | "edge-doh-preflight-only" | "source-artifact";
  trackerCatalog: "hand-curated-service-catalog" | "none" | "provided-or-hand-curated";
  reportStore: "filesystem" | "kv-or-r2" | "caller-managed";
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
    asyncJobs: true,
    dnsGuard: "node-connect-time-proxy",
    trackerCatalog: "hand-curated-service-catalog",
    reportStore: "filesystem"
  },
  {
    producer: "cloudflare-worker",
    runtime: "Cloudflare Worker / Browser Run",
    emitsScanReport: true,
    singleScan: true,
    gpcComparison: true,
    shieldsComparison: false,
    asyncJobs: false,
    dnsGuard: "edge-doh-preflight-only",
    trackerCatalog: "none",
    reportStore: "kv-or-r2"
  },
  {
    producer: "pagegraph",
    runtime: "Brave PageGraph adapter",
    emitsScanReport: true,
    singleScan: true,
    gpcComparison: false,
    shieldsComparison: false,
    asyncJobs: false,
    dnsGuard: "source-artifact",
    trackerCatalog: "provided-or-hand-curated",
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
