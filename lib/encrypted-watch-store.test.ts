import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  ENCRYPTED_WATCH_CADENCE_MS,
  ENCRYPTED_WATCH_GLOBAL_DAILY_RUN_BUDGET,
  ENCRYPTED_WATCH_MAX_ACTIVE,
  ENCRYPTED_WATCH_MAX_RUNS,
  ENCRYPTED_WATCH_TTL_MS,
  type EncryptedWatchPayload
} from "./encrypted-watch-contract";
import {
  EncryptedWatchCapacityError,
  EncryptedWatchCryptoError,
  EncryptedWatchStateError,
  EncryptedWatchValidationError,
  admitEncryptedWatch,
  chargeEncryptedWatchGlobalBudget,
  claimDueEncryptedWatches,
  createEncryptedWatchAdmission,
  createEncryptedWatchCredential,
  createEncryptedWatchCredentialFromToken,
  createEncryptedWatchLeaseCredentials,
  decryptEncryptedWatchClaim,
  deleteEncryptedWatch,
  ensureEncryptedWatchStore,
  findEncryptedWatchByCapability,
  hashEncryptedWatchCapabilityToken,
  hashEncryptedWatchLeaseToken,
  importEncryptedWatchKeyring,
  nextEncryptedWatchWakeAt,
  peekEncryptedWatchGlobalBudget,
  purgeExpiredEncryptedWatches,
  recordEncryptedWatchRunTerminalOutcome,
  recoverExpiredEncryptedWatchLeases,
  resolveEncryptedWatchLease,
  type EncryptedWatchAdmission,
  type EncryptedWatchCredential,
  type EncryptedWatchKeyring,
  type EncryptedWatchStoreSql
} from "./encrypted-watch-store";

const KEY_A = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64url");
const KEY_B = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => 255 - index)).toString("base64url");
const KEY_C = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) % 256)).toString("base64url");

test("keyrings enforce canonical distinct keys and support stable dual-key rotation", async () => {
  const old = await importEncryptedWatchKeyring({ current: KEY_A });
  const rotated = await importEncryptedWatchKeyring({ current: KEY_B, previous: KEY_A });
  assert.equal(rotated.previous?.keyId, old.current.keyId);
  assert.notEqual(rotated.current.keyId, rotated.previous?.keyId);
  await assert.rejects(
    () => importEncryptedWatchKeyring({ current: KEY_A, previous: KEY_A }),
    EncryptedWatchValidationError
  );
  await assert.rejects(() => importEncryptedWatchKeyring({ current: `${KEY_A}=` }), EncryptedWatchValidationError);
  await assert.rejects(() => importEncryptedWatchKeyring({ current: KEY_A.slice(1) }), EncryptedWatchValidationError);
});

test("credentials are opaque and only their SHA-256 digest enters an authenticated encrypted admission", async () => {
  const keyring = await importEncryptedWatchKeyring({ current: KEY_A });
  const credential = await watchCredential(1);
  assert.equal(credential.watchId.length, 32);
  assert.equal(credential.token.length, 43);
  assert.equal(credential.tokenHash.byteLength, 32);
  assert.deepEqual(
    Buffer.from(await hashEncryptedWatchCapabilityToken(credential.token)),
    Buffer.from(credential.tokenHash)
  );

  const first = await admission(keyring, credential, 1_000, 1);
  const second = await admission(keyring, credential, 1_000, 1, 99);
  assert.notDeepEqual(Buffer.from(first.envelope.nonce), Buffer.from(second.envelope.nonce));
  assert.notDeepEqual(Buffer.from(first.envelope.ciphertext), Buffer.from(second.envelope.ciphertext));
  assert.equal(first.nextRunAt, 1_000 + ENCRYPTED_WATCH_CADENCE_MS);
  assert.equal(first.expiresAt, 1_000 + ENCRYPTED_WATCH_TTL_MS);

  const forged = { ...credential, tokenHash: new Uint8Array(32).buffer } as EncryptedWatchCredential;
  await assert.rejects(() => admission(keyring, forged, 1_000, 1), EncryptedWatchValidationError);
});

