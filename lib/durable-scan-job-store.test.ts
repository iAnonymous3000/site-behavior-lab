import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS,
  DURABLE_SCAN_JOB_PUBLICATION_TIMEOUT_MS,
  DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS,
  type DurableScanJobPayload
} from "./durable-scan-job-contract";
import {
  DURABLE_SCAN_JOB_DEADLINE_MS,
  DURABLE_SCAN_JOB_LEASE_MS,
  DURABLE_SCAN_JOB_MAX_NONTERMINAL,
  DURABLE_SCAN_JOB_MAX_ROWS,
  DURABLE_SCAN_JOB_PURGE_MS,
  DurableScanJobCapacityError,
  DurableScanJobCryptoError,
  DurableScanJobStateError,
  DurableScanJobValidationError,
  admitDurableScanJob,
  beginPublishingDurableScanJob,
  cancelDurableScanJob,
  claimDurableScanJobs,
  createDurableScanJobAdmission,
  createDurableScanJobLeaseCredentials,
  decryptDurableScanJobClaim,
  earliestDurableScanJobPurgeAt,
  ensureDurableScanJobStore,
  expireDurableScanJob,
  findDurableScanJobSnapshot,
  hashDurableScanJobLeaseToken,
  heartbeatDurableScanJob,
  importDurableScanJobEncryptionKey,
  listExpiredDurableScanJobLeases,
  listPastDeadlineDurableScanJobs,
  purgeDurableScanJobs,
  reconcileExpiredPublishingDurableScanJob,
  requeueOrFailExpiredDurableScanJobLease,
  resolveDurableScanJob,
  settlePastPurgeDurableScanJobs,
  type DurableScanJobAdmission,
  type DurableScanJobClaim,
  type DurableScanJobEncryptionKey,
  type DurableScanJobLeaseCredential,
  type DurableScanJobStoreSql
} from "./durable-scan-job-store";

const KEY_WIRE = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64url");
const WRONG_KEY_WIRE = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => 255 - index)).toString(
  "base64url"
);

test("encryption keys and the durable payload DTO are strict and canonical", async () => {
  const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
  assert.equal(key.keyId, "v1");
  await assert.rejects(() => importDurableScanJobEncryptionKey(`${KEY_WIRE}=`), DurableScanJobValidationError);
  await assert.rejects(() => importDurableScanJobEncryptionKey(KEY_WIRE.slice(1)), DurableScanJobValidationError);
  await assert.rejects(() => importDurableScanJobEncryptionKey(`${KEY_WIRE.slice(0, -1)}!`), DurableScanJobValidationError);

  const createdAt = 1_000;
  const valid = payload(createdAt);
  await assert.rejects(
    () =>
      createDurableScanJobAdmission(key, {
        jobId: idFor(1),
        reportId: idFor(10_001),
        createdAt,
        payload: { ...valid, clientKey: "203.0.113.10" } as unknown as DurableScanJobPayload
      }),
    DurableScanJobValidationError
  );
  await assert.rejects(
    () =>
      createDurableScanJobAdmission(key, {
        jobId: idFor(1),
        reportId: idFor(10_001),
        createdAt,
        payload: { ...valid, url: "https://private.example/path?secret=yes" }
      }),
    DurableScanJobValidationError
  );
  await assert.rejects(
    () =>
      createDurableScanJobAdmission(key, {
        jobId: idFor(1),
        reportId: idFor(10_001),
        createdAt,
        payload: { ...valid, compareGpc: true, compareConsent: true, rateLimitCost: 2 }
      }),
    DurableScanJobValidationError
  );
  await assert.rejects(
    () =>
      createDurableScanJobAdmission(key, {
        jobId: idFor(1),
        reportId: idFor(10_001),
        createdAt,
        payload: { ...valid, admittedAt: createdAt + 1 }
      }),
    DurableScanJobValidationError
  );
});

test("the durable store schema sentinel fails closed across incompatible rollouts", async () => {
  await withDatabase((database, sql) => {
    ensureDurableScanJobStore(sql);
    assert.equal(
      Number(database.prepare("SELECT version FROM durable_scan_job_schema WHERE singleton = 1").get()?.version),
      1
    );
    database.exec("UPDATE durable_scan_job_schema SET version = 2 WHERE singleton = 1");
    assert.throws(() => ensureDurableScanJobStore(sql), DurableScanJobValidationError);
  });
});

