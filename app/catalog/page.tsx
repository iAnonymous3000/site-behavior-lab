import { githubSourceUrlAtBuildCommit } from "@/lib/build-source-url";
import { calibrationIneligibilitySummary } from "@/lib/detector-calibration-reader";
import { committedDetectorCalibrationReadiness } from "@/lib/detector-calibration-source";
import { detectorValidationMetadata, detectorValidationRows } from "@/lib/detector-validation";
import {
  COVERAGE_BOUNDARY_ENTRIES,
  COVERAGE_BOUNDARY_REASON_COPY,
  coverageBoundaryMetadata
} from "@/lib/detector-coverage-boundary";
import { publicPageMetadata } from "@/lib/seo-metadata";
import { trackerCatalogMetadata, trackerCatalogRecords } from "@/lib/tracker-catalog";
import { CatalogSearch } from "./catalog-search";
import styles from "./catalog.module.css";
import { SiteChrome } from "../_components/site-chrome";

export const dynamic = "force-static";

export const metadata = publicPageMetadata({
  title: "Known-service catalog and detector validation",
  description:
    "Review the maintainer-assigned service-domain labels, source-pinned detector fixtures, and current detector-calibration evidence boundary used by Site Behavior Lab.",
  path: "/catalog/"
});

const SOURCE_REPOSITORY = "https://github.com/iAnonymous3000/site-behavior-lab";
const DECLARED_BUILD_COMMIT = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_BUILD_COMMIT?.trim().toLowerCase();
const BUILD_COMMIT = DECLARED_BUILD_COMMIT && /^[0-9a-f]{40}$/.test(DECLARED_BUILD_COMMIT)
  ? DECLARED_BUILD_COMMIT
  : undefined;

