export type CatalogEntityReference = {
  kind: "official";
  title: string;
  url: string;
};

export type CatalogProvenance = {
  status: "maintainer-reviewed";
  reviewedAt: string;
  reviewer: string;
  relationship: "entity or product identity reference only";
  categoryRationale: string;
  entityReferences: readonly CatalogEntityReference[];
  limitations: string;
};

type EntitySource = {
  title: string;
  url: string;
  reviewedAt?: string;
};

export const TRACKER_CATALOG_REVIEW_VERSION = "catalog-review-v3";
/** Release date for this reviewed-catalog revision and its newly added sources. */
export const TRACKER_CATALOG_REVIEW_DATE = "2026-08-01";
/* Earlier revisions' entries keep the date they were actually reviewed on:
   bumping the revision must never silently re-date an existing review. */
const CATALOG_REVIEW_V2_DATE = "2026-07-28";
const PRIOR_CATALOG_ENTRY_REVIEW_DATE = "2026-07-21";

/*
 * Public, first-party references for every named entity in the hand-curated
 * catalog. A reference identifies the displayed entity or product; it does
 * not necessarily list every catalog suffix or substantiate the maintainer's
 * functional category. These are not imported blocklists and do not turn a
 * domain match into a verdict about a request.
 *
 * The source is deliberately keyed by the displayed entity rather than a
 * domain. One entity can own several service domains, while the effective
 * domain list remains canonical in tracker-catalog.ts.
 */
