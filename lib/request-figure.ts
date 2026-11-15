import type { EvidenceArm } from "./report-evidence-navigation";
import { retainedCountPhrase, type EvidenceState, type ReportFacts, type RunFacts } from "./report-facts";
import type { ReportView } from "./scan-report-views";
import { displayHost } from "./text-format";

/**
 * The report page's figure of where a visit's requests went, as data.
 *
 * One mark is one retained request row, so every count here is a count of
 * rows in `run.evidence.requests` and nothing is read from a summary: the
 * figure cannot draw more or fewer marks than the log the reader can open.
 * A visit whose request evidence was cut short keeps its retained rows and is
 * marked as a lower bound; a visit whose producer captured no request
 * evidence draws nothing and says so.
 *
 * Which visits are drawn follows the report's claim policy. A comparison the
 * policy allows draws both visits. One it refuses draws only the visit the
 * headline describes, so the figure never sets two visits side by side that
 * the report itself declines to compare.
 */
export type RequestFigureRowKind = "site" | "catalogued" | "unnamed";

export type RequestFigureRow = {
  kind: RequestFigureRowKind;
  /** Retained request rows drawn as marks. */
  count: number;
  name: string;
  /** The count in reader words, from the same phrase the findings use. */
  countPhrase: string;
  note: string;
};

export type RequestFigureVisit = {
  /** The visit's label on a comparison; null on a single visit. */
  label: string | null;
  state: EvidenceState;
  /** True when the retained rows are a lower bound on what the visit requested. */
  lowerBound: boolean;
  rows: RequestFigureRow[];
};

export type RequestFigure = {
  title: string;
  caption: string;
  visits: RequestFigureVisit[];
  notMeasuredTitle: string;
  notMeasuredNote: string;
  legend: { site: string; crossSite: string; lowerBound: string | null; notMeasured: string };
  /** Printed in place of the rows of a visit whose producer captured no request evidence. */
  unsupported: string;
};

/**
 * Every sentence and label the figure prints that no earlier surface printed.
 * New wording, kept in one place so it can be reviewed and changed as a set.
 */
export const REQUEST_FIGURE_COPY = Object.freeze({
  title: "Where this page's requests went",
  markUnit: "One mark is one request row in the retained log.",
  visitLead: (label: string) => `The ${label} visit.`,
  bothVisitsLead: "Both visits.",
  siteName: (host: string) => `${host} itself`,
  siteNote: "requests that stayed on the site",
  cataloguedName: "Catalogued services",
  cataloguedNone: "no retained request matched the service catalog",
  unnamedName: "Hosts the catalog does not name",
  unnamedNone: "no other cross-site host on record",
  unnamedNote: (hosts: number) =>
    `${hosts.toLocaleString("en-US")} ${hosts === 1 ? "host" : "hosts"}; the catalog cannot say who operates ${hosts === 1 ? "it" : "them"}`,
  namesLead: (names: number) => `${names.toLocaleString("en-US")} ${names === 1 ? "name" : "names"}`,
  namesMore: (more: number) => `and ${more.toLocaleString("en-US")} more`,
  unsupported: "Request evidence was not captured by this producer.",
  notMeasuredTitle: "Not measured",
  notMeasuredNote: "absence here is not evidence of absence",
  legendSite: "one request on record, same site",
  legendCrossSite: "one request on record, cross-site",
  legendLowerBound: "the count is a lower bound; more may exist",
  legendNotMeasured: "not measured"
});

const NAMED_ENTITIES_SHOWN = 5;

function visitFigure(facts: RunFacts, label: string | null): RequestFigureVisit {
  const run = facts.run;
  const state = facts.evidence.requests.state;
  const requests = run.evidence.requests;
  const site = requests.filter((request) => !request.thirdParty).length;
  const catalogued = requests.filter((request) => request.thirdParty && request.tracker !== null).length;
  const unnamed = requests.length - site - catalogued;
  // Hosts with at least one cross-site row that carries no catalog match.
  const unnamedHosts = new Set(
    requests.filter((request) => request.thirdParty && request.tracker === null).map((request) => request.domain)
  ).size;
  const names = new Map<string, number>();
  for (const request of requests) {
    if (request.thirdParty && request.tracker) names.set(request.tracker.entity, (names.get(request.tracker.entity) ?? 0) + 1);
  }
  const ranked = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = ranked.slice(0, NAMED_ENTITIES_SHOWN).map(([entity, count]) => `${entity} ${count.toLocaleString("en-US")}`);
  const more = ranked.length - shown.length;
  const phrase = (count: number) => retainedCountPhrase(count, "request", "requests", state);

  return {
    label,
    state,
    lowerBound: state === "censored",
    rows:
      state === "unsupported"
        ? []
        : [
            {
              kind: "site",
              count: site,
              name: REQUEST_FIGURE_COPY.siteName(displayHost(run.domain)),
              countPhrase: phrase(site),
              note: REQUEST_FIGURE_COPY.siteNote
            },
            {
              kind: "catalogued",
              count: catalogued,
              name: REQUEST_FIGURE_COPY.cataloguedName,
              countPhrase: phrase(catalogued),
              note:
                ranked.length === 0
                  ? REQUEST_FIGURE_COPY.cataloguedNone
                  : `${REQUEST_FIGURE_COPY.namesLead(ranked.length)}: ${[
                      ...shown,
                      ...(more > 0 ? [REQUEST_FIGURE_COPY.namesMore(more)] : [])
                    ].join(", ")}`
            },
            {
              kind: "unnamed",
              count: unnamed,
              name: REQUEST_FIGURE_COPY.unnamedName,
              countPhrase: phrase(unnamed),
              note: unnamed === 0 ? REQUEST_FIGURE_COPY.unnamedNone : REQUEST_FIGURE_COPY.unnamedNote(unnamedHosts)
            }
          ]
  };
}

