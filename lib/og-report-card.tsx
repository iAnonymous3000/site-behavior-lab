import { ImageResponse } from "next/og";
import { buildReportHeadline, type HeadlineTone, type ReportHeadlineStat } from "./report-headline";
import type { ScanReport } from "./types";

/**
 * Shared `next/og` social-card renderers for report and homepage links.
 *
 * Kept out of the route files so both the `opengraph-image` and `twitter-image`
 * conventions can stay thin, self-contained route segments (re-exporting route
 * config across files defeats Next's static analysis under `output: export`).
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

const TONE_HEX: Record<HeadlineTone, string> = {
  alarm: "#fb7185",
  warn: "#f5a524",
  info: "#7fb3ef",
  calm: "#4ade80"
};

const BG = "#0b1110";
const SURFACE = "#182220";
const BORDER = "#2c3d38";
const TEXT = "#eef3ef";
const MUTED = "#9bb0a6";
const SUBTLE = "#7a9085";
const HOME_ACCENT = "#2dd4bf";

export function renderReportCard(report: ScanReport): ImageResponse {
  const headline = buildReportHeadline(report);
  const accent = TONE_HEX[headline.tone];
  const stats = headline.stats.slice(0, 3);
  const headlineSize = headline.headline.length > 64 ? 50 : headline.headline.length > 44 ? 58 : 66;
  const subhead = truncate(headline.subhead, 150);

  return new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          padding: "60px 64px",
          backgroundColor: BG,
          backgroundImage: `radial-gradient(900px 420px at 88% -8%, ${accent}26, transparent 60%)`,
          color: TEXT,
          fontFamily: "sans-serif"
        }}
      >
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 12, backgroundColor: accent }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                backgroundColor: `${accent}22`,
                border: `2px solid ${accent}`,
                marginRight: 18
              }}
            />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 1 }}>SITE BEHAVIOR LAB</div>
              <div style={{ fontSize: 18, color: MUTED }}>See what a site does, not what it says.</div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 26,
              fontWeight: 700,
              color: TEXT,
              padding: "10px 20px",
              borderRadius: 999,
              backgroundColor: SURFACE,
              border: `1px solid ${BORDER}`
            }}
          >
            {truncate(headline.domain, 30)}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", marginBottom: "auto" }}>
          <div style={{ display: "flex", fontSize: 22, fontWeight: 700, letterSpacing: 2, color: accent, textTransform: "uppercase" }}>
            {headline.kicker}
          </div>
          <div style={{ display: "flex", fontSize: headlineSize, fontWeight: 800, lineHeight: 1.1, marginTop: 14 }}>
            {headline.headline}
          </div>
          <div style={{ display: "flex", fontSize: 26, color: MUTED, lineHeight: 1.4, marginTop: 18, maxWidth: 1000 }}>
            {subhead}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "flex" }}>
            {stats.map((stat) => (
              <StatChip key={stat.label} stat={stat} accent={accent} />
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <div style={{ display: "flex", fontSize: 18, color: SUBTLE }}>open source · reproducible</div>
            <div style={{ display: "flex", fontSize: 16, color: SUBTLE, marginTop: 4, maxWidth: 360, textAlign: "right" }}>
              {headline.caveat}
            </div>
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE }
  );
}

export function renderMissingReportCard(): ImageResponse {
  return renderBrandedCard("Report not found", "This Site Behavior Lab report is unavailable.");
}

export function renderHomeCard(): ImageResponse {
  return renderBrandedCard(
    "See what a site does, not just what it says.",
    "Point it at any site: it runs a controlled browser visit and shows the trackers, cookies, and fingerprinting it actually loads, as reproducible evidence."
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

function StatChip({ stat, accent }: { stat: ReportHeadlineStat; accent: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "14px 20px",
        marginRight: 14,
        borderRadius: 14,
        backgroundColor: stat.emphasis ? `${accent}1f` : SURFACE,
        border: `1px solid ${stat.emphasis ? accent : BORDER}`
      }}
    >
      <div style={{ display: "flex", fontSize: 40, fontWeight: 800, color: stat.emphasis ? accent : TEXT }}>{stat.value}</div>
      <div style={{ display: "flex", fontSize: 18, color: MUTED, marginTop: 2 }}>{stat.label}</div>
    </div>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
