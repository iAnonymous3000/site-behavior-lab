import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

type SmokeR2Server = {
  port: number;
  snapshot(): Array<{ key: string; body: string; headers: Record<string, string> }>;
  close(): Promise<void>;
};

type SmokeR2Helpers = {
  startSmokeR2Server(options: { bucket: string }): Promise<SmokeR2Server>;
};

const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<SmokeR2Helpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "smoke-r2-server.mjs")).href
);

test("Docker smoke R2 endpoint supports conditional writes, list, metadata readback, and delete", async () => {
  const { startSmokeR2Server } = await helpers;
  const server = await startSmokeR2Server({ bucket: "smoke-bucket" });
  const endpoint = `http://127.0.0.1:${server.port}/smoke-bucket`;
  const key = "reports/20260719-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json";
  const objectUrl = `${endpoint}/${key}`;
  const metadata = {
    "x-amz-meta-created-at": "2026-07-19T00:00:00.000Z",
    "x-amz-meta-expires-at": "2026-07-26T00:00:00.000Z"
  };

  try {
    const created = await fetch(objectUrl, {
      method: "PUT",
      headers: { "if-none-match": "*", ...metadata },
      body: '{"schemaVersion":2}\n'
    });
    assert.equal(created.status, 200);
    assert.equal((await fetch(objectUrl, { method: "PUT", headers: { "if-none-match": "*" }, body: "x" })).status, 412);

    const listed = await fetch(`${endpoint}?list-type=2&prefix=reports%2F`).then((response) => response.text());
    assert.match(listed, new RegExp(`<Key>${key.replaceAll(".", "\\.")}</Key>`));

    const head = await fetch(objectUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("x-amz-meta-created-at"), metadata["x-amz-meta-created-at"]);
    assert.equal(await fetch(objectUrl).then((response) => response.text()), '{"schemaVersion":2}\n');
    assert.deepEqual(server.snapshot().map((object) => object.key), [key]);

    assert.equal((await fetch(objectUrl, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(objectUrl)).status, 404);
  } finally {
    await server.close();
  }
});
