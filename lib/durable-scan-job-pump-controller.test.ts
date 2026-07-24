import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DurableScanJobPumpTaskTimeoutError,
  runDurableScanJobPumpTurn,
  type DurableScanJobPumpBudget,
  type DurableScanJobPumpDependencies,
  type DurableScanJobPumpTaskContext,
  type DurableScanJobPumpTimer,
  type DurableScanJobPumpYieldReason
} from "./durable-scan-job-pump-controller";

const TEST_BUDGET: DurableScanJobPumpBudget = {
  maxCoreItems: 8,
  maxOptionalItems: 2,
  wallTimeMs: 100,
  coreDispatchReserveMs: 20
};

type TestDependencies = DurableScanJobPumpDependencies<string, string, string>;

function dependencies(overrides: Partial<TestDependencies> = {}): TestDependencies {
  return {
    listExpiredCoreItems: () => [],
    processExpiredCoreItem: () => undefined,
    listDeadlineCoreItems: () => [],
    processDeadlineCoreItem: () => undefined,
    dispatchCore: () => undefined,
    listOptionalItems: () => [],
    processOptionalItem: () => ({ producedCoreWork: false }),
    persistImmediateSuccessor: () => undefined,
    monotonicNow: () => 0,
    ...overrides
  };
}

test("core recovery and ordinary dispatch always precede optional work", async () => {
  const events: string[] = [];
  const result = await runDurableScanJobPumpTurn(
    dependencies({
      listExpiredCoreItems: () => {
        events.push("list-expired");
        return ["lease"];
      },
      processExpiredCoreItem: (item) => {
        events.push(`expired:${item}`);
      },
      listDeadlineCoreItems: () => {
        events.push("list-deadline");
        return ["deadline"];
      },
      processDeadlineCoreItem: (item) => {
        events.push(`deadline:${item}`);
      },
      dispatchCore: () => {
        events.push("dispatch-core");
      },
      listOptionalItems: () => {
        events.push("list-optional");
        return ["watch"];
      },
      processOptionalItem: (item) => {
        events.push(`optional:${item}`);
        return { producedCoreWork: true };
      },
      persistImmediateSuccessor: (reason) => {
        events.push(`persist:${reason}`);
      }
    }),
    TEST_BUDGET
  );

  assert.deepEqual(events, [
    "list-expired",
    "expired:lease",
    "list-deadline",
    "deadline:deadline",
    "dispatch-core",
    "list-optional",
    "optional:watch",
    "persist:optional-produced-core-work"
  ]);
  assert.deepEqual(result, {
    status: "yielded",
    yieldReason: "optional-produced-core-work",
    attempted: { expiredCore: 1, deadlineCore: 1, optional: 1 },
    failures: 0,
    producedCoreWork: true
  });
});

test("a core backlog is batch-bounded without starving ordinary dispatch", async () => {
  const events: string[] = [];
  let scheduled = { id: "future", at: 60_000 };
  const result = await runDurableScanJobPumpTurn(
    dependencies({
      listExpiredCoreItems: () => ["one", "two", "three"],
      processExpiredCoreItem: (item) => {
        events.push(`recover:${item}`);
      },
      listDeadlineCoreItems: () => {
        events.push("deadline-list-must-not-run");
        return [];
      },
      dispatchCore: () => {
        events.push("dispatch-core");
      },
      listOptionalItems: () => {
        events.push("optional-must-not-run");
        return [];
      },
      persistImmediateSuccessor: (reason) => {
        assert.equal(reason, "core-backlog");
        scheduled = { id: "immediate-successor", at: 0 };
        events.push("replace-schedule");
      }
    }),
    { ...TEST_BUDGET, maxCoreItems: 2 }
  );

  assert.deepEqual(events, ["recover:one", "recover:two", "dispatch-core", "replace-schedule"]);
  assert.deepEqual(scheduled, { id: "immediate-successor", at: 0 });
  assert.equal(result.status, "yielded");
  assert.equal(result.yieldReason, "core-backlog");
  assert.deepEqual(result.attempted, { expiredCore: 2, deadlineCore: 0, optional: 0 });
});

