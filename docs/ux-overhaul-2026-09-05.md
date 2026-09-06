# UI and UX overhaul, 2026-09-05: the design pass

Written before any component changed, against the routes as they rendered at
`main` 446589c. Every decision below is held to the reader model in section 1;
anything that does not serve one of those readers is not built.

## 1. Who reads this, and what would make them wrong

The product publishes evidence about what a real website did during one
controlled visit. Nobody comes here to browse. Each reader arrives with a
decision to make, and the interface exists to make that decision correctly.

| Reader | Arrives at | Needs to decide | What would make them wrong |
|---|---|---|---|
| A journalist checking a claim | A report permalink, usually shared | Whether this record supports the sentence they want to write, and how to cite it | Reading the headline as a verdict; missing that the visit failed, was capped, or that a detector did not complete; citing a number whose denominator they did not see; quoting a share report that will expire |
| A researcher building a dataset | The directory, a category page, the exports | Which rows are comparable, under which measurement identity, and what "complete" means per family | Pooling rows across cohorts; treating a lower bound as a total; missing that category medians use a stricter sample than the rows they see |
| A developer auditing their own site | The scan form, then the explorer, then the site history | What their page actually loaded, which script caused it, whether a change made a difference | Attribution read as causation; a comparison read as a difference the eligibility gate refused; a rescan compared against a visit measured under a different identity |
| A privacy officer asking "does site X do Y" | Search, a site profile, one finding card | Whether the evidence shows Y, whether absence of Y was measured or merely not seen | "No X observed" over a visit that could not have seen X; a percentile from a cohort that does not qualify; the claim boundary skipped |

The rule every surface follows: the finding first, its boundary beside it, the
evidence behind it one step away, the provenance one step after that. A caveat
that the reader can scroll past before the number is not a caveat.

## 2. What is wrong today, per reader

Observed from screenshots of every route at 1280 and 390 wide, light and dark.

