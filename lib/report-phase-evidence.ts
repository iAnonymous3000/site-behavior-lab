import { displayEvidenceName } from "./text-format";
import { isReviewedCookieName, isReviewedStorageKey } from "./public-name-policy";
import type { PhaseKind, RunSummary } from "./scan-report-v2";
import type { RunView } from "./scan-report-views";

/**
 * Client-safe presentation model for the recorded v2 phase surface.
 *
 * Keep this module React-free so the semantics (especially sparse request
 * counts and privacy-filtered names) can be pinned with the unit test runner.
 */

export const STATE_CHANGE_ROW_LIMIT = 80;

export type MutationTally = {
  added: number;
  changed: number;
  removed: number;
  total: number;
};

export type VisitPhaseRow = {
  phaseId: number;
  kind: PhaseKind;
  label: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  requestCounts: RunSummary["countsByPhase"][number] | null;
  requestCountState: "recorded" | "no-retained-rows";
  cookieChanges: MutationTally;
  storageChanges: MutationTally;
  incompleteFamilies: Array<"cookies" | "storage">;
};

export type StateChangeRow = {
  id: string;
  phaseId: number;
  phaseLabel: string;
  family: "cookie" | "storage";
  operation: "added" | "changed" | "removed";
  operationLabel: string;
  subjectLabel: string;
  context: string;
  nameHidden: boolean;
};

export type VisitPhaseEvidence = {
  phases: VisitPhaseRow[];
  changes: StateChangeRow[];
  hiddenNameRecords: number;
  cookieLedgerIncomplete: boolean;
  storageLedgerIncomplete: boolean;
};

const PHASE_LABELS: Record<PhaseKind, string> = {
  "passive-load": "Initial page load",
  "consent-interaction": "Consent interaction",
  "post-choice-reload": "Post-choice verification reload",
  "active-probe": "Active input probe",
  "policy-analysis": "Privacy-policy analysis"
};

const EMPTY_TALLY: MutationTally = { added: 0, changed: 0, removed: 0, total: 0 };

/** Plain-language label for a closed, producer-owned phase kind. */
export function visitPhaseLabel(kind: PhaseKind): string {
  return PHASE_LABELS[kind];
}

/** Compact timing copy; every value is relative to the start of this run. */
export function visitPhaseSpanLabel(phase: Pick<VisitPhaseRow, "startedAtMs" | "endedAtMs" | "durationMs">): string {
  const start = phase.startedAtMs.toLocaleString("en-US");
  const end = phase.endedAtMs.toLocaleString("en-US");
  const duration = phase.durationMs.toLocaleString("en-US");
  return `${start} to ${end} ms (${duration} ms)`;
}

/**
 * Mutation operations are snapshot deltas, not instrumented writes. In
 * particular, phase-zero "added" means the record was present at the first
 * snapshot; it does not prove the page wrote it while the observer watched.
 */
export function stateChangeOperationLabel(
  operation: StateChangeRow["operation"],
  phaseKind: PhaseKind
): string {
  if (operation === "added") {
    return phaseKind === "passive-load" ? "Present at first snapshot" : "Appeared by phase boundary";
  }
  if (operation === "changed") return "Changed by phase boundary";
  return "Absent by phase boundary";
}

/**
 * Build the v2-only phase/state surface. Returning null preserves the view
 * contract's important distinction: legacy v1 never recorded these fields,
 * while v2 records arrays that may legitimately be empty.
 */
