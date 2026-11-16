// What a case's Durable Object keeps about the container its runner runs in: one row for each
// attempt it launched, and the calls that start one and destroy one. The object has one container
// (the platform gives it one), so attempts run in it one after another and never two at once.
//
// A start comes only after the owner's attempt-started has been written, and is never made twice
// for one attempt. Before it, any earlier run that is still running and has no destroy record is
// destroyed and recorded, and the start goes on only once that destroy has resolved. If it is
// refused, nothing is launched and the attempt is flagged. Each start registers the handler again,
// for the one address the runner calls, with the case, the slot and the attempt it was launched for
// as the handler's props: so the handler never takes those from a call. The start's environment
// holds four names and never the token, which the runner asks the handler for (ruling D-8).
//
// A start that throws, or a registration that is refused, writes no event: the object has no actor
// of its own. The attempt still reads as starting, the owner's open answer shows the flag, no token
// is ever handed for it, and the attempt's deadline ends it.
//
// The destroy record is set only when a destroy has resolved, and only for a slot that has a run.
// A slot whose container was never started has no destroy record, because nothing was destroyed:
// the owner's environment-destroyed rests on that record (ruling D-5). A stop for a slot whose run
// is not the latest one destroys nothing, so a late stop of an earlier attempt never ends a later
// attempt's container.
//
// NOT CLAIMED: anything about the platform's own container. Every test of this file runs against a
// stand-in that records its calls. Whether a start after a destroy gives a fresh container, whether
// an intercept outlives a restart of the object, and whether the exit of a container is reported
// after one, are not shown here.

import type { HostStorage } from "./case-host-stores";
import { SLOT_NAMES, type SlotName } from "./case-machine";

/**
 * The one name the runner reaches its handler by. The scanner's proxy refuses any name ending in
 * .internal by its shape, before any lookup, so a page's request to it is refused there whatever
 * the container's resolver answers.
 */
export const HANDLER_HOST = "case-handler.internal";
export const HANDLER_ORIGIN = `http://${HANDLER_HOST}`;

/** The names a start's environment holds, and no others. The token is not among them. */
export const START_ENV_NAMES: readonly string[] = ["SBL_ATTEMPT_ID", "SBL_CASE_ID", "SBL_HANDLER_ORIGIN", "SBL_SLOT"];

/** Whom the handler acts for: set by the object when it registers the handler for one start. */
export type HandlerProps = Readonly<{ caseId: string; slot: SlotName; attemptId: string }>;

/** The part of the platform's container this object uses. Read by its shape, never by a platform type. */
export type ContainerSeam = {
  readonly running: boolean;
  start(options: Readonly<{ env: Readonly<Record<string, string>>; enableInternet: boolean }>): void;
  monitor(): Promise<void>;
  destroy(): Promise<void>;
  interceptOutboundHttp(address: string, binding: unknown): Promise<void>;
};

export function isContainerSeam(value: unknown): value is ContainerSeam {
  const seam = value as Partial<ContainerSeam> | null;
  return typeof seam === "object" && seam !== null && "running" in seam && typeof seam.start === "function" && typeof seam.monitor === "function" && typeof seam.destroy === "function" && typeof seam.interceptOutboundHttp === "function";
}

/** Why a run's attempt is flagged for the owner. */
export type RunFlagReason = "container-start-failed" | "container-destroy-failed";

export type LaunchResult = "launched" | "no-container" | "already-started" | RunFlagReason;

export type RunnerRuns = Readonly<{
  /** Launch this attempt's container, once. Every refusal is recorded; nothing here throws. */
  launch(props: HandlerProps): Promise<LaunchResult>;
  /** Destroy this slot's container if it is the latest run and not yet destroyed, and record it when the destroy resolves. Throws when the destroy is refused. */
  destroy(slot: SlotName): Promise<void>;
  /** Slots whose run has been launched and not destroyed, latest first. */
  liveSlots(): readonly SlotName[];
  /** The flags of each run, for the owner's open answer. */
  flags(): readonly Readonly<{ slot: SlotName; reason: RunFlagReason }>[];
}>;

export type RunnerRunsWorld = Readonly<{
  storage: HostStorage;
  now: () => number;
  container: ContainerSeam | null;
  /** The handler's binding for one start, with its props. */
  handlerFor: ((props: HandlerProps) => unknown) | null;
  /** Called when a run is destroyed, so the token's records follow. */
  recordDestroyed: (slot: SlotName) => void;
  /** Called when a start is refused, so no token is ever handed for it. */
  recordStop: (slot: SlotName) => void;
  /** Called when the container's exit is reported for a run that is still the latest. */
  onExit: (slot: SlotName) => Promise<void>;
}>;

