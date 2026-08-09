import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import {
  buildStagingTeardownEvidence,
  STAGING_RESOURCE_CONTRACT,
  serializeStagingTeardownEvidence,
  validateStagingTeardownEvidence
} from "./staging-teardown-evidence-lib.mjs";
import {
  serializeCanonicalEvidence,
  sha256Bytes
} from "./operator-evidence-common.mjs";
import {
  resolveStagingTeardownProviderAdapter,
  runStagingTeardown
} from "./staging-teardown-provider-adapter.mjs";
import {
  parseStagingTeardownTargetManifest,
  STAGING_TEARDOWN_COMPOSITE_ADAPTER_KIND
} from "./staging-teardown-provider-adapters.mjs";
import {
  createStagingTeardownGitHubAppTokenProvider
} from "./staging-teardown-github-app-token.mjs";

export const STAGING_TEARDOWN_HOSTED_MANIFEST_KIND =
  "site-behavior-staging-teardown-sanitized-provider-manifest";
export const STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_KIND =
  "site-behavior-staging-teardown-producer-closure";
export const STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS =
  Object.freeze([
    ".github/workflows/staging-teardown-evidence.yml",
    "lib/canonical-json.ts",
    "lib/sha256.ts",
    "lib/strict-json.ts",
    "package-lock.json",
    "package.json",
    "scripts/operator-evidence-common.mjs",
    "scripts/staging-teardown-evidence-lib.mjs",
    "scripts/staging-teardown-github-app-token.mjs",
    "scripts/staging-teardown-hosted-capture-lib.mjs",
    "scripts/staging-teardown-hosted-capture.mjs",
    "scripts/staging-teardown-provider-adapter.mjs",
    "scripts/staging-teardown-provider-adapters.mjs",
    "scripts/staging-teardown-provider-http.mjs",
    "scripts/staging-teardown-target-projections.mjs",
    "tsconfig.json",
    "tsconfig.schema.json"
  ]);
export const STAGING_TEARDOWN_HOSTED_SAFE_FILES = Object.freeze([
  "receipt.json",
  "sanitized-provider-manifest.json"
]);
export const STAGING_TEARDOWN_HOSTED_PRODUCER_FILE_MAX_BYTES =
  1024 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  requireValue(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value),
    `${label} must be an object`
  );
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireValue(
    actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]),
    `${label} must contain exactly ${wanted.join(", ")}`
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function required(env, name) {
  const value = env[name];
  requireValue(
    typeof value === "string" && value.length >= 1,
    `${name} is required`
  );
  return value;
}

