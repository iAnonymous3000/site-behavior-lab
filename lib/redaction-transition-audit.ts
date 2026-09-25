import { isCurrentlyCheckablePolicyClaim } from "./privacy-policy";
import { policyQuoteHasIdentifier } from "./redact-scan-report-v1";
import { isGeneralizedPrivateSuffixTenantHost } from "./redaction-v2";
import type { PrivacyPolicyClaim } from "./types";

export const REDACTION_TRANSITION_AUDIT_VERSION = "redaction-v4-transition-audit@3" as const;

export type RedactionTransitionAudit = {
  version: typeof REDACTION_TRANSITION_AUDIT_VERSION;
  pageTitlesWithheld: number;
  explicitPortFieldsRemoved: number;
  ipLiteralFieldsRejected: number;
  /** Host, URL, or tracker-entity fields whose private-suffix tenant label generalized. */
  privateSuffixTenantLabelsGeneralized: number;
  /** Policy quotes from which an identifier span was scrubbed. */
  policyQuoteIdentifierSpansScrubbed: number;
  /**
   * Scrubbed policy claims that were checkable before the scrub. A scrubbed
   * quote is marked incomplete and never checked, so each one is a policy
   * cross-check the rewritten report no longer publishes.
   */
  policyClaimsMadeUncheckable: number;
};

const HOST_OR_URL_KEYS = new Set([
  "url",
  "requestedUrl",
  "finalUrl",
  "initiatorUrl",
  "initiatorDomain",
  "scriptUrl",
  "scriptDomain",
  "injectedByUrl",
  "injectedByDomain",
  "frameUrl",
  "origin",
  "domain",
  "host",
  "cname",
  "firstPartyDomain",
  "registrableDomain",
  "thirdPartyOrigins",
  "recipients"
]);

// A Shields-list tracker entity, and a policy entity grounded in one, is a
// registrable domain, so the tenant rule reaches it as well.
const TENANT_HOST_KEYS = new Set([...HOST_OR_URL_KEYS, "entity", "mentionedEntities", "unmentionedEntities"]);

const HOST_ONLY_KEYS = new Set([
  "domain",
  "host",
  "cname",
  "firstPartyDomain",
  "registrableDomain",
  "initiatorDomain",
  "scriptDomain",
  "injectedByDomain",
  "thirdPartyOrigins",
  "recipients"
]);

export function emptyRedactionTransitionAudit(): RedactionTransitionAudit {
  return {
    version: REDACTION_TRANSITION_AUDIT_VERSION,
    pageTitlesWithheld: 0,
    explicitPortFieldsRemoved: 0,
    ipLiteralFieldsRejected: 0,
    privateSuffixTenantLabelsGeneralized: 0,
    policyQuoteIdentifierSpansScrubbed: 0,
    policyClaimsMadeUncheckable: 0
  };
}

/**
 * Versioned migration-only accounting for v4 policy transitions that cannot
 * be added to the frozen seven-field public privacy counter vocabulary.
 * Counts are before-side fields carrying a superseded policy value that no
 * longer appears under the same key in the after projection. Position is not
 * used: v1 redaction rebuilds derived arrays.
 */
export function redactionTransitionAudit(before: unknown, after: unknown): RedactionTransitionAudit {
  const audit = emptyRedactionTransitionAudit();
  visit(before, collectStringsByKey(after), undefined, audit);
  return audit;
}

export function addRedactionTransitionAudit(
  target: RedactionTransitionAudit,
  source: RedactionTransitionAudit
): void {
  target.pageTitlesWithheld += source.pageTitlesWithheld;
  target.explicitPortFieldsRemoved += source.explicitPortFieldsRemoved;
  target.ipLiteralFieldsRejected += source.ipLiteralFieldsRejected;
  target.privateSuffixTenantLabelsGeneralized += source.privateSuffixTenantLabelsGeneralized;
  target.policyQuoteIdentifierSpansScrubbed += source.policyQuoteIdentifierSpansScrubbed;
  target.policyClaimsMadeUncheckable += source.policyClaimsMadeUncheckable;
}

