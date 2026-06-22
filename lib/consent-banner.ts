/**
 * Consent Management Platform (CMP) detection.
 *
 * A request to a known CMP loader host means the page showed a cookie/consent
 * banner. Because the scanner never clicks the banner, everything it observed is
 * the *pre-consent* state: any tracker seen loaded before consent was given
 * (often not permitted under GDPR/ePrivacy), and more trackers may load after
 * "Accept" that this report does not capture. This module just names the CMP
 * from the request log; the finding layer turns that into the pre-consent story.
 *
 * Pure (types only) so it runs anywhere. The list is curated and unambiguous —
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

/** Name the consent platform from the page's request domains, or null if none matched. */
export function detectConsentPlatform(domains: { domain: string }[]): ConsentPlatform | null {
  for (const signature of CMP_SIGNATURES) {
    for (const entry of domains) {
      const host = entry.domain.trim().toLowerCase().replace(/\.$/, "");
      if (signature.suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
        return { name: signature.name, domain: entry.domain };
      }
    }
  }
  return null;
}
