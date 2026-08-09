import assert from "node:assert/strict";
import test from "node:test";
import { readVerifyArtifactTextWithinLimit } from "./verify-published-report-fetch";

const TEST_URL = "https://reports.example.test/report.json";

test("a headerless response is cancelled at the first over-limit chunk", async () => {
  let chunksServed = 0;
  let cancelled = false;
  const chunk = new Uint8Array(3).fill(120);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        chunksServed += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
        // Cleanup from a broken transport must not hold the size refusal open.
        return new Promise<void>(() => undefined);
      }
    },
    { highWaterMark: 0 }
  );
  const response = new Response(body);
  assert.equal(response.headers.get("content-length"), null);

  await assert.rejects(
    settleWithin(readVerifyArtifactTextWithinLimit(response, TEST_URL, 4)),
    new Error(`${TEST_URL} exceeded the 4 byte ceiling.`)
  );
  assert.equal(cancelled, true);
  assert.equal(chunksServed, 2, "the reader must stop as soon as the next chunk crosses the cap");
});

test("a headerless response at the exact byte ceiling is accepted", async () => {
  const encoder = new TextEncoder();
  const chunks = [encoder.encode("é"), encoder.encode("é")];
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      }
    },
    { highWaterMark: 0 }
  );
  const response = new Response(body);
  assert.equal(response.headers.get("content-length"), null);

  assert.equal(await readVerifyArtifactTextWithinLimit(response, TEST_URL, 4), "éé");
});

test("an encoded response ignores wire Content-Length and enforces decoded bytes", async () => {
  const response = new Response("decoded", {
    headers: {
      "content-encoding": "gzip",
      "content-length": "1024"
    }
  });
  assert.equal(
    await readVerifyArtifactTextWithinLimit(response, TEST_URL, 7),
    "decoded"
  );
});

test("an identity response retains the declared-length early refusal", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      }
    }),
    {
      headers: {
        "content-encoding": "identity",
        "content-length": "8"
      }
    }
  );
  await assert.rejects(
    readVerifyArtifactTextWithinLimit(response, TEST_URL, 7),
    new Error(`${TEST_URL} declares 8 bytes, above the 7 ceiling.`)
  );
  assert.equal(cancelled, true);
});

test("an identity response must finish at its exact declared length", async () => {
  const exact = new Response("decoded", {
    headers: {
      "content-encoding": "identity",
      "content-length": "7"
    }
  });
  assert.equal(
    await readVerifyArtifactTextWithinLimit(exact, TEST_URL, 8),
    "decoded"
  );

  const mismatched = new Response("decoded", {
    headers: {
      "content-encoding": "identity",
      "content-length": "6"
    }
  });
  await assert.rejects(
    readVerifyArtifactTextWithinLimit(mismatched, TEST_URL, 8),
    new Error(`${TEST_URL} body length does not match Content-Length.`)
  );
});

test("many tiny and empty chunks do not create retained per-chunk state", async () => {
  const emptyChunkCount = 50_000;
  const expectedBytes = 256;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls < emptyChunkCount) {
          pulls += 1;
          controller.enqueue(new Uint8Array());
          return;
        }
        if (pulls < emptyChunkCount + expectedBytes) {
          pulls += 1;
          controller.enqueue(Uint8Array.of(120));
          return;
        }
        controller.close();
      }
    },
    { highWaterMark: 0 }
  );

  assert.equal(
    await readVerifyArtifactTextWithinLimit(new Response(body), TEST_URL, expectedBytes),
    "x".repeat(expectedBytes)
  );
  assert.equal(pulls, emptyChunkCount + expectedBytes);
});

test("the byte ceiling is validated before allocating the fixed buffer", async () => {
  await assert.rejects(
    readVerifyArtifactTextWithinLimit(new Response("x"), TEST_URL, 0),
    new TypeError("The verifier response byte ceiling must be a positive safe integer.")
  );
  await assert.rejects(
    readVerifyArtifactTextWithinLimit(new Response("x"), TEST_URL, Number.MAX_SAFE_INTEGER + 1),
    new TypeError("The verifier response byte ceiling must be a positive safe integer.")
  );
});

async function settleWithin<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation did not settle after refusing the body")), 1_000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