test("a browser-held capability deterministically reconstructs one idempotent opaque watch identity", async () => {
  const tokenBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  const token = Buffer.from(tokenBytes).toString("base64url");
  const first = await createEncryptedWatchCredentialFromToken(token);
  const retry = await createEncryptedWatchCredentialFromToken(token);
  assert.notEqual(first, retry);
  assert.deepEqual(retry, first);
  assert.equal(first.watchId.length, 32);
  assert.notEqual(first.watchId, Buffer.from(first.tokenHash).subarray(0, 16).toString("hex"));
  assert.deepEqual(Buffer.from(first.tokenHash), Buffer.from(await hashEncryptedWatchCapabilityToken(token)));

  const keyring = await importEncryptedWatchKeyring({ current: KEY_A });
  await admission(keyring, first, 1_500, 15);
  await admission(keyring, retry, 1_500, 15, 151);
  await assert.rejects(
    () => createEncryptedWatchCredentialFromToken(`${token}=`),
    EncryptedWatchValidationError
  );
  await assert.rejects(
    () => createEncryptedWatchCredentialFromToken(token.slice(1)),
    EncryptedWatchValidationError
  );
});

test("structurally valid low-shape tokens stay domain-separated and cannot remap an existing locator", async () => {
  await withDatabase(async (database, sql) => {
    const zeroToken = Buffer.from(new Uint8Array(32)).toString("base64url");
    const oneToken = Buffer.from(new Uint8Array(32).fill(0xff)).toString("base64url");
    const zero = await createEncryptedWatchCredentialFromToken(zeroToken);
    const one = await createEncryptedWatchCredentialFromToken(oneToken);
    assert.notEqual(zero.watchId, one.watchId);
    assert.notEqual(zero.watchId, "0".repeat(32));
    assert.notEqual(one.watchId, "f".repeat(32));

    const keyring = await importEncryptedWatchKeyring({ current: KEY_A });
    admitEncryptedWatch(sql, await admission(keyring, zero, 1_600, 16));
    const retryAdmission = await admission(keyring, await createEncryptedWatchCredentialFromToken(zeroToken), 1_600, 16, 161);
    assert.throws(() => admitEncryptedWatch(sql, retryAdmission), EncryptedWatchStateError);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM encrypted_watches").get()?.count, 1);
    assert.equal(
      findEncryptedWatchByCapability(sql, {
        watchId: zero.watchId,
        capabilityHash: retryAdmission.capabilityHash,
        now: 1_601
      })?.watchId,
      zero.watchId
    );
  });
});

test("SQLite stores no target, options, raw capability, or caller identity", async () => {
  await withDatabase(async (database, sql) => {
    const keyring = await importEncryptedWatchKeyring({ current: KEY_A });
    const credential = await watchCredential(2);
    admitEncryptedWatch(sql, await admission(keyring, credential, 2_000, 2));

    const columns = database
      .prepare("PRAGMA table_info(encrypted_watches)")
      .all()
      .map((column) => String(column.name));
    for (const forbiddenColumn of ["url", "target", "options", "capability_token", "client_ip", "client_key"]) {
      assert.equal(columns.includes(forbiddenColumn), false);
    }
    const row = database
      .prepare(
        "SELECT capability_hash, payload_nonce, payload_options_binding, payload_ciphertext FROM encrypted_watches"
      )
      .get();
    if (
      !row ||
      !(row.capability_hash instanceof Uint8Array) ||
      !(row.payload_nonce instanceof Uint8Array) ||
      !(row.payload_options_binding instanceof Uint8Array) ||
      !(row.payload_ciphertext instanceof Uint8Array)
    ) {
      throw new Error("Expected an encrypted watch row.");
    }
    assert.deepEqual(Buffer.from(row.capability_hash), Buffer.from(credential.tokenHash));
    assert.equal(Buffer.from(row.capability_hash).includes(Buffer.from(credential.token)), false);
    const ciphertext = Buffer.from(row.payload_ciphertext);
    for (const forbidden of [
      "https://private.example/sensitive-path",
      "private.example",
      "sensitive-path",
      "desktop",
      "gpcEnabled",
      credential.token,
      "203.0.113"
    ]) {
      assert.equal(ciphertext.includes(Buffer.from(forbidden)), false);
    }
  });
});

