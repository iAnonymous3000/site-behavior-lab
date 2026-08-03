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
 * each host is dedicated consent tooling, not a dual-use analytics domain.
 * Most entries name the vendor that operates the host; a framework-endpoint
 * entry names the shared standard the host serves, not who ran it.
 */

/**
 * What the signature's name refers to. A "vendor" name identifies the company
 * that operates the consent tooling. A "framework-endpoint" name identifies a
 * standard's shared host (for example *.consensu.org, delegated to the many
 * CMPs registered with IAB TCF), so it names the framework a host serves, not
 * the operator that ran it, and must not support an "operator identified"
 * claim on its own.
 */
export type ConsentPlatformKind = "vendor" | "framework-endpoint";

export type ConsentPlatform = {
  /** Human name of the consent management platform or shared framework endpoint. */
  name: string;
  /** The request domain that revealed it. */
  domain: string;
  /** Whether that name identifies an operator or a shared framework endpoint. */
  kind: ConsentPlatformKind;
};

const CMP_SIGNATURES: { name: string; kind: ConsentPlatformKind; suffixes: string[] }[] = [
  { name: "OneTrust", kind: "vendor", suffixes: ["cookielaw.org", "onetrust.com", "cookiepro.com"] },
  { name: "Cookiebot", kind: "vendor", suffixes: ["cookiebot.com", "cookiebot.eu"] },
  { name: "Sourcepoint", kind: "vendor", suffixes: ["sp-prod.net", "sourcepoint.com"] },
  { name: "Didomi", kind: "vendor", suffixes: ["didomi.io"] },
  { name: "Usercentrics", kind: "vendor", suffixes: ["usercentrics.eu", "usercentrics.com"] },
  { name: "TrustArc", kind: "vendor", suffixes: ["trustarc.com", "truste.com"] },
  { name: "CookieYes", kind: "vendor", suffixes: ["cookieyes.com"] },
  { name: "Osano", kind: "vendor", suffixes: ["osano.com"] },
  { name: "Termly", kind: "vendor", suffixes: ["termly.io"] },
  { name: "Iubenda", kind: "vendor", suffixes: ["iubenda.com"] },
  { name: "Cookie Information", kind: "vendor", suffixes: ["cookieinformation.com"] },
  { name: "Complianz", kind: "vendor", suffixes: ["complianz.io"] },
  // Generic IAB TCF endpoint, used by many CMPs registered with the framework.
  { name: "IAB TCF", kind: "framework-endpoint", suffixes: ["consensu.org"] }
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
  return consentPlatformSignatureForDomain(domain)?.name ?? null;
}

/**
 * Whether the domain names a vendor or a shared framework endpoint, or null
 * when it names no consent platform at all. Coverage counters must not treat
 * a framework-endpoint match as an identified operator: the CMP that actually
 * ran behind such a host stays unnamed.
 */
export function consentPlatformKindForDomain(domain: string): ConsentPlatformKind | null {
  return consentPlatformSignatureForDomain(domain)?.kind ?? null;
}

function consentPlatformSignatureForDomain(
  domain: string
): { name: string; kind: ConsentPlatformKind } | null {
  const host = domain.trim().toLowerCase().replace(/\.$/, "");
  for (const signature of CMP_SIGNATURES) {
    if (signature.suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      return { name: signature.name, kind: signature.kind };
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
        return { name: signature.name, domain: entry.domain, kind: signature.kind };
      }
    }
  }
  return null;
}
