// What a case's Durable Object keeps beside the log to watch its deadlines: a small table of
// marks in the object's own storage, and one alarm set to the earliest mark not yet flagged.
//
// An alarm writes nothing to the case log. It has no actor: the log takes an owner's entry
// only inside the life of the token that vouches for it, and an alarm holds no token. So when
// a mark comes due the alarm asks for the attempt's runner to be stopped, flags the mark here,
// and stops. The deadline or reconcile event is written later, by the owner, as a signed command
// through the same path as any other. Until then the log still reads the attempt as running, and
// the machine refuses the next visit. The machine compares no time, so a deadline written long
// after it passed is accepted as written, at the time it was written.
//
// A mark exists while the case's state wants it, and the table is brought back to what the
// state wants every time the object folds the case: on each open and after each command. A mark
// is wanted for the case's deadline while the case is open, for an attempt's deadline while that
// attempt runs, and for reconcile while an attempt runs or a cleanup is pending. A mark the state
// no longer wants is deleted, so a deadline the owner already wrote leaves nothing to flag.
//
// An attempt's marks are also written ahead of the command that starts it, so a kill between the
// log's commit and this table cannot leave a running attempt with no alarm. A start that is then
// refused leaves marks the next fold deletes.
//
// Alarms are delivered at least once. A second delivery finds no mark that is due and not yet
// flagged, asks for no stop and flags nothing. If stopping the runner fails, nothing is flagged
// and the alarm is left to be delivered again, so a stop may be asked for twice: whatever fills
// that seam must take a second stop of the same attempt as done.
//
// NOT CLAIMED: that a mark comes due on time, or at all while the platform delivers no alarm.
// The durations below are this file's own defaults. No owner ruling sets them.

import { isRunningPhase, SLOT_NAMES, type MachineState, type SlotName } from "./case-machine";
import type { HostStorage } from "./case-host-stores";

export type DueKind = "attempt-deadline" | "reconcile" | "case-deadline";

/** How long after a mark is first wanted it comes due, by kind. */
export type Deadlines = Readonly<Record<DueKind, number>>;

/** Fifteen minutes for an attempt, thirty before reconcile is due, a day for the case. Defaults, not rulings. */
export const DEFAULT_DEADLINES: Deadlines = Object.freeze({ "attempt-deadline": 15 * 60_000, reconcile: 30 * 60_000, "case-deadline": 24 * 60 * 60_000 });

const DUE_KINDS: readonly DueKind[] = ["attempt-deadline", "reconcile", "case-deadline"];

/** One mark: what is watched, when it comes due, and when an alarm flagged it, if one has. */
export type DueMark = Readonly<{ kind: DueKind; slot: SlotName | null; dueAtMs: number; flaggedAtMs: number | null }>;

/** The alarm calls of a Durable Object's storage. */
export type AlarmStorage = HostStorage & { setAlarm(scheduledTimeMs: number): Promise<void> | void; deleteAlarm(): Promise<void> | void };

export function isAlarmStorage(storage: HostStorage): storage is AlarmStorage {
  const alarms = storage as Partial<AlarmStorage>;
  return typeof alarms.setAlarm === "function" && typeof alarms.deleteAlarm === "function";
}

type Wanted = Readonly<{ kind: DueKind; slot: SlotName | null }>;

/** The marks this state wants watched. A log with no plan, and a closed case with nothing pending, want none. */
export function wantedMarks(machine: MachineState | null): readonly Wanted[] {
  if (machine === null) return [];
  const running = machine.attempts.filter(({ phase }) => isRunningPhase(phase));
  const wanted: Wanted[] = running.map(({ slot }) => ({ kind: "attempt-deadline", slot }));
  if (running.length > 0 || machine.attempts.some(({ cleanup }) => cleanup === "pending")) wanted.push({ kind: "reconcile", slot: null });
  if (machine.closedBy === null) wanted.push({ kind: "case-deadline", slot: null });
  return wanted;
}

/** A mark is shown only while the state still wants it, whatever the table holds. */
export function isWanted(machine: MachineState | null, mark: Pick<DueMark, "kind" | "slot">): boolean {
  return wantedMarks(machine).some(({ kind, slot }) => kind === mark.kind && slot === mark.slot);
}

/** A mark as a caller may hold it: a known kind, a slot of the machine or none, and whole times. Anything else is no mark. */
export function isDueMark(value: unknown): value is DueMark {
  if (typeof value !== "object" || value === null) return false;
  const { kind, slot, dueAtMs, flaggedAtMs } = value as Partial<DueMark>;
  return (
    (DUE_KINDS as readonly unknown[]).includes(kind) &&
    (kind === "attempt-deadline" ? (SLOT_NAMES as readonly unknown[]).includes(slot) : slot === null) &&
    Number.isSafeInteger(dueAtMs) &&
    (flaggedAtMs === null || Number.isSafeInteger(flaggedAtMs))
  );
}

