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
import type { Finding, FindingIconKey } from "@/lib/report-findings";
import { REPORT_SEVERITY_LABELS } from "@/lib/report-facts";
import {
  buildEvidenceHash,
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

export function FindingsList({
  findings,
  evidenceArm,
  automation,
  glossaryHref
}: {
  findings: readonly Finding[];
  evidenceArm: EvidenceArm | undefined;
  /** The scanner identity the board is describing, shown beside the heading. */
  automation: string;
  glossaryHref: string;
}) {
  return (
    <section className="findings-board" id="findings">
      <div className="findings-heading">
        <div>
          <p className="eyebrow">Plain-Language Findings</p>
          <h2>What this visit means</h2>
          <a className="glossary-link" href={glossaryHref}>
            Unfamiliar terms are defined in the glossary
          </a>
        </div>
        <span>{automation}</span>
      </div>
      <div className="finding-list">
        {findings.map((finding) => {
          const Icon = FINDING_ICONS[finding.icon];
          const evidenceLink = findingEvidenceLink(finding.id, evidenceArm);
          return (
            <article className={`finding-card tile-${finding.level}`} key={finding.id}>
              <div className="finding-icon">
                <Icon size={18} aria-hidden="true" />
              </div>
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
                <p>{finding.detail}</p>
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
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
