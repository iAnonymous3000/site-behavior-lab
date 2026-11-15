import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import { frozenReportView } from "./pinned-reports";
import { shieldsRunMeasurement } from "./report-insights";
import { buildReportHeadline, type ReportHeadline } from "./report-headline";
import { readStoredScanReport } from "./scan-report-reader";
import { toReportView } from "./scan-report-view";
import { makeShieldsInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { comparisonArmViews, type ReportView } from "./scan-report-views";

type OgReportCardModule = {
  OG_REPORT_SUBHEAD_MAX_CHARACTERS: number;
  buildReportCardSubhead: (view: ReportView, headline?: ReportHeadline) => string;
  buildReportCardAttribution: (view: ReportView, domain?: string) => string;
  buildReportCardStats: (headline: ReportHeadline) => ReportHeadline["stats"];
  buildReportCardLayout: (view: ReportView) => {
    attribution: string;
    correctionLabel: string | null;
    sentence: string;
    sentenceSize: { size: number; lineHeight: number };
    limit: string;
    subhead: string;
    stats: ReportHeadline["stats"];
  };
};

const reportsDir = path.join(process.cwd(), "public", "reports");
const reportFilePattern = /^[0-9]{8}-[0-9a-f]{32}\.json$/;

/**
 * The unit compiler intentionally excludes TSX. Compile this one renderer in
 * memory so the regression exercises its real semantic fitting function
 * without expanding the test build to every React component in lib/.
 */
function loadOgReportCardModule(): OgReportCardModule {
  const file = path.join(process.cwd(), "lib", "og-report-card.tsx");
  const source = readFileSync(file, "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017
    }
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const localRequire = (id: string): unknown => {
    if (id === "next/og") return { ImageResponse: class ImageResponse {} };
    if (id === "./report-insights") return require("./report-insights");
    if (id === "./report-headline") return require("./report-headline");
    if (id === "./scan-report-views") return require("./scan-report-views");
    return require(id);
  };
  const evaluate = new Script(`(function (require, module, exports) { ${compiled}\n})`, { filename: file }).runInThisContext() as (
    requireModule: (id: string) => unknown,
    targetModule: typeof module,
    exports: typeof module.exports
  ) => void;
  evaluate(localRequire, module, module.exports);
  return module.exports as OgReportCardModule;
}

function readReportView(name: string): ReportView {
  const raw: unknown = JSON.parse(readFileSync(path.join(reportsDir, name), "utf8"));
  const read = readStoredScanReport(raw);
  if (!read.ok) throw new Error(`reader rejected committed report ${name}: ${read.error}`);
  return toReportView(read.stored);
}

function stableOverLimitShieldsView(): ReportView {
  const report = makeShieldsInterventionReportV2R2();
  const view = toReportView({ schemaVersion: 2, schemaRevision: 2, report });
  const arms = comparisonArmViews(view);
  if (!arms) throw new Error("stable Shields fixture lost its comparison arms");
  arms.baseline.counts.totalRequests = 342;
  arms.baseline.counts.thirdPartyRequests = 298;
  arms.variant.counts.totalRequests = 142;
  arms.variant.counts.thirdPartyRequests = 98;
  arms.variant.counts.shieldsBlockedRequests = 30;
  const shields = arms.variant.verificationFacts?.shields;
  if (!shields) throw new Error("stable Shields fixture lost its verification facts");
  shields.requestsEvaluated = 142;
  shields.requestsMatched = 30;
  shields.requestsActuallyBlocked = 30;
  return view;
}

test("an over-limit Shields OG report keeps its complete qualification in bounded copy", () => {
  const og = loadOgReportCardModule();
  const view = stableOverLimitShieldsView();
  const headline = buildReportHeadline(view);
  const subhead = og.buildReportCardSubhead(view, headline);
  const arms = comparisonArmViews(view);

  assert.ok(headline.subhead.length > og.OG_REPORT_SUBHEAD_MAX_CHARACTERS, "fixture must exercise semantic fitting");
  assert.ok(arms, "fixture must remain a comparison");
  const removed = arms.baseline.counts.thirdPartyRequests - arms.variant.counts.thirdPartyRequests;
  const engineBlocks = shieldsRunMeasurement(arms.variant);
  assert.match(subhead, /not a live Brave-browser visit/);
  assert.match(subhead, new RegExp(`${arms.baseline.counts.totalRequests.toLocaleString("en-US")} requests? without blocking`));
  assert.match(subhead, new RegExp(`${removed.toLocaleString("en-US")} fewer third-party requests?`));
  if (engineBlocks?.kind === "engine-blocked") {
    assert.match(subhead, new RegExp(`directly stopped ${engineBlocks.count.toLocaleString("en-US")} requests?`));
    assert.match(subhead, /prevented follow-on requests/);
  }
  assert.match(subhead, /run-to-run variance/);
  assert.ok(subhead.length <= og.OG_REPORT_SUBHEAD_MAX_CHARACTERS);
  assert.doesNotMatch(subhead, /(?:\.\.\.|…)$/);
});

test("report social-card attribution names the observed site and UTC scan date", () => {
  const og = loadOgReportCardModule();
  const view = stableOverLimitShieldsView();
  const attribution = og.buildReportCardAttribution(view);
  assert.match(attribution, new RegExp(`^${view.domain.replace(".", "\\.")} · latest visit `));
  assert.doesNotMatch(attribution, /date not recorded/);

  const withoutDate = structuredClone(view);
  withoutDate.scannedAt = null;
  withoutDate.latestRunAt = null;
  assert.equal(
    og.buildReportCardAttribution(withoutDate, "example.com"),
    "example.com · latest visit date not recorded"
  );
});

test("an over-long subhead drops its secondary observation, never its qualification", () => {
  // The real case (homedepot.com, 2026-07-27 corpus refresh): a pixel
  // identifier finding whose subhead runs 415 characters. The compaction above
  // only knows how to restate a Shields comparison, so this fell straight
  // through to the withheld-claim fallback and the card published no finding
  // at all. Dropping the trailing "It also looks like ..." clause states
  // nothing false and keeps the lead claim AND its hedge.
  const og = loadOgReportCardModule();
  const view = stableOverLimitShieldsView();
  const primary =
    "An advertising pixel on shop.example attached populated personal-identifier fields (external ID) to the events it reported. " +
    "These fields exist to match a visit to a known person; the scanner records only that they were filled, never their values, so what they contained is not verified.";
  // The secondary clause comes from the real headline builder, never from a
  // hand-inlined copy of its compiled string: a view whose primary story
  // outranks listener coverage while an input-monitoring detection is present
  // makes the builder append the extras clause, and slicing off the builder's
  // own subheadPrimaryClaim recovers exactly what it appended. Inlining the
  // sentence here let the extras copy revert to the accusative form while
  // every test stayed green.
  // The unmutated fixture: the stable over-limit view's count overrides make
  // the comparison story win, and comparison branches deliberately never
  // append the extras clause, so the slice below would be empty there.
  const extrasView = toReportView({ schemaVersion: 2, schemaRevision: 2, report: makeShieldsInterventionReportV2R2() });
  for (const run of extrasView.runs) {
    run.evidence.fingerprintDetections.push({
      kind: "input-monitoring",
      heuristic: "input-listener-coverage-v1",
      count: 1,
      evidence: {
        eventTypes: ["input", "keydown"],
        listenerTargets: ["input"],
        thirdPartyOrigins: ["https://recorder.example.net"],
        totalListenerCalls: 4
      }
    });
    for (let index = 0; index < 6; index += 1) {
      const id = 9000 + run.evidence.requests.length;
      run.evidence.requests.push({
        id,
        url: `https://fixture.invalid/request-${id}`,
        domain: "google-analytics.com",
        method: "GET",
        resourceType: "script",
        status: 200,
        thirdParty: true,
        tracker: { domain: "google-analytics.com", entity: "Google", category: "analytics", confidence: "curated" },
        startedAtMs: id
      });
    }
  }
  const extrasHeadline = buildReportHeadline(extrasView);
  assert.notEqual(extrasHeadline.semantic.story, "listener-coverage");
  const secondary = extrasHeadline.subhead.slice(extrasHeadline.subheadPrimaryClaim.length);
  // The fixture is a two-visit report, so the clause names its lead visit.
  assert.match(secondary, /^ In the visit labeled No blocking, it also looks like /);
  assert.match(secondary, /call chain that included a cross-site script/);
  assert.doesNotMatch(secondary, /(cross-site|third-party) script registered/i);
  const headline = {
    ...buildReportHeadline(view),
    subhead: `${primary}${secondary}`,
    subheadPrimaryClaim: primary
  };
  assert.ok(headline.subhead.length > og.OG_REPORT_SUBHEAD_MAX_CHARACTERS);

  const subhead = og.buildReportCardSubhead(view, headline);
  assert.equal(subhead, primary);
  assert.doesNotMatch(subhead, /^Automated-visit headline only/);
  // The qualification is the whole point of keeping it.
  assert.match(subhead, /never their values/);
  assert.ok(subhead.length <= og.OG_REPORT_SUBHEAD_MAX_CHARACTERS);

  // When even the lead claim will not fit, withholding is still correct.
  const unfittable = {
    ...headline,
    subhead: `${"x".repeat(400)}${secondary}`,
    subheadPrimaryClaim: "x".repeat(400)
  };
  assert.match(og.buildReportCardSubhead(view, unfittable), /^Automated-visit headline only/);
});

test("every committed OG report has bounded, non-truncated subhead copy", () => {
  const og = loadOgReportCardModule();
  for (const name of readdirSync(reportsDir).filter((entry) => reportFilePattern.test(entry))) {
    const view = readReportView(name);
    const headline = buildReportHeadline(view);
    const subhead = og.buildReportCardSubhead(view, headline);
    assert.ok(subhead.length <= og.OG_REPORT_SUBHEAD_MAX_CHARACTERS, `${name} has ${subhead.length} characters`);
    assert.doesNotMatch(subhead, /(?:\.\.\.|…)$/, `${name} ends in visual truncation`);
    assert.doesNotMatch(subhead, /^Automated-visit headline only/, `${name} fell back instead of retaining its qualification`);
    if (headline.subhead.length <= og.OG_REPORT_SUBHEAD_MAX_CHARACTERS) assert.equal(subhead, headline.subhead, name);
  }
});

test("a quiet visit with an incomplete check keeps its scoped absences and hedge on the card", () => {
  // gutenberg.org, 2026-09-28: every completed family recorded nothing, and
  // the v1 input probe did not complete its test. The full subhead names the
  // incomplete check and runs past the card bound, which used to drop the
  // card to the generic fallback; the compact form keeps the claims and the
  // hedge the headline states.
  const og = loadOgReportCardModule();
  const view = frozenReportView("20260928-0ade50d01c4085ba146e27f8708a6f65");
  const headline = buildReportHeadline(view);
  assert.equal(headline.semantic.story, "incomplete-evidence");
  assert.match(headline.headline, /but another check is incomplete\.$/);
  assert.ok(headline.subhead.length > og.OG_REPORT_SUBHEAD_MAX_CHARACTERS);
  // One clause per "so": each note already ends in what it leaves incomplete.
  assert.doesNotMatch(headline.subhead, /, so [^.]*, so /);
  assert.match(headline.subhead, /is incomplete\. Whatever those checks look for is unproven here rather than shown to be absent\.$/);
  const subhead = og.buildReportCardSubhead(view, headline);
  assert.equal(subhead, headline.compactSubhead);
  assert.ok(subhead.length <= og.OG_REPORT_SUBHEAD_MAX_CHARACTERS, `${subhead.length} characters`);
  assert.doesNotMatch(subhead, /^Automated-visit headline only/);
  assert.match(subhead, /^The request log recorded no cross-site hosts/);
  assert.match(subhead, /Another check is incomplete, so what it looks for is unproven here, not shown absent\.$/);
});

test("committed pair-framed cards and share text carry no unlabeled one-arm chips", () => {
  // The Shields "fewer third-party requests in the visit configured for
  // Brave-list blocking" headline sits over the no-blocking arm's chips. On
  // the card and in the share text, with no visit label, those read as the
  // blocking visit's numbers (bumble.com: "38 cross-site requests" beside a
  // blocking visit that recorded none). Checked over every committed report,
  // so the pair-scoped set is asserted non-empty rather than passing on none.
  const og = loadOgReportCardModule();
  let pairScoped = 0;
  let chipped = 0;
  for (const name of readdirSync(reportsDir).filter((entry) => reportFilePattern.test(entry))) {
    const headline = buildReportHeadline(readReportView(name));
    const chips = og.buildReportCardStats(headline);
    if (headline.semantic.runScope !== "pair") {
      assert.deepEqual(chips, headline.stats.slice(0, 3), name);
      if (chips.length > 0) chipped += 1;
      continue;
    }
    pairScoped += 1;
    assert.ok(headline.stats.length > 0, `${name}: the page banner keeps its captioned chips`);
    assert.deepEqual(chips, [], `${name}: pair-framed card rendered one arm's chips`);
    for (const stat of headline.stats) {
      assert.equal(headline.shareText.includes(`${stat.value} ${stat.label}`), false, `${name}: ${headline.shareText}`);
    }
  }
  assert.ok(pairScoped > 0, "the committed corpus must exercise a pair-framed headline");
  assert.ok(chipped > 0, "the committed corpus must exercise a chipped card");
});

test("identifier-field social copy keeps its complete evidence boundary", () => {
  const og = loadOgReportCardModule();
  const view = toReportView({ schemaVersion: 2, schemaRevision: 2, report: makeShieldsInterventionReportV2R2() });
  for (const run of view.runs) {
    run.domain = "long-shop.example.invalid";
    run.evidence.pixelEvents = [{
      platform: "Meta", product: "Meta Pixel", events: ["PageView"],
      advancedMatching: ["email", "phone", "external_id"], requests: 1
    }];
  }
  const headline = buildReportHeadline(view);
  assert.ok(headline.subheadPrimaryClaim.length > og.OG_REPORT_SUBHEAD_MAX_CHARACTERS);
  const compact = og.buildReportCardSubhead(view, headline);
  assert.ok(compact.length <= og.OG_REPORT_SUBHEAD_MAX_CHARACTERS);
  assert.match(compact, /fields designated for personal identifiers/);
  assert.match(compact, /never their values/);
  assert.match(compact, /contents, hashing, successful delivery, and eventual use are unverified/);
});

test("every committed card states its limit whole and sets its sentence in at most three lines, never cut", async () => {
  const og = loadOgReportCardModule();
  const { lineCount, CARD_TEXT_WIDTH, SENTENCE_SIZES } = await import("./og-card-layout");
  const { publishedReportCorrections } = await import("./published-report-corrections");
  let cards = 0;
  let stepped = 0;
  for (const name of readdirSync(reportsDir).filter((entry) => reportFilePattern.test(entry))) {
    const view = readReportView(name);
    const headline = buildReportHeadline(view);
    const card = og.buildReportCardLayout(view);
    cards += 1;
    // The limit is the headline's caveat (or the correction sentence), in full.
    const expected = publishedReportCorrections(view.reportId).currentSubjectEvent
      ? "Read the report and public correction together before using these findings."
      : headline.caveat;
    assert.equal(card.limit, expected, name);
    assert.ok(lineCount(card.limit, "sans400", 24, CARD_TEXT_WIDTH - 22) <= 2, `${name}: the limit runs past two lines`);
    // The sentence is the headline itself, never cut, at one of the three sizes.
    assert.equal(card.sentence, headline.headline, name);
    assert.ok(SENTENCE_SIZES.some((step) => step.size === card.sentenceSize.size), name);
    if (card.sentenceSize.size !== SENTENCE_SIZES[0].size) stepped += 1;
    assert.ok(lineCount(card.sentence, "serif500", card.sentenceSize.size, CARD_TEXT_WIDTH) <= 3, `${name}: the sentence needs more than three lines`);
    // The three texts the owner dropped are not on the card.
    assert.ok(!JSON.stringify(card).includes("See what a site does"), name);
    assert.ok(!JSON.stringify(card).includes("open source"), name);
    assert.notEqual(card.correctionLabel, "What this actually means", name);
  }
  assert.ok(cards > 1000, `only ${cards} committed cards were read`);
  console.log(`cards ${cards}, sentence stepped down ${stepped}`);
});

/**
 * Which code points a static TrueType font draws: a cmap (format 4) entry
 * that maps to a glyph whose glyf record holds an outline (whitespace needs
 * only the entry). Read here on its
 * own, not through lib/og-card-layout.ts, so a fault in the card's measure
 * cannot hide one in this check.
 */
function drawnCodePoints(file: string): (codePoint: number) => boolean {
  const bytes = readFileSync(path.join(process.cwd(), "lib", "og-fonts", file));
  const tables = new Map<string, number>();
  for (let index = 0; index < bytes.readUInt16BE(4); index += 1) {
    const record = 12 + index * 16;
    tables.set(bytes.toString("latin1", record, record + 4), bytes.readUInt32BE(record + 8));
  }
  const at = (tag: string) => {
    const offset = tables.get(tag);
    assert.ok(offset !== undefined, `${file} has no ${tag} table`);
    return offset;
  };
  const longLoca = bytes.readInt16BE(at("head") + 50) === 1;
  const loca = at("loca");
  const glyphLength = (glyph: number) => longLoca
    ? bytes.readUInt32BE(loca + 4 * (glyph + 1)) - bytes.readUInt32BE(loca + 4 * glyph)
    : 2 * (bytes.readUInt16BE(loca + 2 * (glyph + 1)) - bytes.readUInt16BE(loca + 2 * glyph));
  const cmap = at("cmap");
  let table = -1;
  for (let index = 0; index < bytes.readUInt16BE(cmap + 2) && table < 0; index += 1) {
    const offset = cmap + bytes.readUInt32BE(cmap + 4 + index * 8 + 4);
    if (bytes.readUInt16BE(offset) === 4) table = offset;
  }
  assert.ok(table >= 0, `${file} has no format 4 cmap`);
  const segments = bytes.readUInt16BE(table + 6) / 2;
  const ends = table + 14;
  const starts = ends + 2 * segments + 2;
  const deltas = starts + 2 * segments;
  const ranges = deltas + 2 * segments;
  const glyphOf = (codePoint: number) => {
    for (let segment = 0; segment < segments; segment += 1) {
      if (codePoint > bytes.readUInt16BE(ends + 2 * segment)) continue;
      const start = bytes.readUInt16BE(starts + 2 * segment);
      if (codePoint < start) return 0;
      const delta = bytes.readUInt16BE(deltas + 2 * segment);
      const range = bytes.readUInt16BE(ranges + 2 * segment);
      if (range === 0) return (codePoint + delta) & 0xffff;
      const glyph = bytes.readUInt16BE(ranges + 2 * segment + range + 2 * (codePoint - start));
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
  // A space has an empty outline by design: mapped is drawn.
  return (codePoint) => {
    const glyph = glyphOf(codePoint);
    return glyph !== 0 && (glyphLength(glyph) > 0 || /\s/.test(String.fromCodePoint(codePoint)));
  };
}

test("every character of a card's numbers is drawn by the static font it is set in", () => {
  // The card sets a number's leading sign ("≥" on a lower bound) in Atkinson
  // 400 and the figure in STIX 500. A font with no glyph for a character
  // draws nothing or a box, and the fit test still passes, so each character
  // is checked against the font file the card hands next/og.
  const og = loadOgReportCardModule();
  const card = readFileSync(path.join(process.cwd(), "lib", "og-report-card.tsx"), "utf8");
  assert.match(card, /<span style=\{\{ fontFamily: "Atkinson Hyperlegible Next", fontWeight: 400 \}\}>\s*\{String\(stat\.value\)\.match\(\/\^\[\^0-9\]\+\/\)!\[0\]\}/);
  assert.match(card, /\{ name: "Atkinson Hyperlegible Next", data: cardFont\("sans400"\), weight: 400 as const/);
  assert.match(card, /<div style=\{\{ display: "flex", fontFamily: "STIX Two Text", fontWeight: 500, fontSize: 40/);
  const sign = drawnCodePoints("AtkinsonHyperlegibleNext-400.latin.ttf");
  const figure = drawnCodePoints("STIXTwoText-500.latin.ttf");
  const signs = new Set<string>();
  let numbers = 0;
  for (const name of readdirSync(reportsDir).filter((entry) => reportFilePattern.test(entry))) {
    for (const stat of og.buildReportCardLayout(readReportView(name)).stats) {
      const value = String(stat.value);
      const prefix = value.match(/^[^0-9]+/)?.[0] ?? "";
      for (const character of prefix) {
        assert.ok(sign(character.codePointAt(0)!), `${name}: Atkinson 400 draws no ${JSON.stringify(character)}`);
        signs.add(character);
      }
      for (const character of value.slice(prefix.length)) {
        assert.ok(figure(character.codePointAt(0)!), `${name}: STIX 500 draws no ${JSON.stringify(character)}`);
      }
      numbers += 1;
    }
  }
  // Lower bounds are on committed cards today, so the sign was checked, not skipped.
  assert.ok(signs.has("≥"), `no committed card carries a lower-bound sign (signs seen: ${[...signs].join(" ")})`);
  assert.ok(numbers > 500, `only ${numbers} card numbers were read`);
});