export function requiredHostedStagingTeardownEnvironment(env) {
  requireValue(
    env !== null && typeof env === "object",
    "staging teardown hosted environment must be an object"
  );
  const githubSha = required(env, "GITHUB_SHA");
  requireValue(/^[0-9a-f]{40}$/.test(githubSha), "GITHUB_SHA must be a full lowercase commit");
  requireValue(
    required(env, "GITHUB_REPOSITORY") === "iAnonymous3000/site-behavior-lab",
    "GITHUB_REPOSITORY must be the canonical repository"
  );
  requireValue(
    required(env, "GITHUB_REF") === "refs/heads/main",
    "staging teardown capture may run only from refs/heads/main"
  );
  const providerKind = required(env, "STAGING_TEARDOWN_PROVIDER_KIND");
  requireValue(
    providerKind === STAGING_TEARDOWN_COMPOSITE_ADAPTER_KIND,
    `STAGING_TEARDOWN_PROVIDER_KIND must be exactly ${STAGING_TEARDOWN_COMPOSITE_ADAPTER_KIND}`
  );
  const targetJson = required(env, "STAGING_TEARDOWN_TARGETS_JSON");
  const targetSha256 = required(env, "STAGING_TEARDOWN_TARGETS_SHA256");
  const targetManifest = parseStagingTeardownTargetManifest(targetJson, githubSha);
  requireValue(
    /^[0-9a-f]{64}$/.test(targetSha256) &&
      sha256Bytes(serializeCanonicalEvidence(targetManifest)) === targetSha256,
    "STAGING_TEARDOWN_TARGETS_SHA256 must bind the canonical strict target manifest"
  );
  const cloudflareAccountId = required(env, "CLOUDFLARE_ACCOUNT_ID");
  const cloudflareZoneId = required(env, "STAGING_TEARDOWN_CF_ZONE_ID");
  requireValue(
    /^[0-9a-f]{32}$/.test(cloudflareAccountId) &&
      targetManifest.cloudflare.accountId === cloudflareAccountId,
    "CLOUDFLARE_ACCOUNT_ID must exactly match the target manifest"
  );
  requireValue(
    /^[0-9a-f]{32}$/.test(cloudflareZoneId) &&
      targetManifest.cloudflare.zoneId === cloudflareZoneId,
    "STAGING_TEARDOWN_CF_ZONE_ID must exactly match the target manifest"
  );
  return {
    githubSha,
    providerKind,
    targetManifest,
    targetManifestSha256: targetSha256,
    cloudflareAccountId,
    cloudflareZoneId,
    githubApp: {
      clientId: required(env, "STAGING_TEARDOWN_RUNNER_APP_CLIENT_ID"),
      privateKey: required(env, "STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY")
    },
    credentials: {
      cloudflareComputeToken: required(env, "STAGING_TEARDOWN_CF_COMPUTE_TOKEN"),
      cloudflareDnsToken: required(env, "STAGING_TEARDOWN_CF_DNS_TOKEN"),
      cloudflareR2Token: required(env, "STAGING_TEARDOWN_CF_R2_TOKEN"),
      cloudflareTokenAdminToken: required(env, "STAGING_TEARDOWN_CF_TOKEN_ADMIN_TOKEN"),
      cloudflareObservationToken: required(env, "STAGING_TEARDOWN_CF_OBSERVATION_TOKEN")
    }
  };
}

export async function withStagingTeardownGitHubTokenCleanup(
  githubTokenProvider,
  operation
) {
  requireValue(
    githubTokenProvider !== null && typeof githubTokenProvider === "object" &&
      typeof githubTokenProvider.revoke === "function",
    "staging teardown GitHub token cleanup requires a revocable provider"
  );
  requireValue(
    typeof operation === "function",
    "staging teardown GitHub token cleanup requires an operation"
  );
  try {
    return await operation();
  } finally {
    // The action must not leave repository-Administration credentials live.
    // This runs after success and partial failure; a failed DELETE prevents
    // any safe evidence artifact from forming.
    await githubTokenProvider.revoke();
  }
}

/**
 * Execute the exact hosted ceremony and return only safe, rederived objects.
 * Raw provider responses are routed solely to persistRaw by the bounded HTTP
 * clients. The exact transient transcript is zeroed after receipt derivation.
 */
