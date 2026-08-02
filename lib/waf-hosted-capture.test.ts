import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

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
const ZONE_ID = "b".repeat(32);
const RULE_ID = "c".repeat(32);
const RULES_TOKEN = `rules_${"r".repeat(32)}`;
const ANALYTICS_TOKEN = `analytics_${"a".repeat(32)}`;
const GET_RAY = "0123456789abcdef";
const POST_RAY = "fedcba9876543210";
const EXPRESSION =
  '(http.request.method eq "POST" and http.request.uri.path eq "/api/scan") or ' +
  '(http.request.method eq "GET" and http.request.uri.path eq "/api/scan/admission")';

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function rulesetRule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    version: "7",
    ref: "scan-api-rate-limit",
    enabled: true,
    action: "block",
    expression: EXPRESSION,
    ratelimit: {
      requests_per_period: 10,
      period: 10,
      mitigation_timeout: 10,
      characteristics: ["cf.colo.id", "ip.src"]
    },
    ...overrides
  };
}

function rulesetResponse(rules = [rulesetRule()]) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      id: "d".repeat(32),
      version: "9",
      phase: "http_ratelimit",
      rules
    }
  };
}

function securityEvent({
  rayName,
  method,
  pathName,
  datetime,
  overrides = {}
}: {
  rayName: string;
  method: string;
  pathName: string;
  datetime: string;
  overrides?: Record<string, unknown>;
}) {
  return {
    action: "block",
    clientRequestHTTPMethodName: method,
    clientRequestPath: pathName,
    datetime,
    rayName,
    ruleId: RULE_ID,
    ...overrides
  };
}

async function completeCapture({
  candidateCommit = CANDIDATE,
  repositoryRoot = process.cwd()
}: {
  candidateCommit?: string;
  repositoryRoot?: string;
} = {}) {
  const hosted = await script("waf-hosted-capture-lib.mjs");
  let clock = Date.parse("2026-08-01T16:00:00.000Z");
  const routeCounts = new Map<string, number>();
  const eventTimes = new Map<string, string>();
  const providerRequests: Array<{
    path: string;
    authorization: string | null;
    body: string | null;
  }> = [];
  const raw = new Map<string, Buffer>();

  const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    if (url.origin === "https://scan.sitebehavior.org" && url.pathname === "/api/health") {
      return response({
        status: "ok",
        warnings: [],
        deployment: candidateCommit
      });
    }
    if (
      url.origin === "https://api.cloudflare.com" &&
      url.pathname.endsWith(
        `/zones/${ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint`
      )
    ) {
      providerRequests.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : null
      });
      return response(rulesetResponse());
    }
    if (
      url.origin === "https://api.cloudflare.com" &&
      url.pathname === "/client/v4/graphql"
    ) {
      providerRequests.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : null
      });
      return response({
        data: {
          viewer: {
            zones: [
              {
                firewallEventsAdaptive: [
                  securityEvent({
                    rayName: GET_RAY,
                    method: "GET",
                    pathName: "/api/scan/admission",
                    datetime: eventTimes.get("get-admission")!
                  }),
                  securityEvent({
                    rayName: POST_RAY,
                    method: "POST",
                    pathName: "/api/scan",
                    datetime: eventTimes.get("post-admission")!
                  }),
                  {
                    // Unrelated provider rows can contain private fields in the
                    // raw response. They are never admitted to normalized bytes.
                    rayName: "1111111111111111",
                    clientIP: "192.0.2.1"
                  }
                ]
              }
            ]
          }
        },
        errors: null
      });
    }
    assert.equal(url.origin, "https://scan.sitebehavior.org");
    const routeId =
      method === "GET" ? "get-admission" : "post-admission";
    const count = (routeCounts.get(routeId) ?? 0) + 1;
    routeCounts.set(routeId, count);
    clock += 100;
    if (count === 11) {
      eventTimes.set(routeId, new Date(clock).toISOString());
      return new Response(null, {
        status: 429,
        headers: {
          "cf-ray": `${routeId === "get-admission" ? GET_RAY : POST_RAY}-SJC`,
          "retry-after": "10"
        }
      });
    }
    return new Response(null, { status: method === "POST" ? 400 : 200 });
  };

  const captured = await hosted.captureHostedWafEvidence({
    candidateCommit,
    zoneId: ZONE_ID,
    rulesToken: RULES_TOKEN,
    analyticsToken: ANALYTICS_TOKEN,
    fetchImpl,
    persistRaw: async (name: string, bytes: Uint8Array) => {
      assert.equal(raw.has(name), false);
      raw.set(name, Buffer.from(bytes));
    },
    now: () => new Date(clock),
    wait: async (milliseconds: number) => {
      clock += milliseconds;
    },
    eventPollAttempts: 1,
    eventPollIntervalMs: 0,
    repositoryRoot
  });
  return { captured, providerRequests, raw, hosted };
}