test("AES-GCM is nondeterministic and authenticates ciphertext, identity, and metadata", async () => {
  await withDatabase(async (_database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    const input = {
      jobId: idFor(2),
      reportId: idFor(10_002),
      createdAt: 2_000,
      payload: payload(2_000, { compareConsent: true, rateLimitCost: 2 as const })
    };
    const first = await createDurableScanJobAdmission(key, input);
    const second = await createDurableScanJobAdmission(key, input);
    assert.notDeepEqual(Buffer.from(first.envelope.nonce), Buffer.from(second.envelope.nonce));
    assert.notDeepEqual(Buffer.from(first.envelope.ciphertext), Buffer.from(second.envelope.ciphertext));

    admitDurableScanJob(sql, first);
    const [credential] = await createDurableScanJobLeaseCredentials(1);
    const [claim] = claimDurableScanJobs(sql, { now: 2_001, capacity: 1, credentials: [credential] });
    assert.deepEqual(await decryptDurableScanJobClaim(key, claim), input.payload);
    assert.deepEqual(
      await decryptDurableScanJobClaim(key, { ...claim, envelope: second.envelope }),
      input.payload
    );

    const tamperedBytes = new Uint8Array(claim.envelope.ciphertext.slice(0));
    tamperedBytes[0] ^= 1;
    const tampered: DurableScanJobClaim = {
      ...claim,
      envelope: { ...claim.envelope, ciphertext: tamperedBytes.buffer }
    };
    await assert.rejects(() => decryptDurableScanJobClaim(key, tampered), DurableScanJobCryptoError);
    const wrongKey = await importDurableScanJobEncryptionKey(WRONG_KEY_WIRE);
    await assert.rejects(() => decryptDurableScanJobClaim(wrongKey, claim), DurableScanJobCryptoError);
    await assert.rejects(
      () => decryptDurableScanJobClaim(key, { ...claim, reportId: idFor(20_002) }),
      DurableScanJobCryptoError
    );
  });
});

test("SQLite never stores payload plaintext or caller/body credential fields", async () => {
  await withDatabase(async (database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    const secretUrl = "https://private.example/sensitive-path";
    const admission = await makeAdmission(key, 3, 3_000, { url: secretUrl });
    admitDurableScanJob(sql, admission);

    const columns = database
      .prepare("PRAGMA table_info(durable_scan_jobs)")
      .all()
      .map((column) => String(column.name));
    assert.equal(
      columns.some((column) =>
        ["url", "client_key", "client_ip", "ip", "request_body", "turnstile_token"].includes(column)
      ),
      false
    );

    const row = database
      .prepare("SELECT payload_nonce AS nonce, payload_ciphertext AS ciphertext FROM durable_scan_jobs")
      .get();
    assert.ok(row?.nonce instanceof Uint8Array);
    assert.ok(row?.ciphertext instanceof Uint8Array);
    const nonce = Buffer.from(row.nonce);
    const ciphertext = Buffer.from(row.ciphertext);
    assert.equal(nonce.byteLength, 12);
    assert.ok(ciphertext.byteLength > 16);
    for (const forbidden of [secretUrl, "private.example", "sensitive-path", "203.0.113", "turnstile"]) {
      assert.equal(ciphertext.includes(Buffer.from(forbidden, "utf8")), false);
    }
  });
});

test("claiming is FIFO and capacity means total leased plus publishing work", async () => {
  await withDatabase(async (_database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    for (let index = 0; index < 4; index += 1) {
      admitDurableScanJob(sql, await makeAdmission(key, 10 + index, 10_000 + index));
    }

    const firstCredentials = await createDurableScanJobLeaseCredentials(2);
    const first = claimDurableScanJobs(sql, { now: 20_000, capacity: 2, credentials: firstCredentials });
    assert.deepEqual(first.map((claim) => claim.jobId), [idFor(10), idFor(11)]);

    const blocked = claimDurableScanJobs(sql, {
      now: 20_001,
      capacity: 2,
      credentials: await createDurableScanJobLeaseCredentials(2)
    });
    assert.deepEqual(blocked, []);

    const firstHash = await hashDurableScanJobLeaseToken(first[0].leaseToken);
    beginPublishingDurableScanJob(sql, {
      jobId: first[0].jobId,
      generation: first[0].leaseGeneration,
      tokenHash: firstHash,
      now: 20_002,
      manifest: publicationManifest(first[0].reportId)
    });
    resolveDurableScanJob(sql, {
      jobId: first[0].jobId,
      generation: first[0].leaseGeneration,
      tokenHash: firstHash,
      now: 20_003,
      outcome: "succeeded"
    });

    const oneSlot = claimDurableScanJobs(sql, {
      now: 20_004,
      capacity: 2,
      credentials: await createDurableScanJobLeaseCredentials(2)
    });
    assert.equal(oneSlot.length, 1);
    assert.equal(oneSlot[0].jobId, idFor(12));
  });
});

