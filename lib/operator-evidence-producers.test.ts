import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { initFixtureRepo, runFixtureGit } from "./git-fixture";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, any>;
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ScriptExports>;

function script(name: string) {
  return nativeImport(
    pathToFileURL(path.join(process.cwd(), "scripts", name)).href
  );
}

const CANDIDATE = "a".repeat(40);
const DEPLOYMENT = "b".repeat(40);
const DIGEST = "f".repeat(64);
const REPOSITORY_HEAD = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(),
  encoding: "utf8"
}).stdout.trim();

// The runtime container image builds from a git-less context by design (.git
// never enters the Docker build context), so inside the image's `npm run
// check` the repository head is unavailable. State that environmental
// precondition as an explicit skip; every host lane runs this test.
const repositoryHeadSkip =
  REPOSITORY_HEAD === ""
    ? "the build context has no .git, so the repository head is unavailable; host lanes run this test"
    : false;
const STAGING_SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const STAGING_TARGET_MANIFEST_SHA256 = "e".repeat(64);
const LOCAL_LEGAL_EVIDENCE_REF =
  "repo:LICENSE#sha256=0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0";

test("package scripts and operator runbook expose every canonical producer", () => {
  const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const expected = {
    "ops:evidence:waf:capture":
      "node scripts/run-schema-cli.mjs operator-evidence-waf",
    "ops:evidence:log-retention":
      "node scripts/run-schema-cli.mjs operator-evidence-log-retention",
    "ops:evidence:egress":
      "node scripts/run-schema-cli.mjs operator-evidence-egress",
    "ops:evidence:staging-teardown":
      "node scripts/run-schema-cli.mjs operator-evidence-staging-teardown",
    "ops:evidence:container-licensing":
      "node scripts/run-schema-cli.mjs operator-evidence-container-licensing",
    "ops:evidence:verify":
      "node scripts/run-schema-cli.mjs operator-evidence-verify"
  };
  for (const [name, command] of Object.entries(expected)) {
    assert.equal(manifest.scripts[name], command, name);
  }
  const runbook = readFileSync(
    path.join(process.cwd(), "docs", "operator-evidence-capture.md"),
    "utf8"
  );
  for (const pathName of [
    "research/ops-evidence/waf-ceilings.json",
    "research/ops-evidence/waf-probe-transcript.json",
    "research/ops-evidence/log-retention.json",
    "research/ops-evidence/egress-backstop.json",
    "research/ops-evidence/staging-teardown.json",
    "research/ops-evidence/container-image-licensing.json"
  ]) {
    assert.match(runbook, new RegExp(pathName.replace(/[./-]/g, "\\$&")));
  }
  assert.match(runbook, /base Cloudflare Ray ID as `requestId`/);
  assert.match(runbook, /domain-separated `providerRequestRef`/);
  assert.doesNotMatch(
    runbook,
    /--provider-events-export[\s\S]{0,160}--captured-at/
  );
  assert.match(
    runbook,
    /object supplies `candidateCommit`, `deploymentCommit`, `policy`/
  );
  assert.match(
    runbook,
    /binding JSON contains exactly\s+`candidateCommit` and `deploymentCommit`/
  );
  assert.match(runbook, /--repository-root <exact-repository-root>/);
  assert.match(
    runbook,
    /Git\s+blob with that digest at the exact candidate commit/
  );
  assert.match(
    runbook,
    /data-only[\s\S]*never loads provider code[\s\S]*never deletes/
  );
  assert.match(
    runbook,
    /controlled-r2 runner registration is deliberately not a staging teardown[\s\S]*both controlled corpus\s+cycles/
  );
  assert.match(
    runbook,
    /release\s+attestation must bind both source-artifact digests/
  );
  assert.match(runbook, /No provider module is loaded/);
  assert.match(runbook, /--provider-events-export/);
  assert.match(
    runbook,
    /caller-supplied digest is not evidence[\s\S]*release gate remains red/
  );
});

test("operator evidence byte format is canonical and rejects cosmetic rewrites", async () => {
  const {
    parseCanonicalEvidence,
    serializeCanonicalEvidence
  } = await script("operator-evidence-common.mjs");
  const bytes = serializeCanonicalEvidence({
    z: [2, 1],
    a: { second: true, first: "value" }
  });
  assert.equal(bytes, '{"a":{"first":"value","second":true},"z":[2,1]}\n');
  assert.deepEqual(parseCanonicalEvidence(bytes), {
    a: { first: "value", second: true },
    z: [2, 1]
  });
  assert.throws(
    () => parseCanonicalEvidence('{"z":[2,1],"a":{"first":"value","second":true}}\n'),
    /not in canonical evidence serialization/
  );
});