test("initial linkage is atomic, metadata-only auth is capability scoped, and terminal truth is durable", async () => {
  await withDatabase(async (_database, sql) => {
    const keyring = await importEncryptedWatchKeyring({ current: KEY_A });
    const credential = await watchCredential(3);
    const createdAt = 3_000;
    const admitted = admitEncryptedWatch(sql, await admission(keyring, credential, createdAt, 3));
    assert.equal(admitted.runCount, 1);
    assert.equal(admitted.history.length, 1);
    assert.deepEqual(admitted.history[0], {
      runNumber: 1,
      outcome: "admitted",
      jobId: idFor(3),
      reportId: idFor(10_003),
      admittedAt: createdAt,
      recordedAt: createdAt,
      terminalOutcome: null,
      terminalErrorCode: null,
      terminalAt: null
    });

    assert.equal(
      findEncryptedWatchByCapability(sql, {
        watchId: credential.watchId,
        capabilityHash: await hashEncryptedWatchCapabilityToken(credential.token),
        now: createdAt + 1
      })?.watchId,
      credential.watchId
    );
    const wrongHash = new Uint8Array(32).buffer;
    assert.equal(
      findEncryptedWatchByCapability(sql, { watchId: credential.watchId, capabilityHash: wrongHash, now: createdAt + 1 }),
      null
    );

    const terminal = recordEncryptedWatchRunTerminalOutcome(sql, {
      jobId: idFor(3),
      now: createdAt + 10,
      resolution: { outcome: "succeeded" }
    });
    assert.equal(terminal?.history[0].terminalOutcome, "succeeded");
    assert.equal(terminal?.history[0].terminalAt, createdAt + 10);
    assert.equal(
      recordEncryptedWatchRunTerminalOutcome(sql, {
        jobId: idFor(3),
        now: createdAt + 20,
        resolution: { outcome: "succeeded" }
      })?.history[0].terminalAt,
      createdAt + 10,
      "identical terminal replay must not rewrite the original observation time"
    );
    assert.throws(
      () =>
        recordEncryptedWatchRunTerminalOutcome(sql, {
          jobId: idFor(3),
          now: createdAt + 20,
          resolution: { outcome: "failed", errorCode: "execution-failed" }
        }),
      EncryptedWatchStateError
    );
  });
});

test("AES-GCM authenticates row identity, policy, options binding, and rotates through one previous key", async () => {
  await withDatabase(async (_database, sql) => {
    const old = await importEncryptedWatchKeyring({ current: KEY_A });
    const firstCredential = await watchCredential(4);
    const secondCredential = await watchCredential(5);
    const createdAt = 4_000;
    admitEncryptedWatch(sql, await admission(old, firstCredential, createdAt, 4));
    admitEncryptedWatch(sql, await admission(old, secondCredential, createdAt, 5));
    const dueAt = createdAt + ENCRYPTED_WATCH_CADENCE_MS;
    const claims = claimDueEncryptedWatches(sql, {
      now: dueAt,
      capacity: 2,
      credentials: await leaseCredentials(2, 20)
    });
    assert.equal(claims.length, 2);

    const rotated = await importEncryptedWatchKeyring({ current: KEY_B, previous: KEY_A });
    assert.deepEqual(await decryptEncryptedWatchClaim(rotated, claims[0]), payload());
    const noPrevious = await importEncryptedWatchKeyring({ current: KEY_B });
    await assert.rejects(() => decryptEncryptedWatchClaim(noPrevious, claims[0]), EncryptedWatchCryptoError);

    await assert.rejects(
      () => decryptEncryptedWatchClaim(rotated, { ...claims[0], envelope: claims[1].envelope }),
      EncryptedWatchCryptoError
    );
    const tamperedCiphertext = new Uint8Array(claims[0].envelope.ciphertext.slice(0));
    tamperedCiphertext[0] ^= 1;
    await assert.rejects(
      () =>
        decryptEncryptedWatchClaim(rotated, {
          ...claims[0],
          envelope: { ...claims[0].envelope, ciphertext: tamperedCiphertext.buffer }
        }),
      EncryptedWatchCryptoError
    );
    const tamperedBinding = new Uint8Array(claims[0].envelope.optionsBinding.slice(0));
    tamperedBinding[0] ^= 1;
    await assert.rejects(
      () =>
        decryptEncryptedWatchClaim(rotated, {
          ...claims[0],
          envelope: { ...claims[0].envelope, optionsBinding: tamperedBinding.buffer }
        }),
      EncryptedWatchCryptoError
    );
  });
});

