import { spawnSync } from "node:child_process";

/**
 * Read-only git plumbing shared by the two append-only history gates
 * (corrections-ledger-history-cli and publication-transparency-log-cli).
 *
 * Each gate compares a file in the working tree with the same file at a base
 * revision, so each must tell two answers apart: the file is absent at the
 * base, or git could not say. A gate that takes a failed read for an absent
 * file compares nothing and then passes, and a log that lost entries reads as
 * a log that begins at that revision. Both gates read the base through this
 * one helper, so they cannot disagree about which answer they were given.
 *
 * Node-only: never imported by app, worker, or browser code.
 */

const MAX_GIT_BLOB_BYTES = 64 * 1024 * 1024;

/** Whether `object` (a revision, or `revision:path`) names something this repository holds. */
export function gitObjectExists(root: string, object: string): boolean {
  return runGit(root, ["cat-file", "-e", object]).status === 0;
}

/**
 * The bytes of `repoPath` at `revision`, or null when the revision holds no
 * such path. Existence is asked first, so a read that fails after git said the
 * blob exists is an error and never an absence.
 */
export function gitBlobIfPresent(root: string, revision: string, repoPath: string): Buffer | null {
  if (!gitObjectExists(root, `${revision}:${repoPath}`)) return null;
  const result = runGit(root, ["show", `${revision}:${repoPath}`]);
  if (result.status !== 0) {
    throw new Error(`Cannot read ${revision}:${repoPath}: ${gitError(result.stderr)}`);
  }
  return result.stdout;
}

function runGit(root: string, args: string[]): { status: number; stdout: Buffer; stderr: Buffer } {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: MAX_GIT_BLOB_BYTES
  });
  if (result.error) throw result.error;
  // A git that was killed has no exit status. Read as a non-zero exit, that
  // would turn "git could not answer" into "absent".
  if (result.status === null) {
    throw new Error(`git ${args.join(" ")} did not exit on its own (signal ${result.signal ?? "unknown"}).`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0)
  };
}

function gitError(stderr: Uint8Array): string {
  return Buffer.from(stderr).toString("utf8").trim() || "unknown Git error";
}