function testSha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function testCrc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function storedZip(entries: Array<{ name: string; bytes: Buffer }>) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = testCrc32(entry.bytes);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, entry.bytes);

    const record = Buffer.alloc(46 + name.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(entry.bytes.length, 20);
    record.writeUInt32LE(entry.bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    record.writeUInt32LE(localOffset, 42);
    name.copy(record, 46);
    central.push(record);
    localOffset += local.length + entry.bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function testGit(root: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-01T15:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-01T15:00:00Z"
    }
  }).trim();
}

function writeTestJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function wafArchiveFixture(
  manifestMutation?: (manifest: Record<string, any>) => Buffer | undefined
) {
  const wafHosted = await script("waf-hosted-capture-lib.mjs");
  const waf = await script("waf-ceiling-evidence-lib.mjs");
  const common = await script("operator-evidence-common.mjs");
  const provenance = await script("hosted-evidence-provenance-lib.mjs");
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "sbl-waf-archive-"))
  );
  for (const repositoryPath of
    wafHosted.WAF_HOSTED_PRODUCER_CLOSURE_PATHS) {
    const target = path.join(root, ...repositoryPath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      readFileSync(path.join(process.cwd(), ...repositoryPath.split("/")))
    );
  }
  testGit(root, ["init"]);
  testGit(root, ["config", "user.name", "WAF Fixture"]);
  testGit(root, ["config", "user.email", "waf-fixture@example.invalid"]);
  testGit(root, ["config", "commit.gpgsign", "false"]);
  testGit(root, ["add", "--all"]);
  testGit(root, ["commit", "-m", "fixture"]);
  const candidateCommit = testGit(root, ["rev-parse", "HEAD"]);
  const { captured } = await completeCapture({
    candidateCommit,
    repositoryRoot: root
  });
  const receiptBytes = Buffer.from(
    waf.serializeWafCeilingEvidence(captured.receipt),
    "utf8"
  );
  const manifest = structuredClone(captured.manifest);
  const replacement = manifestMutation?.(manifest);
  const manifestBytes =
    replacement ??
    Buffer.from(common.serializeCanonicalEvidence(manifest), "utf8");
  const archive = storedZip([
    { name: "receipt.json", bytes: receiptBytes },
    {
      name: "sanitized-provider-manifest.json",
      bytes: manifestBytes
    }
  ]);
  const archiveDigest = testSha256(archive);
  const runId = 401;
  const runAttempt = 1;
  const artifactId = 402;
  const artifactName =
    `site-behavior-waf-ceiling-evidence-${runId}-${runAttempt}`;
  const inputs = path.join(root, "fixture-inputs");
  mkdirSync(inputs);
  const runPath = path.join(inputs, "run.json");
  const jobsPath = path.join(inputs, "jobs.json");
  const artifactsPath = path.join(inputs, "artifacts.json");
  const metadataPath = path.join(inputs, "artifact.json");
  const archivePath = path.join(inputs, "artifact.zip");
  const subjectPath = path.join(inputs, "subject.json");
  writeTestJson(runPath, {
    id: runId,
    run_attempt: runAttempt,
    repository: { full_name: "iAnonymous3000/site-behavior-lab" },
    path: ".github/workflows/waf-ceiling-evidence.yml",
    head_branch: "main",
    head_sha: candidateCommit,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    run_started_at: "2026-08-01T15:59:00Z",
    updated_at: "2026-08-01T16:01:00Z"
  });
  writeTestJson(jobsPath, {
    total_count: 1,
    jobs: [
      {
        id: 403,
        name: "Capture sanitized WAF ceiling evidence",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-01T15:59:00Z",
        completed_at: "2026-08-01T16:01:00Z"
      }
    ]
  });
  const artifact = {
    id: artifactId,
    name: artifactName,
    digest: `sha256:${archiveDigest}`,
    expired: false,
    size_in_bytes: archive.length,
    workflow_run: { id: runId, head_sha: candidateCommit }
  };
  writeTestJson(artifactsPath, {
    total_count: 1,
    artifacts: [artifact]
  });
  writeTestJson(metadataPath, artifact);
  writeFileSync(archivePath, archive, { mode: 0o600 });
  writeFileSync(subjectPath, receiptBytes, { mode: 0o600 });
  const subjectSha256 = testSha256(receiptBytes);
  const relative = provenance.hostedEvidenceArchiveRelativePath(
    "waf-ceilings",
    subjectSha256
  );
  const outputDirectory = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(outputDirectory), { recursive: true });
  return {
    root,
    outputDirectory,
    candidateCommit,
    subjectSha256,
    provenance,
    create: () =>
      provenance.createHostedEvidenceDirectory({
        profile: "waf-ceilings",
        recordedAt: "2026-08-01T16:01:00.000Z",
        archiver: {
          runId: 404,
          runAttempt: 1,
          sourceCommit: candidateCommit,
          runnerEnvironment: "github-hosted"
        },
        subject: {
          repositoryPath: "research/ops-evidence/waf-ceilings.json",
          commit: candidateCommit,
          filePath: subjectPath
        },
        sources: [
          {
            role: "provider-capture",
            workflowPath:
              ".github/workflows/waf-ceiling-evidence.yml",
            runId,
            runAttempt,
            headSha: candidateCommit,
            runPath,
            jobsPagePaths: [jobsPath],
            artifactsPagePaths: [artifactsPath],
            artifact: {
              id: artifactId,
              name: artifactName,
              sha256: archiveDigest,
              members: [
                "receipt.json",
                "sanitized-provider-manifest.json"
              ]
            },
            artifactMetadataPath: metadataPath,
            artifactArchivePath: archivePath
          }
        ],
        outputDirectory,
        repositoryRoot: root
      })
  };
}