test("claims reject a structurally valid token paired with a forged digest", async () => {
  await withDatabase(async (_database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    admitDurableScanJob(sql, await makeAdmission(key, 40, 40_000));
    const [credential] = await createDurableScanJobLeaseCredentials(1);
    const forgedHash = new Uint8Array(credential.tokenHash.slice(0));
    forgedHash[0] ^= 1;
    const forged = {
      token: credential.token,
      tokenHash: forgedHash.buffer
    } as DurableScanJobLeaseCredential;
    assert.throws(
      () => claimDurableScanJobs(sql, { now: 40_001, capacity: 1, credentials: [forged] }),
      DurableScanJobValidationError
    );
    assert.equal(findDurableScanJobSnapshot(sql, idFor(40))?.state, "queued");
    assert.equal(
      claimDurableScanJobs(sql, { now: 40_001, capacity: 1, credentials: [credential] }).length,
      1
    );
  });
});

test("the 32-job unfinished cap counts every nonterminal state", async () => {
  await withDatabase(async (database, sql) => {
    ensureDurableScanJobStore(sql);
    for (let index = 0; index < DURABLE_SCAN_JOB_MAX_NONTERMINAL; index += 1) {
      insertRawQueued(database, index, 50_000 + index);
    }
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    await assert.rejects(
      async () => admitDurableScanJob(sql, await makeAdmission(key, 50, 60_000)),
      DurableScanJobCapacityError
    );
    assert.equal(rowCount(database), DURABLE_SCAN_JOB_MAX_NONTERMINAL);
  });
});

test("expired leases requeue once and stale owners can never win generation two", async () => {
  await withDatabase(async (database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    admitDurableScanJob(sql, await makeAdmission(key, 70, 1_000));
    const [firstCredential] = await createDurableScanJobLeaseCredentials(1);
    const [first] = claimDurableScanJobs(sql, { now: 2_000, capacity: 1, credentials: [firstCredential] });
    assert.equal(first.leaseExpiresAt, 2_000 + DURABLE_SCAN_JOB_LEASE_MS);
    assert.deepEqual(listExpiredDurableScanJobLeases(sql, first.leaseExpiresAt - 1), []);
    assert.equal(listExpiredDurableScanJobLeases(sql, first.leaseExpiresAt)[0]?.jobId, first.jobId);

    const requeued = requeueOrFailExpiredDurableScanJobLease(sql, {
      jobId: first.jobId,
      generation: first.leaseGeneration,
      now: first.leaseExpiresAt
    });
    assert.equal(requeued.state, "queued");

    const [secondCredential] = await createDurableScanJobLeaseCredentials(1);
    const [second] = claimDurableScanJobs(sql, {
      now: first.leaseExpiresAt,
      capacity: 1,
      credentials: [secondCredential]
    });
    assert.equal(second.attemptCount, 2);
    assert.equal(second.leaseGeneration, 2);

    const firstHash = await hashDurableScanJobLeaseToken(first.leaseToken);
    assert.throws(
      () =>
        heartbeatDurableScanJob(sql, {
          jobId: first.jobId,
          generation: first.leaseGeneration,
          tokenHash: firstHash,
          now: first.leaseExpiresAt + 1
        }),
      DurableScanJobStateError
    );
    assert.throws(
      () =>
        beginPublishingDurableScanJob(sql, {
          jobId: first.jobId,
          generation: first.leaseGeneration,
          tokenHash: firstHash,
          now: first.leaseExpiresAt + 1,
          manifest: publicationManifest(first.reportId)
        }),
      DurableScanJobStateError
    );

    const failed = requeueOrFailExpiredDurableScanJobLease(sql, {
      jobId: second.jobId,
      generation: second.leaseGeneration,
      now: second.leaseExpiresAt
    });
    assert.equal(failed.state, "failed");
    assert.equal(failed.terminalReason, "restart-limit");
    assert.equal(
      claimDurableScanJobs(sql, {
        now: second.leaseExpiresAt,
        capacity: 1,
        credentials: await createDurableScanJobLeaseCredentials(1)
      }).length,
      0
    );
    assertPayloadAndLeaseWiped(database, second.jobId);
  });
});

