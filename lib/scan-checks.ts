import { HEADLINE_PLATFORMS } from "./headline-platforms";
import { humanList } from "./text-format";

/**
 * What one controlled visit records: the checks behind every report, each a
 * title and the question it answers.
 *
 * One list for both places the homepage prints it: the block on the first
 * screen (app/_design/visit-records.tsx, a server component, so the block
 * costs HTML and no homepage JavaScript) and the list under a running scan
 * (app/site-behavior-app.tsx).
 */
export const SCAN_CHECKS: readonly { label: string; question: string }[] = [
  { label: "Catalog matches", question: "Which request rows matched the reviewed service catalog, and what roles does that catalog assign?" },
  { label: "Third-party cookie records", question: "Which cookie records crossed the site's registrable-domain boundary?" },
  {
    label: "Named platforms",
    // Derived, not restated: this sentence was a hand-written copy that named
    // four platforms and went stale when Microsoft, LinkedIn, and Pinterest
    // joined the shared constant, so the homepage advertised less than the
    // report actually checks.
    question: `Were requests dispatched to catalogued ${humanList(
      HEADLINE_PLATFORMS,
      HEADLINE_PLATFORMS.length
    )} domains?`
  },
  { label: "Google Analytics remarketing", question: "Did the scan see the Analytics-to-DoubleClick request marker?" },
  { label: "Fingerprint-like API calls", question: "Did canvas, WebGL, or audio behavior cross a documented heuristic threshold?" },
  { label: "Session-replay signals", question: "Did a catalogued service appear or broad interaction listeners register?" },
  { label: "Synthetic input check", question: "Did the test value appear in a cross-site request before form submission?" }
];
