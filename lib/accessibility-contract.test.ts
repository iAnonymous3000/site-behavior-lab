import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

/**
 * Every route component that renders the page shell itself, rather than being
 * composed into one by a parent. `/directory/` and `/directory/page/[page]/`
 * both delegate to `directory-index.tsx`, so that file stands for both.
 *
 * `app/reports/[id]/print/page.tsx` is deliberately absent: it is the
 * container-only printable rendering, has no navigation by design, and
 * `lib/print-route-contract.test.ts` owns its arrangement.
 */
const ROUTE_FILES_WITH_OWN_CHROME = [
  "app/site-behavior-app.tsx",
  "app/reports/[id]/saved-report-client.tsx",
  "app/about/page.tsx",
  "app/catalog/page.tsx",
  "app/categories/[category]/page.tsx",
  "app/corrections/page.tsx",
  "app/directory/directory-index.tsx",
  "app/glossary/page.tsx",
  "app/methodology/page.tsx",
  "app/privacy/page.tsx",
  "app/security/page.tsx",
  "app/sites/[domain]/page.tsx",
  "app/status/page.tsx"
];

test("interactive report transitions move focus to the replacement result region", () => {
  const home = source("app/site-behavior-app.tsx");
  const permalink = source("app/reports/[id]/saved-report-client.tsx");

  assert.match(home, /if \(loaded\) reportRegionRef\.current\?\.focus\(\)/);
  assert.match(home, /<section aria-label="Results" id="report" ref=\{reportRegionRef\} tabIndex=\{-1\}>/);
  assert.match(permalink, /if \(loaded\) evidenceExplorerRef\.current\?\.focus\(\)/);
  assert.match(permalink, /aria-label="Interactive evidence explorer"[\s\S]*ref=\{evidenceExplorerRef\}[\s\S]*tabIndex=\{-1\}/);
});

