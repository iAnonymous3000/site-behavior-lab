import { domainsMatch, type FeaturedSiteConfig } from "./featured-sites";
import { siteProfileKey } from "./site-profile";

/**
 * Small, server-built discovery payload for the homepage. The full report
 * manifest is intentionally not serialized into the initial client page.
 */
export type HomepageReportSource = {
  id: string;
  domain: string;
  headline: string;
  tone: "alarm" | "warn" | "info" | "calm";
  scannedAt: string;
  reportType: "single" | "comparison";
  thirdPartyRequests: number;
  trackerRequests: number;
  requestCapped: boolean;
  requestEvidenceComplete: boolean;
  successfulLoad: boolean;
};

export type HomepageFeaturedCard = {
  id: string;
  domain: string;
  siteLabel: string;
  headline: string;
  tone: HomepageReportSource["tone"];
  scannedAt: string;
  thirdPartyRequests: number;
  trackerRequests: number;
  requestCapped: boolean;
  requestEvidenceComplete: boolean;
};

export type HomepageFeaturedGroup = {
  id: string;
  label: string;
  items: HomepageFeaturedCard[];
};

export type HomepageKnownSite = {
  /** Registrable domain and public site-profile key. */
  domain: string;
  latestReportId: string;
  scannedAt: string;
};

export type HomepageDiscovery = {
  reportCount: number;
  latestReport: HomepageKnownSite | null;
  knownSites: HomepageKnownSite[];
  featuredGroups: HomepageFeaturedGroup[];
};

export const HOMEPAGE_FEATURED_MAX_PER_CATEGORY = 4;
export const HOMEPAGE_FEATURED_MAX_TOTAL = 12;

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function newestFirst(left: HomepageReportSource, right: HomepageReportSource): number {
  return timestamp(right.scannedAt) - timestamp(left.scannedAt) || right.id.localeCompare(left.id);
}

function preferredFeaturedReport(
  reports: HomepageReportSource[],
  featuredDomain: string
): HomepageReportSource | null {
  const matches = reports.filter(
    (report) => report.successfulLoad && domainsMatch(report.domain, featuredDomain)
  );
  if (matches.length === 0) return null;

  // Comparisons make the strongest guided examples; within the same report
  // kind, freshness and then the stable report id decide deterministically.
  return matches.sort((left, right) => {
    const reportTypeRank = Number(right.reportType === "comparison") - Number(left.reportType === "comparison");
    return reportTypeRank || newestFirst(left, right);
  })[0];
}

function toFeaturedCard(
  source: HomepageReportSource,
  siteLabel: string
): HomepageFeaturedCard {
  return {
    id: source.id,
    domain: source.domain,
    siteLabel,
    headline: source.headline,
    tone: source.tone,
    scannedAt: source.scannedAt,
    thirdPartyRequests: source.thirdPartyRequests,
    trackerRequests: source.trackerRequests,
    requestCapped: source.requestCapped,
    requestEvidenceComplete: source.requestEvidenceComplete
  };
}

/**
 * Select one card per populated category before selecting any category's
 * second card. With the current eight categories and twelve-card cap, every
 * category is represented once and four receive a second card.
 */
export function buildHomepageFeaturedGroups(
  config: FeaturedSiteConfig,
  reports: HomepageReportSource[]
): HomepageFeaturedGroup[] {
  const queues = config.categories.map((category) => ({
    id: category.id,
    label: category.label,
    items: config.sites
      .filter((site) => site.category === category.id)
      .map((site) => {
        const report = preferredFeaturedReport(reports, site.domain);
        return report ? toFeaturedCard(report, site.label) : null;
      })
      .filter((item): item is HomepageFeaturedCard => item !== null)
      .slice(0, HOMEPAGE_FEATURED_MAX_PER_CATEGORY)
  }));

  const selected = new Map<string, HomepageFeaturedCard[]>();
  const usedReportIds = new Set<string>();
  let total = 0;

  for (let round = 0; round < HOMEPAGE_FEATURED_MAX_PER_CATEGORY; round += 1) {
    for (const queue of queues) {
      if (total >= HOMEPAGE_FEATURED_MAX_TOTAL) break;
      const item = queue.items[round];
      if (!item || usedReportIds.has(item.id)) continue;
      usedReportIds.add(item.id);
      selected.set(queue.id, [...(selected.get(queue.id) ?? []), item]);
      total += 1;
    }
  }

  return queues.flatMap((queue) => {
    const items = selected.get(queue.id) ?? [];
    return items.length > 0 ? [{ id: queue.id, label: queue.label, items }] : [];
  });
}

export function buildHomepageDiscovery(
  config: FeaturedSiteConfig,
  reports: HomepageReportSource[]
): HomepageDiscovery {
  const successful = reports.filter((report) => report.successfulLoad).sort(newestFirst);
  const newestBySite = new Map<string, HomepageKnownSite>();

  for (const report of successful) {
    const domain = siteProfileKey(report.domain);
    if (!domain || newestBySite.has(domain)) continue;
    newestBySite.set(domain, {
      domain,
      latestReportId: report.id,
      scannedAt: report.scannedAt
    });
  }

  const knownSites = [...newestBySite.values()].sort((left, right) => left.domain.localeCompare(right.domain));
  const newestReport = successful[0];
  const latestDomain = newestReport ? siteProfileKey(newestReport.domain) : null;

  return {
    reportCount: reports.length,
    latestReport:
      newestReport && latestDomain
        ? { domain: latestDomain, latestReportId: newestReport.id, scannedAt: newestReport.scannedAt }
        : null,
    knownSites,
    featuredGroups: buildHomepageFeaturedGroups(config, reports)
  };
}
