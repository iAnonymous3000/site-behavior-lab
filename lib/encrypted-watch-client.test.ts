import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEncryptedWatch,
  deleteEncryptedWatch,
  encodeEncryptedWatchCredentialsFragment,
  encryptedWatchManagementUrl,
  mintEncryptedWatchCredentials,
  parseEncryptedWatchCreation,
  parseEncryptedWatchCredentialsFragment,
  parseEncryptedWatchCredentialsFromUrl,
  parseEncryptedWatchStatusResponse,
  readEncryptedWatch,
  type EncryptedWatchCredentials
} from "./encrypted-watch-client";
import {
  ENCRYPTED_WATCH_CAPABILITY_HEADER,
  ENCRYPTED_WATCH_CADENCE_MS,
  ENCRYPTED_WATCH_MAX_RUNS,
  ENCRYPTED_WATCH_TTL_MS
} from "./encrypted-watch-contract";
import { SCAN_ACCESS_TOKEN_HEADER } from "./scan-token";

const CREATED_AT = 1_752_880_000_000;
const TOKEN_BYTES = Uint8Array.from({ length: 32 }, (_value, index) => index);
const WATCH_ID = "103d0ebdaea7dce9e2910bd227af5c2c";
const CAPABILITY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const JOB_ID = `20260719-${"c".repeat(32)}`;
const REPORT_ID = `20260719-${"d".repeat(32)}`;
const TARGET = "https://example.com/path";
const CREDENTIALS: EncryptedWatchCredentials = {
  watchId: WATCH_ID,
  capabilityToken: CAPABILITY
};

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    watchId: WATCH_ID,
    statusPath: `/api/watches/${WATCH_ID}`,
    state: "active",
    createdAt: CREATED_AT,
    expiresAt: CREATED_AT + ENCRYPTED_WATCH_TTL_MS,
    nextRunAt: CREATED_AT + ENCRYPTED_WATCH_CADENCE_MS,
    attemptCount: 1,
    maxAttempts: ENCRYPTED_WATCH_MAX_RUNS,
    runs: [run(1)],
    ...overrides
  };
}

function run(sequence: number): Record<string, unknown> {
  const jobId = sequence === 1 ? JOB_ID : `20260719-${sequence.toString(16).repeat(32)}`;
  const reportId = sequence === 1 ? REPORT_ID : `20260719-${(sequence + 5).toString(16).repeat(32)}`;
  return {
    sequence,
    admittedAt: CREATED_AT + sequence - 1,
    jobId,
    statusPath: `/api/scans/${jobId}`,
    reportId,
    status: "succeeded",
    errorCode: null
  };
}

function jsonResponse(value: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(value), {
    status: statusCode,
    headers: { "content-type": "application/json" }
  });
}

test("watch creation uses the established access header and keeps the target out of the URL", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const created = await createEncryptedWatch({
    payload: {
      version: 1,
      target: { url: TARGET },
      options: { device: "mobile", gpcEnabled: true, reportMode: "r2", comparison: "none" }
    },
    accessToken: " access-token ",
    turnstileToken: " turnstile-token ",
    credentials: CREDENTIALS,
    resolveApiUrl: (path) => `https://scanner.example${path}`,
    fetcher: async (input, init) => {
      requests.push({ input, init });
      return jsonResponse({ ...status(), capability: CAPABILITY });
    }
  });

  assert.deepEqual(created.credentials, CREDENTIALS);
  assert.equal(created.status.runs[0]?.reportId, REPORT_ID);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.input, "https://scanner.example/api/watches");
  assert.equal(request.input.includes(TARGET), false);
  assert.equal(request.input.includes(CAPABILITY), false);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "error");
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get(SCAN_ACCESS_TOKEN_HEADER), "access-token");
  assert.equal(headers.get(ENCRYPTED_WATCH_CAPABILITY_HEADER), CAPABILITY);
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    url: TARGET,
    device: "mobile",
    gpcEnabled: true,
    turnstileToken: "turnstile-token"
  });
  assert.equal(String(request.init.body).includes("access-token"), false);
});

test("creation credentials are 256-bit, domain-separated, retained before POST, and reusable", async () => {
  const minted = await mintEncryptedWatchCredentials(() => TOKEN_BYTES);
  assert.deepEqual(minted, CREDENTIALS);
  let retained: EncryptedWatchCredentials | null = null;
  const seenCapabilities: string[] = [];
  for (const statusCode of [201, 200]) {
    const result = await createEncryptedWatch({
      payload: {
        version: 1,
        target: { url: TARGET },
        options: { device: "desktop", gpcEnabled: false, reportMode: "r2", comparison: "none" }
      },
      credentials: minted,
      onCredentialsReady: (value) => {
        retained = value;
      },
      resolveApiUrl: (path) => `https://scanner.example${path}`,
      fetcher: async (_input, init) => {
        assert.deepEqual(retained, CREDENTIALS, "credentials must be retained before POST");
        seenCapabilities.push(new Headers(init.headers).get(ENCRYPTED_WATCH_CAPABILITY_HEADER) ?? "");
        return jsonResponse({ ...status(), capability: CAPABILITY }, statusCode);
      }
    });
    assert.deepEqual(result.credentials, CREDENTIALS);
  }
  assert.deepEqual(retained, CREDENTIALS);
  assert.deepEqual(seenCapabilities, [CAPABILITY, CAPABILITY]);
});