test("due leasing is one-in-flight, fenced, and never catches up in bursts", async () => {
  await withDatabase(async (_database, sql) => {
    const keyring = await importEncryptedWatchKeyring({ current: KEY_A });
    const credential = await watchCredential(6);
    const createdAt = 6_000;
    admitEncryptedWatch(sql, await admission(keyring, credential, createdAt, 6));
    assert.deepEqual(
      claimDueEncryptedWatches(sql, { now: createdAt + ENCRYPTED_WATCH_CADENCE_MS - 1, capacity: 1, credentials: await leaseCredentials(1, 30) }),
      []
    );
    const lateAt = createdAt + 20 * 24 * 60 * 60 * 1_000;
    const [claim] = claimDueEncryptedWatches(sql, {
      now: lateAt,
      capacity: 1,
      credentials: await leaseCredentials(1, 31)
    });
    assert.ok(claim);
    assert.deepEqual(
      claimDueEncryptedWatches(sql, { now: lateAt + 1, capacity: 1, credentials: await leaseCredentials(1, 32) }),
      []
    );
    const wrongHash = new Uint8Array(await hashEncryptedWatchLeaseToken(claim.leaseToken));
    wrongHash[0] ^= 1;
    assert.throws(
      () =>
        resolveEncryptedWatchLease(sql, {
          watchId: claim.watchId,
          generation: claim.leaseGeneration,
          tokenHash: wrongHash.buffer,
          now: lateAt + 2,
          resolution: { outcome: "failed" }
        }),
      EncryptedWatchStateError
    );
    const resolved = resolveEncryptedWatchLease(sql, {
      watchId: claim.watchId,
      generation: claim.leaseGeneration,
      tokenHash: await hashEncryptedWatchLeaseToken(claim.leaseToken),
      now: lateAt + 2,
      resolution: { outcome: "failed" }
    });
    assert.equal(resolved.nextRunAt, lateAt + 2 + ENCRYPTED_WATCH_CADENCE_MS);
    assert.equal(resolved.runCount, 2);
    assert.equal(resolved.history[1].outcome, "failed");
  });
});

