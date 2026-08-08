// Whether a commit can still serve as the durable transition's `fromCommit`.
//
// The binding (lib/measurement-candidate-binding.ts, the durable transition
// verifier) requires, in one conjunction:
//
//   git rev-parse <toCommit>^  ==  fromCommit
//     &&  replayDeploymentCommit  ==  fromCommit
//     &&  the transition commit modifies ONLY wrangler.container.jsonc
//     &&  that change is exactly the 0 -> 1 marker substitution
//
// So the replay canaries pin a SHA, that SHA must be the flip commit's direct
// first parent, and the flip commit's ONLY change is the flag. A parent that
// already has a child on a linear-history branch can therefore never be used:
// its one child slot is spent, and `main` permits only squash and rebase merges
// (RELEASE.md), so a second direct child cannot be created.
//
// This is exactly how the receipts archived by PR #98 became ineligible. They
// name 78defca0, and 0cf9e1c landed as its child before any flip commit
// existed. The evidence is still valid operational proof that durable replay
// works; it just can no longer serve the transition.
//
// Run the preflight BEFORE deploying staging for a replay capture, so the
// capture is spent on a parent that can actually carry the transition.

export const DURABLE_CONFIG_PATH = "wrangler.container.jsonc";
export const DURABLE_ENABLED_MARKER = '"SITE_BEHAVIOR_LAB_DURABLE_JOBS": "1"';
export const DURABLE_DISABLED_MARKER = '"SITE_BEHAVIOR_LAB_DURABLE_JOBS": "0"';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Issues that disqualify `parentSha` from carrying the durable transition.
 *
 * Pure: every fact about the repository is supplied by the caller, so the
 * decision logic is testable without a git fixture per case.
 */
export function durableReplayParentIssues({
  parentSha,
  childShas,
  onDefaultBranch,
  configAtParent
}) {
  const issues = [];

  if (typeof parentSha !== "string" || !FULL_GIT_SHA.test(parentSha)) {
    issues.push("the intended replay parent must be a full 40-character lowercase commit sha");
    return issues;
  }

  if (onDefaultBranch !== true) {
    issues.push(
      `${parentSha} is not on the default branch; the transition must be an ordered pre-candidate history on main`
    );
  }

  if (!Array.isArray(childShas)) {
    issues.push("the child list must be an array");
  } else if (childShas.length > 0) {
    // The disqualifying condition, and the one that is invisible until the
    // binding refuses months later.
    issues.push(
      `${parentSha} already has ${childShas.length === 1 ? "a child" : `${childShas.length} children`} ` +
        `(${childShas.map((sha) => sha.slice(0, 12)).join(", ")}); ` +
        "the transition commit must be its DIRECT first child, and linear history forbids a second one. " +
        "Choose a newer parent and re-run this preflight before capturing replay evidence."
    );
  }

  if (typeof configAtParent !== "string" || configAtParent.length === 0) {
    issues.push(`${DURABLE_CONFIG_PATH} could not be read at ${parentSha}`);
    return issues;
  }

  // Mirrors the binding's own check on fromConfig: exactly one disabled marker
  // and no enabled marker, so the flip is representable as a single
  // substitution.
  if (configAtParent.split(DURABLE_DISABLED_MARKER).length !== 2) {
    issues.push(
      `${DURABLE_CONFIG_PATH} at ${parentSha} must contain exactly one ${DURABLE_DISABLED_MARKER}`
    );
  }
  if (configAtParent.includes(DURABLE_ENABLED_MARKER)) {
    issues.push(
      `${DURABLE_CONFIG_PATH} at ${parentSha} already contains ${DURABLE_ENABLED_MARKER}; ` +
        "the transition must change the flag from 0 to 1"
    );
  }

  return issues;
}

/** The flip commit the caller must produce, once a parent qualifies. */
export function durableTransitionPlan(parentSha, configAtParent) {
  return {
    parent: parentSha,
    changes: [DURABLE_CONFIG_PATH],
    substitution: {
      from: DURABLE_DISABLED_MARKER,
      to: DURABLE_ENABLED_MARKER
    },
    resultingConfigSha256Input: configAtParent.replace(
      DURABLE_DISABLED_MARKER,
      DURABLE_ENABLED_MARKER
    )
  };
}