test("ruleset selection resolves the human ref to immutable API rule identity", async () => {
  const hosted = await script("waf-hosted-capture-lib.mjs");
  const policy = hosted.selectCloudflareWafRule(rulesetResponse());
  assert.equal(policy.ruleId, RULE_ID);
  assert.equal(policy.ruleVersion, "7");
  assert.notEqual(policy.ruleId, "scan-api-rate-limit");
  assert.equal(
    hosted.selectCloudflareWafRule(
      rulesetResponse([
        rulesetRule({
          ratelimit: {
            requests_per_period: 10,
            period: 10,
            mitigation_timeout: 10,
            characteristics: ["cf.colo.id", "ip.src"],
            counting_expression: "",
            requests_to_origin: false
          }
        })
      ])
    ).ruleId,
    RULE_ID
  );
  assert.deepEqual(policy.routes, [
    { id: "get-admission", method: "GET", path: "/api/scan/admission" },
    { id: "post-admission", method: "POST", path: "/api/scan" }
  ]);
});

test("ruleset selection fails closed on missing, ambiguous, or weakened policy", async () => {
  const hosted = await script("waf-hosted-capture-lib.mjs");
  assert.throws(
    () => hosted.selectCloudflareWafRule(rulesetResponse([])),
    /exactly one rule with ref/
  );
  assert.throws(
    () =>
      hosted.selectCloudflareWafRule({
        ...rulesetResponse(),
        errors: [{ code: 1000, message: "provider refused the read" }]
      }),
    /rulesets response contains errors/
  );
  assert.throws(
    () =>
      hosted.selectCloudflareWafRule(
        rulesetResponse([rulesetRule(), rulesetRule({ id: "e".repeat(32) })])
      ),
    /exactly one rule with ref/
  );
  for (const [overrides, message] of [
    [{ enabled: false }, /must be enabled/],
    [{ action: "challenge" }, /action must be block/],
    [{ expression: 'http.request.uri.path eq "/api/scan"' }, /exact GET and POST/],
    [
      {
        ratelimit: {
          requests_per_period: 11,
          period: 10,
          mitigation_timeout: 10,
          characteristics: ["cf.colo.id", "ip.src"]
        }
      },
      /requests_per_period must be exactly 10/
    ],
    [
      {
        ratelimit: {
          requests_per_period: 10,
          period: 10,
          mitigation_timeout: 10,
          characteristics: ["ip.src"]
        }
      },
      /characteristics must be exactly/
    ],
    [
      {
        ratelimit: {
          requests_per_period: 10,
          period: 10,
          mitigation_timeout: 10,
          characteristics: ["cf.colo.id", "ip.src"],
          counting_expression: 'http.request.uri.path eq "/api/scan"'
        }
      },
      /counting_expression must be absent, empty, or equal/
    ],
    [
      {
        ratelimit: {
          requests_per_period: 10,
          period: 10,
          mitigation_timeout: 10,
          characteristics: ["cf.colo.id", "ip.src"],
          requests_to_origin: true
        }
      },
      /requests_to_origin must be absent or false/
    ],
    [
      {
        ratelimit: {
          requests_per_period: 10,
          period: 10,
          mitigation_timeout: 10,
          characteristics: ["cf.colo.id", "ip.src"],
          score_per_period: 10
        }
      },
      /must not use score-based/
    ]
  ] as Array<[Record<string, unknown>, RegExp]>) {
    assert.throws(
      () =>
        hosted.selectCloudflareWafRule(
          rulesetResponse([rulesetRule(overrides)])
        ),
      message
    );
  }
});

