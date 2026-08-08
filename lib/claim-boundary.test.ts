import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { CLAIM_BOUNDARY, claimBoundaryParagraph } from "./claim-boundary";

/**
 * The claim boundary is a decision a named human approved in the release
 * manifest. These assertions check the two ways it can go wrong: the manifest
 * says something the reader is never shown, or the reader is shown something
 * the manifest never approved.
 *
 * Both sides are real here. The module imports the manifest; this file reads
 * the same file off disk independently. Neither side is a fixture.
 */

const root = process.cwd();

const manifest = JSON.parse(readFileSync(path.join(root, "RELEASE_READINESS.json"), "utf8")) as {
  decisions: {
    claimBoundary: {
      recommended: string;
      excludes?: string[];
      status: string;
      decidedBy?: string;
      decidedAt?: string;
    };
  };
};

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

function sourceFiles(dir: string): string[] {
  const absolute = path.join(root, dir);
  const found: string[] = [];
  for (const entry of readdirSync(absolute)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const child = path.join(absolute, entry);
    if (statSync(child).isDirectory()) {
      found.push(...sourceFiles(path.join(dir, entry)));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      found.push(path.join(dir, entry));
    }
  }
  return found;
}

test("the approved boundary resolves, and matches the decision on disk", () => {
  const decision = manifest.decisions.claimBoundary;
  assert.equal(decision.status, "approved", "the claim boundary decision must be approved");
  assert.ok(
    CLAIM_BOUNDARY,
    `no reader copy exists for the approved boundary ${decision.recommended}; a reader would be shown nothing`
  );
  assert.equal(CLAIM_BOUNDARY.id, decision.recommended);
  assert.equal(CLAIM_BOUNDARY.decidedAt, decision.decidedAt);
});

test("every excluded use the manifest names reaches the reader", () => {
  assert.ok(CLAIM_BOUNDARY);
  const excludes = manifest.decisions.claimBoundary.excludes ?? [];
  assert.ok(excludes.length > 0, "the boundary is expected to exclude at least one use");

  // The module returns null rather than a shortened list when a slug has no
  // copy, so a resolved boundary already proves coverage. Assert the count
  // anyway: it names the failure precisely when someone adds a slug.
  const clauses = CLAIM_BOUNDARY.exclusions.split(/,| and /).filter((part) => part.trim().length > 0);
  assert.equal(
    clauses.length,
    excludes.length,
    `the manifest excludes ${excludes.length} uses but the reader sees ${clauses.length}`
  );

  // Spot-check that the prose actually tracks the slugs rather than being a
  // fixed sentence that happens to have the right shape.
  for (const slug of excludes) {
    const head = slug.split("-")[0];
    assert.match(
      CLAIM_BOUNDARY.exclusions,
      new RegExp(head, "i"),
      `the exclusion copy does not mention ${slug}`
    );
  }
});

test("the paragraph states both what a report is and what it is not", () => {
  assert.ok(CLAIM_BOUNDARY);
  const paragraph = claimBoundaryParagraph(CLAIM_BOUNDARY);
  assert.match(paragraph, /^This report is /);
  assert.match(paragraph, /It is not /);
});

test("the boundary reaches paper, the report receipt, and the methodology page", () => {
  for (const file of [
    "app/_components/print-evidence-footer.tsx",
    "app/_components/report-page-context.tsx",
    "app/methodology/page.tsx"
  ]) {
    const contents = source(file);
    assert.match(
      contents,
      /claimBoundaryParagraph\(CLAIM_BOUNDARY\)/,
      `${file} must render the single-sourced boundary`
    );
  }
});

test("the release manifest never enters a client bundle", () => {
  const offenders = [...sourceFiles("app"), ...sourceFiles("lib")]
    .filter((file) => file !== "lib/claim-boundary.ts" && !file.endsWith(".test.ts"))
    .filter((file) => {
      const contents = source(file);
      if (!/^\s*["']use client["']/m.test(contents)) return false;
      return /claim-boundary|RELEASE_READINESS/.test(contents);
    });

  assert.deepEqual(
    offenders,
    [],
    "a client component imports the release manifest; keep the boundary on the server"
  );
});
