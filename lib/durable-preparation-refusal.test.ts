import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DURABLE_PREPARATION_REFUSAL_MAX_ROWS,
  DurablePreparationRefusalValidationError,
  countDurablePreparationRefusals,
  findDurablePreparationRefusal,
  isDefinitivePreparationRefusal,
  recordDurablePreparationRefusal
} from "./durable-preparation-refusal";
import {
  DURABLE_PREPARATION_RESERVATION_MAX_MS,
  releaseDurablePreparation,
  reserveDurablePreparation
} from "./durable-preparation-reservation";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";
import { assertOrdered, requireIndex, sliceToNext } from "./source-markers";

const WORKER = "cloudflare/container-worker.ts";
const worker = readFileSync(path.join(process.cwd(), "cloudflare", "container-worker.ts"), "utf8");
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const WINDOW_MS = 30_000;

function capability(seed: number): ArrayBuffer {
  return new Uint8Array(32).fill(seed).buffer;
}

/** The Durable Object's reserve step, in the order its source is pinned to below. */
function reserveUnlessRefused(sql: DurableScanJobStoreSql, capabilityHash: ArrayBuffer, now: number) {
  return (
    findDurablePreparationRefusal(sql, capabilityHash, now) ??
    reserveDurablePreparation(sql, capabilityHash, now, now + WINDOW_MS)
  );
}

test("a refused preparation's capability replayed serially buys no second preparation in its window", () => {
  withDatabase((sql) => {
    // The attempt reserves, Node refuses, the marker is written while the slot
    // is still held, and the finally releases it. Before the marker, the
    // release left nothing behind and the same solved token bought a fresh
    // preparation (with its DNS resolution) on every serial replay.
    const first = reserveUnlessRefused(sql, capability(1), NOW);
    assert.equal(first.status, "reserved");
    assert.equal(recordDurablePreparationRefusal(sql, capability(1), NOW + 100, NOW + WINDOW_MS), true);
    releaseDurablePreparation(sql, capability(1), first.status === "reserved" ? first.expiresAt : undefined);

    assert.deepEqual(reserveUnlessRefused(sql, capability(1), NOW + 200), {
      status: "refused",
      retryAfterSeconds: 30
    });
    assert.deepEqual(reserveUnlessRefused(sql, capability(1), NOW + WINDOW_MS - 1), {
      status: "refused",
      retryAfterSeconds: 1
    });
    // A different capability, which is what an honest client's next scan
    // carries, is unaffected.
    assert.equal(reserveUnlessRefused(sql, capability(2), NOW + 200).status, "reserved");

    // Bounded, not removed: one preparation per admission window per token.
    assert.equal(reserveUnlessRefused(sql, capability(1), NOW + WINDOW_MS).status, "reserved");
    assert.equal(countDurablePreparationRefusals(sql), 0);
  });
});

test("a refusal marker is clamped, bounded and never extended past the later deadline", () => {
  withDatabase((sql) => {
    // Clamped exactly as a reservation is, so a nonsensical deadline cannot
    // strand a capability beyond one admission window.
    assert.equal(recordDurablePreparationRefusal(sql, capability(1), NOW, NOW + 10 * DURABLE_PREPARATION_RESERVATION_MAX_MS), true);
    assert.deepEqual(findDurablePreparationRefusal(sql, capability(1), NOW), {
      status: "refused",
      retryAfterSeconds: Math.ceil(DURABLE_PREPARATION_RESERVATION_MAX_MS / 1000)
    });
    assert.equal(findDurablePreparationRefusal(sql, capability(1), NOW + DURABLE_PREPARATION_RESERVATION_MAX_MS), null);

    // Recording again keeps the later of the two expiries.
    recordDurablePreparationRefusal(sql, capability(2), NOW, NOW + 20_000);
    recordDurablePreparationRefusal(sql, capability(2), NOW + 1, NOW + 5_000);
    assert.equal(findDurablePreparationRefusal(sql, capability(2), NOW + 10_000)?.retryAfterSeconds, 10);

    // A window that is already over records nothing.
    assert.equal(recordDurablePreparationRefusal(sql, capability(3), NOW, NOW), false);
    assert.equal(findDurablePreparationRefusal(sql, capability(3), NOW), null);
  });
});