test("the one shell exposes banner, main, and contentinfo as sibling landmarks", () => {
  // One file, because there is one shell. This assertion used to run over the
  // homepage and the report permalink, which each hand-wrote this structure,
  // while the other thirteen routes rendered a bare <main> with no banner, no
  // contentinfo and no skip link at all -- a gap this shape of test could not
  // see, because it only looked at the two files that already passed.
  const chrome = source("app/_components/site-chrome.tsx");
  assert.doesNotMatch(chrome, /<main className="app-shell/);
  assert.match(
    chrome,
    /<div className=\{`app-shell[\s\S]*<header className="topbar">[\s\S]*<main[\s\S]*<footer className="app-footer">/
  );
  assert.match(chrome, /<a className="skip-link"/);
  assert.match(chrome, /<nav className="topbar-nav" aria-label="Primary">/);

  // And every route reaches it. A route that renders its own <main> is a route
  // that has silently opted out of the header, the footer and the skip link.
  for (const file of ROUTE_FILES_WITH_OWN_CHROME) {
    const contents = source(file);
    assert.match(contents, /<SiteChrome/, `${file} does not render the shared shell`);
    assert.doesNotMatch(contents, /<main[ >]/, `${file} renders its own <main>, bypassing the shell`);
  }

  const home = source("app/site-behavior-app.tsx");
  assert.doesNotMatch(home, /<aside className="method-card">/);
  assert.match(home, /<section className="method-card" aria-labelledby="method-card-title">/);
});

test("directory selections wait for an explicit submit action", () => {
  const controls = source("app/directory/directory-controls.tsx");
  assert.doesNotMatch(controls, /useRouter/);
  assert.match(controls, /<form className=\{`\$\{styles\.categoryControl\} \$\{styles\.searchForm\}`\} onSubmit=\{openSelectedCategory\}>/);
  assert.match(controls, /<button disabled=\{!selectedCategory\} type="submit">Browse category<\/button>/);
  assert.match(controls, /id="directory-search-status" role="status"/);
});

test("essential explanations and errors do not depend on pointer-only title tooltips", () => {
  for (const file of [
    "app/_components/report-header.tsx",
    "app/_components/scan-controls.tsx",
    "app/directory/directory-controls.tsx",
    "app/site-behavior-app.tsx",
    "app/reports/[id]/saved-report-client.tsx"
  ]) {
    assert.doesNotMatch(source(file), /\btitle=/, `${file} reintroduced a title-only explanation`);
  }

  const reportHeader = source("app/_components/report-header.tsx");
  assert.match(reportHeader, /aria-describedby="request-evidence-explanation"/);
  assert.match(reportHeader, /className="request-evidence-explanation" id="request-evidence-explanation"/);
  assert.match(reportHeader, /aria-describedby="csv-export-description"/);

  const scanControls = source("app/_components/scan-controls.tsx");
  assert.match(scanControls, /id="url-error" role="alert"/);
  assert.match(scanControls, /id="gpc-signal-description"/);
  for (const mode of ["single", "gpc", "shields", "consent"]) {
    assert.match(scanControls, new RegExp(`aria-describedby="run-mode-${mode}-description"`));
  }
});

test("links that retarget the tab say so in their accessible name", () => {
  // A new tab kills the Back button, so the change of context has to be announced
  // rather than left to the decorative icon that only some of these links carry.
  const files = [
    "app/site-behavior-app.tsx",
    "app/_components/report-header.tsx",
    "app/_components/report-overview.tsx",
    "app/_components/report-page-context.tsx",
    "app/_components/scheduled-rescans.tsx"
  ];

  let announced = 0;
  let retargeted = 0;
  for (const file of files) {
    const contents = source(file);
    retargeted += (contents.match(/target="_blank"/g) ?? []).length;
    announced += (contents.match(/className="visually-hidden">[^<]*opens in a new tab/g) ?? []).length;
  }

  // 9 since the permalink PDF control joined the scan-result one. Both open a
  // new tab: the response is now Content-Disposition: inline, so the tab shows
  // the document in the browser's viewer, and a render that takes tens of
  // seconds or refuses outright never costs the reader the page they were on.
  assert.equal(retargeted, 9, "the set of tab-retargeting links changed; announce the new one too");
  assert.equal(announced, retargeted, "every target=\"_blank\" link needs a new-tab announcement");
});

test("the share-link copy button keeps its visible label inside its accessible name", () => {
  const header = source("app/_components/report-header.tsx");

  // A fixed aria-label used to override the subtree, so the name stayed put while
  // the button read "Copied". The name is now composed from the visible text plus a
  // hidden qualifier, which means it CHANGES with state: any locator (including the
  // Playwright smoke suites) must match the "share link" qualifier, never a whole
  // exact sentence.
  const copyButton = header.slice(header.indexOf("function CopyButton"));
  assert.doesNotMatch(copyButton, /aria-label=/, "a fixed aria-label would mask the copied state again");
  assert.match(copyButton, /aria-live="polite"/);
  assert.match(copyButton, /<span className="visually-hidden">\{` \(\$\{label\}\)`\}<\/span>/);
  assert.match(header, /<CopyButton value=\{shareUrl \?\? sharePath\} label="share link" \/>/);

  for (const script of ["scripts/smoke-test.mjs", "scripts/smoke-static-site.mjs"]) {
    assert.match(
      source(script),
      /getByRole\("button", \{ name: \/share link\/i \}\)/,
      `${script} must locate the copy control by its stable qualifier`
    );
    assert.doesNotMatch(source(script), /name: "Copy share link"/, `${script} pins a stale accessible name`);
  }
});

test("clipped disclosure cards draw keyboard focus inside their boundaries", () => {
  const css = source("app/globals.css");
  assert.match(css, /\.data-section > summary:focus-visible,[\s\S]*\.state-change-disclosure > summary:focus-visible[\s\S]*box-shadow: inset 0 0 0 3px var\(--accent\)/);
});

test("comparison evidence switchers keep 44px targets on wide touch-capable devices", () => {
  const css = source("app/globals.css");
  const staticSmoke = source("scripts/smoke-static-site.mjs");

  assert.match(
    css,
    /@media \(max-width: 720px\), \(any-pointer: coarse\) \{[\s\S]*?\.arm-option \{[\s\S]*?min-height: 44px;[\s\S]*?min-width: 44px;/
  );
  assert.doesNotMatch(css, /@media \(max-width: 720px\), \(pointer: coarse\)/);
  assert.match(staticSmoke, /primaryPointerType=4,availablePointerTypes=6/);
  assert.match(staticSmoke, /primaryFine: matchMedia\("\(pointer: fine\)"\)\.matches/);
  assert.match(staticSmoke, /primaryCoarse: matchMedia\("\(pointer: coarse\)"\)\.matches/);
  assert.match(staticSmoke, /matchMedia\("\(any-pointer: coarse\)"\)\.matches/);
  assert.match(staticSmoke, /!pointerMedia\.primaryFine[\s\S]*pointerMedia\.primaryCoarse[\s\S]*!pointerMedia\.anyCoarse/);
});

test("visual request timelines expose one text equivalent without duplicating SVG noise", () => {
  const overview = source("app/_components/report-overview.tsx");
  assert.match(overview, /<svg[\s\S]*aria-hidden="true"[\s\S]*focusable="false"/);
  assert.match(overview, /const timingSummary = requestTimingSummary\(requests\)/);
  assert.match(overview, /\{timingSummary\}[\s\S]*Open the request log for exact timing and request details/);
});

test("saved-report comparison failures are announced", () => {
  const gallery = source("app/_components/static-gallery.tsx");
  assert.match(gallery, /className="static-compare-error" role="alert"/);
});

test("dynamic archive, watch, and gallery replacements relocate keyboard focus", () => {
  const home = source("app/site-behavior-app.tsx");
  const gallery = source("app/_components/static-gallery.tsx");
  const watches = source("app/_components/scheduled-rescans.tsx");

  assert.match(home, /if \(archiveRequested\) archiveToolsRef\.current\?\.focus\(\)/);
  assert.match(home, /aria-label="Saved-report tools" ref=\{archiveToolsRef\} tabIndex=\{-1\}/);
  assert.match(gallery, /pendingFocusIndexRef\.current = visibleReports\.length/);
  assert.match(gallery, /newlyRevealedReportRef\.current\?\.focus\(\)/);
  assert.match(watches, /pendingFocusRef\.current = "management"/);
  assert.match(watches, /managementHeadingRef\.current\?\.focus\(\)/);
  assert.match(watches, /pendingFocusRef\.current = "create"/);
  assert.match(watches, /createButtonRef\.current\?\.focus\(\)/);
});

test("theme controls track OS preference changes only before an explicit override", () => {
  const hook = source("app/_hooks/use-theme-preference.ts");
  const toggle = source("app/_components/theme-toggle.tsx");
  const chrome = source("app/_components/site-chrome.tsx");

  assert.match(hook, /readExplicitTheme\(\)/);
  assert.match(hook, /media\.addEventListener\("change", syncSystemTheme\)/);
  assert.match(hook, /media\.removeEventListener\("change", syncSystemTheme\)/);
  assert.match(hook, /removeSystemListenerRef\.current\?\.\(\)/);

  // One control, in the one shell, so every route carries it. It used to live
  // in the home and report shells plus a separate trust row on secondary pages,
  // which is three places for one control.
  assert.match(toggle, /useThemePreference\(\)/);
  assert.match(chrome, /<ThemeToggle \/>/);
  for (const file of ROUTE_FILES_WITH_OWN_CHROME) {
    assert.doesNotMatch(
      source(file),
      /function ThemeToggle\(/,
      "the theme control was duplicated back into a route"
    );
  }

  // Until the effect resolves the OS preference the button must not claim a direction.
  assert.match(toggle, /: "Switch colour theme"/);
  assert.match(toggle, /<SunMoon size=\{18\} aria-hidden="true" \/>/);
});

test("category summaries keep valid definition-list semantics and usable touch targets", () => {
  const category = source("app/categories/[category]/page.tsx");
  const css = source("app/categories/[category]/category.module.css");

  assert.match(
    category,
    /<dt>Third-party cookies<\/dt>\s*<dd>\s*\{rollup\.medianCookies[\s\S]*<small>[\s\S]*complete cookie evidence<\/small>\s*<\/dd>/
  );
  assert.match(css, /\.siteActions a \{[\s\S]*display: inline-flex;[\s\S]*min-height: 44px;/);
});

test("the focus indicator survives forced-colors mode and clears 3:1 in both themes", () => {
  const css = source("app/globals.css");

  // A bare `outline: none` plus a box-shadow ring leaves Windows High Contrast users with
  // no focus indicator at all, because forced-colors drops box-shadow and there is then
  // nothing for the UA to repaint.
  assert.doesNotMatch(css, /:focus-visible \{\s*outline: none;/);
  assert.match(css, /:focus-visible \{\s*outline: 3px solid transparent;\s*outline-offset: 2px;\s*box-shadow: var\(--ring\);/);
  assert.match(css, /@media \(forced-colors: active\) \{[\s\S]*?outline: 3px solid Highlight;/);

  // Presence is not enough, and asserting only presence is what let the defect
  // through: four controls were named in the forced-colors block near the top
  // of the file and then re-declared with `outline: none` further down. A media
  // query adds no specificity, so those are specificity ties resolved by source
  // order and the later `outline: none` won even inside forced-colors mode.
  // Forced colors also discards box-shadow and overrides border-color, so those
  // controls had no focus indicator at all in Windows High Contrast while this
  // test stayed green.
  //
  // So check the cascade, not the text: every selector a forced-colors block
  // gives an outline must not be given `outline: none` by any LATER rule.
  for (const [selector, outlineIndex] of forcedColorsOutlineSelectors(css)) {
    const cancelled = outlineNoneDeclarationIndexes(css, selector).filter(
      (index) => index > outlineIndex
    );
    assert.deepEqual(
      cancelled,
      [],
      `${selector} gets a forced-colors outline at ${outlineIndex} but a later rule sets outline: none at ${cancelled.join(", ")}, which wins on source order`
    );
  }

  // The ring is two solid bands, not a translucent wash: the alpha version measured
  // 1.60:1 in light theme against every surface token, well under WCAG 1.4.11.
  const ringDeclarations = css.match(/--ring: [^;]+;/g) ?? [];
  assert.equal(ringDeclarations.length, 3, "expected one --ring per theme block");
  for (const declaration of ringDeclarations) {
    assert.match(declaration, /0 0 0 2px var\(--surface\), 0 0 0 4px var\(--accent\)/);
    assert.doesNotMatch(declaration, /rgba\(/, `translucent focus ring reintroduced: ${declaration}`);
  }

  // `.active` outranks the bare `:focus-visible` on box-shadow, so the selected segment
  // needs its own rule or it is the one control that shows no ring.
  assert.match(css, /\.segmented-control button:focus-visible \{\s*box-shadow: var\(--shadow-sm\), var\(--ring\);/);
});

/**
 * Every selector that a `@media (forced-colors: active)` block gives an
 * outline, with the offset of its block.
 *
 * Walks every rule inside every forced-colors block. The first version of
 * this parser matched only the FIRST rule per block and only the exact
 * `outline: 3px solid Highlight` spelling, so a second rule in the same
 * block, or a reformatted declaration, silently fell outside the guard while
 * the test stayed green -- a guard quieter than the contract it claims to
 * enforce is how the original defect survived.
 */
function forcedColorsOutlineSelectors(css: string): Array<[string, number]> {
  const found: Array<[string, number]> = [];
  const block = /@media \(forced-colors: active\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(css)) !== null) {
    // Balanced-brace scan for the block body: rules nest exactly one level.
    let depth = 1;
    let index = block.lastIndex;
    while (index < css.length && depth > 0) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") depth -= 1;
      index += 1;
    }
    const body = css.slice(block.lastIndex, index - 1);
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let ruleMatch: RegExpExecArray | null;
    while ((ruleMatch = rule.exec(body)) !== null) {
      // Any outline the block grants counts, not one exact spelling; `none`
      // and `transparent` grant nothing and are exactly what the cascade
      // check exists to catch elsewhere. Extract-then-test rather than a
      // lookahead after \s*, whose backtracking quietly re-admits `none`.
      const outlineValue = /outline:\s*([^;]+);/.exec(ruleMatch[2]);
      if (!outlineValue || /^(?:none|transparent)\b/.test(outlineValue[1].trim())) continue;
      for (const selector of ruleMatch[1].split(",")) {
        const trimmed = selector.trim();
        if (trimmed) found.push([trimmed, match.index]);
      }
    }
  }
  return found;
}

/** Offsets of rules whose selector list contains exactly `selector` and which declare `outline: none`. */
function outlineNoneDeclarationIndexes(css: string, selector: string): number[] {
  const indexes: number[] = [];
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|[,{}])\\s*${escaped}\\s*(?:,[^{}]*)?\\{([^{}]*)\\}`, "g");
  let match: RegExpExecArray | null;
  while ((match = rule.exec(css)) !== null) {
    if (/outline:\s*none/.test(match[1])) indexes.push(match.index);
  }
  return indexes;
}

test("the forced-colors cascade test can actually see a cancelling rule", () => {
  // Mutation check. The assertion above is a scan over parsed selectors, so a
  // parser that silently matches nothing would make it vacuously true forever.
  // Feed it the exact shape of the defect and require a catch.
  const broken = [
    "@media (forced-colors: active) {",
    "  .filter-input:focus {",
    "    outline: 3px solid Highlight;",
    "  }",
    "}",
    ".filter-input:focus {",
    "  border-color: var(--accent);",
    "  outline: none;",
    "}"
  ].join("\n");

  const selectors = forcedColorsOutlineSelectors(broken);
  assert.deepEqual(
    selectors.map(([selector]) => selector),
    [".filter-input:focus"],
    "the block parser must find the selector it is meant to protect"
  );
  assert.equal(
    outlineNoneDeclarationIndexes(broken, ".filter-input:focus").filter(
      (index) => index > selectors[0][1]
    ).length,
    1,
    "the cancelling-rule parser must find a later outline: none"
  );

  // And the inverse: the shipped ordering must not look like a cancellation.
  const fixed = [
    ".filter-input:focus {",
    "  border-color: var(--accent);",
    "  outline: none;",
    "}",
    "@media (forced-colors: active) {",
    "  .filter-input:focus {",
    "    outline: 3px solid Highlight;",
    "  }",
    "}"
  ].join("\n");
  const fixedSelectors = forcedColorsOutlineSelectors(fixed);
  assert.equal(fixedSelectors.length, 1);
  assert.equal(
    outlineNoneDeclarationIndexes(fixed, ".filter-input:focus").filter(
      (index) => index > fixedSelectors[0][1]
    ).length,
    0
  );

  // The first parser matched only the FIRST rule per block and one exact
  // outline spelling. Feed it both blind spots: a second rule in the same
  // block, and a reformatted outline declaration. Both must be seen.
  const multiRule = [
    "@media (forced-colors: active) {",
    "  .first-control:focus {",
    "    outline: 3px solid Highlight;",
    "  }",
    "  .second-control:focus {",
    "    outline: 2px dotted Highlight;",
    "  }",
    "}"
  ].join("\n");
  assert.deepEqual(
    forcedColorsOutlineSelectors(multiRule).map(([selector]) => selector),
    [".first-control:focus", ".second-control:focus"],
    "every rule in a forced-colors block must be protected, not just the first"
  );

  // And an outline that grants nothing must not count as protection.
  const noneRule = [
    "@media (forced-colors: active) {",
    "  .third-control:focus {",
    "    outline: none;",
    "  }",
    "}"
  ].join("\n");
  assert.deepEqual(forcedColorsOutlineSelectors(noneRule), []);
});

test("interactive controls draw their boundary with the 3:1 token, not the hairline one", () => {
  const css = source("app/globals.css");

  // --border stays the low-contrast token for decorative separators; --border-strong is
  // the one that has to clear 3:1 against every surface for control boundaries.
  assert.match(css, /--border-strong: #7c887e;/);
  assert.match(css, /--border-strong: #5f7d6f;/);
  assert.doesNotMatch(css, /--border-strong: #c6d0c7;/);
  assert.doesNotMatch(css, /--border-strong: #33483f;/);

  for (const selector of [
    "\\.icon-button",
    "\\.url-row",
    "\\.segmented-control",
    "\\.access-control"
  ]) {
    const block = new RegExp(`\\n${selector} \\{[^}]*border: 1px solid var\\(--border-strong\\);`);
    assert.match(css, block, `${selector} lost the 3:1 boundary token`);
  }
});

test("the scan field's hit area is the whole visible field", () => {
  const css = source("app/globals.css");

  // The Scan button sets this grid row's height. With `align-items: center` inherited the
  // input was a 19px band inside a 56px field, so clicks on the top and bottom thirds of
  // the product's primary control focused nothing.
  assert.match(css, /\.url-row input \{[\s\S]*?align-self: stretch;/);
  assert.match(css, /\.url-row input \{[\s\S]*?min-height: 44px;/);
  // Under 16px iOS Safari zooms the page on focus.
  assert.match(css, /\.url-row input \{[\s\S]*?font-size: 16px;/);
});

/**
 * Class names that are deliberately unstyled: JS/test mount points, and modifiers whose
 * appearance comes entirely from a base class. Anything NOT on this list must have a
 * rule, so a deleted rule with the JSX left behind fails here.
 */
const INTENTIONALLY_UNSTYLED_CLASS_NAMES = new Set([
  "access-group",
  "causal-graph-card",
  "causal-node-dest",
  "causal-node-source",
  "change-list-cap-note",
  "comparison-privacy-note",
  "domain-request-deltas",
  "provenance-change-list",
  "report-title-block",
  "visit-phase-evidence"
]);

test("every className token rendered by app code has a matching CSS rule", () => {
  // `.capped-chip` shipped with three call sites and no rule at all: the data-integrity
  // warning rendered as unstyled text and inherited `.eyebrow` in the report header.
  // Typecheck and the unit suite are both blind to a deleted rule, so sweep for it.
  const cssFiles = [
    "app/globals.css",
    "app/catalog/catalog.module.css",
    "app/directory/directory.module.css",
    "app/categories/[category]/category.module.css"
  ].map(source).join("\n");

  function collectTsxFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) collectTsxFiles(next, found);
      else if (entry.name.endsWith(".tsx")) found.push(next);
    }
    return found;
  }

  const tokens = new Set<string>();
  for (const file of collectTsxFiles("app")) {
    const contents = source(file);
    for (const match of contents.matchAll(/className="([^"]+)"/g)) {
      for (const token of match[1].split(/\s+/)) if (token) tokens.add(token);
    }
    // Template literals: drop the ${...} holes, keep the static tokens around them.
    for (const match of contents.matchAll(/className=\{`([^`]*)`\}/g)) {
      for (const token of match[1].replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) if (token) tokens.add(token);
    }
  }

  assert.ok(tokens.size > 200, `className sweep collected only ${tokens.size} tokens; the extraction broke`);

  const unstyled = [...tokens]
    // A trailing hyphen is the static half of an interpolated modifier (`tone-${x}`).
    .filter((token) => !token.endsWith("-"))
    .filter((token) => !INTENTIONALLY_UNSTYLED_CLASS_NAMES.has(token))
    .filter((token) => !new RegExp(`\\.${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s,{:.>~+)]`).test(cssFiles))
    .sort();

  assert.deepEqual(
    unstyled,
    [],
    `these class names are rendered but have no CSS rule (add the rule, or list it in ` +
      `INTENTIONALLY_UNSTYLED_CLASS_NAMES with a reason): ${unstyled.join(", ")}`
  );
});

test("no CSS file reads a custom property that is never declared", () => {
  // `color: var(--button-text, #fff)` failed silently to its fallback for both directory
  // submit buttons, giving 1.86:1 white-on-teal in dark theme.
  const files = [
    "app/globals.css",
    "app/catalog/catalog.module.css",
    "app/directory/directory.module.css",
    "app/categories/[category]/category.module.css"
  ];
  const all = files.map(source).join("\n");
  const declared = new Set(Array.from(all.matchAll(/(--[a-z0-9-]+)\s*:/g), (match) => match[1]));
  const referenced = new Set(Array.from(all.matchAll(/var\((--[a-z0-9-]+)/g), (match) => match[1]));

  const undeclared = [...referenced].filter((name) => !declared.has(name));
  assert.deepEqual(undeclared, [], `CSS reads custom properties that are never declared: ${undeclared.join(", ")}`);
});

test("the 404 page carries its own metadata instead of inheriting the home page's", () => {
  const notFound = source("app/not-found.tsx");
  assert.match(notFound, /export const metadata: Metadata = \{/);
  assert.match(notFound, /title: "Report or page not available"/);
  assert.match(notFound, /robots: \{ index: false/);
});

test("scan failures and evidence-load failures relocate keyboard focus", () => {
  const home = source("app/site-behavior-app.tsx");
  const permalink = source("app/reports/[id]/saved-report-client.tsx");
  const banner = source("app/_components/scan-recovery-banner.tsx");

  // Both paths disable the control that holds focus, which browsers resolve by blurring
  // to <body> at the top of the document.
  assert.match(home, /if \(scanFailure && !hadScanFailure\.current\) recoveryBannerRef\.current\?\.focus\(\)/);
  assert.match(home, /<ScanRecoveryBanner\s*\n\s*bannerRef=\{recoveryBannerRef\}/);
  assert.match(banner, /ref=\{bannerRef\}[\s\S]*tabIndex=\{-1\}/);
  assert.match(permalink, /window\.requestAnimationFrame\(\(\) => evidenceLoaderRef\.current\?\.focus\(\)\)/);
});

test("every route reaches the trust surfaces, the primary nav, and the theme control", () => {
  const chrome = source("app/_components/site-chrome.tsx");
  assert.match(chrome, /<ThemeToggle \/>/);
  // Renders the shared sets rather than its own literal hrefs; their contents
  // and the surface that must publish them are enforced in
  // site-navigation.test.ts.
  assert.match(chrome, /SITE_TRUST_LINKS/);
  assert.match(chrome, /SITE_PRIMARY_NAV/);

  // Every route gets all three by rendering the shell. Before it existed, the
  // theme toggle and the trust links reached secondary pages through a separate
  // component and the primary nav reached them not at all.
  for (const file of ROUTE_FILES_WITH_OWN_CHROME) {
    assert.match(source(file), /<SiteChrome/, `${file} renders no trust surface`);
  }
});

test("the homepage checklist describes the checks the report actually runs", () => {
  // SCAN_CHECKS used to restate the named-platform list by hand, and named four
  // platforms after Microsoft, LinkedIn, and Pinterest had joined the shared
  // constant: the homepage advertised less than the report checks, while the
  // report's own absence copy printed all seven. Derived now, and pinned here
  // so a future hand-written copy fails instead of drifting silently.
  const home = source("app/site-behavior-app.tsx");
  assert.doesNotMatch(
    home,
    /catalogued Google, Meta, TikTok, or X domains/,
    "the platform list must be derived from HEADLINE_PLATFORMS, not restated"
  );
  assert.match(home, /humanList\(\s*HEADLINE_PLATFORMS,\s*HEADLINE_PLATFORMS\.length\s*\)/);

  // And the constant it derives from is the one the report reads. It lives in
  // its own module so importing it does not pull the whole report-insights
  // graph into the homepage bundle; report-insights re-exports it, so every
  // other consumer is unchanged.
  const declaration = source("lib/headline-platforms.ts");
  const declared = declaration.match(/export const HEADLINE_PLATFORMS = \[([^\]]*)\]/);
  assert.ok(declared, "HEADLINE_PLATFORMS must stay a literal this test can read");
  assert.match(
    source("lib/report-insights.ts"),
    /export \{ HEADLINE_PLATFORMS \} from "\.\/headline-platforms";/,
    "report-insights must keep re-exporting it for its existing consumers"
  );
  const platforms = declared[1].split(",").map((name) => name.trim().replace(/^"|"$/g, "")).filter(Boolean);
  assert.ok(platforms.length >= 4, "expected the shared platform list to be non-trivial");
  const findings = source("lib/report-findings.ts");
  // Bind the absence copy's literal sentence to the constant, not each name to
  // a substring: `includes("X")` was satisfied by any capital X anywhere in
  // the file, so that platform's check was vacuously green. The exact serial
  // list is the one place the findings copy spells the platforms out, and
  // deriving it here means adding a platform fails until that sentence is
  // deliberately rewritten to include it.
  const serialList = `${platforms.slice(0, -1).join(", ")}, or ${platforms.at(-1)}`;
  assert.ok(
    findings.includes(`No requests to catalogued ${serialList} domains`),
    `the findings absence copy must name exactly the shared platform list (${serialList})`
  );
});
