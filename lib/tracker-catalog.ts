import type { TrackerMatch } from "./types";
import { sha256Hex } from "./sha256";
import {
  TRACKER_CATALOG_REVIEW_VERSION,
  catalogProvenanceFor,
  type CatalogProvenance
} from "./tracker-catalog-provenance";

type CatalogEntry = {
  suffixes: string[];
  entity: string;
  category: string;
};

type IndexedCatalogEntry = {
  domain: string;
  entity: string;
  category: string;
  confidence: TrackerMatch["confidence"];
  prevalence?: number;
  fingerprinting?: number;
  cookiePrevalence?: number;
};

type CanonicalCatalogEntry = {
  domain: string;
  entity: string;
  category: string;
  confidence: TrackerMatch["confidence"];
  prevalence: number | null;
  fingerprinting: number | null;
  cookiePrevalence: number | null;
};

export type TrackerCatalogRecord = {
  domain: string;
  entity: string;
  category: string;
  confidence: TrackerMatch["confidence"];
  provenance: CatalogProvenance;
};

/*
 * Hand-curated tracker/service seed catalog.
 *
 * Hand-curated, in-repo list of high-prevalence third-party services, no
 * third-party (competitor) dataset and no NonCommercial license. Brave
 * ad-block lists are used separately for the Shields filter-list-match and
 * block-simulation signals, not for these service/entity labels.
 */
