import { createServer } from "node:http";

const MAX_OBJECT_BYTES = 32 * 1024 * 1024;

/**
 * Start the smallest S3-compatible surface needed by the report store's Docker
 * smoke. It is intentionally process-local test infrastructure: SigV4 headers
 * are accepted but never authenticated, and no production code imports it.
 */
export async function startSmokeR2Server({ bucket = "site-behavior-lab-smoke" } = {}) {
  const objects = new Map();
  const server = createServer(async (request, response) => {
    try {
      await handleRequest({ request, response, bucket, objects });
    } catch (error) {
      response.statusCode = error instanceof ObjectTooLargeError ? 413 : 500;
      response.setHeader("content-type", "application/xml");
      response.end(`<Error><Code>SmokeStoreError</Code></Error>`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Could not allocate the Docker R2 smoke endpoint.");
  }

  return Object.freeze({
    port: address.port,
    snapshot() {
      return [...objects.entries()].map(([key, object]) =>
        Object.freeze({ key, body: object.body.toString("utf8"), headers: Object.freeze({ ...object.headers }) })
      );
    },
    close: () => closeServer(server)
  });
}

async function handleRequest({ request, response, bucket, objects }) {
  const url = new URL(request.url || "/", "http://smoke.invalid");
  const bucketPath = `/${encodeURIComponent(bucket)}`;
  if (url.pathname === bucketPath && request.method === "GET" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") || "";
    const listed = [...objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right));
    response.statusCode = 200;
    response.setHeader("content-type", "application/xml");
    response.end(listResultXml(bucket, prefix, listed));
    return;
  }

  if (!url.pathname.startsWith(`${bucketPath}/`)) {
    writeXmlError(response, 404, "NoSuchBucket");
    return;
  }
  let key;
  try {
    key = decodeURIComponent(url.pathname.slice(bucketPath.length + 1));
  } catch {
    writeXmlError(response, 400, "InvalidURI");
    return;
  }
  if (!key) {
    writeXmlError(response, 404, "NoSuchKey");
    return;
  }

  if (request.method === "PUT") {
    if (request.headers["if-none-match"] === "*" && objects.has(key)) {
      writeXmlError(response, 412, "PreconditionFailed");
      return;
    }
    const body = await readBody(request);
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.startsWith("x-amz-meta-") && typeof value === "string") headers[name] = value;
    }
    objects.set(key, { body, headers, lastModified: new Date().toISOString() });
    response.statusCode = 200;
    response.setHeader("etag", `"smoke-${body.byteLength}"`);
    response.end();
    return;
  }

  const object = objects.get(key);
  if (request.method === "GET" || request.method === "HEAD") {
    if (!object) {
      writeXmlError(response, 404, "NoSuchKey");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.setHeader("content-length", String(object.body.byteLength));
    response.setHeader("last-modified", new Date(object.lastModified).toUTCString());
    for (const [name, value] of Object.entries(object.headers)) response.setHeader(name, value);
    response.end(request.method === "HEAD" ? undefined : object.body);
    return;
  }

  if (request.method === "DELETE") {
    objects.delete(key);
    response.statusCode = 204;
    response.end();
    return;
  }

  response.statusCode = 405;
  response.setHeader("allow", "GET, HEAD, PUT, DELETE");
  response.end();
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_OBJECT_BYTES) throw new ObjectTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function listResultXml(bucket, prefix, entries) {
  const contents = entries
    .map(
      ([key, object]) =>
        `<Contents><Key>${xml(key)}</Key><LastModified>${xml(object.lastModified)}</LastModified>` +
        `<ETag>&quot;smoke-${object.body.byteLength}&quot;</ETag><Size>${object.body.byteLength}</Size>` +
        `<StorageClass>STANDARD</StorageClass></Contents>`
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ListBucketResult><Name>${xml(bucket)}</Name><Prefix>${xml(prefix)}</Prefix>` +
    `<KeyCount>${entries.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>` +
    `${contents}</ListBucketResult>`
  );
}

function writeXmlError(response, status, code) {
  response.statusCode = status;
  response.setHeader("content-type", "application/xml");
  response.end(`<Error><Code>${code}</Code></Error>`);
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

class ObjectTooLargeError extends Error {}
