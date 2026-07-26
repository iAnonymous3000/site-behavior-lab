import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DURABLE_PREPARATION_RESERVATION_MAX_MS,
  DURABLE_PREPARATION_RESERVATION_MAX_ROWS,
  DurablePreparationReservationValidationError,
  countDurablePreparations,
  purgeExpiredDurablePreparations,
  releaseDurablePreparation,
  reserveDurablePreparation
} from "./durable-preparation-reservation";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";

const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);
const WINDOW_MS = 30_000;

function capability(seed: number): ArrayBuffer {
  return new Uint8Array(32).fill(seed).buffer;
}

test("one capability may hold only one uncommitted preparation at a time", () => {
  withDatabase((sql) => {
    // This is the amplification the activation gate names: Turnstile redemption
    // is idempotent per capability, so one solved token replayed concurrently
    // used to buy N preparations (each with its own DNS resolution) for the
    // price of one challenge.
    const first = reserveDurablePreparation(sql, capability(1), NOW, NOW + WINDOW_MS);
    assert.deepEqual(first, { status: "reserved", expiresAt: NOW + WINDOW_MS });

    const replay = reserveDurablePreparation(sql, capability(1), NOW + 5, NOW + 5 + WINDOW_MS);
    assert.equal(replay.status, "in-flight");
    assert.equal(countDurablePreparations(sql), 1);

    // A different capability is unaffected: this bounds replay, not throughput.
    assert.equal(reserveDurablePreparation(sql, capability(2), NOW, NOW + WINDOW_MS).status, "reserved");
    assert.equal(countDurablePreparations(sql), 2);
  });
});

test("releasing frees the slot immediately, so an honest sequential retry is never blocked", () => {
  withDatabase((sql) => {
    reserveDurablePreparation(sql, capability(1), NOW, NOW + WINDOW_MS);
    releaseDurablePreparation(sql, capability(1));
    assert.equal(countDurablePreparations(sql), 0);

    const again = reserveDurablePreparation(sql, capability(1), NOW + 10, NOW + 10 + WINDOW_MS);
    assert.equal(again.status, "reserved");
  });
});

test("releasing a capability that holds nothing is not an error", () => {
  withDatabase((sql) => {
    // The release runs in a finally; a caller that failed before reserving must
    // not turn its own earlier failure into a second, more confusing one.
    assert.doesNotThrow(() => releaseDurablePreparation(sql, capability(9)));
    assert.equal(countDurablePreparations(sql), 0);
  });
});

test("a stranded reservation expires with the admission window that held it", () => {
  withDatabase((sql) => {
    // A crashed isolate never runs its finally. The row must not outlive one
    // admission window, or a single crash would strand that capability.
    reserveDurablePreparation(sql, capability(1), NOW, NOW + WINDOW_MS);

    const during = reserveDurablePreparation(sql, capability(1), NOW + WINDOW_MS - 1, NOW + WINDOW_MS + 10);
    assert.equal(during.status, "in-flight");
    assert.equal(during.status === "in-flight" && during.retryAfterSeconds >= 1, true);

    const after = reserveDurablePreparation(sql, capability(1), NOW + WINDOW_MS, NOW + WINDOW_MS + WINDOW_MS);
    assert.equal(after.status, "reserved");
    assert.equal(countDurablePreparations(sql), 1);
  });
});

test("a reservation may not outlive one admission window, and must expire after it starts", () => {
  withDatabase((sql) => {
    assert.throws(
      () =>
        reserveDurablePreparation(
          sql,
          capability(1),
          NOW,
          NOW + DURABLE_PREPARATION_RESERVATION_MAX_MS + 1
        ),
      DurablePreparationReservationValidationError
    );
    assert.throws(
      () => reserveDurablePreparation(sql, capability(1), NOW, NOW),
      DurablePreparationReservationValidationError
    );
    assert.equal(countDurablePreparations(sql), 0);
  });
});

test("concurrent distinct capabilities are bounded, and the refusal names a real wait", () => {
  withDatabase((sql) => {
    for (let index = 0; index < DURABLE_PREPARATION_RESERVATION_MAX_ROWS; index += 1) {
      const reservation = reserveDurablePreparation(
        sql,
        distinctCapability(index),
        NOW,
        NOW + WINDOW_MS
      );
      assert.equal(reservation.status, "reserved");
    }

    const surplus = reserveDurablePreparation(
      sql,
      distinctCapability(DURABLE_PREPARATION_RESERVATION_MAX_ROWS),
      NOW,
      NOW + WINDOW_MS
    );
    assert.equal(surplus.status, "at-capacity");
    // Every surviving row is unexpired, so the advertised wait is the nearest
    // real expiry and never zero.
    assert.equal(surplus.status === "at-capacity" && surplus.retryAfterSeconds >= 1, true);
    assert.equal(countDurablePreparations(sql), DURABLE_PREPARATION_RESERVATION_MAX_ROWS);

    // Once the window passes, the purge reclaims every slot.
    assert.equal(
      purgeExpiredDurablePreparations(sql, NOW + WINDOW_MS),
      DURABLE_PREPARATION_RESERVATION_MAX_ROWS
    );
    assert.equal(countDurablePreparations(sql), 0);
  });
});

test("the reservation table stores only a digest and two timestamps", () => {
  withDatabase((sql, database) => {
    reserveDurablePreparation(sql, capability(1), NOW, NOW + WINDOW_MS);
    const columns = database
      .prepare("SELECT name FROM pragma_table_info('durable_preparations')")
      .all()
      .map((row) => String((row as { name: unknown }).name))
      .sort();
    assert.deepEqual(columns, ["capability_hash", "expires_at", "reserved_at"]);
  });
});

test("a malformed capability digest or timestamp is refused before any write", () => {
  withDatabase((sql) => {
    assert.throws(
      () => reserveDurablePreparation(sql, new Uint8Array(31).buffer, NOW, NOW + WINDOW_MS),
      DurablePreparationReservationValidationError
    );
    assert.throws(
      () => reserveDurablePreparation(sql, capability(1), Number.NaN, NOW + WINDOW_MS),
      DurablePreparationReservationValidationError
    );
    assert.throws(
      () => releaseDurablePreparation(sql, new Uint8Array(64).buffer),
      DurablePreparationReservationValidationError
    );
    assert.equal(countDurablePreparations(sql), 0);
  });
});

function distinctCapability(index: number): ArrayBuffer {
  const bytes = new Uint8Array(32);
  bytes[0] = index & 0xff;
  bytes[1] = (index >> 8) & 0xff;
  return bytes.buffer;
}

function withDatabase(callback: (sql: DurableScanJobStoreSql, database: DatabaseSync) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    callback(
      {
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
      },
      database
    );
  } finally {
    database.close();
  }
}