const catalog: CatalogEntry[] = [
  {
    suffixes: ["analytics.google.com", "google-analytics.com", "googletagmanager.com"],
    entity: "Google",
    category: "analytics / tag management"
  },
  {
    suffixes: ["adservice.google.com", "doubleclick.net", "googleadservices.com", "googlesyndication.com"],
    entity: "Google",
    category: "advertising"
  },
  {
    suffixes: ["connect.facebook.net", "facebook.com", "facebook.net"],
    entity: "Meta",
    category: "social / advertising pixel"
  },
  {
    suffixes: ["analytics.tiktok.com", "business-api.tiktok.com", "tiktok.com"],
    entity: "TikTok",
    category: "social / advertising pixel"
  },
  {
    suffixes: ["ads-twitter.com", "t.co", "twitter.com", "x.com"],
    entity: "X",
    category: "social / advertising pixel"
  },
  {
    suffixes: ["hotjar.com", "hotjar.io"],
    entity: "Hotjar",
    category: "session replay / behavior analytics"
  },
  {
    suffixes: ["fullstory.com", "fullstorydev.com"],
    entity: "FullStory",
    category: "session replay"
  },
  {
    suffixes: ["logrocket.com", "lr-ingest.com"],
    entity: "LogRocket",
    category: "session replay / product analytics"
  },
  {
    suffixes: ["segment.com", "segment.io"],
    entity: "Twilio Segment",
    category: "customer data platform"
  },
  {
    suffixes: ["amplitude.com", "amplitudeexperiment.com"],
    entity: "Amplitude",
    category: "product analytics"
  },
  {
    suffixes: ["mixpanel.com"],
    entity: "Mixpanel",
    category: "product analytics"
  },
  {
    suffixes: ["clarity.ms"],
    entity: "Microsoft Clarity",
    category: "session replay / behavior analytics"
  },
  {
    suffixes: ["bat.bing.com", "bing.com"],
    entity: "Microsoft",
    category: "advertising / analytics"
  },
  {
    suffixes: ["ads.linkedin.com", "linkedin.com", "licdn.com", "snap.licdn.com"],
    entity: "LinkedIn",
    category: "social / advertising pixel"
  },
  {
    suffixes: ["quantcount.com", "quantserve.com"],
    entity: "Quantcast",
    category: "advertising / measurement"
  },
  {
    suffixes: ["scorecardresearch.com"],
    entity: "Comscore",
    category: "audience measurement"
  },
  {
    suffixes: ["criteo.com", "criteo.net"],
    entity: "Criteo",
    category: "advertising"
  },
  {
    suffixes: ["taboola.com", "taboolasyndication.com"],
    entity: "Taboola",
    category: "advertising / recommendations"
  },
  {
    suffixes: ["outbrain.com", "outbrainimg.com"],
    entity: "Outbrain",
    category: "advertising / recommendations"
  },
  {
    suffixes: ["adsrvr.org", "thetradedesk.com"],
    entity: "The Trade Desk",
    category: "advertising / demand-side platform"
  },
  {
    suffixes: ["stackadapt.com"],
    entity: "StackAdapt",
    category: "advertising / demand-side platform"
  },
  {
    suffixes: ["liveramp.com", "rlcdn.com"],
    entity: "LiveRamp",
    category: "identity / advertising"
  },
  {
    suffixes: ["adobedtm.com", "demdex.net", "omtrdc.net"],
    entity: "Adobe",
    category: "analytics / advertising"
  },
  {
    suffixes: ["amazon-adsystem.com", "assoc-amazon.com"],
    entity: "Amazon Ads",
    category: "advertising"
  },
  {
    suffixes: ["magnite.com", "rubicon.com", "rubiconproject.com"],
    entity: "Magnite",
    category: "advertising / supply-side platform"
  },
  {
    suffixes: ["pubmatic.com"],
    entity: "PubMatic",
    category: "advertising / supply-side platform"
  },
  {
    suffixes: ["3lift.com"],
    entity: "TripleLift",
    category: "advertising / supply-side platform"
  },
  {
    suffixes: ["smartadserver.com"],
    entity: "Equativ",
    category: "advertising / supply-side platform"
  },
  {
    suffixes: ["openx.com", "openx.net"],
    entity: "OpenX",
    category: "advertising / exchange"
  },
  {
    suffixes: ["casalemedia.com", "indexexchange.com"],
    entity: "Index Exchange",
    category: "advertising / exchange"
  },
  {
    suffixes: ["media.net"],
    entity: "Media.net",
    category: "advertising"
  },
  {
    suffixes: ["adtech.de", "adtechus.com", "advertising.com", "gemini.yahoo.com"],
    entity: "Yahoo Advertising",
    category: "advertising"
  },
  {
    suffixes: ["addthis.com", "bkrtx.com", "bluekai.com", "eloqua.com"],
    entity: "Oracle Advertising",
    category: "advertising / marketing data"
  },
  {
    suffixes: ["krxd.net", "pardot.com"],
    entity: "Salesforce",
    category: "marketing automation / analytics"
  },
  {
    suffixes: ["snowplowanalytics.com"],
    entity: "Snowplow",
    category: "event analytics"
  },
  {
    suffixes: ["matomo.cloud", "matomo.org"],
    entity: "Matomo",
    category: "analytics"
  },
  {
    suffixes: ["plausible.io"],
    entity: "Plausible",
    category: "analytics"
  },
  {
    suffixes: ["usefathom.com"],
    entity: "Fathom",
    category: "analytics"
  },
  {
    suffixes: ["heap.io", "heapanalytics.com"],
    entity: "Heap",
    category: "product analytics"
  },
  {
    suffixes: ["posthog.com"],
    entity: "PostHog",
    category: "product analytics"
  },
  {
    suffixes: ["statsig.com", "statsigapi.net"],
    entity: "Statsig",
    category: "experimentation / product analytics"
  },
  {
    suffixes: ["optimizely.com", "optimizelyedge.com"],
    entity: "Optimizely",
    category: "experimentation"
  },
  {
    suffixes: ["visualwebsiteoptimizer.com", "vwo.com"],
    entity: "VWO",
    category: "experimentation / behavior analytics"
  },
  {
    suffixes: ["crazyegg.com"],
    entity: "Crazy Egg",
    category: "session replay / behavior analytics"
  },
  {
    suffixes: ["smartlook.com", "smartlook.cloud"],
    entity: "Smartlook",
    category: "session replay / behavior analytics"
  },
  {
    suffixes: ["inspectlet.com"],
    entity: "Inspectlet",
    category: "session replay / behavior analytics"
  },
  {
    suffixes: ["luckyorange.com"],
    entity: "Lucky Orange",
    category: "session replay / behavior analytics"
  },
  {
    suffixes: ["sessioncam.com"],
    entity: "SessionCam",
    category: "session replay / behavior analytics"
  },
  {
    suffixes: ["mouseflow.com"],
    entity: "Mouseflow",
    category: "session replay / behavior analytics"
  },
  {
    suffixes: ["contentsquare.com", "contentsquare.net"],
    entity: "Contentsquare",
    category: "session replay / behavior analytics"
  },
  {
    suffixes: ["quantummetric.com"],
    entity: "Quantum Metric",
    category: "session replay / product analytics"
  },
  {
    suffixes: ["newrelic.com", "nr-data.net"],
    entity: "New Relic",
    category: "performance monitoring"
  },
  {
    suffixes: ["sentry.io"],
    entity: "Sentry",
    category: "error monitoring"
  },
  {
    suffixes: ["datadoghq-browser-agent.com", "datadoghq.com"],
    entity: "Datadog",
    category: "performance monitoring"
  },
  {
    suffixes: ["bugsnag.com"],
    entity: "Bugsnag",
    category: "error monitoring"
  },
  {
    suffixes: ["intercom.io", "intercomcdn.com"],
    entity: "Intercom",
    category: "customer messaging"
  },
  {
    suffixes: ["drift.com", "driftcdn.com"],
    entity: "Drift",
    category: "customer messaging / marketing"
  },
  {
    suffixes: ["zdassets.com", "zendesk.com"],
    entity: "Zendesk",
    category: "customer support"
  },
  {
    suffixes: ["hs-analytics.net", "hs-scripts.com", "hubspot.com"],
    entity: "HubSpot",
    category: "marketing automation / analytics"
  },
  {
    suffixes: ["marketo.com", "marketo.net"],
    entity: "Marketo",
    category: "marketing automation"
  },
  {
    suffixes: ["klaviyo.com"],
    entity: "Klaviyo",
    category: "marketing automation"
  },
  {
    suffixes: ["list-manage.com", "mailchimp.com"],
    entity: "Mailchimp",
    category: "email marketing"
  },
  {
    suffixes: ["appboy.com", "braze.com", "braze.eu"],
    entity: "Braze",
    category: "customer engagement"
  },
  {
    suffixes: ["tealium.com", "tealiumiq.com"],
    entity: "Tealium",
    category: "tag management / customer data"
  },
  {
    suffixes: ["chartbeat.com", "chartbeat.net"],
    entity: "Chartbeat",
    category: "audience analytics"
  },
  {
    suffixes: ["parsely.com"],
    entity: "Parse.ly",
    category: "audience analytics"
  },
  {
    suffixes: ["imrworldwide.com", "nielsen.com"],
    entity: "Nielsen",
    category: "audience measurement"
  },
  {
    suffixes: ["doubleverify.com"],
    entity: "DoubleVerify",
    category: "advertising measurement / verification"
  },
  {
    suffixes: ["crwdcntrl.net", "lotame.com"],
    entity: "Lotame",
    category: "advertising / data management"
  },
  {
    suffixes: ["ct.pinterest.com", "pinterest.com"],
    entity: "Pinterest",
    category: "social / advertising pixel"
  },
  {
    suffixes: ["adroll.com"],
    entity: "AdRoll",
    category: "advertising / retargeting"
  },
  {
    suffixes: ["lijit.com", "sovrn.com"],
    entity: "Sovrn",
    category: "advertising / publisher monetization"
  }
];

