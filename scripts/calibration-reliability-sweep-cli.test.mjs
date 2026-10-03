import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
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
// artifact exactly as the previous case wrote it.
// ---------------------------------------------------------------------------

const COLLECT_BUILD = "d".repeat(40);
const DECLARED_CONDITION = { device: "desktop", consentMode: "observe", gpcEnabled: false };

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

function candidateFile(dir, count) {
  const candidates = Array.from({ length: count }, (_, index) => ({
    caseId: `case${index + 1}.example`,
    url: `https://case${index + 1}.example/`
  }));
  const file = path.join(dir, "candidates.json");
  writeFileSync(file, `${JSON.stringify({ studyId: "collect-fail-closed", candidates }, null, 2)}\n`);
  return file;
}

async function withFakeScanServer(handlers, fn) {
  const requests = [];
  const server = createServer((request, response) => {
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
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function collect(baseUrl, candidatesPath, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "collect", "1", candidatesPath, outPath], {
      env: {
        ...process.env,
        SITE_BEHAVIOR_LAB_BUILD_COMMIT: COLLECT_BUILD,
        SWEEP_RUNNER_LABEL: "cli-test-runner",
        SWEEP_EGRESS: "loopback",
        SWEEP_BASE_URL: baseUrl
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

test("collect records site outcomes as rows and completes the round", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-collect-"));
  const candidatesPath = candidateFile(dir, 7);
  const outPath = path.join(dir, "round-1.json");
  const handlers = [
    json(200, r2Report()),
    refusal(400, "The host could not be resolved to a public address.", "target-unreachable"),
    refusal(400, "Local and private network targets are blocked.", "private-target"),
    refusal(504, "The page did not load before the scan timeout.", "page-load-timeout"),
    refusal(502, "The page could not be loaded. The site may be down, unreachable, or blocking automated visits."),
    // The site refused the visit: a report, so a row read from the report.
    json(200, r2Report({ status: 403 })),
    json(200, r2Report())
  ];
  await withFakeScanServer(handlers, async (baseUrl, requests) => {
    const result = await collect(baseUrl, candidatesPath, outPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 7);
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
    assert.match(result.stdout, /not-loaded target navigation-failure \(HTTP 502\): The page could not be loaded/);
    assert.match(result.stdout, /pass 1: observed 7, loaded 2/);
    assert.doesNotMatch(result.stderr, /STOPPED/);
  });
  const artifact = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(artifact.version, 3, "the pass-artifact format is unchanged");
  assert.equal(artifact.identity.buildCommit, COLLECT_BUILD);
  assert.deepEqual(
    artifact.outcomes.map((outcome) => [outcome.caseId, outcome.runOutcome, outcome.status, outcome.loaded]),
    [
      ["case1.example", "complete", 200, true],
      ["case2.example", "unavailable", null, false],
      ["case3.example", "unavailable", null, false],
      ["case4.example", "unavailable", null, false],
      ["case5.example", "unavailable", null, false],
      ["case6.example", "complete", 403, false],
      ["case7.example", "complete", 200, true]
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
    label: "cause-less 400",
    handler: refusal(400, "The host resolved to more than 64 addresses, which this scanner will not verify."),
    expect: [/more than 64 addresses/, /server cause: +none declared/]
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
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const dead = await collect(`http://127.0.0.1:${port}`, candidatesPath, outPath);
  assert.equal(dead.status, 1);
  assert.match(dead.stderr, /STOPPED at case 1\/2/);
  assert.match(dead.stderr, /transport failure talking to http:\/\/127\.0\.0\.1:\d+\/api\/scan: fetch failed; code ECONNREFUSED/);
  assert.equal(existsSync(outPath), false);
});
