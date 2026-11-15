import { ImageResponse } from "next/og";
import { publishedReportCorrections } from "./published-report-corrections";
import {
  HEADLINE_KICKER,
  buildReportHeadline,
  type ReportHeadline,
  type ReportHeadlineStat
} from "./report-headline";
import type { ReportView } from "./scan-report-views";
import { CARD_TEXT_WIDTH, OG_REPORT_CARD_FOOT, OG_REPORT_CARD_PADDING, OG_REPORT_CARD_SIDE, OG_REPORT_CARD_TOP, cardFont, lineCount, sentenceSize } from "./og-card-layout";

/**
 * Shared `next/og` social-card renderers for report and homepage links.
 *
 * Kept out of the route files so both the `opengraph-image` and `twitter-image`
 * conventions can stay thin, self-contained route segments (re-exporting route
 * config across files defeats Next's static analysis under `output: export`).
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";
export const OG_REPORT_SUBHEAD_MAX_CHARACTERS = 300;
/** The bands the card keeps free of text, defined beside its text width (lib/og-card-layout.ts). */
export { OG_REPORT_CARD_PADDING };

const BG = "#0b1110";
const TEXT = "#eef3ef";
const MUTED = "#9bb0a6";
const SUBTLE = "#7a9085";
const HOME_ACCENT = "#2dd4bf";

/** Direction A's paper and inks, as in app/_design/tokens.css. */
const PAPER = "#fbfcfd";
const CARBON = "#101820";
const SLATE = "#46535f";
const RULE = "#c8d1d9";

/** The card's fonts, as next/og takes them: static TrueType instances (lib/og-card-layout.ts). */
function cardFonts() {
  return [
    { name: "STIX Two Text", data: cardFont("serif500"), weight: 500 as const, style: "normal" as const },
    { name: "STIX Two Text", data: cardFont("serif600"), weight: 600 as const, style: "normal" as const },
    { name: "Atkinson Hyperlegible Next", data: cardFont("sans400"), weight: 400 as const, style: "normal" as const },
    { name: "Atkinson Hyperlegible Next", data: cardFont("sans600"), weight: 600 as const, style: "normal" as const }
  ];
}

/**
 * Everything the report card states, in the order it states it, and the sizes
 * it is set at. Built apart from the drawing so a test can hold every card to
 * its rules (the limit whole, the sentence never cut) without decoding images.
 */
export function buildReportCardLayout(view: ReportView) {
  const headline = buildReportHeadline(view);
  const correction = publishedReportCorrections(view.reportId).currentSubjectEvent ? true : false;
  return {
    attribution: buildReportCardAttribution(view, headline.domain),
    // The correction label stands in the kicker's place; an ordinary card has none.
    correctionLabel: headline.kicker !== HEADLINE_KICKER ? headline.kicker : null,
    sentence: headline.headline,
    sentenceSize: sentenceSize(headline.headline),
    limit: correction ? "Read the report and public correction together before using these findings." : headline.caveat,
    subhead: buildReportCardSubhead(view, headline, (text) =>
      text.length <= OG_REPORT_SUBHEAD_MAX_CHARACTERS && lineCount(text, "sans400", 22, CARD_TEXT_WIDTH) <= 3
    ),
    stats: buildReportCardStats(headline)
  };
}

/**
 * The share card, in direction A: paper, Carbon text, no tone colour. The
 * wordmark and the attribution line, the finding sentence (with the
 * correction label above it when there is one), its limit directly under it
 * with the hatched edge, the subhead, and the numbers as plain figures under
 * a rule in the site's rule colour.
 */
