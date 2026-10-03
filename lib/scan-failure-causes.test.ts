import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PublicScanError, toPublicError } from "./public-errors";
import { requireIndex } from "./source-markers";
import {
  formatScanRetryWait,
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
  "page-load-failed": true,
  "host-lookup-timeout": true,
  "public-suffix-target": true,
  "generalized-tenant-target": true,
  "address-fanout-target": true,
  "unnameable-subject-target": true,
  "report-redaction-unstable": true,
  "scanner-busy": true,
  "request-limit": true,
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
 * in non-test sources, optionally followed by one identifier or member
 * expression (a quota refusal's `retryAfterSeconds`). The `[^;]*?` span cannot
 * cross a semicolon, so a throw whose message text contains one is not seen; if
 * a guard below fails for a cause you can see being thrown, check for that first.
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
        /new (?:PublicScanError|PublicFacingError|EdgeScanGateError)\([^;]*?,\s*"([a-z-]+)"\s*(?:,\s*[A-Za-z_$][\w$.]*\s*)?\)/g
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

test("a host-lookup timeout is never told to the visitor as a bad or dead address", () => {
  // The lookup ran out of time, which a slow name server for the site and a
  // stalled lookup inside the scanner both produce. The notice may say what
  // happened and offer a retry; it may not say the address is private,
  // unresolvable, or down, because nothing established that.
  const notice = scanFailureNotice("host-lookup-timeout");
  const words = `${notice.message} ${notice.action ?? ""}`;
  assert.doesNotMatch(words, /only visits public web pages|site may be down|does not exist|doesn't exist|could not be resolved|not resolve/i);
  assert.match(notice.message, /took too long/);
  assert.match(notice.action ?? "", /try again/i);
  assert.equal(notice.retryable, true);
});

test("a page load the scanner attributes to the site names the site, never the address", () => {
  // Declared only when the scanner attributes the failure to the site, so the
  // notice may name the site. It must not call the address private, invalid
  // or unresolvable, and the same visit can succeed later.
  const notice = scanFailureNotice("page-load-failed");
  const words = `${notice.message} ${notice.action ?? ""}`;
  assert.match(notice.message, /load the page from the site/);
  assert.doesNotMatch(words, /only visits public web pages|doesn't look like|not a scannable|could not be resolved/i);
  assert.equal(notice.retryable, true);
});

test("a subject refusal keeps the instruction its server message carried", () => {
  // A declared cause replaces the server's sentence with this notice, so the
  // instruction the gate's own message gave must survive in the notice.
  const suffix = scanFailureNotice("public-suffix-target");
  assert.match(suffix.message, /registry boundary/);
  assert.match(suffix.action ?? "", /example\.github\.io/);
  assert.equal(suffix.retryable, false);

  const tenant = scanFailureNotice("generalized-tenant-target");
  assert.match(tenant.message, /network address, timestamp, or one-time token/);
  assert.match(tenant.action ?? "", /stable address/);
  assert.equal(tenant.retryable, false);

  // A ceiling the scanner declines to verify, not a lookup that failed.
  const fanout = scanFailureNotice("address-fanout-target");
  assert.match(fanout.message, /more addresses than the scanner will check/);
  assert.doesNotMatch(fanout.message, /could not be resolved|not resolve/i);
  assert.equal(fanout.action, null);
  assert.equal(fanout.retryable, false);
});

test("a subject no report can name is refused without blaming the site or calling the address invalid", () => {
  // Usually reached by a redirect the site sends, after a visit, so the
  // notice says a visit happened and nothing was published, and never that
  // the address is malformed, private, unreachable or down.
  const notice = scanFailureNotice("unnameable-subject-target");
  const words = `${notice.message} ${notice.action ?? ""}`;
  assert.match(notice.message, /was visited/);
  assert.match(notice.message, /No report was published/);
  assert.doesNotMatch(words, /doesn't look like|only visits public web pages|could not be resolved|site may be down/i);
  assert.equal(notice.retryable, false);
});

test("a report the scanner would not publish is the scanner's limit, not the visitor's address", () => {
  // The scan ran and produced a report, but the report failed the scanner's
  // own check that redacting it again changes nothing, so it was not saved.
  // That is page content meeting a scanner limit: the notice blames neither
  // the address nor the site, and says nothing was published.
  const notice = scanFailureNotice("report-redaction-unstable");
  const words = `${notice.message} ${notice.action ?? ""}`;
  assert.match(notice.message, /not published/);
  assert.match(notice.message, /not a problem with the address you gave it/);
  assert.doesNotMatch(words, /site may be down|blocking|only visits public web pages|access key/i);
  assert.equal(notice.retryable, true);
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
  const start = requireIndex(source, "export function friendlyScanError", "lib/scan-client-orchestration.ts");
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
  // The Worker's bodies come from the one builder, which also carries a quota
  // refusal's wait. A hand-written body there would drop `retryAfterSeconds`
  // while still passing the `cause` check above.
  const worker = readFileSync(path.join(root, "cloudflare", "container-worker.ts"), "utf8");
  const gate = worker.slice(
    requireIndex(worker, "function gateErrorResponse(", "cloudflare/container-worker.ts"),
    requireIndex(worker, "function assertDurableAdmissionCommitActive(", "cloudflare/container-worker.ts")
  );
  assert.match(gate, /JSON\.stringify\(publicErrorBody\(publicError\)\)/);
  assert.doesNotMatch(gate, /cause:\s*publicError\.cause/);
  const attempts = readFileSync(path.join(root, "lib", "admission-attempt-limit.ts"), "utf8");
  assert.match(attempts, /JSON\.stringify\(publicErrorBody\(/);
});

test("a scanner quota refusal states the producer's wait, or nothing it cannot know", () => {
  // The quota store folds client and global, minute and day windows into one
  // refusal with only the longest wait. So the notice may not say whose usage
  // fired, and may not promise a short wait unless the producer sent one. A
  // limit can also refuse before the address is read, so it passes no verdict
  // on the address either.
  const quota = scanFailureNotice("request-limit");
  const words = `${quota.message} ${quota.action ?? ""}`;
  assert.doesNotMatch(words, /you('ve| have) run|short window|a moment|the site|nothing is wrong/i);
  assert.equal(quota.action, "Try again later.");
  assert.equal(quota.retryable, true);

  for (const [seconds, wait] of [
    [1, "1 second"],
    [89, "89 seconds"],
    [5_340, "89 minutes"],
    [5_400, "2 hours"],
    [86_400, "24 hours"]
  ] as const) {
    const notice = scanFailureText("request-limit", "raw", { retryAfterSeconds: seconds });
    assert.equal(notice.message, quota.message);
    assert.equal(notice.action, `Try again in about ${wait}.`);
    assert.equal(formatScanRetryWait(seconds), wait);
  }
  // A wait is wire data. Anything that is not a whole number of seconds inside
  // one day falls back to the fixed action instead of being rendered.
  for (const invalid of [0, -1, 1.5, "60", 86_401, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    assert.equal(
      scanFailureText("request-limit", "raw", { retryAfterSeconds: invalid }).action,
      "Try again later.",
      `retryAfterSeconds ${String(invalid)} must not be rendered`
    );
  }
  // The wait belongs to this cause only.
  assert.equal(
    scanFailureText("scanner-busy", "raw", { retryAfterSeconds: 30 }).action,
    scanFailureNotice("scanner-busy").action
  );
});

test("the quota cause is a new id, so a page built before it renders the server's own sentence", () => {
  // Pages and the Worker deploy separately. A page built before this cause was
  // emitted maps the retired "rate-limited" id to "You've run several scans in a
  // short window... Wait a moment", which is false for a global or a day-window
  // refusal. Emitting a new id reaches that page as an unknown cause, and an
  // unknown cause renders the Worker's message verbatim, which is accurate.
  assert.equal(isScanFailureCause("rate-limited"), false);
  const worker = readFileSync(path.join(root, "cloudflare", "container-worker.ts"), "utf8");
  assert.doesNotMatch(worker, /429,\s*"rate-limited"/);
  // Both public quota refusals declare the cause and carry the wait as data.
  assert.match(
    worker,
    /class DurableScanJobRateLimitError extends EdgeScanGateError[\s\S]*?429,\s*"request-limit",\s*retryAfterSeconds\s*\)/
  );
  assert.match(
    worker,
    /Too many public scans\. Try again in about \$\{formatPublicScanRetryAfter\(charge\.retryAfterSeconds\)\}\.`,\s*429,\s*"request-limit",\s*charge\.retryAfterSeconds\s*\)/
  );
  // A duplicate preparation in flight is not a quota refusal and stays uncaused.
  assert.match(
    worker,
    /class DurablePreparationInFlightError extends EdgeScanGateError[\s\S]*?formatPublicScanRetryAfter\(retryAfterSeconds\)\}\.`,\s*429\s*\)/
  );
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
  // because the 502 navigation failure cannot tell a refusal from an outage.
  //
  // Causes no producer declares today. Allowed, not required: when one gets a
  // producer this test still passes, and the entry can simply be dropped.
  const undeclaredAllowed = new Set<ScanFailureCause>([
    // toPublicError's unexpected-error branch declines to classify.
    "service-error",
    // Every 409 a visitor can reach carries specific wording that renders
    // verbatim by design: the cancel refusals ("already being saved" or
    // "already finished", scan-client-orchestration.test.ts), and a durable
    // preparation replayed after a definitive refusal ("already refused"),
    // which an honest client reaches only when that refusal's response was
    // lost, because it clears the admission on any 4xx. Lease and activation
    // 409s in lib/scan-jobs.ts reach only the private coordinator, and the
    // Node jobs route drops `cause` from the wire anyway.
    "scan-conflict"
  ]);
  const declared = producerDeclaredCauses();
  for (const cause of ALL_CAUSES) {
    assert.ok(
      declared.has(cause) || undeclaredAllowed.has(cause),
      `"${cause}" has reader-facing words but no producer declares it`
    );
  }
});
