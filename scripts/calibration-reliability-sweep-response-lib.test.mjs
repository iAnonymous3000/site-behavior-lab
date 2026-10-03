import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import {
  EXPECTED_EVIDENCE_FAMILIES,
  SWEEP_ROW_ANSWERS,
  bareLoadOutcome
} from "./calibration-reliability-sweep-lib.mjs";
import {
  SWEEP_ADMITTED_REPORT,
  SWEEP_LOST_CAUSES,
  SWEEP_REPORT_READ_PATHS,
  SWEEP_SCAN_CAUSE_DISPOSITIONS,
  SWEEP_TARGET_FAILURE_CAUSES,
  classifyScanResponse
} from "./calibration-reliability-sweep-response-lib.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(moduleDir, "..");

const BUILD = "b".repeat(40);
const CONDITION = Object.freeze({ device: "desktop", consentMode: "observe", gpcEnabled: false });

function r2Report({
  buildCommit = BUILD,
  conditions = { gpc: false, consent: "observe", device: { kind: "desktop" } },
  status = 200
} = {}) {
  return {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "single",
    run: {
      provenance: { observer: "node-playwright", acquisition: "public-api", buildCommit },
      conditions,
      summary: { status },
      quality: {
        run: { outcome: "complete", reasons: [] },
        byFamily: Object.fromEntries(
          EXPECTED_EVIDENCE_FAMILIES.map((family) => [family, { outcome: "complete", reasons: [] }])
        )
      },
      qualityFacts: {
        status,
        navigationSettled: true,
        botWallTitleMatched: false,
        captureLoss: [],
        budgetsExhausted: []
      }
    }
  };
}

function classify(httpStatus, body) {
  return classifyScanResponse({
    httpStatus,
    bodyText: typeof body === "string" ? body : JSON.stringify(body),
    expectedBuildCommit: BUILD,
    condition: CONDITION
  });
}

function refusal(error, cause) {
  return { ok: false, error, ...(cause === undefined ? {} : { cause }) };
}

test("an r2 single report from the declared build under the declared condition is admitted untouched", () => {
  const report = r2Report();
  const verdict = classify(200, report);
  assert.equal(verdict.disposition, "report");
  assert.deepEqual(verdict.report, report);
  // The admitted object still goes through the one narrowing layer.
  const outcome = bareLoadOutcome("alpha.example", verdict.report, {
    pass: 1,
    observedAt: "2026-10-02T00:00:00.000Z"
  });
  assert.equal(outcome.runOutcome, "complete");
});

test("site outcomes are recorded as observations: the declared target causes", () => {
  const cases = [
    [400, refusal("The host could not be resolved to a public address.", "target-unreachable")],
    [400, refusal("Local and private network targets are blocked.", "private-target")],
    [504, refusal("The page did not load before the scan timeout.", "page-load-timeout")],
    [
      502,
      refusal(
        "The page could not be loaded. The site may be down, unreachable, or blocking automated visits.",
        "page-load-failed"
      )
    ],
    // The 2026-10-03 rulings: refusals the target causes, now declared.
    [503, refusal("Public host verification timed out. Try again shortly.", "host-lookup-timeout")],
    [
      400,
      refusal(
        "That host is a registry boundary (a public suffix such as github.io or gov.uk), not a site that can be scanned on its own.",
        "public-suffix-target"
      )
    ],
    [400, refusal("That host's name under its hosting provider looks like a network address.", "generalized-tenant-target")],
    [
      400,
      refusal("The host resolved to more than 64 addresses, which this scanner will not verify.", "address-fanout-target")
    ]
  ];
  for (const [status, body] of cases) {
    const verdict = classify(status, body);
    assert.equal(verdict.disposition, "target", `${status} ${body.cause ?? "no cause"}`);
    assert.equal(verdict.httpStatus, status);
    assert.equal(verdict.cause, body.cause ?? null);
    assert.equal(verdict.error, body.error);
    // The row answer is the declared cause.
    assert.equal(verdict.answer, body.cause);
    assert.equal(SWEEP_ROW_ANSWERS[verdict.answer], "site", verdict.answer);
  }
  assert.deepEqual(SWEEP_TARGET_FAILURE_CAUSES, [
    "address-fanout-target",
    "generalized-tenant-target",
    "host-lookup-timeout",
    "page-load-failed",
    "page-load-timeout",
    "private-target",
    "public-suffix-target",
    "target-unreachable"
  ]);
});

