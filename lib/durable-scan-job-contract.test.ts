import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeDurableScanJobPreparation,
  encodeDurableScanJobPreparation,
  isDurableScanJobPayload,
  isDurableScanJobNodePrivatePath,
  parseDurableScanJobCoordinatorPath,
  stripDurableScanJobInternalHeaders,
  type DurableScanJobPreparation
} from "./durable-scan-job-contract";

const JOB_ID = `20260718-${"a".repeat(32)}`;
const REPORT_ID = `20260718-${"b".repeat(32)}`;

function preparation(): DurableScanJobPreparation {
  return {
    submission: {
      ok: true,
      jobId: JOB_ID,
      status: "queued",
      statusPath: `/api/scans/${JOB_ID}`,
      reportId: REPORT_ID
    },
    payload: {
      version: 1,
      url: "https://example.com/path",
      device: "desktop",
      gpcEnabled: false,
      compareGpc: false,
      compareShields: true,
      compareConsent: false,
      rateLimitCost: 2,
      admittedAt: 1_752_880_000_000,
      reportMode: "r2",
      alreadyCharged: true
    }
  };
}

test("the private preparation header round-trips only the strict edge-safe DTO", () => {
  const expected = preparation();
  const encoded = encodeDurableScanJobPreparation(expected);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeDurableScanJobPreparation(encoded), expected);
});

test("the preparation decoder rejects capability aliasing, extra fields, and non-canonical targets", () => {
  for (const mutate of [
    (value: any) => (value.submission.reportId = value.submission.jobId),
    (value: any) => (value.submission.statusPath = "/api/scans/wrong"),
    (value: any) => (value.payload.clientKey = "192.0.2.1"),
    (value: any) => (value.payload.url = "https://user:secret@example.com/path"),
    (value: any) => (value.payload.url = "https://example.com/path?secret=1"),
    (value: any) => (value.payload.url = "https://example.com/path#secret")
  ]) {
    const candidate: any = structuredClone(preparation());
    mutate(candidate);
    const encoded = base64urlJson(candidate);
    assert.equal(decodeDurableScanJobPreparation(encoded), null);
  }
});

test("durable payload comparison flags and admission cost cannot disagree", () => {
  const base = preparation().payload;
  assert.equal(isDurableScanJobPayload(base), true);
  assert.equal(isDurableScanJobPayload({ ...base, compareGpc: true }), false);
  assert.equal(isDurableScanJobPayload({ ...base, compareShields: false, rateLimitCost: 2 }), false);
  assert.equal(isDurableScanJobPayload({ ...base, rateLimitCost: 1 }), false);
  assert.equal(isDurableScanJobPayload({ ...base, compareShields: false, rateLimitCost: 1 }), true);
});

test("malformed private preparation headers fail closed", () => {
  for (const value of [null, "", "*", "a", "e30", "A".repeat(16_385)]) {
    assert.equal(decodeDurableScanJobPreparation(value), null);
  }
  assert.equal(
    decodeDurableScanJobPreparation(
      Buffer.from('{"submission":{},"submission":{},"payload":{}}', "utf8").toString("base64url")
    ),
    null
  );
});

test("private route matching uses path boundaries and coordinator actions are closed", () => {
  assert.equal(isDurableScanJobNodePrivatePath("/api/internal/durable-scans"), true);
  assert.equal(isDurableScanJobNodePrivatePath(`/api/internal/durable-scans/${JOB_ID}`), true);
  assert.equal(isDurableScanJobNodePrivatePath("/api/internal/durable-scans-public"), false);
  assert.deepEqual(
    parseDurableScanJobCoordinatorPath(`/__site-behavior-lab/durable-scans/${JOB_ID}/heartbeat`),
    { jobId: JOB_ID, action: "heartbeat" }
  );
  assert.equal(parseDurableScanJobCoordinatorPath(`/__site-behavior-lab/durable-scans/${JOB_ID}/unknown`), null);
  assert.equal(parseDurableScanJobCoordinatorPath(`/__site-behavior-lab/durable-scans/${JOB_ID}/heartbeat/extra`), null);
});

test("public forwarding strips the entire reserved durable header namespace", () => {
  const headers = stripDurableScanJobInternalHeaders(
    new Headers({
      "X-Site-Behavior-Lab-Durable-Job-Internal-Token": "secret",
      "x-site-behavior-lab-durable-job-prepared": "secret-dto",
      "x-site-behavior-lab-durable-job-future": "secret-future",
      "x-site-behavior-lab-access-token": "public-scan-token"
    })
  );
  assert.equal(headers.get("x-site-behavior-lab-durable-job-internal-token"), null);
  assert.equal(headers.get("x-site-behavior-lab-durable-job-prepared"), null);
  assert.equal(headers.get("x-site-behavior-lab-durable-job-future"), null);
  assert.equal(headers.get("x-site-behavior-lab-access-token"), "public-scan-token");
});

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
