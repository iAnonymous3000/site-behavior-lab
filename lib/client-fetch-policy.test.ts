import assert from "node:assert/strict";
import test from "node:test";
import {
  ClientFetchTimeoutError,
  ClientInvalidJsonError,
  ClientResponseTooLargeError,
  LatestClientOperation,
  fetchJsonResponseWithPolicy,
  fetchJsonWithPolicy
} from "./client-fetch-policy";

test("connection deadline aborts a request that never returns headers", async () => {
  let requestSignal: AbortSignal | null = null;
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? null;
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;

  await assert.rejects(
    fetchJsonWithPolicy("https://example.test/report.json", {}, {
      label: "Report evidence",
      maxBytes: 1024,
      connectTimeoutMs: 10,
      operationTimeoutMs: 100,
      fetchImpl
    }),
    (error: unknown) =>
      error instanceof ClientFetchTimeoutError && error.phase === "connect" && error.timeoutMs === 10
  );
  assert.equal((requestSignal as AbortSignal | null)?.aborted, true);
});

test("whole-operation deadline includes a response body that never finishes", async () => {
  const prefix = new TextEncoder().encode('{"partial":');
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix);
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

  await assert.rejects(
    fetchJsonWithPolicy("https://example.test/report.json", {}, {
      label: "Report evidence",
      maxBytes: 1024,
      connectTimeoutMs: 100,
      operationTimeoutMs: 15,
      fetchImpl: (async () => response) as typeof fetch
    }),
    (error: unknown) =>
      error instanceof ClientFetchTimeoutError && error.phase === "operation" && error.timeoutMs === 15
  );
});

test("caller abort composes with deadlines and preserves the caller reason", async () => {
  const caller = new AbortController();
  const reason = new DOMException("The report view was closed.", "AbortError");
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const rejectAbort = () => reject(signal.reason);
      if (signal.aborted) rejectAbort();
      else signal.addEventListener("abort", rejectAbort, { once: true });
    })) as typeof fetch;

  const read = fetchJsonWithPolicy("https://example.test/report.json", {}, {
    label: "Report evidence",
    maxBytes: 1024,
    signal: caller.signal,
    connectTimeoutMs: 100,
    operationTimeoutMs: 200,
    fetchImpl
  });
  caller.abort(reason);
  await assert.rejects(read, (error: unknown) => error === reason);
});

test("an already-aborted caller does not start a fetch", async () => {
  const caller = new AbortController();
  const reason = new DOMException("The view was already closed.", "AbortError");
  caller.abort(reason);
  let fetchCalls = 0;

  await assert.rejects(
    fetchJsonWithPolicy("https://example.test/report.json", {}, {
      label: "Report evidence",
      maxBytes: 1024,
      signal: caller.signal,
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response("{}");
      }) as typeof fetch
    }),
    (error: unknown) => error === reason
  );
  assert.equal(fetchCalls, 0);
});

test("a JSON response inside the deadline and byte cap is parsed", async () => {
  const payload = await fetchJsonWithPolicy("https://example.test/report.json", {}, {
    label: "Report evidence",
    maxBytes: 1024,
    fetchImpl: (async () => new Response('{"report":"current"}', { status: 200 })) as typeof fetch
  });
  assert.deepEqual(payload, { report: "current" });
});

test("browser JSON reads reject duplicate keys, including escaped aliases", async () => {
  for (const wire of ['{"report":"first","report":"second"}', '{"report":"first","\\u0072eport":"second"}']) {
    await assert.rejects(
      fetchJsonWithPolicy("https://example.test/report.json", {}, {
        label: "Report evidence",
        maxBytes: 1024,
        fetchImpl: (async () => new Response(wire)) as typeof fetch
      }),
      ClientInvalidJsonError
    );
  }
});

test("the response-preserving variant can bound and parse an accepted non-2xx body", async () => {
  const result = await fetchJsonResponseWithPolicy("https://example.test/jobs/missing", {}, {
    label: "Scan job status",
    maxBytes: 1024,
    acceptResponse: (response) => response.status === 404,
    fetchImpl: (async () => new Response('{"error":"missing"}', {
      status: 404,
      headers: { "retry-after": "3" }
    })) as typeof fetch
  });

  assert.equal(result.response.status, 404);
  assert.equal(result.response.headers.get("retry-after"), "3");
  assert.deepEqual(result.payload, { error: "missing" });
});