test("operator evidence I/O rejects oversized or linked inputs and linked output parents", async () => {
  const {
    readBoundedNoFollowUtf8,
    writeExclusive,
    writeExclusiveAtomic
  } = await script("operator-evidence-common.mjs");
  const dir = mkdtempSync(
    path.join(
      process.cwd(),
      "research",
      "ops-evidence",
      ".test-operator-io-"
    )
  );
  try {
    const oversized = path.join(dir, "oversized.json");
    writeFileSync(oversized, "123456789");
    await assert.rejects(
      readBoundedNoFollowUtf8(oversized, "fixture", 8),
      /exceeds the 8-byte input limit/
    );

    const target = path.join(dir, "target.json");
    const linkedInput = path.join(dir, "linked-input.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, linkedInput);
    await assert.rejects(
      readBoundedNoFollowUtf8(linkedInput, "fixture", 8),
      /symbolic link/
    );

    const realParent = path.join(dir, "real-parent");
    const linkedParent = path.join(dir, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    await assert.rejects(
      writeExclusive(path.join(linkedParent, "receipt.json"), "{}\n"),
      /parent chain must not contain symbolic links/
    );
    assert.equal(existsSync(path.join(realParent, "receipt.json")), false);

    const atomicOutput = path.join(dir, "atomic.json");
    await writeExclusiveAtomic(atomicOutput, '{"complete":true}\n');
    assert.equal(readFileSync(atomicOutput, "utf8"), '{"complete":true}\n');
    await assert.rejects(
      writeExclusiveAtomic(atomicOutput, '{"complete":false}\n'),
      /must not already exist/
    );
    assert.equal(readFileSync(atomicOutput, "utf8"), '{"complete":true}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function wafPolicy() {
  return {
    provider: "cloudflare",
    ruleId: "scan-api-rate-limit",
    ruleVersion: "2026-08-01",
    requestLimit: 10,
    windowSeconds: 10,
    mitigationTimeoutSeconds: 10,
    routes: [
      {
        id: "get-admission",
        method: "GET",
        path: "/api/scan/admission"
      },
      {
        id: "post-admission",
        method: "POST",
        path: "/api/scan"
      }
    ]
  };
}

function wafRequestRef(value: string) {
  const normalized = value.split("-", 1)[0].toLowerCase();
  return `sha256:${createHash("sha256")
    .update(`site-behavior-lab-waf-request-correlation-v1\u0000${normalized}`)
    .digest("hex")}`;
}

function wafProbes() {
  const observations = (requestId: string) =>
    Array.from({ length: 11 }, (_, index) => ({
      ordinal: index + 1,
      status: index === 10 ? 429 : 400,
      retryAfterSeconds: index === 10 ? 10 : null,
      providerRequestRef: index === 10 ? wafRequestRef(requestId) : null
    }));
  return [
    {
      routeId: "get-admission",
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:01.000Z",
      observations: observations("89ABCDEF01234567-SJC")
    },
    {
      routeId: "post-admission",
      startedAt: "2026-08-01T00:00:12.000Z",
      completedAt: "2026-08-01T00:00:13.000Z",
      observations: observations("0123456789ABCDEF-IAD")
    }
  ];
}

function wafProviderEventsExport() {
  return {
    tool: {
      name: "cloudflare-security-events-exporter",
      version: "1.0.0"
    },
    query: {
      provider: "cloudflare",
      zoneId: "zone-sensitive-id",
      startedAt: "2026-07-31T23:59:59.000Z",
      endedAt: "2026-08-01T00:00:13.050Z"
    },
    exportedAt: "2026-08-01T00:00:13.075Z",
    events: [
      {
        ruleId: "scan-api-rate-limit",
        method: "GET",
        path: "/api/scan/admission",
        action: "block",
        timestamp: "2026-08-01T00:00:00.900Z",
        requestId: "89abcdef01234567"
      },
      {
        ruleId: "scan-api-rate-limit",
        method: "POST",
        path: "/api/scan",
        action: "block",
        timestamp: "2026-08-01T00:00:12.900Z",
        requestId: "0123456789abcdef"
      }
    ]
  };
}

test("WAF receipt proves two isolated exact eleventh-request ceilings and derives its digest", async () => {
  const {
    buildWafCeilingEvidence,
    buildWafProbeTranscript,
    serializeWafCeilingEvidence,
    serializeWafProbeTranscript,
    validateWafCeilingEvidence,
    WAF_PROVIDER_EVENTS_EXPORT_MAX_BYTES
  } = await script("waf-ceiling-evidence-lib.mjs");
  const transcript = buildWafProbeTranscript({
    candidateCommit: CANDIDATE,
    deploymentCommit: DEPLOYMENT,
    recordedAt: "2026-08-01T00:00:13.000Z",
    rulePolicy: wafPolicy(),
    probes: wafProbes()
  });
  const probeTranscriptBytes = serializeWafProbeTranscript(transcript);
  const providerEventsExportBytes = `${JSON.stringify(
    wafProviderEventsExport(),
    null,
    2
  )}\n`;
  const receipt = buildWafCeilingEvidence({
    probeTranscriptBytes,
    providerEventsExportBytes
  });
  const wafVerdict = validateWafCeilingEvidence(receipt);
  assert.equal(wafVerdict.ok, true);
  assert.match(wafVerdict.bindings.probeTranscriptDigest, /^[0-9a-f]{64}$/);
  assert.match(
    wafVerdict.bindings.providerEventsExportDigest,
    /^[0-9a-f]{64}$/
  );
  assert.equal(receipt.capturedAt, "2026-08-01T00:00:13.075Z");
  assert.equal(
    wafVerdict.bindings.effectiveSourceObservedAt,
    "2026-08-01T00:00:13.075Z"
  );
  assert.match(receipt.wafRulesDigest, /^[0-9a-f]{64}$/);
  assert.match(receipt.providerEventReadbackDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    receipt.sourceArtifacts.providerEventsExport.digest,
    `sha256:${createHash("sha256")
      .update(providerEventsExportBytes)
      .digest("hex")}`
  );
  assert.match(
    receipt.sourceArtifacts.providerEventsExport.query.zoneRef,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.doesNotMatch(
    serializeWafCeilingEvidence(receipt),
    /zone-sensitive-id|89abcdef01234567|0123456789abcdef|clientIp|rawUrl|secret=value/
  );
  assert.equal(serializeWafCeilingEvidence(receipt).endsWith("\n"), true);

  const randomDigest = structuredClone(receipt);
  randomDigest.wafRulesDigest = DIGEST;
  const digestVerdict = validateWafCeilingEvidence(randomDigest);
  assert.equal(digestVerdict.ok, false);
  assert.match(digestVerdict.problems.join(" "), /exact canonical rulePolicy bytes/);

  const randomReadbackDigest = structuredClone(receipt);
  randomReadbackDigest.providerEventReadbackDigest = DIGEST;
  assert.match(
    validateWafCeilingEvidence(randomReadbackDigest).problems.join(" "),
    /exact canonical provider Security Events readback bytes/
  );

  const earlyLimit = structuredClone(receipt);
  earlyLimit.probes[0].observations[9].status = 429;
  assert.match(
    validateWafCeilingEvidence(earlyLimit).problems.join(" "),
    /must not be rate limited before request 11/
  );

  const acceptedInvalidPost = structuredClone(receipt);
  acceptedInvalidPost.probes[1].observations[0].status = 202;
  assert.match(
    validateWafCeilingEvidence(acceptedInvalidPost).problems.join(" "),
    /must be exactly 400 for the fixed invalid POST probe/
  );

  const substitutedPostBodyDigest = structuredClone(receipt);
  substitutedPostBodyDigest.postProbeBodyDigest = `sha256:${"0".repeat(64)}`;
  assert.match(
    validateWafCeilingEvidence(substitutedPostBodyDigest).problems.join(" "),
    /postProbeBodyDigest must be exactly/
  );

  const sharedWindow = structuredClone(receipt);
  sharedWindow.probes[1].startedAt = "2026-08-01T00:00:02.000Z";
  assert.match(
    validateWafCeilingEvidence(sharedWindow).problems.join(" "),
    /must start after the GET route/
  );

  const applicationLimiter = structuredClone(receipt);
  applicationLimiter.providerEventReadback.events[1].ruleId =
    "application-rate-limiter";
  assert.match(
    validateWafCeilingEvidence(applicationLimiter).problems.join(" "),
    /ruleId must be exactly scan-api-rate-limit/
  );

  const movingProviderEvent = structuredClone(receipt);
  movingProviderEvent.providerEventReadback.events[0].clientIp = "192.0.2.1";
  assert.match(
    validateWafCeilingEvidence(movingProviderEvent).problems.join(" "),
    /must contain exactly .*providerRequestRef/
  );

  const relabeledFreshness = structuredClone(receipt);
  relabeledFreshness.capturedAt = "2026-08-01T00:00:14.000Z";
  assert.match(
    validateWafCeilingEvidence(relabeledFreshness).problems.join(" "),
    /capturedAt must exactly equal the effective source observation time/
  );

  const secretBearingExport = wafProviderEventsExport();
  (secretBearingExport.events[0] as Record<string, unknown>).clientIp =
    "192.0.2.1";
  assert.throws(
    () =>
      buildWafCeilingEvidence({
        probeTranscriptBytes,
        providerEventsExportBytes: `${JSON.stringify(secretBearingExport)}\n`
      }),
    /must contain exactly .*requestId/
  );

  const unrelatedConcurrentExport = wafProviderEventsExport();
  unrelatedConcurrentExport.events[0].requestId = "fedcba9876543210";
  assert.throws(
    () =>
      buildWafCeilingEvidence({
        probeTranscriptBytes,
        providerEventsExportBytes: `${JSON.stringify(
          unrelatedConcurrentExport
        )}\n`
      }),
    /exactly one matching get-admission block event/
  );

  assert.throws(
    () =>
      buildWafCeilingEvidence({
        probeTranscriptBytes,
        providerEventsExportBytes: Buffer.from([0xff])
      }),
    /valid UTF-8 JSON/
  );
  assert.throws(
    () =>
      buildWafCeilingEvidence({
        probeTranscriptBytes,
        providerEventsExportBytes: Buffer.alloc(
          WAF_PROVIDER_EVENTS_EXPORT_MAX_BYTES + 1,
          0x20
        )
      }),
    /must contain 1 through/
  );
});

test("live WAF executor isolates shared counters and never retains private request or response material", async () => {
  const {
    executeWafCeilingProbe,
    serializeWafProbeTranscript,
    wafProviderRequestRef,
    WAF_POST_PROBE_BODY_DIGEST
  } = await script("waf-ceiling-evidence-lib.mjs");
  assert.equal(
    wafProviderRequestRef("89ABCDEF01234567-SJC"),
    wafProviderRequestRef("89abcdef01234567")
  );
  let calls = 0;
  const requestSignals: AbortSignal[] = [];
  const requestBodies: Array<string | undefined> = [];
  const requestContentTypes: Array<string | null> = [];
  let waitedMilliseconds = 0;
  let getBurstCompletedAt = 0;
  let nowMs = Date.parse("2026-08-01T00:00:00.000Z");
  const secret = "secret-body-and-credential";
  const transcript = await executeWafCeilingProbe({
    baseUrl: "https://scan.example.test",
    candidateCommit: CANDIDATE,
    deploymentCommit: DEPLOYMENT,
    rulePolicy: wafPolicy(),
    requestMaterial: {
      get: { headers: { authorization: `Bearer ${secret}` } },
      post: {
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/problem+json"
        }
      }
    },
    fetchImpl: async (
      _url: URL,
      options: { signal: AbortSignal; body?: string; headers: Headers }
    ) => {
      calls += 1;
      requestSignals.push(options.signal);
      requestBodies.push(options.body);
      requestContentTypes.push(options.headers.get("content-type"));
      nowMs += 25;
      const ordinal = ((calls - 1) % 11) + 1;
      if (calls === 11) getBurstCompletedAt = nowMs;
      // The live 11s-gap probe throttled POST early despite a 10s mitigation.
      // Model counter state that persists through the counting window too.
      const staleGetCounter = calls > 11 && nowMs - getBurstCompletedAt < 20_000;
      return {
        status: ordinal === 11 || staleGetCounter ? 429 : 400,
        headers: {
          get: (name: string) => {
            if (name === "retry-after" && (ordinal === 11 || staleGetCounter)) return "10";
            if (name === "cf-ray") {
              return `${calls.toString(16).padStart(16, "0")}-SJC`;
            }
            return null;
          }
        },
        body: `response-${secret}`
      };
    },
    now: () => new Date(nowMs),
    wait: async (milliseconds: number) => {
      waitedMilliseconds += milliseconds;
      nowMs += milliseconds;
    }
  });
  const bytes = serializeWafProbeTranscript(transcript);
  assert.equal(calls, 22);
  assert.equal(requestSignals.length, 22);
  assert.equal(
    requestSignals.every((signal) => signal instanceof AbortSignal),
    true
  );
  assert.equal(waitedMilliseconds, 21_000);
  assert.equal(transcript.postProbeBodyDigest, WAF_POST_PROBE_BODY_DIGEST);
  assert.deepEqual(requestBodies.slice(0, 11), Array(11).fill(undefined));
  assert.deepEqual(requestBodies.slice(11), Array(11).fill("{}"));
  assert.deepEqual(
    requestContentTypes.slice(11),
    Array(11).fill("application/json")
  );
  assert.doesNotMatch(
    bytes,
    /secret-body-and-credential|target\.example|authorization|response-|0000000000000016/
  );

  await assert.rejects(
    () =>
      executeWafCeilingProbe({
        baseUrl: "https://scan.example.test",
        candidateCommit: CANDIDATE,
        deploymentCommit: DEPLOYMENT,
        rulePolicy: wafPolicy(),
        requestMaterial: {
          get: { headers: {} },
          post: {
            headers: {},
            body: JSON.stringify({
              url: "https://target.example",
              createReport: true
            })
          }
        },
        fetchImpl: async () => {
          throw new Error("must not execute");
        }
      }),
    /post-admission request material must contain exactly headers/
  );
});

test("canonical WAF CLI refuses non-production origins and arbitrary provider modules", () => {
  const refusedOutput = path.join(
    process.cwd(),
    "research",
    "ops-evidence",
    ".must-not-create-waf-probe.json"
  );
  rmSync(refusedOutput, { force: true });
  const cli = spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), "scripts", "capture-waf-ceilings.mjs"),
      "--probe",
      "--base-url",
      "https://scan.example.test",
      "--candidate-commit",
      CANDIDATE,
      "--deployment-commit",
      DEPLOYMENT,
      "--rule-policy",
      "/does/not/exist.json",
      "--output",
      refusedOutput
    ],
    { encoding: "utf8" }
  );
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /must be exactly https:\/\/scan\.sitebehavior\.org/);
  assert.equal(existsSync(refusedOutput), false);

  const dir = mkdtempSync(
    path.join(
      process.cwd(),
      "research",
      "ops-evidence",
      ".test-waf-adapter-refusal-"
    )
  );
  try {
    const marker = path.join(dir, "module-loaded");
    const adapter = path.join(dir, "malicious-adapter.mjs");
    const collision = path.join(dir, "existing-probe.json");
    writeFileSync(collision, "keep\n");
    const refusedCollision = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts", "capture-waf-ceilings.mjs"),
        "--probe",
        "--base-url",
        "https://scan.sitebehavior.org",
        "--candidate-commit",
        CANDIDATE,
        "--deployment-commit",
        DEPLOYMENT,
        "--rule-policy",
        "/does/not/exist.json",
        "--output",
        collision
      ],
      { encoding: "utf8" }
    );
    assert.notEqual(refusedCollision.status, 0);
    assert.match(refusedCollision.stderr, /must not already exist/);
    assert.equal(readFileSync(collision, "utf8"), "keep\n");

    writeFileSync(
      adapter,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(
        marker
      )}, "loaded");`
    );
    const refusedAdapter = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts", "capture-waf-ceilings.mjs"),
        "--probe",
        "--base-url",
        "https://scan.sitebehavior.org",
        "--candidate-commit",
        CANDIDATE,
        "--deployment-commit",
        DEPLOYMENT,
        "--rule-policy",
        "/does/not/exist.json",
        "--output",
        path.join(dir, "must-not-create.json"),
        "--provider-events-adapter",
        adapter
      ],
      { encoding: "utf8" }
    );
    assert.notEqual(refusedAdapter.status, 0);
    assert.match(refusedAdapter.stderr, /unknown argument --provider-events-adapter/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WAF finalization refuses a linked provider export before creating evidence", async () => {
  const {
    buildWafProbeTranscript,
    serializeWafProbeTranscript
  } = await script("waf-ceiling-evidence-lib.mjs");
  const dir = mkdtempSync(
    path.join(
      process.cwd(),
      "research",
      "ops-evidence",
      ".test-waf-finalize-input-"
    )
  );
  try {
    const transcriptPath = path.join(dir, "probe.json");
    const providerTarget = path.join(dir, "provider-target.json");
    const providerLink = path.join(dir, "provider-link.json");
    const output = path.join(dir, "receipt.json");
    writeFileSync(
      transcriptPath,
      serializeWafProbeTranscript(
        buildWafProbeTranscript({
          candidateCommit: CANDIDATE,
          deploymentCommit: DEPLOYMENT,
          recordedAt: "2026-08-01T00:00:13.000Z",
          rulePolicy: wafPolicy(),
          probes: wafProbes()
        })
      )
    );
    writeFileSync(
      providerTarget,
      `${JSON.stringify(wafProviderEventsExport())}\n`
    );
    symlinkSync(providerTarget, providerLink);
    const cli = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts", "capture-waf-ceilings.mjs"),
        "--finalize",
        "--probe-transcript",
        transcriptPath,
        "--provider-events-export",
        providerLink,
        "--output",
        output
      ],
      { encoding: "utf8" }
    );
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /symbolic link/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function logPolicy() {
  return {
    provider: "cloudflare-workers-observability",
    policyId: "workers-observability-production",
    retentionDays: 7,
    queryWindow: {
      startedAt: "2026-07-25T12:00:00.000Z",
      endedAt: "2026-08-01T12:00:00.000Z"
    },
    maxEventsPerQuery: 100,
    queries: [
      { id: "health", routePrefix: "/api/health" },
      { id: "reports", routePrefix: "/reports/" }
    ],
    redaction: {
      retainedEventFields: ["observedAt"],
      discardedSensitiveClasses: [
        "target-url",
        "query-value",
        "raw-credential",
        "request-body",
        "personal-data-payload",
        "report-identifier"
      ]
    }
  };
}

test("log producer derives policy digest and drops all provider identifiers and payloads", async () => {
  const {
    buildLogRetentionEvidence,
    serializeLogRetentionEvidence,
    validateLogRetentionEvidence
  } = await script("log-retention-evidence-lib.mjs");
  const rawResults = [
    {
      queryId: "health",
      observedAt: "2026-07-29T11:25:00.000Z",
      requestUrl: "https://target.example/?secret=value",
      credential: "Bearer should-not-survive",
      payload: { patient: "private" }
    },
    {
      queryId: "reports",
      observedAt: "2026-07-29T11:42:00.000Z",
      reportIdentifier: "20260729-private",
      queryValue: "private"
    }
  ];
  const source = {
    candidateCommit: CANDIDATE,
    deploymentCommit: DEPLOYMENT,
    policy: logPolicy(),
    retentionReadback: {
      readAt: "2026-08-01T12:00:30.000Z",
      configuredRetentionDays: 7,
      providerPolicyRef: "workers-observability-production"
    },
    rawResults,
    sourceTool: {
      name: "cloudflare-observability-query-exporter",
      version: "1.0.0"
    },
    providerQueryId: "query-2026-08-01-release"
  };
  const sourceBytes = `${JSON.stringify(source, null, 2)}\n`;
  const receipt = buildLogRetentionEvidence({ sourceBytes });
  const bytes = serializeLogRetentionEvidence(receipt);
  const logVerdict = validateLogRetentionEvidence(receipt);
  assert.equal(logVerdict.ok, true);
  assert.match(logVerdict.bindings.providerExportDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    logVerdict.bindings.sourceTool,
    "cloudflare-observability-query-exporter@1.0.0"
  );
  assert.equal(receipt.capturedAt, "2026-08-01T12:00:30.000Z");
  assert.equal(
    logVerdict.bindings.effectiveSourceObservedAt,
    "2026-08-01T12:00:30.000Z"
  );
  assert.equal(
    receipt.sourceArtifact.digest,
    `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`
  );
  assert.match(
    receipt.sourceArtifact.query.providerQueryRef,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.match(receipt.policy.policyId, /^sha256:[0-9a-f]{64}$/);
  assert.match(
    receipt.retentionReadback.providerPolicyRef,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.doesNotMatch(
    bytes,
    /target\.example|secret=value|Bearer|patient|reportIdentifier|20260729-private|queryValue|workers-observability-production/
  );

  const randomDigest = structuredClone(receipt);
  randomDigest.logPolicyDigest = DIGEST;
  assert.match(
    validateLogRetentionEvidence(randomDigest).problems.join(" "),
    /exact canonical policy bytes/
  );

  const smuggledIdentifier = structuredClone(receipt);
  smuggledIdentifier.results[0].events[0].identifier = "private";
  assert.match(
    validateLogRetentionEvidence(smuggledIdentifier).problems.join(" "),
    /must contain exactly observedAt/
  );

  const movingSource = structuredClone(receipt);
  movingSource.sourceArtifact.digest = "provider/dashboard/latest";
  assert.match(
    validateLogRetentionEvidence(movingSource).problems.join(" "),
    /exact sha256:<64 lowercase hex>/
  );

  const detachedReadback = structuredClone(receipt);
  detachedReadback.sourceArtifact.retentionReadbackDigest = DIGEST;
  assert.match(
    validateLogRetentionEvidence(detachedReadback).problems.join(" "),
    /must bind the exact retention readback/
  );

  const detachedWindow = structuredClone(receipt);
  detachedWindow.sourceArtifact.query.startedAt =
    "2026-07-25T12:00:01.000Z";
  assert.match(
    validateLogRetentionEvidence(detachedWindow).problems.join(" "),
    /must bind the exact log policy query window/
  );

  const nonCausalReadback = structuredClone(receipt);
  nonCausalReadback.retentionReadback.readAt =
    "2026-08-01T11:59:59.000Z";
  assert.match(
    validateLogRetentionEvidence(nonCausalReadback).problems.join(" "),
    /must not precede the query-window end/
  );

  const relabeledFreshness = structuredClone(receipt);
  relabeledFreshness.capturedAt = "2026-08-01T12:01:00.000Z";
  assert.match(
    validateLogRetentionEvidence(relabeledFreshness).problems.join(" "),
    /capturedAt must exactly equal the effective source observation time/
  );

  const mismatchedRawPolicy = structuredClone(source);
  mismatchedRawPolicy.retentionReadback.providerPolicyRef =
    "different-provider-policy";
  assert.throws(
    () =>
      buildLogRetentionEvidence({
        sourceBytes: `${JSON.stringify(mismatchedRawPolicy)}\n`
      }),
    /providerPolicyRef must exactly equal policy\.policyId before redaction/
  );

  assert.throws(
    () =>
      buildLogRetentionEvidence({
        candidateCommit: CANDIDATE,
        policy: logPolicy(),
        rawResults
      }),
    /provider log export must be supplied as exact bytes/
  );
});

function egressPolicy() {
  return {
    provider: "example-vpc",
    policyId: "scanner-egress",
    policyVersion: "2026-08-01",
    enforcementBoundary: "vpc-firewall",
    applicationProcessOwnership: "external",
    defaultAction: "deny",
    allowedPublicTcpPorts: [80, 443],
    blockedClasses: [
      {
        id: "private",
        ruleId: "scanner-egress:private",
        cidrs: [
          "10.0.0.0/8",
          "172.16.0.0/12",
          "192.168.0.0/16",
          "fc00::/7"
        ],
        probeDestination: "10.255.255.1",
        probePort: 80
      },
      {
        id: "link-local",
        ruleId: "scanner-egress:link-local",
        cidrs: ["169.254.0.0/16", "fe80::/10"],
        probeDestination: "169.254.1.1",
        probePort: 80
      },
      {
        id: "metadata",
        ruleId: "scanner-egress:metadata",
        cidrs: ["169.254.169.254/32"],
        probeDestination: "169.254.169.254",
        probePort: 80
      }
    ],
    publicControl: { destination: "1.1.1.1", port: 443 },
    collectionEgress: {
      label: "controlled-r2-nat",
      region: "us-east",
      natIdentity: "nat-0feedface"
    }
  };
}

function egressProbe() {
  return {
    tool: {
      name: "network-policy-probe",
      version: "1.0.0",
      executionBoundary: "outside-application"
    },
    applicationGuardMode: "disabled",
    startedAt: "2026-08-01T13:00:00.000Z",
    completedAt: "2026-08-01T13:00:04.000Z",
    attempts: egressPolicy().blockedClasses.map((entry, index) => ({
      classId: entry.id,
      destination: entry.probeDestination,
      port: entry.probePort,
      observedAt: `2026-08-01T13:00:0${index + 1}.000Z`,
      outcome: "blocked",
      policyDecision: "deny",
      policyRuleId: entry.ruleId
    })),
    publicControl: {
      destination: "1.1.1.1",
      port: 443,
      observedAt: "2026-08-01T13:00:04.000Z",
      outcome: "allowed",
      policyDecision: "allow"
    }
  };
}

test("egress receipt binds exact policy bytes to an outside-application failure probe", async () => {
  const {
    buildEgressBackstopEvidence,
    validateEgressBackstopEvidence
  } = await script("egress-backstop-evidence-lib.mjs");
  const policyBytes = `${JSON.stringify(egressPolicy(), null, 2)}\n`;
  const probeBytes = `${JSON.stringify(egressProbe(), null, 2)}\n`;
  const receipt = buildEgressBackstopEvidence({
    candidateCommit: CANDIDATE,
    deploymentCommit: DEPLOYMENT,
    networkPolicySourceBytes: policyBytes,
    failureModeProbeSourceBytes: probeBytes
  });
  const egressVerdict = validateEgressBackstopEvidence(receipt);
  assert.equal(egressVerdict.ok, true);
  assert.match(
    egressVerdict.bindings.networkPolicyExportDigest,
    /^[0-9a-f]{64}$/
  );
  assert.match(
    egressVerdict.bindings.failureProbeTranscriptDigest,
    /^[0-9a-f]{64}$/
  );
  assert.equal(receipt.capturedAt, "2026-08-01T13:00:04.000Z");
  assert.equal(
    egressVerdict.bindings.effectiveSourceObservedAt,
    "2026-08-01T13:00:04.000Z"
  );
  assert.equal(
    receipt.sourceArtifacts.networkPolicyExport.digest,
    `sha256:${createHash("sha256").update(policyBytes).digest("hex")}`
  );
  assert.equal(
    receipt.sourceArtifacts.failureProbeTranscript.digest,
    `sha256:${createHash("sha256").update(probeBytes).digest("hex")}`
  );
  const committedBytes = JSON.stringify(receipt);
  assert.doesNotMatch(
    committedBytes,
    /example-vpc|scanner-egress|scanner-egress:private|nat-0feedface/
  );
  assert.match(receipt.networkPolicy.provider, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.networkPolicy.policyId, /^sha256:[0-9a-f]{64}$/);
  assert.match(
    receipt.networkPolicy.collectionEgress.natIdentityRef,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.match(
    receipt.networkPolicy.collectionEgress.labelRef,
    /^sha256:[0-9a-f]{64}$/
  );
  assert.notEqual(
    receipt.networkPolicy.blockedClasses[0].ruleId,
    receipt.networkPolicy.policyId
  );

  const randomDigest = structuredClone(receipt);
  randomDigest.networkPolicyDigest = DIGEST;
  assert.match(
    validateEgressBackstopEvidence(randomDigest).problems.join(" "),
    /exact canonical networkPolicy bytes/
  );

  const appGuard = structuredClone(receipt);
  appGuard.failureModeProbe.applicationGuardMode = "enabled";
  assert.match(
    validateEgressBackstopEvidence(appGuard).problems.join(" "),
    /must be exactly disabled/
  );

  const reachableMetadata = structuredClone(receipt);
  reachableMetadata.failureModeProbe.attempts[2].outcome = "allowed";
  assert.match(
    validateEgressBackstopEvidence(reachableMetadata).problems.join(" "),
    /outcome must be exactly blocked/
  );

  const digestFreeSource = structuredClone(receipt);
  digestFreeSource.sourceArtifacts.failureProbeTranscript.digest =
    "latest/provider-probe.json";
  assert.match(
    validateEgressBackstopEvidence(digestFreeSource).problems.join(" "),
    /exact sha256:<64 lowercase hex>/
  );

  const relabeledFreshness = structuredClone(receipt);
  relabeledFreshness.capturedAt = "2026-08-01T13:00:05.000Z";
  assert.match(
    validateEgressBackstopEvidence(relabeledFreshness).problems.join(" "),
    /capturedAt must exactly equal the effective source observation time/
  );

  assert.throws(
    () =>
      buildEgressBackstopEvidence({
        candidateCommit: CANDIDATE,
        deploymentCommit: DEPLOYMENT,
        networkPolicy: egressPolicy(),
        failureModeProbe: egressProbe()
      }),
    /network policy export must be supplied as exact bytes/
  );

  for (const rejectedControl of [
    "::ffff:10.0.0.1",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "192.0.2.1",
    "224.0.0.1",
    "2001:db8::1"
  ]) {
    const policy = egressPolicy();
    policy.publicControl.destination = rejectedControl;
    assert.throws(
      () =>
        buildEgressBackstopEvidence({
          candidateCommit: CANDIDATE,
          deploymentCommit: DEPLOYMENT,
          networkPolicySourceBytes: `${JSON.stringify(policy)}\n`,
          failureModeProbeSourceBytes: probeBytes
        }),
      /publicControl\.destination must be exactly 1\.1\.1\.1/
    );
  }

  const longProbe = egressProbe();
  longProbe.startedAt = "2026-08-01T12:58:59.000Z";
  assert.throws(
    () =>
      buildEgressBackstopEvidence({
        candidateCommit: CANDIDATE,
        deploymentCommit: DEPLOYMENT,
        networkPolicySourceBytes: policyBytes,
        failureModeProbeSourceBytes: `${JSON.stringify(longProbe)}\n`
      }),
    /must complete within one minute/
  );

  const privateRulePolicy = egressPolicy();
  privateRulePolicy.blockedClasses[0].ruleId =
    "private-provider-firewall-rule-secret";
  assert.throws(
    () =>
      buildEgressBackstopEvidence({
        candidateCommit: CANDIDATE,
        deploymentCommit: DEPLOYMENT,
        networkPolicySourceBytes: `${JSON.stringify(privateRulePolicy)}\n`,
        failureModeProbeSourceBytes: probeBytes
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /policyRuleId must match its bound blocked-class rule/);
      assert.doesNotMatch(
        error.message,
        /private-provider-firewall-rule-secret/
      );
      return true;
    }
  );
});

async function stagingTranscript() {
  const {
    stagingTeardownDryRunPlan
  } = await script("staging-teardown-evidence-lib.mjs");
  const plan = stagingTeardownDryRunPlan();
  const before = plan.map(
    (entry: { kind: string; logicalName: string }) => ({
      kind: entry.kind,
      logicalName: entry.logicalName,
      externalIds: [`id:${entry.logicalName}`],
      state: "present",
      evidenceArtifact: {
        kind: "provider-inventory-response",
        sessionId: STAGING_SESSION_ID,
        bytes: `fixture:before:${entry.logicalName}`
      }
    })
  );
  const after = plan.map(
    (entry: { kind: string; logicalName: string }) => ({
      kind: entry.kind,
      logicalName: entry.logicalName,
      externalIds: [],
      state: "absent",
      evidenceArtifact: {
        kind: "provider-inventory-response",
        sessionId: STAGING_SESSION_ID,
        bytes: `fixture:after:${entry.logicalName}`
      }
    })
  );
  const actions = plan.map(
    (entry: { kind: string; logicalName: string; ifPresent: string }) => ({
      kind: entry.kind,
      logicalName: entry.logicalName,
      externalIds: [`id:${entry.logicalName}`],
      disposition: entry.ifPresent,
      completedAt: "2026-08-01T14:00:02.000Z",
      evidenceArtifact: {
        kind: "provider-removal-response",
        sessionId: STAGING_SESSION_ID,
        bytes: `fixture:remove:${entry.logicalName}`
      }
    })
  );
  return {
    stagingSourceCommit: CANDIDATE,
    targetManifestSha256: STAGING_TARGET_MANIFEST_SHA256,
    recordedAt: "2026-08-01T14:00:04.000Z",
    session: {
      id: STAGING_SESSION_ID,
      startedAt: "2026-08-01T14:00:00.000Z",
      inventoryBeforeAt: "2026-08-01T14:00:01.000Z",
      inventoryAfterAt: "2026-08-01T14:00:03.000Z",
      completedAt: "2026-08-01T14:00:04.000Z"
    },
    inventory: {
      before,
      actions,
      after
    }
  };
}

test("a teardown receipt where nothing was present proves nothing, and is refused", async () => {
  // The disposition of each action is DERIVED from the before-inventory state,
  // so a transcript in which every resource was already absent produced a
  // fully consistent receipt. That is exactly what a rerun of a completed
  // ceremony yields, and what an environment that was never provisioned
  // yields, and it would have been archived as proof that staging was
  // destroyed.
  const { buildStagingTeardownEvidence } = await script("staging-teardown-evidence-lib.mjs");

  const transcript = await stagingTranscript();
  for (const entry of transcript.inventory.before) {
    entry.state = "absent";
    entry.externalIds = [];
  }
  for (const action of transcript.inventory.actions) {
    action.disposition = "already-absent";
    action.externalIds = [];
    action.evidenceArtifact.kind = "provider-inventory-response";
  }

  // The builder refuses to construct it at all, so such a receipt never exists
  // to be archived, signed, or pinned.
  assert.throws(
    () =>
      buildStagingTeardownEvidence({
        sourceBytes: `${JSON.stringify(transcript)}\n`
      }),
    /at least one resource observed present and removed/
  );
});

test("a ceremony may legitimately scope out resources that were never deployed", async () => {
  // The requirement is participation, not completeness: a half of staging that
  // was never provisioned must not force the whole receipt to be rejected, or
  // the only way to pass would be to provision resources in order to destroy
  // them.
  const {
    buildStagingTeardownEvidence,
    validateStagingTeardownEvidence
  } = await script("staging-teardown-evidence-lib.mjs");

  const transcript = await stagingTranscript();
  // Everything absent except the first resource, which is torn down for real.
  for (const [index, entry] of transcript.inventory.before.entries()) {
    if (index === 0) continue;
    entry.state = "absent";
    entry.externalIds = [];
  }
  for (const [index, action] of transcript.inventory.actions.entries()) {
    if (index === 0) continue;
    action.disposition = "already-absent";
    action.externalIds = [];
    action.evidenceArtifact.kind = "provider-inventory-response";
  }

  const receipt = buildStagingTeardownEvidence({
    sourceBytes: `${JSON.stringify(transcript)}\n`
  });
  const verdict = validateStagingTeardownEvidence(receipt);
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.equal(receipt.schemaVersion, 2);
});

test("staging teardown hashes one sanitized same-session transcript without executing provider code", async () => {
  const {
    buildStagingTeardownEvidence,
    stagingTeardownDryRunPlan,
    validateStagingTeardownEvidence
  } = await script("staging-teardown-evidence-lib.mjs");
  const plan = stagingTeardownDryRunPlan();
  assert.equal(
    plan.some(
      (entry: { logicalName: string }) =>
        entry.logicalName === "durable-replay-staging-runner-registration"
    ),
    true
  );
  assert.equal(
    plan.some(
      (entry: { logicalName: string }) =>
        entry.logicalName === "controlled-r2-runner-registration"
    ),
    false
  );
  const transcript = await stagingTranscript();
  transcript.inventory.before[0].externalIds = [
    "id:first-resource:a",
    "id:first-resource:z"
  ];
  transcript.inventory.actions[0].externalIds = [
    "id:first-resource:a",
    "id:first-resource:z"
  ];
  const sourceBytes = `${JSON.stringify(transcript)}\n`;
  const receipt = buildStagingTeardownEvidence({ sourceBytes });
  const verdict = validateStagingTeardownEvidence(receipt);
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.equal(Object.hasOwn(receipt, "candidateCommit"), false);
  assert.equal(
    receipt.targetManifestSha256,
    STAGING_TARGET_MANIFEST_SHA256
  );
  assert.equal(
    verdict.bindings.targetManifestSha256,
    STAGING_TARGET_MANIFEST_SHA256
  );
  assert.equal(Object.hasOwn(receipt, "targetManifest"), false);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /STAGING_TEARDOWN_TARGETS_JSON/
  );
  assert.equal(verdict.recordedAt, receipt.recordedAt);
  assert.equal(verdict.teardownInventoryDigest, receipt.teardownInventoryDigest);
  assert.equal(
    verdict.bindings.sourceArtifactDigest,
    receipt.sourceArtifact.digest.slice("sha256:".length)
  );
  assert.equal(
    verdict.bindings.sourceArtifactByteLength,
    Buffer.byteLength(sourceBytes)
  );
  assert.equal(
    receipt.sourceArtifact.digest,
    `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`
  );
  assert.equal(
    receipt.inventory.before.every(
      (entry: { externalIds: string[] }) =>
        entry.externalIds.every((id) => /^sha256:[0-9a-f]{64}$/.test(id))
    ),
    true
  );
  assert.deepEqual(
    receipt.inventory.before[0].externalIds,
    [...receipt.inventory.before[0].externalIds].sort()
  );
  assert.equal(receipt.inventory.before[0].externalIds.length, 2);
  assert.doesNotMatch(JSON.stringify(receipt), /id:site-behavior-lab/);

  const randomDigest = structuredClone(receipt);
  randomDigest.teardownInventoryDigest = DIGEST;
  assert.match(
    validateStagingTeardownEvidence(randomDigest).problems.join(" "),
    /exact canonical session inventory bytes/
  );

  const missingTargetBinding = structuredClone(receipt);
  delete missingTargetBinding.targetManifestSha256;
  assert.match(
    validateStagingTeardownEvidence(missingTargetBinding).problems.join(" "),
    /targetManifestSha256/
  );

  const legacySchema = structuredClone(receipt);
  legacySchema.schemaVersion = 1;
  assert.match(
    validateStagingTeardownEvidence(legacySchema).problems.join(" "),
    /schemaVersion must be exactly 2/
  );

  const malformedTargetBinding = structuredClone(receipt);
  malformedTargetBinding.targetManifestSha256 = "0".repeat(63);
  assert.match(
    validateStagingTeardownEvidence(malformedTargetBinding).problems.join(" "),
    /targetManifestSha256/
  );

  const survivingBucket = structuredClone(receipt);
  survivingBucket.inventory.after[6] = structuredClone(
    survivingBucket.inventory.before[6]
  );
  assert.match(
    validateStagingTeardownEvidence(survivingBucket).problems.join(" "),
    /reports-staging.*absent/
  );

  const movingReference = structuredClone(receipt);
  movingReference.inventory.after[0].evidenceRef = "dashboard/latest";
  assert.match(
    validateStagingTeardownEvidence(movingReference).problems.join(" "),
    /evidenceRef must be an object/
  );

  const crossSessionReference = structuredClone(receipt);
  crossSessionReference.inventory.actions[0].evidenceRef.sessionId =
    "123e4567-e89b-42d3-a456-426614174001";
  assert.match(
    validateStagingTeardownEvidence(crossSessionReference).problems.join(" "),
    /sessionId must match the teardown session/
  );

  const digestFreeReference = structuredClone(receipt);
  digestFreeReference.inventory.before[0].evidenceRef.digest =
    "sha256:latest";
  assert.match(
    validateStagingTeardownEvidence(digestFreeReference).problems.join(" "),
    /exact sha256:<64 lowercase hex>/
  );
});

test("staging teardown CLI is data-only, create-only, and rejects adapter execution", async () => {
  const {
    stagingTeardownDryRunPlan
  } = await script("staging-teardown-evidence-lib.mjs");
  const dir = mkdtempSync(
    path.join(
      process.cwd(),
      "research",
      "ops-evidence",
      ".test-teardown-create-only-"
    )
  );
  try {
    const output = path.join(dir, "receipt.json");
    const marker = path.join(dir, "adapter-loaded");
    const adapter = path.join(dir, "adapter.mjs");
    const capture = path.join(dir, "transcript.json");
    writeFileSync(capture, `${JSON.stringify(await stagingTranscript())}\n`);
    writeFileSync(output, "keep\n");
    writeFileSync(
      adapter,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
        marker
      )}, "loaded");\nexport function createStagingTeardownAdapter(){ throw new Error("must not load"); }\n`
    );
    const cli = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts", "capture-staging-teardown.mjs"),
        "--adapter",
        adapter,
      ],
      { encoding: "utf8" }
    );
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /Usage:/);
    assert.equal(existsSync(marker), false);

    const existingOutputCli = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts", "capture-staging-teardown.mjs"),
        "--capture",
        capture,
        "--output",
        output
      ],
      { encoding: "utf8" }
    );
    assert.notEqual(existingOutputCli.status, 0);
    assert.match(existingOutputCli.stderr, /must not already exist/);
    assert.equal(readFileSync(output, "utf8"), "keep\n");

    const realParent = path.join(dir, "real-output-parent");
    const linkedParent = path.join(dir, "linked-output-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    const linkedParentCli = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts", "capture-staging-teardown.mjs"),
        "--capture",
        capture,
        "--output",
        path.join(linkedParent, "receipt.json")
      ],
      { encoding: "utf8" }
    );
    assert.notEqual(linkedParentCli.status, 0);
    assert.match(linkedParentCli.stderr, /parent chain must not contain symbolic links/);
    assert.equal(existsSync(marker), false);

    const dryRun = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts", "capture-staging-teardown.mjs"),
        "--dry-run"
      ],
      { encoding: "utf8" }
    );
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const plan = JSON.parse(dryRun.stdout);
    assert.equal(plan.destructive, false);
    assert.equal(plan.operations.length, stagingTeardownDryRunPlan().length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function makeContainerEvidence({
  candidateCommit = REPOSITORY_HEAD,
  legalEvidenceRef = LOCAL_LEGAL_EVIDENCE_REF,
  repositoryRoot = process.cwd()
}: {
  candidateCommit?: string;
  legalEvidenceRef?: string;
  repositoryRoot?: string;
} = {}) {
  const inventoryLibrary = await script("container-image-package-inventory-lib.mjs");
  const reviewsLibrary = await script("container-image-package-reviews-lib.mjs");
  const packages = [
    {
      key: "os:ubuntu:adduser@3.137ubuntu1#all",
      packageType: "ubuntu",
      name: "adduser",
      version: "3.137ubuntu1",
      architecture: "all",
      sourceName: "adduser",
      sourceVersion: "3.137ubuntu1",
      detectedLicenses: ["GPL-2.0-only"]
    }
  ].map((pkg) => ({
    ...pkg,
    evidenceDigest: inventoryLibrary.packageEvidenceDigest(pkg)
  }));
  const inventory = {
    schemaVersion: 1,
    artifactKind: "site-behavior-container-image-package-inventory",
    source: { commit: candidateCommit },
    image: {
      id: `sha256:${"b".repeat(64)}`,
      digest: "b".repeat(64),
      os: "linux",
      architecture: "amd64",
      rootfsLayers: [`sha256:${"c".repeat(64)}`]
    },
    scanner: {
      name: "trivy",
      version: "0.70.0",
      reportSchemaVersion: 2,
      scope: "os-packages",
      licenseMode: "standard"
    },
    summary: {
      packageCount: 1,
      packagesWithDetectedLicenses: 1,
      packagesWithoutDetectedLicenses: 0,
      classifiedLicenseFindingCount: 1
    },
    packageSetDigest: inventoryLibrary.packageSetDigest(packages),
    packages
  };
  const { ledger } = reviewsLibrary.syncContainerPackageReviewLedger(inventory, null);
  Object.assign(ledger.reviews[0], {
    status: "reviewed",
    determinedLicense: "GPL-2.0-only",
    licenseEvidenceRefs: [legalEvidenceRef],
    obligations: [
      {
        requirement: "Preserve the packaged copyright and license notices.",
        disposition: "satisfied",
        evidenceRefs: [legalEvidenceRef]
      }
    ],
    reviewer: "Release legal reviewer",
    reviewedAt: "2026-08-01",
    notes: null
  });
  const inventoryBytes =
    inventoryLibrary.serializeContainerImagePackageInventory(inventory);
  const ledgerBytes = `${JSON.stringify(ledger, null, 2)}\n`;
  return {
    inventory,
    ledger,
    inventoryBytes,
    ledgerBytes,
    repositoryRoot
  };
}

test("container licensing receipt derives image and package digests from exact reviewed inputs", { skip: repositoryHeadSkip }, async () => {
  const {
    buildContainerImageLicensingEvidence,
    validateContainerImageLicensingEvidence
  } = await script("container-image-licensing-evidence-lib.mjs");
  const dependencies = await makeContainerEvidence();
  const receipt = buildContainerImageLicensingEvidence({
    ...dependencies,
    capturedAt: "2026-08-02T00:00:00.000Z",
    now: "2026-08-02T00:00:00.000Z"
  });
  const verdict = validateContainerImageLicensingEvidence(receipt, {
    ...dependencies,
    now: "2026-08-02T00:00:00.000Z"
  });
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.equal(receipt.candidateCommit, REPOSITORY_HEAD);
  assert.equal(receipt.containerImageDigest, "b".repeat(64));
  assert.equal(
    receipt.packageInventoryDigest,
    createHash("sha256").update(dependencies.inventoryBytes).digest("hex")
  );
  assert.match(verdict.bindings.legalEvidenceDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(receipt.legalEvidence, [
    {
      kind: "repository-file",
      reference: LOCAL_LEGAL_EVIDENCE_REF,
      repositoryPath: "LICENSE",
      sha256:
        "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0"
    }
  ]);

  const randomDigest = structuredClone(receipt);
  randomDigest.packageInventoryDigest = DIGEST;
  assert.match(
    validateContainerImageLicensingEvidence(randomDigest, {
      ...dependencies,
      now: "2026-08-02T00:00:00.000Z"
    }).problems.join(" "),
    /must be derived from the exact container evidence/
  );

  assert.throws(
    () =>
      buildContainerImageLicensingEvidence({
        ...dependencies,
        inventoryBytes: ` ${dependencies.inventoryBytes}`,
        capturedAt: "2026-08-02T00:00:00.000Z",
        now: "2026-08-02T00:00:00.000Z"
      }),
    /canonical inventory serialization/
  );

  const arbitraryReference = structuredClone(dependencies);
  arbitraryReference.ledger.reviews[0].licenseEvidenceRefs = ["x"];
  arbitraryReference.ledgerBytes =
    `${JSON.stringify(arbitraryReference.ledger, null, 2)}\n`;
  assert.throws(
    () =>
      buildContainerImageLicensingEvidence({
        ...arbitraryReference,
        capturedAt: "2026-08-02T00:00:00.000Z",
        now: "2026-08-02T00:00:00.000Z"
      }),
    /repo:.*canonical HTTPS/
  );

  const wrongLocalDigest = structuredClone(dependencies);
  wrongLocalDigest.ledger.reviews[0].licenseEvidenceRefs = [
    `repo:LICENSE#sha256=${"0".repeat(64)}`
  ];
  wrongLocalDigest.ledgerBytes =
    `${JSON.stringify(wrongLocalDigest.ledger, null, 2)}\n`;
  assert.throws(
    () =>
      buildContainerImageLicensingEvidence({
        ...wrongLocalDigest,
        capturedAt: "2026-08-02T00:00:00.000Z",
        now: "2026-08-02T00:00:00.000Z"
      }),
    /digest does not match the local file bytes/
  );

  const detachedEnumeration = structuredClone(receipt);
  detachedEnumeration.legalEvidence = [];
  assert.match(
    validateContainerImageLicensingEvidence(detachedEnumeration, {
      ...dependencies,
      now: "2026-08-02T00:00:00.000Z"
    }).problems.join(" "),
    /legalEvidence must enumerate/
  );

  const roots = mkdtempSync(
    path.join(process.env.TMPDIR ?? "/tmp", "container-license-roots-")
  );
  const wrongRoot = path.join(roots, "wrong");
  mkdirSync(wrongRoot);
  writeFileSync(path.join(wrongRoot, "LICENSE"), "unrelated checkout\n");
  try {
    const rootedReceipt = buildContainerImageLicensingEvidence({
      ...dependencies,
      capturedAt: "2026-08-02T00:00:00.000Z",
      now: "2026-08-02T00:00:00.000Z"
    });
    const wrongCheckoutVerdict =
      validateContainerImageLicensingEvidence(rootedReceipt, {
        ...dependencies,
        repositoryRoot: wrongRoot,
        now: "2026-08-02T00:00:00.000Z"
      });
    assert.equal(wrongCheckoutVerdict.ok, false);
    assert.match(
      wrongCheckoutVerdict.problems.join(" "),
      /repositoryRoot must identify a Git repository root/
    );
  } finally {
    rmSync(roots, { recursive: true, force: true });
  }

  assert.throws(
    () =>
      buildContainerImageLicensingEvidence({
        ...dependencies,
        repositoryRoot: undefined,
        capturedAt: "2026-08-02T00:00:00.000Z",
        now: "2026-08-02T00:00:00.000Z"
      }),
    /repositoryRoot is required/
  );

  const untrackedDir = mkdtempSync(
    path.join(process.cwd(), "research", "ops-evidence", ".test-legal-ref-")
  );
  try {
    const untrackedPath = path.join(untrackedDir, "NOTICE");
    const untrackedBytes = "untracked legal evidence\n";
    writeFileSync(untrackedPath, untrackedBytes);
    const relativePath = path
      .relative(process.cwd(), untrackedPath)
      .split(path.sep)
      .join("/");
    const untrackedRef = `repo:${relativePath}#sha256=${createHash("sha256")
      .update(untrackedBytes)
      .digest("hex")}`;
    const untrackedDependencies = await makeContainerEvidence({
      legalEvidenceRef: untrackedRef
    });
    assert.throws(
      () =>
        buildContainerImageLicensingEvidence({
          ...untrackedDependencies,
          capturedAt: "2026-08-02T00:00:00.000Z",
          now: "2026-08-02T00:00:00.000Z"
        }),
      /must identify a Git-tracked blob at candidateCommit/
    );
  } finally {
    rmSync(untrackedDir, { recursive: true, force: true });
  }

  const disappearingRoot = mkdtempSync(
    path.join(process.env.TMPDIR ?? "/tmp", "container-license-disappearing-")
  );
  try {
    const noticeBytes = "candidate legal notice\n";
    const noticePath = path.join(disappearingRoot, "NOTICE");
    writeFileSync(noticePath, noticeBytes);
    initFixtureRepo(disappearingRoot, {
      name: "Fixture",
      email: "fixture@example.test"
    });
    runFixtureGit(disappearingRoot, ["add", "NOTICE"]);
    runFixtureGit(disappearingRoot, ["commit", "-qm", "fixture"]);
    const candidateCommit = runFixtureGit(disappearingRoot, [
      "rev-parse",
      "HEAD"
    ]).trim();
    const evidenceRef = `repo:NOTICE#sha256=${createHash("sha256")
      .update(noticeBytes)
      .digest("hex")}`;
    const disappearingDependencies = await makeContainerEvidence({
      candidateCommit,
      legalEvidenceRef: evidenceRef,
      repositoryRoot: disappearingRoot
    });
    rmSync(noticePath);
    assert.throws(
      () =>
        buildContainerImageLicensingEvidence({
          ...disappearingDependencies,
          capturedAt: "2026-08-02T00:00:00.000Z",
          now: "2026-08-02T00:00:00.000Z"
        }),
      /does not identify an existing local file/
    );
  } finally {
    rmSync(disappearingRoot, { recursive: true, force: true });
  }
});