test("expired leases consume one bounded attempt and a deleted watch fences its old owner", async () => {
  await withDatabase(async (database, sql) => {
    const keyring = await importEncryptedWatchKeyring({ current: KEY_A });
    const credential = await watchCredential(7);
    const createdAt = 7_000;
    admitEncryptedWatch(sql, await admission(keyring, credential, createdAt, 7));
    const [claim] = claimDueEncryptedWatches(sql, {
      now: createdAt + ENCRYPTED_WATCH_CADENCE_MS,
      capacity: 1,
      credentials: await leaseCredentials(1, 40)
    });
    assert.equal(recoverExpiredEncryptedWatchLeases(sql, claim.leaseExpiresAt), 1);
    const recovered = findEncryptedWatchByCapability(sql, {
      watchId: credential.watchId,
      capabilityHash: credential.tokenHash,
      now: claim.leaseExpiresAt
    });
    assert.equal(recovered?.runCount, 2);
    assert.equal(recovered?.history[1].outcome, "failed");

    const secondDue = recovered?.nextRunAt ?? 0;
    const [secondClaim] = claimDueEncryptedWatches(sql, {
      now: secondDue,
      capacity: 1,
      credentials: await leaseCredentials(1, 41)
    });
    assert.equal(deleteEncryptedWatch(sql, { watchId: credential.watchId, capabilityHash: credential.tokenHash }), true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM encrypted_watch_runs").get()?.count, 0);
    assert.throws(
      () =>
        resolveEncryptedWatchLease(sql, {
          watchId: secondClaim.watchId,
          generation: secondClaim.leaseGeneration,
          tokenHash: secondClaim.envelope.optionsBinding,
          now: secondDue + 1,
          resolution: { outcome: "failed" }
        }),
      EncryptedWatchStateError
    );
  });
});

test("five total runs complete the watch and wipe target ciphertext without catch-up", async () => {
  await withDatabase(async (database, sql) => {
    const keyring = await importEncryptedWatchKeyring({ current: KEY_A });
    const credential = await watchCredential(8);
    const createdAt = 8_000;
    let snapshot = admitEncryptedWatch(sql, await admission(keyring, credential, createdAt, 8));
    for (let runNumber = 2; runNumber <= ENCRYPTED_WATCH_MAX_RUNS; runNumber += 1) {
      const now = snapshot.nextRunAt;
      if (now === null) throw new Error("Expected another due encrypted-watch run.");
      const [claim] = claimDueEncryptedWatches(sql, {
        now,
        capacity: 1,
        credentials: await leaseCredentials(1, 50 + runNumber)
      });
      snapshot = resolveEncryptedWatchLease(sql, {
        watchId: claim.watchId,
        generation: claim.leaseGeneration,
        tokenHash: await hashEncryptedWatchLeaseToken(claim.leaseToken),
        now: now + 1,
        resolution: { outcome: "failed" }
      });
    }
    assert.equal(snapshot.state, "completed");
    assert.equal(snapshot.runCount, ENCRYPTED_WATCH_MAX_RUNS);
    assert.equal(snapshot.history.length, ENCRYPTED_WATCH_MAX_RUNS);
    assert.equal(snapshot.nextRunAt, null);
    const row = database
      .prepare(
        "SELECT payload_key_id, payload_nonce, payload_options_binding, payload_ciphertext, lease_token_hash, lease_expires_at FROM encrypted_watches WHERE watch_id = ?"
      )
      .get(credential.watchId);
    assert.deepEqual({ ...row }, {
      payload_key_id: null,
      payload_nonce: null,
      payload_options_binding: null,
      payload_ciphertext: null,
      lease_token_hash: null,
      lease_expires_at: null
    });
  });
});

test("hard TTL and explicit deletion remove ciphertext, metadata, digest, and history", async () => {
  await withDatabase(async (database, sql) => {
    const keyring = await importEncryptedWatchKeyring({ current: KEY_A });
    const credential = await watchCredential(9);
    const createdAt = 9_000;
    admitEncryptedWatch(sql, await admission(keyring, credential, createdAt, 9));
    assert.equal(purgeExpiredEncryptedWatches(sql, createdAt + ENCRYPTED_WATCH_TTL_MS - 1), 0);
    assert.equal(purgeExpiredEncryptedWatches(sql, createdAt + ENCRYPTED_WATCH_TTL_MS), 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM encrypted_watches").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM encrypted_watch_runs").get()?.count, 0);
  });
});

test("active-watch and global UTC-day budgets are authoritative", async () => {
  await withDatabase(async (_database, sql) => {
    const keyring = await importEncryptedWatchKeyring({ current: KEY_C });
    for (let index = 0; index < ENCRYPTED_WATCH_MAX_ACTIVE; index += 1) {
      const credential = await watchCredential(100 + index);
      admitEncryptedWatch(sql, await admission(keyring, credential, 100_000, 100 + index));
    }
    const overflow = await watchCredential(999);
    const overflowAdmission = await admission(keyring, overflow, 100_000, 999);
    assert.throws(
      () => admitEncryptedWatch(sql, overflowAdmission),
      EncryptedWatchCapacityError
    );

    const now = 200_000;
    assert.equal(chargeEncryptedWatchGlobalBudget(sql, { now, cost: 32 }).used, 32);
    assert.equal(chargeEncryptedWatchGlobalBudget(sql, { now, cost: 32 }).used, 64);
    assert.equal(chargeEncryptedWatchGlobalBudget(sql, { now, cost: 32 }).used, 96);
    assert.equal(chargeEncryptedWatchGlobalBudget(sql, { now, cost: 4 }).used, ENCRYPTED_WATCH_GLOBAL_DAILY_RUN_BUDGET);
    const denied = chargeEncryptedWatchGlobalBudget(sql, { now, cost: 1 });
    assert.equal(denied.allowed, false);
    assert.equal(denied.remaining, 0);
    assert.equal(peekEncryptedWatchGlobalBudget(sql, { now: denied.resetsAt, cost: 1 }).used, 0);
  });
});

