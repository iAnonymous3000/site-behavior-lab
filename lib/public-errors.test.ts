import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { EdgeUrlSafetyError } from "./edge-url-safety";
import { PublicFacingError, PublicScanError, toPublicError } from "./public-errors";

test("public-facing errors share one status-carrying base class", () => {
  const scanError = new PublicScanError("Nope.", 429);
  const edgeError = new EdgeUrlSafetyError("Blocked.", 400);

  assert.equal(scanError instanceof PublicFacingError, true);
  assert.equal(edgeError instanceof PublicFacingError, true);
  assert.deepEqual(toPublicError(scanError), { message: "Nope.", status: 429 });
  assert.deepEqual(toPublicError(edgeError), { message: "Blocked.", status: 400 });
});

test("toPublicError scrubs unexpected errors without blaming the target URL and logs them server-side", () => {
  // A non-public error can carry internal detail, hostnames, private IPs, file
  // paths, stack frames. The client response must never echo it; the operator log
  // must still receive the original. This pins the no-leak guarantee for the
  // public scanner so a future refactor of toPublicError cannot silently expose
  // internals.
  const originalConsoleError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args[0]);
  };

  try {
    const leaky = new Error("connect ECONNREFUSED 10.0.0.7:5432 at /srv/internal/db.ts:42");
    const result = toPublicError(leaky);

    assert.deepEqual(result, {
      message: "The service could not complete this request. Try again later.",
      status: 500
    });
    assert.doesNotMatch(result.message, /ECONNREFUSED|10\.0\.0\.7|internal|db\.ts/);
    assert.doesNotMatch(result.message, /target URL|check.*URL/i);
    // The original error is preserved for operators, not leaked to the client.
    assert.deepEqual(logged, [leaky]);
  } finally {
    console.error = originalConsoleError;
  }
});

test("front Workers scrub unexpected exception text before unauthenticated responses", () => {
  const worker = readFileSync(path.join(process.cwd(), "cloudflare", "worker.ts"), "utf8");
  const containerWorker = readFileSync(path.join(process.cwd(), "cloudflare", "container-worker.ts"), "utf8");

  assert.match(
    worker,
    /catch \(error\) \{\s*const publicError = toPublicError\(error\);\s*return jsonResponse\(\{ ok: false, error: publicError\.message \}, request, env, publicError\.status\);/
  );
  assert.match(
    containerWorker,
    /function gateErrorResponse[\s\S]*?const publicError = toPublicError\(error\);[\s\S]*?JSON\.stringify\(\{ ok: false, error: publicError\.message \}\)[\s\S]*?status: publicError\.status,/
  );
  assert.doesNotMatch(worker, /const message = error instanceof Error \? error\.message/);
  assert.doesNotMatch(containerWorker, /const message = error instanceof Error \? error\.message/);
});
