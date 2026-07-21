import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVE_SCAN_SESSION_MAX_AGE_MS,
  ACTIVE_SCAN_SESSION_STORAGE_KEY,
  clearActiveScanSession,
  persistActiveScanSession,
  restoreActiveScanSession,
  type ActiveScanJob,
  type RecoverableScanJob
} from "./active-scan-session";

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

test("storage failures never turn accepted recovery into a crash", () => {
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
