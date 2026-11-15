import { identifiedHostCatalogMatchLabel, type EvidenceState, type RunFacts } from "./report-facts";
import { listOverflowCopy } from "./report-table-copy";
import { displayHost, plural } from "./text-format";

/**
 * The report page's server-rendered domain table: the busiest recorded
 * domains of one visit, each with a strip of when its retained request rows
 * started.
 *
 * It is a bounded excerpt, never the inventory: the evidence explorer and the
 * report JSON hold every row, and the table says how many it leaves out.
 *
 * The sentences in DOMAIN_TABLE_SHARED_COPY are the evidence explorer's own
 * (app/_components/report-tables.tsx), restated here because that module is a
 * client component this server table cannot import from.
 * lib/domain-evidence-table.test.ts fails if the two stop agreeing.
 */
export const DOMAIN_TABLE_SHARED_COPY = Object.freeze({
  heading: "Domain evidence",
  columnDomain: "Domain",
  columnRole: "Role",
  columnRequests: "Requests",
  columnCatalogMatch: "Catalog match",
  columnResourceTypes: "Resource types",
  noCatalogMatch: "No catalog match",
  roleService: "service",
  roleThirdParty: "third-party",
  roleFirstParty: "first-party",
  retainedOnly: "These are retained domain rows, not a complete inventory.",
  returnedDocument: "These domains describe the returned document, not a verified normal page load."
});

/** Wording this table adds. New text, kept in one place for review. */
export const DOMAIN_TABLE_NEW_COPY = Object.freeze({
  columnWhen: (seconds: string) => `When, 0 to ${seconds} s`,
  stripLabel: (first: string, last: string) =>
    first === last ? `request start time: ${first} s` : `request start times: ${first} s to ${last} s`,
  stripEmpty: "no retained request row",
  overflowWhere: "the evidence explorer below",
  caption: (label: string | null) =>
    label
      ? `The busiest recorded domains of the ${label} visit, with role, request count, request start times and catalog match.`
      : "The busiest recorded domains of this visit, with role, request count, request start times and catalog match."
});

export type DomainEvidenceRow = {
  host: string;
  site: boolean;
  role: string;
  requests: number;
  catalogMatch: string | null;
  resourceTypes: string;
  /** Request start times as fractions of the strip, in order. */
  ticks: number[];
  stripLabel: string;
};

export type DomainEvidenceTable = {
  /** Domains that passed `matches` (every recorded domain when none was given). */
  matched: number;
  state: EvidenceState;
  countLabel: string;
  caption: string;
  whenColumn: string;
  rows: DomainEvidenceRow[];
  overflow: string | null;
  notes: string[];
};

export const DOMAIN_TABLE_ROWS = 30;

function seconds(ms: number): string {
  return (ms / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/**
 * The one time scale of a visit's drawings: the domain table's strips, the
 * request log's ticks and the explorer's timeline all run from 0 to `spanMs`.
 * The strip spans the visit; a row recorded after the stated duration still
 * has to land inside it.
 */
export function visitTimeScale(run: RunFacts["run"]): { spanMs: number; whenColumn: string } {
  let latest = 0;
  for (const request of run.evidence.requests) if (request.startedAtMs > latest) latest = request.startedAtMs;
  const spanMs = Math.max(run.durationMs, latest, 1);
  return { spanMs, whenColumn: DOMAIN_TABLE_NEW_COPY.columnWhen(seconds(spanMs)) };
}

/**
 * `matches`, when given, keeps only the domains it accepts before the row
 * limit applies (the explorer's filter field); the count label still states
 * every recorded domain.
 */
export function buildDomainEvidenceTable(
  facts: RunFacts,
  label: string | null,
  limit = DOMAIN_TABLE_ROWS,
  matches?: (domain: string) => boolean
): DomainEvidenceTable {
  const run = facts.run;
  const state = facts.evidence.requests.state;
  const starts = new Map<string, number[]>();
  for (const request of run.evidence.requests) {
    const list = starts.get(request.domain);
    if (list) list.push(request.startedAtMs);
    else starts.set(request.domain, [request.startedAtMs]);
  }
  const { spanMs: span, whenColumn } = visitTimeScale(run);
  const recorded = [...run.evidence.domains].sort((a, b) => b.requests - a.requests);
  const domains = matches ? recorded.filter((domain) => matches(domain.domain)) : recorded;
  const rows = domains.slice(0, limit).map((domain): DomainEvidenceRow => {
    const identity = facts.identity.hosts.find((entry) => entry.host === domain.domain);
    const times = [...(starts.get(domain.domain) ?? [])].sort((a, b) => a - b);
    return {
      host: displayHost(domain.domain),
      site: !domain.thirdParty,
      role:
        (identity?.catalogMatches.length ?? 0) > 0
          ? DOMAIN_TABLE_SHARED_COPY.roleService
          : domain.thirdParty
            ? DOMAIN_TABLE_SHARED_COPY.roleThirdParty
            : DOMAIN_TABLE_SHARED_COPY.roleFirstParty,
      requests: domain.requests,
      catalogMatch: identifiedHostCatalogMatchLabel(identity),
      resourceTypes: domain.resourceTypes.join(", "),
      ticks: times.map((time) => Math.round((time / span) * 1000) / 1000),
      stripLabel:
        times.length === 0
          ? DOMAIN_TABLE_NEW_COPY.stripEmpty
          : DOMAIN_TABLE_NEW_COPY.stripLabel(seconds(times[0]), seconds(times[times.length - 1]))
    };
  });
  const notes: string[] = [];
  if (rows.length > 0 && state === "censored") notes.push(DOMAIN_TABLE_SHARED_COPY.retainedOnly);
  if (rows.length > 0 && !facts.subject.describesSubject) notes.push(DOMAIN_TABLE_SHARED_COPY.returnedDocument);
  return {
    state,
    matched: domains.length,
    countLabel: plural(recorded.length, "recorded domain"),
    caption: DOMAIN_TABLE_NEW_COPY.caption(label),
    whenColumn,
    rows,
    overflow: listOverflowCopy(domains.length, rows.length, DOMAIN_TABLE_NEW_COPY.overflowWhere),
    notes
  };
}