test("budget exhaustion defers a due wake to reset without postponing an earlier lease or TTL fence", async () => {
  await withDatabase(async (_database, sql) => {
    const keyring = await importEncryptedWatchKeyring({ current: KEY_A });
    const credential = await watchCredential(10);
    const createdAt = 10_000;
    const snapshot = admitEncryptedWatch(sql, await admission(keyring, credential, createdAt, 10));
    const dueAt = snapshot.nextRunAt ?? 0;
    for (const cost of [32, 32, 32, 4]) chargeEncryptedWatchGlobalBudget(sql, { now: dueAt, cost });
    const budget = peekEncryptedWatchGlobalBudget(sql, { now: dueAt, cost: 1 });
    assert.equal(budget.allowed, false);
    assert.equal(nextEncryptedWatchWakeAt(sql, dueAt), budget.resetsAt);
  });
});

function payload(): EncryptedWatchPayload {
  return {
    version: 1,
    target: { url: "https://private.example/sensitive-path" },
    options: { device: "desktop", gpcEnabled: false, reportMode: "r2", comparison: "none" }
  };
}

async function watchCredential(seed: number): Promise<EncryptedWatchCredential> {
  return createEncryptedWatchCredential((length) => deterministicBytes(length, seed));
}

async function admission(
  keyring: EncryptedWatchKeyring,
  credential: EncryptedWatchCredential,
  createdAt: number,
  id: number,
  nonceSeed = id
): Promise<EncryptedWatchAdmission> {
  return createEncryptedWatchAdmission(
    keyring,
    {
      credential,
      createdAt,
      payload: payload(),
      initialRun: { jobId: idFor(id), reportId: idFor(id + 10_000), admittedAt: createdAt }
    },
    (length) => deterministicBytes(length, nonceSeed)
  );
}

async function leaseCredentials(count: number, seed: number) {
  let offset = 0;
  return createEncryptedWatchLeaseCredentials(count, (length) => deterministicBytes(length, seed + offset++));
}

function deterministicBytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (seed * 17 + index * 29 + 11) % 256);
}

function idFor(index: number): string {
  return `20260719-${index.toString(16).padStart(32, "0")}`;
}

async function withDatabase(
  callback: (database: DatabaseSync, sql: EncryptedWatchStoreSql) => Promise<void> | void
): Promise<void> {
  const database = new DatabaseSync(":memory:");
  try {
    const sql: EncryptedWatchStoreSql = {
      exec<T extends Record<string, ArrayBuffer | string | number | null>>(
        query: string,
        ...bindings: Array<ArrayBuffer | string | number | null>
      ) {
        const statement = database.prepare(query);
        const sqliteBindings = bindings.map((binding) =>
          binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding
        );
        const isRead = /^\s*(SELECT|PRAGMA)\b/i.test(query);
        const rows = isRead
          ? statement.all(...sqliteBindings).map((row) => normalizeSqliteRow(row) as T)
          : [];
        if (!isRead) statement.run(...sqliteBindings);
        return { toArray: () => rows };
      }
    };
    ensureEncryptedWatchStore(sql);
    await callback(database, sql);
  } finally {
    database.close();
  }
}

function normalizeSqliteRow(row: Record<string, unknown>): Record<string, ArrayBuffer | string | number | null> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array ? Uint8Array.from(value).buffer : (value as string | number | null)
    ])
  );
}
