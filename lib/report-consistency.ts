import { buildReportFacts, type ReportFacts } from "./report-facts";
import { renderedEvidenceArm } from "./report-evidence-navigation";
import { buildFindings, type Finding } from "./report-findings";
import { buildReportHeadline, type ReportHeadline } from "./report-headline";
import type { ReportView } from "./scan-report-views";
import type { CorpusStats } from "./corpus-stats";

export type ReportConsistencyRuleId =
  | "fingerprint-asserted-without-events"
  | "cookie-absence-with-recorded-cookie"
  | "quiet-copy-over-loud-finding"
  | "identity-conflict"
  | "unsafe-categorical-title-under-incomplete-evidence"
  | "error-page-signals-attributed-to-site";

export type ReportConsistencyViolation = {
  id: ReportConsistencyRuleId;
  message: string;
};

/**
 * Validate meaning, not English. Headline/finding renderers emit structured
 * semantic decisions, and this gate checks those decisions against ReportFacts.
 * Wording can evolve without weakening the invariant or adding another regex.
 */
export function reportConsistencyViolations(
  facts: ReportFacts,
  headline: ReportHeadline,
  findings: readonly Finding[]
): ReportConsistencyViolation[] {
  const violations: ReportConsistencyViolation[] = [];
  const run = facts.display;
  const headlineRuns =
    headline.semantic.runScope === "pair"
      ? facts.runs
      : headline.semantic.runScope === "baseline" ||
          headline.semantic.runScope === "variant"
        ? [facts.arms?.[headline.semantic.runScope] ?? facts.display]
        : [facts.display];
  const add = (id: ReportConsistencyRuleId, message: string) => {
    if (!violations.some((violation) => violation.id === id && violation.message === message)) {
      violations.push({ id, message });
    }
  };

  if (
    headline.semantic.story === "fingerprint-api" &&
    !headlineRuns.some((candidate) => candidate.signals.fingerprint.apiActivityObserved)
  ) {
    add(
      "fingerprint-asserted-without-events",
      "The headline selected the fingerprint-API story without API events or a high-entropy heuristic."
    );
  }

  if (
    headlineRuns.some((candidate) => candidate.signals.cookies.thirdParty > 0) &&
    headline.semantic.absenceClaims.includes("third-party-cookies")
  ) {
    const recorded = headlineRuns.reduce(
      (total, candidate) => total + candidate.signals.cookies.thirdParty,
      0
    );
    add(
      "cookie-absence-with-recorded-cookie",
      `The headline rendered a cookie-absence claim over ${recorded} recorded third-party cookies.`
    );
  }
  const cookieFindingAbsence = findings.some(
    (finding) =>
      finding.claim?.id === "third-party-cookies" &&
      (finding.claim.mode === "categorical-absence" ||
        finding.claim.mode === "qualified-absence")
  );
  if (run.signals.cookies.thirdParty > 0 && cookieFindingAbsence) {
    add(
      "cookie-absence-with-recorded-cookie",
      `A finding rendered a cookie-absence claim over ${run.signals.cookies.thirdParty} recorded third-party cookies.`
    );
  }

  const loudFindings = findings.filter(
    (finding) =>
      finding.methodology !== true &&
      (finding.level === "warn" || finding.level === "loud")
  );
  if (headline.semantic.reassuring && loudFindings.length > 0) {
    add(
      "quiet-copy-over-loud-finding",
      `A reassuring headline rendered over ${loudFindings.map((finding) => finding.id).join(", ")}.`
    );
  }
  // The bottom line is the reader's one-line verdict, and it is computed from
  // the findings board while the headline is computed from ReportFacts. Those
  // are two answers to "is this visit quiet?", so they can disagree on the same
  // page below the warn/loud threshold the check above uses: gov.uk rendered
  // the calm "showed few catalogued or fingerprint-like signals" directly above
  // an alert card reading "this visit has review-worthy signals". Pin the seam
  // itself rather than each card that can leak across it.
  const bottomLine = findings.find((finding) => finding.id === "bottom-line");
  if (headline.semantic.reassuring && bottomLine?.icon === "alert") {
    add(
      "quiet-copy-over-loud-finding",
      `A reassuring headline rendered over an alert bottom line ("${bottomLine.title}").`
    );
  }

  const serviceCard = findings.find((finding) => finding.id === "third-party-services");
  if (
    run.identity.allNames.length > 0 &&
    (serviceCard?.claim?.mode === "categorical-absence" ||
      serviceCard?.claim?.mode === "qualified-absence")
  ) {
    add(
      "identity-conflict",
      `The service card rendered an absence while ${run.identity.allNames.join(", ")} were named by the identity union.`
    );
  }

  for (const finding of findings) {
    if (finding.claim?.mode !== "categorical-absence") continue;
    if (!run.claims[finding.claim.id].allowed) {
      add(
        "unsafe-categorical-title-under-incomplete-evidence",
        `${finding.id} rendered a categorical absence while its fact gate was closed.`
      );
    }
  }
  for (const claim of headline.semantic.absenceClaims) {
    if (headlineRuns.some((candidate) => !candidate.claims[claim].allowed)) {
      add(
        "unsafe-categorical-title-under-incomplete-evidence",
        `The headline rendered categorical ${claim} absence while its fact gate was closed.`
      );
    }
  }

  if (
    headlineRuns.some((candidate) => !candidate.subject.describesSubject) &&
    headline.semantic.subjectScope === "requested-page"
  ) {
    add(
      "error-page-signals-attributed-to-site",
      "The headline attributed returned-document evidence to the requested page."
    );
  }
  for (const finding of findings) {
    if (
      !run.subject.describesSubject &&
      finding.claim &&
      finding.claim.scope === "requested-page"
    ) {
      add(
        "error-page-signals-attributed-to-site",
        `${finding.id} attributed returned-document evidence to the requested page.`
      );
    }
  }

  return violations;
}

export function validateReportPresentation(
  view: ReportView,
  corpus: CorpusStats | null = null
): {
  facts: ReportFacts;
  headline: ReportHeadline;
  findings: Finding[];
  violations: ReportConsistencyViolation[];
} {
  const facts = buildReportFacts(view);
  const headline = buildReportHeadline(view, facts);
  // Validate the board readers actually see. The renderer threads the
  // headline's focused arm into buildFindings (report-overview derives
  // exactly this value for the evidence links), so validating a default
  // display-arm board here would re-split the contract this gate exists to
  // hold together: the fidelity invariants and the committed-corpus check
  // would go green over findings nobody renders while the rendered board
  // went unvalidated.
  const findings = buildFindings(view, corpus, facts, renderedEvidenceArm(view, headline));
  return {
    facts,
    headline,
    findings,
    violations: reportConsistencyViolations(facts, headline, findings)
  };
}