test("heartbeats are exact-expiry fenced and never extend beyond the deadline", async () => {
  await withDatabase(async (_database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    const createdAt = 100_000;
    admitDurableScanJob(sql, await makeAdmission(key, 80, createdAt));
    const [credential] = await createDurableScanJobLeaseCredentials(1);
    const [claim] = claimDurableScanJobs(sql, {
      now: createdAt + DURABLE_SCAN_JOB_DEADLINE_MS - DURABLE_SCAN_JOB_LEASE_MS / 2,
      capacity: 1,
      credentials: [credential]
    });
    assert.equal(claim.leaseExpiresAt, createdAt + DURABLE_SCAN_JOB_DEADLINE_MS);
    const tokenHash = await hashDurableScanJobLeaseToken(claim.leaseToken);
    assert.throws(
      () =>
        heartbeatDurableScanJob(sql, {
          jobId: claim.jobId,
          generation: claim.leaseGeneration,
          tokenHash,
          now: claim.leaseExpiresAt
        }),
      DurableScanJobStateError
    );
  });
});

test("queued and leased cancellation is tokenless, atomic, wiping, and idempotent", async () => {
  await withDatabase(async (database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    admitDurableScanJob(sql, await makeAdmission(key, 90, 90_000));
    const queued = cancelDurableScanJob(sql, { jobId: idFor(90), now: 90_001 });
    assert.equal(queued.state, "cancelled");
    assert.deepEqual(cancelDurableScanJob(sql, { jobId: idFor(90), now: 90_002 }), queued);
    assertPayloadAndLeaseWiped(database, idFor(90));

    admitDurableScanJob(sql, await makeAdmission(key, 91, 91_000));
    const [credential] = await createDurableScanJobLeaseCredentials(1);
    const [claim] = claimDurableScanJobs(sql, { now: 91_001, capacity: 1, credentials: [credential] });
    const cancelled = cancelDurableScanJob(sql, { jobId: claim.jobId, now: 91_002 });
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.leaseGeneration, claim.leaseGeneration);
    assertPayloadAndLeaseWiped(database, claim.jobId);
    assert.throws(
      () =>
        beginPublishingDurableScanJob(sql, {
          jobId: claim.jobId,
          generation: claim.leaseGeneration,
          tokenHash: credential.tokenHash,
          now: 91_003,
          manifest: publicationManifest(claim.reportId)
        }),
      DurableScanJobStateError
    );
  });
});

