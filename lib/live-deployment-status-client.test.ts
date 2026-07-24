import assert from "node:assert/strict";
import test from "node:test";
import { ClientResponseTooLargeError, LatestClientOperation } from "./client-fetch-policy";
import {
  PAGES_DEPLOYMENT_RECEIPT_MAX_BYTES,
  runLiveDeploymentStatusCheck,
  type LiveDeploymentStatusCheck
} from "./live-deployment-status-client";

const SHA = "a".repeat(40);
const NOW = Date.parse("2026-07-21T12:00:00.000Z");

test("public status rejects a decompressed receipt beyond its explicit byte cap", async () => {
  const operation = new LatestClientOperation();
  let observedError: unknown = null;
  const outcome = await runLiveDeploymentStatusCheck(
    operation,
    {
      pagesReceiptUrl: "https://site.example/deployment.json",
      scannerHealthUrl: "https://scanner.example/api/health",
      nowMs: NOW,
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input).includes("deployment.json")
          ? jsonResponse({ padding: "x".repeat(PAGES_DEPLOYMENT_RECEIPT_MAX_BYTES) })
          : jsonResponse(scannerHealth())) as typeof fetch
    },
    {
      onSuccess: () => assert.fail("oversized status evidence must not commit"),
      onError: (error) => { observedError = error; }
    }
  );

  assert.equal(outcome, "failed");
  assert.equal(observedError instanceof ClientResponseTooLargeError, true);
});

test("a superseded public-status success cannot overwrite newer evidence", async () => {
  const operation = new LatestClientOperation();
  const responses = Array.from({ length: 4 }, () => deferred<Response>());
  let responseIndex = 0;
  const fetchImpl = (() => responses[responseIndex++].promise) as typeof fetch;
  const state = statusState();
  const handlers = statusHandlers(state);
  const options = {
    pagesReceiptUrl: "https://site.example/deployment.json",
    scannerHealthUrl: "https://scanner.example/api/health",
    nowMs: NOW,
    fetchImpl
  };

  const staleRun = runLiveDeploymentStatusCheck(operation, options, handlers);
  const currentRun = runLiveDeploymentStatusCheck(operation, options, handlers);
  assert.equal(responseIndex, 4);

  responses[2].resolve(jsonResponse(pagesReceipt("current")));
  responses[3].resolve(jsonResponse(scannerHealth()));
  assert.equal(await currentRun, "committed");
  assert.deepEqual(state, { marker: "current", error: null, checking: false });

  responses[0].resolve(jsonResponse(pagesReceipt("stale")));
  responses[1].resolve(jsonResponse(scannerHealth()));
  assert.equal(await staleRun, "superseded");
  assert.deepEqual(state, { marker: "current", error: null, checking: false });
});

test("a superseded public-status error and finally cannot clear the current busy state", async () => {
  const operation = new LatestClientOperation();
  const responses = Array.from({ length: 4 }, () => deferred<Response>());
  let responseIndex = 0;
  const fetchImpl = (() => responses[responseIndex++].promise) as typeof fetch;
  const state = statusState();
  const handlers = statusHandlers(state);
  const options = {
    pagesReceiptUrl: "https://site.example/deployment.json",
    scannerHealthUrl: "https://scanner.example/api/health",
    nowMs: NOW,
    fetchImpl
  };

  const staleRun = runLiveDeploymentStatusCheck(operation, options, handlers);
  const currentRun = runLiveDeploymentStatusCheck(operation, options, handlers);
  responses[0].reject(new Error("old status failure"));
  responses[1].reject(new Error("old scanner failure"));

  assert.equal(await staleRun, "superseded");
  assert.deepEqual(state, { marker: null, error: null, checking: true });

  responses[2].resolve(jsonResponse(pagesReceipt("current")));
  responses[3].resolve(jsonResponse(scannerHealth()));
  assert.equal(await currentRun, "committed");
  assert.deepEqual(state, { marker: "current", error: null, checking: false });
});

type StatusState = {
  marker: string | null;
  error: string | null;
  checking: boolean;
};

function statusState(): StatusState {
  return { marker: null, error: null, checking: false };
}

function statusHandlers(state: StatusState) {
  return {
    onStart: () => { state.checking = true; },
    onSuccess: ({ evidence }: LiveDeploymentStatusCheck) => {
      state.marker = readMarker(evidence.pages);
    },
    onError: (error: unknown) => {
      state.error = error instanceof Error ? error.message : "unknown";
    },
    onSettled: () => { state.checking = false; }
  };
}

function pagesReceipt(marker: string): Record<string, unknown> {
  return { schemaVersion: 1, deployment: SHA, marker };
}

function scannerHealth(): Record<string, unknown> {
  return {
    ok: true,
    status: "ok",
    timestamp: new Date(NOW).toISOString(),
    deployment: SHA,
    scansAvailable: true,
    warnings: []
  };
}

function readMarker(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = (value as Record<string, unknown>).marker;
  return typeof marker === "string" ? marker : null;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