test("sequential reconciliation cannot consume the core dispatch reserve", async () => {
  let now = 0;
  const taskBudgets: number[] = [];
  let dispatchBudget = 0;
  const result = await runDurableScanJobPumpTurn(
    dependencies({
      monotonicNow: () => now,
      listExpiredCoreItems: () => ["publish-1", "publish-2", "publish-3", "publish-4"],
      processExpiredCoreItem: (_item, context) => {
        taskBudgets.push(context.remainingTimeMs);
        now += Math.min(30, context.remainingTimeMs);
      },
      dispatchCore: (context) => {
        dispatchBudget = context.remainingTimeMs;
      }
    }),
    { ...TEST_BUDGET, maxCoreItems: 10 }
  );

  assert.deepEqual(taskBudgets, [80, 50, 20]);
  assert.equal(dispatchBudget, 20);
  assert.equal(result.status, "yielded");
  assert.equal(result.yieldReason, "core-backlog");
  assert.deepEqual(result.attempted, { expiredCore: 3, deadlineCore: 0, optional: 0 });
});

test("a hung optional preparation is aborted and cannot delay core dispatch", async () => {
  const events: string[] = [];
  const failures: Array<{ phase: string; error: unknown }> = [];
  let aborted = false;
  const result = await runDurableScanJobPumpTurn(
    dependencies({
      dispatchCore: () => {
        events.push("dispatch-core");
      },
      listOptionalItems: () => ["hung-watch", "later-watch"],
      processOptionalItem: (item, context) => {
        events.push(`optional:${item}`);
        return new Promise((_, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(context.signal.reason);
            },
            { once: true }
          );
        });
      },
      persistImmediateSuccessor: (reason) => {
        events.push(`persist:${reason}`);
      },
      onFailure: ({ phase, error }) => failures.push({ phase, error }),
      timer: timerFiringOnSchedule(3)
    }),
    TEST_BUDGET
  );

  assert.equal(aborted, true);
  assert.deepEqual(events, [
    "dispatch-core",
    "optional:hung-watch",
    "persist:optional-task-timeout"
  ]);
  assert.equal(result.yieldReason, "optional-task-timeout");
  assert.deepEqual(result.attempted, { expiredCore: 0, deadlineCore: 0, optional: 1 });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].phase, "optional-item");
  assert.ok(failures[0].error instanceof DurableScanJobPumpTaskTimeoutError);
});

test("cancelled and stale rows are isolated from independent recovery", async () => {
  class StateConflict extends Error {}
  const processed: string[] = [];
  const failures: string[] = [];
  const result = await runDurableScanJobPumpTurn(
    dependencies({
      listExpiredCoreItems: () => ["cancelled", "stale-generation", "healthy"],
      processExpiredCoreItem: (item) => {
        processed.push(item);
        if (item !== "healthy") throw new StateConflict(item);
      },
      listDeadlineCoreItems: () => ["past-deadline"],
      processDeadlineCoreItem: (item) => {
        processed.push(item);
      },
      dispatchCore: () => {
        processed.push("dispatch-core");
      },
      onFailure: ({ error }) => {
        if (error instanceof Error) failures.push(error.message);
      }
    }),
    TEST_BUDGET
  );

  assert.deepEqual(processed, [
    "cancelled",
    "stale-generation",
    "healthy",
    "past-deadline",
    "dispatch-core"
  ]);
  assert.deepEqual(failures, ["cancelled", "stale-generation"]);
  assert.equal(result.status, "completed");
  assert.equal(result.failures, 2);
});

test("one optional row failure does not suppress later watch admission", async () => {
  const processed: string[] = [];
  const successorReasons: DurableScanJobPumpYieldReason[] = [];
  const result = await runDurableScanJobPumpTurn(
    dependencies({
      listOptionalItems: () => ["broken", "healthy"],
      processOptionalItem: (item) => {
        processed.push(item);
        if (item === "broken") throw new Error("watch was deleted during preparation");
        return { producedCoreWork: true };
      },
      persistImmediateSuccessor: (reason) => {
        successorReasons.push(reason);
      }
    }),
    TEST_BUDGET
  );

  assert.deepEqual(processed, ["broken", "healthy"]);
  assert.deepEqual(successorReasons, ["optional-produced-core-work"]);
  assert.equal(result.failures, 1);
  assert.equal(result.producedCoreWork, true);
});

test("optional backlog is independently batch-bounded after core dispatch", async () => {
  const events: string[] = [];
  const result = await runDurableScanJobPumpTurn(
    dependencies({
      dispatchCore: () => {
        events.push("dispatch-core");
      },
      listOptionalItems: () => ["watch-1", "watch-2", "watch-3"],
      processOptionalItem: (item) => {
        events.push(item);
        return { producedCoreWork: false };
      },
      persistImmediateSuccessor: (reason) => {
        events.push(`persist:${reason}`);
      }
    }),
    { ...TEST_BUDGET, maxOptionalItems: 1 }
  );

  assert.deepEqual(events, ["dispatch-core", "watch-1", "persist:optional-backlog"]);
  assert.equal(result.yieldReason, "optional-backlog");
  assert.deepEqual(result.attempted, { expiredCore: 0, deadlineCore: 0, optional: 1 });
});