test("publishing is an exact manifest boundary and requires fenced reconciliation after expiry", async () => {
  await withDatabase(async (database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    admitDurableScanJob(sql, await makeAdmission(key, 100, 100_000));
    const [credential] = await createDurableScanJobLeaseCredentials(1);
    const [claim] = claimDurableScanJobs(sql, { now: 100_001, capacity: 1, credentials: [credential] });
    const manifest = publicationManifest(claim.reportId);
    const extraFieldManifest = JSON.stringify({
      ...(JSON.parse(manifest) as Record<string, unknown>),
      targetUrl: "https://private.example/sensitive-path"
    });
    assert.throws(
      () =>
        beginPublishingDurableScanJob(sql, {
          jobId: claim.jobId,
          generation: claim.leaseGeneration,
          tokenHash: credential.tokenHash,
          now: 100_002,
          manifest: extraFieldManifest
        }),
      DurableScanJobValidationError
    );
    assert.throws(
      () =>
        beginPublishingDurableScanJob(sql, {
          jobId: claim.jobId,
          generation: claim.leaseGeneration,
          tokenHash: credential.tokenHash,
          now: 100_002,
          manifest: publicationManifest(idFor(30_100))
        }),
      DurableScanJobValidationError
    );
    assert.equal(findDurableScanJobSnapshot(sql, claim.jobId)?.state, "leased");
    const publishing = beginPublishingDurableScanJob(sql, {
      jobId: claim.jobId,
      generation: claim.leaseGeneration,
      tokenHash: credential.tokenHash,
      now: 100_002,
      manifest
    });
    assert.equal(publishing.state, "publishing");
    assert.equal(publishing.publicationManifest, manifest);
    assert.equal(publishing.leaseExpiresAt, 100_002 + DURABLE_SCAN_JOB_LEASE_MS);
    const publishingLeaseExpiresAt = publishing.leaseExpiresAt;
    assert.notEqual(publishingLeaseExpiresAt, null);
    if (publishingLeaseExpiresAt === null) throw new Error("Publishing lease expiry was not recorded.");
    assert.throws(
      () =>
        resolveDurableScanJob(sql, {
          jobId: claim.jobId,
          generation: claim.leaseGeneration,
          tokenHash: credential.tokenHash,
          now: 100_003,
          outcome: "failed",
          reason: "execution-failed"
        }),
      DurableScanJobStateError
    );
    assert.equal(findDurableScanJobSnapshot(sql, claim.jobId)?.state, "publishing");
    assert.equal(findDurableScanJobSnapshot(sql, claim.jobId)?.publicationManifest, manifest);
    assert.throws(
      () => cancelDurableScanJob(sql, { jobId: claim.jobId, now: 100_003 }),
      DurableScanJobStateError
    );
    assert.throws(
      () =>
        requeueOrFailExpiredDurableScanJobLease(sql, {
          jobId: claim.jobId,
          generation: claim.leaseGeneration,
          now: claim.leaseExpiresAt
        }),
      DurableScanJobStateError
    );

    assert.throws(
      () =>
        reconcileExpiredPublishingDurableScanJob(sql, {
          jobId: claim.jobId,
          generation: claim.leaseGeneration,
          now: publishingLeaseExpiresAt,
          result: "succeeded"
        }),
      DurableScanJobStateError
    );
    const succeeded = reconcileExpiredPublishingDurableScanJob(sql, {
      jobId: claim.jobId,
      generation: claim.leaseGeneration,
      now: publishingLeaseExpiresAt + DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS,
      result: "succeeded"
    });
    assert.equal(succeeded.state, "succeeded");
    assert.equal(succeeded.publicationManifest, null);
    assertPayloadAndLeaseWiped(database, claim.jobId);
  });
});

test("publishing is a no-requeue point after the settlement fence", async () => {
  await withDatabase(async (database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    for (const index of [110, 111]) admitDurableScanJob(sql, await makeAdmission(key, index, 110_000 + index));
    const claims = claimDurableScanJobs(sql, {
      now: 111_000,
      capacity: 2,
      credentials: await createDurableScanJobLeaseCredentials(2)
    });
    const publishing = await Promise.all(
      claims.map(async (claim) =>
        beginPublishingDurableScanJob(sql, {
          jobId: claim.jobId,
          generation: claim.leaseGeneration,
          tokenHash: await hashDurableScanJobLeaseToken(claim.leaseToken),
          now: 111_001,
          manifest: publicationManifest(claim.reportId)
        })
      )
    );
    const publishingLeaseExpiresAt = publishing.map((snapshot) => {
      assert.notEqual(snapshot.leaseExpiresAt, null);
      if (snapshot.leaseExpiresAt === null) throw new Error("Publishing lease expiry was not recorded.");
      return snapshot.leaseExpiresAt;
    });

    const missing = reconcileExpiredPublishingDurableScanJob(sql, {
      jobId: claims[0].jobId,
      generation: claims[0].leaseGeneration,
      now: publishingLeaseExpiresAt[0] + DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS,
      result: "missing"
    });
    assert.equal(missing.state, "failed");
    assert.equal(missing.terminalReason, "publication-missing");
    assert.equal(missing.publicationManifest, null);
    assert.equal(
      claimDurableScanJobs(sql, {
        now: publishingLeaseExpiresAt[0] + DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS,
        capacity: 1,
        credentials: await createDurableScanJobLeaseCredentials(1)
      }).some((claim) => claim.jobId === missing.jobId),
      false
    );
    assertPayloadAndLeaseWiped(database, claims[0].jobId);

    const integrity = reconcileExpiredPublishingDurableScanJob(sql, {
      jobId: claims[1].jobId,
      generation: claims[1].leaseGeneration,
      now: publishingLeaseExpiresAt[1] + DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS,
      result: "integrity-failed",
      reason: "report-digest-mismatch"
    });
    assert.equal(integrity.state, "failed");
    assert.equal(integrity.terminalReason, "report-digest-mismatch");
    assertPayloadAndLeaseWiped(database, claims[1].jobId);
  });
});