const isSlot = (value: unknown): value is SlotName => (SLOT_NAMES as readonly unknown[]).includes(value);

export function runnerRunsOver(world: RunnerRunsWorld): RunnerRuns {
  const { storage, now, container } = world;
  const { sql } = storage;
  sql.exec("CREATE TABLE IF NOT EXISTS runner_runs (slot TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, ordinal INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, start_failed_at_ms INTEGER, destroy_failed_at_ms INTEGER, destroyed_at_ms INTEGER)").toArray();

  type Run = Readonly<{ slot: SlotName; ordinal: number; destroyed: boolean }>;
  const runs = (): readonly Run[] =>
    sql
      .exec("SELECT slot, ordinal, destroyed_at_ms FROM runner_runs ORDER BY ordinal DESC")
      .toArray()
      .flatMap((row) => (isSlot(row.slot) ? [{ slot: row.slot, ordinal: Number(row.ordinal), destroyed: row.destroyed_at_ms !== null }] : []));
  const latest = (): Run | undefined => runs()[0];
  const mark = (slot: SlotName, column: "start_failed_at_ms" | "destroy_failed_at_ms" | "destroyed_at_ms"): void => {
    sql.exec(`UPDATE runner_runs SET ${column} = ? WHERE slot = ? AND ${column} IS NULL`, now(), slot).toArray();
  };

  async function destroy(slot: SlotName): Promise<void> {
    const newest = latest();
    // No run for this slot, a run already destroyed, or a later run in the container: nothing of this slot's is live.
    if (container === null || newest === undefined || newest.slot !== slot || newest.destroyed) return;
    await container.destroy();
    // Only once the destroy has resolved.
    mark(slot, "destroyed_at_ms");
    world.recordDestroyed(slot);
  }

  return {
    async launch(props) {
      if (container === null || world.handlerFor === null) return "no-container";
      const { slot, attemptId } = props;
      if (sql.exec("SELECT slot FROM runner_runs WHERE slot = ?", slot).toArray().length > 0) return "already-started";
      const before = latest();
      const ordinal = before === undefined ? 1 : before.ordinal + 1;
      sql.exec("INSERT INTO runner_runs (slot, attempt_id, ordinal, started_at_ms) VALUES (?, ?, ?, ?)", slot, attemptId, ordinal, now()).toArray();
      // Never two runs at once: a live earlier run is destroyed, and recorded, before this one starts.
      if (before !== undefined && !before.destroyed && container.running) {
        try {
          await container.destroy();
          mark(before.slot, "destroyed_at_ms");
          world.recordDestroyed(before.slot);
        } catch {
          mark(slot, "destroy_failed_at_ms");
          world.recordStop(slot);
          return "container-destroy-failed";
        }
      }
      try {
        await container.interceptOutboundHttp(HANDLER_HOST, world.handlerFor(props));
        container.start({ env: { SBL_ATTEMPT_ID: attemptId, SBL_CASE_ID: props.caseId, SBL_HANDLER_ORIGIN: HANDLER_ORIGIN, SBL_SLOT: slot }, enableInternet: false });
      } catch {
        mark(slot, "start_failed_at_ms");
        world.recordStop(slot);
        return "container-start-failed";
      }
      // The exit of this run, however it ends, ends it here too. A later run is never touched by it.
      const exited = async (): Promise<void> => {
        const newest = latest();
        if (newest?.slot !== slot || newest.destroyed) return;
        try {
          await world.onExit(slot);
        } catch {
          // The stop is recorded either way; the attempt's deadline asks again.
        }
      };
      container.monitor().then(exited, exited);
      return "launched";
    },

    destroy,

    liveSlots() {
      return runs()
        .filter(({ destroyed }) => !destroyed)
        .map(({ slot }) => slot);
    },

    flags() {
      return sql
        .exec("SELECT slot, start_failed_at_ms, destroy_failed_at_ms FROM runner_runs ORDER BY ordinal")
        .toArray()
        .flatMap((row): Readonly<{ slot: SlotName; reason: RunFlagReason }>[] => {
          if (!isSlot(row.slot)) return [];
          if (row.destroy_failed_at_ms !== null) return [{ slot: row.slot, reason: "container-destroy-failed" }];
          if (row.start_failed_at_ms !== null) return [{ slot: row.slot, reason: "container-start-failed" }];
          return [];
        });
    }
  };
}