const catalogIndex = buildCatalogIndex();
const curatedOverrideCount = catalog.reduce((total, entry) => total + entry.suffixes.length, 0);
const reviewedCatalogRecords = buildReviewedCatalogRecords();
const catalogValidationIssues = validateTrackerCatalogRecords(reviewedCatalogRecords);

if (catalogValidationIssues.length > 0) {
  throw new Error(`Invalid tracker catalog provenance:\n${catalogValidationIssues.join("\n")}`);
}

export const trackerCatalogMetadata = {
  source: "Hand-curated service catalog",
  version: "hand-curated-2026.07",
  region: "US-biased",
  entries: curatedOverrideCount,
  curatedOverrides: curatedOverrideCount,
  license: "AGPL-3.0-or-later",
  provenanceVersion: TRACKER_CATALOG_REVIEW_VERSION,
  reviewedEntries: reviewedCatalogRecords.length,
  provenanceDigest: sha256Hex(canonicalTrackerCatalogProvenanceContents()),
  // SHA-256 of canonicalTrackerCatalogContents(). Kept as a checked-in
  // constant so this shared Node/Cloudflare module does not require a
  // runtime-specific crypto API merely to expose immutable build metadata.
  digest: "7cade02ae20c3bb88e28e0de1135ef63c48f586e7196de3c02c13478f70c95bc"
};

/**
 * Canonical representation of the effective catalog (after normalization and
 * duplicate resolution). Domain order and explicit nulls make the digest
 * stable across source formatting, insertion order, and JSON serializers.
 */
export function canonicalTrackerCatalogContents(): string {
  const entries: CanonicalCatalogEntry[] = [...catalogIndex.values()]
    .map((entry) => ({
      domain: entry.domain,
      entity: entry.entity,
      category: entry.category,
      confidence: entry.confidence,
      prevalence: entry.prevalence ?? null,
      fingerprinting: entry.fingerprinting ?? null,
      cookiePrevalence: entry.cookiePrevalence ?? null
    }))
    .sort((left, right) => left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0);

  return JSON.stringify(entries);
}

/**
 * Review metadata is versioned and digested separately so adding references
 * does not change the detector-facing effective-catalog digest embedded in
 * existing reports.
 */
export function canonicalTrackerCatalogProvenanceContents(): string {
  return JSON.stringify(reviewedCatalogRecords);
}

/** Return detached records for the public catalog UI and data consumers. */
export function trackerCatalogRecords(): TrackerCatalogRecord[] {
  return reviewedCatalogRecords.map((record) => ({
    ...record,
    provenance: {
      ...record.provenance,
      entityReferences: record.provenance.entityReferences.map((reference) => ({ ...reference }))
    }
  }));
}