test("a navigation failure is a site row only when the scanner declares it the site's", () => {
  // The cause-less 502 also carries the scan proxy's own resolver failures and
  // traffic bound, a browser that closed, and the scanner's own route abort.
  // Its status says nothing about which side failed, so it stops, whatever
  // its sentence says.
  for (const error of [
    "The page could not be loaded, and the scanner could not tell whether the site or its own network path failed. Try again shortly.",
    "The page could not be loaded. The site may be down, unreachable, or blocking automated visits."
  ]) {
    const verdict = classify(502, refusal(error));
    assert.equal(verdict.disposition, "stop", error);
    assert.equal(verdict.cause, null);
    assert.equal(verdict.answer, undefined);
    assert.match(verdict.reason, /could not attribute to the site/);
  }
  assert.equal(Object.hasOwn(SWEEP_ROW_ANSWERS, "navigation-failure"), false);
});

test("a report the scanner measured and would not publish is instrument loss, never a site outcome", () => {
  const body = refusal(
    "The scan finished, but its report did not pass the scanner's privacy-redaction check, so it was not published.",
    "report-redaction-unstable"
  );
  const verdict = classify(500, body);
  assert.equal(verdict.disposition, "lost");
  assert.equal(verdict.answer, "report-redaction-unstable");
  assert.equal(verdict.cause, "report-redaction-unstable");
  assert.equal(verdict.httpStatus, 500);
  assert.equal(verdict.error, body.error);
  assert.equal(SWEEP_ROW_ANSWERS[verdict.answer], "lost");
  assert.deepEqual(SWEEP_LOST_CAUSES, ["report-redaction-unstable"]);
  // The cause decides, not the status: the same refusal without its cause is
  // the server's unexpected branch, and that still stops.
  assert.equal(classify(500, refusal(body.error)).disposition, "stop");
});

