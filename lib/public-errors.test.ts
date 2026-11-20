import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PublicFacingError, PublicScanError, publicErrorBody, publicErrorHeaders, toPublicError } from "./public-errors";
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
    /function gateErrorResponse[\s\S]*?const publicError = toPublicError\(error\);[\s\S]*?JSON\.stringify\(publicErrorBody\(publicError\)\)[\s\S]*?status: publicError\.status,/
  );
  assert.doesNotMatch(containerWorker, /const message = error instanceof Error \? error\.message/);
});

test("a quota refusal carries its wait as data, and every other body keeps its exact bytes", () => {
  assert.deepEqual(toPublicError(new PublicScanError("m", 429, "request-limit", 30)), {
    message: "m",
    status: 429,
    cause: "request-limit",
    retryAfterSeconds: 30
  });
  // Omitted, never undefined, exactly like `cause`: a wait the thrower did not
  // establish as a whole positive number of seconds is not sent at all.
  for (const invalid of [0, -5, 1.5, Number.NaN]) {
    assert.deepEqual(toPublicError(new PublicScanError("m", 429, "request-limit", invalid)), {
      message: "m",
      status: 429,
      cause: "request-limit"
    });
  }

  // The builder adds nothing to a body without a cause or a wait, so every
  // existing producer's bytes are unchanged.
  assert.equal(JSON.stringify(publicErrorBody({ message: "m", status: 400 })), '{"ok":false,"error":"m"}');
  assert.equal(
    JSON.stringify(publicErrorBody({ message: "m", status: 400, cause: "invalid-url" })),
    '{"ok":false,"error":"m","cause":"invalid-url"}'
  );
  assert.equal(
    JSON.stringify(publicErrorBody(toPublicError(new PublicScanError("m", 429, "request-limit", 30)))),
    '{"ok":false,"error":"m","cause":"request-limit","retryAfterSeconds":30}'
  );
});

test("a refusal that carries a wait also sends it as Retry-After, and no other body gains the header", () => {
  const withWait = toPublicError(new PublicScanError("Too many report requests. Try again in about 37 seconds.", 429, undefined, 37));
  assert.equal(publicErrorHeaders(withWait)["Retry-After"], "37");
  assert.equal(publicErrorBody(withWait).retryAfterSeconds, 37, "the header and the body carry the same wait");

  assert.equal(publicErrorHeaders(toPublicError(new PublicScanError("Refused.", 429)))["Retry-After"], undefined);
  assert.equal(
    publicErrorHeaders(toPublicError(new PublicScanError("Refused.", 429, undefined, 0)))["Retry-After"],
    undefined,
    "no wait of 0"
  );
  assert.equal(publicErrorHeaders(toPublicError(new Error("unexpected")))["Retry-After"], undefined);
});

test("every public error is sent uncached and unsniffed, and gains no other header", () => {
  // The Worker's gate refusals are answered at the edge, so next.config's
  // /api headers never reach them. These two travel with the body instead.
  const errors: Array<[string, ReturnType<typeof toPublicError>]> = [
    ["a refusal with a wait", toPublicError(new PublicScanError("Refused.", 429, undefined, 37))],
    ["a refusal without a wait", toPublicError(new PublicScanError("Refused.", 429))],
    ["a caused refusal", toPublicError(new PublicScanError("Refused.", 400, "invalid-url"))],
    ["an unexpected error", toPublicError(new Error("unexpected"))]
  ];
  for (const [label, publicError] of errors) {
    const headers = publicErrorHeaders(publicError);
    assert.equal(headers["Cache-Control"], "no-store", `${label} is never cached`);
    assert.equal(headers["X-Content-Type-Options"], "nosniff", `${label} is never sniffed`);
  }
  assert.deepEqual(
    publicErrorHeaders(errors[0][1]),
    { "Cache-Control": "no-store", "Retry-After": "37", "X-Content-Type-Options": "nosniff" },
    "a refusal with a wait gains exactly these headers"
  );
  assert.deepEqual(
    publicErrorHeaders(errors[1][1]),
    { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    "a refusal without a wait gains exactly these headers"
  );
});