test("Security Events normalization fails on pagination, ambiguity, and mismatches", async () => {
  const hosted = await script("waf-hosted-capture-lib.mjs");
  const policy = hosted.selectCloudflareWafRule(rulesetResponse());
  const event = securityEvent({
    rayName: GET_RAY,
    method: "GET",
    pathName: "/api/scan/admission",
    datetime: "2026-08-01T16:00:01.000Z"
  });
  const graph = (events: unknown[], zones = 1) => ({
    data: {
      viewer: {
        zones: Array.from({ length: zones }, () => ({
          firewallEventsAdaptive: events
        }))
      }
    }
  });
  assert.deepEqual(
    hosted.normalizeCloudflareSecurityEvents({
      rawValue: graph([]),
      rulePolicy: policy,
      expectedRayIds: [GET_RAY, POST_RAY]
    }),
    { complete: false, events: [] }
  );
  assert.throws(
    () =>
      hosted.normalizeCloudflareSecurityEvents({
        rawValue: graph(
          Array.from(
            { length: hosted.WAF_HOSTED_GRAPHQL_LIMIT },
            () => ({ rayName: "1111111111111111" })
          )
        ),
        rulePolicy: policy,
        expectedRayIds: [GET_RAY, POST_RAY]
      }),
    /pagination is ambiguous/
  );
  assert.throws(
    () =>
      hosted.normalizeCloudflareSecurityEvents({
        rawValue: graph([], 2),
        rulePolicy: policy,
        expectedRayIds: [GET_RAY, POST_RAY]
      }),
    /exactly one selected zone/
  );
  assert.throws(
    () =>
      hosted.normalizeCloudflareSecurityEvents({
        rawValue: graph([event, { ...event }]),
        rulePolicy: policy,
        expectedRayIds: [GET_RAY, POST_RAY]
      }),
    /ambiguous duplicate/
  );
  assert.throws(
    () =>
      hosted.normalizeCloudflareSecurityEvents({
        rawValue: graph([{ ...event, ruleId: "d".repeat(32) }]),
        rulePolicy: policy,
        expectedRayIds: [GET_RAY, POST_RAY]
      }),
    /immutable selected WAF rule id/
  );
  assert.throws(
    () =>
      hosted.normalizeCloudflareSecurityEvents({
        rawValue: graph([{ ...event, clientIP: "192.0.2.1" }]),
        rulePolicy: policy,
        expectedRayIds: [GET_RAY, POST_RAY]
      }),
    /must contain exactly/
  );
});

