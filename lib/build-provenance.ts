/**
 * The single definition of recorded build provenance: the env var every
 * producer reads and the exact shape a recorded build commit must have.
 * Producers, the shadow store, runtime status, and the operator CLIs all pin
 * work to a build; this rule must never drift between them.
 */
export const BUILD_COMMIT_ENV = "SITE_BEHAVIOR_LAB_BUILD_COMMIT";

/** A full 40-character lowercase Git SHA; anything else is unknown provenance. */
export const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

/** The env-declared build commit, canonicalized; null when absent or malformed. */
export function recordedBuildCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[BUILD_COMMIT_ENV]?.trim().toLowerCase() ?? "";
  return FULL_GIT_SHA.test(value) ? value : null;
}
