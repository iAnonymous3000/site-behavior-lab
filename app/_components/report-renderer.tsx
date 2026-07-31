"use client";

import { useEffect, useMemo, useState } from "react";
import { CausalityGraph } from "./causality-graph";
import { ComparisonPanel } from "./comparison-panel";
import { FindingsBoard, HeadlineBanner, MetricGrid, TrafficViz } from "./report-overview";
import { ReportHeader } from "./report-header";
import {
  CookieList,
  DomainTable,
  FingerprintList,
  PixelEventsList,
  RequestTable,
  StorageList,
  TopThirdParties,
  Warnings
} from "./report-tables";
import { VisitPhasesAndStateChanges } from "./visit-phases-and-state-changes";
import { consentChoiceLabel } from "@/lib/consent-interaction";
import { requestLogToCsv } from "@/lib/csv-export";
import { consentVerificationSummary } from "@/lib/report-consent-copy";
import { buildReportHeadline } from "@/lib/report-headline";
import { buildReportFacts } from "@/lib/report-facts";
import { parseEvidenceHash } from "@/lib/report-evidence-navigation";
import {
  displayableScreenshot,
  gpcRunMeasurement
} from "@/lib/report-insights";
import type { LoadedReport } from "@/lib/scan-report-view";
import {
  comparisonArmViews,
  runQualitySummary,
  schemaProvenanceLabel,
  type ReportView,
  type RunView
} from "@/lib/scan-report-views";
import { plural } from "@/lib/text-format";

/**
 * The evidence-heavy half of the product. The homepage imports this module
 * lazily only after a scan/import has produced a report, while report
 * permalinks import it only after the visitor asks to explore raw evidence.
 * Keeping this boundary independent prevents scanner, archive, watch, and
 * importer code from entering report-page bundles and prevents report tables
 * from entering the homepage's initial route chunk.
 */