export type Supervision = Readonly<{
  /** Bring the table to what this state wants, and set the alarm to the earliest mark not flagged. */
  sync(machine: MachineState | null): Promise<void>;
  /** Write an attempt's marks ahead of the command that starts it. */
  prepareStart(slot: SlotName): Promise<void>;
  /** The marks an alarm has flagged that this state still wants. */
  flagged(machine: MachineState | null): readonly DueMark[];
  /** What the object's alarm runs. How many marks it flagged. */
  alarm(): Promise<number>;
}>;

export type SupervisionWorld = Readonly<{
  storage: AlarmStorage;
  now: () => number;
  deadlines: Deadlines;
  /** Stops the runner of this slot's attempt. The runner does not exist yet, so nothing fills this. */
  stopRunner: (slot: SlotName) => Promise<void>;
}>;

/** A slot is stored as its name, and a mark of the whole case as the empty string, so the pair is a key. */
const slotKey = (slot: SlotName | null): string => slot ?? "";

export function supervisionOver({ storage, now, deadlines, stopRunner }: SupervisionWorld): Supervision {
  const { sql } = storage;
  sql.exec("CREATE TABLE IF NOT EXISTS due_marks (kind TEXT NOT NULL, slot TEXT NOT NULL, due_at_ms INTEGER NOT NULL, flagged_at_ms INTEGER, PRIMARY KEY (kind, slot))").toArray();

  function marks(): DueMark[] {
    return sql
      .exec("SELECT kind, slot, due_at_ms, flagged_at_ms FROM due_marks ORDER BY due_at_ms, kind, slot")
      .toArray()
      .map((row) => ({ kind: row.kind, slot: row.slot === "" ? null : row.slot, dueAtMs: row.due_at_ms, flaggedAtMs: row.flagged_at_ms }))
      .filter(isDueMark);
  }

  /** A mark that is not there yet, due its kind's duration from now. One already there keeps its time and its flag. */
  function ensure(wanted: Wanted, atMs: number): void {
    sql.exec("INSERT INTO due_marks (kind, slot, due_at_ms, flagged_at_ms) VALUES (?, ?, ?, NULL) ON CONFLICT (kind, slot) DO NOTHING", wanted.kind, slotKey(wanted.slot), atMs + deadlines[wanted.kind]).toArray();
  }

  /** The alarm follows the table: the earliest mark not flagged, or no alarm when every mark is flagged or none is left. */
  async function arm(): Promise<void> {
    const [next] = marks().filter(({ flaggedAtMs }) => flaggedAtMs === null);
    if (next === undefined) await storage.deleteAlarm();
    else await storage.setAlarm(next.dueAtMs);
  }

  return {
    async sync(machine) {
      const wanted = wantedMarks(machine);
      const atMs = now();
      storage.transactionSync(() => {
        for (const mark of marks()) {
          if (!wanted.some(({ kind, slot }) => kind === mark.kind && slot === mark.slot)) sql.exec("DELETE FROM due_marks WHERE kind = ? AND slot = ?", mark.kind, slotKey(mark.slot)).toArray();
        }
        // Rows of a kind or slot this code does not know are not marks, and nothing wants them.
        sql.exec("DELETE FROM due_marks WHERE kind NOT IN ('attempt-deadline', 'reconcile', 'case-deadline')").toArray();
        for (const mark of wanted) ensure(mark, atMs);
      });
      await arm();
    },

    async prepareStart(slot) {
      const atMs = now();
      storage.transactionSync(() => {
        ensure({ kind: "attempt-deadline", slot }, atMs);
        ensure({ kind: "reconcile", slot: null }, atMs);
      });
      await arm();
    },

    flagged(machine) {
      return marks().filter((mark) => mark.flaggedAtMs !== null && isWanted(machine, mark));
    },

    async alarm() {
      const atMs = now();
      const due = marks().filter(({ flaggedAtMs, dueAtMs }) => flaggedAtMs === null && dueAtMs <= atMs);
      // The stop comes first. If it fails nothing is flagged, and the alarm is delivered again.
      for (const { kind, slot } of due) if (kind === "attempt-deadline" && slot !== null) await stopRunner(slot);
      storage.transactionSync(() => {
        for (const { kind, slot } of due) sql.exec("UPDATE due_marks SET flagged_at_ms = ? WHERE kind = ? AND slot = ? AND flagged_at_ms IS NULL", atMs, kind, slotKey(slot)).toArray();
      });
      await arm();
      return due.length;
    }
  };
}