/**
 * CI-facing validator. It intentionally checks only mechanically enforceable
 * review rules. Entity references do not claim source support for each domain
 * suffix or maintainer-assigned functional category.
 */
export function validateTrackerCatalogRecords(records: readonly TrackerCatalogRecord[]): string[] {
  const issues: string[] = [];
  const seenDomains = new Set<string>();

  for (const [index, record] of records.entries()) {
    const label = record.domain || `record ${index + 1}`;
    if (!normalizeDomain(record.domain) || normalizeDomain(record.domain) !== record.domain) {
      issues.push(`${label}: domain must be a normalized hostname`);
    }
    if (seenDomains.has(record.domain)) issues.push(`${label}: duplicate domain`);
    seenDomains.add(record.domain);
    if (!record.entity.trim()) issues.push(`${label}: entity is required`);
    if (!record.category.trim()) issues.push(`${label}: category is required`);
    if (record.confidence !== "curated") issues.push(`${label}: catalog confidence must be curated`);

    const provenance = record.provenance;
    if (!provenance || provenance.status !== "maintainer-reviewed") {
      issues.push(`${label}: maintainer review provenance is required`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(provenance.reviewedAt)) {
      issues.push(`${label}: reviewedAt must use YYYY-MM-DD`);
    }
    if (!provenance.reviewer.trim()) issues.push(`${label}: reviewer is required`);
    if (!provenance.categoryRationale.trim()) issues.push(`${label}: category rationale is required`);
    if (!provenance.limitations.trim()) issues.push(`${label}: limitations are required`);
    if (provenance.entityReferences.length === 0) {
      issues.push(`${label}: at least one entity reference is required`);
    }
    for (const [referenceIndex, reference] of provenance.entityReferences.entries()) {
      if (!reference.title.trim()) issues.push(`${label}: entity reference ${referenceIndex + 1} needs a title`);
      try {
        const url = new URL(reference.url);
        if (url.protocol !== "https:") issues.push(`${label}: entity reference ${referenceIndex + 1} must use HTTPS`);
        if (url.username || url.password) issues.push(`${label}: entity reference ${referenceIndex + 1} must not include credentials`);
      } catch {
        issues.push(`${label}: entity reference ${referenceIndex + 1} must be an absolute URL`);
      }
    }
  }

  return issues;
}

export function findTrackerMatch(domain: string): TrackerMatch | null {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;
  const match = findIndexedMatch(normalized);
  if (!match) return null;

  const result: TrackerMatch = {
    domain: match.domain,
    entity: match.entity,
    category: match.category,
    confidence: match.confidence
  };

  if (match.prevalence !== undefined) result.prevalence = match.prevalence;
  if (match.fingerprinting !== undefined) result.fingerprinting = match.fingerprinting;
  if (match.cookiePrevalence !== undefined) result.cookiePrevalence = match.cookiePrevalence;

  return result;
}

function buildCatalogIndex(): Map<string, IndexedCatalogEntry> {
  const index = new Map<string, IndexedCatalogEntry>();

  for (const entry of catalog) {
    for (const suffix of entry.suffixes) {
      const normalized = normalizeDomain(suffix);
      if (!normalized) continue;
      index.set(normalized, {
        domain: normalized,
        entity: entry.entity,
        category: entry.category,
        confidence: "curated"
      });
    }
  }

  return index;
}

function buildReviewedCatalogRecords(): TrackerCatalogRecord[] {
  return [...catalogIndex.values()]
    .map((entry) => {
      const provenance = catalogProvenanceFor(entry.entity, entry.category);
      if (!provenance) {
        throw new Error(`Tracker catalog entry for ${entry.domain} (${entry.entity}) has no entity reference.`);
      }
      return {
        domain: entry.domain,
        entity: entry.entity,
        category: entry.category,
        confidence: entry.confidence,
        provenance
      };
    })
    .sort((left, right) => left.domain.localeCompare(right.domain));
}

function findIndexedMatch(domain: string): IndexedCatalogEntry | null {
  let candidate = normalizeDomain(domain);
  while (candidate) {
    const match = catalogIndex.get(candidate);
    if (match) return match;

    const dotIndex = candidate.indexOf(".");
    if (dotIndex < 0) return null;
    candidate = candidate.slice(dotIndex + 1);
  }

  return null;
}

function normalizeDomain(domain: string): string | null {
  const normalized = domain.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  if (!isValidHostname(normalized)) return null;
  return normalized;
}

function isValidHostname(domain: string): boolean {
  if (!domain || domain.length > 253) return false;
  if (!/^[a-z0-9.-]+$/.test(domain)) return false;

  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63)) return false;

  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}