test("the refusal table stays bounded under churn and falls back to the reservation alone", () => {
  withDatabase((sql) => {
    for (let seed = 0; seed < DURABLE_PREPARATION_REFUSAL_MAX_ROWS; seed += 1) {
      assert.equal(recordDurablePreparationRefusal(sql, capability(seed), NOW, NOW + WINDOW_MS), true);
    }
    assert.equal(recordDurablePreparationRefusal(sql, capability(250), NOW, NOW + WINDOW_MS), false);
    assert.equal(countDurablePreparationRefusals(sql), DURABLE_PREPARATION_REFUSAL_MAX_ROWS);
    // An already-held capability may still refresh its own marker.
    assert.equal(recordDurablePreparationRefusal(sql, capability(0), NOW + 1, NOW + WINDOW_MS + 1), true);
    // Expired rows are purged before the bound is applied.
    assert.equal(recordDurablePreparationRefusal(sql, capability(250), NOW + WINDOW_MS + 1, NOW + 2 * WINDOW_MS), true);
    assert.equal(countDurablePreparationRefusals(sql), 1);
  });
});

test("malformed refusal inputs are rejected", () => {
  withDatabase((sql) => {
    assert.throws(
      () => recordDurablePreparationRefusal(sql, new ArrayBuffer(16), NOW, NOW + 1),
      DurablePreparationRefusalValidationError
    );
    assert.throws(() => recordDurablePreparationRefusal(sql, capability(1), -1, NOW), DurablePreparationRefusalValidationError);
    assert.throws(() => recordDurablePreparationRefusal(sql, capability(1), NOW, 1.5), DurablePreparationRefusalValidationError);
    assert.throws(() => findDurablePreparationRefusal(sql, capability(1), Number.NaN), DurablePreparationRefusalValidationError);
  });
});

test("only a definitive refusal of the request is remembered", () => {
  // An honest client keeps its capability after a 5xx or an outcome it could
  // not read, and retries it. Remembering a transient failure would refuse
  // that retry for something a moment later could have fixed.
  for (const status of [400, 403, 413, 422]) assert.equal(isDefinitivePreparationRefusal(status), true, String(status));
  for (const status of [200, 202, 302, 404, 429, 500, 502, 503, 504, Number.NaN]) {
    assert.equal(isDefinitivePreparationRefusal(status), false, String(status));
  }
});

test("the Worker records the refusal before it frees the slot, and answers a replay before any preparation", () => {
  // The DO checks the marker first, in the same transaction that reserves.
  const reserve = sliceToNext(worker, "reserveDurablePreparationSlot(input:", "recordDurablePreparationRefusal(input:", WORKER);
  assertOrdered(
    reserve,
    ["this.ctx.storage.transactionSync(", "findDurablePreparationRefusal(", "??", "reserveDurablePreparationInStore("],
    WORKER
  );

  // Recorded only in Node's definitive-refusal branch, and awaited before that
  // response is returned, so before the caller's finally releases the slot.
  const submit = sliceToNext(worker, "async function submitDurableScanJob(", "async function recordDefinitivePreparationRefusal(", WORKER);
  const refused = submit.slice(requireIndex(submit, "if (preparedResponse.status !== 202) {", WORKER));
  assertOrdered(
    refused,
    [
      "if (isDefinitivePreparationRefusal(preparedResponse.status)) {",
      "await recordDefinitivePreparationRefusal(env, scanAdmissionKey.capabilityHash, commitNotAfter);",
      "return new Response(new Uint8Array(preparedBody)"
    ],
    WORKER
  );
  assert.equal(worker.split("recordDefinitivePreparationRefusal(env,").length - 1, 1);

  // The replay is refused where the other reservation outcomes are, before
  // the deferred quota peek and the crossing to Node.
  const handler = worker.slice(requireIndex(worker, "reserveDurablePreparationSlot({", WORKER));
  assertOrdered(
    handler,
    ['if (reservation.status === "refused") {', "throw new DurablePreparationRefusedGateError();", '"defer",', "submitDurableScanJob("],
    WORKER
  );

  // A fixed sentence with no cause: the marker holds no refusal text to echo.
  assert.match(
    worker,
    /class DurablePreparationRefusedGateError extends EdgeScanGateError \{\s*constructor\(\) \{\s*super\("This scan request was already refused, so it was not prepared again\.", 409\);/
  );
});

function withDatabase(callback: (sql: DurableScanJobStoreSql) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    callback({
      exec<T extends Record<string, ArrayBuffer | string | number | null>>(
        query: string,
        ...bindings: Array<ArrayBuffer | string | number | null>
      ) {
        const statement = database.prepare(query);
        const sqliteBindings = bindings.map((binding) =>
          binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding
        );
        const isRead = /^\s*(SELECT|PRAGMA)\b/i.test(query);
        const rows = isRead ? (statement.all(...sqliteBindings) as T[]) : [];
        if (!isRead) statement.run(...sqliteBindings);
        return { toArray: () => rows };
      }
    });
  } finally {
    database.close();
  }
}
