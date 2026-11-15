import {
  AlertTriangle,
  CheckCircle2,
  Cookie,
  Eye,
  FileText,
  Fingerprint,
  Globe2,
  Keyboard,
  Network,
  Radar,
  ShieldCheck
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { LimitLine } from "@/app/_design/limit-line";
import { findingLookCloser, findingNewVisit, LOOK_CLOSER_NAME } from "@/lib/finding-look-closer";
import type { Finding, FindingIconKey } from "@/lib/report-findings";
import { REPORT_SEVERITY_LABELS, type ReportSeverity } from "@/lib/report-facts";
import {
  buildEvidenceHash,
  findingCardDomId,
  findingEvidenceLink,
  type EvidenceArm
} from "@/lib/report-evidence-navigation";

/**
 * The findings board's markup, with no state and no fetch, so the same cards
 * render from a server component on the report permalink and from the
 * client explorer once it has loaded the wire.
 *
 * The permalink used to show the identity block, the headline banner and a
 * card whose only content was a button; the plain-language findings, the
 * part of the page written for a reader checking a claim, arrived only after
 * "Explore full evidence" fetched an up-to-8 MB wire. That gate exists to keep
 * the raw tables and charts out of the initial document. It never needed to
 * hold back the board, which is a pure function of the view the server
 * already holds and the committed corpus statistics it can read from disk.
 *
 * Server-safe on purpose: no hooks, no window, and the icons are plain SVG
 * components. `FindingsBoard` in report-overview.tsx keeps its corpus fetch
 * and hands the result here, so both surfaces build the cards through one
 * `buildFindings` call and one markup.
 */
export const FINDING_ICONS: Record<FindingIconKey, typeof Eye> = {
  globe: Globe2,
  network: Network,
  radar: Radar,
  cookie: Cookie,
  eye: Eye,
  keyboard: Keyboard,
  fingerprint: Fingerprint,
  "shield-check": ShieldCheck,
  check: CheckCircle2,
  alert: AlertTriangle,
  "file-text": FileText
};

/** The order the index lists the filed labels in: heaviest first. */
const INDEX_ORDER: readonly ReportSeverity[] = ["loud", "warn", "info", "quiet", "ok"];

export function FindingsList({
  findings,
  evidenceArm,
  automation,
  glossaryHref,
  afterBottomLine,
  lookCloser,
  plainHeading,
  shortLimits,
  omitIcons,
  index
}: {
  findings: readonly Finding[];
  evidenceArm: EvidenceArm | undefined;
  /** The scanner identity the board is describing, shown beside the heading. */
  automation: string;
  glossaryHref: string;
  /**
   * Server-built markup for directly after the bottom line and before every
   * other card (the report pages' ReportVisitSummaryBlock). A board with no
   * bottom line, a withheld report's single correction card, takes it after
   * its cards.
   */
  afterBottomLine?: ReactNode;
  /**
   * What each card's Look closer view and new visit need beyond the card
   * itself, or absent to render none, as the printable route does. A report
   * page builds the history target on the server and hands the same value to
   * its explorer; the page a new visit would visit again, and the share it
   * names, are built on each board from the same view and the same freshness.
   */
  lookCloser?: {
    siteHistoryHref: string | null;
    newVisitTarget: string | null;
    newVisitFrom: string | null;
    basePath: string;
  };
  /**
   * Render the heading as the title and the glossary link alone. The report
   * permalink sets it: its record block states the scanner, so the heading
   * need not, and the label above the title says nothing the title does not.
   */
  plainHeading?: boolean;
  /**
   * Print each card's limit as the evidence layer gives it: the one sentence
   * beside the claim with the text behind it, the sentence alone when nothing
   * is behind it, or the card's full string when the card carries no limit.
   * Nothing is split, joined or chosen here (lib/finding-limits.ts does that).
   * The report permalink sets it; the explorer and the printable route do
   * not, and print the full string.
   */
  shortLimits?: boolean;
  /**
   * Leave each card's icon out of the markup. The report permalink sets it:
   * its design shows no icon, and an icon hidden by a stylesheet is still
   * stored in every committed report's page, several times over.
   */
  omitIcons?: boolean;
  /**
   * List every card's title under its filed label, as links to the cards,
   * directly after the heading. The cards keep their stored order; the index
   * is how a reader finds the heaviest first. It holds labels and titles the
   * cards already print and nothing else: no heading and no name of its own,
   * each list labelled by the visible label above it. The report permalink
   * sets it, for a board of more than one card; the explorer's board and the
   * printable route do not.
   */
  index?: boolean;
}) {
  const hasBottomLine = findings.some((finding) => finding.id === "bottom-line");
  const indexGroups =
    index && findings.length > 1
      ? INDEX_ORDER.map((level) => ({ level, cards: findings.filter((finding) => finding.level === level) })).filter(
          (group) => group.cards.length > 0
        )
      : [];
  return (
    <section className="findings-board" id="findings">
      <div className="findings-heading">
        <div>
          {!plainHeading && <p className="eyebrow">Plain-Language Findings</p>}
          <h2>What this visit means</h2>
          <a className="glossary-link" href={glossaryHref}>
            Unfamiliar terms are defined in the glossary
          </a>
        </div>
        {!plainHeading && <span>{automation}</span>}
      </div>
      {indexGroups.length > 0 && (
        <div className="a-fx">
          {indexGroups.map((group) => (
            <div className={`tile-${group.level}`} key={group.level}>
              <p id={`findings-index-${group.level}`}>{REPORT_SEVERITY_LABELS[group.level]}</p>
              {/* Keyed by position: a key holding the title would put it in
                  the page data a second time. */}
              <ul aria-labelledby={`findings-index-${group.level}`}>
                {group.cards.map((finding, position) => (
                  <li key={position}>
                    <a href={`#${findingCardDomId(finding.id)}`}>{finding.title}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <div className="finding-list">
        {findings.map((finding) => {
          const Icon = FINDING_ICONS[finding.icon];
          const evidenceLink = findingEvidenceLink(finding.id, evidenceArm);
          const view = lookCloser
            ? findingLookCloser(finding, findings, { arm: evidenceArm, siteHistoryHref: lookCloser.siteHistoryHref })
            : null;
          // A card offers a view or a new visit, never both: the two kinds
          // key disjoint cards (lib/report-findings.test.ts holds that), so
          // the group shows one link and its sentence either way.
          const followUp =
            view ??
            (lookCloser
              ? findingNewVisit(finding, {
                  newVisitTarget: lookCloser.newVisitTarget,
                  newVisitFrom: lookCloser.newVisitFrom,
                  basePath: lookCloser.basePath
                })
              : null);
          const viewSentenceId = `${findingCardDomId(finding.id)}-look-closer`;
          // The id is the target of the visit summary's "What this visit
          // could not see" links; the board renders once per document.
          const card = (
            <article className={`finding-card tile-${finding.level}`} id={findingCardDomId(finding.id)} key={finding.id}>
              {!omitIcons && (
                <div className="finding-icon">
                  <Icon size={18} aria-hidden="true" />
                </div>
              )}
              <div>
                {/* The card's rank had exactly one channel: a hue on the left
                    border and the icon tint. The icon itself is chosen per
                    FINDING, not per level, so five levels shared no shape and no
                    text, and the prose never states the rank. Naming it is the
                    second channel WCAG 1.4.1 asks for, and it also lets a reader
                    scan the board for what matters without decoding colour. */}
                <p className="finding-level">{REPORT_SEVERITY_LABELS[finding.level]}</p>
                <h3>{finding.title}</h3>
                <p className="finding-lead">{finding.lead}</p>
                {shortLimits ? (
                  <div className="finding-limit">
                    {finding.limit && finding.limit.behind.length > 0 ? (
                      <LimitLine details={finding.limit.behind}>{finding.limit.sentence}</LimitLine>
                    ) : (
                      <LimitLine>{finding.limit ? finding.limit.sentence : finding.detail}</LimitLine>
                    )}
                  </div>
                ) : (
                  <p>{finding.detail}</p>
                )}
                <div className="finding-meta">
                  <span>{finding.evidence}</span>
                  {finding.benchmark && <span>{finding.benchmark}</span>}
                  {evidenceLink && (
                    <a
                      className="glossary-link"
                      href={buildEvidenceHash(evidenceLink.target)}
                      aria-label={`${evidenceLink.label} for ${finding.title}`}
                    >
                      {evidenceLink.label}
                    </a>
                  )}
                </div>
                {/* One follow-up per card, after everything the card states:
                    a view opens rows, a card or the site's history the reader
                    could reach already, and a new visit opens the scan form,
                    filled and never submitted. Its sentence says what it
                    opens before anyone follows it. The link names its card,
                    like the evidence link above, and points at the sentence. */}
                {followUp && (
                  <div className="finding-look-closer" data-look-closer={followUp.variant}>
                    <p className="finding-look-closer-name">{LOOK_CLOSER_NAME}</p>
                    <a
                      className="finding-look-closer-link"
                      href={followUp.href}
                      aria-label={`${followUp.label} for ${finding.title}`}
                      aria-describedby={viewSentenceId}
                    >
                      {followUp.label}
                    </a>
                    <p className="finding-look-closer-sentence" id={viewSentenceId}>{followUp.sentence}</p>
                  </div>
                )}
              </div>
            </article>
          );
          return finding.id === "bottom-line" && afterBottomLine ? (
            <Fragment key={finding.id}>
              {card}
              {afterBottomLine}
            </Fragment>
          ) : card;
        })}
        {!hasBottomLine && afterBottomLine}
      </div>
    </section>
  );
}
