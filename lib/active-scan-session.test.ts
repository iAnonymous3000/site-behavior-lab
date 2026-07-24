import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVE_SCAN_SESSION_MAX_AGE_MS,
  ACTIVE_SCAN_SESSION_MAX_STORAGE_BYTES,
  ACTIVE_SCAN_SESSION_STORAGE_KEY,
  PENDING_SCAN_ADMISSION_STORAGE_KEY,
  clearActiveScanSession,
  clearPendingScanAdmissionSession,
  persistActiveScanSession,
  persistPendingScanAdmissionSession,
  restoreActiveScanSession,
  restorePendingScanAdmissionSession,
  type ActiveScanJob,
  type RecoverableScanJob
} from "./active-scan-session";
import { SCAN_ADMISSION_TTL_MS } from "./scan-admission-capability";

const JOB_ID = `20260721-${"a".repeat(32)}`;
const REPORT_ID = `20260721-${"b".repeat(32)}`;
const JOB: ActiveScanJob = {
  jobId: JOB_ID,
  statusPath: `/api/scans/${JOB_ID}`,
  accessKey: "admission-key",
  reportId: REPORT_ID
};
const RECOVERY_JOB: RecoverableScanJob = {
  jobId: JOB_ID,
  statusPath: `/api/scans/${JOB_ID}`,
  reportId: REPORT_ID
};
const ADMISSION_CREDENTIAL = {
  capabilityToken: Buffer.alloc(32, 3).toString("base64url"),
  requestCommitment: Buffer.alloc(32, 7).toString("base64url")
};

test("pending admission recovery is retained before POST without request or authentication data", () => {
  const storage = new MemoryStorage();
  const now = Date.UTC(2026, 6, 21, 11, 59, 0);
  const session = persistPendingScanAdmissionSession(storage, ADMISSION_CREDENTIAL, now);

  assert.deepEqual(session, {
    credential: ADMISSION_CREDENTIAL,
    createdAt: now,
    expiresAt: now + SCAN_ADMISSION_TTL_MS
  });
  const raw = storage.getItem(PENDING_SCAN_ADMISSION_STORAGE_KEY) ?? "";
  assert.match(raw, new RegExp(ADMISSION_CREDENTIAL.capabilityToken));
  assert.match(raw, new RegExp(ADMISSION_CREDENTIAL.requestCommitment));
  assert.doesNotMatch(
    raw,
    /example\.com|requestedUrl|target|accessKey|authorization|turnstile|device|compare|report|evidence/i
  );
  assert.deepEqual(restorePendingScanAdmissionSession(storage, now + 1), session);

  assert.equal(restorePendingScanAdmissionSession(storage, session.expiresAt), null);
  assert.equal(storage.getItem(PENDING_SCAN_ADMISSION_STORAGE_KEY), null);
});

test("malformed or tampered pending admissions fail closed and are removed", () => {
  const storage = new MemoryStorage();
  const now = Date.UTC(2026, 6, 21, 12, 0, 0);
  const valid = {
    version: 1,
    credential: ADMISSION_CREDENTIAL,
    createdAt: now,
    expiresAt: now + SCAN_ADMISSION_TTL_MS
  };
  const invalidRecords = [
    "not json",
    `{"version":1,"version":1,"credential":{},"createdAt":${now},"expiresAt":${now + SCAN_ADMISSION_TTL_MS}}`,
    " ".repeat(ACTIVE_SCAN_SESSION_MAX_STORAGE_BYTES + 1),
    JSON.stringify({ ...valid, expiresAt: now + SCAN_ADMISSION_TTL_MS + 1 }),
    JSON.stringify({ ...valid, credential: { ...ADMISSION_CREDENTIAL, capabilityToken: "invalid" } }),
    JSON.stringify({ ...valid, credential: { ...ADMISSION_CREDENTIAL, unexpected: true } }),
    JSON.stringify({ ...valid, targetUrl: "https://example.com/" })
  ];

  for (const raw of invalidRecords) {
    storage.setItem(PENDING_SCAN_ADMISSION_STORAGE_KEY, raw);
    assert.equal(restorePendingScanAdmissionSession(storage, now), null);
    assert.equal(storage.getItem(PENDING_SCAN_ADMISSION_STORAGE_KEY), null);
  }
});

