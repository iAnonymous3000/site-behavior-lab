// One place that knows how to drive git against a throwaway fixture
// repository. Eleven test modules used to each carry their own copy of this,
// and the copies had drifted: some pinned commit dates, some did not; one
// disabled commit signing, the rest did not; none of them disabled background
// maintenance.
//
// Two hazards this closes.
//
// 1. `git commit` spawns `git maintenance run --auto --quiet --detach`. The
//    `--detach` is the problem: that process outlives the commit and keeps
//    writing inside .git after the test has moved on. A fixture teardown that
//    removes the tree inside that window fails with ENOTEMPTY, and because it
//    depends on how the host schedules a detached child it fails only
//    sometimes, only under load. Disabling background maintenance removes the
//    concurrent writer rather than racing it.
//
// 2. A fixture repository otherwise inherits the host's global and system git
//    configuration: hooks, templates, commit signing, an fsmonitor daemon, a
//    default branch name. Then a test that passes in CI fails on a
//    contributor's machine for reasons that have nothing to do with the code
//    under test. Fixture git reads neither file.
//
// Callers that need a deterministic commit identity or timestamp pass those as
// overrides; everything else is fixed here so it cannot drift again.

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

// Applied through git's environment-variable configuration channel rather than
// `git config`, so a fixture's own .git/config stays exactly what the test
// wrote. Tests that assert on repository configuration see their own values.
const FIXTURE_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  // Hazard 1: the detached background writer.
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["gc.autoDetach", "false"],
  // Hazard 2: host configuration that would otherwise change behavior.
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["init.defaultBranch", "main"],
  ["core.fsmonitor", "false"],
  ["core.hooksPath", ""],
  ["protocol.file.allow", "always"]
];

/**
 * Environment variables a caller may add on top of the fixture environment.
 *
 * Deliberately not `NodeJS.ProcessEnv`: the Next build augments that type with
 * a required `NODE_ENV`, so a `NodeJS.ProcessEnv` parameter defaulting to `{}`
 * compiles under tsconfig.test.json and fails under the app's typecheck. An
 * overlay is a plain string map, and saying so makes the two configs agree.
 */
export type GitFixtureEnvOverrides = Readonly<
  Record<string, string | undefined>
>;

/**
 * The environment a fixture git invocation runs under: the caller's
 * environment, with host git configuration neutralized and the fixture
 * configuration above forced on. Later `overrides` win, so a caller may still
 * pin GIT_AUTHOR_DATE or an identity.
 */
export function gitFixtureEnv(
  overrides: GitFixtureEnvOverrides = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Neither the host's ~/.gitconfig nor /etc/gitconfig is readable from here.
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";

  env.GIT_CONFIG_COUNT = String(FIXTURE_GIT_CONFIG.length);
  FIXTURE_GIT_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  // Assigned rather than spread: spreading an index-signature overlay over
  // process.env widens the augmented NODE_ENV back to `string | undefined`.
  for (const [key, value] of Object.entries(overrides)) env[key] = value;

  return env;
}

/**
 * Run one git command inside a fixture repository and return its stdout
 * verbatim. Throws on a non-zero exit, like the `execFileSync` each caller
 * used before.
 */
export function runFixtureGit(
  root: string,
  args: readonly string[],
  overrides: GitFixtureEnvOverrides = {}
): string {
  return execFileSync("git", args as string[], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitFixtureEnv(overrides)
  });
}

/**
 * Initialize a fixture repository with a committing identity. Separate from
 * `runFixtureGit` only because every caller needs exactly this preamble.
 */
export function initFixtureRepo(
  root: string,
  options: {
    name?: string;
    email?: string;
    env?: GitFixtureEnvOverrides;
  } = {}
): void {
  const { name = "Fixture", email = "fixture@sitebehavior.invalid", env = {} } =
    options;
  runFixtureGit(root, ["init", "-q"], env);
  runFixtureGit(root, ["config", "user.name", name], env);
  runFixtureGit(root, ["config", "user.email", email], env);
}

/**
 * Remove a fixture tree. Background maintenance is already disabled above, so
 * this is defence in depth rather than the fix: the retries cover filesystem
 * transients (a lingering handle, a slow unlink) and would otherwise turn a
 * cleanup hiccup into a red build.
 */
export function removeFixtureTree(root: string): void {
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50
  });
}
