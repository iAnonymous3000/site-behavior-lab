import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { initFixtureRepo, removeFixtureTree, runFixtureGit } from "../lib/git-fixture.ts";
import { bareLoadOutcome, EXPECTED_EVIDENCE_FAMILIES } from "./calibration-reliability-sweep-lib.mjs";
import { buildPassArtifact } from "./calibration-reliability-sweep-run-lib.mjs";

/**
 * END-TO-END: these tests SPAWN the real CLI. The corrective history behind
 * them: a merge changed the driver's header comments while its implementation
 * kept importing a removed export, and every library test stayed green
 * because none launched the process. A missing export, a stale command
 * table, or comment-only wiring must fail HERE.
 */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(moduleDir, "calibration-reliability-sweep-run.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function soundReport() {
  return {
    run: {
      summary: { status: 200 },
      quality: {
        run: { outcome: "complete" },
        byFamily: Object.fromEntries(
          EXPECTED_EVIDENCE_FAMILIES.map((family) => [family, { outcome: "complete" }])
        )
      },
      qualityFacts: {
        status: 200,
        navigationSettled: true,
        botWallTitleMatched: false,
        captureLoss: [],
        budgetsExhausted: []
      }
    }
  };
}

test("the CLI actually launches: import errors and stale commands cannot hide behind green library tests", () => {
  const noArgs = run([]);
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /collect <round 1\.\.12>/);
  assert.match(noArgs.stderr, /receipt <candidates> <round1> \[round2 \.\.\.\] <out>/);
  assert.match(noArgs.stderr, /bound <candidates> <round1> \[round2 \.\.\.\] <receipt> <out>/);
  // The exact invocation that exposed the broken merge.
  const help = run(["--help"]);
  assert.equal(help.status, 1);
  assert.doesNotMatch(help.stderr, /is not exported|SyntaxError|ReferenceError/);

  const badRound = run(["collect", "0", "a.json", "b.json"]);
  assert.equal(badRound.status, 1);
  assert.match(badRound.stderr, /collect <round 1\.\.12>/);
  const round13 = run(["collect", "13", "a.json", "b.json"]);
  assert.equal(round13.status, 1);
});

test("receipt and bound run end to end through the real process over five rounds", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-cli-"));
  const candidateSet = {
    studyId: "cli-smoke-study",
    candidates: [
      { caseId: "alpha.example", url: "https://alpha.example/" },
      { caseId: "beta.example", url: "https://beta.example/" }
    ]
  };
  const candidatesPath = path.join(dir, "candidates.json");
  const candidateBytes = `${JSON.stringify(candidateSet, null, 2)}\n`;
  writeFileSync(candidatesPath, candidateBytes);
  const { createHash } = await import("node:crypto");
  const candidateSetDigest = createHash("sha256").update(candidateBytes).digest("hex");

  const identity = {
    buildCommit: "a".repeat(40),
    runtime: "node-test",
    runnerLabel: "cli-smoke",
    egress: "cli-smoke"
  };
  const condition = { device: "desktop", consentMode: "observe", gpcEnabled: false };
  const at = [
    "2026-08-23T01:00:00.000Z",
    "2026-08-25T02:00:00.000Z",
    "2026-08-26T03:00:00.000Z",
    "2026-08-27T04:00:00.000Z",
    "2026-08-28T05:00:00.000Z"
  ];
  const roundPaths = at.map((when, index) => {
    const artifact = buildPassArtifact({
      studyId: "cli-smoke-study",
      pass: index + 1,
      candidateSetDigest,
      measurementCondition: condition,
      identity,
      outcomes: candidateSet.candidates.map((candidate) =>
        bareLoadOutcome(candidate.caseId, soundReport(), { pass: index + 1, observedAt: when })
      )
    });
    const file = path.join(dir, `round-${index + 1}.json`);
    writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
    return file;
  });

  const receiptPath = path.join(dir, "receipt.json");
  const receiptRun = run(["receipt", candidatesPath, ...roundPaths, receiptPath]);
  assert.equal(receiptRun.status, 0, receiptRun.stderr);
  assert.match(receiptRun.stdout, /receipt: 5 rounds, 2 candidates, 2 eligible/);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.diagnostics.allFamiliesCompleteBothPasses, 2);

  const boundPath = path.join(dir, "bound.json");
  const boundRun = run(["bound", candidatesPath, ...roundPaths, receiptPath, boundPath]);
  assert.equal(boundRun.status, 0, boundRun.stderr);
  assert.match(boundRun.stdout, /loss bound over 5 rounds/);
  const boundArtifact = readFileSync(boundPath, "utf8");
  const parsed = JSON.parse(boundArtifact);
  assert.equal(parsed.rounds, 5);
  assert.equal(parsed.method.algorithm, "cluster-bootstrap");
  assert.equal(/wilson|interval95/i.test(boundArtifact), false);

  // Below the preregistered minimum the CLI itself refuses, end to end.
  const shortReceiptPath = path.join(dir, "short-receipt.json");
  const shortRun = run(["receipt", candidatesPath, ...roundPaths.slice(0, 3), shortReceiptPath]);
  assert.equal(shortRun.status, 0, shortRun.stderr);
  const shortBound = run([
    "bound",
    candidatesPath,
    ...roundPaths.slice(0, 3),
    shortReceiptPath,
    path.join(dir, "short-bound.json")
  ]);
  assert.equal(shortBound.status, 1);
  assert.match(shortBound.stderr, /preregistered minimum is 4/);
});