test("accepted scan recovery is tab-scoped, minimal, and expires after the server retention window", () => {
  const storage = new MemoryStorage();
  const now = Date.UTC(2026, 6, 21, 12, 0, 0);
  const session = persistActiveScanSession(storage, JOB, now);

  assert.deepEqual(session, {
    job: RECOVERY_JOB,
    acceptedAt: now,
    expiresAt: now + ACTIVE_SCAN_SESSION_MAX_AGE_MS
  });
  const raw = storage.getItem(ACTIVE_SCAN_SESSION_STORAGE_KEY) ?? "";
  assert.doesNotMatch(raw, /admission-key|accessKey|example\.com|turnstile|requestedUrl|evidence/);
  assert.deepEqual(restoreActiveScanSession(storage, now + 1), session);

  assert.equal(restoreActiveScanSession(storage, session.expiresAt), null);
  assert.equal(storage.getItem(ACTIVE_SCAN_SESSION_STORAGE_KEY), null);
});

test("tampered, cross-path, and malformed recovery capabilities fail closed and are removed", () => {
  const storage = new MemoryStorage();
  const now = Date.UTC(2026, 6, 21, 12, 0, 0);
  const invalidRecords = [
    "not json",
    `{"version":1,"version":1,"acceptedAt":${now},"expiresAt":${now + ACTIVE_SCAN_SESSION_MAX_AGE_MS},"job":{}}`,
    " ".repeat(ACTIVE_SCAN_SESSION_MAX_STORAGE_BYTES + 1),
    JSON.stringify({
      version: 1,
      acceptedAt: now,
      expiresAt: now + ACTIVE_SCAN_SESSION_MAX_AGE_MS,
      job: { ...RECOVERY_JOB, statusPath: `https://attacker.example/api/scans/${JOB_ID}` }
    }),
    JSON.stringify({
      version: 1,
      acceptedAt: now,
      expiresAt: now + ACTIVE_SCAN_SESSION_MAX_AGE_MS,
      job: { ...RECOVERY_JOB, unexpected: "field" }
    }),
    JSON.stringify({
      version: 1,
      acceptedAt: now,
      expiresAt: now + ACTIVE_SCAN_SESSION_MAX_AGE_MS,
      job: { ...RECOVERY_JOB, reportId: JOB_ID }
    })
  ];

  for (const raw of invalidRecords) {
    storage.setItem(ACTIVE_SCAN_SESSION_STORAGE_KEY, raw);
    assert.equal(restoreActiveScanSession(storage, now), null);
    assert.equal(storage.getItem(ACTIVE_SCAN_SESSION_STORAGE_KEY), null);
  }
});

test("pending admission fails closed on storage failure while accepted recovery stays best-effort", () => {
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    }
  };
  assert.doesNotThrow(() => persistActiveScanSession(blocked, JOB, 1));
  assert.equal(restoreActiveScanSession(blocked, 1), null);
  assert.doesNotThrow(() => clearActiveScanSession(blocked));
  assert.throws(() => persistPendingScanAdmissionSession(blocked, ADMISSION_CREDENTIAL, 1), /blocked/);
  assert.equal(restorePendingScanAdmissionSession(blocked, 1), null);
  assert.doesNotThrow(() => clearPendingScanAdmissionSession(blocked));

  const noReadback = {
    setItem: () => undefined,
    getItem: () => null,
    removeItem: () => undefined
  };
  assert.throws(
    () => persistPendingScanAdmissionSession(noReadback, ADMISSION_CREDENTIAL, 1),
    /could not be retained/
  );
});

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
