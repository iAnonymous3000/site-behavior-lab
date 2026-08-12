import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  releaseTagGovernanceReceiptFreshnessProblems,
  releaseTagGovernanceReceiptPath,
  releaseTagGovernanceReceiptProblems,
  serializeReleaseTagGovernanceReceipt
} from "./release-tag-governance-receipt-lib.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;

function git(rootDir, args, { encoding = "utf8", maxBuffer = MAX_RECEIPT_BYTES } = {}) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding,
    maxBuffer,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function decodeJson(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} contains non-UTF-8 bytes`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  return { text, value };
}

/**
 * Verify the cheap, read-only half of the release-governance selection before
 * a workflow enters the protected release-tag environment. The privileged tag
 * job still re-fetches and independently validates live App and ruleset state.
 */
export function verifyReleaseGovernanceSelection({
  rootDir,
  commit,
  receiptSha256,
  now = Date.now()
}) {
  if (typeof rootDir !== "string" || rootDir.length < 1) {
    throw new Error("release governance selection requires a repository root");
  }
  if (!FULL_SHA.test(commit ?? "")) {
    throw new Error("release governance selection commit must be one lowercase full SHA");
  }
  if (!SHA256.test(receiptSha256 ?? "")) {
    throw new Error("release governance selection digest must be one lowercase sha256");
  }
  if (!Number.isFinite(now)) {
    throw new Error("release governance selection time is invalid");
  }

  const root = realpathSync(path.resolve(rootDir));
  let resolved;
  try {
    resolved = git(root, ["rev-parse", "--verify", `${commit}^{commit}`]).trim();
  } catch {
    throw new Error(`release commit ${commit} is unavailable`);
  }
  if (resolved !== commit) {
    throw new Error(`release commit ${commit} did not resolve to itself`);
  }

  const relativePath = releaseTagGovernanceReceiptPath(receiptSha256);
  let treeEntry;
  try {
    treeEntry = git(root, ["ls-tree", commit, "--", relativePath]).trim();
  } catch {
    throw new Error(`could not inspect ${relativePath} at release commit ${commit}`);
  }
  const expectedSuffix = `\t${relativePath}`;
  if (!treeEntry.endsWith(expectedSuffix)) {
    throw new Error(
      `${relativePath} is not committed in selected release revision ${commit}; commit the receipt, let that carrier reach main and production, then dispatch that carrier SHA`
    );
  }
  const metadata = treeEntry.slice(0, -expectedSuffix.length).split(" ");
  if (
    metadata.length !== 3 ||
    metadata[0] !== "100644" ||
    metadata[1] !== "blob" ||
    !FULL_SHA.test(metadata[2] ?? "")
  ) {
    throw new Error(`${relativePath} must be one regular non-executable Git blob`);
  }

  let size;
  try {
    size = Number(git(root, ["cat-file", "-s", metadata[2]]).trim());
  } catch {
    throw new Error(`${relativePath} blob metadata is unavailable`);
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_RECEIPT_BYTES) {
    throw new Error(`${relativePath} exceeds the bounded receipt size`);
  }

  let bytes;
  try {
    bytes = git(root, ["cat-file", "blob", metadata[2]], {
      encoding: null,
      maxBuffer: MAX_RECEIPT_BYTES + 1
    });
  } catch {
    throw new Error(`${relativePath} bytes are unavailable`);
  }
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== size) {
    throw new Error(`${relativePath} byte count does not match its Git blob`);
  }
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== receiptSha256) {
    throw new Error(`${relativePath} bytes do not match the selected sha256`);
  }

  const { text, value } = decodeJson(bytes, relativePath);
  const problems = releaseTagGovernanceReceiptProblems(value);
  if (problems.length > 0) {
    throw new Error(`${relativePath} is invalid: ${problems.join("; ")}`);
  }
  if (serializeReleaseTagGovernanceReceipt(value) !== text) {
    throw new Error(`${relativePath} is not canonical JSON`);
  }
  const freshness = releaseTagGovernanceReceiptFreshnessProblems(value, now);
  if (freshness.length > 0) {
    throw new Error(`${relativePath} is not fresh: ${freshness.join("; ")}`);
  }

  return {
    commit,
    receiptSha256,
    relativePath,
    capturedAt: value.capturedAt
  };
}
