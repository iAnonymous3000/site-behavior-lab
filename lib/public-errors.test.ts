import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PublicFacingError, PublicScanError, toPublicError } from "./public-errors";
import { PublicUrlDnsUnavailableError } from "./url-safety";

test("public-facing errors share one status-carrying base class", () => {
  const scanError = new PublicScanError("Nope.", 429);
  const dnsError = new PublicUrlDnsUnavailableError("EAI_AGAIN");

  assert.equal(scanError instanceof PublicFacingError, true);
  assert.equal(dnsError instanceof PublicFacingError, true);
  assert.deepEqual(toPublicError(scanError), { message: "Nope.", status: 429 });
  // A verification outage must reach the client as its own 503, not be masked.
  assert.deepEqual(toPublicError(dnsError), {
    message: "Public host verification could not complete. Try again shortly.",
    status: 503
  });
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

test("the front Worker scrubs unexpected exception text before unauthenticated responses", () => {
  const containerWorker = readFileSync(path.join(process.cwd(), "cloudflare", "container-worker.ts"), "utf8");

  // The guarantee is that the Worker's body comes from `toPublicError`, never
  // from raw exception text. The declared `cause` may ride alongside the
  // scrubbed message -- it is a closed vocabulary member, not error text -- so
  // the pattern allows fields after `error:` while still pinning the scrub.
  assert.match(
    containerWorker,
    /function gateErrorResponse[\s\S]*?const publicError = toPublicError\(error\);[\s\S]*?JSON\.stringify\(\{ ok: false, error: publicError\.message[^}]*\}\)[\s\S]*?status: publicError\.status,/
  );
  assert.doesNotMatch(containerWorker, /const message = error instanceof Error \? error\.message/);
});