test("publication reserves timeout, settlement, and final reconciliation before deadline", async () => {
  await withDatabase(async (_database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    const required =
      DURABLE_SCAN_JOB_PUBLICATION_TIMEOUT_MS +
      DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS +
      DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS;

    for (const [index, offset] of [
      [112, required],
      [113, required - 1]
    ] as const) {
      const createdAt = 500_000 + index;
      const admission = await makeAdmission(key, index, createdAt);
      admitDurableScanJob(sql, admission);
      const [credential] = await createDurableScanJobLeaseCredentials(1);
      const [claim] = claimDurableScanJobs(sql, {
        now: admission.deadlineAt - offset,
        capacity: 1,
        credentials: [credential]
      });
      const begin = () =>
        beginPublishingDurableScanJob(sql, {
          jobId: claim.jobId,
          generation: claim.leaseGeneration,
          tokenHash: credential.tokenHash,
          now: admission.deadlineAt - offset,
          manifest: publicationManifest(claim.reportId)
        });
      if (offset === required) {
        const publishing = begin();
        assert.equal(
          publishing.leaseExpiresAt,
          admission.deadlineAt -
            DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS -
            DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS
        );
        assert.throws(
          () => expireDurableScanJob(sql, { jobId: claim.jobId, now: admission.deadlineAt }),
          DurableScanJobStateError
        );
        resolveDurableScanJob(sql, {
          jobId: claim.jobId,
          generation: claim.leaseGeneration,
          tokenHash: credential.tokenHash,
          now: admission.deadlineAt - offset + 1,
          outcome: "succeeded"
        });
      } else {
        assert.throws(begin, DurableScanJobStateError);
        assert.equal(findDurableScanJobSnapshot(sql, claim.jobId)?.state, "leased");
      }
    }
  });
});

test("deadline and purge boundaries are exact", async () => {
  await withDatabase(async (_database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    const createdAt = 200_000;
    const admission = await makeAdmission(key, 120, createdAt);
    const laterAdmission = await makeAdmission(key, 121, createdAt + 100);
    admitDurableScanJob(sql, admission);
    admitDurableScanJob(sql, laterAdmission);
    assert.equal(earliestDurableScanJobPurgeAt(sql), admission.purgeAt);
    assert.deepEqual(listPastDeadlineDurableScanJobs(sql, admission.deadlineAt - 1), []);
    assert.equal(listPastDeadlineDurableScanJobs(sql, admission.deadlineAt)[0]?.jobId, admission.jobId);

    const expired = expireDurableScanJob(sql, { jobId: admission.jobId, now: admission.deadlineAt });
    assert.equal(expired.state, "expired");
    assert.ok(findDurableScanJobSnapshot(sql, admission.jobId));
    assert.equal(purgeDurableScanJobs(sql, admission.purgeAt - 1), 0);
    assert.ok(findDurableScanJobSnapshot(sql, admission.jobId));
    assert.equal(purgeDurableScanJobs(sql, admission.purgeAt), 1);
    assert.equal(findDurableScanJobSnapshot(sql, admission.jobId), null);
    assert.equal(earliestDurableScanJobPurgeAt(sql), laterAdmission.purgeAt);
    assert.throws(
      () => purgeDurableScanJobs(sql, laterAdmission.purgeAt),
      DurableScanJobStateError,
      "hard purge must never silently delete unfinished work"
    );
    assert.equal(findDurableScanJobSnapshot(sql, laterAdmission.jobId)?.state, "queued");
    assert.deepEqual(
      settlePastPurgeDurableScanJobs(sql, laterAdmission.purgeAt).map((snapshot) => snapshot.state),
      ["expired"]
    );
    assert.equal(purgeDurableScanJobs(sql, laterAdmission.purgeAt), 1);
    assert.equal(earliestDurableScanJobPurgeAt(sql), null);
  });
});