export default function CatalogPage() {
  const records = trackerCatalogRecords();
  const validationRows = detectorValidationRows();
  const entities = new Set(records.map((record) => record.entity)).size;
  const categories = new Set(records.map((record) => record.category)).size;
  const realChromiumCases = validationRows.reduce((sum, row) => sum + row.realChromiumCases, 0);
  const calibration = committedDetectorCalibrationReadiness();

  return (
    <SiteChrome activePath="/catalog/">
      <div className={styles.page}>
      <header className={styles.header}>
        <p className="eyebrow">Public evidence register</p>
        <h1>Known-service catalog and validation fixtures</h1>
        <p>
          The catalog contains maintainer-assigned mappings from domain suffixes to recognizable services. Each
          mapping has a reviewer, review date, and functional rationale. Its official link identifies the named
          entity or product; it may not list that suffix or support the maintainer&apos;s category. A match is a useful
          lower-bound label, not proof of why a request occurred, what it carried, or whether it complied with law.
        </p>
      </header>

      <div className={styles.summary} aria-label="Catalog summary">
        <article><strong>{records.length}</strong><span>maintainer-reviewed domain mappings</span></article>
        <article><strong>{entities}</strong><span>named services or operators</span></article>
        <article><strong>{categories}</strong><span>functional labels</span></article>
        <article><strong>{detectorValidationMetadata.cases}</strong><span>source-pinned validation cases</span></article>
        <article><strong>{calibration.eligibleCalibrationStudies}</strong><span>eligible calibration studies</span></article>
      </div>

      <section className={styles.section} aria-labelledby="catalog-heading">
        <h2 id="catalog-heading">Search the service catalog</h2>
        <p className={styles.sectionIntro}>
          This is the effective catalog used for report labels. It is maintained in-repository and does not import a
          competitor tracker dataset. Functional categories are review prompts, not privacy grades.
        </p>
        <p className={styles.note}>
          Reference scope: an official page identifies the named entity or product only. It is not presented as a
          citation for every suffix or as support for the maintainer-assigned category. The mapping and category remain
          reviewable project assertions; report evidence should always be checked in context.
        </p>
        <CatalogSearch records={records} />
        <p className={styles.digest}>
          Catalog {trackerCatalogMetadata.version} · provenance {trackerCatalogMetadata.provenanceVersion} · effective
          digest {trackerCatalogMetadata.digest} · provenance digest {trackerCatalogMetadata.provenanceDigest}
        </p>
      </section>

      <section className={styles.section} aria-labelledby="validation-heading">
        <h2 id="validation-heading">Detector validation fixture coverage</h2>
        <p className={styles.sectionIntro}>
          The matrix below is generated from exact, source-controlled cases in the repository test suite: one positive,
          one negative, and one adversarial or failure-boundary case for every detector. {realChromiumCases} selected
          cases run in real Chromium; the others test deterministic detector logic.
        </p>
        <p className={styles.note}>
          This is an acceptance-fixture inventory, not a representative labeled web corpus. It does not support a
          precision, recall, accuracy, or “all trackers detected” claim. The limitations shown for each detector remain
          part of the result even when every fixture passes.
        </p>
        <p className={styles.note}>
          <strong>
            Calibration status:{" "}
            {calibration.status === "eligible-studies-recorded"
              ? "eligible labeled studies recorded for this exact release."
              : calibration.status === "committed-studies-ineligible"
                ? "committed studies exist, but none is eligible against this exact release."
                : "external labeled corpus required."}
          </strong>{" "}
          The repository contains {calibration.calibrationStudies} committed calibration{" "}
          {calibration.calibrationStudies === 1 ? "study" : "studies"}, of which{" "}
          {calibration.eligibleCalibrationStudies} {calibration.eligibleCalibrationStudies === 1 ? "is" : "are"}{" "}
          eligible under the current release identity, carrying {calibration.labeledCalibrationCases} eligible
          labeled {calibration.labeledCalibrationCases === 1 ? "case" : "cases"}
          {calibration.ineligibleStudyLabeledCases > 0
            ? `; a further ${calibration.ineligibleStudyLabeledCases} labeled ${
                calibration.ineligibleStudyLabeledCases === 1 ? "case" : "cases"
              } in ineligible studies ${
                calibration.ineligibleStudyLabeledCases === 1 ? "supports" : "support"
              } no rate`
            : ""}
          . Eligibility is re-derived on every build against the exact current release identity, so a study bound to
          an earlier build, catalog, or filter-list revision demotes itself automatically. {calibration.evidenceGate}
        </p>
        <p className={styles.note}>
          The published <a href={calibration.studySchemaPath}>{calibration.studySchema} JSON Schema</a> keeps acceptance
          fixtures outside the calibration denominator. {calibration.releaseIdentityGate}{" "}
          {calibration.labelProvenanceGate}
        </p>

        {/* The register a checker actually needs: which studies exist, what
            each measured, and the exact reason its re-analysis withholds a
            rate. The report page states only that no rate is published; the
            per-reason detail lives here, where someone verifying the claim
            can compare it against the analyzer's own vocabulary. */}
        {calibration.studies.length > 0 && (
          <div className={styles.studyRegister}>
            <h3>Committed calibration studies</h3>
            <ul>
              {calibration.studies.map((study) => (
                <li key={study.studyId}>
                  <p className={styles.studyIdentity}>
                    <code>{study.studyId}</code>
                    <span>{study.detector ?? "unidentified detector"}</span>
                    <span className={styles.studyStatus} data-status={study.status}>{study.status}</span>
                  </p>
                  <p className={styles.studyCases}>
                    {study.completeCases} complete {study.completeCases === 1 ? "case" : "cases"}
                    {study.censoredCases > 0 ? `, ${study.censoredCases} censored` : ""}
                  </p>
                  {study.ineligibilityReasons.length > 0 && (
                    <>
                      <p className={styles.studyWhy}>
                        No rate is published because {calibrationIneligibilitySummary(study.ineligibilityReasons)}.
                      </p>
                      <details className={styles.studyReasons}>
                        <summary>Analyzer reasons ({study.ineligibilityReasons.length})</summary>
                        <ul>
                          {study.ineligibilityReasons.map((reason) => (
                            <li key={reason}><code>{reason}</code></li>
                          ))}
                        </ul>
                      </details>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className={styles.validationGrid}>
          {validationRows.map((row) => (
            <article className={styles.validationCard} key={row.detector}>
              <h3>{row.label}</h3>
              <p className={styles.version}>{row.detector} · {row.version}</p>
              <p className={styles.caseCounts}>
                <span>{row.positiveCases} positive</span>
                <span>{row.negativeCases} negative</span>
                <span>{row.adversarialCases} adversarial/boundary</span>
                <span>{row.realChromiumCases} real Chromium</span>
              </p>
              <p className={styles.limitations}>{row.limitations}</p>
              <details>
                <summary>Inspect source-pinned cases</summary>
                <ul className={styles.fixtureList}>
                  {row.fixtures.map((fixture) => (
                    <li key={`${fixture.file}:${fixture.testName}`}>
                      <strong>{fixture.kind}</strong> · {fixture.environment === "real-chromium" ? "real Chromium" : "unit"}
                      <br />{fixture.verifies}
                      {githubSourceUrlAtBuildCommit(SOURCE_REPOSITORY, fixture.file, BUILD_COMMIT) ? (
                        <a href={githubSourceUrlAtBuildCommit(SOURCE_REPOSITORY, fixture.file, BUILD_COMMIT) ?? undefined}>
                          {fixture.testName}
                        </a>
                      ) : (
                        <span>{fixture.testName} (exact source link unavailable in this local build)</span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            </article>
          ))}
        </div>
        <p className={styles.digest}>
          Matrix {detectorValidationMetadata.version} · registry {detectorValidationMetadata.registryVersion} · digest {detectorValidationMetadata.digest}
          {BUILD_COMMIT && <> · build <code>{BUILD_COMMIT}</code></>}
        </p>
      </section>

      <section className={styles.section} id="coverage-boundary">
        <h2>What this scanner does not measure</h2>
        <p className={styles.sectionIntro}>
          Coverage is only a meaningful claim if its edges are stated. These are the privacy-relevant
          things a report never rules out, so a quiet report is not read as an all-clear. The list is
          grouped by why each one is absent, because a surface we have not built is a different fact
          from one we decline to build and from one no page visit can see.
        </p>
        <p className={styles.note}>
          {coverageBoundaryMetadata.checkedClaims} of these {coverageBoundaryMetadata.entries} entries are
          enforced against the scanner source by a test: if that surface is ever instrumented, the build
          fails until this page is corrected. The rest rely on review, and are marked accordingly.
        </p>

        {(["not-instrumented", "declined", "unobservable"] as const).map((reason) => {
          const group = COVERAGE_BOUNDARY_ENTRIES.filter((entry) => entry.reason === reason);
          if (group.length === 0) return null;
          const copy = COVERAGE_BOUNDARY_REASON_COPY[reason];
          return (
            <div className={styles.boundaryGroup} key={reason}>
              <h3>{copy.label}</h3>
              <p className={styles.limitations}>{copy.meaning}</p>
              <div className={styles.validationGrid}>
                {group.map((entry) => (
                  <article className={styles.validationCard} id={entry.id} key={entry.id}>
                    <h4>{entry.label}</h4>
                    <p className={styles.caseCounts}>
                      <span>
                        {entry.absentIdentifiers && entry.absentIdentifiers.length > 0
                          ? "enforced by test"
                          : "reviewed, not test-enforced"}
                      </span>
                    </p>
                    <p className={styles.limitations}>{entry.explanation}</p>
                  </article>
                ))}
              </div>
            </div>
          );
        })}

        <p className={styles.digest}>Boundary {coverageBoundaryMetadata.version}</p>
      </section>
      </div>
    </SiteChrome>
  );
}
