import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PublicScanError, toPublicError } from "./public-errors";
import {
  isScanFailureCause,
  scanFailureNotice,
  scanFailureText,
  type ScanFailureCause
} from "./scan-failure-causes";

// process.cwd(), not __dirname: these tests run from .unit-test-dist, where
// __dirname points at the compiled output rather than the sources they read.
const root = process.cwd();

// A Record over the union, so the compiler holds this list to exactly the
// declared vocabulary: a cause added to or removed from the module without this
// list fails to compile instead of silently escaping the tests below.
const CAUSE_KEYS: Record<ScanFailureCause, true> = {
  "invalid-url": true,
  "private-target": true,
  "target-unreachable": true,
  "page-load-timeout": true,
  "scanner-busy": true,
  "rate-limited": true,
  "challenge-required": true,
  "access-key-required": true,
  "request-rejected": true,
  "feature-unavailable": true,
  "scan-conflict": true,
  "service-error": true
};
const ALL_CAUSES = Object.keys(CAUSE_KEYS) as ScanFailureCause[];

/**
 * Every cause a producer declares at a throw site in lib, app, or cloudflare.
 *
 * Reads `new PublicScanError|PublicFacingError|EdgeScanGateError(..., "cause")`
 * in non-test sources. The `[^;]*?` span cannot cross a semicolon, so a throw
 * whose message text contains one is not seen; if a guard below fails for a
 * cause you can see being thrown, check for that first.
 */
function producerDeclaredCauses(): Set<string> {
  const declared = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "adblock-wasm") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue;
      const source = readFileSync(full, "utf8");
      for (const match of source.matchAll(
        /new (?:PublicScanError|PublicFacingError|EdgeScanGateError)\([^;]*?,\s*"([a-z-]+)"\s*\)/g
      )) {
        declared.add(match[1]!);
      }
    }
  };
  walk(path.join(root, "lib"));
  walk(path.join(root, "app"));
  walk(path.join(root, "cloudflare"));
  return declared;
}

test("every declared cause has reader-facing words", () => {
  for (const cause of ALL_CAUSES) {
    const notice = scanFailureNotice(cause);
    assert.ok(notice.message.length > 0, `${cause} needs a message`);
    assert.equal(typeof notice.retryable, "boolean");
  }
});

test("an undeclared cause returns the server's own words and invents no instruction", () => {
  const notice = scanFailureText(undefined, "Something the client has never heard of.");
  assert.equal(notice.message, "Something the client has never heard of.");
  assert.equal(notice.action, null);
  // Unknown strings must not be coerced into a cause.
  assert.equal(scanFailureText("not-a-cause", "raw").action, null);
  assert.equal(isScanFailureCause("not-a-cause"), false);
});

test("the three messages that used to be mis-mapped now carry a truthful cause", () => {
  // Each of these contains a substring the old ordered matcher keyed on, and
  // each rendered as a statement the server had never made.
  const cases: Array<{ message: string; cause: ScanFailureCause; mustNotSay: RegExp }> = [
    {
      // contains "private" -> used to blame the visitor's public URL
      message: "Durable scan admission must use the private coordinator.",
      cause: "feature-unavailable",
      mustNotSay: /localhost|private network/i
    },
    {
      // contains "token" -> used to demand an access key on an open scanner
      message: "This durable scan-job activation has the wrong lease token.",
      cause: "scan-conflict",
      mustNotSay: /access key/i
    },
    {
      // matched nothing -> raw operator prose, and no hint to re-solve
      message: "Turnstile verification failed.",
      cause: "challenge-required",
      mustNotSay: /^Turnstile verification failed\.$/
    }
  ];
  for (const { message, cause, mustNotSay } of cases) {
    const notice = scanFailureText(cause, message);
    const rendered = `${notice.message} ${notice.action ?? ""}`;
    assert.doesNotMatch(rendered, mustNotSay, `${cause} still renders the old wrong text`);
  }
});

test("a failed challenge tells the visitor to solve it again", () => {
  // The client consumes and resets the token, so the challenge on screen is
  // genuinely unsolved. Without this sentence the visitor has no way to know.
  const notice = scanFailureNotice("challenge-required");
  assert.match(notice.action ?? "", /solve/i);
  assert.equal(notice.retryable, true);
});