- **The homepage argues with itself.** Three consecutive hero blocks (the
  thesis and scan form, a "transparency index" card, an "explore measured
  evidence" empty state with a radar icon) each claim the page. The featured
  library, the thing a first-time reader actually wants, sits inside the third,
  styled as an empty state. The right column beside the scan form is a filler
  card. The top bar repeats the thesis as a tagline under the wordmark on every
  route, competing with the `<h1>` that says the same thing.
- **The report page hides the finding board behind a click.** A permalink
  shows the identity block, the corrections notice, and the headline banner,
  then a card whose only content is a button. The plain-language findings, the
  part of the page written for the journalist and the privacy officer, arrive
  only after "Explore full evidence" loads an 8 MB wire. The reason (keeping
  the raw tables and charts out of the initial document) does not apply to the
  board, which is a pure function of the view the server already holds.
- **The explorer header breaks.** Inside the opened explorer, the report title
  wraps one character per line beside five action buttons; the comparison
  page renders "Brave-list blocking off/on comparison" as a 90 px column. The
  actions belong on their own row.
- **The directory makes the reader work twice.** A "Find a site" form with a
  disabled button, a "Browse a category" select with a disabled button, and
  below them a table that already has its own filter. Twelve thousand pixels.
- **The site history repeats itself.** Seven timeline cards on github.com
  carry the identical headline sentence seven times; the numbers that differ
  between visits are the small print.
- **Secondary pages have three header patterns.** Legal pages, the directory,
  the category page and the report page each style eyebrow, heading, lede and
  breadcrumb differently, at three different measures.
- **Small defects:** the status page renders "94distinct sites"; the scan
  form's example list stacks into a full screen of links on a phone; the
  mobile explorer runs to 15,000 px with the section nav as its only map.

What is right and stays: the single shell with one `<h1>` per route, the
severity ramp with its shape channel, the two-band focus ring, the two-weight
type system and the absence of a webfont, the print stylesheet, the section
nav, the identity-first report header, and every sentence of boundary copy.

## 3. Information architecture

Primary navigation: **Scan · Sites · Catalog · Methodology · Glossary.**
"Directory" becomes "Sites": it is a list of sites, and the word a reader
searches for. Categories live under Sites. The footer keeps the trust links
(About, Status, Privacy, Security, Corrections, Source).

Every route follows one page pattern, in this order: breadcrumb (when the page
has a parent), eyebrow, `<h1>`, lede, actions. Data pages use the content
measure; prose pages use the prose measure. No page introduces a third.

- **Home**: thesis and scan form; beside it, what one visit records, as a
  list rather than a card; then the library (coverage numbers and the featured
  cards under one heading); then the tools disclosure. One hero, not three.
- **Report permalink**: identity, corrections, evidence-quality notice,
  headline, the findings board rendered by the server, then a single gate for
  the raw evidence (tables, charts, phases, screenshot), then the receipt.
- **Explorer**: the header's actions move under the title; the comparison
  panel, attribution map, numbers, traffic, phases, tables and rail keep their
  order and their anchors.
- **Sites**: one search that filters the table in place and offers "open
  profile" on an exact match; category cards; the table.
- **Site history**: identity, latest visit, comparable-visit deltas, then a
  compact timeline table (date, kind, device, requests, trackers, cookies,
  schema) with the headline stated once for the latest visit.
- **Category, methodology, catalog, glossary, about, status, corrections,
  privacy, security**: the shared header pattern and measure; no structural
  change beyond that.

## 4. Tokens

The palette, ramp, radii, shadows, weights, focus ring and the two measures
are kept. Added: a spacing scale (`--space-1` 4 px through `--space-8` 48 px)
and a type scale (`--text-xs` 12 px through `--text-3xl` 40 px, with the
display size a clamp) so that pages stop choosing their own 12.5 px and 13.5 px
sizes. The top-bar tagline is removed on every route. Nothing new is added to
the client bundle: no icon components on the homepage's first load, no new
dependency, no webfont.

## 5. Component inventory

Kept as they are: `SiteChrome`, `ThemeToggle`, `ReportSectionNav`,
`ReportPageContext`, `ReportEvidenceReceipt`, `PrintEvidenceFooter`,
`SiteEvidenceTable`, `ComparisonPanel`, `CausalityGraph`,
`VisitPhasesAndStateChanges`, the report tables, `ScanControls`,
`ScheduledRescans`, `ScanRecoveryBanner`.

Changed: `SiteChrome` (tagline removed, nav label), the homepage sections
(one hero, the library section), `ReportHeader` (actions row),
`ReportPageSummary` (findings rendered by the server through the same
`buildFindings` the explorer uses, with the committed corpus statistics),
`DirectoryControls` (in-place filter), the site-history timeline, and the
shared page header styles.

## 6. What is deliberately not built

- No client-side router, framework, component library, webfont or build step.
- No change to any report wire, admitted string, catalog entry, producer
  tuple, methodology string or detector version.
- No reordering of the explorer's evidence sections: their anchors are shared
  as `#evidence=` links and their order is the reading order the section nav
  documents.
- No "dashboard" summaries, scores or trend claims beyond what the
  corpus-population rule already permits.
- No new copy that makes a claim the existing guard tests do not already pin;
  where copy moves, its guard moves with it in the same commit.

## 7. Sequence

One commit per route or component group; each leaves both builds green.

1. Tokens and the shared page header; top-bar tagline; nav label.
2. Home.
3. Report permalink: server-rendered findings, one evidence gate.
4. Explorer header.
5. Sites and category.
6. Site history timeline.
7. Remaining pages onto the shared header; the status-page defect.
8. Print pass, axe on every route in both themes, after-screenshots.

## 8. Record of what changed

Implemented on `ux-overhaul-2026-09-05`, one commit per step, each leaving
both builds green.

| Step | What changed | Measured |
|---|---|---|
| Tokens and shell | Spacing and type scales; a shared page header, breadcrumb and section heading; the top-bar tagline removed on every route; "Directory" renamed "Sites". | Homepage at 1280 wide: 2,760 px to 2,519 px. |
| Home | One hero (thesis, form, the seven checks beside it); the library as a section with its own heading, the coverage and category numbers as a strip, the featured cards, the actions; tools disclosure last; example chips in two columns on a phone. | The mobile arrival screen reaches the run controls without scrolling past six stacked example rows. |
| Report permalink | The findings board rendered by the server from the same `buildFindings` call the explorer uses, with the committed corpus statistics; the raw-evidence gate says what it gates. | github.com permalink: the board's nine cards visible with no click, 1,631 px to 3,541 px of content on arrival where a button used to be. Consistency rules over the committed corpus: 0 violations before, 0 after (the server path calls the same builder). |
| Explorer | The header's actions under its title. | The comparison title no longer wraps one character per line. |
| Sites | One search filtering the table in place with a status count and an exact-match profile link; categories as header links; the forms with disabled buttons removed. | Typing `github.com` leaves one row and one "Open github.com" link. |
| Site history | Timeline as a table with the headline stated once. | github.com: 2,099 px to 1,784 px, seven repeated sentences to one. |
| Remaining pages | Methodology, glossary, about, status, corrections, privacy, security, category and catalog on the shared header; the doubled rule under prose headers removed; the "94distinct sites" spacing defect on the status page fixed. | |
| Accessibility | axe (WCAG 2.0 and 2.1 A and AA) over fourteen routes, light and dark, 1280 and 390 wide, with the explorer opened on the report routes. | One finding across the whole set, the "Open latest evidence" link distinguishable only by colour inside the evidence table's sentence; underlined. Zero after. |

What was measured and held: every guard test that reads the app's source
(15 files, 46 pinned surfaces) passes; where a change moved pinned
structure (the homepage library gate, the directory controls, the summary
slot, the shared table's owner) the guard moved with it and pins the new
contract rather than the old shape.

## 9. Left for a later pass

- The explorer's evidence sections keep their order and their anchors; the
  mobile explorer still runs to about 15,000 px with the section nav as its
  map. Collapsing the rail cards into disclosures on narrow screens would
  shorten it, and would change the print output, which prints them open;
  not attempted here.
- The category page and the catalog page keep their module stylesheets and
  their own section headings; they adopt the header only.
- The homepage's status pill ("Live", "Limited", "Checking") is the
  scanner-health label the runtime tests pin; its copy was not redesigned.
- The corrections notice and the headline banner both carry the correction
  sentence on corrected reports (the banner's subhead is the correction's
  own text by design); one of the two could yield, which is a copy decision
  for the corrections ledger's owner rather than a layout change.
