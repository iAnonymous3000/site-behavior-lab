import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// First-ever coverage of the two error boundaries. The unit harness compiles
// only lib/*.ts (no JSX), and Next's dev overlay swallows global-error, so
// nothing renders these components in any gate today; a deleted retry button
// or a base-path-unsafe recovery link would ship silently. These pins hold
// the RECOVERY CONTRACT in the source: every affordance a stranded reader
// needs, and the constraints each boundary documents for itself.

function boundarySource(name: string): string {
  return readFileSync(path.join(process.cwd(), "app", name), "utf8");
}

for (const name of ["error.tsx", "global-error.tsx"]) {
  test(`${name} keeps the full recovery contract`, () => {
    const source = boundarySource(name);
    // A reset-invoking retry button: the one-click recovery path.
    assert.match(source, /<button className="primary-button" type="button" onClick=\{reset\}>Retry<\/button>/);
    // Both escape hatches, routed through staticAssetPath so they survive a
    // base-path deployment even when the app shell is the thing that broke.
    assert.match(source, /href=\{staticAssetPath\("\/"\)\}/);
    assert.match(source, /href=\{staticAssetPath\("\/directory\/"\)\}/);
    assert.doesNotMatch(
      source,
      /href="\//,
      "recovery links must never hardcode root-relative paths; base-path deployments would 404"
    );
    // Announced as an alert and labelled for assistive tech.
    assert.match(source, /role="alert"/);
    assert.match(source, /aria-labelledby="/);
    // Client component contract Next requires of boundaries.
    assert.match(source, /^"use client";/);
    assert.match(source, /reset: \(\) => void/);
  });
}

test("global-error.tsx owns the document, error.tsx never does", () => {
  const globalError = boundarySource("global-error.tsx");
  // The root boundary replaces the whole document, so it must render html and
  // body itself and carry its own stylesheet import; the route boundary must
  // NOT, because it renders inside the still-mounted root layout.
  assert.match(globalError, /<html lang="en">/);
  assert.match(globalError, /<body>/);
  assert.match(globalError, /import "\.\/globals\.css";/);

  const routeError = boundarySource("error.tsx");
  assert.doesNotMatch(routeError, /<html/);
  assert.doesNotMatch(routeError, /<body>/);
});