test("an open scanner never sends the visitor looking for an access key", () => {
  const gated = scanFailureText("access-key-required", "x", { openAccessScanner: false });
  assert.match(gated.action ?? "", /access key/i);
  const open = scanFailureText("access-key-required", "x", { openAccessScanner: true });
  assert.doesNotMatch(open.action ?? "", /add the scanner access key/i);
});

test("toPublicError carries a declared cause and omits the key entirely otherwise", () => {
  const declared = toPublicError(new PublicScanError("nope", 400, "invalid-url"));
  assert.deepEqual(declared, { message: "nope", status: 400, cause: "invalid-url" });

  // Omitted, not set to undefined. The existing contract tests compare this
  // object with deepEqual to pin the exact public shape, and an unexplained
  // failure must reach the reader as the server's own words with nothing added.
  assert.deepEqual(toPublicError(new PublicScanError("nope", 400)), {
    message: "nope",
    status: 400
  });

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    // An error we could not identify gets no cause: classifying it would be the
    // same guess this mechanism exists to remove. Its scrubbed message already
    // carries its own advice.
    assert.deepEqual(toPublicError(new Error("boom")), {
      message: "The service could not complete this request. Try again later.",
      status: 500
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test("the client no longer infers a cause by matching the server's prose", () => {
  // This is the actual defect. A future edit that reintroduces substring
  // matching over the message would restore every mis-map above, and every one
  // of them would still pass its own unit test.
  const source = readFileSync(path.join(root, "lib", "scan-client-orchestration.ts"), "utf8");
  const start = source.indexOf("export function friendlyScanError");
  assert.ok(start > 0, "friendlyScanError must exist");
  const body = source.slice(start, start + 1400);
  for (const forbidden of ["lower.includes", "toLowerCase()"]) {
    assert.equal(
      body.includes(forbidden),
      false,
      `friendlyScanError must not re-derive a cause with ${forbidden}`
    );
  }
});

test("both producers emit the cause on the wire", () => {
  // One contract, two producers. If either stops sending `cause`, the client
  // silently falls back to verbatim prose for that whole surface and the
  // regression is invisible in the other producer's tests.
  const node = readFileSync(path.join(root, "app", "api", "scan", "route.ts"), "utf8");
  assert.match(node, /cause:\s*publicError\.cause/);
  const worker = readFileSync(path.join(root, "cloudflare", "container-worker.ts"), "utf8");
  assert.match(worker, /cause:\s*publicError\.cause/);
});

test("no public scan error declares a cause outside the closed vocabulary", () => {
  // Guards against a typo'd cause silently becoming an unclassified failure.
  const declared = producerDeclaredCauses();
  assert.ok(declared.size > 0, "no declared causes were found to check");
  for (const cause of declared) {
    assert.equal(isScanFailureCause(cause), true, `"${cause}" is not a declared cause`);
  }
});

test("every cause in the vocabulary is declared by a producer or listed as undeclared", () => {
  // Words for a case no producer throws describe behavior the product does not
  // have, and the next reader of the module believes the case is handled.
  // "target-refused-automation" was that: written, tested, and never declared,
  // because the navigation-failure 502 cannot tell a refusal from an outage.
  //
  // Causes no producer declares today. Allowed, not required: when one gets a
  // producer this test still passes, and the entry can simply be dropped.
  const undeclaredAllowed = new Set<ScanFailureCause>([
    // toPublicError's unexpected-error branch declines to classify.
    "service-error",
    // The lease conflicts in lib/scan-jobs.ts throw 409 without a cause.
    "scan-conflict",
    // The 429 throws in lib/scan-limits.ts and the Worker carry no cause.
    "rate-limited"
  ]);
  const declared = producerDeclaredCauses();
  for (const cause of ALL_CAUSES) {
    assert.ok(
      declared.has(cause) || undeclaredAllowed.has(cause),
      `"${cause}" has reader-facing words but no producer declares it`
    );
  }
});
