export const DEFAULT_DURABLE_SCAN_JOB_PUMP_BUDGET = Object.freeze({
  maxCoreItems: 8,
  maxOptionalItems: 2,
  wallTimeMs: 45_000,
  coreDispatchReserveMs: 15_000
});

export type DurableScanJobPumpBudget = Readonly<{
  /** Maximum lease/deadline/publication rows attempted in one callback. */
  maxCoreItems: number;
  /** Maximum optional-feature rows attempted after ordinary job dispatch. */
  maxOptionalItems: number;
  /** Hard target for the complete coordinator callback. */
  wallTimeMs: number;
  /** Time maintenance must leave available for claiming/activating ordinary jobs. */
  coreDispatchReserveMs: number;
}>;

export type DurableScanJobPumpPhase =
  | "expired-core"
  | "deadline-core"
  | "core-dispatch"
  | "optional-load"
  | "optional-item";

export type DurableScanJobPumpYieldReason =
  | "core-backlog"
  | "core-task-timeout"
  | "core-dispatch-failed"
  | "core-dispatch-timeout"
  | "wall-clock-budget"
  | "optional-backlog"
  | "optional-task-timeout"
  | "optional-produced-core-work";

export type DurableScanJobPumpTaskContext = Readonly<{
  signal: AbortSignal;
  /** Monotonic duration still owned by this task when it starts. */
  remainingTimeMs: number;
  turnStartedAt: number;
  turnDeadlineAt: number;
}>;

export type DurableScanJobPumpFailure = Readonly<{
  phase: DurableScanJobPumpPhase;
  item: unknown;
  error: unknown;
}>;

export type DurableScanJobPumpOptionalOutcome = Readonly<{
  /** True when optional work admitted an ordinary durable job for the next turn. */
  producedCoreWork: boolean;
}>;

export type DurableScanJobPumpTimer = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;

type MaybePromise<T> = T | Promise<T>;

export type DurableScanJobPumpDependencies<ExpiredItem, DeadlineItem, OptionalItem> = Readonly<{
  listExpiredCoreItems(): readonly ExpiredItem[];
  processExpiredCoreItem(
    item: ExpiredItem,
    context: DurableScanJobPumpTaskContext
  ): MaybePromise<void>;
  listDeadlineCoreItems(): readonly DeadlineItem[];
  processDeadlineCoreItem(
    item: DeadlineItem,
    context: DurableScanJobPumpTaskContext
  ): MaybePromise<void>;
  /** Claim/decrypt/activate ordinary jobs. This always precedes optional work. */
  dispatchCore(context: DurableScanJobPumpTaskContext): MaybePromise<void>;
  listOptionalItems(context: DurableScanJobPumpTaskContext): MaybePromise<readonly OptionalItem[]>;
  processOptionalItem(
    item: OptionalItem,
    context: DurableScanJobPumpTaskContext
  ): MaybePromise<DurableScanJobPumpOptionalOutcome>;
  /**
   * Persist an immediate replacement before this function resolves. A yielded
   * result is therefore proof that request-independent continuation is durable.
   */
  persistImmediateSuccessor(reason: DurableScanJobPumpYieldReason): MaybePromise<void>;
  onFailure?(failure: DurableScanJobPumpFailure): void;
  monotonicNow?: () => number;
  timer?: DurableScanJobPumpTimer;
}>;

export type DurableScanJobPumpTurnResult = Readonly<{
  status: "completed" | "yielded";
  yieldReason: DurableScanJobPumpYieldReason | null;
  attempted: Readonly<{
    expiredCore: number;
    deadlineCore: number;
    optional: number;
  }>;
  failures: number;
  producedCoreWork: boolean;
}>;

type MutableTurnState = {
  expiredCore: number;
  deadlineCore: number;
  optional: number;
  failures: number;
  producedCoreWork: boolean;
};

type OperationOutcome<T> =
  | Readonly<{ status: "completed"; value: T }>
  | Readonly<{ status: "failed"; error: unknown }>
  | Readonly<{ status: "timed-out"; error: DurableScanJobPumpTaskTimeoutError }>;

type CorePhaseOutcome = Readonly<{
  backlog: boolean;
  timedOut: boolean;
}>;

