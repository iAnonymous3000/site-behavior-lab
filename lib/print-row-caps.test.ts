import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { PRINT_ROW_CAPS } from "./print-row-caps";
import { toReportView } from "./scan-report-views";
import { listStaticReportCandidateIds, readStaticReportBundle } from "./static-report-files";
import { STATE_CHANGE_ROW_LIMIT } from "./report-phase-evidence";

/**
 * lib/print-row-caps.ts claims its ceilings were derived from the committed
 * corpus and that each one clears the observed per-run maximum, so a printed
 * report truncates only where the SCAN truncated. That is a claim about data,
 * and until now nothing re-derived it: the corpus grows every Monday, and a
 * report with more rows than a cap would quietly make the docblock false and
 * silently drop evidence from paper.
 *
 * This measures through the same reader the print route renders from, so it
 * counts rendered rows rather than wire array lengths.
 */

const reportsDir = path.join(process.cwd(), "public", "reports");

type Observed = {
  requests: number;
  domains: number;
  cookies: number;
  storage: number;
  stateChanges: number;
  runs: number;
  reports: number;
};

/** Walking 574 bundles through the managed reader costs ~19s; do it once. */
let observedOnce: Promise<Observed> | null = null;

function observedMaxima(): Promise<Observed> {
  observedOnce ??= walkCorpus();
  return observedOnce;
}

async function walkCorpus(): Promise<Observed> {
  const worst: Observed = {
    requests: 0,
    domains: 0,
    cookies: 0,
    storage: 0,
    stateChanges: 0,
    runs: 0,
    reports: 0
  };

  for (const id of await listStaticReportCandidateIds(reportsDir)) {
    const read = await readStaticReportBundle(reportsDir, id);
    if (read.outcome !== "found") continue;
    worst.reports += 1;
    const view = toReportView(read.stored);
    for (const run of view.runs) {
      worst.runs += 1;
      worst.requests = Math.max(worst.requests, run.evidence.requests.length);
      worst.domains = Math.max(worst.domains, run.evidence.domains.length);
      worst.cookies = Math.max(worst.cookies, run.evidence.cookies.length);
      worst.storage = Math.max(worst.storage, run.evidence.storage.length);
      const changes =
        (run.evidence.cookieMutations?.length ?? 0) + (run.evidence.storageMutations?.length ?? 0);
      worst.stateChanges = Math.max(worst.stateChanges, changes);
    }
  }

  return worst;
}

test("every print row cap clears the corpus maximum it claims to be derived from", async () => {
  const worst = await observedMaxima();
  assert.ok(worst.reports > 0, "the committed corpus must be readable for this claim to mean anything");
  assert.ok(worst.runs >= worst.reports, "a comparison report contributes more than one run");

  for (const family of ["requests", "domains", "cookies", "storage", "stateChanges"] as const) {
    assert.ok(
      PRINT_ROW_CAPS[family] >= worst[family],
      `PRINT_ROW_CAPS.${family} is ${PRINT_ROW_CAPS[family]} but the corpus has a run with ` +
        `${worst[family]} ${family}. A printed report would silently drop evidence. Raise the cap ` +
        "deliberately, or change the docblock's claim that paper truncates only where the scan did."
    );
  }
});

test("the caps are ceilings above the screen limits, not a second set of screen limits", async () => {
  // If a print cap ever fell to or below its screen counterpart the print route
  // would render no more than the interactive page, which is the entire reason
  // the route exists. The screen caps are literals in the components; this
  // pins the relationship rather than the numbers.
  assert.ok(PRINT_ROW_CAPS.requests > 80, "screen renders 80 request rows");
  assert.ok(PRINT_ROW_CAPS.domains > 100, "screen renders 100 domain rows");
  assert.ok(PRINT_ROW_CAPS.cookies > 12, "screen renders 12 cookies");
  assert.ok(PRINT_ROW_CAPS.storage > 12, "screen renders 12 storage keys");
  assert.ok(
    PRINT_ROW_CAPS.stateChanges > STATE_CHANGE_ROW_LIMIT,
    "screen renders STATE_CHANGE_ROW_LIMIT change records"
  );
});

test("the request cap is the scanner's own recording cap, so paper never truncates first", async () => {
  const worst = await observedMaxima();
  // The corpus maximum for requests is the scanner's per-scan recording cap
  // rather than a tail of the distribution: a scan that hits it records a
  // capped-evidence qualification, which the report already carries. Matching
  // the cap exactly means the only truncation a reader sees on paper is the
  // one the scan itself disclosed.
  assert.equal(
    PRINT_ROW_CAPS.requests,
    1_000,
    "the request cap is meant to equal the scanner's recording cap"
  );
  assert.ok(
    worst.requests <= PRINT_ROW_CAPS.requests,
    `the corpus has a run with ${worst.requests} requests, above the recording cap this assumes`
  );
});