test("an uncertain POST performs one deterministic capability recovery GET", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const created = await createEncryptedWatch({
    payload: {
      version: 1,
      target: { url: TARGET },
      options: { device: "desktop", gpcEnabled: true, reportMode: "r2", comparison: "none" }
    },
    credentials: CREDENTIALS,
    resolveApiUrl: (path) => `https://scanner.example${path}`,
    fetcher: async (input, init) => {
      requests.push({ input, init });
      if (requests.length === 1) throw new TypeError("response lost");
      return jsonResponse(status());
    }
  });

  assert.deepEqual(created.credentials, CREDENTIALS);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].input, "https://scanner.example/api/watches");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[1].input, `https://scanner.example/api/watches/${WATCH_ID}`);
  assert.equal(requests[1].init.method, "GET");
  for (const request of requests) {
    assert.equal(request.input.includes(CAPABILITY), false);
    assert.equal(new Headers(request.init.headers).get(ENCRYPTED_WATCH_CAPABILITY_HEADER), CAPABILITY);
  }
});

test("a malformed creation response recovers once, while mismatched credentials never reach the network", async () => {
  let calls = 0;
  const created = await createEncryptedWatch({
    payload: {
      version: 1,
      target: { url: TARGET },
      options: { device: "desktop", gpcEnabled: true, reportMode: "r2", comparison: "none" }
    },
    credentials: CREDENTIALS,
    resolveApiUrl: (path) => `https://scanner.example${path}`,
    fetcher: async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ ok: true, malformed: true }, 201) : jsonResponse(status());
    }
  });
  assert.deepEqual(created.credentials, CREDENTIALS);
  assert.equal(calls, 2);

  let attempted = false;
  await assert.rejects(
    createEncryptedWatch({
      payload: {
        version: 1,
        target: { url: TARGET },
        options: { device: "desktop", gpcEnabled: true, reportMode: "r2", comparison: "none" }
      },
      credentials: { ...CREDENTIALS, watchId: "f".repeat(32) },
      resolveApiUrl: (path) => path,
      fetcher: async () => {
        attempted = true;
        return jsonResponse(status());
      }
    }),
    /The scheduled rescan could not be created/
  );
  assert.equal(attempted, false);
});

test("watch read and delete send the capability only in its custom header", async () => {
  const requests: Array<{ input: string; init: RequestInit }> = [];
  const fetcher = async (input: string, init: RequestInit): Promise<Response> => {
    requests.push({ input, init });
    return init.method === "DELETE"
      ? jsonResponse({ ok: true, watchId: WATCH_ID, state: "deleted" })
      : jsonResponse(status());
  };
  const common = {
    credentials: CREDENTIALS,
    accessToken: " access-token ",
    resolveApiUrl: (path: string) => `https://scanner.example${path}`,
    fetcher
  };

  const read = await readEncryptedWatch(common);
  const deleted = await deleteEncryptedWatch(common);

  assert.equal(read.watchId, WATCH_ID);
  assert.deepEqual(deleted, { watchId: WATCH_ID, state: "deleted" });
  assert.deepEqual(requests.map(({ init }) => init.method), ["GET", "DELETE"]);
  for (const request of requests) {
    assert.equal(request.input, `https://scanner.example/api/watches/${WATCH_ID}`);
    assert.equal(request.input.includes(CAPABILITY), false);
    assert.equal(request.input.includes(TARGET), false);
    assert.equal(request.init.body, undefined);
    assert.equal(new Headers(request.init.headers).get(ENCRYPTED_WATCH_CAPABILITY_HEADER), CAPABILITY);
    assert.equal(new Headers(request.init.headers).get(SCAN_ACCESS_TOKEN_HEADER), "access-token");
    assert.equal(request.init.redirect, "error");
  }
});

test("management credentials round-trip only through the URL fragment", () => {
  const fragment = encodeEncryptedWatchCredentialsFragment(CREDENTIALS);
  assert.equal(fragment, `#watch=${WATCH_ID}.${CAPABILITY}`);
  assert.deepEqual(parseEncryptedWatchCredentialsFragment(fragment), CREDENTIALS);

  const managementUrl = encryptedWatchManagementUrl("https://site.example/reports?view=watch#old", CREDENTIALS);
  const parsed = new URL(managementUrl);
  assert.equal(parsed.pathname, "/reports");
  assert.equal(parsed.search, "");
  assert.equal(parsed.pathname.includes(WATCH_ID), false);
  assert.equal(parsed.search.includes(WATCH_ID), false);
  assert.equal(parsed.pathname.includes(CAPABILITY), false);
  assert.equal(parsed.search.includes(CAPABILITY), false);
  assert.equal(parsed.hash, fragment);
  assert.deepEqual(parseEncryptedWatchCredentialsFromUrl(managementUrl), CREDENTIALS);

  assert.throws(
    () => encryptedWatchManagementUrl(`https://site.example/${WATCH_ID}`, CREDENTIALS),
    /Invalid scheduled rescan management URL/
  );
  assert.equal(
    parseEncryptedWatchCredentialsFromUrl(
      `https://site.example/?capability=${CAPABILITY}${fragment}`
    ),
    null
  );
  assert.equal(parseEncryptedWatchCredentialsFragment(`${fragment}.extra`), null);
});

