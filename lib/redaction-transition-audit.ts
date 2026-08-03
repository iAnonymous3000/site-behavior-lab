export const REDACTION_TRANSITION_AUDIT_VERSION = "redaction-v4-transition-audit@2" as const;

export type RedactionTransitionAudit = {
  version: typeof REDACTION_TRANSITION_AUDIT_VERSION;
  pageTitlesWithheld: number;
  explicitPortFieldsRemoved: number;
  ipLiteralFieldsRejected: number;
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
    ipLiteralFieldsRejected: 0
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
    return;
  }
  if (Array.isArray(before)) {
    for (const element of before) visit(element, after, key, audit);
    return;
  }
  if (!isRecord(before)) return;
  for (const [childKey, value] of Object.entries(before)) visit(value, after, childKey, audit);
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
  let host: string;
  try {
    host = /^https?:\/\//i.test(value)
      ? new URL(value).hostname
      : HOST_OR_URL_KEYS.has(key)
        ? new URL(`https://${value.replace(/^\./, "")}/`).hostname
        : "";
  } catch {
    return false;
  }
  return /^\[.*\]$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
