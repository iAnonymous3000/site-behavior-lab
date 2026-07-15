import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const verifier = path.resolve("scripts/static-deployment-provenance.mjs");
const commitEnvNames = ["SITE_BEHAVIOR_LAB_BUILD_COMMIT", "CF_PAGES_COMMIT_SHA", "GITHUB_SHA"];

test("static deployment provenance emits the clean checkout HEAD in the production-health marker shape", async (t) => {
  const repo = await cleanRepository(t);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const result = verify(repo);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual({ schemaVersion: 1, deployment: result.stdout.trim() }, { schemaVersion: 1, deployment: head });
});

test("static deployment provenance rejects dirty tracked source even when an exact SHA is declared", async (t) => {
  const repo = await cleanRepository(t);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(repo, "tracked.txt"), "dirty source\n");

  const result = verify(repo, { GITHUB_SHA: head });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a clean Git worktree/);
});

test("static deployment provenance rejects staged and untracked build inputs", async (t) => {
  const stagedRepo = await cleanRepository(t);
  await writeFile(path.join(stagedRepo, "tracked.txt"), "staged source\n");
  git(stagedRepo, ["add", "tracked.txt"]);
  const staged = verify(stagedRepo);
  assert.notEqual(staged.status, 0);
  assert.match(staged.stderr, /requires a clean Git worktree/);

  const untrackedRepo = await cleanRepository(t);
  await writeFile(path.join(untrackedRepo, "untracked-source.mjs"), "export default 'uncommitted';\n");
  const untracked = verify(untrackedRepo);
  assert.notEqual(untracked.status, 0);
  assert.match(untracked.stderr, /requires a clean Git worktree/);
});

test("static deployment provenance rejects a declared SHA that differs from checkout HEAD", async (t) => {
  const repo = await cleanRepository(t);
  const result = verify(repo, { SITE_BEHAVIOR_LAB_BUILD_COMMIT: "f".repeat(40) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the checked-out Git HEAD/);
});

test("static deployment provenance rejects any conflicting lower-priority SHA declaration", async (t) => {
  const repo = await cleanRepository(t);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const result = verify(repo, {
    SITE_BEHAVIOR_LAB_BUILD_COMMIT: head,
    GITHUB_SHA: "f".repeat(40)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GITHUB_SHA does not match the checked-out Git HEAD/);
});

async function cleanRepository(t: TestContext) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "site-behavior-lab-provenance-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.name", "Provenance Test"]);
  git(repo, ["config", "user.email", "provenance@example.invalid"]);
  await writeFile(path.join(repo, "tracked.txt"), "committed source\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "--quiet", "-m", "initial"]);
  return repo;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function verify(cwd: string, overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const name of commitEnvNames) delete env[name];
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [verifier], { cwd, env, encoding: "utf8" });
}
