# Direction A, "document of record"

The design layer chosen on 2026-11-13. It is rebuilt page by page; a page opts
in by rendering the `da` class on its shell and importing the four stylesheets.
Pages that have not been rebuilt still use `app/globals.css` and see none of
this.

## Files

| File | Holds |
| --- | --- |
| `tokens.css` | Colors for light, dark and paper, type scale, spacing, page measure. Every token is `--a-*`. |
| `base.css` | Body, links, focus ring, reduced motion, the shared masthead and footer. |
| `components.css` | Request figure, limit line, evidence table, and the three textures. |
| `report.css` | The report page: layout, and the dress of the blocks it shares with the evidence explorer. |
| `fonts.css` | The `@font-face` rules. A stylesheet, so they are stored once and not in each page. |
| `request-figure.tsx`, `limit-line.tsx`, `record-block.tsx` | Server components. None ships script. `record-block.tsx` is the report page's identity header. |
| `evidence-table.tsx` | The busiest-domains table with its time strips, after the findings on the report page. |

## The evidence table is on the report page

`evidence-table.tsx` renders the described visit's busiest recorded domains
after the findings, at most 30 rows, each with its time strip. It is the only
place on the page that names the contacted domains without a click and
without script, and it prints. It was taken off the page once for its weight
in the static export and put back when the per-page budget was measured to
hold: across the 1,029 committed reports it adds a median of about 17 KB to a
page's HTML and at most about 54 KB. Once the reader opens the evidence
explorer the summary it sits in is replaced, so the page never shows the
table and the explorer's full one together.

## What a report page may carry

A report page is one of about a thousand. `scripts/smoke-static-site.mjs`
holds a report page's HTML under a budget and the whole export under a ceiling.
So: nothing is rendered per request as elements (the figure's marks are one
run of text per row, and two blocks on paper), per-domain rows are bounded
(the table's 30), no text is rendered twice (a limit's paragraphs are in the
page once), a list key never holds the text it keys, nothing is rendered that
neither screen nor paper shows (the record's report id, digest and scanner
are paper's; on screen the receipt shows them), and constant rules (the font
faces) live in a stylesheet, not in the page.

## Rules that are the product

- A claim's limit is on the page beside it, without a click. `LimitLine` can
  hold more behind the limit sentence, but the sentence itself is always shown.
  The text behind it is in the element after the `details`, once; paper always
  shows it, by a rule of its own.
- No color means good or bad. Prussian marks what stayed on the site, Tracer
  marks contact with another site. Tracer is used for nothing else.
- Three textures, used the same way everywhere: a solid mark is a request row
  on record, an open-ended box is a lower bound, hatching is not measured.
- No request leaves this origin. The font files are in `public/fonts/`; the
  build copies the ones `fonts.css` names beside the stylesheet.

## Typefaces

Latin subsets, built by `node scripts/build-design-fonts.mjs <source-dir>` from
each project's own upstream TTF with HarfBuzz `hb-subset` 15.0.0. All three are
under the SIL Open Font License 1.1; each project's own license file sits beside
its family. STIX names "TM Math" as a Reserved Font Name; these files keep the
family name STIX Two Text.

| File under `public/fonts/` | WOFF2 bytes | Upstream file |
| --- | ---: | --- |
| `stix-two-text/STIXTwoText-wght.latin.woff2` | 26,532 | `STIXTwoText.ttf`, version 2.13 b171, variable 400 to 700 |
| `stix-two-text/STIXTwoText-Italic-wght.latin.woff2` | 28,860 | `STIXTwoText-Italic.ttf`, variable 400 to 700 |
| `atkinson-hyperlegible-next/AtkinsonHyperlegibleNext-wght.latin.woff2` | 33,792 | `AtkinsonHyperlegibleNext[wght].ttf`, version 2.001 |
| `atkinson-hyperlegible-next/AtkinsonHyperlegibleNext-Italic-wght.latin.woff2` | 37,280 | `AtkinsonHyperlegibleNext-Italic[wght].ttf` |
| `atkinson-hyperlegible-mono/AtkinsonHyperlegibleMono-wght.latin.woff2` | 18,152 | `AtkinsonHyperlegibleMono[wght].ttf`, version 2.001 |

The share card (`lib/og-report-card.tsx`) is drawn by next/og, which reads
TrueType and draws a variable font at its default instance only. The same run
of the same script writes, from the same sources and glyph set, one static
TrueType instance per weight the card sets, with `hb-subset --variations=wght=N`.
They sit in `lib/og-fonts/` with each family's license as committed under
`public/fonts/`, are read at build time and in the container (the Dockerfile
copies the folder), and are never served.

| File under `lib/og-fonts/` | TTF bytes | Upstream file | Weight | Upstream file's SHA-256 |
| --- | ---: | --- | ---: | --- |
| `STIXTwoText-500.latin.ttf` | 31,188 | `STIXTwoText.ttf`, version 2.13 b171 | 500 | `7962b8b7811e6a896c9a91a0bccbb5241047770eb24d4997c5cb5fe21d5c0df2` |
| `STIXTwoText-600.latin.ttf` | 31,196 | `STIXTwoText.ttf`, version 2.13 b171 | 600 | `7962b8b7811e6a896c9a91a0bccbb5241047770eb24d4997c5cb5fe21d5c0df2` |
| `AtkinsonHyperlegibleNext-400.latin.ttf` | 30,132 | `AtkinsonHyperlegibleNext[wght].ttf`, version 2.001 | 400 | `5a455d1cfa099b601ab70751bb9673e8fe1854dc4500c80e1a220d0d75e31745` |
| `AtkinsonHyperlegibleNext-600.latin.ttf` | 30,144 | `AtkinsonHyperlegibleNext[wght].ttf`, version 2.001 | 600 | `5a455d1cfa099b601ab70751bb9673e8fe1854dc4500c80e1a220d0d75e31745` |

Every file keeps its weight axis. The serif is set at 400 for reading text, 500
for the finding sentence and 600 for finding titles and the wordmark.

Total 144,616 bytes. A report page's first screen loads the STIX roman, the
Atkinson Next roman and the Atkinson Mono files, 78,476 bytes; the italics load
only where italic text is set.

Sources: STIX Two from `github.com/stipub/stixfonts`; Atkinson Hyperlegible Next
and Mono from `github.com/googlefonts/atkinson-hyperlegible-next` and
`github.com/googlefonts/atkinson-hyperlegible-next-mono`. Those two repositories
sit under the googlefonts GitHub organization; nothing is fetched from Google
Fonts or any Google-hosted service, at build time or in the browser.

Known limits of these files:

- The WOFF2 container is written without the glyf transform, so each file is
  somewhat larger than the reference encoder would make it.
