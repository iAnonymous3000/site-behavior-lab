import { execFileSync as nodeExecFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import {
  DURABLE_SOAK_LEDGER_FILE,
  DURABLE_SOAK_SOURCE_DIGESTS_FILE,
  durableSoakAggregateMemberNameAllowed,
  verifyDurableSoakLedgerMembers
} from "./durable-soak-ledger-lib.mjs";
import {
  verifyDurableRestartEvidenceSet
} from "./durable-soak-restart-evidence-lib.mjs";
import {
  DURABLE_SOAK_EXERCISE_FILE,
  DURABLE_SOAK_EXERCISE_HEALTH_FILE,
  DURABLE_SOAK_EXERCISE_POST_HEALTH_FILE,
  parseDurableSoakExerciseEvidence,
  verifyDurableSoakExerciseEvidence
} from "./durable-soak-exercise-evidence-lib.mjs";
import {
  buildWafHostedProducerClosure,
  buildWafHostedSanitizedManifest
} from "./waf-hosted-capture-lib.mjs";
import {
  buildStagingTeardownHostedManifest,
  buildStagingTeardownHostedProducerClosure,
  STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS
} from "./staging-teardown-hosted-capture-lib.mjs";
import {
  serializeWafCeilingEvidence,
  validateWafCeilingEvidence
} from "./waf-ceiling-evidence-lib.mjs";

export const HOSTED_EVIDENCE_CONTEXT_KIND =
  "site-behavior-hosted-evidence-context";
export const HOSTED_EVIDENCE_CONTEXT_VERSION = 1;
export const HOSTED_EVIDENCE_CONTEXT_FILE = "context.json";
export const HOSTED_EVIDENCE_BUNDLE_FILE = "context.sigstore.json";
export const HOSTED_EVIDENCE_SUBJECT_FILE = "subject.json";
export const HOSTED_EVIDENCE_REPOSITORY =
  "iAnonymous3000/site-behavior-lab";
export const HOSTED_EVIDENCE_ARCHIVER_WORKFLOW_PATH =
  ".github/workflows/archive-hosted-evidence.yml";
export const HOSTED_EVIDENCE_ARCHIVER_WORKFLOW =
  `${HOSTED_EVIDENCE_REPOSITORY}/${HOSTED_EVIDENCE_ARCHIVER_WORKFLOW_PATH}@refs/heads/main`;
export const HOSTED_EVIDENCE_ROOT = "research/hosted-evidence";
export const HOSTED_EVIDENCE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const HOSTED_EVIDENCE_MAX_ARCHIVE_BYTES = 56 * 1024 * 1024;

const MAX_SUBJECT_BYTES = 8 * 1024 * 1024;
const MAX_API_JSON_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_MEMBER_BYTES = 8 * 1024 * 1024;
const MAX_MEMBERS = 16;
const MAX_SOURCES = 8;
const MAX_PAGES = 10;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REPOSITORY_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*\/\/)[A-Za-z0-9._/-]{1,500}$/;
const CANONICAL_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACTIONS_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ARCHIVE_DIGEST_PREFIX = /^sha256:/;
const CONTEXT_DIGEST_DOMAIN =
  "site-behavior-hosted-evidence-context-v1\u0000";
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_ALLOWED_FLAGS = (1 << 3) | (1 << 11);
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_DIRECTORY_ATTRIBUTE = 0x10;
const ZIP_UNIX_HOST = 3;
const ZIP_UNIX_FILE_TYPE_MASK = 0xf000;
const ZIP_UNIX_REGULAR_FILE = 0x8000;

const PROFILE_RULES = Object.freeze({
  "controlled-publication": Object.freeze({
    exactRoles: Object.freeze(["publisher"]),
    sources: Object.freeze({
      publisher: Object.freeze({
        workflows: Object.freeze([".github/workflows/scan-featured.yml"]),
        events: Object.freeze(["schedule", "workflow_dispatch"]),
        requiredJobNames: Object.freeze([
          "Validate and Publish Featured Reports"
        ]),
        artifactRequired: true,
        archivePolicy: "exact",
        requiredArtifactMembers: Object.freeze([
          "publication.json",
          "receipt.json"
        ]),
        artifactName: ({ runId, runAttempt }) =>
          `site-behavior-controlled-publication-evidence-${runId}-${runAttempt}`
      })
    })
  }),
  "runner-destruction": Object.freeze({
    exactRoles: Object.freeze(["collection", "destruction"]),
    sources: Object.freeze({
      collection: Object.freeze({
        workflows: Object.freeze([".github/workflows/scan-featured.yml"]),
        events: Object.freeze(["schedule", "workflow_dispatch"]),
        requiredJobNames: Object.freeze(["Populate Featured Gallery"]),
        publicSafeControlledRunner: true,
        artifactRequired: true,
        archivePolicy: "featured-publication",
        requiredArtifactMembers: Object.freeze(["publication.json"]),
        artifactName: ({ runId, runAttempt }) =>
          `site-behavior-featured-publication-${runId}-${runAttempt}`
      }),
      destruction: Object.freeze({
        workflows: Object.freeze([
          ".github/workflows/runner-destruction-evidence.yml"
        ]),
        events: Object.freeze(["workflow_dispatch"]),
        requiredJobNames: Object.freeze([
          "Read back provider destruction and absence"
        ]),
        artifactRequired: true,
        archivePolicy: "exact",
        requiredArtifactMembers: Object.freeze([
          "destruction-evidence.json"
        ]),
        artifactName: ({ runId, runAttempt }) =>
          `site-behavior-runner-destruction-evidence-${runId}-${runAttempt}`
      })
    })
  }),
  "durable-transition": Object.freeze({
    exactRoles: Object.freeze(["ci", "promotion", "production-health"]),
    sources: Object.freeze({
      ci: Object.freeze({
        workflows: Object.freeze([".github/workflows/ci.yml"]),
        events: Object.freeze(["push", "workflow_dispatch"]),
        requiredJobNames: Object.freeze([
          "Attest exact-SHA evidence manifests"
        ]),
        artifactRequired: true,
        archivePolicy: "exact",
        requiredArtifactMembers: Object.freeze([
          "attestation-results.json",
          "container-evidence-manifest.bundle.json",
          "container-package-inventory.bundle.json",
          "static-evidence-manifest.bundle.json"
        ]),
        artifactName: ({ headSha }) =>
          `exact-sha-provenance-attestations-${headSha}`
      }),
      promotion: Object.freeze({
        workflows: Object.freeze([
          ".github/workflows/promote-production.yml",
          ".github/workflows/ci.yml"
        ]),
        trustedSourcePaths: Object.freeze([
          ".github/required-ci-jobs.json",
          "scripts/verify-required-ci-jobs.mjs"
        ]),
        eventsByWorkflow: Object.freeze({
          ".github/workflows/promote-production.yml": Object.freeze([
            "workflow_run"
          ]),
          ".github/workflows/ci.yml": Object.freeze([
            "push",
            "workflow_dispatch"
          ])
        }),
        requiredJobNames: Object.freeze([
          "Advance production to the tested SHA"
        ]),
        artifactRequired: false,
        archivePolicy: null,
        requiredArtifactMembers: Object.freeze([]),
        artifactName: null
      }),
      "production-health": productionHealthRule()
    })
  }),
  "durable-soak": Object.freeze({
    exactRoles: Object.freeze(["monitor", "restart", "exercises"]),
    sources: Object.freeze({
      monitor: Object.freeze({
        workflows: Object.freeze([
          ".github/workflows/durable-soak-monitor.yml"
        ]),
        trustedSourcePaths: Object.freeze([
          "lib/strict-json.ts",
          "scripts/archive-hosted-evidence.mjs",
          "scripts/durable-soak-exercise-evidence-lib.mjs",
          "scripts/durable-soak-ledger-lib.mjs",
          "scripts/durable-soak-ledger.mjs",
          "scripts/durable-soak-restart-evidence-lib.mjs",
          "scripts/hosted-evidence-provenance-lib.mjs",
          "scripts/operator-evidence-common.mjs",
          "scripts/staging-teardown-evidence-lib.mjs",
          "scripts/staging-teardown-hosted-capture-lib.mjs",
          "scripts/waf-ceiling-evidence-lib.mjs",
          "scripts/waf-hosted-capture-lib.mjs"
        ]),
        events: Object.freeze(["workflow_dispatch"]),
        requiredJobNames: Object.freeze([
          "Aggregate authenticated hourly durable health"
        ]),
        artifactRequired: true,
        archivePolicy: "durable-soak-ledger",
        requiredArtifactMembers: Object.freeze([
          DURABLE_SOAK_LEDGER_FILE,
          DURABLE_SOAK_SOURCE_DIGESTS_FILE
        ]),
        artifactName: ({ runId, runAttempt }) =>
          `site-behavior-durable-soak-ledger-${runId}-${runAttempt}`
      }),
      restart: Object.freeze({
        workflows: Object.freeze([
          ".github/workflows/durable-soak-restart.yml"
        ]),
        trustedSourcePaths: Object.freeze([
          "package-lock.json",
          "package.json",
          "tsconfig.json",
          "tsconfig.schema.json",
          "lib/canonical-json.ts",
          "lib/durable-restart-control-auth.ts",
          "lib/sha256.ts",
          "lib/strict-json.ts",
          "scripts/build-schema.mjs",
          "scripts/durable-soak-restart-evidence-lib.mjs",
          "scripts/durable-soak-restart-evidence.mjs",
          "scripts/http-response.mjs",
          "scripts/operator-evidence-common.mjs",
          "scripts/scan-admission.mjs"
        ]),
        events: Object.freeze(["workflow_dispatch"]),
        requiredJobNames: Object.freeze([
          "Restart runtime and prove queued work recovery"
        ]),
        artifactRequired: true,
        archivePolicy: "exact",
        requiredArtifactMembers: Object.freeze([
          "post-health.json",
          "pre-health.json",
          "queued-work-recovery.json",
          "restart-evidence.json"
        ]),
        artifactName: ({ runId, runAttempt }) =>
          `site-behavior-durable-soak-restart-evidence-${runId}-${runAttempt}`
      }),
      exercises: Object.freeze({
        workflows: Object.freeze([
          ".github/workflows/durable-soak-exercises.yml"
        ]),
        trustedSourcePaths: Object.freeze([
          "package-lock.json",
          "package.json",
          "tsconfig.json",
          "tsconfig.schema.json",
          "lib/canonical-json.ts",
          "lib/sha256.ts",
          "lib/strict-json.ts",
          "scripts/build-schema.mjs",
          "scripts/durable-soak-exercise-evidence-lib.mjs",
          "scripts/durable-soak-exercise-evidence.mjs",
          "scripts/http-response.mjs",
          "scripts/operator-evidence-common.mjs",
          "scripts/scan-admission.mjs",
          "scripts/smoke-deployed-scanner-report.mjs"
        ]),
        events: Object.freeze(["workflow_dispatch"]),
        requiredJobNames: Object.freeze([
          "Exercise durable completion, cancellation, and recovery"
        ]),
        artifactRequired: true,
        archivePolicy: "exact",
        requiredArtifactMembers: Object.freeze([
          DURABLE_SOAK_EXERCISE_FILE,
          DURABLE_SOAK_EXERCISE_POST_HEALTH_FILE,
          DURABLE_SOAK_EXERCISE_HEALTH_FILE
        ]),
        artifactName: ({ runId, runAttempt }) =>
          `site-behavior-durable-soak-exercises-${runId}-${runAttempt}`
      })
    })
  }),
  lifecycle: Object.freeze({
    exactRoles: Object.freeze(["readback", "production-health"]),
    sources: Object.freeze({
      readback: Object.freeze({
        workflows: Object.freeze([
          ".github/workflows/r2-lifecycle-evidence.yml"
        ]),
        events: Object.freeze(["workflow_dispatch"]),
        requiredJobNames: Object.freeze([
          "Read back production R2 lifecycle"
        ]),
        artifactRequired: true,
        archivePolicy: "exact",
        requiredArtifactMembers: Object.freeze(["receipt.json"]),
        artifactName: ({ runId, runAttempt }) =>
          `site-behavior-r2-lifecycle-evidence-${runId}-${runAttempt}`
      }),
      "production-health": productionHealthRule()
    })
  }),
  "staging-teardown": Object.freeze({
    exactRoles: Object.freeze(["provider-capture"]),
    sources: Object.freeze({
      "provider-capture": Object.freeze({
        workflows: Object.freeze([
          ".github/workflows/staging-teardown-evidence.yml"
        ]),
        trustedSourcePaths: Object.freeze(
          STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS.filter(
            (repositoryPath) =>
              repositoryPath !==
              ".github/workflows/staging-teardown-evidence.yml"
          )
        ),
        events: Object.freeze(["workflow_dispatch"]),
        requiredJobNames: Object.freeze([
          "Capture sanitized staging teardown evidence"
        ]),
        artifactRequired: true,
        archivePolicy: "exact",
        requiredArtifactMembers: Object.freeze([
          "receipt.json",
          "sanitized-provider-manifest.json"
        ]),
        artifactName: ({ runId, runAttempt }) =>
          `site-behavior-staging-teardown-evidence-${runId}-${runAttempt}`
      })
    })
  }),
  "waf-ceilings": Object.freeze({
    exactRoles: Object.freeze(["provider-capture"]),
    sources: Object.freeze({
      "provider-capture": Object.freeze({
        workflows: Object.freeze([
          ".github/workflows/waf-ceiling-evidence.yml"
        ]),
        events: Object.freeze(["workflow_dispatch"]),
        requiredJobNames: Object.freeze([
          "Capture sanitized WAF ceiling evidence"
        ]),
        artifactRequired: true,
        archivePolicy: "exact",
        requiredArtifactMembers: Object.freeze([
          "receipt.json",
          "sanitized-provider-manifest.json"
        ]),
        artifactName: ({ runId, runAttempt }) =>
          `site-behavior-waf-ceiling-evidence-${runId}-${runAttempt}`
      })
    })
  })
});