test("Security Events timestamp precision must overlap the exact probe window", async () => {
  const hosted = await script("waf-hosted-capture-lib.mjs");
  const policy = hosted.selectCloudflareWafRule(rulesetResponse());
  const event = securityEvent({
    rayName: GET_RAY,
    method: "GET",
    pathName: "/api/scan/admission",
    datetime: "2026-08-01T16:00:01Z"
  });
  const rawValue = {
    data: {
      viewer: {
        zones: [{ firewallEventsAdaptive: [event] }]
      }
    }
  };
  const normalized = hosted.normalizeCloudflareSecurityEvents({
    rawValue,
    rulePolicy: policy,
    expectedRayIds: [GET_RAY, POST_RAY],
    probeWindows: [
      {
        startedAt: "2026-08-01T16:00:01.250Z",
        completedAt: "2026-08-01T16:00:01.500Z"
      },
      {
        startedAt: "2026-08-01T16:00:20.000Z",
        completedAt: "2026-08-01T16:00:20.500Z"
      }
    ]
  });
  assert.equal(normalized.complete, false);
  assert.equal(normalized.events[0].timestamp, "2026-08-01T16:00:01.250Z");
  assert.throws(
    () =>
      hosted.normalizeCloudflareSecurityEvents({
        rawValue,
        rulePolicy: policy,
        expectedRayIds: [GET_RAY, POST_RAY],
        probeWindows: [
          {
            startedAt: "2026-08-01T16:00:02.000Z",
            completedAt: "2026-08-01T16:00:02.100Z"
          },
          {
            startedAt: "2026-08-01T16:00:20.000Z",
            completedAt: "2026-08-01T16:00:20.500Z"
          }
        ]
      }),
    /does not overlap its exact probe window/
  );
  assert.throws(
    () =>
      hosted.normalizeCloudflareSecurityEvents({
        rawValue,
        rulePolicy: policy,
        expectedRayIds: [GET_RAY, POST_RAY],
        probeWindows: {}
      }),
    /must contain the exact two route windows/
  );
});

test("provider rate limits and GraphQL errors fail closed without leaking tokens", async () => {
  const hosted = await script("waf-hosted-capture-lib.mjs");
  let requests = 0;
  await assert.rejects(
    hosted.captureHostedWafEvidence({
      candidateCommit: CANDIDATE,
      zoneId: ZONE_ID,
      rulesToken: RULES_TOKEN,
      analyticsToken: ANALYTICS_TOKEN,
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) {
          return response({
            status: "ok",
            warnings: [],
            deployment: CANDIDATE
          });
        }
        return response({ success: false }, 429);
      },
      persistRaw: async () => {
        assert.fail("rate-limited provider bytes must not be treated as evidence");
      }
    }),
    (error: unknown) => {
      assert.match(String(error), /returned HTTP 429/);
      assert.equal(String(error).includes(RULES_TOKEN), false);
      assert.equal(String(error).includes(ANALYTICS_TOKEN), false);
      return true;
    }
  );
  const policy = hosted.selectCloudflareWafRule(rulesetResponse());
  assert.throws(
    () =>
      hosted.normalizeCloudflareSecurityEvents({
        rawValue: {
          data: null,
          errors: [{ message: "rate limited" }]
        },
        rulePolicy: policy,
        expectedRayIds: [GET_RAY, POST_RAY]
      }),
    /contains errors/
  );
});

