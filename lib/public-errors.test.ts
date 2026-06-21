import assert from "node:assert/strict";
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

test("toPublicError scrubs unexpected errors to a generic message and logs them server-side", () => {
  // A non-public error can carry internal detail — hostnames, private IPs, file
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

    assert.deepEqual(result, { message: "Scan failed. Check the target URL and try again.", status: 500 });
    assert.doesNotMatch(result.message, /ECONNREFUSED|10\.0\.0\.7|internal|db\.ts/);
    // The original error is preserved for operators, not leaked to the client.
    assert.deepEqual(logged, [leaky]);
  } finally {
    console.error = originalConsoleError;
  }
});