test("every scanner-side refusal stops the round and carries the server's own error and cause", () => {
  const cases = [
    ["access gate", 401, refusal("Scanner access key is required for this deployment.", "access-key-required")],
    ["our rate limit", 429, { ...refusal("Too many scan requests. Try again shortly.", "request-limit"), retryAfterSeconds: 30 }],
    [
      "r2 misconfigured",
      503,
      refusal("Public r2 report production is misconfigured: SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION must be 1 before public r2 reports are enabled.")
    ],
    ["r2 persistence unavailable", 503, refusal("Public r2 report persistence is unavailable.", "feature-unavailable")],
    ["durable admission", 503, refusal("Durable scan admission must use the private coordinator.", "feature-unavailable")],
    ["persistence or internal failure", 500, refusal("The service could not complete this request. Try again later.")],
    ["busy", 503, refusal("Scanner is busy. Try again shortly.", "scanner-busy")],
    ["dns resolver outage", 503, refusal("Public host verification could not complete. Try again shortly.")],
    // A server from before the 2026-10-03 causes: the cause-less forms of
    // the newly recorded answers still stop, because nothing in them is
    // declared.
    ["cause-less dns verification timeout", 503, refusal("Public host verification timed out. Try again shortly.")],
    [
      "cause-less address fan-out",
      400,
      refusal("The host resolved to more than 64 addresses, which this scanner will not verify.")
    ],
    ["lifecycle conflict", 409, refusal("This scan job has already finished and cannot be cancelled.", "scan-conflict")],
    ["malformed request", 400, refusal("Request body must be valid JSON.", "request-rejected")],
    ["oversized request", 413, refusal("Request body is too large.", "request-rejected")],
    ["challenge", 403, refusal("Turnstile verification failed.", "challenge-required")],
    ["service error", 503, refusal("The scanner could not complete this request.", "service-error")],
    ["candidate refused as an address", 400, refusal("Only standard HTTP and HTTPS ports can be scanned.", "invalid-url")],
    [
      "cause-less subject refusal",
      400,
      refusal("That host is a registry boundary (a public suffix such as github.io or gov.uk), not a site that can be scanned on its own.")
    ],
    ["unknown declared cause", 400, refusal("Something new.", "a-cause-this-driver-has-never-seen")],
    ["a scanner cause wins over the navigation status", 502, refusal("Proxy failure.", "service-error")]
  ];
  for (const [label, status, body] of cases) {
    const verdict = classify(status, body);
    assert.equal(verdict.disposition, "stop", label);
    assert.equal(verdict.httpStatus, status, label);
    assert.equal(verdict.error, body.error, label);
    assert.equal(verdict.cause, body.cause ?? null, label);
    assert.equal(typeof verdict.reason, "string", label);
    assert.ok(verdict.reason.length > 0, label);
  }
  assert.match(classify(500, refusal("x")).reason, /server's own log/);
  assert.match(classify(400, refusal("x", "brand-new")).reason, /does not know/);
});

test("non-report answers and malformed bodies stop the round", () => {
  const cases = [
    ["job submission", 202, { jobId: "job-1", status: "queued" }, /scan-job submission/],
    ["redirect", 307, "", /neither a report nor a refusal/],
    ["non-JSON 200", 200, "<html>gateway</html>", /not strict JSON/],
    ["duplicate-key 200", 200, '{"schemaVersion":2,"schemaVersion":2}', /not strict JSON/],
    ["non-JSON error", 500, "Internal Server Error", /not strict JSON/],
    ["error without ok:false", 500, { error: "x" }, /not the scanner's error shape/],
    ["error without a message", 503, { ok: false, cause: "scanner-busy" }, /not the scanner's error shape/],
    ["non-string cause", 400, { ok: false, error: "x", cause: 7 }, /not the scanner's error shape/],
    ["array body", 400, [], /not the scanner's error shape/],
    ["200 error body", 200, refusal("x", "service-error"), /not a ScanReport v2 r2/]
  ];
  for (const [label, status, body, reason] of cases) {
    const verdict = classify(status, body);
    assert.equal(verdict.disposition, "stop", label);
    assert.match(verdict.reason, reason, label);
  }
});

test("a 200 is admitted only as an r2 single report from the declared build under the declared condition", () => {
  const v1 = {
    url: "https://alpha.example/",
    run: r2Report().run,
    warnings: []
  };
  const r1 = { ...r2Report(), schemaRevision: 1 };
  const comparison = { ...r2Report(), reportType: "comparison" };
  const noProvenance = r2Report();
  delete noProvenance.run.provenance;
  const cases = [
    ["v1 body with an r2-looking run", v1, /not a ScanReport v2 r2/],
    ["v2 r1", r1, /not a ScanReport v2 r2/],
    ["comparison", comparison, /not the single report/],
    ["no provenance", noProvenance, /no run provenance/],
    ["another build", r2Report({ buildCommit: "c".repeat(40) }), /produced by build "c{40}"/],
    ["unrecorded build", r2Report({ buildCommit: "unknown" }), /produced by build "unknown"/],
    ["uppercase build", r2Report({ buildCommit: BUILD.toUpperCase() }), /not the declared/],
    [
      "consent arm",
      r2Report({ conditions: { gpc: false, consent: "accept-all", device: { kind: "desktop" } } }),
      /measured under/
    ],
    ["gpc arm", r2Report({ conditions: { gpc: true, consent: "observe", device: { kind: "desktop" } } }), /measured under/],
    [
      "device",
      r2Report({ conditions: { gpc: false, consent: "observe", device: { kind: "mobile" } } }),
      /measured under/
    ],
    ["no conditions", r2Report({ conditions: null }), /measured under \{"device":null,"consent":null,"gpc":null\}/]
  ];
  for (const [label, body, reason] of cases) {
    const verdict = classify(200, body);
    assert.equal(verdict.disposition, "stop", label);
    assert.match(verdict.reason, reason, label);
  }
  // The comparison is against the declared sha, so the same report is
  // admitted under its own build and refused under any other.
  assert.equal(
    classifyScanResponse({
      httpStatus: 200,
      bodyText: JSON.stringify(r2Report({ buildCommit: "c".repeat(40) })),
      expectedBuildCommit: "c".repeat(40),
      condition: CONDITION
    }).disposition,
    "report"
  );
});

test("the classifier refuses to run without the declared identity and condition", () => {
  const base = { httpStatus: 200, bodyText: "{}", expectedBuildCommit: BUILD, condition: CONDITION };
  assert.throws(() => classifyScanResponse({ ...base, expectedBuildCommit: "abc" }), /40-character/);
  assert.throws(() => classifyScanResponse({ ...base, condition: { device: "desktop" } }), /condition/);
  assert.throws(() => classifyScanResponse({ ...base, httpStatus: "200" }), /HTTP status/);
  assert.throws(() => classifyScanResponse({ ...base, bodyText: null }), /body text/);
});

test("the restart section's answer table states exactly what the driver does", () => {
  // The owner rulings are restated as a table in the design document, and a
  // restatement drifts. Every row's handling and answer must be the code's.
  const design = readFileSync(path.join(repoRoot, "docs", "reliability-sweep-cluster-design.md"), "utf8");
  const start = design.indexOf("\n## Restart (2026-10-02)");
  const end = design.indexOf("\n## ", start + 1);
  const restart = design.slice(start, end);
  const tableStart = restart.indexOf("| Answer from `/api/scan` | Handling | Row `answer` |");
  assert.ok(start >= 0 && tableStart >= 0, "the restart section carries the answer table");
  const rows = restart
    .slice(tableStart)
    .split("\n\n")[0]
    .split("\n")
    .slice(2)
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  assert.ok(rows.length >= 15, `parsed only ${rows.length} table rows`);
  const stated = { report: [], site: [], lost: [] };
  let stopCauses = null;
  for (const [answer, handling, rowAnswer] of rows) {
    const rowClass = handling.startsWith("report row")
      ? "report"
      : handling === "site row"
        ? "site"
        : handling === "lost row"
          ? "lost"
          : null;
    if (rowClass === null) {
      assert.ok(handling === "stop" || handling === "the round does not start", `unknown handling "${handling}"`);
      assert.equal(rowAnswer, "none", `a ${handling} row records no answer: ${answer}`);
      if (answer.startsWith("a declared ")) {
        stopCauses = [...answer.matchAll(/`([a-z-]+)`/g)].map((match) => match[1]).sort();
      }
      continue;
    }
    const recorded = /^`([a-z-]+)`$/.exec(rowAnswer)?.[1];
    assert.ok(recorded, `row answer "${rowAnswer}" is not a single answer`);
    stated[rowClass].push(recorded);
    if (rowClass !== "report") {
      assert.match(answer, new RegExp(`\`${recorded}\``), `the ${recorded} row must name the cause it records`);
    }
  }
  for (const rowClass of ["report", "site", "lost"]) {
    assert.deepEqual(
      stated[rowClass].sort(),
      Object.entries(SWEEP_ROW_ANSWERS)
        .filter(([, value]) => value === rowClass)
        .map(([answer]) => answer)
        .sort(),
      `the table's ${rowClass} rows`
    );
  }
  assert.deepEqual(
    stopCauses,
    Object.entries(SWEEP_SCAN_CAUSE_DISPOSITIONS)
      .filter(([, disposition]) => disposition === "stop")
      .map(([cause]) => cause)
      .sort(),
    "the table's declared stop causes"
  );
});

// ---------------------------------------------------------------------------
// Drift guards: the classification restates two server contracts, so each is
// pinned to its source. A new cause, or a second producer of a cause-less 502,
// must fail here before a sweep files it as a site outcome.
// ---------------------------------------------------------------------------

function parseTs(file) {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

test("the cause map classifies exactly the ScanFailureCause union, in both directions", () => {
  const sourceFile = parseTs(path.join(repoRoot, "lib", "scan-failure-causes.ts"));
  let causes = null;
  walk(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "ScanFailureCause") {
      assert.ok(ts.isUnionTypeNode(node.type), "ScanFailureCause is no longer a union");
      causes = node.type.types.map((member) => {
        assert.ok(
          ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal),
          "ScanFailureCause gained a non-literal member"
        );
        return member.literal.text;
      });
    }
  });
  assert.ok(causes !== null, "ScanFailureCause union not found");
  assert.ok(causes.length >= 10, `parsed only ${causes.length} causes`);
  assert.deepEqual(Object.keys(SWEEP_SCAN_CAUSE_DISPOSITIONS).sort(), [...causes].sort());
  for (const disposition of Object.values(SWEEP_SCAN_CAUSE_DISPOSITIONS)) {
    assert.ok(disposition === "target" || disposition === "lost" || disposition === "stop");
  }
});

test("the row answers are exactly the classifier's site and lost answers, in both directions", () => {
  // One contract in two files: the classifier decides which causes are rows,
  // and the narrowing layer closes the row vocabulary. Each half passing its
  // own tests while they disagree would stop a round on a valid row, or
  // admit an answer the classifier never gives.
  const byClass = (wanted) =>
    Object.entries(SWEEP_ROW_ANSWERS)
      .filter(([, rowClass]) => rowClass === wanted)
      .map(([answer]) => answer)
      .sort();
  assert.deepEqual(byClass("report"), ["report"]);
  assert.deepEqual(byClass("site"), [...SWEEP_TARGET_FAILURE_CAUSES]);
  assert.deepEqual(byClass("lost"), [...SWEEP_LOST_CAUSES]);
  assert.deepEqual(
    Object.keys(SWEEP_ROW_ANSWERS).sort(),
    ["report", ...SWEEP_TARGET_FAILURE_CAUSES, ...SWEEP_LOST_CAUSES].sort()
  );
});

function productionSourceFiles() {
  const files = [];
  const visitDir = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") visitDir(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  visitDir(path.join(repoRoot, "lib"));
  visitDir(path.join(repoRoot, "app"));
  return files.map((file) => ({ file: path.relative(repoRoot, file), sourceFile: parseTs(file) }));
}

function extendsName(node) {
  const clause = node.heritageClauses?.find((entry) => entry.token === ts.SyntaxKind.ExtendsKeyword);
  const expression = clause?.types[0]?.expression;
  return expression && ts.isIdentifier(expression) ? expression.text : null;
}

/**
 * Every construction of a public-facing error, including the super() call
 * inside each subclass, over the hierarchy found transitively from
 * PublicFacingError. Arguments are reported as their source text.
 */
function publicErrorConstructions(sources) {
  const classes = new Set(["PublicFacingError"]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { sourceFile } of sources) {
      walk(sourceFile, (node) => {
        if (ts.isClassDeclaration(node) && node.name && !classes.has(node.name.text)) {
          const parent = extendsName(node);
          if (parent !== null && classes.has(parent)) {
            classes.add(node.name.text);
            grew = true;
          }
        }
      });
    }
  }
  const calls = [];
  for (const { file, sourceFile } of sources) {
    const record = (callee, args) =>
      calls.push({ file, callee, args: args.map((arg) => arg.getText(sourceFile)) });
    walk(sourceFile, (node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && classes.has(node.expression.text)) {
        record(node.expression.text, node.arguments ?? []);
      }
      if (ts.isClassDeclaration(node) && node.name && classes.has(node.name.text)) {
        walk(node, (inner) => {
          if (ts.isCallExpression(inner) && inner.expression.kind === ts.SyntaxKind.SuperKeyword) {
            record(`${node.name.text} -> super`, inner.arguments);
          }
        });
      }
    });
  }
  return { classes, calls };
}

test("the navigation failure's site cause has one producer, and every 502 is the scanner's navigation failure", () => {
  const { classes, calls } = publicErrorConstructions(productionSourceFiles());
  // The walk must actually see the hierarchy and the throws, or every
  // assertion below would pass over an empty list.
  for (const name of ["PublicScanError", "EdgeScanGateError", "PublicUrlDnsUnavailableError"]) {
    assert.ok(classes.has(name), `${name} not found in the public-error hierarchy`);
  }
  assert.ok(calls.length > 50, `found only ${calls.length} public-error constructions`);
  assert.ok(
    calls.some((call) => call.file === path.join("lib", "scan-gate.ts") && call.args.includes("503")),
    "the scan gate's own 503 constructions were not found"
  );
  assert.ok(
    calls.some((call) => call.callee === "PublicUrlDnsUnavailableError -> super" && call.args.includes("503")),
    "subclass super() calls were not found"
  );

  // The scanner's navigation failure is the only 502: one construction
  // declares page-load-failed, for a failure the scanner attributes to the
  // site, and one declares nothing, for every failure it cannot attribute.
  // The classifier reads the cause, so the cause-less one stops; a 502 from
  // anywhere else would be a new answer to classify, and fails here first.
  const status502 = calls.filter((call) => call.args.some((arg) => arg === "502"));
  assert.deepEqual(
    status502.map(({ file, callee, args }) => ({ file, callee, args })),
    [
      {
        file: path.join("lib", "scanner.ts"),
        callee: "PublicScanError",
        args: ["PAGE_LOAD_FAILED_MESSAGE", "502", '"page-load-failed"']
      },
      {
        file: path.join("lib", "scanner.ts"),
        callee: "PublicScanError",
        args: ["UNATTRIBUTED_NAVIGATION_FAILURE_MESSAGE", "502"]
      }
    ]
  );
  const pageLoadFailed = calls.filter((call) => call.args.includes('"page-load-failed"'));
  assert.equal(pageLoadFailed.length, 1, "page-load-failed must have exactly the attributed navigation failure as its producer");

  // The declared target causes are what the scan path actually throws for a
  // site that cannot be measured, so the map is not reasoning about causes
  // nobody produces.
  for (const cause of SWEEP_TARGET_FAILURE_CAUSES) {
    assert.ok(
      calls.some((call) => call.args.includes(`"${cause}"`)),
      `no public error declares ${cause}`
    );
  }
  // The lost cause has one producer: the scan API's persistence mapping, as
  // a 500, so nothing but that refusal can be recorded as instrument loss.
  for (const cause of SWEEP_LOST_CAUSES) {
    const producers = calls.filter((call) => call.args.includes(`"${cause}"`));
    assert.deepEqual(
      producers.map(({ file, callee, args }) => ({ file, callee, status: args[1] })),
      [{ file: path.join("lib", "scan-api.ts"), callee: "PublicScanError", status: "500" }],
      `${cause} must have exactly the persistence mapping as its producer`
    );
  }
});

test("every path the classifier reads resolves on the real r2 single report type to what it compares", () => {
  // The fixtures above are hand-written to the classifier's own names, so
  // they cannot catch a field the producer renamed or moved. Resolve each
  // read path through PublicSingleReportV2R2 with the TypeScript checker
  // (Omit, intersections and aliases included) and require the leaf type the
  // comparison assumes.
  const configPath = path.join(repoRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
  const entry = path.join(repoRoot, "lib", "scan-report-v2-r2.ts");
  const program = ts.createProgram([entry], { ...options, noEmit: true, incremental: false, plugins: [] });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entry);
  let alias = null;
  walk(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "PublicSingleReportV2R2") alias = node;
  });
  assert.ok(alias, "PublicSingleReportV2R2 not found");
  const reportType = checker.getTypeAtLocation(alias.name);

  const resolve = (keys) => {
    let current = reportType;
    for (const key of keys) {
      const property = checker.getPropertyOfType(checker.getApparentType(current), key);
      assert.ok(property, `PublicSingleReportV2R2 has no ${keys.join(".")} (missing "${key}")`);
      current = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, alias));
    }
    return current;
  };
  const literalValues = (type) =>
    (type.isUnion() ? type.types : [type]).filter((member) => member.isLiteral()).map((member) => member.value);

  assert.deepEqual(literalValues(resolve(SWEEP_REPORT_READ_PATHS.schemaVersion)), [SWEEP_ADMITTED_REPORT.schemaVersion]);
  assert.deepEqual(
    literalValues(resolve(SWEEP_REPORT_READ_PATHS.schemaRevision)),
    [SWEEP_ADMITTED_REPORT.schemaRevision]
  );
  assert.deepEqual(literalValues(resolve(SWEEP_REPORT_READ_PATHS.reportType)), [SWEEP_ADMITTED_REPORT.reportType]);
  assert.equal(checker.typeToString(resolve(SWEEP_REPORT_READ_PATHS.buildCommit)), "string");
  assert.ok(literalValues(resolve(SWEEP_REPORT_READ_PATHS.device)).includes(CONDITION.device));
  assert.ok(literalValues(resolve(SWEEP_REPORT_READ_PATHS.consentMode)).includes(CONDITION.consentMode));
  assert.equal(checker.typeToString(resolve(SWEEP_REPORT_READ_PATHS.gpcEnabled)), "boolean");
  // Every exported path is pinned above; a new one must be added here too.
  assert.deepEqual(Object.keys(SWEEP_REPORT_READ_PATHS).sort(), [
    "buildCommit",
    "consentMode",
    "device",
    "gpcEnabled",
    "reportType",
    "schemaRevision",
    "schemaVersion"
  ]);
});
