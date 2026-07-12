import { canonicalJson } from "./scan-report-v2-fingerprints";
import { sha256Hex } from "./sha256";
import {
  DETECTOR_IDS,
  type CaptureLossEntry,
  type CookieMutation,
  type DetectorId,
  type DetectorLedger,
  type DetectorStatus,
  type EvidenceFamily,
  type PhaseId,
  type PhaseKind,
  type PhaseSpan,
  type QualityFacts,
  type StorageMutation
} from "./scan-report-v2";
import type { CookieRecord, StorageRecord } from "./types";

/**
 * Internal measurement kernel for the Node producer. It records facts only:
 * sequential phase clocks, request-to-phase attribution, detector outcomes,
 * budget/capture loss, and boundary-state mutations. Wire quality and claims
 * remain derived by the versioned evaluators.
 */

export const DETECTOR_REGISTRY_VERSION = "node-detectors-v1";

export const DETECTOR_VERSIONS: Readonly<Record<DetectorId, string>> = {
  "fingerprint-heuristics": "fingerprint-observer@1",
  "keystroke-exfiltration": "synthetic-sentinel@1",
  "cname-uncloaking": "dns-cname-chain@1",
  "pixel-events": "pixel-request-decoder@1",
  "consent-banner": "consent-control-and-state@1",
  "privacy-policy": "policy-text-cross-check@1"
};

export const DETECTOR_REGISTRY_DIGEST = sha256Hex(
  canonicalJson({ version: DETECTOR_REGISTRY_VERSION, detectors: DETECTOR_VERSIONS })
);

type Clock = () => number;

export class MeasurementKernel<RequestT extends object = object> {
  private readonly phases: PhaseSpan[] = [];
  private readonly requestPhases = new WeakMap<RequestT, PhaseId>();
  private readonly losses: CaptureLossEntry[] = [];
  private readonly exhausted = new Set<string>();
  private readonly detectorState: DetectorLedger;
  private active: PhaseSpan | null = null;
  private finished = false;

  constructor(
    private readonly startedAtMs: number,
    private readonly now: Clock = Date.now
  ) {
    this.detectorState = Object.fromEntries(
      DETECTOR_IDS.map((id) => [id, { version: DETECTOR_VERSIONS[id], status: "skipped" as const }])
    ) as DetectorLedger;
  }

  beginPhase(kind: PhaseKind): PhaseId {
    this.assertOpen();
    const at = this.elapsed();
    this.closeActive(at);
    const phaseId = this.phases.length;
    const phase: PhaseSpan = { phaseId, kind, startedAtMs: at, endedAtMs: at };
    this.phases.push(phase);
    this.active = phase;
    return phaseId;
  }

  endPhase(): void {
    this.assertOpen();
    this.closeActive(this.elapsed());
  }

  currentPhaseId(): PhaseId {
    if (!this.active) throw new Error("No measurement phase is active.");
    return this.active.phaseId;
  }

  elapsed(): number {
    return Math.max(0, Math.floor(this.now() - this.startedAtMs));
  }

  tagRequest(request: RequestT): PhaseId {
    const phaseId = this.currentPhaseId();
    this.requestPhases.set(request, phaseId);
    return phaseId;
  }

  phaseForRequest(request: RequestT): PhaseId | null {
    return this.requestPhases.get(request) ?? null;
  }

  setDetector(id: DetectorId, status: DetectorStatus, input: { reason?: string; phaseId?: PhaseId } = {}): void {
    this.assertOpen();
    this.detectorState[id] = {
      version: DETECTOR_VERSIONS[id],
      status,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {})
    };
  }

  recordCaptureLoss(entry: CaptureLossEntry): void {
    this.assertOpen();
    if (!Number.isInteger(entry.count) || entry.count <= 0) {
      throw new Error("Capture loss count must be a positive integer.");
    }
    this.losses.push({ ...entry });
  }

  exhaustBudget(input: {
    name: string;
    family: EvidenceFamily;
    phaseId?: PhaseId | null;
    kind?: CaptureLossEntry["kind"];
    count?: number;
  }): void {
    this.assertOpen();
    const name = input.name.trim();
    if (!name) throw new Error("Budget name is required.");
    if (this.exhausted.has(name)) return;
    this.exhausted.add(name);
    this.recordCaptureLoss({
      family: input.family,
      phaseId: input.phaseId === undefined ? this.active?.phaseId ?? null : input.phaseId,
      kind: input.kind ?? "cap",
      count: input.count ?? 1,
      detail: name
    });
  }

  finish(): { phases: PhaseSpan[]; detectors: DetectorLedger; budgetsExhausted: string[]; captureLoss: CaptureLossEntry[] } {
    if (!this.finished) {
      this.closeActive(this.elapsed());
      this.finished = true;
    }
    return {
      phases: this.phases.map((phase) => ({ ...phase })),
      detectors: cloneDetectorLedger(this.detectorState),
      budgetsExhausted: [...this.exhausted].sort(),
      captureLoss: this.losses.map((entry) => ({ ...entry }))
    };
  }

  qualityFacts(input: {
    status: number | null;
    botWallTitleMatched: boolean;
    navigationSettled: boolean;
  }): QualityFacts {
    const measurement = this.finish();
    return {
      status: input.status,
      botWallTitleMatched: input.botWallTitleMatched,
      navigationSettled: input.navigationSettled,
      budgetsExhausted: measurement.budgetsExhausted,
      captureLoss: measurement.captureLoss
    };
  }

  private closeActive(at: number): void {
    if (!this.active) return;
    this.active.endedAtMs = Math.max(this.active.startedAtMs, at);
    this.active = null;
  }

  private assertOpen(): void {
    if (this.finished) throw new Error("Measurement kernel is already finished.");
  }
}

export function deriveCookieMutations(
  snapshots: ReadonlyArray<{ phaseId: PhaseId; records: readonly CookieRecord[] }>
): CookieMutation[] {
  return deriveMutations(
    snapshots,
    (cookie) => `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`,
    (phaseId, op, cookie) => ({ phaseId, op, cookie: { ...cookie } })
  );
}

export function deriveStorageMutations(
  snapshots: ReadonlyArray<{ phaseId: PhaseId; records: readonly StorageRecord[] }>
): StorageMutation[] {
  return deriveMutations(
    snapshots,
    (entry) => `${entry.area}\u0000${entry.key}`,
    (phaseId, op, entry) => ({ phaseId, op, entry: { ...entry } })
  );
}

function deriveMutations<T, Mutation>(
  snapshots: ReadonlyArray<{ phaseId: PhaseId; records: readonly T[] }>,
  keyOf: (record: T) => string,
  mutation: (phaseId: PhaseId, op: "added" | "changed" | "removed", record: T) => Mutation
): Mutation[] {
  const result: Mutation[] = [];
  let previous = new Map<string, T>();
  for (const snapshot of snapshots) {
    const current = new Map(snapshot.records.map((record) => [keyOf(record), record]));
    for (const [key, record] of current) {
      const before = previous.get(key);
      if (before === undefined) result.push(mutation(snapshot.phaseId, "added", record));
      else if (canonicalJson(before) !== canonicalJson(record)) result.push(mutation(snapshot.phaseId, "changed", record));
    }
    for (const [key, record] of previous) {
      if (!current.has(key)) result.push(mutation(snapshot.phaseId, "removed", record));
    }
    previous = current;
  }
  return result;
}

function cloneDetectorLedger(source: DetectorLedger): DetectorLedger {
  return Object.fromEntries(
    DETECTOR_IDS.map((id) => [id, { ...source[id] }])
  ) as DetectorLedger;
}