// ---------------------------------------------------------------------------
// COLLECT FAILS CLOSED, end to end. The real driver runs against a local fake
// /api/scan on 127.0.0.1 (never a live site): site outcomes become rows and the
// round completes; every scanner-side refusal or transport failure stops the
// round, prints the server's reason and cause, exits non-zero, and leaves the
// artifact exactly as the previous case wrote it. The same fake answers the
// egress probe at http://localhost:<port>/egress-probe, so the probe exercises
// the resolver on a loopback name and never leaves the machine.
// ---------------------------------------------------------------------------

// collect refuses unless the driver's own git checkout is at the declared
// build with no tracked change, so it cannot run from this (possibly dirty)
// tree. Every collect test runs the driver from a throwaway repository that
// commits a copy of the driver's module closure, found by following its
// relative imports. A module missing from that walk fails to import there, so
// the copy also proves the closure is self-contained.
function driverModuleClosure() {
  const repoRoot = path.resolve(moduleDir, "..");
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = source.matchAll(
      /(?:import|export)[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g
    );
    for (const match of specifiers) walk(path.resolve(path.dirname(file), match[1] ?? match[2]));
  };
  walk(CLI);
  return [...seen].map((file) => path.relative(repoRoot, file)).sort();
}

function createDriverCheckout() {
  const root = mkdtempSync(path.join(tmpdir(), "sweep-driver-checkout-"));
  const closure = driverModuleClosure();
  for (const relative of closure) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    copyFileSync(path.join(moduleDir, "..", relative), path.join(root, relative));
  }
  writeFileSync(path.join(root, "README.md"), "A committed copy of the sweep driver, for its CLI tests.\n");
  initFixtureRepo(root);
  runFixtureGit(root, ["add", "-A"]);
  runFixtureGit(root, ["commit", "-q", "-m", "Sweep driver checkout fixture"]);
  return {
    root,
    closure,
    cli: path.join(root, "scripts", "calibration-reliability-sweep-run.mjs"),
    head: runFixtureGit(root, ["rev-parse", "HEAD"]).trim()
  };
}

const CHECKOUT = createDriverCheckout();
after(() => removeFixtureTree(CHECKOUT.root));

const COLLECT_BUILD = CHECKOUT.head;
const DECLARED_CONDITION = { device: "desktop", consentMode: "observe", gpcEnabled: false };
const EGRESS_PATH = "/egress-probe";

function r2Report({
  buildCommit = COLLECT_BUILD,
  status = 200,
  conditions = { gpc: false, consent: "observe", device: { kind: "desktop" } }
} = {}) {
  return {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "single",
    run: {
      ...soundReport().run,
      provenance: { observer: "node-playwright", acquisition: "public-api", buildCommit },
      conditions,
      summary: { status },
      qualityFacts: { ...soundReport().run.qualityFacts, status }
    }
  };
}

const json = (status, body) => (request, response) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
};
const refusal = (status, error, cause) =>
  json(status, { ok: false, error, ...(cause === undefined ? {} : { cause }) });

async function releasedLoopbackPort() {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  return port;
}

function candidateFile(dir, count) {
  const candidates = Array.from({ length: count }, (_, index) => ({
    caseId: `case${index + 1}.example`,
    url: `https://case${index + 1}.example/`
  }));
  const file = path.join(dir, "candidates.json");
  writeFileSync(file, `${JSON.stringify({ studyId: "collect-fail-closed", candidates }, null, 2)}\n`);
  return file;
}

const probeOk = (request, response) => {
  response.writeHead(204);
  response.end();
};
const probeDown = (request, response) => {
  response.socket.destroy();
};

