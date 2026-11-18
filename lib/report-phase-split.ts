import type { PhaseKind } from "./scan-report-v2";
import type { RunView } from "./scan-report-views";

/**
 * When a visit's counted cross-site rows were recorded, relative to the
 * scanner's own actions.
 *
 * A request carries the phase that was open when the browser emitted it
 * (lib/measurement-kernel.ts tagRequest). That records timing, never cause:
 * a page timer that fires while the typing probe runs lands in the probe's
 * phase. So this module counts rows by phase and states nothing about why a
 * request was made. Every surface that quotes a cross-site count reads one
 * split from here, so the headline, its share text and the findings board
 * cannot describe the same rows differently.
 *
 * React-free and wording-free, so it runs in the client renderer, the server
 * routes and the share-card route, and its states can be checked exhaustively.
 */

/** Every phase the scanner opens by acting on the page. */
export type ScannerActionPhase = Exclude<PhaseKind, "passive-load">;

/**
 * - `no-rows`: the claim counts no row.
 * - `page-load-only`: every counted row was recorded in page load.
 * - `mixed`: some in page load, some after a scanner action.
 * - `all-after-action`: none in page load.
 * - `unknown-after-action`: the report records no phases (or a counted row
 *   carries none), and the visit recorded a scanner action whose requests are
 *   in the counts, so the split cannot be stated.
 * - `no-action-recorded`: the report records no phases and no scanner action
 *   whose requests are in the counts.
 */
export type CrossSitePhaseState =
  | "no-rows"
  | "page-load-only"
  | "mixed"
  | "all-after-action"
  | "unknown-after-action"
  | "no-action-recorded";

export type CrossSitePhaseSplit = {
  state: CrossSitePhaseState;
  /** The request log did not finish, so every count here is of retained rows only. */
  requestsCensored: boolean;
  /** The scanner actions whose phases hold counted rows, in phase order. */
  actions: ScannerActionPhase[];
  requests: { total: number; afterAction: number };
  /** Hosts with no counted row in page load, in first-seen order. */
  hosts: { total: number; onlyAfterAction: string[] };
  /** Catalogued entities with no counted row in page load, in first-seen order. */
  entities: { total: number; onlyAfterAction: string[] };
};

/**
 * What the visit's own records say about scanner actions when it carries no
 * phases. The caller reads these from the run (its typing disclosure and its
 * consent mode); this module never parses warning text.
 */
export type UnphasedActions = {
  /** The typing disclosure's ending: whether the probe's requests are in the counts. */
  typingRequests: "included" | "omitted" | "unstated" | null;
  /** The scanner clicked a consent control in this visit. */
  consentClick: boolean;
};

type RequestRow = RunView["evidence"]["requests"][number];

const ACTION_ORDER: readonly ScannerActionPhase[] = [
  "consent-interaction",
  "post-choice-reload",
  "active-probe",
  "policy-analysis"
];

export function crossSitePhaseSplit(
  run: Pick<RunView, "phases" | "evidence">,
  input: {
    /** The rows the claim counts. Cross-site rows when omitted. */
    claimRows?: (request: RequestRow) => boolean;
    requestsCensored: boolean;
    unphased: UnphasedActions;
  }
): CrossSitePhaseSplit {
  const counted = run.evidence.requests.filter(input.claimRows ?? ((request) => request.thirdParty));
  const kindById = run.phases ? new Map(run.phases.map((phase) => [phase.phaseId, phase.kind])) : null;
  const kindOf = (request: RequestRow): PhaseKind | null => {
    const phaseId = (request as { phaseId?: unknown }).phaseId;
    return kindById && typeof phaseId === "number" ? kindById.get(phaseId) ?? null : null;
  };

  const pageHosts = new Set<string>();
  const pageEntities = new Set<string>();
  const hosts = new Set<string>();
  const entities = new Set<string>();
  const laterHosts: string[] = [];
  const laterEntities: string[] = [];
  const actions = new Set<ScannerActionPhase>();
  let afterAction = 0;
  let unknownRows = 0;
  for (const request of counted) {
    hosts.add(request.domain);
    if (request.tracker) entities.add(request.tracker.entity);
    const kind = kindOf(request);
    if (kind === "passive-load") {
      pageHosts.add(request.domain);
      if (request.tracker) pageEntities.add(request.tracker.entity);
    } else if (kind === null) {
      unknownRows += 1;
    } else {
      afterAction += 1;
      actions.add(kind);
    }
  }
  for (const request of counted) {
    const kind = kindOf(request);
    if (kind === null || kind === "passive-load") continue;
    if (!pageHosts.has(request.domain) && !laterHosts.includes(request.domain)) laterHosts.push(request.domain);
    const entity = request.tracker?.entity;
    if (entity && !pageEntities.has(entity) && !laterEntities.includes(entity)) laterEntities.push(entity);
  }

  const total = counted.length;
  const unphasedActionRecorded =
    input.unphased.consentClick ||
    input.unphased.typingRequests === "included" ||
    input.unphased.typingRequests === "unstated";
  const state: CrossSitePhaseState =
    total === 0
      ? "no-rows"
      : kindById === null
        ? unphasedActionRecorded
          ? "unknown-after-action"
          : "no-action-recorded"
        : unknownRows > 0
          ? "unknown-after-action"
          : afterAction === 0
            ? "page-load-only"
            : afterAction === total
              ? "all-after-action"
              : "mixed";

  return {
    state,
    requestsCensored: input.requestsCensored,
    actions: ACTION_ORDER.filter((kind) => actions.has(kind)),
    requests: { total, afterAction },
    hosts: { total: hosts.size, onlyAfterAction: laterHosts },
    entities: { total: entities.size, onlyAfterAction: laterEntities }
  };
}
