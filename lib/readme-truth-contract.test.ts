import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { COVERAGE_BOUNDARY_ENTRIES, coverageBoundaryMetadata } from "./detector-coverage-boundary";

const root = process.cwd();
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const methodology = readFileSync(path.join(root, "app/methodology/page.tsx"), "utf8");

/**
 * The README is a published claim surface, so it gets the same treatment as the
 * report copy: assertions against the code, not against a snapshot of itself.
 *
 * An audit of all 515 lines found six false or overstated statements. Each test
 * below fails against the sentence that shipped. The shape matters as much as
 * the coverage: these assert that a named thing EXISTS and that a stated fact
 * re-derives from its source of truth. They deliberately avoid pinning exact
 * prose, which is how the About-footer and setUrlError guards ended up breaking
 * on refactors while missing the defects they existed to catch.
 */

/**
 * The README claimed the WAF and log-retention follow-ups were closed. Both
 * gates report open, because their canonical receipts are not committed. A
 * release-readiness claim in prose must not contradict the evaluator.
 */
test("the README never claims a release gate is closed while its receipt is absent", () => {
  const gateReceipts: Record<string, string> = {
    "waf-ceilings": "research/ops-evidence/waf-ceilings.json",
    "log-retention": "research/ops-evidence/log-retention.json",
    "egress-backstop": "research/ops-evidence/egress-backstop.json"
  };
  for (const [gate, receipt] of Object.entries(gateReceipts)) {
    if (existsSync(path.join(root, receipt))) continue;
    // The receipt is missing, so the gate is open. The README may DESCRIBE the
    // observation; it may not say the follow-up is closed or the gate is met.
    const closedClaim = new RegExp(
      `(close[sd]?|closes out|satisfie[sd]|meets?) the [^.]*${gate.replace("-", "[ -]")}`,
      "i"
    );
    assert.doesNotMatch(
      readme,
      closedClaim,
      `${receipt} does not exist, so the ${gate} gate is open and the README must not call it closed`
    );
  }
  // The specific sentence that shipped, kept as a named regression.
  assert.doesNotMatch(
    readme,
    /close the WAF and historical log-query follow-ups/,
    "this sentence claimed two open gates were closed"
  );
});

/**
 * Anchors cover a PREFIX. The log had 676 entries and three anchors, all for
 * the same head at 478, so 198 entries had no external time bound. The README
 * said heads carry anchors "covering the entries beneath them", which reads as
 * total coverage.
 */
test("the README describes transparency-log anchoring as a prefix while a gap exists", () => {
  const log = JSON.parse(readFileSync(path.join(root, "public/transparency-log.json"), "utf8")) as {
    entries: unknown[];
    anchors?: { entryCount: number }[];
  };
  const entryCount = log.entries.length;
  const anchored = Math.max(0, ...(log.anchors ?? []).map((anchor) => anchor.entryCount));
  if (anchored >= entryCount) return; // fully anchored: a total claim would be fair

  assert.match(
    readme,
    /anchors cover a prefix|most recently anchored head|no external time bound/i,
    `${entryCount - anchored} entries sit beyond the last anchor, so the README must say anchoring covers a prefix`
  );
});

/**
 * The catalog page publishes both kinds of boundary entry: test-enforced and
 * review-only. The README said the blind spots are published "with the test
 * that keeps each claim honest", implying every entry is enforced. It is 10 of
 * 17.
 */
test("the README does not imply every coverage-boundary entry is test-enforced", () => {
  const enforced = coverageBoundaryMetadata.checkedClaims;
  const total = COVERAGE_BOUNDARY_ENTRIES.length;
  assert.ok(enforced < total, "if every entry became enforced, this guard and the README copy should be revisited");

  assert.doesNotMatch(
    readme,
    /blind spots are published on the\s*\[catalog page\]\([^)]*\) with the test that keeps each\s*claim honest/,
    `only ${enforced} of ${total} entries are test-enforced, so "the test that keeps each claim honest" overstates`
  );
  assert.match(
    readme,
    /whether a test enforces it against the scanner source or it rests on review/,
    "the README must distinguish enforced entries from reviewed ones"
  );
});

/**
 * Every header the scan gate actually accepts must be listed, or an operator
 * locking down a deployment will not know a third one opens it.
 */
