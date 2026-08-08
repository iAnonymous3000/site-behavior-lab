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

  // Every excluded use must carry its own negation. "It is not A and B"
  // parses as "not (A and B)", which permits being exactly one of them: a
  // weaker claim than the approved decision, printed where a reader cannot
  // check it. A single shared "not" is a real defect, not a style choice.
  const excludes = manifest.decisions.claimBoundary.excludes ?? [];
  assert.equal(
    [...CLAIM_BOUNDARY.exclusions.matchAll(/\bnot\b/g)].length,
    excludes.length,
    "each excluded use must be negated individually"
  );
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
  // Grepping each file for its own "use client" line does not answer this.
  // In the App Router the directive is inherited through imports: a module
  // with no directive that is imported by a client component is compiled into
  // the client bundle with it. print-evidence-footer.tsx carries no directive
  // and imports this module, so moving it inside saved-report-client.tsx (an
  // obvious refactor: the footer belongs with the report body) would ship the
  // whole release manifest to every browser. So walk the graph.
  const files = new Set([...sourceFiles("app"), ...sourceFiles("lib")]);

  function resolve(fromFile: string, specifier: string): string | null {
    let base: string;
    if (specifier.startsWith("@/")) base = specifier.slice(2);
    else if (specifier.startsWith(".")) base = path.posix.join(path.posix.dirname(fromFile), specifier);
    else return null; // a package, not our source
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (files.has(candidate)) return candidate;
    }
    return null;
  }

  function importsOf(file: string): string[] {
    const contents = source(file);
    const specifiers = [...contents.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
    return specifiers
      .map((specifier) => resolve(file, specifier))
      .filter((resolved): resolved is string => resolved !== null);
  }

  const clientRoots = [...files].filter((file) => /^\s*["']use client["']/m.test(source(file)));
  assert.ok(clientRoots.length > 0, "the walk must start somewhere; no client components were found");

  const reachedBy = new Map<string, string[]>();
  for (const rootFile of clientRoots) {
    const queue: string[][] = [[rootFile]];
    const seen = new Set([rootFile]);
    while (queue.length > 0) {
      const trail = queue.shift()!;
      const current = trail[trail.length - 1];
      for (const next of importsOf(current)) {
        if (seen.has(next)) continue;
        seen.add(next);
        const extended = [...trail, next];
        if (next === "lib/claim-boundary.ts") reachedBy.set(rootFile, extended);
        queue.push(extended);
      }
    }
  }

  assert.deepEqual(
    [...reachedBy.values()].map((trail) => trail.join(" -> ")),
    [],
    "a client component reaches the release manifest through its import graph; keep the boundary on the server"
  );
});