export async function captureHostedStagingTeardownEvidence({
  environment,
  persistRaw,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  randomUUID
}) {
  requireValue(
    environment !== null && typeof environment === "object",
    "staging teardown capture requires a validated environment"
  );
  requireValue(typeof persistRaw === "function", "staging teardown capture requires a private raw sink");
  requireValue(typeof fetchImpl === "function", "staging teardown capture requires fetch");
  requireValue(typeof now === "function", "staging teardown capture requires a clock");
  requireValue(typeof randomUUID === "function", "staging teardown capture requires a UUID generator");
  const sessionId = randomUUID();
  requireValue(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId),
    "staging teardown UUID generator must return a canonical lowercase UUIDv4"
  );
  const targetManifestSha256 = sha256Bytes(
    serializeCanonicalEvidence(environment.targetManifest)
  );
  requireValue(
    environment.targetManifestSha256 === targetManifestSha256,
    "staging teardown target manifest changed after environment validation"
  );
  const githubTokenProvider =
    createStagingTeardownGitHubAppTokenProvider({
      clientId: environment.githubApp.clientId,
      privateKey: environment.githubApp.privateKey,
      repository: environment.targetManifest.github.repository,
      fetchImpl,
      persistRaw,
      now
    });
  const adapter = resolveStagingTeardownProviderAdapter(environment.providerKind, {
    targetManifest: environment.targetManifest,
    trustedCommit: environment.githubSha,
    trustedCloudflareAccountId: environment.cloudflareAccountId,
    trustedCloudflareZoneId: environment.cloudflareZoneId,
    credentials: {
      ...environment.credentials,
      githubRunnerAdminTokenProvider: githubTokenProvider.getToken
    },
    sessionId,
    fetchImpl,
    persistRaw
  });
  const providerTranscript = await withStagingTeardownGitHubTokenCleanup(
    githubTokenProvider,
    () => runStagingTeardown({
      adapter,
      resources: STAGING_RESOURCE_CONTRACT,
      session: { id: sessionId },
      stagingSourceCommit: environment.githubSha,
      now
    })
  );
  // Preserve only the non-secret digest of the already-validated canonical
  // target manifest. The raw target JSON remains an ephemeral ceremony input
  // and is never copied into either safe artifact.
  const transcript = {
    ...providerTranscript,
    targetManifestSha256
  };
  const transcriptBytes = Buffer.from(serializeCanonicalEvidence(transcript), "utf8");
  let receipt;
  try {
    receipt = buildStagingTeardownEvidence({ sourceBytes: transcriptBytes });
  } finally {
    transcriptBytes.fill(0);
  }
  const producerClosure = stagingTeardownHostedProducerClosureFromDirectory();
  return {
    receipt,
    manifest: buildStagingTeardownHostedManifest(receipt, producerClosure)
  };
}

function parseUtf8Json(bytes, label) {
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
  return value;
}

export function buildStagingTeardownHostedProducerClosure(
  readSourceBytes
) {
  requireValue(
    typeof readSourceBytes === "function",
    "staging teardown producer closure requires a source-byte reader"
  );
  return {
    schemaVersion: 1,
    artifactKind:
      STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_KIND,
    files: STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS.map(
      (repositoryPath) => {
        const value = readSourceBytes(repositoryPath);
        requireValue(
          Buffer.isBuffer(value) || value instanceof Uint8Array,
          `staging teardown producer closure ${repositoryPath} must resolve to exact bytes`
        );
        const bytes = Buffer.from(
          value.buffer,
          value.byteOffset,
          value.byteLength
        );
        requireValue(
          bytes.byteLength >= 1 &&
            bytes.byteLength <=
              STAGING_TEARDOWN_HOSTED_PRODUCER_FILE_MAX_BYTES,
          `staging teardown producer closure ${repositoryPath} must contain 1 through ${STAGING_TEARDOWN_HOSTED_PRODUCER_FILE_MAX_BYTES} bytes`
        );
        return {
          path: repositoryPath,
          sha256: sha256(bytes)
        };
      }
    )
  };
}

export function validateStagingTeardownHostedProducerClosure(value) {
  exactKeys(
    value,
    ["schemaVersion", "artifactKind", "files"],
    "staging teardown producer closure"
  );
  requireValue(
    value.schemaVersion === 1 &&
      value.artifactKind ===
        STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_KIND,
    "staging teardown producer closure has the wrong identity"
  );
  requireValue(
    Array.isArray(value.files) &&
      value.files.length ===
        STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS.length,
    "staging teardown producer closure must enumerate the exact source path set"
  );
  for (const [index, expectedPath] of
    STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS.entries()) {
    const entry = value.files[index];
    exactKeys(
      entry,
      ["path", "sha256"],
      `staging teardown producer closure file ${index}`
    );
    requireValue(
      entry.path === expectedPath &&
        typeof entry.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(entry.sha256),
      `staging teardown producer closure file ${index} must bind ${expectedPath}`
    );
  }
  return value;
}