export function ReportRenderer({
  loaded,
  liveApiServesReportPages
}: {
  loaded: LoadedReport;
  liveApiServesReportPages: boolean;
}) {
  const reportView = loaded.view;
  const reportFacts = useMemo(() => buildReportFacts(reportView), [reportView]);
  const headline = useMemo(
    () => buildReportHeadline(reportView, reportFacts),
    [reportFacts, reportView]
  );
  const primaryRun = reportFacts.display.run;
  const arms = comparisonArmViews(reportView);
  const [selectedArm, setSelectedArm] = useState<"baseline" | "variant" | null>(null);

  useEffect(() => {
    setSelectedArm(null);
  }, [loaded]);

  useEffect(() => {
    function selectLinkedEvidenceArm(hash: string) {
      const target = parseEvidenceHash(hash);
      if (target?.arm) setSelectedArm(target.arm);
    }
    const selectCurrentLinkedEvidenceArm = () => selectLinkedEvidenceArm(window.location.hash);
    function selectRepeatedLinkedEvidenceArm(event: MouseEvent) {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a");
      const href = anchor?.getAttribute("href") ?? "";
      if (!href.startsWith("#evidence=") || anchor?.hash !== window.location.hash) return;
      selectLinkedEvidenceArm(anchor.hash);
    }

    selectCurrentLinkedEvidenceArm();
    window.addEventListener("hashchange", selectCurrentLinkedEvidenceArm);
    document.addEventListener("click", selectRepeatedLinkedEvidenceArm);
    return () => {
      window.removeEventListener("hashchange", selectCurrentLinkedEvidenceArm);
      document.removeEventListener("click", selectRepeatedLinkedEvidenceArm);
    };
  }, [loaded]);

  const headlineFocusArm = arms ? headline.focusArm ?? null : null;
  const defaultArm: "baseline" | "variant" =
    headlineFocusArm ?? (reportView.comparison?.temporalPair ? "variant" : "baseline");
  const displayedArmLabel: "baseline" | "variant" = selectedArm ?? defaultArm;
  const displayedFacts =
    arms && reportFacts.arms ? reportFacts.arms[displayedArmLabel] : reportFacts.display;
  const displayedRun = displayedFacts.run;
  const screenshot = displayableScreenshot(displayedRun.screenshot);
  // The capture itself is right to keep: it is the reader's only direct look at
  // what the scanner actually hit. What was missing is the caption. A block page
  // scaled into the sidebar column is often near-blank, which reads either as a
  // broken image or as a claim that the site is a blank page.
  const screenshotFailureStatus =
    displayedFacts.subject.kind === "http-error" ? displayedFacts.subject.status : null;
  const screenshotSubjectUnverified = displayedFacts.subject.kind === "unverified";
  const screenshotSoftBlock = displayedFacts.subject.kind === "interstitial";
  const screenshotFailedLoad = !displayedFacts.subject.describesSubject;
  const screenshotSubject =
    screenshotFailureStatus !== null
      ? `the HTTP ${screenshotFailureStatus} error or block page returned by ${displayedRun.domain}`
      : screenshotSubjectUnverified
        ? `an unverified page subject returned while scanning ${displayedRun.domain}`
        : screenshotSoftBlock
          ? `the suspected challenge or soft-block page returned by ${displayedRun.domain}`
          : screenshotFailedLoad
            ? `the page ${displayedRun.domain} returned on a load that did not complete`
            : displayedRun.domain;

  async function downloadReport() {
    const { publicWireForExportOrPersistence } = await import("@/lib/scan-report-view");
    const blob = new Blob([JSON.stringify(publicWireForExportOrPersistence(loaded), null, 2)], {
      type: "application/json"
    });
    downloadBlob(blob, `site-behavior-lab-${safeFilenamePart(primaryRun.domain)}.json`);
  }

  function downloadCsv() {
    const csv = requestLogToCsv(displayedRun.evidence.requests);
    const armPart = arms ? `-${safeFilenamePart(armDisplayLabel(reportView, displayedArmLabel))}` : "";
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      `site-behavior-lab-${safeFilenamePart(displayedRun.domain)}${armPart}-requests.csv`
    );
  }

  return (
    <>
      <p className="visually-hidden" role="status" aria-live="polite">
        {`Scan report ready for ${primaryRun.domain}: ${plural(
          primaryRun.evidence.requests.length,
          "recorded request row"
        )}.${reportFacts.display.subject.describesSubject ? "" : " The requested page was not established."}`}
      </p>
      <section className="report-grid">
        <div className="report-main">
          <ReportHeader
            share={loaded.wire.share ?? null}
            view={reportView}
            runFacts={displayedFacts}
            evidenceFacts={displayedFacts}
            csvArmLabel={arms ? armDisplayLabel(reportView, displayedArmLabel) : null}
            onDownload={() => void downloadReport()}
            onDownloadCsv={downloadCsv}
            liveApiServesReportPages={liveApiServesReportPages}
          />
          <HeadlineBanner
            share={loaded.wire.share ?? null}
            headline={headline}
            liveApiServesReportPages={liveApiServesReportPages}
          />
          <FindingsBoard view={reportView} facts={reportFacts} headline={headline} />
          {reportView.reportType === "comparison" && (
            <ComparisonPanel view={reportView} facts={reportFacts} />
          )}
          {arms && (
            <div className="arm-switcher" role="group" aria-label="Which visit's evidence the tables below show">
              <span>Evidence shown:</span>
              {(["baseline", "variant"] as const).map((arm) => (
                <button
                  key={arm}
                  type="button"
                  className={`arm-option${displayedArmLabel === arm ? " is-active" : ""}`}
                  aria-pressed={displayedArmLabel === arm}
                  onClick={() => setSelectedArm(arm)}
                >
                  {armDisplayLabel(reportView, arm)}
                </button>
              ))}
              <p className="visually-hidden" role="status" aria-live="polite">
                {`Showing evidence from the ${armDisplayLabel(reportView, displayedArmLabel)} visit.`}
              </p>
            </div>
          )}
          <CausalityGraph requests={displayedRun.evidence.requests} />
          <MetricGrid facts={displayedFacts} />
          <TrafficViz facts={displayedFacts} />
          <VisitPhasesAndStateChanges run={displayedRun} />
          <Warnings warnings={reportView.warnings} />
        </div>

        <aside className="report-sidebar" aria-label="Supporting report evidence">
          {screenshot && (
            <section className="side-card screenshot-card">
              <h2>Viewport</h2>
              <img
                src={screenshot}
                alt={`Screenshot of ${screenshotSubject}`}
                loading="lazy"
                decoding="async"
              />
              {screenshotFailedLoad && (
                <p className="muted">
                  {screenshotFailureStatus !== null
                    ? `This is the HTTP ${screenshotFailureStatus} error or block page, not the site. A near-blank image is what the browser actually rendered.`
                    : screenshotSubjectUnverified
                      ? "The scanner could not verify that this rendered document was the requested page."
                      : screenshotSoftBlock
                        ? "This is the suspected challenge or soft-block page the browser rendered, not a normal load of the site."
                        : "This is what the browser rendered on a load that did not complete, not the site."}
                </p>
              )}
            </section>
          )}

          <section className="side-card">
            <h2>Top Third Parties</h2>
            <TopThirdParties facts={displayedFacts} />
          </section>

          {displayedRun.evidence.pixelEvents.length > 0 && (
            <section className="side-card">
              <h2>Advertising Pixels</h2>
              <PixelEventsList pixels={displayedRun.evidence.pixelEvents} facts={displayedFacts} />
            </section>
          )}

          <section className="side-card">
            <h2>Cookies</h2>
            <CookieList
              cookies={displayedRun.evidence.cookies}
              facts={displayedFacts}
            />
          </section>

          <section className="side-card">
            <h2>Storage</h2>
            <StorageList
              storage={displayedRun.evidence.storage}
              facts={displayedFacts}
            />
          </section>

          <section className="side-card">
            <h2>Browser Behavior Signals</h2>
            <FingerprintList
              events={displayedRun.evidence.fingerprintEvents}
              detections={displayedRun.evidence.fingerprintDetections}
              facts={displayedFacts}
            />
          </section>

          <section className="side-card methodology">
            <h2>Methodology</h2>
            <dl>
              <div><dt>Schema</dt><dd>{schemaProvenanceLabel(reportView)}</dd></div>
              <div><dt>Run quality</dt><dd>{runQualitySummary(displayedRun)}</dd></div>
              <div><dt>Scanner</dt><dd>{displayedRun.conditions.automation}</dd></div>
              {displayedRun.conditions.automation === "playwright-chromium" && (
                <div><dt>Playwright</dt><dd>{displayedRun.conditions.playwrightVersion ?? "not recorded"}</dd></div>
              )}
              <div><dt>Browser</dt><dd>{displayedRun.conditions.browserVersion ?? "not recorded"}</dd></div>
              <div><dt>Timezone</dt><dd>{displayedRun.conditions.timezone}</dd></div>
              <div><dt>Headless</dt><dd>{displayedRun.conditions.headless ? "yes" : "no"}</dd></div>
              <div>
                <dt>Viewport</dt>
                <dd>{displayedRun.conditions.viewport.width}×{displayedRun.conditions.viewport.height}</dd>
              </div>
              <div><dt>GPC</dt><dd>{gpcMethodologyLabel(displayedRun)}</dd></div>
              {displayedRun.consent && (
                <div>
                  <dt>Consent</dt>
                  <dd>
                    {displayedRun.consent.controlActivated
                      ? `${
                          displayedRun.consent.matchedControlQualification
                            ? // The click is evidence of which control was activated, not of
                              // what it expressed, so the row states the request rather than
                              // asserting the choice as an outcome.
                              `asked for "${consentChoiceLabel(displayedRun.consent.mode)}"`
                            : `clicked "${consentChoiceLabel(displayedRun.consent.mode)}"`
                        }${displayedRun.consent.cmp ? ` (${displayedRun.consent.cmp})` : ""}${
                          displayedRun.consent.matchedControlQualification
                            ? `; clicked ${displayedRun.consent.matchedControlQualification}`
                            : ""
                        }`
                      : "no control activation recorded"}
                    {` · ${consentVerificationSummary(displayedRun.consent)}`}
                  </dd>
                </div>
              )}
              <div><dt>Egress</dt><dd>{displayedRun.conditions.scannerEgress}</dd></div>
              {displayedRun.conditions.trackerCatalog && (
                <div>
                  <dt>Catalog</dt>
                  <dd>
                    {displayedRun.conditions.trackerCatalog.source}<br />
                    {displayedRun.conditions.trackerCatalog.region
                      ? `${displayedRun.conditions.trackerCatalog.region} · `
                      : ""}
                    {displayedRun.conditions.trackerCatalog.version}<br />
                    {displayedRun.conditions.trackerCatalog.entries.toLocaleString("en-US")} entries
                  </dd>
                </div>
              )}
              {displayedRun.conditions.adblockLists && (
                <div>
                  <dt>Brave Shields lists</dt>
                  <dd>
                    {displayedRun.conditions.adblockLists.source}<br />
                    {displayedRun.conditions.adblockLists.lists.toLocaleString("en-US")} lists · fetched{" "}
                    {formatListSnapshot(displayedRun.conditions.adblockLists.fetchedAt)}
                  </dd>
                </div>
              )}
            </dl>
            {displayedRun.conditions.disclosure && <p>{displayedRun.conditions.disclosure}</p>}
          </section>
        </aside>

        <div className="report-evidence-tables" aria-label="Raw report evidence">
          <DomainTable domains={displayedRun.evidence.domains} facts={displayedFacts} />
          <RequestTable
            requests={displayedRun.evidence.requests}
            phases={displayedRun.phases}
            facts={displayedFacts}
          />
        </div>
      </section>
    </>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "") || "report";
}

// Builds that could not read the vendored list metadata record `fetchedAt` as the
// literal "unknown" sentinel, and imported report files can carry anything. Say the
// provenance is missing rather than rendering "Invalid Date" in the methodology block.
function formatListSnapshot(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date not recorded";
  return date.toLocaleDateString("en-US", { timeZone: "UTC" });
}

function gpcMethodologyLabel(run: RunView): string {
  const measurement = gpcRunMeasurement(run);
  if (measurement.outcome === "verified") {
    return `${measurement.configured ? "configured on" : "configured off"} · readback verified`;
  }
  if (measurement.outcome === "contradicted") {
    return `${measurement.configured ? "configured on" : "configured off"} · readback contradicted`;
  }
  if (measurement.outcome === "unverified") {
    return `${measurement.configured ? "configured on" : "configured off"} · readback inconclusive`;
  }
  return `${measurement.configured ? "configured on" : "configured off"} · readback not recorded`;
}

function armDisplayLabel(view: ReportView, arm: "baseline" | "variant"): string {
  return view.comparison?.runLabels[arm] ?? (arm === "baseline" ? "Baseline" : "Variant");
}