const ENTITY_SOURCES: Readonly<Record<string, EntitySource>> = {
  "AdRoll": { title: "AdRoll", url: "https://www.adroll.com/" },
  "Adobe": { title: "Adobe Analytics", url: "https://business.adobe.com/products/adobe-analytics.html" },
  "Amazon Ads": { title: "Amazon Ads", url: "https://advertising.amazon.com/" },
  "Amplitude": { title: "Amplitude", url: "https://amplitude.com/" },
  "Braze": { title: "Braze", url: "https://www.braze.com/" },
  "Bugsnag": { title: "Bugsnag", url: "https://www.bugsnag.com/" },
  "Chartbeat": { title: "Chartbeat", url: "https://chartbeat.com/" },
  "Cloudflare": {
    title: "Cloudflare Web Analytics",
    url: "https://www.cloudflare.com/web-analytics/",
    reviewedAt: TRACKER_CATALOG_REVIEW_DATE
  },
  "Comscore": { title: "Comscore", url: "https://www.comscore.com/" },
  "Contentsquare": { title: "Contentsquare", url: "https://contentsquare.com/" },
  "Crazy Egg": { title: "Crazy Egg", url: "https://www.crazyegg.com/" },
  "Criteo": { title: "Criteo", url: "https://www.criteo.com/" },
  "Datadog": { title: "Datadog", url: "https://www.datadoghq.com/" },
  "DoubleVerify": {
    title: "DoubleVerify company overview",
    url: "https://doubleverify.com/company/about",
    reviewedAt: CATALOG_REVIEW_V2_DATE
  },
  "Drift": { title: "Drift", url: "https://www.drift.com/" },
  "Equativ": {
    title: "Equativ Smart AdServer ads.txt implementation",
    url: "https://help.equativ.com/implement-adstxt-specification",
    reviewedAt: CATALOG_REVIEW_V2_DATE
  },
  "Fathom": { title: "Fathom Analytics", url: "https://usefathom.com/" },
  "FullStory": { title: "Fullstory", url: "https://www.fullstory.com/" },
  "Google": { title: "Google Analytics", url: "https://marketingplatform.google.com/about/analytics/" },
  "Heap": { title: "Heap", url: "https://www.heap.io/" },
  "Hotjar": { title: "Hotjar", url: "https://www.hotjar.com/" },
  "HubSpot": { title: "HubSpot Marketing Hub", url: "https://www.hubspot.com/products/marketing" },
  "HUMAN Security": {
    title: "HUMAN Sensor CSP requirements",
    url: "https://docs.humansecurity.com/docs/sensor",
    reviewedAt: TRACKER_CATALOG_REVIEW_DATE
  },
  "Index Exchange": { title: "Index Exchange", url: "https://www.indexexchange.com/" },
  "Inspectlet": { title: "Inspectlet", url: "https://www.inspectlet.com/" },
  "Intercom": { title: "Intercom", url: "https://www.intercom.com/" },
  "Klaviyo": { title: "Klaviyo", url: "https://www.klaviyo.com/" },
  "LinkedIn": { title: "LinkedIn Insight Tag", url: "https://business.linkedin.com/marketing-solutions/insight-tag" },
  "LiveRamp": { title: "LiveRamp", url: "https://liveramp.com/" },
  "LogRocket": { title: "LogRocket", url: "https://logrocket.com/" },
  "Lotame": { title: "Lotame", url: "https://www.lotame.com/" },
  "Lucky Orange": { title: "Lucky Orange", url: "https://www.luckyorange.com/" },
  "Magnite": { title: "Magnite", url: "https://www.magnite.com/" },
  "Mailchimp": { title: "Mailchimp", url: "https://mailchimp.com/" },
  "Marketo": { title: "Adobe Marketo Engage", url: "https://business.adobe.com/products/marketo/adobe-marketo.html" },
  "Matomo": { title: "Matomo", url: "https://matomo.org/" },
  "Media.net": { title: "Media.net", url: "https://www.media.net/" },
  "Meta": { title: "Meta Pixel", url: "https://www.facebook.com/business/tools/meta-pixel" },
  "Microsoft": { title: "Microsoft Advertising", url: "https://about.ads.microsoft.com/" },
  "Microsoft Azure": {
    title: "Azure Content Delivery Network overview",
    url: "https://learn.microsoft.com/en-us/azure/cdn/cdn-overview",
    reviewedAt: TRACKER_CATALOG_REVIEW_DATE
  },
  "Microsoft Clarity": { title: "Microsoft Clarity", url: "https://clarity.microsoft.com/" },
  "Mixpanel": { title: "Mixpanel", url: "https://mixpanel.com/" },
  "Mouseflow": { title: "Mouseflow", url: "https://mouseflow.com/" },
  "New Relic": { title: "New Relic", url: "https://newrelic.com/" },
  "Nielsen": { title: "Nielsen", url: "https://www.nielsen.com/" },
  "OpenX": { title: "OpenX", url: "https://www.openx.com/" },
  "Optimizely": { title: "Optimizely", url: "https://www.optimizely.com/" },
  "Oracle Advertising": { title: "Oracle Advertising", url: "https://www.oracle.com/advertising/" },
  "Outbrain": { title: "Outbrain", url: "https://www.outbrain.com/" },
  "Parse.ly": { title: "Parse.ly", url: "https://www.parse.ly/" },
  "Pinterest": { title: "Pinterest Business", url: "https://business.pinterest.com/" },
  "Plausible": { title: "Plausible Analytics", url: "https://plausible.io/" },
  "PostHog": { title: "PostHog", url: "https://posthog.com/" },
  "PubMatic": { title: "PubMatic", url: "https://pubmatic.com/" },
  "Quantcast": { title: "Quantcast", url: "https://www.quantcast.com/" },
  "Quantum Metric": { title: "Quantum Metric", url: "https://www.quantummetric.com/" },
  "Salesforce": { title: "Salesforce Marketing", url: "https://www.salesforce.com/marketing/" },
  "Sentry": { title: "Sentry", url: "https://sentry.io/" },
  "SessionCam": { title: "SessionCam", url: "https://www.sessioncam.com/" },
  "Smartlook": { title: "Smartlook", url: "https://www.smartlook.com/" },
  "Snowplow": { title: "Snowplow", url: "https://snowplow.io/" },
  "Sovrn": { title: "Sovrn", url: "https://www.sovrn.com/" },
  "StackAdapt": {
    title: "StackAdapt platform",
    url: "https://www.stackadapt.com/platform",
    reviewedAt: CATALOG_REVIEW_V2_DATE
  },
  "Statsig": { title: "Statsig", url: "https://www.statsig.com/" },
  "Taboola": { title: "Taboola", url: "https://www.taboola.com/" },
  "Tealium": {
    title: "Tealium content security policy reference",
    url: "https://docs.tealium.com/server-side/settings/tealium-content-security-policies-reference-guide/",
    reviewedAt: TRACKER_CATALOG_REVIEW_DATE
  },
  "The Trade Desk": { title: "The Trade Desk", url: "https://www.thetradedesk.com/" },
  "TikTok": { title: "TikTok Pixel", url: "https://ads.tiktok.com/business/en-US/solutions/tiktok-pixel" },
  "TripleLift": {
    title: "TripleLift advertising technology platform cookie notice",
    url: "https://triplelift.com/advertising-technology-platform-cookie-notice/",
    reviewedAt: CATALOG_REVIEW_V2_DATE
  },
  "Twilio Segment": { title: "Twilio Segment", url: "https://segment.com/" },
  "VWO": { title: "VWO", url: "https://vwo.com/" },
  "X": { title: "X conversion tracking", url: "https://business.x.com/en/help/campaign-measurement-and-analytics/conversion-tracking-for-websites" },
  "Yahoo Advertising": { title: "Yahoo Advertising", url: "https://www.yahooinc.com/advertising" },
  "Zendesk": { title: "Zendesk", url: "https://www.zendesk.com/" }
};

export function catalogProvenanceFor(entity: string, category: string): CatalogProvenance | null {
  const source = ENTITY_SOURCES[entity];
  if (!source) return null;

  return {
    status: "maintainer-reviewed",
    reviewedAt: source.reviewedAt ?? PRIOR_CATALOG_ENTRY_REVIEW_DATE,
    reviewer: "Site Behavior Lab maintainers",
    relationship: "entity or product identity reference only",
    categoryRationale:
      `The “${category}” label is a functional maintainer classification; the cited entity reference is not asserted to substantiate that category.`,
    entityReferences: [{ kind: "official", title: source.title, url: source.url }],
    limitations:
      "The official reference identifies the named entity or product. It may not list this suffix, prove the domain mapping, or support the functional category. A match also does not prove an individual request's purpose, data use, or legal status."
  };
}
