import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import {
  serializeStagingTeardownEvidence,
  validateStagingTeardownEvidence
} from "./staging-teardown-evidence-lib.mjs";
import { serializeCanonicalEvidence } from "./operator-evidence-common.mjs";

export const STAGING_TEARDOWN_HOSTED_MANIFEST_KIND =
  "site-behavior-staging-teardown-sanitized-provider-manifest";
export const STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_KIND =
  "site-behavior-staging-teardown-producer-closure";
export const STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS =
  Object.freeze([
    ".github/workflows/staging-teardown-evidence.yml",
    "lib/canonical-json.ts",
    "lib/sha256.ts",
    "package-lock.json",
    "package.json",
    "scripts/operator-evidence-common.mjs",
    "scripts/staging-teardown-evidence-lib.mjs",
    "scripts/staging-teardown-hosted-capture-lib.mjs",
    "scripts/staging-teardown-hosted-capture.mjs",
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
    schemaVersion: 1,
    artifactKind: STAGING_TEARDOWN_HOSTED_MANIFEST_KIND,
    stagingSourceCommit: receipt.stagingSourceCommit,
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
    receiptSha256: sha256(receiptBytes)
  };
}
