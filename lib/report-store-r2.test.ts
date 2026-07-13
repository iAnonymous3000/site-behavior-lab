import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReportStoreWriteConflictError,
  createR2ReportStoreBackend,
  parseListResult,
  type R2ReportStoreConfig
} from "./report-store-r2";

const CONFIG: R2ReportStoreConfig = {
  bucket: "reports-bucket",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  accessKeyId: "ak",
  secretAccessKey: "sk",
  prefix: "reports/"
};

const VALID_ID = "20260620-0123456789abcdef0123456789abcdef";
const RETENTION = {
  createdAt: "2026-06-20T12:00:00.000Z",
  expiresAt: "2026-06-27T12:00:00.000Z"
};

function retentionHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-amz-meta-created-at": RETENTION.createdAt,
    "x-amz-meta-expires-at": RETENTION.expiresAt,
    ...extra
  };
}

type RecordedRequest = { method: string; url: string; headers: Record<string, string>; body: string };

/** Queue a Response to return it, or an Error to simulate a network failure. */
function recordingFetch(responses: (Response | Error)[]): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const queue = [...responses];
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: Request): Promise<Response> => {
    const headers: Record<string, string> = {};
    input.headers.forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({
      method: input.method,
      url: input.url,
      headers,
      body: input.body ? await input.clone().text() : ""
    });
    const next = queue.shift();
    if (!next) throw new Error("No queued response for request.");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function backendWith(responses: (Response | Error)[]) {
  const recorder = recordingFetch(responses);
  const sleeps: number[] = [];
  const backend = createR2ReportStoreBackend(CONFIG, {
    // Skip real SigV4 signing; this exercises only the backend's HTTP behaviour.
    sign: async (input, init) => new Request(input, init),
    fetch: recorder.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });
  return { backend, requests: recorder.requests, sleeps };
}

test("R2 write issues a create-only PUT to the prefixed key", async () => {
  const { backend, requests } = backendWith([new Response(null, { status: 200 })]);
  await backend.write(VALID_ID, "{}\n", RETENTION);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PUT");
  assert.equal(requests[0].url, `${CONFIG.endpoint}/reports-bucket/reports/${VALID_ID}.json`);
  assert.equal(requests[0].headers["content-length"], "3");
  assert.equal(requests[0].headers["if-none-match"], "*");
  assert.equal(requests[0].headers["x-amz-meta-created-at"], RETENTION.createdAt);
  assert.equal(requests[0].headers["x-amz-meta-expires-at"], RETENTION.expiresAt);
  assert.equal(requests[0].body, "{}\n");
});

test("R2 writes and reads the provenance sidecar beside the report key", async () => {
  const sidecar = '{"reportId":"test"}\n';
  const { backend, requests } = backendWith([
    new Response(null, { status: 200 }),
    new Response(sidecar, { status: 200 })
  ]);
  await backend.writeSidecar(VALID_ID, sidecar);
  assert.equal(await backend.readSidecar(VALID_ID), sidecar);
  assert.equal(requests[0].url, `${CONFIG.endpoint}/reports-bucket/reports/${VALID_ID}.json.provenance.json`);
  assert.equal(requests[0].method, "PUT");
  assert.equal(requests[0].headers["content-length"], String(new TextEncoder().encode(sidecar).byteLength));
  assert.equal(requests[1].method, "GET");
});

test("R2 write declares the UTF-8 byte length rather than the JavaScript string length", async () => {
  const { backend, requests } = backendWith([new Response(null, { status: 200 })]);
  await backend.write(VALID_ID, '"snowman: ☃"\n');

  assert.equal(requests[0].headers["content-length"], "15");
});

test("R2 sidecar write is create-only", async () => {
  const { backend } = backendWith([new Response(null, { status: 412 })]);
  await assert.rejects(() => backend.writeSidecar(VALID_ID, "{}\n"), ReportStoreWriteConflictError);
});

test("R2 write rejects when the object already exists", async () => {
  const { backend } = backendWith([new Response(null, { status: 412 })]);
  await assert.rejects(() => backend.write(VALID_ID, "{}\n"), ReportStoreWriteConflictError);
});

test("R2 write retries a transient 5xx and succeeds", async () => {
  const { backend, requests, sleeps } = backendWith([
    new Response("busy", { status: 503 }),
    new Response(null, { status: 200 })
  ]);
  await backend.write(VALID_ID, "{}\n");

  assert.equal(requests.length, 2);
  assert.equal(requests[1].method, "PUT");
  assert.deepEqual(sleeps, [250]);
});

test("R2 write retries a dropped connection and succeeds", async () => {
  const { backend, requests } = backendWith([
    new Error("socket hang up"),
    new Response(null, { status: 200 })
  ]);
  await backend.write(VALID_ID, "{}\n");
  assert.equal(requests.length, 2);
});

test("R2 write treats a 412 after a lost response as success when the object matches", async () => {
  // First PUT lands server-side but the response is lost; the retried
  // create-only PUT then 412s. The read-back proves our write succeeded.
  const { backend, requests } = backendWith([
    new Error("socket hang up"),
    new Response(null, { status: 412 }),
    new Response("{}\n", {
      status: 200,
      headers: retentionHeaders({ "last-modified": "Fri, 20 Jun 2026 12:00:00 GMT" })
    })
  ]);
  await backend.write(VALID_ID, "{}\n", RETENTION);

  assert.equal(requests.length, 3);
  assert.equal(requests[2].method, "GET");
});

test("R2 write still rejects a 412 after a lost response when the object differs", async () => {
  const { backend } = backendWith([
    new Error("socket hang up"),
    new Response(null, { status: 412 }),
    new Response("SOMEONE-ELSES-REPORT", { status: 200 })
  ]);
  await assert.rejects(() => backend.write(VALID_ID, "{}\n"), ReportStoreWriteConflictError);
});

test("R2 ambiguous replay requires immutable retention metadata to match", async () => {
  const { backend } = backendWith([
    new Error("socket hang up"),
    new Response(null, { status: 412 }),
    new Response("{}\n", {
      status: 200,
      headers: retentionHeaders({ "x-amz-meta-expires-at": "2026-07-01T12:00:00.000Z" })
    })
  ]);
  await assert.rejects(() => backend.write(VALID_ID, "{}\n", RETENTION), ReportStoreWriteConflictError);
});

test("R2 write gives up after exhausting retries", async () => {
  const { backend, requests, sleeps } = backendWith([
    new Response(null, { status: 500 }),
    new Response(null, { status: 500 }),
    new Response(null, { status: 500 })
  ]);
  await assert.rejects(() => backend.write(VALID_ID, "{}\n"), /HTTP 500/);
  assert.equal(requests.length, 3);
  assert.deepEqual(sleeps, [250, 750]);
});

test("R2 write does not retry a non-retryable client error", async () => {
  const { backend, requests } = backendWith([new Response(null, { status: 403 })]);
  await assert.rejects(() => backend.write(VALID_ID, "{}\n"), /HTTP 403/);
  assert.equal(requests.length, 1);
});

test("R2 read retries a transient failure and succeeds", async () => {
  const { backend, requests } = backendWith([
    new Error("read ECONNRESET"),
    new Response("REPORT-JSON", { status: 200, headers: { "last-modified": "Fri, 20 Jun 2026 12:00:00 GMT" } })
  ]);
  const blob = await backend.read(VALID_ID);
  assert.equal(blob?.contents, "REPORT-JSON");
  assert.equal(requests.length, 2);
});

test("R2 read returns contents, diagnostic last-modified, and immutable retention metadata", async () => {
  const lastModified = "Fri, 20 Jun 2026 12:00:00 GMT";
  const { backend } = backendWith([
    new Response("REPORT-JSON", { status: 200, headers: retentionHeaders({ "last-modified": lastModified }) })
  ]);

  assert.deepEqual(await backend.read(VALID_ID), {
    contents: "REPORT-JSON",
    lastModifiedMs: Date.parse(lastModified),
    retention: RETENTION
  });
});

test("R2 read treats missing or malformed custom retention metadata as unknown", async () => {
  const { backend } = backendWith([new Response("REPORT-JSON", { status: 200 })]);
  assert.equal((await backend.read(VALID_ID))?.retention, null);
});

test("R2 read returns null for a missing object", async () => {
  const { backend } = backendWith([new Response(null, { status: 404 })]);
  assert.equal(await backend.read(VALID_ID), null);
});

test("R2 remove tolerates a missing object", async () => {
  const { backend, requests } = backendWith([
    new Response(null, { status: 404 }),
    new Response(null, { status: 404 })
  ]);
  await backend.remove(VALID_ID);
  assert.match(requests[0].url, /\.json\.provenance\.json$/);
  assert.equal(requests[0].method, "DELETE");
  assert.match(requests[1].url, new RegExp(`${VALID_ID}\\.json$`));
});

test("R2 remove attempts both halves when one delete fails", async () => {
  const { backend, requests } = backendWith([
    new Response("denied", { status: 403 }),
    new Response(null, { status: 200 })
  ]);
  await assert.rejects(() => backend.remove(VALID_ID), /HTTP 403/);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\.json\.provenance\.json$/);
  assert.match(requests[1].url, new RegExp(`${VALID_ID}\\.json$`));
});