export function renderReportCard(view: ReportView): ImageResponse {
  const card = buildReportCardLayout(view);
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          padding: `${OG_REPORT_CARD_TOP}px ${OG_REPORT_CARD_SIDE}px ${OG_REPORT_CARD_FOOT}px`,
          backgroundColor: PAPER,
          color: CARBON,
          fontFamily: "Atkinson Hyperlegible Next"
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexShrink: 0, fontFamily: "STIX Two Text", fontWeight: 600, fontSize: 30 }}>
            Site Behavior Lab
          </div>
          <div style={{ display: "flex", marginLeft: 40, fontSize: 22, lineHeight: "30px", textAlign: "right", justifyContent: "flex-end" }}>
            {card.attribution}
          </div>
        </div>

        {card.correctionLabel && (
          <div style={{ display: "flex", marginTop: 28, fontSize: 20, fontWeight: 600 }}>{card.correctionLabel}</div>
        )}

        <div
          style={{
            display: "flex",
            marginTop: card.correctionLabel ? 10 : 34,
            fontFamily: "STIX Two Text",
            fontWeight: 500,
            fontSize: card.sentenceSize.size,
            lineHeight: `${card.sentenceSize.lineHeight}px`
          }}
        >
          {card.sentence}
        </div>

        <div style={{ display: "flex", marginTop: 16 }}>
          {/* The hatched edge every limit carries (app/_design/components.css). */}
          <div
            style={{
              display: "flex",
              width: 8,
              flexShrink: 0,
              marginTop: 4,
              marginBottom: 4,
              marginRight: 14,
              backgroundImage: `repeating-linear-gradient(135deg, ${CARBON} 0px, ${CARBON} 1.5px, transparent 1.5px, transparent 4.5px)`
            }}
          />
          <div style={{ display: "flex", fontSize: 24, lineHeight: "32px" }}>{card.limit}</div>
        </div>

        <div style={{ display: "flex", marginTop: 16, fontSize: 22, lineHeight: "30px", color: SLATE }}>{card.subhead}</div>

        {card.stats.length > 0 && (
          // A rule across the text width, 24 px above the numerals, anchors the
          // foot row when the sentence is short.
          <div style={{ display: "flex", marginTop: "auto", paddingTop: 24, borderTop: `1px solid ${RULE}` }}>
            {card.stats.map((stat, index) => (
              <div key={stat.label} style={{ display: "flex", flexDirection: "column", marginLeft: index === 0 ? 0 : 48 }}>
                <div style={{ display: "flex", fontFamily: "STIX Two Text", fontWeight: 500, fontSize: 40, lineHeight: "44px" }}>
                  {/* STIX Two Text has no "≥" (it is in STIX Two Math), so the
                      sign is set in Atkinson and the figure in STIX, as the
                      browser does on the site. */}
                  {String(stat.value).match(/^[^0-9]+/) && (
                    <span style={{ fontFamily: "Atkinson Hyperlegible Next", fontWeight: 400 }}>
                      {String(stat.value).match(/^[^0-9]+/)![0]}
                    </span>
                  )}
                  <span>{String(stat.value).replace(/^[^0-9]+/, "")}</span>
                </div>
                <div style={{ display: "flex", fontSize: 20, lineHeight: "26px" }}>{stat.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    ),
    { ...OG_SIZE, fonts: cardFonts() }
  );
}

/**
 * The stat chips the card shows. A pair-framed headline describes a difference
 * between two visits, and its chips are one arm's counts with no arm label, so
 * beside that sentence they read as the other visit's numbers. The card's
 * subhead already carries both visits' figures for those branches; the chips
 * are omitted rather than left unattributed.
 */
export function buildReportCardStats(headline: Pick<ReportHeadline, "stats" | "semantic">): ReportHeadlineStat[] {
  return headline.semantic.runScope === "pair" ? [] : headline.stats.slice(0, 3);
}

/** Permanent social cards always name both the observed site and scan date. */
export function buildReportCardAttribution(view: ReportView, domain = buildReportHeadline(view).domain): string {
  const timestamp = view.reportType === "comparison" ? view.latestRunAt ?? view.scannedAt : view.scannedAt;
  const date = timestamp ? new Date(timestamp) : null;
  const scanDate = date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : "date not recorded";
  return `${truncate(domain, 42)} · ${view.reportType === "comparison" ? "latest visit" : "scanned"} ${scanDate}`;
}

/**
 * Fit report copy semantically, never by cutting characters. Most report
 * subheads already fit intact. When the headline engine supplies a compact
 * restatement for its own full claim, use it only while that source claim is
 * unchanged; a caller-modified headline must not inherit stale compact copy.
 */
export function buildReportCardSubhead(
  view: ReportView,
  headline = buildReportHeadline(view),
  /** Whether a form fits the card; the character bound unless the card measures it. */
  fits: (text: string) => boolean = (text) => text.length <= OG_REPORT_SUBHEAD_MAX_CHARACTERS
): string {
  if (fits(headline.subhead)) return headline.subhead;
  if (
    headline.compactSubhead &&
    headline.compactSubheadSource === headline.subhead &&
    fits(headline.compactSubhead)
  ) {
    return headline.compactSubhead;
  }

  // Before withholding the claim, drop SECONDARY observations. Every headline
  // family may append an "It also looks like ..." clause after its lead
  // finding and that finding's qualification; omitting an additional
  // observation states nothing false, while the fallback below costs the
  // reader both the claim and the hedge that qualifies it. Still semantic:
  // the clause is removed as a whole, by the headline itself, never cut.
  if (
    headline.subheadPrimaryClaim !== headline.subhead &&
    fits(headline.subheadPrimaryClaim)
  ) {
    return headline.subheadPrimaryClaim;
  }

  // Default safe for an unexpectedly long future finding: do not publish a
  // visually severed qualification. The full claim is explicitly withheld
  // from the card and the viewer is directed to its evidence and limitations.
  return (
    "Automated-visit headline only; its claim-specific context does not fit this card. " +
    "Open the report for the complete evidence and limitations, and do not treat this card alone as a verdict or general claim about the site."
  );
}

export function renderMissingReportCard(): ImageResponse {
  return renderBrandedCard("Report not found", "This Site Behavior Lab report is unavailable.");
}

export function renderHomeCard(): ImageResponse {
  return renderBrandedCard(
    "See what a site does, not just what it says.",
    "Point it at any site: it runs a controlled browser visit and shows observed requests, cookie metadata, catalog matches, and fingerprint-like API patterns as reproducible evidence."
  );
}

function renderBrandedCard(title: string, subtitle: string): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          padding: "64px",
          backgroundColor: BG,
          backgroundImage: `radial-gradient(900px 460px at 85% -10%, ${HOME_ACCENT}26, transparent 60%)`,
          color: TEXT,
          fontFamily: "sans-serif"
        }}
      >
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 12, backgroundColor: HOME_ACCENT }} />

        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              backgroundColor: `${HOME_ACCENT}22`,
              border: `2px solid ${HOME_ACCENT}`,
              marginRight: 18
            }}
          />
          <div style={{ display: "flex", fontSize: 28, fontWeight: 700, letterSpacing: 1 }}>SITE BEHAVIOR LAB</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", marginBottom: "auto" }}>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 800, lineHeight: 1.08, maxWidth: 1010 }}>{title}</div>
          <div style={{ display: "flex", fontSize: 28, color: MUTED, marginTop: 22, maxWidth: 980, lineHeight: 1.4 }}>{subtitle}</div>
        </div>

        <div style={{ display: "flex", fontSize: 20, color: SUBTLE }}>open source · reproducible · evidence, not a verdict</div>
      </div>
    ),
    { ...OG_SIZE }
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