test("an optional loader failure does not convert successful core dispatch into an outage", async () => {
  let dispatched = false;
  let persisted = false;
  const result = await runDurableScanJobPumpTurn(
    dependencies({
      dispatchCore: () => {
        dispatched = true;
      },
      listOptionalItems: () => {
        throw new Error("optional keyring unavailable");
      },
      persistImmediateSuccessor: () => {
        persisted = true;
      }
    }),
    TEST_BUDGET
  );

  assert.equal(dispatched, true);
  assert.equal(persisted, false);
  assert.equal(result.status, "completed");
  assert.equal(result.failures, 1);
});

test("a hung core dispatch yields through a persisted immediate successor", async () => {
  let optionalLoaded = false;
  let aborted = false;
  const reasons: DurableScanJobPumpYieldReason[] = [];
  const result = await runDurableScanJobPumpTurn(
    dependencies({
      dispatchCore: (context) => abortOnly(context, () => {
        aborted = true;
      }),
      listOptionalItems: () => {
        optionalLoaded = true;
        return [];
      },
      persistImmediateSuccessor: (reason) => {
        reasons.push(reason);
      },
      timer: immediateTimer()
    }),
    TEST_BUDGET
  );

  assert.equal(aborted, true);
  assert.equal(optionalLoaded, false);
  assert.deepEqual(reasons, ["core-dispatch-timeout"]);
  assert.equal(result.yieldReason, "core-dispatch-timeout");
});

test("a yielded turn does not resolve before its replacement is durable", async () => {
  let releaseSuccessor: () => void = () => undefined;
  const successor = new Promise<void>((resolve) => {
    releaseSuccessor = resolve;
  });
  let settled = false;
  const pending = runDurableScanJobPumpTurn(
    dependencies({
      listExpiredCoreItems: () => ["one", "two"],
      persistImmediateSuccessor: () => successor
    }),
    { ...TEST_BUDGET, maxCoreItems: 1 }
  ).then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  releaseSuccessor();
  assert.equal((await pending).status, "yielded");
  assert.equal(settled, true);
});

test("a timeout waits for abort settlement so work cannot mutate after return", async () => {
  let releaseAbortCleanup: () => void = () => undefined;
  const abortCleanup = new Promise<void>((resolve) => {
    releaseAbortCleanup = resolve;
  });
  let abortObserved = false;
  let successorPersisted = false;
  let settled = false;
  const pending = runDurableScanJobPumpTurn(
    dependencies({
      dispatchCore: (context) =>
        new Promise((_, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              void abortCleanup.then(() => reject(context.signal.reason));
            },
            { once: true }
          );
        }),
      persistImmediateSuccessor: () => {
        successorPersisted = true;
      },
      timer: immediateTimer()
    }),
    TEST_BUDGET
  ).then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(abortObserved, true);
  assert.equal(settled, false);
  assert.equal(successorPersisted, false);

  releaseAbortCleanup();
  const result = await pending;
  assert.equal(result.yieldReason, "core-dispatch-timeout");
  assert.equal(successorPersisted, true);
  assert.equal(settled, true);
});

test("invalid callback budgets fail closed", async () => {
  await assert.rejects(
    runDurableScanJobPumpTurn(dependencies(), { ...TEST_BUDGET, maxCoreItems: 0 }),
    /Invalid durable pump maxCoreItems budget/
  );
  await assert.rejects(
    runDurableScanJobPumpTurn(dependencies(), { ...TEST_BUDGET, coreDispatchReserveMs: 100 }),
    /core dispatch reserve must be smaller/
  );
});

function immediateTimer(): DurableScanJobPumpTimer {
  return timerFiringOnSchedule(1);
}

function timerFiringOnSchedule(target: number): DurableScanJobPumpTimer {
  let schedules = 0;
  return {
    schedule(callback) {
      schedules += 1;
      if (schedules === target) callback();
      return Symbol("immediate timer");
    },
    cancel() {
      /* already fired */
    }
  };
}

function abortOnly(context: DurableScanJobPumpTaskContext, onAbort: () => void): Promise<never> {
  return new Promise((_, reject) => {
    context.signal.addEventListener(
      "abort",
      () => {
        onAbort();
        reject(context.signal.reason);
      },
      { once: true }
    );
  });
}
