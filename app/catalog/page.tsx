import Link from "next/link";
import { githubSourceUrlAtBuildCommit } from "@/lib/build-source-url";
import { detectorValidationMetadata, detectorValidationRows } from "@/lib/detector-validation";
import { publicPageMetadata } from "@/lib/seo-metadata";
import { trackerCatalogMetadata, trackerCatalogRecords } from "@/lib/tracker-catalog";
import { CatalogSearch } from "./catalog-search";
import styles from "./catalog.module.css";

export const dynamic = "force-static";

export const metadata = publicPageMetadata({
  title: "Known-service catalog and detector validation",
  description:
    "Review the maintainer-assigned service-domain labels, entity references, and source-pinned detector fixtures used by Site Behavior Lab.",
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

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className="eyebrow">Public evidence register</p>
        <h1>Known-service catalog and validation fixtures</h1>
        <p>
          The catalog contains maintainer-assigned mappings from domain suffixes to recognizable services. Each
          mapping has a reviewer, review date, and functional rationale. Its official link identifies the named
          entity or product; it may not list that suffix or support the maintainer&apos;s category. A match is a useful
          lower-bound label—not proof of why a request occurred, what it carried, or whether it complied with law.
        </p>
        <p className={styles.back}><Link href="/">&larr; Back to Site Behavior Lab</Link></p>
      </header>

      <div className={styles.summary} aria-label="Catalog summary">
        <article><strong>{records.length}</strong><span>maintainer-reviewed domain mappings</span></article>
        <article><strong>{entities}</strong><span>named services or operators</span></article>
        <article><strong>{categories}</strong><span>functional labels</span></article>
        <article><strong>{detectorValidationMetadata.cases}</strong><span>source-pinned validation cases</span></article>
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
    </main>
  );
}