/**
 * Every string in the projection, indexed by the property key it sits under.
 * Array elements inherit their parent key, exactly as the walk below does.
 *
 * v1 redaction REBUILDS derived arrays instead of mapping them: `domains` is
 * regrouped from the sanitized requests, so IP-literal rows collapse into one
 * {invalid-host} row and the survivors re-sort by request count. Pairing
 * before/after elements by index therefore compared unrelated fields. A
 * field's transition is confirmed instead by its violating value being absent
 * from the after projection under the same key.
 */
function collectStringsByKey(
  value: unknown,
  key?: string,
  into = new Map<string, Set<string>>()
): Map<string, Set<string>> {
  if (typeof value === "string") {
    if (key !== undefined) {
      let bucket = into.get(key);
      if (bucket === undefined) into.set(key, (bucket = new Set()));
      bucket.add(value);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const element of value) collectStringsByKey(element, key, into);
    return into;
  }
  if (!isRecord(value)) return into;
  for (const [childKey, child] of Object.entries(value)) collectStringsByKey(child, childKey, into);
  return into;
}

function visit(
  before: unknown,
  after: Map<string, Set<string>>,
  key: string | undefined,
  audit: RedactionTransitionAudit
): void {
  if (typeof before === "string") {
    if (key === undefined || after.get(key)?.has(before) === true) return;
    if (key === "pageTitle" && before !== "") audit.pageTitlesWithheld += 1;
    if (explicitPort(before, key) !== null) audit.explicitPortFieldsRemoved += 1;
    if (HOST_OR_URL_KEYS.has(key) && hasIpLiteralHost(before, key)) audit.ipLiteralFieldsRejected += 1;
    if (TENANT_HOST_KEYS.has(key)) {
      const host = fieldHostname(before, key, TENANT_HOST_KEYS);
      if (host !== null && isGeneralizedPrivateSuffixTenantHost(host)) audit.privateSuffixTenantLabelsGeneralized += 1;
    }
    if (key === "quote" && policyQuoteHasIdentifier(before)) audit.policyQuoteIdentifierSpansScrubbed += 1;
    return;
  }
  if (Array.isArray(before)) {
    for (const element of before) visit(element, after, key, audit);
    return;
  }
  if (!isRecord(before)) return;
  if (key === "claims" && madeUncheckable(before, after)) audit.policyClaimsMadeUncheckable += 1;
  for (const [childKey, value] of Object.entries(before)) visit(value, after, childKey, audit);
}

function madeUncheckable(claim: Record<string, unknown>, after: Map<string, Set<string>>): boolean {
  const { kind, quote } = claim;
  if (typeof kind !== "string" || typeof quote !== "string") return false;
  if (after.get("quote")?.has(quote) === true || !policyQuoteHasIdentifier(quote)) return false;
  return isCurrentlyCheckablePolicyClaim({ kind: kind as PrivacyPolicyClaim["kind"], quote });
}

function explicitPort(value: string, key: string | undefined): string | null {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.port) return parsed.port;
  } catch {
    // A host-shaped field may not contain a URL scheme. Try it below.
  }
  if (key === undefined || !HOST_ONLY_KEYS.has(key)) return null;
  try {
    const parsed = new URL(`https://${value.replace(/^\./, "")}/`);
    return parsed.port || null;
  } catch {
    return null;
  }
}

function hasIpLiteralHost(value: string, key: string): boolean {
  const host = fieldHostname(value, key, HOST_OR_URL_KEYS) ?? "";
  return /^\[.*\]$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function fieldHostname(value: string, key: string, hostKeys: ReadonlySet<string>): string | null {
  try {
    if (/^https?:\/\//i.test(value)) return new URL(value).hostname;
    return hostKeys.has(key) ? new URL(`https://${value.replace(/^\./, "")}/`).hostname : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