function productionHealthRule() {
  return Object.freeze({
    workflows: Object.freeze([
      ".github/workflows/production-health.yml"
    ]),
    trustedSourcePaths: Object.freeze([
      "lib/strict-json.ts",
      "package.json",
      "scripts/http-response.mjs",
      "scripts/scan-admission.mjs",
      "scripts/smoke-deployed-scanner-report.mjs",
      "scripts/smoke-production-r2-delete.mjs",
      "scripts/smoke-production-synthetic.mjs"
    ]),
    events: Object.freeze([
      "schedule",
      "workflow_dispatch",
      "repository_dispatch"
    ]),
    requiredJobNames: Object.freeze([
      "Verify scanner health and posture"
    ]),
    requiredStepNames: Object.freeze([
      "Validate availability and production posture",
      "Preserve exact production-health evidence",
      "Run production scan, R2 readback, and report-page synthetic",
      "Run isolated production R2 write/read/delete canary"
    ]),
    artifactRequired: true,
    archivePolicy: "exact",
    requiredArtifactMembers: productionHealthMembers(),
    artifactName: ({ runId, runAttempt }) =>
      `site-behavior-production-health-evidence-${runId}-${runAttempt}`
  });
}

function productionHealthMembers() {
  return Object.freeze([
    "production-health.json",
    "production-pages-deployment.json",
    "production-public-ingress.json",
    "production-scan-report-schema.json"
  ]);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed =
    typeof value === "string" && /^[1-9][0-9]*$/.test(value)
      ? Number(value)
      : value;
  requireValue(
    Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum,
    `${label} must be a positive safe integer`
  );
  return parsed;
}

function canonicalInstant(value, label) {
  requireValue(
    typeof value === "string" &&
      CANONICAL_INSTANT.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(value)).toISOString() === value,
    `${label} must be a canonical UTC instant`
  );
  return value;
}

function actionsInstant(value, label) {
  requireValue(
    typeof value === "string" &&
      ACTIONS_INSTANT.test(value) &&
      Number.isFinite(Date.parse(value)),
    `${label} must be a GitHub Actions UTC instant`
  );
  return new Date(Date.parse(value)).toISOString();
}

function sameActionsInstant(canonicalValue, actionsValue, label) {
  return (
    Date.parse(canonicalInstant(canonicalValue, `${label} subject`)) ===
    Date.parse(actionsInstant(actionsValue, `${label} Actions metadata`))
  );
}

export function verifyHostedEvidenceSessionWithinJob({
  session,
  recordedAt,
  job,
  label = "hosted provider session"
}) {
  requireValue(isRecord(session), `${label} must contain a session object`);
  requireValue(isRecord(job), `${label} must bind one authenticated job`);
  const sessionStarted = Date.parse(
    canonicalInstant(session.startedAt, `${label} startedAt`)
  );
  const sessionCompleted = Date.parse(
    canonicalInstant(session.completedAt, `${label} completedAt`)
  );
  const receiptRecorded = Date.parse(
    canonicalInstant(recordedAt, `${label} recordedAt`)
  );
  const jobStarted = Date.parse(
    canonicalInstant(job.startedAt, `${label} job startedAt`)
  );
  const jobCompleted = Date.parse(
    canonicalInstant(job.completedAt, `${label} job completedAt`)
  );
  requireValue(
    sessionStarted >= jobStarted &&
      sessionCompleted >= sessionStarted &&
      receiptRecorded >= sessionCompleted &&
      receiptRecorded <= jobCompleted,
    `${label} must be fully contained in the authenticated provider-capture job`
  );
  return true;
}

function fullSha(value, label) {
  requireValue(
    typeof value === "string" && FULL_SHA.test(value),
    `${label} must be a full lowercase Git commit`
  );
  return value;
}

function digest(value, label) {
  const normalized =
    typeof value === "string"
      ? value.replace(ARCHIVE_DIGEST_PREFIX, "")
      : "";
  requireValue(SHA256.test(normalized), `${label} must be a sha256 digest`);
  return normalized;
}

function token(value, label) {
  requireValue(
    typeof value === "string" && TOKEN.test(value),
    `${label} must be a bounded lowercase token`
  );
  return value;
}

function artifactName(value, label) {
  requireValue(
    typeof value === "string" &&
      value.length >= 1 &&
      value.length <= 255 &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value),
    `${label} must be a safe bounded Actions artifact name`
  );
  return value;
}

function repositoryPath(value, label) {
  requireValue(
    typeof value === "string" &&
      REPOSITORY_PATH.test(value) &&
      !value.split("/").some((part) => part === "." || part === ".."),
    `${label} must be a safe repository-relative path`
  );
  return value;
}

function exactKeys(value, expected, label) {
  requireValue(isRecord(value), `${label} must be an object`);
  requireValue(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort()),
    `${label} must contain exactly: ${[...expected].sort().join(", ")}`
  );
}