async function withFakeScanServer(handlers, fn, { probes = [] } = {}) {
  const requests = [];
  const probeLog = [];
  const server = createServer((request, response) => {
    if (request.url === EGRESS_PATH) {
      // Scripted per probe; past the script the probe answers, so only a
      // scripted failure can stop a round on egress.
      const handler = probes[probeLog.length] ?? probeOk;
      probeLog.push(request.method);
      request.resume();
      handler(request, response);
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const handler = handlers[requests.length];
      requests.push({ method: request.method, url: request.url, body });
      if (handler === undefined) {
        // A request past the scripted list means the driver kept going after
        // a stop. Answer with a valid report so only the request count
        // betrays it, never a second refusal that would mask the defect.
        json(200, r2Report())(request, response);
        return;
      }
      handler(request, response);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, requests, {
      probeUrl: `http://localhost:${port}${EGRESS_PATH}`,
      probeLog
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function collect(baseUrl, candidatesPath, outPath, { probeUrl, env = {}, nodeArgs = [], cli = CHECKOUT.cli } = {}) {
  const port = new URL(baseUrl).port;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, cli, "collect", "1", candidatesPath, outPath], {
      env: {
        ...process.env,
        SITE_BEHAVIOR_LAB_BUILD_COMMIT: COLLECT_BUILD,
        SWEEP_RUNNER_LABEL: "cli-test-runner",
        SWEEP_EGRESS: "loopback",
        SWEEP_BASE_URL: baseUrl,
        // Always a loopback listener: a real value in the caller's shell must
        // never reach a test.
        SWEEP_EGRESS_PROBE_URL: probeUrl ?? `http://localhost:${port}${EGRESS_PATH}`,
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// The scan API's exact answers for the 2026-10-03 rulings' classes.
const REDACTION_UNSTABLE = refusal(
  500,
  "The scan finished, but its report did not pass the scanner's privacy-redaction check, so it was not published.",
  "report-redaction-unstable"
);
const LOOKUP_TIMEOUT = refusal(503, "Public host verification timed out. Try again shortly.", "host-lookup-timeout");

test("collect records site outcomes as rows and completes the round", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-collect-"));
  const candidatesPath = candidateFile(dir, 13);
  const outPath = path.join(dir, "round-1.json");
  const handlers = [
    json(200, r2Report()),
    refusal(400, "The host could not be resolved to a public address.", "target-unreachable"),
    refusal(400, "Local and private network targets are blocked.", "private-target"),
    refusal(504, "The page did not load before the scan timeout.", "page-load-timeout"),
    refusal(
      502,
      "The page could not be loaded. The site may be down, unreachable, or blocking automated visits.",
      "page-load-failed"
    ),
    // The site refused the visit: a report, so a row read from the report.
    json(200, r2Report({ status: 403 })),
    json(200, r2Report()),
    // The 2026-10-03 rulings: four refusals the target causes are site rows,
    // and the unstable-redaction persistence refusal is a lost row.
    LOOKUP_TIMEOUT,
    refusal(
      400,
      "That host is a registry boundary (a public suffix such as github.io or gov.uk), not a site that can be scanned on its own.",
      "public-suffix-target"
    ),
    refusal(400, "That host's name under its hosting provider looks like a network address.", "generalized-tenant-target"),
    refusal(400, "The host resolved to more than 64 addresses, which this scanner will not verify.", "address-fanout-target"),
    REDACTION_UNSTABLE,
    refusal(
      400,
      "The page was visited, but the address requested or the one the visit ended on has no site name a report can carry.",
      "unnameable-subject-target"
    )
  ];
  await withFakeScanServer(handlers, async (baseUrl, requests, { probeLog }) => {
    const result = await collect(baseUrl, candidatesPath, outPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 13);
    // One probe before case 1 and one after every answer, each a HEAD.
    assert.deepEqual(probeLog, Array(14).fill("HEAD"));
    assert.match(
      result.stdout,
      new RegExp(`checkout \\S+ at ${COLLECT_BUILD}, no tracked changes; egress probe http://localhost:\\d+/egress-probe: HTTP 204`)
    );
    for (const [index, request] of requests.entries()) {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/scan");
      assert.deepEqual(JSON.parse(request.body), {
        url: `https://case${index + 1}.example/`,
        ...DECLARED_CONDITION
      });
    }
    assert.match(result.stdout, /not-loaded target target-unreachable: The host could not be resolved/);
    assert.match(result.stdout, /not-loaded target private-target/);
    assert.match(result.stdout, /not-loaded target page-load-timeout/);
    assert.match(result.stdout, /not-loaded target page-load-failed: The page could not be loaded/);
    assert.match(result.stdout, /not-loaded target host-lookup-timeout: Public host verification timed out/);
    assert.match(result.stdout, /not-loaded target public-suffix-target: That host is a registry boundary/);
    assert.match(result.stdout, /not-loaded target generalized-tenant-target/);
    assert.match(result.stdout, /not-loaded target address-fanout-target: The host resolved to more than 64 addresses/);
    assert.match(
      result.stdout,
      /lost report-redaction-unstable \(instrument loss, not a site outcome\): The scan finished, but its report did not pass/
    );
    assert.match(result.stdout, /not-loaded target unnameable-subject-target: The page was visited/);
    assert.match(result.stdout, /pass 1: observed 13, loaded 2/);
    assert.match(result.stdout, /bare-load valid 2 \(15\.4%\)/);
    assert.match(result.stdout, /lost to the instrument: 1 of 13, counted as neither valid nor complete/);
    assert.match(result.stdout, /rows by answer: \{"address-fanout-target":1,"generalized-tenant-target":1,"host-lookup-timeout":1,"page-load-failed":1,"page-load-timeout":1,"private-target":1,"public-suffix-target":1,"report":3,"report-redaction-unstable":1,"target-unreachable":1,"unnameable-subject-target":1\}/);
    assert.doesNotMatch(result.stderr, /STOPPED/);
  });
  const artifact = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(artifact.version, 4, "the pass artifact carries the row answer");
  assert.equal(artifact.identity.buildCommit, COLLECT_BUILD);
  assert.deepEqual(
    artifact.outcomes.map((outcome) => [outcome.caseId, outcome.answer, outcome.runOutcome, outcome.status, outcome.loaded]),
    [
      ["case1.example", "report", "complete", 200, true],
      ["case2.example", "target-unreachable", "unavailable", null, false],
      ["case3.example", "private-target", "unavailable", null, false],
      ["case4.example", "page-load-timeout", "unavailable", null, false],
      ["case5.example", "page-load-failed", "unavailable", null, false],
      ["case6.example", "report", "complete", 403, false],
      ["case7.example", "report", "complete", 200, true],
      ["case8.example", "host-lookup-timeout", "unavailable", null, false],
      ["case9.example", "public-suffix-target", "unavailable", null, false],
      ["case10.example", "generalized-tenant-target", "unavailable", null, false],
      ["case11.example", "address-fanout-target", "unavailable", null, false],
      ["case12.example", "report-redaction-unstable", "unavailable", null, false],
      ["case13.example", "unnameable-subject-target", "unavailable", null, false]
    ]
  );
});

const destroyMidBody = (request, response) => {
  response.writeHead(200, { "content-type": "application/json", "content-length": "4096" });
  response.write('{"schemaVersion":2,');
  setTimeout(() => response.socket.destroy(), 20);
};
const declaredOversize = (request, response) => {
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(33 * 1024 * 1024)
  });
  response.flushHeaders();
  setTimeout(() => response.socket.destroy(), 200);
};
const redirect = (request, response) => {
  response.writeHead(307, { location: "http://127.0.0.1:9/api/scan" });
  response.end();
};
const noLedger = () => {
  const report = r2Report();
  delete report.run.quality;
  return report;
};

const STOP_CASES = [
  {
    label: "our access gate",
    handler: refusal(401, "Scanner access key is required for this deployment.", "access-key-required"),
    expect: [/HTTP status: +401/, /Scanner access key is required/, /server cause: +access-key-required/]
  },
  {
    label: "our own rate limit",
    handler: json(429, {
      ok: false,
      error: "Too many scan requests. Try again shortly.",
      cause: "request-limit",
      retryAfterSeconds: 30
    }),
    expect: [/HTTP status: +429/, /Too many scan requests/, /server cause: +request-limit/]
  },
  {
    label: "r2 misconfigured",
    handler: refusal(
      503,
      "Public r2 report production is misconfigured: SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION must be 1 before public r2 reports are enabled."
    ),
    expect: [/HTTP status: +503/, /misconfigured: SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION/, /server cause: +none declared/]
  },
  {
    label: "r2 persistence unavailable",
    handler: refusal(503, "Public r2 report persistence is unavailable.", "feature-unavailable"),
    expect: [/persistence is unavailable/, /server cause: +feature-unavailable/]
  },
  {
    label: "persistence or internal failure",
    handler: refusal(500, "The service could not complete this request. Try again later."),
    expect: [/HTTP status: +500/, /server's own log/]
  },
  {
    label: "scanner busy",
    handler: refusal(503, "Scanner is busy. Try again shortly.", "scanner-busy"),
    expect: [/server cause: +scanner-busy/]
  },
  {
    label: "async job submission",
    handler: json(202, { jobId: "job-1", status: "queued" }),
    expect: [/HTTP status: +202/, /scan-job submission/]
  },
  {
    label: "candidate refused as an address",
    handler: refusal(400, "Only standard HTTP and HTTPS ports can be scanned.", "invalid-url"),
    expect: [/server cause: +invalid-url/]
  },
  {
    // A server from before the 2026-10-03 causes: the cause-less forms of
    // the newly recorded answers still stop.
    label: "cause-less 400",
    handler: refusal(400, "The host resolved to more than 64 addresses, which this scanner will not verify."),
    expect: [/more than 64 addresses/, /server cause: +none declared/]
  },
  {
    label: "cause-less lookup timeout",
    handler: refusal(503, "Public host verification timed out. Try again shortly."),
    expect: [/HTTP status: +503/, /verification timed out/, /server cause: +none declared/]
  },
  {
    label: "resolver failure",
    handler: refusal(503, "Public host verification could not complete. Try again shortly."),
    expect: [/could not complete/, /server cause: +none declared/]
  },
  {
    // A navigation failure the scanner could not attribute to the site: its
    // own proxy, resolver or browser may have failed.
    label: "cause-less navigation failure",
    handler: refusal(
      502,
      "The page could not be loaded, and the scanner could not tell whether the site or its own network path failed. Try again shortly."
    ),
    expect: [/HTTP status: +502/, /could not attribute to the site/, /server cause: +none declared/]
  },

  {
    label: "unknown declared cause",
    handler: refusal(418, "A refusal from the future.", "a-cause-this-driver-has-never-seen"),
    expect: [/does not know/, /server cause: +a-cause-this-driver-has-never-seen/]
  },
  {
    label: "non-JSON 200",
    handler: (request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>not a report</html>");
    },
    expect: [/not strict JSON/]
  },
  {
    label: "v1-shaped 200",
    handler: json(200, soundReport()),
    expect: [/not a ScanReport v2 r2/, /SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS=1/]
  },
  {
    label: "r2 from another build",
    handler: json(200, r2Report({ buildCommit: "e".repeat(40) })),
    expect: [/produced by build "e{40}"/, new RegExp(`declared SITE_BEHAVIOR_LAB_BUILD_COMMIT ${COLLECT_BUILD}`)]
  },
  {
    label: "r2 under another condition",
    handler: json(200, r2Report({ conditions: { gpc: false, consent: "accept-all", device: { kind: "desktop" } } })),
    expect: [/measured under/, /accept-all/]
  },
  {
    label: "r2 with no quality ledger",
    handler: json(200, noLedger()),
    expect: [/no per-family quality ledger/]
  },
  {
    label: "socket destroyed mid-body",
    handler: destroyMidBody,
    expect: [/HTTP status: +none \(transport failure/, /transport failure talking to/]
  },
  {
    label: "declared body over the byte limit",
    handler: declaredOversize,
    expect: [/transport failure talking to/, /byte response limit/]
  },
  {
    label: "redirect",
    handler: redirect,
    expect: [/transport failure talking to/]
  }
];

test("every scanner-side refusal and transport failure stops the round at the failing case", async () => {
  for (const stopCase of STOP_CASES) {
    const dir = mkdtempSync(path.join(tmpdir(), "sweep-stop-"));
    const candidatesPath = candidateFile(dir, 3);
    const outPath = path.join(dir, "round-1.json");
    // Case 1 is a site outcome, so the persisted prefix has a row of each
    // admitted kind; case 2 fails; case 3 must never be requested.
    const handlers = [
      refusal(504, "The page did not load before the scan timeout.", "page-load-timeout"),
      stopCase.handler,
      json(200, r2Report())
    ];
    await withFakeScanServer(handlers, async (baseUrl, requests) => {
      const result = await collect(baseUrl, candidatesPath, outPath);
      assert.equal(result.status, 1, `${stopCase.label}: exit status\n${result.stdout}\n${result.stderr}`);
      assert.equal(requests.length, 2, `${stopCase.label}: the driver kept scanning after the stop`);
      assert.match(result.stderr, /ROUND 1 STOPPED at case 2\/3 \(case2\.example\)/, stopCase.label);
      for (const expected of stopCase.expect) {
        assert.match(result.stderr, expected, stopCase.label);
      }
      assert.match(result.stderr, /egress probe: +ok \(HTTP 204\)/, stopCase.label);
      assert.match(result.stderr, /persisted: +1 of 3 outcomes in .*round-1\.json, written through case 1/, stopCase.label);
      assert.match(result.stderr, /re-run in full/, stopCase.label);
      assert.doesNotMatch(result.stdout, /pass 1: observed/, `${stopCase.label}: printed a round summary`);
    });
    const artifact = JSON.parse(readFileSync(outPath, "utf8"));
    assert.deepEqual(
      artifact.outcomes.map((outcome) => [outcome.caseId, outcome.runOutcome]),
      [["case1.example", "unavailable"]],
      `${stopCase.label}: the artifact must hold exactly the cases before the stop`
    );
  }
});

test("a stop on the first case writes no artifact, and a dead server is a stop, not a row", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-first-"));
  const candidatesPath = candidateFile(dir, 2);
  const outPath = path.join(dir, "round-1.json");
  await withFakeScanServer(
    [refusal(503, "Public r2 report persistence is unavailable.", "feature-unavailable")],
    async (baseUrl, requests) => {
      const result = await collect(baseUrl, candidatesPath, outPath);
      assert.equal(result.status, 1);
      assert.equal(requests.length, 1);
      assert.match(result.stderr, /STOPPED at case 1\/2/);
      assert.match(result.stderr, /persisted: +nothing; this invocation wrote no artifact/);
    }
  );
  assert.equal(existsSync(outPath), false);

  // Connection refused: a port that was just bound and released on loopback.
  // The egress probe still answers, from a live fake, so the stop is the dead
  // scan server's.
  const port = await releasedLoopbackPort();
  const dead = await withFakeScanServer([], (baseUrl, requests, { probeUrl }) =>
    collect(`http://127.0.0.1:${port}`, candidatesPath, outPath, { probeUrl })
  );
  assert.equal(dead.status, 1);
  assert.match(dead.stderr, /STOPPED at case 1\/2/);
  assert.match(dead.stderr, /transport failure talking to http:\/\/127\.0\.0\.1:\d+\/api\/scan: fetch failed; code ECONNREFUSED/);
  assert.equal(existsSync(outPath), false);
});

// ---------------------------------------------------------------------------
// THE INSTRUMENT'S OWN FAILURES. A dead resolver answers ENOTFOUND for every
// name, the gate turns that into target-unreachable in milliseconds, and a
// scan spanning a sleep expires the scanner's wall-clock budget. Each of those
// answers is shaped exactly like a site outcome, so the driver must stop on
// the instrument's state, not read the answer.
// ---------------------------------------------------------------------------

// The gate's exact answer to getaddrinfo ENOTFOUND (lib/url-safety.ts), which
// is also what every case gets while the machine has no resolver.
const resolverDown = refusal(400, "The host could not be resolved to a public address.", "target-unreachable");

test("an outage-shaped answer stream stops the round on the failed egress probe instead of filing unreachable sites", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-outage-"));
  const candidatesPath = candidateFile(dir, 3);
  const outPath = path.join(dir, "round-1.json");
  // Before case 1 and after case 1 the probe answers; after case 2 the
  // resolver is gone. Every scan answer is the same unreachable body.
  await withFakeScanServer(
    [resolverDown, resolverDown, resolverDown],
    async (baseUrl, requests, { probeLog }) => {
      const result = await collect(baseUrl, candidatesPath, outPath);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(requests.length, 2, "the driver kept scanning without egress");
      assert.equal(probeLog.length, 3);
      assert.match(result.stderr, /ROUND 1 STOPPED at case 2\/3 \(case2\.example\)/);
      assert.match(result.stderr, /server cause: +target-unreachable/);
      assert.match(result.stderr, /egress probe: +FAILED \(/);
      assert.match(
        result.stderr,
        /reason: +the egress probe to http:\/\/localhost:\d+\/egress-probe failed right after this answer/
      );
      assert.match(result.stderr, /persisted: +1 of 3 outcomes/);
      assert.doesNotMatch(result.stdout, /pass 1: observed/);
    },
    { probes: [probeOk, probeOk, probeDown] }
  );
  const artifact = JSON.parse(readFileSync(outPath, "utf8"));
  assert.deepEqual(
    artifact.outcomes.map((outcome) => outcome.caseId),
    ["case1.example"],
    "only the case answered while egress worked is a row"
  );
});

test("a lost answer is recorded only while the instrument is sound, like a site row", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-lost-probe-"));
  const candidatesPath = candidateFile(dir, 3);
  const outPath = path.join(dir, "round-1.json");
  // Case 1 is lost with egress up and becomes a lost row; case 2 is lost
  // while the probe fails, and stops the round instead of being recorded.
  await withFakeScanServer(
    [REDACTION_UNSTABLE, REDACTION_UNSTABLE, json(200, r2Report())],
    async (baseUrl, requests) => {
      const result = await collect(baseUrl, candidatesPath, outPath);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(requests.length, 2);
      assert.match(result.stdout, /\[1\/3\] pass 1 case1\.example \.\.\. lost report-redaction-unstable/);
      assert.match(result.stderr, /ROUND 1 STOPPED at case 2\/3 \(case2\.example\)/);
      assert.match(result.stderr, /server cause: +report-redaction-unstable/);
      assert.match(result.stderr, /egress probe: +FAILED \(/);
    },
    { probes: [probeOk, probeOk, probeDown] }
  );
  const artifact = JSON.parse(readFileSync(outPath, "utf8"));
  assert.deepEqual(
    artifact.outcomes.map((outcome) => [outcome.caseId, outcome.answer]),
    [["case1.example", "report-redaction-unstable"]]
  );
});

test("a round does not start without egress: nothing is scanned and nothing is written", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-preflight-"));
  const candidatesPath = candidateFile(dir, 2);
  const outPath = path.join(dir, "round-1.json");
  await withFakeScanServer(
    [resolverDown, resolverDown],
    async (baseUrl, requests, { probeLog }) => {
      const result = await collect(baseUrl, candidatesPath, outPath);
      assert.equal(result.status, 1);
      assert.equal(requests.length, 0);
      assert.equal(probeLog.length, 1);
      assert.match(result.stderr, /ROUND 1 NOT STARTED: the egress probe to http:\/\/localhost:\d+\/egress-probe failed before case 1/);
    },
    { probes: [probeDown] }
  );
  assert.equal(existsSync(outPath), false);

  // A probe host that refuses connections is the same refusal.
  const port = await releasedLoopbackPort();
  const refused = await withFakeScanServer([resolverDown], (baseUrl, requests) =>
    collect(baseUrl, candidatesPath, outPath, { probeUrl: `http://localhost:${port}/` }).then((result) => ({
      ...result,
      scans: requests.length
    }))
  );
  assert.equal(refused.status, 1);
  assert.equal(refused.scans, 0);
  assert.match(refused.stderr, /NOT STARTED/);
  assert.match(refused.stderr, /ECONNREFUSED/);
  assert.equal(existsSync(outPath), false);
});

test("the egress probe URL is required and must name its host", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-probe-env-"));
  const candidatesPath = candidateFile(dir, 1);
  const outPath = path.join(dir, "round-1.json");
  await withFakeScanServer([json(200, r2Report())], async (baseUrl, requests, { probeLog }) => {
    const port = new URL(baseUrl).port;
    for (const [value, expected] of [
      ["", /SWEEP_EGRESS_PROBE_URL is required/],
      [`http://127.0.0.1:${port}${EGRESS_PATH}`, /must name its host, not the address 127\.0\.0\.1/],
      [`ftp://localhost:${port}/`, /must be an http or https URL/]
    ]) {
      const result = await collect(baseUrl, candidatesPath, outPath, { probeUrl: value });
      assert.equal(result.status, 1, value);
      assert.match(result.stderr, expected, value);
    }
    assert.equal(requests.length, 0);
    assert.equal(probeLog.length, 0);
  });
  assert.equal(existsSync(outPath), false);
});

// A preload that moves the driver's clocks at the moment case 2's answer
// arrives, the way a machine that slept mid-scan would: "sleep" moves only the
// wall clock (Node's monotonic clock does not advance while macOS sleeps),
// "stall" moves both (a platform whose monotonic clock counts the sleep).
function clockPreload(dir, mode) {
  const file = path.join(dir, `clock-${mode}.mjs`);
  writeFileSync(
    file,
    `const realNow = Date.now.bind(Date);
const realMonotonic = performance.now.bind(performance);
let offset = 0;
Date.now = () => realNow() + offset;
${mode === "stall" ? "performance.now = () => realMonotonic() + offset;\n" : ""}const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await realFetch(input, init);
  if (typeof init?.body === "string" && JSON.parse(init.body).url === "https://case2.example/") offset += 600_000;
  return response;
};
`
  );
  return ["--import", pathToFileURL(file).href];
}

test("a scan that spans a sleep stops the round, even when its answer is a report", async () => {
  for (const [mode, reason] of [
    ["sleep", /reason: +the wall clock moved 60\d\.\d s while this process ran \d+\.\d s: the machine slept/],
    ["stall", /reason: +the scan took 60\d\.\d s of wall-clock time, beyond the driver's 180\.0 s deadline/]
  ]) {
    const dir = mkdtempSync(path.join(tmpdir(), `sweep-${mode}-`));
    const candidatesPath = candidateFile(dir, 3);
    const outPath = path.join(dir, "round-1.json");
    await withFakeScanServer([json(200, r2Report()), json(200, r2Report()), json(200, r2Report())], async (baseUrl, requests) => {
      const result = await collect(baseUrl, candidatesPath, outPath, { nodeArgs: clockPreload(dir, mode) });
      assert.equal(result.status, 1, `${mode}\n${result.stdout}\n${result.stderr}`);
      assert.equal(requests.length, 2, mode);
      assert.match(result.stderr, /ROUND 1 STOPPED at case 2\/3 \(case2\.example\)/, mode);
      assert.match(result.stderr, /HTTP status: +200/, mode);
      assert.match(result.stderr, reason, mode);
      assert.match(result.stderr, /persisted: +1 of 3 outcomes/, mode);
    });
    const artifact = JSON.parse(readFileSync(outPath, "utf8"));
    assert.deepEqual(artifact.outcomes.map((outcome) => outcome.caseId), ["case1.example"], mode);
  }
});

// ---------------------------------------------------------------------------
// THE CHECKOUT IS THE BUILD. The round artifact names
// SITE_BEHAVIOR_LAB_BUILD_COMMIT; the driver refuses to collect from any
// checkout that is not exactly that commit with no tracked change.
// ---------------------------------------------------------------------------

test("collect refuses a checkout that is not the declared build, before any request", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-checkout-"));
  const candidatesPath = candidateFile(dir, 2);
  const outPath = path.join(dir, "round-1.json");
  const other = "f".repeat(40);
  await withFakeScanServer([json(200, r2Report())], async (baseUrl, requests, { probeLog }) => {
    const wrongBuild = await collect(baseUrl, candidatesPath, outPath, {
      env: { SITE_BEHAVIOR_LAB_BUILD_COMMIT: other }
    });
    assert.equal(wrongBuild.status, 1);
    assert.match(
      wrongBuild.stderr,
      new RegExp(`collect refused: the driver's checkout is at ${COLLECT_BUILD}, not the declared SITE_BEHAVIOR_LAB_BUILD_COMMIT ${other}`)
    );

    // A tracked change refuses and is named; an untracked file is not a change.
    writeFileSync(path.join(CHECKOUT.root, "README.md"), "edited after the commit\n");
    writeFileSync(path.join(CHECKOUT.root, "sweep-server.log"), "untracked\n");
    try {
      const dirty = await collect(baseUrl, candidatesPath, outPath);
      assert.equal(dirty.status, 1);
      assert.match(dirty.stderr, /collect refused: the driver's checkout has 1 tracked change\(s\) against [0-9a-f]{40} \(README\.md\)/);
    } finally {
      runFixtureGit(CHECKOUT.root, ["checkout", "--", "README.md"]);
    }
    assert.equal(requests.length, 0);
    assert.equal(probeLog.length, 0);
  });
  assert.equal(existsSync(outPath), false);

  // Outside any git checkout the driver cannot establish its build at all.
  const loose = mkdtempSync(path.join(tmpdir(), "sweep-loose-driver-"));
  for (const relative of CHECKOUT.closure) {
    mkdirSync(path.dirname(path.join(loose, relative)), { recursive: true });
    copyFileSync(path.join(CHECKOUT.root, relative), path.join(loose, relative));
  }
  try {
    const result = await withFakeScanServer([json(200, r2Report())], (baseUrl) =>
      collect(baseUrl, candidatesPath, outPath, { cli: path.join(loose, "scripts", "calibration-reliability-sweep-run.mjs") })
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /collect refused: the sweep driver must run from a git checkout of the collection SHA/);
  } finally {
    rmSync(loose, { recursive: true, force: true });
  }
});

test("the checkout binding reads the driver's own repository, whatever GIT_* variables the shell carries", async () => {
  // Another repository at another commit. If the driver let GIT_DIR or
  // GIT_WORK_TREE through, git would read this one and refuse the round.
  const decoy = mkdtempSync(path.join(tmpdir(), "sweep-decoy-repo-"));
  try {
    initFixtureRepo(decoy);
    runFixtureGit(decoy, ["commit", "-q", "--allow-empty", "-m", "Decoy"]);
    const dir = mkdtempSync(path.join(tmpdir(), "sweep-git-env-"));
    const candidatesPath = candidateFile(dir, 1);
    const outPath = path.join(dir, "round-1.json");
    await withFakeScanServer([json(200, r2Report())], async (baseUrl, requests) => {
      const result = await collect(baseUrl, candidatesPath, outPath, {
        env: {
          GIT_DIR: path.join(decoy, ".git"),
          GIT_WORK_TREE: decoy,
          GIT_INDEX_FILE: path.join(decoy, ".git", "index")
        }
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(requests.length, 1);
      assert.match(result.stdout, new RegExp(`at ${COLLECT_BUILD}, no tracked changes`));
    });
  } finally {
    removeFixtureTree(decoy);
  }
});