export function buildVisitPhaseEvidence(run: RunView): VisitPhaseEvidence | null {
  const cookieMutations = run.evidence.cookieMutations;
  const storageMutations = run.evidence.storageMutations;
  if (run.phases === null || run.countsByPhase === null || cookieMutations === null || storageMutations === null) {
    return null;
  }

  const phaseById = new Map(run.phases.map((phase) => [phase.phaseId, phase]));
  const countsByPhase = new Map(run.countsByPhase.map((counts) => [counts.phaseId, counts]));
  const cookieTallies = mutationTallies(cookieMutations);
  const storageTallies = mutationTallies(storageMutations);
  const phaseLosses = new Map<number, Set<"cookies" | "storage">>();
  const globalLedgerLosses = new Set<"cookies" | "storage">();

  for (const loss of run.quality.facts?.captureLoss ?? []) {
    if (!mutationLedgerLoss(loss)) continue;
    if (loss.phaseId === null) {
      globalLedgerLosses.add(loss.family);
      continue;
    }
    const families = phaseLosses.get(loss.phaseId) ?? new Set<"cookies" | "storage">();
    families.add(loss.family);
    phaseLosses.set(loss.phaseId, families);
  }

  const phases = run.phases.map((phase): VisitPhaseRow => {
    const requestCounts = countsByPhase.get(phase.phaseId) ?? null;
    return {
      phaseId: phase.phaseId,
      kind: phase.kind,
      label: visitPhaseLabel(phase.kind),
      startedAtMs: phase.startedAtMs,
      endedAtMs: phase.endedAtMs,
      durationMs: Math.max(0, phase.endedAtMs - phase.startedAtMs),
      requestCounts,
      requestCountState: requestCounts ? "recorded" : "no-retained-rows",
      cookieChanges: cookieTallies.get(phase.phaseId) ?? { ...EMPTY_TALLY },
      storageChanges: storageTallies.get(phase.phaseId) ?? { ...EMPTY_TALLY },
      incompleteFamilies: [...new Set([...(phaseLosses.get(phase.phaseId) ?? []), ...globalLedgerLosses])]
    };
  });

  const cookieRows: Array<StateChangeRow & { order: number }> = cookieMutations.map((mutation, index) => {
    const phase = phaseById.get(mutation.phaseId);
    const subjectLabel = displayEvidenceName(mutation.cookie.name, "cookie", index + 1);
    const nameHidden = !isReviewedCookieName(mutation.cookie.name);
    return {
      id: `cookie-${index}`,
      order: index,
      phaseId: mutation.phaseId,
      phaseLabel: phase ? visitPhaseLabel(phase.kind) : `Phase ${mutation.phaseId}`,
      family: "cookie",
      operation: mutation.op,
      operationLabel: stateChangeOperationLabel(mutation.op, phase?.kind ?? "passive-load"),
      subjectLabel,
      context: `${mutation.cookie.thirdParty ? "Third-party" : "First-party"} cookie · ${
        mutation.cookie.session ? "session" : "persistent"
      }`,
      nameHidden
    };
  });

  const storageRows: Array<StateChangeRow & { order: number }> = storageMutations.map((mutation, index) => {
    const phase = phaseById.get(mutation.phaseId);
    const subjectLabel = displayEvidenceName(mutation.entry.key, "storage", index + 1);
    const nameHidden = !isReviewedStorageKey(mutation.entry.key);
    const sizeLabel = `${mutation.entry.valueBytes.toLocaleString("en-US")} ${
      mutation.entry.valueBytes === 1 ? "byte" : "bytes"
    }`;
    return {
      id: `storage-${index}`,
      order: cookieMutations.length + index,
      phaseId: mutation.phaseId,
      phaseLabel: phase ? visitPhaseLabel(phase.kind) : `Phase ${mutation.phaseId}`,
      family: "storage",
      operation: mutation.op,
      operationLabel: stateChangeOperationLabel(mutation.op, phase?.kind ?? "passive-load"),
      subjectLabel,
      context: `${mutation.entry.area} · ${mutation.op === "removed" ? "last observed size" : "observed size"} ${sizeLabel}`,
      nameHidden
    };
  });

  const ordered = [...cookieRows, ...storageRows]
    .sort((left, right) => left.phaseId - right.phaseId || left.order - right.order)
    .map(({ order: _order, ...row }) => row);

  return {
    phases,
    changes: ordered,
    hiddenNameRecords: ordered.filter((row) => row.nameHidden).length,
    cookieLedgerIncomplete: [...phaseLosses.values()].some((families) => families.has("cookies")) || globalLedgerLosses.has("cookies"),
    storageLedgerIncomplete: [...phaseLosses.values()].some((families) => families.has("storage")) || globalLedgerLosses.has("storage")
  };
}

/**
 * Final-list clipping does not make the separately recorded mutation ledger
 * partial. Every other cookie/storage loss can remove a boundary observation;
 * unknown detail therefore fails closed as ledger loss.
 */
function mutationLedgerLoss(
  loss: NonNullable<RunView["quality"]["facts"]>["captureLoss"][number]
): loss is typeof loss & { family: "cookies" | "storage" } {
  if (loss.family !== "cookies" && loss.family !== "storage") return false;
  const finalOnlyDetail = loss.family === "cookies" ? "public-cookie-final" : "public-storage-final";
  return loss.detail !== finalOnlyDetail;
}

function mutationTallies(
  mutations: ReadonlyArray<{ phaseId: number; op: "added" | "changed" | "removed" }>
): Map<number, MutationTally> {
  const tallies = new Map<number, MutationTally>();
  for (const mutation of mutations) {
    const tally = tallies.get(mutation.phaseId) ?? { ...EMPTY_TALLY };
    tally[mutation.op] += 1;
    tally.total += 1;
    tallies.set(mutation.phaseId, tally);
  }
  return tallies;
}