export function stagingTeardownHostedProducerClosureFromDirectory(
  repositoryRoot = process.cwd()
) {
  const root = realpathSync(path.resolve(repositoryRoot));
  return buildStagingTeardownHostedProducerClosure((repositoryPath) => {
    const absolute = path.join(root, ...repositoryPath.split("/"));
    const info = lstatSync(absolute);
    requireValue(
      info.isFile() && !info.isSymbolicLink(),
      `staging teardown producer closure ${repositoryPath} must be a regular file`
    );
    const resolved = realpathSync(absolute);
    requireValue(
      path.relative(root, resolved) === repositoryPath,
      `staging teardown producer closure ${repositoryPath} must not traverse a symbolic link`
    );
    return readFileSync(resolved);
  });
}

export function buildStagingTeardownHostedManifest(
  receipt,
  producerClosure
) {
  const verdict = validateStagingTeardownEvidence(receipt);
  requireValue(
    verdict.ok,
    `hosted staging teardown receipt is invalid: ${verdict.problems.join("; ")}`
  );
  return {
    schemaVersion: 2,
    artifactKind: STAGING_TEARDOWN_HOSTED_MANIFEST_KIND,
    stagingSourceCommit: receipt.stagingSourceCommit,
    targetManifestSha256: receipt.targetManifestSha256,
    recordedAt: receipt.recordedAt,
    session: receipt.session,
    inventory: receipt.inventory,
    sourceArtifact: receipt.sourceArtifact,
    producerClosure:
      validateStagingTeardownHostedProducerClosure(producerClosure),
    teardownInventoryDigest: receipt.teardownInventoryDigest
  };
}

export function verifyStagingTeardownHostedSafeDirectory(
  directory,
  { repositoryRoot = process.cwd() } = {}
) {
  const entries = readdirSync(directory, { withFileTypes: true });
  requireValue(
    entries.every((entry) => entry.isFile()) &&
      JSON.stringify(entries.map((entry) => entry.name).sort()) ===
        JSON.stringify([...STAGING_TEARDOWN_HOSTED_SAFE_FILES]),
    "staging teardown hosted output must contain only receipt.json and sanitized-provider-manifest.json"
  );
  for (const entry of entries) {
    requireValue(
      lstatSync(path.join(directory, entry.name)).isFile(),
      "staging teardown hosted output members must be regular files"
    );
  }
  const receiptBytes = readFileSync(path.join(directory, "receipt.json"));
  const manifestBytes = readFileSync(
    path.join(directory, "sanitized-provider-manifest.json")
  );
  const receipt = parseUtf8Json(
    receiptBytes,
    "staging teardown receipt"
  );
  const verdict = validateStagingTeardownEvidence(receipt);
  requireValue(verdict.ok, verdict.problems.join("; "));
  requireValue(
    Buffer.from(
      serializeStagingTeardownEvidence(receipt),
      "utf8"
    ).equals(receiptBytes),
    "staging teardown receipt bytes are not canonical"
  );
  const manifest = parseUtf8Json(
    manifestBytes,
    "staging teardown sanitized provider manifest"
  );
  const expectedManifest = buildStagingTeardownHostedManifest(
    receipt,
    stagingTeardownHostedProducerClosureFromDirectory(repositoryRoot)
  );
  requireValue(
    serializeCanonicalEvidence(manifest) ===
      serializeCanonicalEvidence(expectedManifest) &&
      Buffer.from(
        serializeCanonicalEvidence(manifest),
        "utf8"
      ).equals(manifestBytes),
    "staging teardown sanitized provider manifest does not canonically rederive the receipt and exact producer closure"
  );
  return {
    ok: true,
    stagingSourceCommit: receipt.stagingSourceCommit,
    targetManifestSha256: receipt.targetManifestSha256,
    receiptSha256: sha256(receiptBytes)
  };
}
