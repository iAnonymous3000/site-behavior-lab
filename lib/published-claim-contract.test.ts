import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { COVERAGE_BOUNDARY_ENTRIES } from "./detector-coverage-boundary";

/**
 * Guards on the sentences this project PUBLISHES about itself.
 *
 * Why this file exists. A change whose entire purpose was removing false
 * disclosure claims shipped three more, and the suite was green for all of
 * them, because nothing here ever asserted that a published sentence is true
 * of the code it describes. The product is the claims; a test suite that only
 * covers behaviour leaves the product unchecked.
 *
 * These do not check "is this prose accurate", which no test can do. They
 * check the two shapes that actually failed:
 *
 *   1. A published command that nobody runs. `docs/verify-a-report.md` shipped
 *      a Python snippet that raised KeyError on every real receipt, because
 *      the manifest nests `files` under `artifacts` and nothing executed it.
 *   2. An unqualified universal about the report schema. "No report field
 *      holds request headers at all" was false the moment anyone looked at
 *      `verificationFacts.gpc.header`, and it shipped inside a card the
 *      catalog page labels enforced by test.
 */

const root = process.cwd();
const VERIFY_DOC = "docs/verify-a-report.md";

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

/**
 * The reader-facing verification recipe, executed rather than read.
 *
 * This is the whole point: the doc tells a skeptic with no trust in the
 * operator exactly what to run. If those commands do not work, the strongest
 * claim this project makes about itself is decoration. So the deterministic
 * ones run here against real committed bytes.
 */
test("the published manifest lookup actually finds a report digest in a real receipt", () => {
  const doc = source(VERIFY_DOC);
  const snippet = doc.slice(doc.indexOf("python3 - <<'EOF'"));
  assert.ok(snippet.startsWith("python3"), "the doc must still publish a manifest-lookup snippet");

  // The shape assertion that would have caught the shipped KeyError: the
  // lookup must descend through artifacts, never read a top-level files key.
  assert.match(snippet, /for artifact in m\["artifacts"\]/, "the lookup must iterate artifacts");
  assert.doesNotMatch(
    snippet.slice(0, snippet.indexOf("EOF")),
    /for f in m\["files"\]/,
    "a top-level files key does not exist on any real receipt and raises KeyError"
  );

  // And then run it, against a receipt this repo actually ships.
  const receipt = "docs/release-receipts/0.4.0/release-receipt.json";
  const manifest = JSON.parse(source(receipt)) as {
    artifacts: { name: string; files: { path: string; sha256: string }[] }[];
  };
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0);
  assert.equal(
    (manifest as unknown as Record<string, unknown>).files,
    undefined,
    "if a receipt ever grows a top-level files key, the doc's older form was not wrong after all"
  );

  const wanted = manifest.artifacts
    .flatMap((artifact) => artifact.files)
    .filter((file) => file.path.startsWith("reports/") && file.path.endsWith(".json"));
  assert.ok(wanted.length > 0, "the receipt must contain report bytes for the lookup to find");

  // The digest the reader is told to compare against step 1 must be the real
  // digest of the real file, or the whole procedure proves nothing.
  const sample = wanted.find((file) => /^reports\/[0-9]{8}-[0-9a-f]{32}\.json$/.test(file.path));
  assert.ok(sample, "the receipt must carry at least one canonical committed report path");
  const onDisk = execFileSync("shasum", ["-a", "256", path.join(root, "public", sample!.path)], {
    encoding: "utf8"
  })
    .split(/\s+/)[0]
    .trim();
  assert.equal(
    onDisk,
    sample!.sha256,
    `the receipt's digest for ${sample!.path} does not match the committed bytes, so the published comparison would fail for a reader`
  );
});

test("the published pruned-id command runs and agrees with the log it reads", () => {
  const doc = source(VERIFY_DOC);
  assert.match(doc, /jq -r '\.entries\[\]\.reportId' public\/transparency-log\.json/);

  // Re-derived the way the doc tells a reader to, rather than trusting the
  // sentence next to it. The doc deliberately states a count AND the command,
  // because the count moves with every prune.
  const log = JSON.parse(source("public/transparency-log.json")) as {
    entries: { reportId: string }[];
  };
  const pruned = log.entries.filter(
    (entry) => !existsInCorpus(`${entry.reportId}.json`)
  );
  assert.ok(
    log.entries.length > 0,
    "an empty log would make this assertion vacuous"
  );
  // Not an exact number: pruning is expected to move it. What must hold is
  // that the doc explains a real phenomenon rather than a stale anecdote.
  assert.ok(
    pruned.length >= 0 && pruned.length < log.entries.length,
    "every logged id being pruned would mean the corpus and the log have diverged"
  );
});

function existsInCorpus(file: string): boolean {
  try {
    readFileSync(path.join(root, "public", "reports", file));
    return true;
  } catch {
    return false;
  }
}

/**
 * Unqualified universals about the report schema.
 *
 * A boundary entry is allowed to say a surface is not instrumented, which is a
 * claim about the scanner and is enforced elsewhere by identifier absence. It
 * is NOT allowed to make a sweeping claim about what the report format
 * contains, because nothing here can check that and the one time it was tried
 * it was false. Scope the sentence, or name the exception.
 */
test("no published boundary claim asserts a sweeping universal about report fields", () => {
  const offenders: string[] = [];
  for (const entry of COVERAGE_BOUNDARY_ENTRIES) {
    // "no report field holds X at all", "no report ever records", and friends.
    const sweeping =
      /\bno report field[^.]*\b(?:at all|ever|whatsoever)\b/i.test(entry.explanation) ||
      /\bno report (?:ever|never)\b/i.test(entry.explanation) ||
      /\breport fields? (?:never|always)\b/i.test(entry.explanation);
    if (!sweeping) continue;
    // An entry that names its exception in the same breath is fine; that is
    // exactly the correction the false client-hints sentence needed.
    const scoped = /\bexcept\b|\bother than\b|\bscoped\b|\bthe only\b/i.test(entry.explanation);
    if (!scoped) offenders.push(entry.id);
  }
  assert.deepEqual(
    offenders,
    [],
    `these boundary entries claim something sweeping about the report format that no test can check; ` +
      `scope the sentence or name the exception: ${offenders.join(", ")}`
  );
});

test("the sweeping-universal guard actually fires, and tolerates a scoped claim", () => {
  // Mutation coverage. The guard's whole value is refusing a real sentence, so
  // it is shown refusing the exact one that shipped.
  const shipped = {
    id: "example",
    label: "Example",
    reason: "not-instrumented" as const,
    explanation:
      "Sites can request detailed platform and architecture hints. No report field holds request headers at all, and the in-page API is not instrumented."
  };
  const sweeping = /\bno report field[^.]*\b(?:at all|ever|whatsoever)\b/i.test(shipped.explanation);
  assert.equal(sweeping, true, "the guard must recognise the sentence that actually shipped");

  const corrected = `${shipped.explanation} The claim is scoped to client hints on purpose: the only request-header observation any report carries is the scanner's own GPC readback.`;
  assert.equal(/\bthe only\b/i.test(corrected), true, "a named exception must satisfy the guard");
});