/**
 * The character a mark is written as on screen. A group's marks are one run
 * of this character, one per retained request row, so the page carries one
 * byte per mark and not one element. It must stay "0": the stylesheet sets
 * the pitch from `1ch`, which is the advance of "0" in whatever font the
 * reader's browser ends up using (app/_design/components.css).
 */
export const MARK_CHARACTER = "0";

/** Marks per row of the printed figure. */
export const PRINT_MARK_COLUMNS = 60;

/**
 * Columns kept free at the right of the printed figure for the open-ended
 * box, so the box always follows the last mark on that mark's own row.
 */
export const PRINT_OPEN_BOX_COLUMNS = 4;

export type FigureMarks = {
  /** The run that wraps freely: every mark, or every mark but the last on a lower bound. */
  run: string;
  /**
   * On a lower bound, the mark held to the open-ended box so the two cannot
   * wrap apart: the last mark, or none when the row has no mark. Null when
   * the count is not a lower bound and no box is drawn.
   */
  held: string | null;
  /** The printed drawing: `fullRows` rows of `columns` marks, then one row of `remainder`. */
  print: { columns: number; fullRows: number; remainder: number; rows: number };
};

/**
 * One figure row's marks, for the screen and for paper. Screen: `run` and
 * `held` together hold exactly `count` characters. Paper:
 * `fullRows * columns + remainder` is exactly `count`; `rows` is how many
 * rows the drawing needs, at least one so a lone open-ended box has a row.
 */
export function figureMarks(count: number, lowerBound: boolean, columns: number = PRINT_MARK_COLUMNS): FigureMarks {
  if (!Number.isInteger(count) || count < 0) throw new Error(`a figure row cannot draw ${count} marks`);
  if (!Number.isInteger(columns) || columns < 1) throw new Error(`a printed figure cannot have ${columns} columns`);
  const heldCount = lowerBound && count > 0 ? 1 : 0;
  const fullRows = Math.floor(count / columns);
  const remainder = count % columns;
  return {
    run: MARK_CHARACTER.repeat(count - heldCount),
    held: lowerBound ? MARK_CHARACTER.repeat(heldCount) : null,
    print: { columns, fullRows, remainder, rows: Math.max(1, fullRows + (remainder > 0 ? 1 : 0)) }
  };
}

export function buildRequestFigure(
  view: ReportView,
  facts: ReportFacts,
  evidenceArm: EvidenceArm | undefined,
  options: {
    /**
     * Draw only the visit the headline describes, even where the claim policy
     * allows the pair. A surface that shows one report among others (the
     * homepage's record and its rows) sets it, so its figure, its date and its
     * finding sentence are about one visit. The caption is the one a refused
     * comparison already uses: it names the visit drawn.
     */
    describedVisitOnly?: boolean;
  } = {}
): RequestFigure {
  const labels = view.comparison?.runLabels;
  let visits: RequestFigureVisit[];
  let lead: string | null = null;
  if (facts.arms && labels && evidenceArm) {
    if (view.claims.pairComparison?.allowed === true && !options.describedVisitOnly) {
      visits = [visitFigure(facts.arms.baseline, labels.baseline), visitFigure(facts.arms.variant, labels.variant)];
      lead = REQUEST_FIGURE_COPY.bothVisitsLead;
    } else {
      visits = [visitFigure(facts.arms[evidenceArm], labels[evidenceArm])];
      lead = REQUEST_FIGURE_COPY.visitLead(labels[evidenceArm]);
    }
  } else {
    visits = [visitFigure(facts.display, null)];
  }
  return {
    title: REQUEST_FIGURE_COPY.title,
    caption: lead ? `${lead} ${REQUEST_FIGURE_COPY.markUnit}` : REQUEST_FIGURE_COPY.markUnit,
    visits,
    notMeasuredTitle: REQUEST_FIGURE_COPY.notMeasuredTitle,
    notMeasuredNote: REQUEST_FIGURE_COPY.notMeasuredNote,
    unsupported: REQUEST_FIGURE_COPY.unsupported,
    legend: {
      site: REQUEST_FIGURE_COPY.legendSite,
      crossSite: REQUEST_FIGURE_COPY.legendCrossSite,
      lowerBound: visits.some((visit) => visit.lowerBound) ? REQUEST_FIGURE_COPY.legendLowerBound : null,
      notMeasured: REQUEST_FIGURE_COPY.legendNotMeasured
    }
  };
}