test("the README lists every header that satisfies the scan access token", () => {
  const gate = readFileSync(path.join(root, "lib/scan-token.ts"), "utf8");
  const headers = [...gate.matchAll(/["'`](x-[a-z0-9-]*(?:token|access)[a-z0-9-]*)["'`]/gi)].map((m) =>
    m[1].toLowerCase()
  );
  const unique = [...new Set(headers)];
  assert.ok(unique.length > 0, "no access header literals found; this guard is not testing anything");
  for (const header of unique) {
    assert.ok(
      readme.toLowerCase().includes(header),
      `lib/scan-token.ts accepts ${header} but the README does not mention it`
    );
  }
});

/**
 * The methodology identity enumerated five suffixes while the producer emitted
 * eight. A reader comparing a report's provenance against the README would
 * conclude their report was malformed.
 */
test("the README enumerates every methodology suffix the r2 producer emits", () => {
  // Parse the ACTIVE constant only. A broad sweep for every `-vN` literal in
  // this file also collects HISTORICAL_* identities, which are deliberately
  // frozen and must not be enumerated in the README.
  const source = readFileSync(path.join(root, "lib/scan-report-v2-r2-producer-contract.ts"), "utf8");
  const active = source.slice(source.indexOf("export const NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION"));
  const template = active.slice(active.indexOf("`") + 1, active.indexOf("`", active.indexOf("`") + 1));
  assert.ok(template.includes("+"), "the active r2 methodology template was not found");
  const suffixes = template
    .split("+")
    .map((part) => part.trim())
    .filter((part) => /^[a-z][a-z-]*-v\d+$/.test(part));
  assert.ok(suffixes.length > 0, "no methodology suffixes found; the source path likely moved");

  const listed = readme.slice(readme.indexOf("provenance.methodologyVersion") - 600);
  // The README shortens names in prose ("budget" for resource-budget,
  // "accountability" for detector-accountability), which is fine. What must
  // hold is that each emitted suffix is RECOGNISABLE in the enumeration, so a
  // genuinely omitted one (no distinctive word present) still fails.
  for (const suffix of suffixes) {
    const words = suffix
      .replace(/-v\d+$/, "")
      .split("-")
      .filter((word) => word.length >= 5);
    assert.ok(
      words.length > 0 && words.some((word) => listed.includes(word)),
      `the r2 producer emits ${suffix} but the README's methodology enumeration names none of ${words.join(", ")}`
    );
  }
});

/**
 * The scanner returns before adding a typed-field warning when no field took
 * the sentinel. Once at least one field took it, both the ordinary path and
 * the failure/timeout paths preserve the live count. Published explanations
 * must therefore describe a conditional disclosure, not promise a count in
 * every report.
 */
test("published interaction copy matches the scanner's conditional typed-field disclosure", () => {
  const scanner = readFileSync(path.join(root, "lib/scanner.ts"), "utf8");
  const zeroFieldReturn = scanner.indexOf("if (typed.count === 0)");
  const ordinaryDisclosure = scanner.indexOf(
    "addKeystrokeProbeDisclosure(warnings, typed.count);",
    zeroFieldReturn
  );
  assert.ok(zeroFieldReturn >= 0, "the scanner's zero-field branch was not found");
  assert.ok(
    ordinaryDisclosure > zeroFieldReturn,
    "the scanner must return the zero-field outcome before adding the ordinary typed-field disclosure"
  );
  assert.match(
    scanner,
    /typedFieldCount\s*>\s*0[\s\S]{0,160}addKeystrokeProbeDisclosure\(warnings,\s*keystrokeProbeLifecycle\.typedFieldCount\)/,
    "a timed-out probe must preserve the count after at least one field accepted the sentinel"
  );

  for (const [label, document] of [
    ["README", readme],
    ["methodology page", methodology]
  ] as const) {
    assert.doesNotMatch(
      document,
      /every report discloses (?:exactly what was typed|how many fields were typed)/i,
      `${label} must not promise a typed-field count in reports where the probe had no accepted field`
    );
    assert.match(
      document,
      /at least one field accepts?|at least one field accepted/i,
      `${label} must scope the count to visits where a field accepted the synthetic value`
    );
    assert.match(
      document,
      /no field accepted[\s\S]{0,100}no (?:such statement|typed-field count)/i,
      `${label} must disclose that a zero-accepted-field visit carries no count`
    );
  }
});

/**
 * Every path and npm script the README names must exist. Two npm scripts were
 * deleted as dead code in the same session this guard was written, and the
 * check that they were undocumented was scoped to the removal rather than to
 * the whole README.
 */
test("every repository path and npm script the README names exists", () => {
  const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts as Record<
    string,
    string
  >;

  const named = [...readme.matchAll(/`npm run ([a-z0-9:_-]+)`/g)].map((m) => m[1]);
  for (const script of [...new Set(named)]) {
    assert.ok(scripts[script], `README documents \`npm run ${script}\` but package.json has no such script`);
  }

  // Backticked repo paths: lib/x.ts, docs/y.md, scripts/z.mjs, public/w.json.
  // A path named while describing something RETIRED is history, not a claim
  // that the file exists. README:418 names cloudflare/worker.ts precisely to
  // say it was deleted, which is true and must stay sayable.
  const retired = /retired|deleted|removed|used to ship|no longer/i;
  const paths = [...readme.matchAll(/`((?:lib|docs|scripts|public|app|cloudflare|research)\/[A-Za-z0-9._/-]+)`/g)]
    .filter((m) => {
      const around = readme.slice(Math.max(0, m.index! - 260), m.index! + 260);
      return !retired.test(around);
    })
    .map((m) => m[1]);
  const missing = [...new Set(paths)].filter((relative) => !existsSync(path.join(root, relative)));
  assert.deepEqual(missing, [], `the README names paths that do not exist: ${missing.join(", ")}`);
});

/**
 * Mutation coverage: the guards above must fail on the sentences that actually
 * shipped, not merely pass on the corrected ones.
 */
test("the README guards reject the sentences that were wrong", () => {
  const shipped = "These point-in-time receipts close the WAF and historical log-query follow-ups for this release.";
  assert.match(shipped, /close the WAF and historical log-query follow-ups/);

  const overstated =
    "blind spots are published on the\n[catalog page](https://sitebehavior.org/catalog/) with the test that keeps each\nclaim honest.";
  assert.match(
    overstated,
    /blind spots are published on the\s*\[catalog page\]\([^)]*\) with the test that keeps each\s*claim honest/
  );

  assert.doesNotMatch("npm run calibration:archive", /`npm run ([a-z0-9:_-]+)`/, "unbackticked text is not a claim");
});