test("streamed response bytes cannot exceed the configured decompressed limit", async () => {
  const response = new Response(JSON.stringify({ evidence: "larger than the limit" }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

  await assert.rejects(
    fetchJsonWithPolicy("https://example.test/report.json", {}, {
      label: "Report evidence",
      maxBytes: 8,
      fetchImpl: (async () => response) as typeof fetch
    }),
    (error: unknown) => error instanceof ClientResponseTooLargeError && error.maxBytes === 8
  );
});

test("HTTP and declared-length early rejections cancel their response bodies", async () => {
  let httpCancelled = false;
  const httpResponse = new Response(new ReadableStream<Uint8Array>({
    cancel() {
      httpCancelled = true;
    }
  }), { status: 500 });
  await assert.rejects(
    fetchJsonWithPolicy("https://example.test/report.json", {}, {
      label: "Report evidence",
      maxBytes: 1024,
      fetchImpl: (async () => httpResponse) as typeof fetch
    }),
    /HTTP 500/
  );
  assert.equal(httpCancelled, true);

  let oversizedCancelled = false;
  const oversizedResponse = new Response(new ReadableStream<Uint8Array>({
    cancel() {
      oversizedCancelled = true;
    }
  }), {
    status: 200,
    headers: { "content-length": "9" }
  });
  await assert.rejects(
    fetchJsonWithPolicy("https://example.test/report.json", {}, {
      label: "Report evidence",
      maxBytes: 8,
      fetchImpl: (async () => oversizedResponse) as typeof fetch
    }),
    ClientResponseTooLargeError
  );
  assert.equal(oversizedCancelled, true);
});

test("JSON decoding fails closed on invalid UTF-8", async () => {
  const bytes = new Uint8Array([
    ...new TextEncoder().encode('{"value":"'),
    0xff,
    ...new TextEncoder().encode('"}')
  ]);
  await assert.rejects(
    fetchJsonWithPolicy("https://example.test/report.json", {}, {
      label: "Report evidence",
      maxBytes: 1024,
      fetchImpl: (async () => new Response(bytes)) as typeof fetch
    }),
    ClientInvalidJsonError
  );
});

test("a superseded request cannot overwrite a newer successful result", async () => {
  const operation = new LatestClientOperation();
  const first = deferred<string>();
  const second = deferred<string>();
  const state: { data: string | null; error: string | null; loading: boolean } = {
    data: null,
    error: null,
    loading: false
  };
  let firstSignal: AbortSignal | null = null;
  const handlers = {
    onStart: () => { state.loading = true; },
    onSuccess: (value: string) => { state.data = value; },
    onError: (error: unknown) => { state.error = error instanceof Error ? error.message : "unknown"; },
    onSettled: () => { state.loading = false; }
  };

  const firstRun = operation.run((signal) => {
    firstSignal = signal;
    return first.promise;
  }, handlers);
  const secondRun = operation.run(() => second.promise, handlers);
  assert.equal((firstSignal as AbortSignal | null)?.aborted, true);

  second.resolve("new report");
  assert.equal(await secondRun, "committed");
  first.resolve("stale report");
  assert.equal(await firstRun, "superseded");
  assert.deepEqual(state, { data: "new report", error: null, loading: false });
});

test("a stale error and finally cannot clear a newer operation's busy state", async () => {
  const operation = new LatestClientOperation();
  const first = deferred<string>();
  const second = deferred<string>();
  const state: { data: string | null; error: string | null; loading: boolean } = {
    data: null,
    error: null,
    loading: false
  };
  const handlers = {
    onStart: () => { state.loading = true; state.error = null; },
    onSuccess: (value: string) => { state.data = value; },
    onError: (error: unknown) => { state.error = error instanceof Error ? error.message : "unknown"; },
    onSettled: () => { state.loading = false; }
  };

  const firstRun = operation.run(() => first.promise, handlers);
  const secondRun = operation.run(() => second.promise, handlers);
  first.reject(new Error("old failure"));
  assert.equal(await firstRun, "superseded");
  assert.deepEqual(state, { data: null, error: null, loading: true });

  second.resolve("current report");
  assert.equal(await secondRun, "committed");
  assert.deepEqual(state, { data: "current report", error: null, loading: false });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
