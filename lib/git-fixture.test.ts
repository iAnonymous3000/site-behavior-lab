import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  gitFixtureEnv,
  initFixtureRepo,
  removeFixtureTree,
  runFixtureGit,
  type GitFixtureEnvOverrides
} from "./git-fixture";

// One root for the whole file, removed once at the end rather than after each
// test. That matters for the vacuity check below, which must start a real
// detached `git maintenance` to prove it can be observed: removing its tree in
// the same breath would recreate the exact race this module exists to close.
// Deferring teardown to the end of the file puts every remaining test between
// that child and the removal.
const ROOT = mkdtempSync(path.join(tmpdir(), "sbl-git-fixture-test-"));
after(() => removeFixtureTree(ROOT));

let nextDirectory = 0;
function fixtureDir(name: string): string {
  const directory = path.join(ROOT, `${nextDirectory++}-${name}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

// The defect this guards: `git commit` spawns
// `git maintenance run --auto --quiet --detach`. Because that child is
// detached it outlives the commit and keeps writing inside .git, so a fixture
// teardown that removes the tree in the same window fails with ENOTEMPTY -
// nondeterministically, and only on a loaded host.
//
// Asserting on the configuration values would not catch a regression: git
// could stop honoring them, or a caller could pass an `env` override that
// drops them. So assert the observable behavior instead, by reading git's own
// trace of the subprocesses it started.
test("a fixture commit starts no detached background maintenance", () => {
  const root = fixtureDir("hardened");
  const tracePath = path.join(ROOT, "hardened-trace.log");

  initFixtureRepo(root);
  writeFileSync(path.join(root, "tracked.txt"), "fixture source\n");
  runFixtureGit(root, ["add", "--all"]);
  runFixtureGit(root, ["commit", "-q", "-m", "fixture"], {
    GIT_TRACE: tracePath
  });

  const trace = readFileSync(tracePath, "utf8");
  // Without this the assertion below would pass on an empty trace, which
  // proves nothing about what git did.
  assert.match(
    trace,
    /built-in: git commit/,
    "expected git to have traced the commit itself"
  );
  assert.doesNotMatch(
    trace,
    /maintenance run/,
    "fixture git must not spawn background maintenance"
  );
});

// Mutation check for the assertion above: without the fixture environment the
// same commit does spawn maintenance. If this ever stops holding, the guard
// test above has become vacuous and must be rewritten rather than trusted.
test("the guard above is not vacuous: plain git does spawn maintenance", () => {
  const root = fixtureDir("plain");
  const tracePath = path.join(ROOT, "plain-trace.log");

  const plain = (args: string[], extra: GitFixtureEnvOverrides = {}) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Host configuration is still neutralized, so the only variable under
      // test is background maintenance itself.
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        ...extra
      }
    });

  plain(["init", "-q"]);
  plain(["config", "user.name", "Fixture"]);
  plain(["config", "user.email", "fixture@sitebehavior.invalid"]);
  writeFileSync(path.join(root, "tracked.txt"), "fixture source\n");
  plain(["add", "--all"]);
  plain(["commit", "-q", "-m", "fixture"], { GIT_TRACE: tracePath });

  assert.match(
    readFileSync(tracePath, "utf8"),
    /maintenance run/,
    "git no longer auto-starts maintenance; the guard test above is now vacuous"
  );
});

test("host git configuration cannot reach a fixture repository", () => {
  const root = fixtureDir("host-config");
  const hostConfig = path.join(ROOT, "host-gitconfig");
  writeFileSync(
    hostConfig,
    "[user]\n\tname = Host Identity\n\temail = host@example.invalid\n"
  );

  initFixtureRepo(root, {
    name: "Fixture",
    email: "fixture@sitebehavior.invalid"
  });
  writeFileSync(path.join(root, "tracked.txt"), "fixture source\n");
  runFixtureGit(root, ["add", "--all"]);
  // GIT_CONFIG_GLOBAL is forced to /dev/null, so pointing the host variable at
  // a populated file must have no effect on the recorded identity.
  runFixtureGit(root, ["commit", "-q", "-m", "fixture"], {
    HOME: ROOT,
    XDG_CONFIG_HOME: ROOT
  });

  assert.equal(
    runFixtureGit(root, ["log", "-1", "--format=%an <%ae>"]).trim(),
    "Fixture <fixture@sitebehavior.invalid>"
  );
});

test("callers may still pin a deterministic commit timestamp", () => {
  const root = fixtureDir("timestamp");
  initFixtureRepo(root);
  writeFileSync(path.join(root, "tracked.txt"), "fixture source\n");
  runFixtureGit(root, ["add", "--all"]);
  runFixtureGit(root, ["commit", "-q", "-m", "fixture"], {
    GIT_AUTHOR_DATE: "2026-08-01T18:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-01T18:00:00Z"
  });

  // Compare the instant rather than the rendering: git's strict-ISO spelling
  // of a UTC offset has changed between versions.
  assert.equal(
    Number(runFixtureGit(root, ["log", "-1", "--format=%at"]).trim()),
    Date.parse("2026-08-01T18:00:00Z") / 1000
  );
});

test("the fixture environment leaves the caller's environment untouched", () => {
  const before = { ...process.env };
  const env = gitFixtureEnv({ GIT_AUTHOR_DATE: "2026-08-01T18:00:00Z" });

  assert.equal(env.GIT_AUTHOR_DATE, "2026-08-01T18:00:00Z");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.deepEqual({ ...process.env }, before);
});