export function canonicalHostedEvidenceJson(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    requireValue(
      Number.isFinite(value),
      "canonical hosted-evidence JSON refuses non-finite numbers"
    );
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalHostedEvidenceJson(entry)).join(",")}]`;
  }
  requireValue(
    isRecord(value),
    "canonical hosted-evidence JSON accepts JSON values only"
  );
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalHostedEvidenceJson(value[key])}`
    )
    .join(",")}}`;
}

export function sha256HostedEvidence(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hostedEvidenceContextDigest(context) {
  requireValue(isRecord(context), "hosted evidence context must be an object");
  const unsigned = { ...context };
  delete unsigned.contextDigest;
  return sha256HostedEvidence(
    `${CONTEXT_DIGEST_DOMAIN}${canonicalHostedEvidenceJson(unsigned)}`
  );
}

export function hostedEvidenceArchiveRelativePath(
  profile,
  subjectSha256
) {
  profileRule(profile);
  digest(subjectSha256, "hosted evidence subject digest");
  return `${HOSTED_EVIDENCE_ROOT}/${profile}/${subjectSha256}`;
}

/**
 * Return the immutable collection contract for a hosted-evidence profile.
 *
 * The dispatch plan selects only run/artifact ids. It never selects retained
 * members, trusted workflows, or required jobs: those come exclusively from
 * this profile contract.
 */
export function hostedEvidenceCollectionContract(profile) {
  const profileConfig = profileRule(
    token(profile, "hosted evidence profile")
  );
  return Object.freeze({
    exactRoles: Object.freeze([...profileConfig.exactRoles]),
    sources: Object.freeze(
      Object.fromEntries(
        Object.entries(profileConfig.sources).map(([role, rule]) => [
          role,
          Object.freeze({
            workflows: Object.freeze([...rule.workflows]),
            trustedSourcePaths: Object.freeze([
              ...(rule.trustedSourcePaths ?? [])
            ]),
            artifactRequired: rule.artifactRequired,
            requiredArtifactMembers: Object.freeze([
              ...rule.requiredArtifactMembers
            ])
          })
        ])
      )
    )
  });
}

export function hostedEvidenceSourceClosureProblems({
  profile,
  candidateCommit,
  sources,
  readBlob
}) {
  const problems = [];
  let contract;
  try {
    contract = hostedEvidenceCollectionContract(profile);
    fullSha(candidateCommit, "hosted evidence candidate commit");
    requireValue(
      Array.isArray(sources),
      "hosted evidence source closure requires a source array"
    );
    requireValue(
      typeof readBlob === "function",
      "hosted evidence source closure requires a blob reader"
    );
  } catch (error) {
    return [
      error instanceof Error ? error.message : String(error)
    ];
  }
  for (const source of sources) {
    const sourceContract = contract.sources[source?.role];
    if (!sourceContract) {
      problems.push(
        `${String(source?.role)} is not a trusted source role for ${profile}`
      );
      continue;
    }
    const paths = [
      source.workflowPath,
      ...sourceContract.trustedSourcePaths
    ];
    for (const trustedPath of paths) {
      const sourceBytes = readBlob(
        source.headSha,
        trustedPath
      );
      const candidateBytes = readBlob(
        candidateCommit,
        trustedPath
      );
      if (
        !Buffer.isBuffer(sourceBytes) ||
        !Buffer.isBuffer(candidateBytes) ||
        !sourceBytes.equals(candidateBytes)
      ) {
        problems.push(
          trustedPath === source.workflowPath
            ? `${source.role} ran workflow bytes that do not equal the candidate-approved ${trustedPath}`
            : `${source.role} ran producer bytes that do not equal the candidate-approved ${trustedPath}`
        );
      }
    }
  }
  return problems;
}

function profileRule(profile) {
  const rule = PROFILE_RULES[profile];
  requireValue(rule, `unsupported hosted evidence profile ${String(profile)}`);
  return rule;
}

function readRegularNoFollow(filePath, maximumBytes, label) {
  let descriptor;
  try {
    descriptor = openSync(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    const info = fstatSync(descriptor);
    requireValue(
      info.isFile(),
      `${label} must be a regular file`
    );
    requireValue(
      info.size > 0 && info.size <= maximumBytes,
      `${label} must contain 1..${maximumBytes} bytes`
    );
    const bytes = readFileSync(descriptor);
    requireValue(
      bytes.byteLength === info.size &&
        bytes.byteLength > 0 &&
        bytes.byteLength <= maximumBytes,
      `${label} changed size while it was read`
    );
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function strictJsonBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true
    }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  requireValue(isRecord(value), `${label} must contain a JSON object`);
  return { text, value };
}

function copyExclusive(outputPath, bytes) {
  let descriptor;
  try {
    descriptor = openSync(
      outputPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
    writeFileSync(descriptor, bytes);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fileDescriptor(relativePath, bytes) {
  return {
    path: relativePath,
    sha256: sha256HostedEvidence(bytes),
    sizeBytes: bytes.byteLength
  };
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function checkedRange(buffer, offset, length, label) {
  requireValue(
    Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset <= buffer.length &&
      length <= buffer.length - offset,
    `${label} is truncated or outside the ZIP`
  );
}

function decodeZipName(bytes) {
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("ZIP member name is not valid UTF-8");
  }
  repositoryPath(value, "ZIP member name");
  requireValue(
    !value.endsWith("/") &&
      !value.includes("\\") &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(value),
    "ZIP member name is not a safe regular-file path"
  );
  return value;
}

function extractZipMembers(
  archiveBytes,
  requestedPaths,
  archivePolicy,
  returnAll = false
) {
  requireValue(
    Array.isArray(requestedPaths) &&
      requestedPaths.length > 0 &&
      requestedPaths.length <= MAX_MEMBERS &&
      new Set(requestedPaths).size === requestedPaths.length,
    `artifact members must contain 1..${MAX_MEMBERS} unique paths`
  );
  for (const memberPath of requestedPaths) {
    repositoryPath(memberPath, "artifact member path");
  }
  requireValue(
    archiveBytes.byteLength >= 22 &&
      archiveBytes.readUInt32LE(archiveBytes.byteLength - 22) ===
        ZIP_EOCD_SIGNATURE,
    "artifact ZIP must end in one un-commented EOCD record"
  );
  const eocd = archiveBytes.byteLength - 22;
  const disk = archiveBytes.readUInt16LE(eocd + 4);
  const centralDisk = archiveBytes.readUInt16LE(eocd + 6);
  const diskEntries = archiveBytes.readUInt16LE(eocd + 8);
  const totalEntries = archiveBytes.readUInt16LE(eocd + 10);
  const centralSize = archiveBytes.readUInt32LE(eocd + 12);
  const centralOffset = archiveBytes.readUInt32LE(eocd + 16);
  const commentLength = archiveBytes.readUInt16LE(eocd + 20);
  requireValue(
    disk === 0 &&
      centralDisk === 0 &&
      diskEntries === totalEntries &&
      totalEntries > 0 &&
      totalEntries <= 4096 &&
      totalEntries !== 0xffff &&
      centralSize !== 0xffffffff &&
      centralOffset !== 0xffffffff &&
      commentLength === 0 &&
      centralOffset + centralSize === eocd,
    "artifact ZIP disk, count, ZIP64, directory, or comment metadata is invalid"
  );
  const requested = new Set(requestedPaths);
  const found = new Map();
  const allMembers = returnAll ? new Map() : null;
  const allNames = new Set();
  const localOffsets = new Set();
  const localRanges = [];
  let totalUncompressedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    checkedRange(archiveBytes, cursor, 46, "ZIP central header");
    requireValue(
      archiveBytes.readUInt32LE(cursor) === ZIP_CENTRAL_SIGNATURE,
      "artifact ZIP central header signature is invalid"
    );
    const madeBy = archiveBytes.readUInt16LE(cursor + 4);
    const needed = archiveBytes.readUInt16LE(cursor + 6);
    const flags = archiveBytes.readUInt16LE(cursor + 8);
    const method = archiveBytes.readUInt16LE(cursor + 10);
    const checksum = archiveBytes.readUInt32LE(cursor + 16);
    const compressedSize = archiveBytes.readUInt32LE(cursor + 20);
    const uncompressedSize = archiveBytes.readUInt32LE(cursor + 24);
    const nameLength = archiveBytes.readUInt16LE(cursor + 28);
    const extraLength = archiveBytes.readUInt16LE(cursor + 30);
    const commentSize = archiveBytes.readUInt16LE(cursor + 32);
    const diskStart = archiveBytes.readUInt16LE(cursor + 34);
    const externalAttributes = archiveBytes.readUInt32LE(cursor + 38);
    const localOffset = archiveBytes.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentSize;
    checkedRange(archiveBytes, cursor, recordLength, "ZIP central entry");
    const name = decodeZipName(
      archiveBytes.subarray(cursor + 46, cursor + 46 + nameLength)
    );
    requireValue(!allNames.has(name), "artifact ZIP repeats a member path");
    allNames.add(name);
    requireValue(
      needed <= 63 &&
        (flags & ~ZIP_ALLOWED_FLAGS) === 0 &&
        (method === 0 || method === 8) &&
        diskStart === 0 &&
        compressedSize !== 0xffffffff &&
        uncompressedSize !== 0xffffffff &&
        localOffset !== 0xffffffff &&
        extraLength === 0 &&
        commentSize === 0 &&
        (externalAttributes & ZIP_DIRECTORY_ATTRIBUTE) === 0,
      `artifact ZIP member ${name} uses unsupported metadata`
    );
    totalUncompressedBytes += uncompressedSize;
    requireValue(
      Number.isSafeInteger(totalUncompressedBytes) &&
        totalUncompressedBytes <=
          (archivePolicy === "durable-soak-ledger"
            ? HOSTED_EVIDENCE_MAX_ARCHIVE_BYTES
            : 512 * 1024 * 1024),
      "artifact ZIP expanded members exceed the aggregate byte bound"
    );
    const memberMaximum =
      archivePolicy === "featured-publication" &&
      /^reports\/[0-9]{8}-[0-9a-f]{32}\.json$/.test(name)
        ? 32 * 1024 * 1024
        : archivePolicy === "featured-publication" &&
            /^reports\/[0-9]{8}-[0-9a-f]{32}\.provenance\.json$/.test(
              name
            )
          ? 16 * 1024
          : MAX_MEMBER_BYTES;
    requireValue(
      uncompressedSize > 0 && uncompressedSize <= memberMaximum,
      `artifact ZIP member ${name} is outside its profile byte bound`
    );
    if ((madeBy >>> 8) === ZIP_UNIX_HOST) {
      const mode = (externalAttributes >>> 16) & 0xffff;
      requireValue(
        (mode & ZIP_UNIX_FILE_TYPE_MASK) === 0 ||
          (mode & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_REGULAR_FILE,
        `artifact ZIP member ${name} is not a regular file`
      );
    }
    requireValue(
      !localOffsets.has(localOffset),
      "artifact ZIP repeats a local-header offset"
    );
    localOffsets.add(localOffset);
    checkedRange(archiveBytes, localOffset, 30, `ZIP local header ${name}`);
    requireValue(
      archiveBytes.readUInt32LE(localOffset) === ZIP_LOCAL_SIGNATURE,
      `artifact ZIP local header signature is invalid for ${name}`
    );
    const localFlags = archiveBytes.readUInt16LE(localOffset + 6);
    const localMethod = archiveBytes.readUInt16LE(localOffset + 8);
    const localChecksum = archiveBytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = archiveBytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = archiveBytes.readUInt32LE(localOffset + 22);
    const localNameLength = archiveBytes.readUInt16LE(localOffset + 26);
    const localExtraLength = archiveBytes.readUInt16LE(localOffset + 28);
    checkedRange(
      archiveBytes,
      localOffset,
      30 + localNameLength + localExtraLength,
      `ZIP local header fields ${name}`
    );
    const localName = decodeZipName(
      archiveBytes.subarray(
        localOffset + 30,
        localOffset + 30 + localNameLength
      )
    );
    const usesDataDescriptor = (flags & (1 << 3)) !== 0;
    requireValue(
      localName === name &&
        localFlags === flags &&
        localMethod === method &&
        localExtraLength === 0 &&
        (usesDataDescriptor
          ? localChecksum === 0 &&
            localCompressedSize === 0 &&
            localUncompressedSize === 0
          : localChecksum === checksum &&
            localCompressedSize === compressedSize &&
            localUncompressedSize === uncompressedSize),
      `artifact ZIP local and central metadata disagree for ${name}`
    );
    const dataOffset =
      localOffset + 30 + localNameLength + localExtraLength;
    checkedRange(
      archiveBytes,
      dataOffset,
      compressedSize,
      `ZIP member data ${name}`
    );
    requireValue(
      dataOffset + compressedSize <= centralOffset,
      `artifact ZIP member ${name} overlaps the central directory`
    );
    let localEnd = dataOffset + compressedSize;
    if (usesDataDescriptor) {
      checkedRange(
        archiveBytes,
        localEnd,
        12,
        `ZIP data descriptor ${name}`
      );
      let descriptorOffset = localEnd;
      if (
        archiveBytes.readUInt32LE(descriptorOffset) ===
        ZIP_DATA_DESCRIPTOR_SIGNATURE
      ) {
        checkedRange(
          archiveBytes,
          descriptorOffset,
          16,
          `ZIP signed data descriptor ${name}`
        );
        descriptorOffset += 4;
        localEnd += 16;
      } else {
        localEnd += 12;
      }
      requireValue(
        archiveBytes.readUInt32LE(descriptorOffset) === checksum &&
          archiveBytes.readUInt32LE(descriptorOffset + 4) ===
            compressedSize &&
          archiveBytes.readUInt32LE(descriptorOffset + 8) ===
            uncompressedSize &&
          localEnd <= centralOffset,
        `artifact ZIP data descriptor does not match central metadata for ${name}`
      );
    }
    localRanges.push({
      start: localOffset,
      end: localEnd,
      name
    });
    const compressed = archiveBytes.subarray(
      dataOffset,
      dataOffset + compressedSize
    );
    let bytes;
    try {
      if (method === 0) {
        requireValue(
          compressedSize === uncompressedSize,
          `stored ZIP member ${name} has inconsistent sizes`
        );
        bytes = Buffer.from(compressed);
      } else {
        const inflated = inflateRawSync(compressed, {
          maxOutputLength: uncompressedSize,
          info: true
        });
        requireValue(
          inflated.engine.bytesWritten === compressed.byteLength,
          `artifact ZIP member ${name} has trailing compressed data`
        );
        bytes = inflated.buffer;
      }
    } catch {
      throw new Error(`artifact ZIP member ${name} cannot be decompressed`);
    }
    requireValue(
      bytes.byteLength === uncompressedSize &&
        crc32(bytes) === checksum,
      `artifact ZIP member ${name} size or CRC is invalid`
    );
    if (requested.has(name)) found.set(name, bytes);
    if (allMembers) allMembers.set(name, bytes);
    cursor += recordLength;
  }
  localRanges.sort((left, right) => left.start - right.start);
  requireValue(
    localRanges[0]?.start === 0,
    "artifact ZIP contains a preamble before its first local entry"
  );
  for (let index = 1; index < localRanges.length; index += 1) {
    requireValue(
      localRanges[index - 1].end === localRanges[index].start,
      `artifact ZIP local entries ${localRanges[index - 1].name} and ${localRanges[index].name} overlap or hide a gap`
    );
  }
  requireValue(
    localRanges.at(-1)?.end === centralOffset,
    "artifact ZIP hides bytes between its local entries and central directory"
  );
  requireValue(
    cursor === eocd,
    "artifact ZIP central directory length is inconsistent"
  );
  requireValue(
    found.size === requested.size,
    "artifact ZIP is missing one or more required members"
  );
  if (archivePolicy === "exact") {
    requireValue(
      JSON.stringify([...allNames].sort()) ===
        JSON.stringify([...requested].sort()),
      "artifact ZIP contains an unapproved member"
    );
  } else if (archivePolicy === "featured-publication") {
    const reportId = "[0-9]{8}-[0-9a-f]{32}";
    const allowed = new RegExp(
      `^(?:publication\\.json|corpus-stats\\.json|reports/index\\.json|reports/${reportId}(?:\\.json|\\.provenance\\.json))$`
    );
    requireValue(
      [...allNames].every((name) => allowed.test(name)),
      "featured publication ZIP contains an unapproved member"
    );
  } else if (archivePolicy === "durable-soak-ledger") {
    requireValue(
      [...allNames].every((name) =>
        durableSoakAggregateMemberNameAllowed(name)
      ),
      "durable soak ledger ZIP contains an unapproved member"
    );
  } else {
    throw new Error("artifact ZIP has no approved archival policy");
  }
  const selected = returnAll ? [...allNames].sort() : requestedPaths;
  const selectedMembers = returnAll ? allMembers : found;
  return selected.map((memberPath) => ({
    path: memberPath,
    bytes: selectedMembers.get(memberPath)
  }));
}

export function inspectHostedEvidenceArtifactZip(
  archiveBytes,
  requestedPaths,
  archivePolicy
) {
  requireValue(
    Buffer.isBuffer(archiveBytes),
    "hosted evidence artifact ZIP must be supplied as a Buffer"
  );
  return extractZipMembers(
    archiveBytes,
    requestedPaths,
    archivePolicy
  ).map((member) => ({
    path: member.path,
    sha256: sha256HostedEvidence(member.bytes),
    sizeBytes: member.bytes.byteLength
  }));
}

export function extractHostedEvidenceArtifactZipMembers(
  archiveBytes,
  requestedPaths,
  archivePolicy
) {
  requireValue(
    Buffer.isBuffer(archiveBytes),
    "hosted evidence artifact ZIP must be supplied as a Buffer"
  );
  return extractZipMembers(
    archiveBytes,
    requestedPaths,
    archivePolicy
  );
}

function extractHostedEvidenceArtifactZipAll(
  archiveBytes,
  requestedPaths,
  archivePolicy
) {
  return new Map(
    extractZipMembers(
      archiveBytes,
      requestedPaths,
      archivePolicy,
      true
    ).map((member) => [member.path, member.bytes])
  );
}

function flattenedPageObjects(pageBytes, collectionKey, label) {
  const pages = pageBytes.map((bytes, index) =>
    strictJsonBytes(bytes, `${label} page ${index + 1}`).value
  );
  const values = [];
  let expectedTotal = null;
  for (const [index, page] of pages.entries()) {
    requireValue(
      Number.isSafeInteger(page.total_count) && page.total_count >= 0,
      `${label} page ${index + 1} total_count is invalid`
    );
    if (expectedTotal === null) expectedTotal = page.total_count;
    requireValue(
      page.total_count === expectedTotal,
      `${label} pages disagree on total_count`
    );
    requireValue(
      Array.isArray(page[collectionKey]),
      `${label} page ${index + 1} has no ${collectionKey} array`
    );
    requireValue(
      page[collectionKey].length <= 100,
      `${label} page ${index + 1} exceeds the page bound`
    );
    values.push(...page[collectionKey]);
  }
  requireValue(
    values.length === expectedTotal,
    `${label} retained pages are not set-complete`
  );
  return values;
}

function validateRunMetadata(run, expected, rule) {
  requireValue(
    run.id === expected.runId &&
      run.run_attempt === expected.runAttempt &&
      run.repository?.full_name === HOSTED_EVIDENCE_REPOSITORY &&
      run.path === expected.workflowPath &&
      run.head_branch === "main" &&
      run.head_sha === expected.headSha &&
      run.status === "completed" &&
      run.conclusion === "success",
    `${expected.role} run metadata does not identify the exact successful main-branch run`
  );
  const allowedEvents =
    rule.eventsByWorkflow?.[expected.workflowPath] ?? rule.events;
  requireValue(
    Array.isArray(allowedEvents) && allowedEvents.includes(run.event),
    `${expected.role} run event is not allowed for ${expected.workflowPath}`
  );
  return run.event;
}

function validatePublicSafeControlledRunner(job, role) {
  const customLabels = Array.isArray(job.labels)
    ? job.labels.filter(
        (label) =>
          !["self-hosted", "Linux", "X64"].includes(label)
      )
    : [];
  requireValue(
    typeof job.runner_name === "string" &&
      /^sbl-controlled-[0-9a-f]{16}$/.test(job.runner_name) &&
      job.runner_group_name === "Default" &&
      Array.isArray(job.labels) &&
      job.labels.length === 4 &&
      new Set(job.labels).size === 4 &&
      ["self-hosted", "Linux", "X64"].every((label) =>
        job.labels.includes(label)
      ) &&
      customLabels.length === 1 &&
      /^sbl-controlled-r2-[0-9a-f]{16}$/.test(customLabels[0]),
    `${role} raw Jobs API metadata is not deliberately public-safe: register the ephemeral runner with an opaque sbl-controlled-<16hex> name, the Default group, and only self-hosted/Linux/X64 plus sbl-controlled-r2-<16hex>`
  );
}

function validateJobs(jobs, expected, rule) {
  const ids = new Set();
  for (const [index, job] of jobs.entries()) {
    requireValue(
      isRecord(job) &&
        Number.isSafeInteger(job.id) &&
        job.id > 0 &&
        typeof job.name === "string" &&
        job.name.length > 0 &&
        !ids.has(job.id),
      `${expected.role} jobs contain an invalid or duplicate entry at ${index}`
    );
    ids.add(job.id);
  }
  const required = rule.requiredJobNames;
  requireValue(
    Array.isArray(required) &&
      required.every(
        (name) =>
          typeof name === "string" &&
          name.length > 0 &&
          name.length <= 200
      ),
    `${expected.role} required job names are invalid`
  );
  for (const name of required) {
    const matches = jobs.filter((job) => job.name === name);
    requireValue(
      matches.length === 1 &&
        matches[0].status === "completed" &&
        matches[0].conclusion === "success",
      `${expected.role} must contain one successful completed job named ${name}`
    );
    if (rule.publicSafeControlledRunner === true) {
      validatePublicSafeControlledRunner(matches[0], expected.role);
    }
  }
  if (rule.publicSafeControlledRunner === true) {
    const selfHostedJobs = jobs.filter(
      (job) =>
        Array.isArray(job.labels) &&
        job.labels.includes("self-hosted")
    );
    requireValue(
      selfHostedJobs.length > 0,
      `${expected.role} must retain its controlled self-hosted job metadata`
    );
    for (const job of selfHostedJobs) {
      validatePublicSafeControlledRunner(job, expected.role);
    }
  }
  const requiredStepNames = rule.requiredStepNames ?? [];
  requireValue(
    Array.isArray(requiredStepNames) &&
      requiredStepNames.every(
        (name) =>
          typeof name === "string" &&
          name.length > 0 &&
          name.length <= 200
      ),
    `${expected.role} required step names are invalid`
  );
  return jobs
    .filter((job) => required.includes(job.name))
    .map((job) => {
      const identity = {
        id: job.id,
        name: job.name,
        conclusion: job.conclusion,
        startedAt: actionsInstant(
          job.started_at,
          `${expected.role} job started_at`
        ),
        completedAt: actionsInstant(
          job.completed_at,
          `${expected.role} job completed_at`
        )
      };
      if (requiredStepNames.length === 0) return identity;
      requireValue(
        Array.isArray(job.steps),
        `${expected.role} job must retain its exact step results`
      );
      const requiredSteps = requiredStepNames.map((name) => {
        const matches = job.steps.filter((step) => step?.name === name);
        requireValue(
          matches.length === 1 &&
            matches[0].status === "completed" &&
            matches[0].conclusion === "success",
          `${expected.role} must execute one successful completed step named ${name}`
        );
        return {
          name,
          number: positiveInteger(
            matches[0].number,
            `${expected.role} step ${name} number`
          ),
          conclusion: "success",
          startedAt: actionsInstant(
            matches[0].started_at,
            `${expected.role} step ${name} started_at`
          ),
          completedAt: actionsInstant(
            matches[0].completed_at,
            `${expected.role} step ${name} completed_at`
          )
        };
      });
      return { ...identity, requiredSteps };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function inspectHostedEvidenceJobs(profile, role, jobs) {
  const profileConfig = profileRule(
    token(profile, "hosted evidence profile")
  );
  const normalizedRole = token(role, "hosted evidence source role");
  const rule = profileConfig.sources[normalizedRole];
  requireValue(
    rule,
    `hosted evidence profile does not allow role ${normalizedRole}`
  );
  requireValue(Array.isArray(jobs), "hosted evidence jobs must be an array");
  return validateJobs(jobs, { role: normalizedRole }, rule);
}

function validateArtifact({
  artifacts,
  artifactMetadata,
  archiveBytes,
  expected,
  rule
}) {
  if (!expected.artifact) {
    requireValue(
      rule.artifactRequired === false,
      `${expected.role} requires one authenticated artifact`
    );
    return null;
  }
  const artifactId = positiveInteger(
    expected.artifact.id,
    `${expected.role} artifact id`
  );
  const matches = artifacts.filter((artifact) => artifact?.id === artifactId);
  requireValue(
    matches.length === 1,
    `${expected.role} artifact pages must identify exactly one artifact id`
  );
  const artifact = matches[0];
  const expectedName =
    typeof rule.artifactName === "function"
      ? rule.artifactName(expected)
      : expected.artifact.name;
  requireValue(
    expected.artifact.name === expectedName &&
      artifact.name === expectedName &&
      artifactMetadata.id === artifactId &&
      artifactMetadata.name === expectedName,
    `${expected.role} artifact name or id does not match its profile`
  );
  const liveDigest = digest(
    artifact.digest,
    `${expected.role} live artifact digest`
  );
  requireValue(
    digest(
      artifactMetadata.digest,
      `${expected.role} artifact metadata digest`
    ) === liveDigest &&
      digest(
        expected.artifact.sha256,
        `${expected.role} expected artifact digest`
      ) === liveDigest &&
      sha256HostedEvidence(archiveBytes) === liveDigest,
    `${expected.role} raw artifact archive does not match immutable metadata`
  );
  requireValue(
    artifact.expired === false &&
      artifactMetadata.expired === false &&
      artifact.workflow_run?.id === expected.runId &&
      artifact.workflow_run?.head_sha === expected.headSha &&
      artifactMetadata.workflow_run?.id === expected.runId &&
      artifactMetadata.workflow_run?.head_sha === expected.headSha,
    `${expected.role} artifact is expired or belongs to another run`
  );
  requireValue(
    artifact.size_in_bytes === archiveBytes.byteLength &&
      artifactMetadata.size_in_bytes === archiveBytes.byteLength,
    `${expected.role} raw artifact byte length does not match GitHub metadata`
  );
  return {
    id: artifactId,
    name: expectedName,
    sha256: liveDigest,
    sizeBytes: archiveBytes.byteLength
  };
}

function validateProfileSources(profile, sources) {
  const profileConfig = profileRule(profile);
  requireValue(
    Array.isArray(sources) &&
      sources.length === profileConfig.exactRoles.length &&
      sources.length > 0 &&
      sources.length <= MAX_SOURCES,
    `${profile} must retain exactly ${profileConfig.exactRoles.join(", ")} sources`
  );
  const roles = sources.map((source) => source.role);
  requireValue(
    JSON.stringify(roles) ===
      JSON.stringify([...profileConfig.exactRoles]),
    `${profile} source roles must be exactly ${profileConfig.exactRoles.join(", ")} in canonical order`
  );
  return profileConfig;
}

function workflowIdentity(workflowPath) {
  return `${HOSTED_EVIDENCE_REPOSITORY}/${workflowPath}@refs/heads/main`;
}

function sourceEvidenceFor(sourceEvidence, role) {
  const evidence = sourceEvidence.find((entry) => entry.role === role);
  requireValue(evidence, `hosted evidence is missing semantic source ${role}`);
  return evidence;
}

function memberBytes(evidence, memberPath) {
  const bytes = evidence.members.get(memberPath);
  requireValue(
    Buffer.isBuffer(bytes),
    `${evidence.role} artifact is missing retained member ${memberPath}`
  );
  return bytes;
}

function memberJson(evidence, memberPath) {
  return strictJsonBytes(
    memberBytes(evidence, memberPath),
    `${evidence.role} artifact member ${memberPath}`
  ).value;
}

function sameCanonical(left, right) {
  return (
    canonicalHostedEvidenceJson(left) ===
    canonicalHostedEvidenceJson(right)
  );
}

function requireSubjectEqualsMember(subjectBytes, evidence, memberPath) {
  requireValue(
    subjectBytes.equals(memberBytes(evidence, memberPath)),
    `hosted evidence subject bytes do not equal ${evidence.role} ${memberPath}`
  );
}

function requireRunBinding(claim, evidence, label) {
  requireValue(
    isRecord(claim) &&
      String(claim.runId) === String(evidence.context.runId) &&
      claim.runAttempt === evidence.context.runAttempt &&
      claim.workflow === workflowIdentity(evidence.context.workflowPath),
    `${label} does not bind the authenticated workflow run`
  );
}

function validatePublicationSubject(subject, subjectBytes, context, evidence) {
  const publisher = sourceEvidenceFor(evidence, "publisher");
  requireSubjectEqualsMember(subjectBytes, publisher, "receipt.json");
  const publicationBytes = memberBytes(publisher, "publication.json");
  requireValue(
    subject.actionsRun?.id === publisher.context.runId &&
      Number.isSafeInteger(subject.actionsRun?.attempt) &&
      subject.actionsRun.attempt >= 1 &&
      subject.actionsRun.attempt <= publisher.context.runAttempt &&
      subject.actionsRun?.sourceCommit === publisher.context.headSha,
    "controlled publication subject does not bind the authenticated publisher run"
  );
  requireValue(
    subject.publicationArtifact?.manifestSha256 ===
      sha256HostedEvidence(publicationBytes),
    "controlled publication subject does not bind the retained publication manifest"
  );
  const publication = strictJsonBytes(
    publicationBytes,
    "controlled publication manifest"
  ).value;
  requireValue(
    publication.sourceCommit === publisher.context.headSha &&
      publication.publicationKind === "featured" &&
      publication.reportMode === "r2",
    "controlled publication manifest is not the authenticated r2 producer output"
  );
}

function validateRunnerSubject(subject, subjectBytes, context, evidence) {
  const collection = sourceEvidenceFor(evidence, "collection");
  const destruction = sourceEvidenceFor(evidence, "destruction");
  requireValue(
    subject.actionsRunId === collection.context.runId &&
      subject.actionsRunAttempt === collection.context.runAttempt &&
      subject.runEvidence?.headSha === collection.context.headSha &&
      subject.runEvidence?.artifact?.id === collection.context.artifact?.id &&
      subject.runEvidence?.artifact?.name ===
        collection.context.artifact?.name &&
      subject.runEvidence?.artifact?.sha256 ===
        collection.context.artifact?.sha256,
    "runner receipt collection tuple does not bind the authenticated run and artifact"
  );
  const collectionJob = collection.context.requiredJobs.find(
    (job) => job.name === "Populate Featured Gallery"
  );
  requireValue(
    collectionJob &&
      subject.runEvidence?.job?.id === collectionJob.id &&
      subject.runEvidence?.job?.name === collectionJob.name &&
      subject.runEvidence?.job?.startedAt === collectionJob.startedAt &&
      subject.runEvidence?.job?.completedAt === collectionJob.completedAt,
    "runner receipt job does not bind the authenticated collection job"
  );
  const destructionClaim = subject.destructionEvidence;
  const destructionJob = destruction.context.requiredJobs.find(
    (job) => job.name ===
      "Read back provider destruction and absence"
  );
  requireValue(
    isRecord(destructionClaim) &&
      destructionClaim.workflow ===
        ".github/workflows/runner-destruction-evidence.yml" &&
      destructionClaim.runId === destruction.context.runId &&
      destructionClaim.runAttempt === destruction.context.runAttempt &&
      destructionClaim.headSha === destruction.context.headSha &&
      destructionClaim.conclusion === "success" &&
      destructionJob &&
      destructionClaim.job?.id === destructionJob.id &&
      destructionClaim.job?.name === destructionJob.name &&
      destructionClaim.job?.startedAt === destructionJob.startedAt &&
      destructionClaim.job?.completedAt === destructionJob.completedAt &&
      destructionClaim.artifact?.id === destruction.context.artifact?.id &&
      destructionClaim.artifact?.name ===
        destruction.context.artifact?.name &&
      destructionClaim.artifact?.sha256 ===
        destruction.context.artifact?.sha256,
    "runner receipt destruction tuple does not bind the authenticated hosted readback"
  );
  const absence = memberJson(destruction, "destruction-evidence.json");
  exactKeys(
    absence,
    [
      "schemaVersion",
      "artifactKind",
      "collection",
      "destroyedAt",
      "verifiedAbsentAt",
      "computeAbsent",
      "registrationAbsent",
      "runnerAbsent",
      "evidenceRefs"
    ],
    "runner destruction provider readback"
  );
  requireValue(
    absence.schemaVersion === 1 &&
      absence.artifactKind ===
        "site-behavior-runner-destruction-provider-readback" &&
      absence.collection?.runId === collection.context.runId &&
      absence.collection?.runAttempt === collection.context.runAttempt &&
      absence.collection?.headSha === collection.context.headSha &&
      absence.destroyedAt === subject.destruction?.destroyedAt &&
      absence.verifiedAbsentAt ===
        subject.destruction?.verifiedAbsentAt &&
      absence.computeAbsent === true &&
      absence.registrationAbsent === true &&
      absence.runnerAbsent === true &&
      Array.isArray(absence.evidenceRefs) &&
      absence.evidenceRefs.length > 0 &&
      Array.isArray(subject.operator?.evidenceRefs) &&
      absence.evidenceRefs.every((reference) =>
        subject.operator.evidenceRefs.some((candidate) =>
          sameCanonical(reference, candidate)
        )
      ) &&
      destructionClaim.readback?.path === "destruction-evidence.json" &&
      destructionClaim.readback?.sha256 ===
        sha256HostedEvidence(
          memberBytes(destruction, "destruction-evidence.json")
        ),
    "runner destruction provider readback does not prove the receipt's exact absence evidence"
  );
}

function validateDurableTransitionSubject(subject, context, evidence) {
  const ci = sourceEvidenceFor(evidence, "ci");
  const promotion = sourceEvidenceFor(evidence, "promotion");
  const health = sourceEvidenceFor(evidence, "production-health");
  requireRunBinding(subject.ci, ci, "durable transition CI");
  requireRunBinding(
    subject.promotion,
    promotion,
    "durable transition promotion"
  );
  requireRunBinding(
    subject.productionHealth,
    health,
    "durable transition Production Health"
  );
  const toCommit = subject.transition?.toCommit;
  requireValue(
    FULL_SHA.test(toCommit) &&
      subject.ci.headCommit === toCommit &&
      subject.promotion.productionCommit === toCommit &&
      subject.productionHealth.headCommit === toCommit &&
      ci.context.headSha === toCommit &&
      promotion.context.headSha === toCommit &&
      health.context.headSha === toCommit,
    "durable transition sources do not share the exact enabled deployment commit"
  );
  requireValue(
    subject.ci.conclusion === "success" &&
      sameActionsInstant(
        subject.ci.completedAt,
        ci.run.updated_at,
        "durable transition CI updated_at"
      ) &&
      sameActionsInstant(
        subject.promotion.convergedAt,
        promotion.run.updated_at,
        "durable transition promotion updated_at"
      ) &&
      sameActionsInstant(
        subject.productionHealth.observedAt,
        health.run.updated_at,
        "durable transition Production Health updated_at"
      ),
    "durable transition timestamps do not come from authenticated run metadata"
  );
  const ciResult = memberJson(ci, "attestation-results.json");
  requireValue(
    ciResult.sourceCommit === toCommit,
    "durable transition CI artifact does not bind the enabled deployment commit"
  );
  const healthBytes = memberBytes(health, "production-health.json");
  const liveHealth = strictJsonBytes(
    healthBytes,
    "durable transition production health"
  ).value;
  requireValue(
    liveHealth.deployment === toCommit &&
      liveHealth.status === "ok" &&
      Array.isArray(liveHealth.warnings) &&
      liveHealth.warnings.length === 0 &&
      liveHealth.checks?.durableJobs?.requested === true &&
      liveHealth.checks?.durableJobs?.enabled === true &&
      liveHealth.checks?.durableJobs?.readiness === "ready" &&
      subject.productionHealth.status === "ok" &&
      subject.productionHealth.warningCount === 0 &&
      subject.productionHealth.durableJobs?.requested === true &&
      subject.productionHealth.durableJobs?.enabled === true &&
      subject.productionHealth.durableJobs?.readiness === "ready" &&
      subject.promotion.deploymentDigest === health.context.artifact?.sha256,
    "durable transition health/deployment claims do not match the authenticated health artifact"
  );
}

function durableHealthIdentity(evidence, label) {
  const health = memberJson(evidence, "production-health.json");
  requireValue(
    FULL_SHA.test(health.deployment) &&
      health.status === "ok" &&
      Array.isArray(health.warnings) &&
      health.warnings.length === 0 &&
      health.checks?.durableJobs?.requested === true &&
      health.checks?.durableJobs?.enabled === true &&
      health.checks?.durableJobs?.readiness === "ready",
    `${label} is not a clean durable-enabled health artifact`
  );
  return health;
}

export function verifyDurableSoakExerciseHostedBinding({
  exerciseBytes,
  healthBytes,
  postHealthBytes,
  sourceHeadSha,
  requiredJobs,
  subjectBindings,
  window
}) {
  const exerciseEvidence = parseDurableSoakExerciseEvidence(
    exerciseBytes.toString("utf8")
  );
  const verified = verifyDurableSoakExerciseEvidence(
    exerciseEvidence,
    {
      expectedSourceCommit: sourceHeadSha,
      expectedDeploymentCommit:
        subjectBindings?.soakDeploymentCommit,
      expectedDurableConfigSha256:
        subjectBindings?.durableConfigDigest,
      healthBytes,
      postHealthBytes,
      window
    }
  );
  const exerciseJob = Array.isArray(requiredJobs)
    ? requiredJobs.find(
        (job) =>
          job.name ===
          "Exercise durable completion, cancellation, and recovery"
      )
    : null;
  requireValue(
    exerciseJob &&
      SHA256.test(
        subjectBindings?.durableEnableReceiptDigest ?? ""
      ) &&
      verified.sourceCommit ===
        subjectBindings.soakDeploymentCommit &&
      Date.parse(verified.startedAt) >=
        Date.parse(exerciseJob.startedAt) &&
      Date.parse(verified.completedAt) <=
        Date.parse(exerciseJob.completedAt),
    "durable soak behavior exercises are not bound to the exact deployment, enable receipt, and authenticated exercise job"
  );
  return verified;
}

function validateDurableSoakSubject(subject, context, evidence) {
  const monitor = sourceEvidenceFor(evidence, "monitor");
  const restart = sourceEvidenceFor(evidence, "restart");
  const exercises = sourceEvidenceFor(evidence, "exercises");
  const preHealth = memberJson(restart, "pre-health.json");
  const postHealth = memberJson(restart, "post-health.json");
  const restartEvidence = memberJson(restart, "restart-evidence.json");
  const recovery = memberJson(restart, "queued-work-recovery.json");
  const verifiedRestart = verifyDurableRestartEvidenceSet({
    preHealth,
    postHealth,
    recovery,
    restart: restartEvidence,
    recoverySha256: sha256HostedEvidence(
      memberBytes(restart, "queued-work-recovery.json")
    )
  });
  const restartJob = restart.context.requiredJobs.find(
    (job) =>
      job.name ===
      "Restart runtime and prove queued work recovery"
  );
  requireValue(
    restartJob &&
      verifiedRestart.deploymentCommit === restart.context.headSha &&
      Date.parse(restartEvidence.startedAt) >=
        Date.parse(restartJob.startedAt) &&
      Date.parse(restartEvidence.completedAt) <=
        Date.parse(restartJob.completedAt),
    "durable soak restart facts are outside their authenticated restart job"
  );

  const aggregateMembers = extractHostedEvidenceArtifactZipAll(
    monitor.archiveBytes,
    [DURABLE_SOAK_LEDGER_FILE, DURABLE_SOAK_SOURCE_DIGESTS_FILE],
    "durable-soak-ledger"
  );
  const expectedRestart = {
    workflowPath: restart.context.workflowPath,
    runId: restart.context.runId,
    runAttempt: restart.context.runAttempt,
    headSha: restart.context.headSha,
    startedAt: restartEvidence.startedAt,
    completedAt: restartEvidence.completedAt,
    restartObservedAt: restartEvidence.restartObservedAt,
    artifact: {
      id: restart.context.artifact.id,
      name: restart.context.artifact.name,
      sha256: restart.context.artifact.sha256
    },
    recoverySha256: sha256HostedEvidence(
      memberBytes(restart, "queued-work-recovery.json")
    )
  };
  const aggregate = verifyDurableSoakLedgerMembers(
    aggregateMembers,
    {
      expectedRestart,
      artifactZipInspector:
        extractHostedEvidenceArtifactZipMembers
    }
  );
  const monitorJob = monitor.context.requiredJobs.find(
    (job) =>
      job.name === "Aggregate authenticated hourly durable health"
  );
  requireValue(
    monitorJob &&
      Date.parse(aggregate.ledger.recordedAt) >=
        Date.parse(monitorJob.startedAt) &&
      Date.parse(aggregate.ledger.recordedAt) <=
        Date.parse(monitorJob.completedAt),
    "durable soak ledger recordedAt is outside its authenticated monitor job"
  );

  const window = subject.evidenceWindow;
  const deployment = subject.bindings?.soakDeploymentCommit;
  requireValue(
    deployment === aggregate.deploymentCommit &&
      subject.bindings?.ledgerSha256 === aggregate.ledgerSha256 &&
      window?.startedAt === aggregate.ledger.window.startedAt &&
      window?.endedAt === aggregate.ledger.window.endedAt &&
      window?.restartObservedAt ===
        aggregate.ledger.restart.restartObservedAt &&
      subject.evidenceCapturedAt === aggregate.ledger.window.endedAt,
    "durable soak subject does not bind the authenticated hourly ledger digest, window, and deployment"
  );

  verifyDurableSoakExerciseHostedBinding({
    exerciseBytes: memberBytes(
      exercises,
      DURABLE_SOAK_EXERCISE_FILE
    ),
    healthBytes: memberBytes(
      exercises,
      DURABLE_SOAK_EXERCISE_HEALTH_FILE
    ),
    postHealthBytes: memberBytes(
      exercises,
      DURABLE_SOAK_EXERCISE_POST_HEALTH_FILE
    ),
    sourceHeadSha: exercises.context.headSha,
    requiredJobs: exercises.context.requiredJobs,
    subjectBindings: subject.bindings,
    window: {
      startedAt: aggregate.ledger.window.startedAt,
      endedAt: aggregate.ledger.window.endedAt
    }
  });
  requireValue(
    Array.isArray(subject.evidenceRefs) &&
      JSON.stringify(subject.evidenceRefs) ===
        JSON.stringify(
          [monitor, restart, exercises].map(
            (source) =>
              `github-actions-run:${source.context.runId}:artifact-sha256:${source.context.artifact.sha256}`
          )
        ),
    "durable soak evidenceRefs do not bind every authenticated source run and artifact"
  );
}

function validateLifecycleSubject(subject, subjectBytes, context, evidence) {
  const readback = sourceEvidenceFor(evidence, "readback");
  const health = sourceEvidenceFor(evidence, "production-health");
  requireSubjectEqualsMember(subjectBytes, readback, "receipt.json");
  const liveHealth = durableHealthIdentity(
    health,
    "lifecycle Production Health"
  );
  requireValue(
    subject.kind === "site-behavior-r2-lifecycle-readback" &&
      subject.receiptVersion === 2 &&
      subject.ok === true &&
      isRecord(subject.sourceArtifact) &&
      typeof subject.sourceArtifact.data === "string" &&
      readback.context.headSha === health.context.headSha &&
      liveHealth.deployment === health.context.headSha,
    "lifecycle subject is not a complete reopenable v2 readback receipt"
  );
}

function validateStagingTeardownSubject(
  subject,
  subjectBytes,
  context,
  evidence,
  repositoryRoot
) {
  const capture = sourceEvidenceFor(evidence, "provider-capture");
  requireSubjectEqualsMember(subjectBytes, capture, "receipt.json");
  const manifestBytes = memberBytes(
    capture,
    "sanitized-provider-manifest.json"
  );
  const manifest = memberJson(
    capture,
    "sanitized-provider-manifest.json"
  );
  const captureJob = capture.context.requiredJobs.find(
    (job) => job.name ===
      "Capture sanitized staging teardown evidence"
  );
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "artifactKind",
      "stagingSourceCommit",
      "recordedAt",
      "session",
      "inventory",
      "sourceArtifact",
      "producerClosure",
      "teardownInventoryDigest"
    ],
    "staging teardown sanitized provider manifest"
  );
  requireValue(
    Buffer.from(
      `${canonicalHostedEvidenceJson(manifest)}\n`,
      "utf8"
    ).equals(manifestBytes),
    "staging teardown sanitized provider manifest bytes are not canonical"
  );
  const sourceRoot = realpathSync(path.resolve(repositoryRoot));
  const gitRoot = realpathSync(
    nodeExecFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    }).trim()
  );
  requireValue(
    gitRoot === sourceRoot,
    "staging teardown producer closure requires the exact repository root"
  );
  const producerClosure =
    buildStagingTeardownHostedProducerClosure(
      (repositoryPath) =>
        nodeExecFileSync(
          "git",
          [
            "show",
            `${capture.context.headSha}:${repositoryPath}`
          ],
          {
            cwd: sourceRoot,
            encoding: "buffer",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
            maxBuffer: 2 * 1024 * 1024
          }
        )
    );
  const expectedManifest =
    buildStagingTeardownHostedManifest(subject, producerClosure);
  requireValue(
    manifest.schemaVersion === 1 &&
      manifest.artifactKind ===
        "site-behavior-staging-teardown-sanitized-provider-manifest" &&
      subject.schemaVersion === 1 &&
      subject.artifactKind ===
        "site-behavior-staging-teardown-session-receipt" &&
      FULL_SHA.test(subject.stagingSourceCommit) &&
      captureJob &&
      verifyHostedEvidenceSessionWithinJob({
        session: subject.session,
        recordedAt: subject.recordedAt,
        job: captureJob,
        label: "staging teardown session"
      }) &&
      sameCanonical(manifest, expectedManifest),
    "staging teardown subject is not rederived by the authenticated sanitized provider manifest"
  );
}

function validateWafCeilingsSubject(
  subject,
  subjectBytes,
  context,
  evidence,
  repositoryRoot
) {
  const capture = sourceEvidenceFor(evidence, "provider-capture");
  requireSubjectEqualsMember(subjectBytes, capture, "receipt.json");
  const manifestBytes = memberBytes(
    capture,
    "sanitized-provider-manifest.json"
  );
  const manifest = memberJson(
    capture,
    "sanitized-provider-manifest.json"
  );
  const verdict = validateWafCeilingEvidence(subject);
  requireValue(
    verdict.ok,
    `WAF ceiling subject failed canonical validation: ${verdict.problems.join("; ")}`
  );
  requireValue(
    Buffer.from(serializeWafCeilingEvidence(subject), "utf8").equals(
      subjectBytes
    ),
    "WAF ceiling subject bytes are not canonical"
  );
  const sourceRoot = realpathSync(path.resolve(repositoryRoot));
  const gitRoot = realpathSync(
    nodeExecFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    }).trim()
  );
  requireValue(
    gitRoot === sourceRoot,
    "WAF ceiling producer closure requires the exact repository root"
  );
  const producerClosure = buildWafHostedProducerClosure(
    (repositoryPath) =>
      nodeExecFileSync(
        "git",
        [
          "show",
          `${capture.context.headSha}:${repositoryPath}`
        ],
        {
          cwd: sourceRoot,
          encoding: "buffer",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
          maxBuffer: 2 * 1024 * 1024
        }
      )
  );
  const expectedManifest = buildWafHostedSanitizedManifest(
    subject,
    producerClosure
  );
  requireValue(
    Buffer.from(
      `${canonicalHostedEvidenceJson(manifest)}\n`,
      "utf8"
    ).equals(manifestBytes),
    "WAF ceiling sanitized provider manifest bytes are not canonical"
  );
  const captureJob = capture.context.requiredJobs.find(
    (job) => job.name === "Capture sanitized WAF ceiling evidence"
  );
  requireValue(
    captureJob &&
      verifyHostedEvidenceSessionWithinJob({
        session: expectedManifest.session,
        recordedAt: subject.capturedAt,
        job: captureJob,
        label: "WAF ceiling provider capture"
      }) &&
      capture.context.headSha === subject.candidateCommit &&
      subject.deploymentCommit === subject.candidateCommit &&
      sameCanonical(manifest, expectedManifest),
    "WAF ceiling subject is not rederived by the exact candidate's authenticated sanitized provider manifest"
  );
}

function validateSubjectSemantics(
  profile,
  subject,
  subjectBytes,
  context,
  evidence,
  repositoryRoot
) {
  if (profile === "controlled-publication") {
    validatePublicationSubject(subject, subjectBytes, context, evidence);
  } else if (profile === "runner-destruction") {
    validateRunnerSubject(subject, subjectBytes, context, evidence);
  } else if (profile === "durable-transition") {
    validateDurableTransitionSubject(subject, context, evidence);
  } else if (profile === "durable-soak") {
    validateDurableSoakSubject(subject, context, evidence);
  } else if (profile === "lifecycle") {
    validateLifecycleSubject(subject, subjectBytes, context, evidence);
  } else if (profile === "staging-teardown") {
    validateStagingTeardownSubject(
      subject,
      subjectBytes,
      context,
      evidence,
      repositoryRoot
    );
  } else if (profile === "waf-ceilings") {
    validateWafCeilingsSubject(
      subject,
      subjectBytes,
      context,
      evidence,
      repositoryRoot
    );
  } else {
    throw new Error(`hosted evidence has no subject validator for ${profile}`);
  }
}

function normalizeSourceInput(source, profileConfig) {
  requireValue(isRecord(source), "hosted evidence source input must be an object");
  const role = token(source.role, "hosted evidence source role");
  const rule = profileConfig.sources[role];
  requireValue(rule, `hosted evidence profile does not allow role ${role}`);
  const runId = positiveInteger(source.runId, `${role} run id`);
  const runAttempt = positiveInteger(
    source.runAttempt,
    `${role} run attempt`,
    100
  );
  const workflowPath = repositoryPath(
    source.workflowPath,
    `${role} workflow path`
  );
  requireValue(
    rule.workflows.includes(workflowPath),
    `${role} workflow path is not trusted for this profile`
  );
  const headSha = fullSha(source.headSha, `${role} head SHA`);
  requireValue(
    Array.isArray(source.jobsPagePaths) &&
      source.jobsPagePaths.length > 0 &&
      source.jobsPagePaths.length <= MAX_PAGES,
    `${role} must retain 1..${MAX_PAGES} jobs pages`
  );
  requireValue(
    Array.isArray(source.artifactsPagePaths) &&
      source.artifactsPagePaths.length > 0 &&
      source.artifactsPagePaths.length <= MAX_PAGES,
    `${role} must retain 1..${MAX_PAGES} artifact pages`
  );
  const artifact =
    source.artifact === null || source.artifact === undefined
      ? null
      : {
          id: positiveInteger(source.artifact.id, `${role} artifact id`),
          name: artifactName(source.artifact.name, `${role} artifact name`),
          sha256: digest(
            source.artifact.sha256,
            `${role} artifact digest`
          ),
          members: (() => {
            requireValue(
              Array.isArray(source.artifact.members) &&
                source.artifact.members.length > 0 &&
                source.artifact.members.length <= MAX_MEMBERS,
              `${role} artifact must name 1..${MAX_MEMBERS} retained members`
            );
            const members = source.artifact.members.map((member, index) =>
              repositoryPath(
                member,
                `${role} artifact member ${index + 1}`
              )
            );
            requireValue(
              new Set(members).size === members.length,
              `${role} artifact members must be unique`
            );
            requireValue(
              JSON.stringify([...members].sort()) ===
                JSON.stringify([...rule.requiredArtifactMembers].sort()),
              `${role} artifact members must be exactly ${rule.requiredArtifactMembers.join(", ")}`
            );
            return members;
          })()
        };
  return {
    ...source,
    role,
    rule,
    runId,
    runAttempt,
    workflowPath,
    headSha,
    artifact
  };
}

/**
 * Build the exact context that the isolated hosted job attests.
 *
 * All paths are trusted workflow-created temporary files. Every raw GitHub API
 * response and source artifact archive is retained byte-for-byte. The output
 * directory must not exist; its parent must already exist.
 */
export function createHostedEvidenceDirectory(input) {
  requireValue(isRecord(input), "hosted evidence create input must be an object");
  const profile = token(input.profile, "hosted evidence profile");
  const profileConfig = validateProfileSources(profile, input.sources);
  const outputDirectory = path.resolve(input.outputDirectory);
  const outputParent = realpathSync(path.dirname(outputDirectory));
  requireValue(
    outputParent === path.dirname(outputDirectory),
    "hosted evidence output parent must not traverse a symbolic link"
  );
  requireValue(
    !path.relative(outputParent, outputDirectory).includes(path.sep),
    "hosted evidence output must be a direct child of its trusted parent"
  );
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });

  const subjectPath = repositoryPath(
    input.subject?.repositoryPath,
    "hosted evidence subject repository path"
  );
  const subjectCommit = fullSha(
    input.subject?.commit,
    "hosted evidence subject commit"
  );
  const subjectBytes = readRegularNoFollow(
    input.subject?.filePath,
    MAX_SUBJECT_BYTES,
    "hosted evidence subject"
  );
  const subjectValue = strictJsonBytes(
    subjectBytes,
    "hosted evidence subject"
  ).value;
  const subjectSha256 = sha256HostedEvidence(subjectBytes);
  const subjectOutput = path.join(
    outputDirectory,
    HOSTED_EVIDENCE_SUBJECT_FILE
  );
  copyExclusive(subjectOutput, subjectBytes);

  const archiver = {
    repository: HOSTED_EVIDENCE_REPOSITORY,
    workflow: HOSTED_EVIDENCE_ARCHIVER_WORKFLOW,
    runId: positiveInteger(input.archiver?.runId, "archiver run id"),
    runAttempt: positiveInteger(
      input.archiver?.runAttempt,
      "archiver run attempt",
      100
    ),
    sourceCommit: fullSha(
      input.archiver?.sourceCommit,
      "archiver source commit"
    ),
    runnerEnvironment: input.archiver?.runnerEnvironment
  };
  requireValue(
    archiver.runnerEnvironment === "github-hosted",
    "hosted evidence archiver must run on a GitHub-hosted runner"
  );

  const fileEntries = [
    fileDescriptor(HOSTED_EVIDENCE_SUBJECT_FILE, subjectBytes)
  ];
  let retainedBytes = subjectBytes.byteLength;
  const sourceContexts = [];
  const semanticEvidence = [];
  for (const [index, rawSource] of input.sources.entries()) {
    const source = normalizeSourceInput(rawSource, profileConfig);
    const prefix = `sources/${String(index).padStart(2, "0")}-${source.role}`;
    const sourceDirectory = path.join(outputDirectory, ...prefix.split("/"));
    mkdirSync(sourceDirectory, { recursive: true, mode: 0o700 });
    const runBytes = readRegularNoFollow(
      source.runPath,
      MAX_API_JSON_BYTES,
      `${source.role} run metadata`
    );
    const run = strictJsonBytes(
      runBytes,
      `${source.role} run metadata`
    ).value;
    const event = validateRunMetadata(run, source, source.rule);

    const jobsPageBytes = source.jobsPagePaths.map((filePath, pageIndex) =>
      readRegularNoFollow(
        filePath,
        MAX_API_JSON_BYTES,
        `${source.role} jobs page ${pageIndex + 1}`
      )
    );
    const jobs = flattenedPageObjects(
      jobsPageBytes,
      "jobs",
      `${source.role} jobs`
    );
    const requiredJobs = validateJobs(jobs, source, source.rule);

    const artifactsPageBytes = source.artifactsPagePaths.map(
      (filePath, pageIndex) =>
        readRegularNoFollow(
          filePath,
          MAX_API_JSON_BYTES,
          `${source.role} artifacts page ${pageIndex + 1}`
        )
    );
    const artifacts = flattenedPageObjects(
      artifactsPageBytes,
      "artifacts",
      `${source.role} artifacts`
    );

    const sourceFiles = {
      run: `${prefix}/run.json`,
      jobsPages: [],
      artifactsPages: [],
      artifactMetadata: null,
      artifactArchive: null,
      artifactMembers: []
    };
    copyExclusive(path.join(outputDirectory, ...sourceFiles.run.split("/")), runBytes);
    fileEntries.push(fileDescriptor(sourceFiles.run, runBytes));
    retainedBytes += runBytes.byteLength;
    for (const [pageIndex, bytes] of jobsPageBytes.entries()) {
      const relative = `${prefix}/jobs-page-${String(pageIndex + 1).padStart(3, "0")}.json`;
      copyExclusive(path.join(outputDirectory, ...relative.split("/")), bytes);
      sourceFiles.jobsPages.push(relative);
      fileEntries.push(fileDescriptor(relative, bytes));
      retainedBytes += bytes.byteLength;
    }
    for (const [pageIndex, bytes] of artifactsPageBytes.entries()) {
      const relative = `${prefix}/artifacts-page-${String(pageIndex + 1).padStart(3, "0")}.json`;
      copyExclusive(path.join(outputDirectory, ...relative.split("/")), bytes);
      sourceFiles.artifactsPages.push(relative);
      fileEntries.push(fileDescriptor(relative, bytes));
      retainedBytes += bytes.byteLength;
    }

    let artifact = null;
    let semanticArchiveBytes = null;
    const retainedMembers = new Map();
    if (source.artifact) {
      const artifactMetadataBytes = readRegularNoFollow(
        source.artifactMetadataPath,
        MAX_API_JSON_BYTES,
        `${source.role} artifact metadata`
      );
      const artifactMetadata = strictJsonBytes(
        artifactMetadataBytes,
        `${source.role} artifact metadata`
      ).value;
      const archiveBytes = readRegularNoFollow(
        source.artifactArchivePath,
        HOSTED_EVIDENCE_MAX_ARCHIVE_BYTES,
        `${source.role} artifact archive`
      );
      semanticArchiveBytes = archiveBytes;
      artifact = validateArtifact({
        artifacts,
        artifactMetadata,
        archiveBytes,
        expected: source,
        rule: source.rule
      });
      const members = extractZipMembers(
        archiveBytes,
        source.artifact.members,
        source.rule.archivePolicy
      );
      sourceFiles.artifactMetadata = `${prefix}/artifact.json`;
      sourceFiles.artifactArchive = `${prefix}/artifact.zip`;
      copyExclusive(
        path.join(
          outputDirectory,
          ...sourceFiles.artifactMetadata.split("/")
        ),
        artifactMetadataBytes
      );
      copyExclusive(
        path.join(
          outputDirectory,
          ...sourceFiles.artifactArchive.split("/")
        ),
        archiveBytes
      );
      fileEntries.push(
        fileDescriptor(sourceFiles.artifactMetadata, artifactMetadataBytes),
        fileDescriptor(sourceFiles.artifactArchive, archiveBytes)
      );
      retainedBytes +=
        artifactMetadataBytes.byteLength + archiveBytes.byteLength;
      artifact.members = [];
      for (const [memberIndex, member] of members.entries()) {
        const relative =
          `${prefix}/members/${String(memberIndex).padStart(2, "0")}.bin`;
        mkdirSync(
          path.join(outputDirectory, ...`${prefix}/members`.split("/")),
          { recursive: true, mode: 0o700 }
        );
        copyExclusive(
          path.join(outputDirectory, ...relative.split("/")),
          member.bytes
        );
        const identity = {
          path: member.path,
          sha256: sha256HostedEvidence(member.bytes),
          sizeBytes: member.bytes.byteLength,
          file: relative
        };
        artifact.members.push(identity);
        retainedMembers.set(member.path, member.bytes);
        sourceFiles.artifactMembers.push(relative);
        fileEntries.push(fileDescriptor(relative, member.bytes));
        retainedBytes += member.bytes.byteLength;
      }
    } else {
      validateArtifact({
        artifacts,
        artifactMetadata: null,
        archiveBytes: null,
        expected: source,
        rule: source.rule
      });
    }
    requireValue(
      retainedBytes <= HOSTED_EVIDENCE_MAX_TOTAL_BYTES,
      `hosted evidence archive exceeds ${HOSTED_EVIDENCE_MAX_TOTAL_BYTES} retained bytes`
    );
    const sourceContext = {
      role: source.role,
      repository: HOSTED_EVIDENCE_REPOSITORY,
      workflowPath: source.workflowPath,
      runId: source.runId,
      runAttempt: source.runAttempt,
      event,
      headBranch: "main",
      headSha: source.headSha,
      conclusion: "success",
      requiredJobs,
      artifact,
      files: sourceFiles
    };
    sourceContexts.push(sourceContext);
    semanticEvidence.push({
      role: source.role,
      context: sourceContext,
      run,
      jobs,
      artifacts,
      members: retainedMembers,
      archiveBytes: semanticArchiveBytes
    });
  }

  const context = {
    schemaVersion: HOSTED_EVIDENCE_CONTEXT_VERSION,
    artifactKind: HOSTED_EVIDENCE_CONTEXT_KIND,
    profile,
    recordedAt: canonicalInstant(input.recordedAt, "hosted evidence recordedAt"),
    archiver,
    subject: {
      repositoryPath: subjectPath,
      commit: subjectCommit,
      sha256: subjectSha256,
      sizeBytes: subjectBytes.byteLength,
      file: HOSTED_EVIDENCE_SUBJECT_FILE
    },
    sources: sourceContexts,
    files: fileEntries.sort((left, right) =>
      left.path.localeCompare(right.path)
    ),
    contextDigest: ""
  };
  validateSubjectSemantics(
    profile,
    subjectValue,
    subjectBytes,
    context,
    semanticEvidence,
    input.repositoryRoot ?? process.cwd()
  );
  context.contextDigest = hostedEvidenceContextDigest(context);
  const contextBytes = Buffer.from(
    `${canonicalHostedEvidenceJson(context)}\n`,
    "utf8"
  );
  requireValue(
    retainedBytes + contextBytes.byteLength <=
      HOSTED_EVIDENCE_MAX_TOTAL_BYTES,
    `hosted evidence context exceeds ${HOSTED_EVIDENCE_MAX_TOTAL_BYTES} retained bytes`
  );
  copyExclusive(
    path.join(outputDirectory, HOSTED_EVIDENCE_CONTEXT_FILE),
    contextBytes
  );
  return {
    outputDirectory,
    relativePath: hostedEvidenceArchiveRelativePath(
      profile,
      subjectSha256
    ),
    context,
    contextSha256: sha256HostedEvidence(contextBytes),
    contextDigest: context.contextDigest,
    subjectSha256,
    retainedBytes: retainedBytes + contextBytes.byteLength
  };
}

function parseContext(text) {
  let context;
  try {
    context = JSON.parse(text);
  } catch {
    throw new Error("hosted evidence context is not valid JSON");
  }
  requireValue(
    text === `${canonicalHostedEvidenceJson(context)}\n`,
    "hosted evidence context is not canonical JSON"
  );
  exactKeys(
    context,
    [
      "schemaVersion",
      "artifactKind",
      "profile",
      "recordedAt",
      "archiver",
      "subject",
      "sources",
      "files",
      "contextDigest"
    ],
    "hosted evidence context"
  );
  requireValue(
    context.schemaVersion === HOSTED_EVIDENCE_CONTEXT_VERSION &&
      context.artifactKind === HOSTED_EVIDENCE_CONTEXT_KIND,
    "hosted evidence context schema identity is invalid"
  );
  profileRule(context.profile);
  canonicalInstant(context.recordedAt, "hosted evidence recordedAt");
  exactKeys(
    context.archiver,
    [
      "repository",
      "workflow",
      "runId",
      "runAttempt",
      "sourceCommit",
      "runnerEnvironment"
    ],
    "hosted evidence archiver"
  );
  requireValue(
    context.archiver.repository === HOSTED_EVIDENCE_REPOSITORY &&
      context.archiver.workflow === HOSTED_EVIDENCE_ARCHIVER_WORKFLOW &&
      context.archiver.runnerEnvironment === "github-hosted",
    "hosted evidence archiver identity is invalid"
  );
  positiveInteger(context.archiver.runId, "archiver run id");
  positiveInteger(context.archiver.runAttempt, "archiver run attempt", 100);
  fullSha(context.archiver.sourceCommit, "archiver source commit");
  exactKeys(
    context.subject,
    ["repositoryPath", "commit", "sha256", "sizeBytes", "file"],
    "hosted evidence subject"
  );
  repositoryPath(
    context.subject.repositoryPath,
    "hosted evidence subject repository path"
  );
  fullSha(context.subject.commit, "hosted evidence subject commit");
  digest(context.subject.sha256, "hosted evidence subject digest");
  positiveInteger(context.subject.sizeBytes, "hosted evidence subject size");
  requireValue(
    context.subject.file === HOSTED_EVIDENCE_SUBJECT_FILE,
    "hosted evidence subject file is invalid"
  );
  requireValue(
    context.contextDigest === hostedEvidenceContextDigest(context),
    "hosted evidence context digest does not recompute"
  );
  validateProfileSources(context.profile, context.sources);
  requireValue(
    Array.isArray(context.files) &&
      context.files.length > 0 &&
      context.files.length <= 64,
    "hosted evidence files must be a bounded non-empty array"
  );
  let priorPath = "";
  const paths = new Set();
  let total = 0;
  for (const [index, file] of context.files.entries()) {
    exactKeys(file, ["path", "sha256", "sizeBytes"], `files[${index}]`);
    repositoryPath(file.path, `files[${index}].path`);
    requireValue(
      file.path > priorPath && !paths.has(file.path),
      "hosted evidence files must be uniquely sorted by path"
    );
    paths.add(file.path);
    priorPath = file.path;
    digest(file.sha256, `files[${index}].sha256`);
    positiveInteger(file.sizeBytes, `files[${index}].sizeBytes`);
    total += file.sizeBytes;
  }
  requireValue(
    total <= HOSTED_EVIDENCE_MAX_TOTAL_BYTES,
    "hosted evidence declared files exceed the aggregate byte bound"
  );
  return context;
}

export function parseAndVerifyHostedEvidenceContext(text, options = {}) {
  const issues = [];
  let context = null;
  try {
    context = parseContext(text);
    if (
      options.expectedProfile !== undefined &&
      context.profile !== options.expectedProfile
    ) {
      throw new Error("hosted evidence profile does not match expectedProfile");
    }
    if (
      options.expectedSubjectPath !== undefined &&
      context.subject.repositoryPath !== options.expectedSubjectPath
    ) {
      throw new Error(
        "hosted evidence subject path does not match expectedSubjectPath"
      );
    }
    if (
      options.expectedSubjectSha256 !== undefined &&
      context.subject.sha256 !== options.expectedSubjectSha256
    ) {
      throw new Error(
        "hosted evidence subject digest does not match expectedSubjectSha256"
      );
    }
    if (
      options.expectedSubjectCommit !== undefined &&
      context.subject.commit !== options.expectedSubjectCommit
    ) {
      throw new Error(
        "hosted evidence subject commit does not match expectedSubjectCommit"
      );
    }
    compareExpectedSources(context.sources, options.expectedSources);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return { ok: issues.length === 0, issues, context };
}

function compareExpectedSources(actualSources, expectedSources) {
  if (expectedSources === undefined) return;
  requireValue(
    Array.isArray(expectedSources),
    "expectedSources must be an array"
  );
  requireValue(
    actualSources.length === expectedSources.length,
    "hosted evidence sources do not match expectedSources length"
  );
  for (const [index, expected] of expectedSources.entries()) {
    const actual = actualSources[index];
    for (const field of [
      "role",
      "workflowPath",
      "runId",
      "runAttempt",
      "headSha",
      "event"
    ]) {
      if (expected[field] !== undefined) {
        requireValue(
          actual[field] === expected[field],
          `hosted evidence source ${index} ${field} does not match expectedSources`
        );
      }
    }
    if (expected.artifactId !== undefined) {
      requireValue(
        actual.artifact?.id === expected.artifactId,
        `hosted evidence source ${index} artifact id does not match expectedSources`
      );
    }
    if (expected.artifactName !== undefined) {
      requireValue(
        actual.artifact?.name === expected.artifactName,
        `hosted evidence source ${index} artifact name does not match expectedSources`
      );
    }
    if (expected.artifactSha256 !== undefined) {
      requireValue(
        actual.artifact?.sha256 === expected.artifactSha256,
        `hosted evidence source ${index} artifact digest does not match expectedSources`
      );
    }
    if (expected.artifactMembers !== undefined) {
      requireValue(
        Array.isArray(expected.artifactMembers),
        `hosted evidence source ${index} expected artifactMembers must be an array`
      );
      for (const [memberIndex, expectedMember] of expected.artifactMembers.entries()) {
        const actualMember = actual.artifact?.members?.[memberIndex];
        requireValue(
          actualMember?.path === expectedMember.path &&
            (expectedMember.sha256 === undefined ||
              actualMember.sha256 === expectedMember.sha256),
          `hosted evidence source ${index} artifact member ${memberIndex} does not match expectedSources`
        );
      }
      requireValue(
        actual.artifact?.members?.length === expected.artifactMembers.length,
        `hosted evidence source ${index} artifact member count does not match expectedSources`
      );
    }
    if (expected.requiredJobNames !== undefined) {
      requireValue(
        JSON.stringify(
          actual.requiredJobs.map((job) => job.name).sort()
        ) === JSON.stringify([...expected.requiredJobNames].sort()),
        `hosted evidence source ${index} jobs do not match expectedSources`
      );
    }
  }
}

function safeDirectory(rootDir, directory) {
  const root = realpathSync(path.resolve(rootDir));
  const resolved = realpathSync(path.resolve(directory));
  const relative = path.relative(root, resolved);
  requireValue(
    relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    "hosted evidence directory must stay inside the repository root"
  );
  return { root, resolved };
}

function regularFileInside(directory, relativePath, maximumBytes, label) {
  repositoryPath(relativePath, label);
  const candidate = path.resolve(directory, ...relativePath.split("/"));
  const relative = path.relative(directory, candidate);
  requireValue(
    relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    `${label} escapes its archive`
  );
  return readRegularNoFollow(candidate, maximumBytes, label);
}

function verifyRawDirectory(directory, context, repositoryRoot) {
  const allowed = new Set([
    HOSTED_EVIDENCE_CONTEXT_FILE,
    HOSTED_EVIDENCE_BUNDLE_FILE,
    ...context.files.map((file) => file.path)
  ]);
  const discovered = walkRegularFiles(directory);
  requireValue(
    JSON.stringify(discovered) === JSON.stringify([...allowed].sort()),
    "hosted evidence directory contains missing or unenumerated files"
  );
  let total = 0;
  const byPath = new Map();
  for (const file of context.files) {
    const maximum =
      file.path.endsWith("/artifact.zip")
        ? HOSTED_EVIDENCE_MAX_ARCHIVE_BYTES
        : file.path.includes("/members/")
          ? MAX_MEMBER_BYTES
        : file.path === HOSTED_EVIDENCE_SUBJECT_FILE
          ? MAX_SUBJECT_BYTES
          : MAX_API_JSON_BYTES;
    const bytes = regularFileInside(
      directory,
      file.path,
      maximum,
      `hosted evidence file ${file.path}`
    );
    requireValue(
      bytes.byteLength === file.sizeBytes &&
        sha256HostedEvidence(bytes) === file.sha256,
      `hosted evidence file ${file.path} does not match its exact bytes`
    );
    total += bytes.byteLength;
    byPath.set(file.path, bytes);
  }
  requireValue(
    total <= HOSTED_EVIDENCE_MAX_TOTAL_BYTES,
    "hosted evidence raw files exceed the aggregate byte bound"
  );
  const subjectBytes = byPath.get(HOSTED_EVIDENCE_SUBJECT_FILE);
  const subject = strictJsonBytes(
    subjectBytes,
    "hosted evidence subject"
  ).value;
  requireValue(
    subjectBytes.byteLength === context.subject.sizeBytes &&
      sha256HostedEvidence(subjectBytes) === context.subject.sha256,
    "hosted evidence subject does not match the context"
  );

  const profileConfig = validateProfileSources(
    context.profile,
    context.sources
  );
  const semanticEvidence = [];
  for (const source of context.sources) {
    const rule = profileConfig.sources[source.role];
    const runBytes = byPath.get(source.files.run);
    const run = strictJsonBytes(
      runBytes,
      `${source.role} retained run metadata`
    ).value;
    validateRunMetadata(run, source, rule);
    const jobsBytes = source.files.jobsPages.map((file) => byPath.get(file));
    const jobs = flattenedPageObjects(
      jobsBytes,
      "jobs",
      `${source.role} retained jobs`
    );
    const jobsIdentity = validateJobs(jobs, source, rule);
    requireValue(
      canonicalHostedEvidenceJson(jobsIdentity) ===
        canonicalHostedEvidenceJson(source.requiredJobs),
      `${source.role} retained jobs do not match the context`
    );
    const artifactsBytes = source.files.artifactsPages.map((file) =>
      byPath.get(file)
    );
    const artifacts = flattenedPageObjects(
      artifactsBytes,
      "artifacts",
      `${source.role} retained artifacts`
    );
    const members = new Map();
    let semanticArchiveBytes = null;
    if (source.artifact) {
      const artifactMetadata = strictJsonBytes(
        byPath.get(source.files.artifactMetadata),
        `${source.role} retained artifact metadata`
      ).value;
      const archiveBytes = byPath.get(source.files.artifactArchive);
      semanticArchiveBytes = archiveBytes;
      const identity = validateArtifact({
        artifacts,
        artifactMetadata,
        archiveBytes,
        expected: {
          ...source,
          artifact: {
            id: source.artifact.id,
            name: source.artifact.name,
            sha256: source.artifact.sha256
          }
        },
        rule
      });
      const extractedMembers = extractZipMembers(
        archiveBytes,
        source.artifact.members.map((member) => member.path),
        rule.archivePolicy
      );
      requireValue(
        extractedMembers.length === source.artifact.members.length &&
          source.files.artifactMembers.length ===
            source.artifact.members.length,
        `${source.role} artifact member set is incomplete`
      );
      for (const [index, member] of extractedMembers.entries()) {
        const retained = byPath.get(source.files.artifactMembers[index]);
        const declared = source.artifact.members[index];
        requireValue(
          member.path === declared.path &&
            retained.equals(member.bytes) &&
            retained.byteLength === declared.sizeBytes &&
            sha256HostedEvidence(retained) === declared.sha256 &&
            declared.file === source.files.artifactMembers[index],
          `${source.role} artifact member ${index + 1} does not match the retained ZIP`
        );
        members.set(member.path, retained);
      }
      const declaredArtifactIdentity = { ...source.artifact };
      delete declaredArtifactIdentity.members;
      requireValue(
        canonicalHostedEvidenceJson(identity) ===
          canonicalHostedEvidenceJson(declaredArtifactIdentity),
        `${source.role} retained artifact does not match the context`
      );
    } else {
      requireValue(
        source.files.artifactMetadata === null &&
          source.files.artifactArchive === null &&
          Array.isArray(source.files.artifactMembers) &&
          source.files.artifactMembers.length === 0 &&
          rule.artifactRequired === false,
        `${source.role} artifact omission is invalid`
      );
    }
    semanticEvidence.push({
      role: source.role,
      context: source,
      run,
      jobs,
      artifacts,
      members,
      archiveBytes: semanticArchiveBytes
    });
  }
  validateSubjectSemantics(
    context.profile,
    subject,
    subjectBytes,
    context,
    semanticEvidence,
    repositoryRoot
  );
  return { subjectBytes, totalBytes: total };
}

function walkRegularFiles(root) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      requireValue(
        !entry.isSymbolicLink(),
        "hosted evidence archive must not contain symbolic links"
      );
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(directory, entry.name), relative);
      } else {
        requireValue(
          entry.isFile(),
          "hosted evidence archive must contain only directories and regular files"
        );
        files.push(relative);
      }
    }
  };
  walk(root, "");
  return files.sort();
}

export function hostedEvidenceAttestationVerifyArgs(request) {
  return [
    "attestation",
    "verify",
    request.contextPath,
    "--bundle",
    request.bundlePath,
    "--repo",
    HOSTED_EVIDENCE_REPOSITORY,
    "--cert-identity",
    `https://github.com/${HOSTED_EVIDENCE_ARCHIVER_WORKFLOW}`,
    "--signer-digest",
    request.expectedArchiverCommit,
    "--source-digest",
    request.expectedArchiverCommit,
    "--source-ref",
    "refs/heads/main",
    "--predicate-type",
    "https://slsa.dev/provenance/v1",
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--deny-self-hosted-runners",
    "--format",
    "json"
  ];
}

