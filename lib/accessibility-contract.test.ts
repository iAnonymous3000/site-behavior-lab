import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

test("interactive report transitions move focus to the replacement result region", () => {
  const home = source("app/site-behavior-app.tsx");
  const permalink = source("app/reports/[id]/saved-report-client.tsx");

  assert.match(home, /if \(loaded\) reportRegionRef\.current\?\.focus\(\)/);
  assert.match(home, /<section aria-label="Results" id="report" ref=\{reportRegionRef\} tabIndex=\{-1\}>/);
  assert.match(permalink, /if \(loaded\) evidenceExplorerRef\.current\?\.focus\(\)/);
  assert.match(permalink, /aria-label="Interactive evidence explorer"[\s\S]*ref=\{evidenceExplorerRef\}[\s\S]*tabIndex=\{-1\}/);
});

test("primary shells expose banner, main, and contentinfo as sibling landmarks", () => {
  for (const file of ["app/site-behavior-app.tsx", "app/reports/[id]/saved-report-client.tsx"]) {
    const contents = source(file);
    assert.doesNotMatch(contents, /<main className="app-shell/);
    assert.match(contents, /<div className="app-shell[^>]*">[\s\S]*<header className="topbar">[\s\S]*<main[\s\S]*<footer className="app-footer">/);
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

  assert.equal(retargeted, 7, "the set of tab-retargeting links changed; announce the new one too");
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
  const home = source("app/site-behavior-app.tsx");
  const permalink = source("app/reports/[id]/saved-report-client.tsx");

  assert.match(hook, /readExplicitTheme\(\)/);
  assert.match(hook, /media\.addEventListener\("change", syncSystemTheme\)/);
  assert.match(hook, /media\.removeEventListener\("change", syncSystemTheme\)/);
  assert.match(hook, /removeSystemListenerRef\.current\?\.\(\)/);

  // One control, shared, so the two shells cannot drift apart.
  assert.match(toggle, /useThemePreference\(\)/);
  assert.match(home, /<ThemeToggle \/>/);
  assert.match(permalink, /<ThemeToggle \/>/);
  for (const shell of [home, permalink]) {
    assert.doesNotMatch(shell, /function ThemeToggle\(/, "the theme control was duplicated back into a shell");
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