test("hosted environment requires distinct scoped secrets and GitHub-hosted provenance", async () => {
  const hosted = await script("waf-hosted-capture-lib.mjs");
  const valid = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_SHA: CANDIDATE,
    WAF_RULES_API_TOKEN: RULES_TOKEN,
    WAF_ANALYTICS_API_TOKEN: ANALYTICS_TOKEN,
    CLOUDFLARE_ZONE_ID: ZONE_ID
  };
  assert.deepEqual(hosted.requiredHostedWafEnvironment(valid), {
    githubSha: CANDIDATE,
    rulesToken: RULES_TOKEN,
    analyticsToken: ANALYTICS_TOKEN,
    zoneId: ZONE_ID
  });
  for (const name of [
    "WAF_RULES_API_TOKEN",
    "WAF_ANALYTICS_API_TOKEN",
    "CLOUDFLARE_ZONE_ID"
  ]) {
    assert.throws(
      () =>
        hosted.requiredHostedWafEnvironment({
          ...valid,
          [name]: ""
        }),
      new RegExp(`${name} is required`)
    );
  }
  assert.throws(
    () =>
      hosted.requiredHostedWafEnvironment({
        ...valid,
        WAF_ANALYTICS_API_TOKEN: RULES_TOKEN
      }),
    /must be distinct/
  );
  assert.throws(
    () =>
      hosted.requiredHostedWafEnvironment({
        ...valid,
        RUNNER_ENVIRONMENT: "self-hosted"
      }),
    /GitHub-hosted runner/
  );
});

test("complete capture keeps tokens, zone id, and raw Ray IDs out of safe bytes", async () => {
  const { captured, providerRequests, raw, hosted } = await completeCapture();
  assert.equal(captured.receipt.candidateCommit, CANDIDATE);
  assert.equal(captured.receipt.deploymentCommit, CANDIDATE);
  assert.equal(captured.receipt.rulePolicy.ruleId, RULE_ID);
  assert.equal(captured.manifest.ruleSelector.ref, "scan-api-rate-limit");
  assert.deepEqual(
    captured.manifest.producerClosure.files.map(
      (entry: { path: string }) => entry.path
    ),
    hosted.WAF_HOSTED_PRODUCER_CLOSURE_PATHS
  );
  assert.equal(
    captured.manifest.producerClosure.files.every(
      (entry: { sha256: string }) => /^[0-9a-f]{64}$/.test(entry.sha256)
    ),
    true
  );
  assert.deepEqual([...raw.keys()], [
    "rulesets-phase-entrypoint.json",
    "security-events-01.json"
  ]);
  assert.deepEqual(
    providerRequests.map(({ authorization }) => authorization),
    [`Bearer ${RULES_TOKEN}`, `Bearer ${ANALYTICS_TOKEN}`]
  );
  assert.equal(providerRequests[0].body, null);
  assert.match(providerRequests[1].body!, /firewallEventsAdaptive/);
  const safeBytes = JSON.stringify(captured);
  for (const forbidden of [
    RULES_TOKEN,
    ANALYTICS_TOKEN,
    ZONE_ID,
    GET_RAY,
    POST_RAY,
    "192.0.2.1",
    "clientIP"
  ]) {
    assert.equal(safeBytes.includes(forbidden), false, forbidden);
  }
  assert.equal(
    hosted.WAF_HOSTED_SECURITY_EVENTS_QUERY.includes("clientIP"),
    false
  );
});