test("strict parsers cap run history at five and reject privacy or relationship drift", () => {
  const runs = Array.from({ length: ENCRYPTED_WATCH_MAX_RUNS }, (_value, index) => run(index + 1));
  const completed = status({
    state: "completed",
    nextRunAt: null,
    attemptCount: ENCRYPTED_WATCH_MAX_RUNS,
    runs
  });
  assert.ok(parseEncryptedWatchStatusResponse(completed));
  assert.ok(parseEncryptedWatchCreation({ ...completed, capability: CAPABILITY }));

  assert.equal(
    parseEncryptedWatchStatusResponse({
      ...completed,
      attemptCount: ENCRYPTED_WATCH_MAX_RUNS + 1,
      runs: [...runs, run(1)]
    }),
    null
  );
  assert.equal(
    parseEncryptedWatchStatusResponse({
      ...completed,
      state: "active",
      nextRunAt: CREATED_AT + ENCRYPTED_WATCH_CADENCE_MS,
      attemptCount: 0,
      runs: []
    }),
    null
  );
  assert.equal(parseEncryptedWatchStatusResponse({ ...completed, target: TARGET }), null);
  assert.equal(parseEncryptedWatchStatusResponse({ ...completed, capability: CAPABILITY }), null);
  assert.equal(parseEncryptedWatchStatusResponse({ ...completed, statusPath: "/api/watches/wrong" }), null);
  assert.equal(
    parseEncryptedWatchStatusResponse({
      ...completed,
      runs: [{ ...runs[0], statusPath: `/api/scans/${REPORT_ID}` }, ...runs.slice(1)]
    }),
    null
  );
  assert.equal(
    parseEncryptedWatchStatusResponse({
      ...completed,
      runs: runs.slice(0, -1)
    }),
    null
  );
  assert.equal(
    parseEncryptedWatchStatusResponse({
      ...completed,
      runs: [...runs.slice(0, -1), { ...runs[4], sequence: 4 }]
    }),
    null
  );
  const failedAttempt = {
    sequence: 5,
    admittedAt: null,
    jobId: null,
    statusPath: null,
    reportId: null,
    status: "failed",
    errorCode: "admission-failed"
  };
  assert.ok(
    parseEncryptedWatchStatusResponse({
      ...completed,
      runs: [...runs.slice(0, -1), failedAttempt]
    })
  );
  assert.equal(
    parseEncryptedWatchStatusResponse({
      ...completed,
      runs: [...runs.slice(0, -1), { ...failedAttempt, reportId: REPORT_ID }]
    }),
    null
  );
  assert.ok(
    parseEncryptedWatchStatusResponse({
      ...completed,
      runs: [
        { ...runs[0], status: "failed", errorCode: "1.scan_error" },
        ...runs.slice(1)
      ]
    })
  );
});

test("capability reads and deletes expose uniform errors while DELETE treats authoritative absence idempotently", async () => {
  const message = "The scheduled rescan capability is invalid or unavailable.";
  const common = {
    credentials: CREDENTIALS,
    resolveApiUrl: (path: string) => `https://scanner.example${path}`
  };
  const failures = [
    async () => jsonResponse({ ok: false, error: "Unauthorized" }, 401),
    async () => new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
    async () => {
      throw new TypeError("secret transport detail");
    }
  ];

  for (const fetcher of failures) {
    await assert.rejects(readEncryptedWatch({ ...common, fetcher }), (error: unknown) => {
      assert.equal((error as Error).message, message);
      return true;
    });
    await assert.rejects(deleteEncryptedWatch({ ...common, fetcher }), (error: unknown) => {
      assert.equal((error as Error).message, message);
      return true;
    });
  }

  const notFound = async () => jsonResponse({ ok: false, error: "Scheduled rescan not found." }, 404);
  await assert.rejects(readEncryptedWatch({ ...common, fetcher: notFound }), (error: unknown) => {
    assert.equal((error as Error).message, message);
    return true;
  });
  assert.deepEqual(await deleteEncryptedWatch({ ...common, fetcher: notFound }), {
    watchId: WATCH_ID,
    state: "deleted"
  });
  await assert.rejects(
    deleteEncryptedWatch({
      ...common,
      fetcher: async () => new Response("old deployment", { status: 404, headers: { "content-type": "text/html" } })
    }),
    /invalid or unavailable/
  );
});
