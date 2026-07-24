export const REDACTION_TRANSITION_AUDIT_VERSION = "redaction-v4-transition-audit@1" as const;

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
 * Counts are field transitions in the exact before/after report projection.
 */
export function redactionTransitionAudit(before: unknown, after: unknown): RedactionTransitionAudit {
  const audit = emptyRedactionTransitionAudit();
  visit(before, after, undefined, audit);
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

function visit(
  before: unknown,
  after: unknown,
  key: string | undefined,
  audit: RedactionTransitionAudit
): void {
  if (typeof before === "string") {
    if (key === "pageTitle" && before !== "" && after === "") audit.pageTitlesWithheld += 1;
    const beforePort = explicitPort(before, key);
    if (beforePort !== null && (typeof after !== "string" || explicitPort(after, key) !== beforePort)) {
      audit.explicitPortFieldsRemoved += 1;
    }
    if (
      key !== undefined &&
      HOST_OR_URL_KEYS.has(key) &&
      hasIpLiteralHost(before, key) &&
      typeof after === "string" &&
      (after === "{invalid-url}" || after === "{invalid-host}" || after === ".{invalid-host}")
    ) {
      audit.ipLiteralFieldsRejected += 1;
    }
    return;
  }
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return;
    for (let index = 0; index < before.length; index += 1) {
      visit(before[index], after[index], key, audit);
    }
    return;
  }
  if (!isRecord(before) || !isRecord(after)) return;
  for (const [childKey, value] of Object.entries(before)) {
    visit(value, after[childKey], childKey, audit);
  }
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