test("safe directory verification rejects extra files and symbolic links", async () => {
  const { captured, hosted } = await completeCapture();
  const waf = await script("waf-ceiling-evidence-lib.mjs");
  const common = await script("operator-evidence-common.mjs");
  const directory = mkdtempSync(path.join(os.tmpdir(), "sbl-waf-safe-"));
  try {
    writeFileSync(
      path.join(directory, "receipt.json"),
      waf.serializeWafCeilingEvidence(captured.receipt)
    );
    writeFileSync(
      path.join(directory, "sanitized-provider-manifest.json"),
      common.serializeCanonicalEvidence(captured.manifest)
    );
    assert.equal(hosted.verifyWafHostedSafeDirectory(directory).ok, true);
    writeFileSync(path.join(directory, "raw-provider.json"), "{}\n");
    assert.throws(
      () => hosted.verifyWafHostedSafeDirectory(directory),
      /must contain only/
    );
    rmSync(path.join(directory, "raw-provider.json"));
    rmSync(path.join(directory, "sanitized-provider-manifest.json"));
    symlinkSync(
      path.join(directory, "receipt.json"),
      path.join(directory, "sanitized-provider-manifest.json")
    );
    assert.throws(
      () => hosted.verifyWafHostedSafeDirectory(directory),
      /must contain only/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("WAF workflow is GitHub-hosted, least-privilege, pinned, and uploads only safe files", () => {
  const workflow = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "waf-ceiling-evidence.yml"),
    "utf8"
  );
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /environment: release-evidence/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/
  );
  assert.match(
    workflow,
    /actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444/
  );
  assert.match(
    workflow,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/
  );
  assert.match(workflow, /node-version: 24\.14\.1/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(
    workflow,
    /node node_modules\/typescript\/bin\/tsc -p tsconfig\.schema\.json/
  );
  assert.match(
    workflow,
    /WAF_RULES_API_TOKEN: \$\{\{ secrets\.WAF_RULES_API_TOKEN \}\}/
  );
  assert.match(
    workflow,
    /WAF_ANALYTICS_API_TOKEN: \$\{\{ secrets\.WAF_ANALYTICS_API_TOKEN \}\}/
  );
  assert.match(
    workflow,
    /CLOUDFLARE_ZONE_ID: \$\{\{ vars\.CLOUDFLARE_ZONE_ID \|\| '' \}\}/
  );
  assert.match(workflow, /test ! -e "\$RUNNER_TEMP\/waf-ceiling-private"/);
  const uploadPaths = workflow.match(
    /path: \|([\s\S]*?)\n\s+if-no-files-found:/
  )?.[1];
  assert.ok(uploadPaths);
  assert.match(uploadPaths, /waf-ceiling-safe\/receipt\.json/);
  assert.match(
    uploadPaths,
    /waf-ceiling-safe\/sanitized-provider-manifest\.json/
  );
  assert.doesNotMatch(uploadPaths, /private|rulesets|security-events/);
});

test("hosted archive profile pins the WAF workflow and exact safe artifact members", async () => {
  const hostedEvidence = await script("hosted-evidence-provenance-lib.mjs");
  const contract = hostedEvidence.hostedEvidenceCollectionContract(
    "waf-ceilings"
  );
  assert.deepEqual(contract.exactRoles, ["provider-capture"]);
  assert.deepEqual(contract.sources["provider-capture"].workflows, [
    ".github/workflows/waf-ceiling-evidence.yml"
  ]);
  assert.deepEqual(
    contract.sources["provider-capture"].requiredArtifactMembers,
    ["receipt.json", "sanitized-provider-manifest.json"]
  );
  const archiveWorkflow = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "archive-hosted-evidence.yml"),
    "utf8"
  );
  assert.match(archiveWorkflow, /\n\s+- waf-ceilings\n/);
  assert.match(
    archiveWorkflow,
    /if: inputs\.profile == 'waf-ceilings'[\s\S]*tsconfig\.schema\.json/
  );
});

