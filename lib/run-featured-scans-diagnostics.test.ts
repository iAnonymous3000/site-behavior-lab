import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

type FeaturedScanDiagnosticHelpers = {
  failureDiagnosticFromStderr(stderr: unknown): string | null;
};

// Preserve native import() after this test is compiled to CommonJS; TypeScript
// would otherwise lower a direct dynamic import to require(), which cannot load
// the source .mjs helper exercised by the actual featured-scan script.
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<FeaturedScanDiagnosticHelpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "run-featured-scans-diagnostics.mjs")).href
);

test("featured-scan diagnostics retain the final child failure reason", async () => {
  const { failureDiagnosticFromStderr } = await helpers;

  assert.equal(
    failureDiagnosticFromStderr(
      "setup detail\nSkipping scan target: primary baseline arm: landing page title matches a bot-block/challenge page.\n"
    ),
    "Skipping scan target: primary baseline arm: landing page title matches a bot-block/challenge page."
  );
  assert.equal(
    failureDiagnosticFromStderr("\nThe page could not be loaded. The site may be down, unreachable, or blocking automated visits.\n"),
    "The page could not be loaded. The site may be down, unreachable, or blocking automated visits."
  );
  assert.equal(failureDiagnosticFromStderr("\n\t\n"), null);
});

test("featured-scan diagnostics strip terminal controls, redact URLs, and cap output", async () => {
  const { failureDiagnosticFromStderr } = await helpers;
  const diagnostic = failureDiagnosticFromStderr(
    `old line\n\u001b[31mRequest failed for https://private.example/path\u001b[0m\u0000 ${"x".repeat(600)}\n`
  );

  assert.ok(diagnostic);
  assert.equal(diagnostic.includes("\u001b"), false);
  assert.equal(diagnostic.includes("private.example"), false);
  assert.equal(diagnostic.includes("[redacted URL]"), true);
  assert.equal(diagnostic.length, 500);
  assert.equal(diagnostic.endsWith("..."), true);
});