test("R2 list paginates, keeps valid ids, and reads retention independently of rewrite time", async () => {
  const otherId = "20260619-ffffffffffffffffffffffffffffffff";
  const page1 = `<?xml version="1.0"?>
    <ListBucketResult>
      <Contents><Key>reports/${VALID_ID}.json</Key><LastModified>2030-01-01T00:00:00.000Z</LastModified></Contents>
      <Contents><Key>reports/not-a-report.txt</Key><LastModified>2026-06-20T12:00:00.000Z</LastModified></Contents>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>TOKEN123</NextContinuationToken>
    </ListBucketResult>`;
  const page2 = `<?xml version="1.0"?>
    <ListBucketResult>
      <Contents><Key>reports/${otherId}.json</Key><LastModified>2026-06-19T08:00:00.000Z</LastModified></Contents>
      <IsTruncated>false</IsTruncated>
    </ListBucketResult>`;

  const { backend, requests } = backendWith([
    new Response(page1, { status: 200 }),
    new Response(null, { status: 200, headers: retentionHeaders() }),
    new Response(page2, { status: 200 }),
    new Response(null, {
      status: 200,
      headers: {
        "x-amz-meta-created-at": "2026-06-19T08:00:00.000Z",
        "x-amz-meta-expires-at": "2026-06-26T08:00:00.000Z"
      }
    })
  ]);

  const entries = await backend.list();
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [VALID_ID, otherId]
  );
  assert.deepEqual(entries[0].retention, RETENTION);
  assert.equal(entries[0].lastModifiedMs, Date.parse("2030-01-01T00:00:00.000Z"));
  assert.equal(requests[1].method, "HEAD");
  assert.ok(requests[2].url.includes("continuation-token=TOKEN123"));
  assert.equal(requests[3].method, "HEAD");
});

test("parseListResult ignores keys outside the prefix", () => {
  const xml = `<ListBucketResult>
    <Contents><Key>other/${VALID_ID}.json</Key><LastModified>2026-06-20T12:00:00.000Z</LastModified></Contents>
    <IsTruncated>false</IsTruncated>
  </ListBucketResult>`;
  assert.deepEqual(parseListResult(xml, "reports/").entries, []);
});

test("R2 status reports the bucket and prefix", () => {
  const { backend } = backendWith([]);
  assert.deepEqual(backend.status(), {
    kind: "r2",
    bucket: "reports-bucket",
    prefix: "reports/",
    configuredPath: true
  });
});