test("hard-purge settlement covers queued, leased, and publishing rows before deletion", async () => {
  await withDatabase(async (_database, sql) => {
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    const createdAt = 250_000;
    const admissions = await Promise.all([
      makeAdmission(key, 130, createdAt),
      makeAdmission(key, 131, createdAt),
      makeAdmission(key, 132, createdAt)
    ]);
    for (const admission of admissions) admitDurableScanJob(sql, admission);

    const credentials = await createDurableScanJobLeaseCredentials(2);
    const claims = claimDurableScanJobs(sql, {
      now: createdAt + 1,
      capacity: 2,
      credentials
    });
    assert.equal(claims.length, 2);
    beginPublishingDurableScanJob(sql, {
      jobId: claims[1].jobId,
      generation: claims[1].leaseGeneration,
      tokenHash: credentials[1].tokenHash,
      now: createdAt + 2,
      manifest: publicationManifest(claims[1].reportId)
    });

    const purgeAt = admissions[0].purgeAt;
    assert.deepEqual(
      admissions.map((admission) => findDurableScanJobSnapshot(sql, admission.jobId)?.state),
      ["leased", "publishing", "queued"]
    );
    assert.throws(() => purgeDurableScanJobs(sql, purgeAt), DurableScanJobStateError);

    const settled = settlePastPurgeDurableScanJobs(sql, purgeAt);
    assert.equal(settled.length, 3);
    assert.deepEqual(settled.map((snapshot) => snapshot.state), ["expired", "expired", "expired"]);
    assert.deepEqual(settled.map((snapshot) => snapshot.terminalReason), ["deadline", "deadline", "deadline"]);
    assert.equal(purgeDurableScanJobs(sql, purgeAt), 3);
    assert.deepEqual(
      admissions.map((admission) => findDurableScanJobSnapshot(sql, admission.jobId)),
      [null, null, null]
    );
  });
});

test("the 500-row policy evicts only oldest terminal tombstones", async () => {
  await withDatabase(async (database, sql) => {
    ensureDurableScanJobStore(sql);
    for (let index = 0; index < DURABLE_SCAN_JOB_MAX_ROWS; index += 1) {
      insertRawTerminal(database, index, 300_000 + index);
    }
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    const admission = await makeAdmission(key, 600, 900_000);
    admitDurableScanJob(sql, admission);
    assert.equal(rowCount(database), DURABLE_SCAN_JOB_MAX_ROWS);
    assert.equal(findDurableScanJobSnapshot(sql, idFor(0)), null);
    assert.ok(findDurableScanJobSnapshot(sql, idFor(1)));
    assert.ok(findDurableScanJobSnapshot(sql, admission.jobId));

    insertRawTerminal(database, 700, 1_000_000);
    insertRawTerminal(database, 701, 1_000_001);
    assert.equal(purgeDurableScanJobs(sql, 0), 2);
    assert.equal(rowCount(database), DURABLE_SCAN_JOB_MAX_ROWS);
    assert.equal(findDurableScanJobSnapshot(sql, idFor(1)), null);
    assert.equal(findDurableScanJobSnapshot(sql, idFor(2)), null);
  });
});

test("a full store of unfinished rows rejects admission without deleting work", async () => {
  await withDatabase(async (database, sql) => {
    ensureDurableScanJobStore(sql);
    for (let index = 0; index < DURABLE_SCAN_JOB_MAX_ROWS; index += 1) {
      insertRawQueued(database, index, 2_000_000 + index);
    }
    const key = await importDurableScanJobEncryptionKey(KEY_WIRE);
    await assert.rejects(
      async () => admitDurableScanJob(sql, await makeAdmission(key, 900, 3_000_000)),
      DurableScanJobCapacityError
    );
    assert.equal(rowCount(database), DURABLE_SCAN_JOB_MAX_ROWS);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM durable_scan_jobs WHERE state = 'queued'").get()?.count,
      DURABLE_SCAN_JOB_MAX_ROWS
    );
  });
});

function payload(createdAt: number, overrides: Partial<DurableScanJobPayload> = {}): DurableScanJobPayload {
  return {
    version: 1,
    url: "https://private.example/sensitive-path",
    device: "desktop",
    gpcEnabled: false,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 1,
    admittedAt: createdAt,
    reportMode: "r2",
    alreadyCharged: true,
    ...overrides
  };
}

async function makeAdmission(
  key: DurableScanJobEncryptionKey,
  index: number,
  createdAt: number,
  overrides: Partial<DurableScanJobPayload> = {}
): Promise<DurableScanJobAdmission> {
  return createDurableScanJobAdmission(key, {
    jobId: idFor(index),
    reportId: idFor(index + 10_000),
    createdAt,
    payload: payload(createdAt, overrides)
  });
}