test("hosted WAF archive executes semantic validation with exact producer closure", async () => {
  const fixture = await wafArchiveFixture();
  try {
    const created = fixture.create();
    writeFileSync(
      path.join(
        fixture.outputDirectory,
        fixture.provenance.HOSTED_EVIDENCE_BUNDLE_FILE
      ),
      '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}\n'
    );
    const verified = fixture.provenance.verifyHostedEvidenceDirectory({
      rootDir: fixture.root,
      directory: fixture.outputDirectory,
      expectedProfile: "waf-ceilings",
      expectedSubjectPath:
        "research/ops-evidence/waf-ceilings.json",
      expectedSubjectSha256: created.subjectSha256,
      expectedSubjectCommit: fixture.candidateCommit,
      expectedArchiverCommit: fixture.candidateCommit,
      attestationVerifier: () => ({
        status: "verified-by-gh-attestation"
      })
    });
    assert.equal(verified.ok, true, verified.issues.join("; "));
    assert.deepEqual(
      verified.subject.candidateCommit,
      fixture.candidateCommit
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hosted WAF archive rejects noncanonical, malformed, or stale producer manifests", async () => {
  const cases: Array<{
    mutate: (manifest: Record<string, any>) => Buffer | undefined;
    message: RegExp;
  }> = [
    {
      mutate: (manifest) =>
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      message: /manifest bytes are not canonical/
    },
    {
      mutate: (manifest) => {
        delete manifest.producerClosure;
        return undefined;
      },
      message: /not rederived by the exact candidate/
    },
    {
      mutate: (manifest) => {
        manifest.producerClosure.files[0].sha256 = "0".repeat(64);
        return undefined;
      },
      message: /not rederived by the exact candidate/
    }
  ];
  for (const entry of cases) {
    const fixture = await wafArchiveFixture(entry.mutate);
    try {
      assert.throws(() => fixture.create(), entry.message);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("operator docs distinguish the human rule ref from immutable API identity", () => {
  const operator = readFileSync(
    path.join(process.cwd(), "docs", "operator-evidence-capture.md"),
    "utf8"
  );
  assert.match(
    operator,
    /human-authored ref `scan-api-rate-limit`[\s\S]*immutable \*\*rule API `id` and `version`\*\*/
  );
  assert.match(
    operator,
    /"ruleId": "<immutable-cloudflare-rule-api-id>"/
  );
  assert.doesNotMatch(operator, /"ruleId": "scan-api-rate-limit"/);
  assert.match(
    operator,
    /WAF_RULES_API_TOKEN[\s\S]*WAF_ANALYTICS_API_TOKEN[\s\S]*CLOUDFLARE_ZONE_ID/
  );
});

test("readiness accepts only the exact hosted receipt member and candidate deployment source", async () => {
  const readiness = await script("release-readiness-lib.mjs");
  const digest = "d".repeat(64);
  const source = {
    headSha: CANDIDATE,
    artifact: {
      members: [{ path: "receipt.json", sha256: digest }]
    }
  };
  assert.deepEqual(
    readiness.hostedWafCaptureBindingProblems(
      source,
      {
        candidateCommit: CANDIDATE,
        deploymentCommit: CANDIDATE
      },
      digest
    ),
    []
  );
  assert.match(
    readiness
      .hostedWafCaptureBindingProblems(
        {
          ...source,
          artifact: {
            members: [{ path: "receipt.json", sha256: "e".repeat(64) }]
          }
        },
        {
          candidateCommit: CANDIDATE,
          deploymentCommit: CANDIDATE
        },
        digest
      )
      .join("; "),
    /exact canonical WAF receipt/
  );
  assert.match(
    readiness
      .hostedWafCaptureBindingProblems(
        source,
        {
          candidateCommit: "f".repeat(40),
          deploymentCommit: CANDIDATE
        },
        digest
      )
      .join("; "),
    /exact candidate and deployment/
  );
  assert.equal(
    readiness.trustedProviderCapturePreflightIssue("waf-ceilings"),
    null
  );
  assert.match(
    readiness.trustedProviderCapturePreflightIssue("egress-backstop"),
    /unavailable/
  );
  assert.match(
    readiness.trustedProviderCapturePreflightIssue("log-retention"),
    /unavailable/
  );
});
