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

type RecordedRequest = { method: string; url: string; headers: Record<string, string>; body: string };

function recordingFetch(responses: Response[]): { fetch: typeof fetch; requests: RecordedRequest[] } {
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
    return next;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function backendWith(responses: Response[]) {
  const recorder = recordingFetch(responses);
  const backend = createR2ReportStoreBackend(CONFIG, {
    // Skip real SigV4 signing; this exercises only the backend's HTTP behaviour.
    sign: async (input, init) => new Request(input, init),
    fetch: recorder.fetch
  });
  return { backend, requests: recorder.requests };
}

test("R2 write issues a create-only PUT to the prefixed key", async () => {
  const { backend, requests } = backendWith([new Response(null, { status: 200 })]);
  await backend.write(VALID_ID, "{}\n");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PUT");
  assert.equal(requests[0].url, `${CONFIG.endpoint}/reports-bucket/reports/${VALID_ID}.json`);
  assert.equal(requests[0].headers["if-none-match"], "*");
  assert.equal(requests[0].body, "{}\n");
});

test("R2 write rejects when the object already exists", async () => {
  const { backend } = backendWith([new Response(null, { status: 412 })]);
  await assert.rejects(() => backend.write(VALID_ID, "{}\n"), ReportStoreWriteConflictError);
});

test("R2 read returns contents and last-modified", async () => {
  const lastModified = "Fri, 20 Jun 2026 12:00:00 GMT";
  const { backend } = backendWith([
    new Response("REPORT-JSON", { status: 200, headers: { "last-modified": lastModified } })
  ]);

  assert.deepEqual(await backend.read(VALID_ID), {
    contents: "REPORT-JSON",
    lastModifiedMs: Date.parse(lastModified)
  });
});

test("R2 read returns null for a missing object", async () => {
  const { backend } = backendWith([new Response(null, { status: 404 })]);
  assert.equal(await backend.read(VALID_ID), null);
});

test("R2 remove tolerates a missing object", async () => {
  const { backend, requests } = backendWith([new Response(null, { status: 404 })]);
  await backend.remove(VALID_ID);
  assert.equal(requests[0].method, "DELETE");
});

test("R2 list paginates and keeps only valid report ids", async () => {
  const otherId = "20260619-ffffffffffffffffffffffffffffffff";
  const page1 = `<?xml version="1.0"?>
    <ListBucketResult>
      <Contents><Key>reports/${VALID_ID}.json</Key><LastModified>2026-06-20T12:00:00.000Z</LastModified></Contents>
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
    new Response(page2, { status: 200 })
  ]);

  const entries = await backend.list();
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [VALID_ID, otherId]
  );
  assert.ok(requests[1].url.includes("continuation-token=TOKEN123"));
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