function idFor(index: number): string {
  return `20260718-${index.toString(16).padStart(32, "0")}`;
}

function publicationManifest(reportId: string): string {
  const createdAt = "2026-07-18T12:00:00.000Z";
  const expiresAt = "2026-07-25T12:00:00.000Z";
  const publicDigest = "a".repeat(64);
  const canonicalizationVersion = "canon-v1";
  const redactionVersion = 3;
  const sidecar = {
    reportId,
    publicDigest,
    canonicalizationVersion,
    redactionVersion,
    writtenAt: createdAt,
    createdAt,
    expiresAt
  };
  return JSON.stringify({
    manifestVersion: 1,
    reportId,
    reportWireSha256: "b".repeat(64),
    publicDigest,
    canonicalizationVersion,
    redactionVersion,
    reportBytes: 1_024,
    retention: { createdAt, expiresAt },
    sidecarWire: `${JSON.stringify(sidecar, null, 2)}\n`
  });
}

function insertRawTerminal(database: DatabaseSync, index: number, createdAt: number): void {
  database
    .prepare(
      `INSERT INTO durable_scan_jobs (
        job_id, report_id, state, created_at, deadline_at, purge_at, total_runs,
        attempt_count, lease_generation, lease_token_hash, lease_expires_at,
        payload_version, payload_key_id, payload_nonce, payload_ciphertext,
        publication_manifest, terminal_reason, finished_at, updated_at
      ) VALUES (?, ?, 'cancelled', ?, ?, ?, 1, 0, 0, NULL, NULL, 1, NULL, NULL, NULL, NULL, 'cancelled', ?, ?)`
    )
    .run(
      idFor(index),
      idFor(index + 10_000),
      createdAt,
      createdAt + DURABLE_SCAN_JOB_DEADLINE_MS,
      createdAt + DURABLE_SCAN_JOB_PURGE_MS,
      createdAt + 1,
      createdAt + 1
    );
}

function insertRawQueued(database: DatabaseSync, index: number, createdAt: number): void {
  database
    .prepare(
      `INSERT INTO durable_scan_jobs (
        job_id, report_id, state, created_at, deadline_at, purge_at, total_runs,
        attempt_count, lease_generation, lease_token_hash, lease_expires_at,
        payload_version, payload_key_id, payload_nonce, payload_ciphertext,
        publication_manifest, terminal_reason, finished_at, updated_at
      ) VALUES (?, ?, 'queued', ?, ?, ?, 1, 0, 0, NULL, NULL, 1, 'v1', ?, ?, NULL, NULL, NULL, ?)`
    )
    .run(
      idFor(index),
      idFor(index + 10_000),
      createdAt,
      createdAt + DURABLE_SCAN_JOB_DEADLINE_MS,
      createdAt + DURABLE_SCAN_JOB_PURGE_MS,
      new Uint8Array(12),
      new Uint8Array(16),
      createdAt
    );
}

function assertPayloadAndLeaseWiped(database: DatabaseSync, jobId: string): void {
  const row = database
    .prepare(
      `SELECT payload_key_id, payload_nonce, payload_ciphertext, lease_token_hash,
              lease_expires_at, publication_manifest
       FROM durable_scan_jobs WHERE job_id = ?`
    )
    .get(jobId);
  assert.deepEqual({ ...row }, {
    payload_key_id: null,
    payload_nonce: null,
    payload_ciphertext: null,
    lease_token_hash: null,
    lease_expires_at: null,
    publication_manifest: null
  });
}

function rowCount(database: DatabaseSync): number {
  return Number(database.prepare("SELECT COUNT(*) AS count FROM durable_scan_jobs").get()?.count);
}

async function withDatabase(
  callback: (database: DatabaseSync, sql: DurableScanJobStoreSql) => Promise<void> | void
): Promise<void> {
  const database = new DatabaseSync(":memory:");
  try {
    const sql: DurableScanJobStoreSql = {
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
    await callback(database, sql);
  } finally {
    database.close();
  }
}

function normalizeSqliteRow(row: Record<string, unknown>): Record<string, ArrayBuffer | string | number | null> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? Uint8Array.from(value).buffer
        : (value as string | number | null)
    ])
  );
}
