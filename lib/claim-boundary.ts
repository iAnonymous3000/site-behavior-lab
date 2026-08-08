// Relative, not the "@/" alias: that alias is TypeScript-only, so an aliased
// import typechecks and then fails to resolve under the compiled unit tests,
// which run on plain node. A static import also means the bundler inlines the
// approved values at build time, so the runtime image never needs the manifest
// file itself.
import readiness from "../RELEASE_READINESS.json";

/**
 * The approved boundary on how a report may be used, as a reader sees it.
 *
 * The decision itself lives in RELEASE_READINESS.json and is approved by a
 * named human; this module is the one place that turns it into English. It
 * imports the manifest rather than restating it, so the slug a reader is shown
 * can never drift from the slug that was approved.
 *
 * Server-only by construction: it pulls the release manifest into whatever
 * module graph imports it, which must never be a client bundle.
 *
 * Deliberately not fail-closed at import time. An unapproved or unrecognised
 * decision renders no statement rather than taking every report page down, and
 * lib/claim-boundary.test.ts is red the moment either happens, so the failure
 * surfaces in CI instead of in production.
 */

/** Reader prose for each approved boundary slug. Unknown slugs render nothing. */
const BOUNDARY_COPY: Readonly<Record<string, string>> = {
  "investigative-evidence-requiring-independent-corroboration":
    "investigative evidence that requires independent corroboration"
};

/** Reader prose for each excluded use. Unknown slugs render nothing. */
const EXCLUDED_USE_COPY: Readonly<Record<string, string>> = {
  "standalone-legal-determinations": "a standalone legal determination",
  "sole-court-exhibit-use": "the sole exhibit in a legal proceeding"
};

export type ClaimBoundary = {
  /** The approved slug, verbatim from the manifest. */
  readonly id: string;
  /** One sentence stating what a report is. */
  readonly summary: string;
  /** One sentence stating what it is not. Empty when nothing is excluded. */
  readonly exclusions: string;
  /** ISO instant the decision was approved. */
  readonly decidedAt: string;
};

/** "a, b, and c" without an Oxford-comma special case for two items. */
function joinClauses(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function resolveClaimBoundary(): ClaimBoundary | null {
  const decision = readiness.decisions?.claimBoundary;
  // Mirrors decisionProblems() in scripts/release-readiness-lib.mjs: a
  // recommended value carries no authority until a named human approves it.
  if (!decision || decision.status !== "approved") return null;
  if (typeof decision.decidedBy !== "string" || decision.decidedBy.trim().length === 0) return null;
  if (typeof decision.decidedAt !== "string" || decision.decidedAt.length === 0) return null;

  const summary = BOUNDARY_COPY[decision.recommended];
  if (!summary) return null;

  const excluded = (decision.excludes ?? [])
    .map((use) => EXCLUDED_USE_COPY[use])
    .filter((copy): copy is string => typeof copy === "string");
  // A slug we have no copy for must not silently shrink the exclusion list: a
  // reader would be shown a narrower boundary than the one that was approved.
  const everyExclusionHasCopy = excluded.length === (decision.excludes ?? []).length;
  if (!everyExclusionHasCopy) return null;

  return {
    id: decision.recommended,
    summary: `This report is ${summary}.`,
    // Every clause carries its own "not". "It is not A and B" parses as
    // "not (A and B)", which permits being exactly one of them: a materially
    // weaker statement than the one that was approved, on the surface where a
    // reader is least able to check it.
    exclusions:
      excluded.length > 0 ? `It is ${joinClauses(excluded.map((use) => `not ${use}`))}.` : "",
    decidedAt: decision.decidedAt
  };
}

export const CLAIM_BOUNDARY: ClaimBoundary | null = resolveClaimBoundary();

/** The boundary as one paragraph, for surfaces with no room for two. */
export function claimBoundaryParagraph(boundary: ClaimBoundary): string {
  return boundary.exclusions ? `${boundary.summary} ${boundary.exclusions}` : boundary.summary;
}
