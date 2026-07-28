/**
 * Consent Management Platform (CMP) detection.
 *
 * A request to a known CMP loader host proves only that consent tooling loaded;
 * it does not prove a banner was visibly shown. In observe mode the scanner
 * makes no consent choice, so this module can identify tooling and the finding
 * layer can describe what loaded before that choice boundary. Neither layer
 * decides whether a request required consent or whether behavior complied with
 * applicable law, and more trackers may load after an "Accept" interaction.
 *
 * Pure (types only) so it runs anywhere. The list is curated and unambiguous:
 * each host is a dedicated consent platform, not a dual-use analytics domain.
 */

export type ConsentPlatform = {
  /** Human name of the consent management platform. */
  name: string;
  /** The request domain that revealed it. */
  domain: string;
};

const CMP_SIGNATURES: { name: string; suffixes: string[] }[] = [
  { name: "OneTrust", suffixes: ["cookielaw.org", "onetrust.com", "cookiepro.com"] },
  { name: "Cookiebot", suffixes: ["cookiebot.com", "cookiebot.eu"] },
  { name: "Sourcepoint", suffixes: ["sp-prod.net", "sourcepoint.com"] },
  { name: "Didomi", suffixes: ["didomi.io"] },
  { name: "Usercentrics", suffixes: ["usercentrics.eu", "usercentrics.com"] },
  { name: "TrustArc", suffixes: ["trustarc.com", "truste.com"] },
  { name: "CookieYes", suffixes: ["cookieyes.com"] },
  { name: "Osano", suffixes: ["osano.com"] },
  { name: "Termly", suffixes: ["termly.io"] },
  { name: "Iubenda", suffixes: ["iubenda.com"] },
  { name: "Cookie Information", suffixes: ["cookieinformation.com"] },
  { name: "Complianz", suffixes: ["complianz.io"] },
  // Generic IAB TCF endpoint, used by many CMPs registered with the framework.
  { name: "IAB TCF", suffixes: ["consensu.org"] }
];

/**
 * Name the consent platform a single request domain belongs to, or null.
 *
 * These signatures are the only place the report can name a CMP host, so any
 * surface that asks "could this scan identify this domain?" must consult them.
 * The service catalog deliberately does not carry CMP loaders (they are not
 * tracking services and must not enter tracker counts), which means a report
 * that consulted only the catalog would name OneTrust in its consent card and
 * simultaneously claim it could not identify that same domain.
 */
export function consentPlatformForDomain(domain: string): string | null {
  const host = domain.trim().toLowerCase().replace(/\.$/, "");
  for (const signature of CMP_SIGNATURES) {
    if (signature.suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      return signature.name;
    }
  }
  return null;
}

/** Name the consent platform from the page's request domains, or null if none matched. */
export function detectConsentPlatform(domains: { domain: string }[]): ConsentPlatform | null {
  // Signature-major order: the first signature with any matching domain wins,
  // so the reported platform does not depend on request ordering.
  for (const signature of CMP_SIGNATURES) {
    for (const entry of domains) {
      if (consentPlatformForDomain(entry.domain) === signature.name) {
        return { name: signature.name, domain: entry.domain };
      }
    }
  }
  return null;
}