const SYSTEM_TIMER: DurableScanJobPumpTimer = {
  schedule(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  cancel(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  }
};

export class DurableScanJobPumpTaskTimeoutError extends Error {
  constructor(public readonly phase: DurableScanJobPumpPhase) {
    super(`The durable scan-job pump ${phase} task exhausted its turn budget.`);
    this.name = "DurableScanJobPumpTaskTimeoutError";
  }
}

/**
 * Run one bounded, request-independent coordinator turn.
 *
 * Core maintenance is attempted first, but it cannot consume the time reserved
 * for ordinary claim/activation. Optional work runs only after that dispatch.
 * Every yielded return awaits an injected durable immediate successor, so the
 * caller can safely return from a one-shot callback without relying on traffic.
 */
export async function runDurableScanJobPumpTurn<ExpiredItem, DeadlineItem, OptionalItem>(
  dependencies: DurableScanJobPumpDependencies<ExpiredItem, DeadlineItem, OptionalItem>,
  budget: DurableScanJobPumpBudget = DEFAULT_DURABLE_SCAN_JOB_PUMP_BUDGET
): Promise<DurableScanJobPumpTurnResult> {
  assertBudget(budget);
  const monotonicNow = dependencies.monotonicNow ?? defaultMonotonicNow;
  const timer = dependencies.timer ?? SYSTEM_TIMER;
  const turnStartedAt = readMonotonicTime(monotonicNow);
  const turnDeadlineAt = turnStartedAt + budget.wallTimeMs;
  if (!Number.isFinite(turnDeadlineAt)) throw new Error("Invalid durable pump turn deadline.");

  const state: MutableTurnState = {
    expiredCore: 0,
    deadlineCore: 0,
    optional: 0,
    failures: 0,
    producedCoreWork: false
  };

  const expired = dependencies.listExpiredCoreItems();
  const expiredOutcome = await processCorePhase({
    phase: "expired-core",
    items: expired,
    process: dependencies.processExpiredCoreItem,
    attempted: () => state.expiredCore + state.deadlineCore,
    increment: () => {
      state.expiredCore += 1;
    },
    dependencies,
    budget,
    state,
    monotonicNow,
    timer,
    turnStartedAt,
    turnDeadlineAt
  });

  let coreBacklog = expiredOutcome.backlog;
  let coreTimedOut = expiredOutcome.timedOut;

  if (!coreBacklog) {
    const deadline = dependencies.listDeadlineCoreItems();
    const deadlineOutcome = await processCorePhase({
      phase: "deadline-core",
      items: deadline,
      process: dependencies.processDeadlineCoreItem,
      attempted: () => state.expiredCore + state.deadlineCore,
      increment: () => {
        state.deadlineCore += 1;
      },
      dependencies,
      budget,
      state,
      monotonicNow,
      timer,
      turnStartedAt,
      turnDeadlineAt
    });
    coreBacklog = deadlineOutcome.backlog;
    coreTimedOut = deadlineOutcome.timedOut;
  }

  const dispatchRemaining = remainingTimeMs(monotonicNow, turnDeadlineAt);
  if (dispatchRemaining <= 0) {
    return yieldTurn(dependencies, state, coreTimedOut ? "core-task-timeout" : "wall-clock-budget");
  }
  const dispatch = await runBoundedOperation({
    phase: "core-dispatch",
    item: null,
    maximumDurationMs: dispatchRemaining,
    operation: dependencies.dispatchCore,
    monotonicNow,
    timer,
    turnStartedAt,
    turnDeadlineAt
  });
  if (dispatch.status === "timed-out") {
    recordFailure(dependencies, state, "core-dispatch", null, dispatch.error);
    return yieldTurn(dependencies, state, "core-dispatch-timeout");
  }
  if (dispatch.status === "failed") {
    recordFailure(dependencies, state, "core-dispatch", null, dispatch.error);
    return yieldTurn(dependencies, state, "core-dispatch-failed");
  }
  if (coreBacklog) {
    return yieldTurn(dependencies, state, coreTimedOut ? "core-task-timeout" : "core-backlog");
  }

  const optionalRemaining = remainingTimeMs(monotonicNow, turnDeadlineAt);
  if (optionalRemaining <= 0) {
    return yieldTurn(dependencies, state, "wall-clock-budget");
  }
  const optionalLoad = await runBoundedOperation({
    phase: "optional-load",
    item: null,
    maximumDurationMs: optionalRemaining,
    operation: dependencies.listOptionalItems,
    monotonicNow,
    timer,
    turnStartedAt,
    turnDeadlineAt
  });
  if (optionalLoad.status === "timed-out") {
    recordFailure(dependencies, state, "optional-load", null, optionalLoad.error);
    return yieldTurn(dependencies, state, "optional-task-timeout");
  }
  if (optionalLoad.status === "failed") {
    // Optional feature failure must not turn successful ordinary dispatch into
    // a core outage. Its own retained state determines the next normal wake.
    recordFailure(dependencies, state, "optional-load", null, optionalLoad.error);
    return completedResult(state);
  }

  const optionalItems = optionalLoad.value;
  for (let index = 0; index < optionalItems.length; index += 1) {
    if (state.optional >= budget.maxOptionalItems) {
      return yieldTurn(dependencies, state, "optional-backlog");
    }
    const remaining = remainingTimeMs(monotonicNow, turnDeadlineAt);
    if (remaining <= 0) return yieldTurn(dependencies, state, "wall-clock-budget");

    const item = optionalItems[index];
    state.optional += 1;
    const outcome = await runBoundedOperation({
      phase: "optional-item",
      item,
      maximumDurationMs: remaining,
      operation: (context) => dependencies.processOptionalItem(item, context),
      monotonicNow,
      timer,
      turnStartedAt,
      turnDeadlineAt
    });
    if (outcome.status === "timed-out") {
      recordFailure(dependencies, state, "optional-item", item, outcome.error);
      return yieldTurn(dependencies, state, "optional-task-timeout");
    }
    if (outcome.status === "failed") {
      recordFailure(dependencies, state, "optional-item", item, outcome.error);
      continue;
    }
    if (outcome.value.producedCoreWork) state.producedCoreWork = true;
  }

  if (state.producedCoreWork) {
    return yieldTurn(dependencies, state, "optional-produced-core-work");
  }
  return completedResult(state);
}

async function processCorePhase<Item, ExpiredItem, DeadlineItem, OptionalItem>(options: {
  phase: "expired-core" | "deadline-core";
  items: readonly Item[];
  process(item: Item, context: DurableScanJobPumpTaskContext): MaybePromise<void>;
  attempted(): number;
  increment(): void;
  dependencies: DurableScanJobPumpDependencies<ExpiredItem, DeadlineItem, OptionalItem>;
  budget: DurableScanJobPumpBudget;
  state: MutableTurnState;
  monotonicNow: () => number;
  timer: DurableScanJobPumpTimer;
  turnStartedAt: number;
  turnDeadlineAt: number;
}): Promise<CorePhaseOutcome> {
  for (let index = 0; index < options.items.length; index += 1) {
    if (options.attempted() >= options.budget.maxCoreItems) {
      return { backlog: true, timedOut: false };
    }
    const remaining = remainingTimeMs(options.monotonicNow, options.turnDeadlineAt);
    const maintenanceRemaining = remaining - options.budget.coreDispatchReserveMs;
    if (maintenanceRemaining <= 0) return { backlog: true, timedOut: false };

    const item = options.items[index];
    options.increment();
    const outcome = await runBoundedOperation({
      phase: options.phase,
      item,
      maximumDurationMs: maintenanceRemaining,
      operation: (context) => options.process(item, context),
      monotonicNow: options.monotonicNow,
      timer: options.timer,
      turnStartedAt: options.turnStartedAt,
      turnDeadlineAt: options.turnDeadlineAt
    });
    if (outcome.status === "timed-out") {
      recordFailure(options.dependencies, options.state, options.phase, item, outcome.error);
      return { backlog: true, timedOut: true };
    }
    if (outcome.status === "failed") {
      // A cancelled or newer-generation row can legitimately fence a stale
      // snapshot. Isolate that row and keep recovering independent jobs.
      recordFailure(options.dependencies, options.state, options.phase, item, outcome.error);
    }
  }
  return { backlog: false, timedOut: false };
}

async function runBoundedOperation<T>(options: {
  phase: DurableScanJobPumpPhase;
  item: unknown;
  maximumDurationMs: number;
  operation(context: DurableScanJobPumpTaskContext): MaybePromise<T>;
  monotonicNow: () => number;
  timer: DurableScanJobPumpTimer;
  turnStartedAt: number;
  turnDeadlineAt: number;
}): Promise<OperationOutcome<T>> {
  const maximumDurationMs = Math.max(1, Math.floor(options.maximumDurationMs));
  const controller = new AbortController();
  const context: DurableScanJobPumpTaskContext = {
    signal: controller.signal,
    remainingTimeMs: maximumDurationMs,
    turnStartedAt: options.turnStartedAt,
    turnDeadlineAt: options.turnDeadlineAt
  };

  let work: Promise<T>;
  try {
    // Invoke synchronously so a well-behaved task can attach its abort listener
    // before even an injected immediate test timer fires.
    work = Promise.resolve(options.operation(context));
  } catch (error) {
    return { status: "failed", error };
  }

  let timerHandle: unknown;
  const timeoutError = new DurableScanJobPumpTaskTimeoutError(options.phase);
  const timeout = new Promise<OperationOutcome<T>>((resolve) => {
    timerHandle = options.timer.schedule(() => {
      // Win the race before abort listeners reject the work promise, retaining
      // a deterministic timeout classification while still cancelling I/O.
      resolve({ status: "timed-out", error: timeoutError });
      controller.abort(timeoutError);
    }, maximumDurationMs);
  });
  const settled = work.then<OperationOutcome<T>, OperationOutcome<T>>(
    (value) => ({ status: "completed", value }),
    (error: unknown) => ({ status: "failed", error })
  );
  const outcome = await Promise.race([settled, timeout]);
  options.timer.cancel(timerHandle);

  if (outcome.status === "timed-out") {
    // Production tasks are required to honor the injected signal. Await their
    // abort settlement so no timed-out reconciliation or watch request can
    // mutate state after the coordinator has persisted its successor/returned.
    // This intentionally fails safe instead of detaching stateful work.
    await settled;
  }

  // Read the injected monotonic clock after every awaited boundary. Invalid
  // clocks are programmer/configuration errors and must not silently unbound a
  // critical callback.
  readMonotonicTime(options.monotonicNow);
  return outcome;
}

function recordFailure<ExpiredItem, DeadlineItem, OptionalItem>(
  dependencies: DurableScanJobPumpDependencies<ExpiredItem, DeadlineItem, OptionalItem>,
  state: MutableTurnState,
  phase: DurableScanJobPumpPhase,
  item: unknown,
  error: unknown
): void {
  state.failures += 1;
  try {
    dependencies.onFailure?.({ phase, item, error });
  } catch {
    // Diagnostics must never become another coordinator failure boundary.
  }
}

async function yieldTurn<ExpiredItem, DeadlineItem, OptionalItem>(
  dependencies: DurableScanJobPumpDependencies<ExpiredItem, DeadlineItem, OptionalItem>,
  state: MutableTurnState,
  reason: DurableScanJobPumpYieldReason
): Promise<DurableScanJobPumpTurnResult> {
  await dependencies.persistImmediateSuccessor(reason);
  return resultFromState(state, "yielded", reason);
}

function completedResult(state: MutableTurnState): DurableScanJobPumpTurnResult {
  return resultFromState(state, "completed", null);
}

function resultFromState(
  state: MutableTurnState,
  status: "completed" | "yielded",
  yieldReason: DurableScanJobPumpYieldReason | null
): DurableScanJobPumpTurnResult {
  return {
    status,
    yieldReason,
    attempted: {
      expiredCore: state.expiredCore,
      deadlineCore: state.deadlineCore,
      optional: state.optional
    },
    failures: state.failures,
    producedCoreWork: state.producedCoreWork
  };
}

function remainingTimeMs(monotonicNow: () => number, deadlineAt: number): number {
  return Math.max(0, deadlineAt - readMonotonicTime(monotonicNow));
}

function defaultMonotonicNow(): number {
  return globalThis.performance.now();
}

function readMonotonicTime(monotonicNow: () => number): number {
  const value = monotonicNow();
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("The durable pump monotonic clock returned an invalid value.");
  }
  return value;
}

function assertBudget(budget: DurableScanJobPumpBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid durable pump ${name} budget.`);
    }
  }
  if (budget.coreDispatchReserveMs >= budget.wallTimeMs) {
    throw new Error("The durable pump core dispatch reserve must be smaller than its wall-time budget.");
  }
}