export function verifyHostedEvidenceAttestation(request) {
  fullSha(
    request.expectedArchiverCommit,
    "expected hosted evidence archiver commit"
  );
  const rootDir = path.resolve(
    request.rootDir ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  );
  const exec = request.execFileSync ?? nodeExecFileSync;
  const gh =
    request.ghPath ??
    exec(
      process.execPath,
      [path.join(rootDir, "scripts", "ensure-gh-attestation-verifier.mjs")],
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        timeout: 60_000,
        maxBuffer: 1024 * 1024
      }
    ).trim();
  requireValue(path.isAbsolute(gh), "attestation verifier path must be absolute");
  const output = exec(
    gh,
    hostedEvidenceAttestationVerifyArgs(request),
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 120_000,
      maxBuffer: MAX_BUNDLE_BYTES
    }
  );
  let verified;
  try {
    verified = JSON.parse(output);
  } catch {
    throw new Error("hosted evidence attestation verifier returned invalid JSON");
  }
  requireValue(
    Array.isArray(verified) && verified.length > 0,
    "hosted evidence attestation verifier returned no verified result"
  );
  return { status: "verified-by-gh-attestation", results: verified.length };
}

export function verifyHostedEvidenceDirectory(input) {
  const issues = [];
  let result = null;
  try {
    const { root, resolved } = safeDirectory(input.rootDir, input.directory);
    const contextBytes = readRegularNoFollow(
      path.join(resolved, HOSTED_EVIDENCE_CONTEXT_FILE),
      MAX_API_JSON_BYTES,
      "hosted evidence context"
    );
    const contextText = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true
    }).decode(contextBytes);
    const parsed = parseAndVerifyHostedEvidenceContext(contextText, input);
    requireValue(parsed.ok, parsed.issues.join("; "));
    const context = parsed.context;
    const expectedDirectory = path.join(
      root,
      ...hostedEvidenceArchiveRelativePath(
        context.profile,
        context.subject.sha256
      ).split("/")
    );
    requireValue(
      resolved === expectedDirectory,
      "hosted evidence directory is not its digest-addressed canonical path"
    );
    const raw = verifyRawDirectory(resolved, context, root);
    const bundleBytes = readRegularNoFollow(
      path.join(resolved, HOSTED_EVIDENCE_BUNDLE_FILE),
      MAX_BUNDLE_BYTES,
      "hosted evidence Sigstore bundle"
    );
    strictJsonBytes(bundleBytes, "hosted evidence Sigstore bundle");
    requireValue(
      raw.totalBytes + contextBytes.byteLength + bundleBytes.byteLength <=
        HOSTED_EVIDENCE_MAX_TOTAL_BYTES,
      "hosted evidence context, bundle, and raw files exceed the aggregate byte bound"
    );
    requireValue(
      context.archiver.sourceCommit === input.expectedArchiverCommit,
      "hosted evidence archiver commit does not match the release expectation"
    );
    const verifier =
      input.attestationVerifier ??
      ((request) => verifyHostedEvidenceAttestation(request));
    const attestation = verifier({
      rootDir: root,
      contextPath: path.join(resolved, HOSTED_EVIDENCE_CONTEXT_FILE),
      bundlePath: path.join(resolved, HOSTED_EVIDENCE_BUNDLE_FILE),
      expectedArchiverCommit: input.expectedArchiverCommit
    });
    requireValue(
      isRecord(attestation) &&
        attestation.status === "verified-by-gh-attestation",
      "hosted evidence attestation verifier did not return a verified status"
    );
    result = {
      ok: true,
      issues: [],
      profile: context.profile,
      context,
      contextSha256: sha256HostedEvidence(contextBytes),
      contextDigest: context.contextDigest,
      subject: JSON.parse(raw.subjectBytes.toString("utf8")),
      subjectSha256: context.subject.sha256,
      archiver: context.archiver,
      sources: context.sources,
      bundleSha256: sha256HostedEvidence(bundleBytes),
      attestation
    };
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return (
    result ?? {
      ok: false,
      issues,
      profile: null,
      context: null,
      contextSha256: null,
      contextDigest: null,
      subject: null,
      subjectSha256: null,
      archiver: null,
      sources: [],
      bundleSha256: null,
      attestation: null
    }
  );
}
