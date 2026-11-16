import type { ReactNode } from "react";
import { loadCorpusOverview } from "@/lib/corpus-overview";
import { loadCommittedCorpusStats } from "@/lib/current-scan-cohort";
import { buildFrontPageRecord, buildSiteRowMarks } from "@/lib/homepage-figures";
import { committedReportLocation } from "@/lib/report-locator";
import { readStoredReportForId } from "@/lib/report-source";
import { FrontPageRecordBlock, SiteRowKey, SiteRowMarksRun } from "./_design/front-page-record";
import { clientReportRuntime } from "./client-runtime";
import { buildCategoryEvidencePages } from "@/lib/directory-view";
import { isFeaturedSiteConfig } from "@/lib/featured-sites";
import { buildHomepageDiscovery, type HomepageReportSource } from "@/lib/homepage-discovery";
import featuredSiteConfigJson from "@/public/featured-sites.json";
import { ScanDisclosure } from "./_components/scan-disclosure";
import { VisitRecords } from "./_design/visit-records";
import { SiteBehaviorApp } from "./site-behavior-app";
import "@/app/_design/fonts.css";
import "@/app/_design/tokens.css";
import "@/app/_design/base.css";
import "@/app/_design/components.css";
import "@/app/_design/report.css";
import "@/app/_design/home.css";
import "@/app/_design/record.css";
import "@/app/_design/explorer.css";

export default async function Home() {
  const { entries, coverageSiteCount, attemptedSiteCount, failedSiteCount, cappedSiteCount } =
    await loadCorpusOverview();
  // The hero's category medians must be the SAME numbers the reader finds on
  // /directory/ and on each /categories/<id>/ page. Those pages publish one
  // cohort per category (chosen by the shared newest-evidence rule in
  // `selectPrimaryCorpusCohort`, not by size), while a corpus-wide rollup mixes a
  // different site set, so deriving the hero from anything else publishes two
  // different medians under one label.
  const categoryPages = buildCategoryEvidencePages(entries);
  const corpusHighlights = {
    attemptedSiteCount,
    loadedSiteCount: coverageSiteCount,
    failedSiteCount,
    cappedSiteCount,
    eligibleSiteCount: categoryPages.reduce((total, category) => total + category.rollup.siteCount, 0),
    // Each category page publishes ONE cohort, but different categories can
    // land on different ones during a methodology migration, so the sum above
    // spans them and no single median covers it. The reader is told how many.
    eligibleCohortCount: new Set(categoryPages.map((category) => category.cohort.id)).size,
    topCategories: [...categoryPages]
      .sort(
        (left, right) =>
          right.rollup.medianTrackers - left.rollup.medianTrackers || left.label.localeCompare(right.label)
      )
      .slice(0, 4)
      .map((category) => ({
        label: category.label,
        medianTrackers: category.rollup.medianTrackers,
        cohort: category.cohort
      }))
  };
  if (!isFeaturedSiteConfig(featuredSiteConfigJson)) {
    throw new Error("public/featured-sites.json is not a valid featured site configuration.");
  }
  const discoveryReports: HomepageReportSource[] = entries.map((entry) => ({
    id: entry.id,
    domain: entry.domain,
    siteKey: entry.siteKey,
    requestedUrl: entry.requestedUrl,
    headline: entry.headline,
    tone: entry.tone,
    scannedAt: entry.scannedAt,
    reportType: entry.reportType,
    comparisonType: entry.comparisonType ?? null,
    thirdPartyRequests: entry.thirdPartyRequests,
    trackerRequests: entry.trackerRequests,
    requestCapped: entry.capped,
    requestEvidenceComplete: entry.requestEvidenceComplete,
    successfulLoad: entry.reportHasSuccessfulLoad
  }));
  const homepageDiscovery = buildHomepageDiscovery(featuredSiteConfigJson, discoveryReports);

  // The front-page record is the report the "Open latest report" link opens:
  // the same selection (homepageDiscovery.latestReport), read once more for
  // its figure. No record is rendered, and nothing in its place, when that
  // report is withheld, did not load or has no figure (lib/homepage-figures.ts).
  const latest = homepageDiscovery.latestReport;
  const latestRead = latest ? await readStoredReportForId(latest.latestReportId) : null;
  const record =
    latest && latestRead?.outcome === "found"
      ? buildFrontPageRecord(latest.latestReportId, latestRead.stored, await loadCommittedCorpusStats())
      : null;

  // Each site row's marks, counted by the report figure's own builder from the
  // report the row links. A report that cannot be read draws no marks.
  const rowMarks: Record<string, ReactNode> = {};
  let rowLowerBound = false;
  for (const item of homepageDiscovery.featuredGroups.flatMap((group) => group.items)) {
    const read = await readStoredReportForId(item.id);
    const marks = read.outcome === "found" ? buildSiteRowMarks(read.stored) : null;
    if (!marks) continue;
    rowMarks[item.id] = <SiteRowMarksRun marks={marks} />;
    rowLowerBound ||= marks.lowerBound;
  }

  // Rendered here, on the server, and handed to the client page as markup, so
  // the disclosure, what a visit records, the record and the marks cost HTML
  // rather than homepage JavaScript.
  return (
    <SiteBehaviorApp
      corpusHighlights={corpusHighlights}
      homepageDiscovery={homepageDiscovery}
      scanDisclosure={<ScanDisclosure />}
      visitRecords={<VisitRecords />}
      frontRecord={
        record && (
          <FrontPageRecordBlock
            record={record}
            href={committedReportLocation(record.reportId, clientReportRuntime()).pagePath}
          />
        )
      }
      rowMarks={rowMarks}
      rowKey={Object.keys(rowMarks).length > 0 ? <SiteRowKey lowerBound={rowLowerBound} /> : null}
    />
  );
}
