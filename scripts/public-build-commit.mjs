const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const BUILD_COMMIT_ENV_NAMES = ["SITE_BEHAVIOR_LAB_BUILD_COMMIT", "CF_PAGES_COMMIT_SHA", "GITHUB_SHA"];

/**
 * Resolve the compile-time commit exposed to the browser. Missing provenance
 * remains an empty string so ordinary local development can build, but any
 * PageGraph r2 import then fails closed in the client helper. Present invalid
 * or conflicting values fail the build itself.
 */
export function resolvePublicBuildCommit(environment = process.env) {
  const declared = [];
  for (const name of BUILD_COMMIT_ENV_NAMES) {
    const raw = environment[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = raw.trim().toLowerCase();
    if (!FULL_GIT_SHA.test(value)) {
      throw new Error(`${name} must identify a full 40-character Git commit.`);
    }
    declared.push({ name, value });
  }
  const values = new Set(declared.map(({ value }) => value));
  if (values.size > 1) {
    throw new Error(
      `Conflicting build commits were supplied: ${declared.map(({ name }) => name).join(", ")}.`
    );
  }
  return declared[0]?.value ?? "";
}
