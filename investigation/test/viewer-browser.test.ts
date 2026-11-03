import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { chromium, type Browser, type Locator, type Page, type Response as PageResponse } from "playwright";
import { ACCESS_TOKEN_HEADER } from "../core/access-token";
import { VIEWER_STYLE_HASH, BASE_POLICY } from "../core/workspace-response";
import { CANNOT_ANSWER } from "../core/viewer-pages";
import { dumpOfStores, VIEWER_HOSTNAME, VIEWER_ORIGIN } from "./memory-case-world";
import { generateSigningKey, signToken } from "./token-fixture";
import { ALPHA_RUN, BLANK_POINTS, claimsAt, CODE_RUN, HEBREW, OWNER_RTL, PRIVATE_POINTS, seededStores, SCRIPT_DIGEST, UNASSIGNED_POINTS, VIEWER_CASE, VIEWER_ENV } from "./viewer-fixture";
import { accessKeysOnly, bundleForWorkerd, COMPATIBILITY_DATE } from "./workerd-bundle";

/**
 * The owner's walk through a case in a real browser, with no terminal step: Chromium, driven by
 * Playwright, against the Worker on workerd in Miniflare on a local port over TLS, with the
 * workspace's hostname mapped to that port and every other name refused by Chromium's resolver.
 * The owner's Access assertion rides on every request, as Access would put it there. Every step on
 * the case is a click on a link or a button the Worker served, or text typed into one of its
 * forms. Besides the first address, the walk opens a second tab at the case's address, builds two
 * pages of no origin with setContent to act as another site, reloads the case once, and opens a
 * page of a second local origin, standing in for the Access team's domain, whose login link answers
 * 302 to a case page, as Access sends the owner back after a sign-in.
 *
 * Nothing here waits on a clock: each step waits for the navigation it caused.
 */

const CASE_PATH = `/cases/${VIEWER_CASE}`;
const TEAM_HOSTNAME = "team.example";
const TEAM_ORIGIN = `https://${TEAM_HOSTNAME}`;
const ACTION_WAIT_MS = 60_000;

type Seen = Readonly<{ url: string; method: string; status: number; headers: Record<string, string> }>;

/** The path and query the page shows. */
function landedOn(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
}

/**
 * Wait for the main frame to commit the document a click leads to, and load it. A wait on the
 * address alone would end at once when the click leads back to the page it was made on, as a
 * write that redirects to its case does, and the next read would see the old page.
 */
async function clickThrough(page: Page, target: Locator): Promise<void> {
  await Promise.all([page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: ACTION_WAIT_MS }), target.click()]);
  await page.waitForLoadState("load", { timeout: ACTION_WAIT_MS });
}

/** Submit a form by its button, wait for the page it leads to, and hold that it is the one expected. The answer to the post is returned. */
async function submit(page: Page, form: Locator, landing: string): Promise<PageResponse> {
  const action = await form.getAttribute("action");
  const answered = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === action, { timeout: ACTION_WAIT_MS });
  await clickThrough(page, form.locator("button[type=submit]"));
  const answer = await answered;
  assert.equal(landedOn(page), landing, `the post to ${action} answered ${answer.status()}`);
  return answer;
}

/** Follow a link and hold that it led where it says. */
async function follow(page: Page, link: Locator, landing: string): Promise<void> {
  await clickThrough(page, link);
  assert.equal(landedOn(page), landing);
}

/** A page's text as a reader sees it, with each run of white space read as one space. */
async function textOf(page: Page, selector = "body"): Promise<string> {
  return (await page.locator(selector).first().innerText()).replace(/\s+/g, " ").trim();
}

/** A run of spaces and tabs as a count, worked out here apart from the viewer. */
function blanksCounted(run: string): string {
  const spaces = [...run].filter((blank) => blank === " ").length;
  const tabs = run.length - spaces;
  return [spaces === 0 ? "" : `${spaces} ${spaces === 1 ? "space" : "spaces"}`, tabs === 0 ? "" : `${tabs} ${tabs === 1 ? "tab" : "tabs"}`].filter((part) => part !== "").join(" ");
}

/** Shown text holds no run of blanks but one inside a line and indentation of one kind up to 64, and no line ends in a blank. */
function holdsBlankRule(shown: string, where: string): void {
  for (const line of shown.split("\n")) {
    const rest = line.replace(/^(?: {1,64}|\t{1,64})(?=[^ \t])/, "");
    assert.ok(!/[ \t]{2}/.test(rest) && !/[ \t]$/.test(rest), `${where}: ${JSON.stringify(line.slice(0, 48))}`);
  }
}

/** Where an element's first text node lays its characters: whether all on one line, and their order from left to right. Run in the page. */
function layoutOf(element: Element): { oneLine: boolean; order: string } {
  const node = element.firstChild as Text;
  const placed: [number, string][] = [];
  const centers: number[] = [];
  let height = Infinity;
  for (let index = 0; index < node.data.length; index += 1) {
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    const rect = range.getBoundingClientRect();
    placed.push([rect.left, node.data[index]]);
    centers.push((rect.top + rect.bottom) / 2);
    height = Math.min(height, rect.height);
  }
  return { oneLine: Math.max(...centers) - Math.min(...centers) < height / 2, order: placed.sort((left, right) => left[0] - right[0]).map(([, character]) => character).join("") };
}

/** Whether the text from the first `from` to the next `to` in an element, tokens between included, lies on one line. Run in the page. */
function lineSpan(element: Element, [from, to]: readonly [string, string]): { oneLine: boolean } {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let started = false;
  for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
    if (!started) {
      const at = node.data.indexOf(from);
      if (at === -1) continue;
      range.setStart(node, at);
      started = true;
    }
    const end = node.data.indexOf(to);
    if (end === -1) continue;
    range.setEnd(node, end + to.length);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    const centers = rects.map((rect) => (rect.top + rect.bottom) / 2);
    return { oneLine: rects.length > 0 && Math.max(...centers) - Math.min(...centers) < Math.min(...rects.map((rect) => rect.height)) / 2 };
  }
  return { oneLine: false };
}

/** What every page must hold: the four cases it cannot answer, no script, nothing fetched from anywhere, and the one hashed style applied. */
async function holdsPageRules(page: Page, where: string): Promise<void> {
  const body = await textOf(page);
  for (const line of CANNOT_ANSWER) assert.ok(body.includes(line), `${where}: ${line}`);
  assert.ok(body.includes("The limitations REA states for each attempt's output the adapter batch (W4) reads are kept on an imported case, by identifier, on the instrument and on every row that output produced, and those of the control run's output on the case's control. No page shows an imported case yet."), where);
  const counts = await page.evaluate(() => ({
    scripts: document.querySelectorAll("script").length,
    loads: document.querySelectorAll("img, iframe, frame, object, embed, video, audio, source, link, base, meta[http-equiv]").length,
    styles: document.querySelectorAll("style").length,
    styleAttributes: document.querySelectorAll("[style]").length,
    handlers: [...document.querySelectorAll("*")].filter((element) => [...element.attributes].some((attribute) => attribute.name.startsWith("on"))).length,
    outsideLinks: [...document.querySelectorAll("a[href]")].map((anchor) => anchor.getAttribute("href") as string).filter((href) => !href.startsWith("/cases/")),
    outsideForms: [...document.querySelectorAll("form")].map((form) => form.getAttribute("action") as string).filter((action) => !action.startsWith("/cases/")),
    broke: document.querySelectorAll("#broke-pre, #broke-textarea, #broke-owner").length,
    ran: (window as unknown as Record<string, unknown>).canaryRan ?? (window as unknown as Record<string, unknown>).ownerRan ?? null,
    // The hashed stylesheet applied, which it would not under a policy that did not allow its hash.
    styled: getComputedStyle(document.body).maxWidth
  }));
  assert.deepEqual(counts, { scripts: 0, loads: 0, styles: 1, styleAttributes: 0, handlers: 0, outsideLinks: [], outsideForms: [], broke: 0, ran: null, styled: "1216px" }, where);
}

test("the owner walks case, fact, row and attempt, then reaffirms, through the page in a real browser", { timeout: 300_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sbl-viewer-browser-"));
  const signing = await generateSigningKey("key-1");
  // workerd's clock is the machine's, so the case and the token are made around it.
  const nowMs = Date.now();
  const dump = dumpOfStores(VIEWER_CASE, await seededStores(signing, nowMs));
  const ownerToken = await signToken(signing, claimsAt(nowMs));
  const outbound = accessKeysOnly(signing);
  let miniflare: Miniflare | undefined;
  let browser: Browser | undefined;
  let team: Miniflare | undefined;
  try {
    const scriptPath = bundleForWorkerd("investigation/test/workerd-viewer-entry.ts", directory, "workerd-viewer-entry.js");
    miniflare = new Miniflare({
      modules: true,
      scriptPath,
      modulesRoot: directory,
      compatibilityDate: COMPATIBILITY_DATE,
      host: "127.0.0.1",
      port: 0,
      https: true,
      log: new Log(LogLevel.ERROR),
      bindings: { ...(VIEWER_ENV as Record<string, string>), VIEWER_CASES: [dump] },
      outboundService: outbound.handler
    });
    const served = await miniflare.ready;
    // A second origin standing in for the Access team's domain: its page links to its login, which answers 302 to a case page.
    team = new Miniflare({
      modules: true,
      script: `export default { fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/login") return new Response(null, { status: 302, headers: { location: "${VIEWER_ORIGIN}${CASE_PATH}?from=access" } });
        return new Response('<a href="/login">Back to the workspace</a>', { headers: { "content-type": "text/html; charset=utf-8" } });
      } };`,
      compatibilityDate: COMPATIBILITY_DATE,
      host: "127.0.0.1",
      port: 0,
      https: true,
      log: new Log(LogLevel.ERROR)
    });
    const teamServed = await team.ready;
    assert.equal(served.hostname, "127.0.0.1");
    // Miniflare's own certificate names localhost, so the browser is told not to check it.
    browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${VIEWER_HOSTNAME}:443 127.0.0.1:${served.port}, MAP ${TEAM_HOSTNAME}:443 127.0.0.1:${teamServed.port}, MAP * ~NOTFOUND`, "--ignore-certificate-errors"] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { [ACCESS_TOKEN_HEADER]: ownerToken } });
    context.setDefaultTimeout(ACTION_WAIT_MS);

    const seen: Seen[] = [];
    const requested: string[] = [];
    const posted: Promise<string>[] = [];
    const problems: string[] = [];
    context.on("request", (request) => {
      requested.push(request.url());
      if (request.method() === "POST") posted.push(request.allHeaders().then((headers) => `${new URL(request.url()).pathname} ${headers.origin ?? "absent"}`));
    });
    context.on("response", (response) => {
      seen.push({ url: response.url(), method: response.request().method(), status: response.status(), headers: response.headers() });
    });
    context.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") problems.push(`console: ${message.text()}`);
    });
    context.on("weberror", (error) => problems.push(`error: ${error.error().message}`));
    const page = await context.newPage();
    page.on("dialog", (dialog) => {
      problems.push(`dialog: ${dialog.message()}`);
      void dialog.dismiss();
    });

    // The first address typed.
    const first = await page.goto(`${VIEWER_ORIGIN}${CASE_PATH}`, { waitUntil: "load", timeout: ACTION_WAIT_MS });
    assert.equal(first?.status(), 200);
    assert.equal(await page.locator("h1").innerText(), `Case ${VIEWER_CASE}`);
    await holdsPageRules(page, "case");
    // The owner's words lay out left to right in stored order, right-to-left letters among them, on one line, painted in their own box.
    const ownerRtl = page.locator("div.text", { hasText: "owner-rtl:" });
    assert.equal(await ownerRtl.count(), 1);
    assert.deepEqual(await ownerRtl.evaluate(layoutOf), { oneLine: true, order: OWNER_RTL });
    assert.deepEqual(await ownerRtl.evaluate((element) => [getComputedStyle(element).unicodeBidi, getComputedStyle(element).direction, getComputedStyle(element).contain, getComputedStyle(element).whiteSpace]), ["bidi-override", "ltr", "paint", "pre-wrap"]);
    for (const text of await page.locator("div.text").allInnerTexts()) holdsBlankRule(text, "the owner's words");

    // A fact, and each link to its evidence, with the snapshot of limits beside the reading now.
    await follow(page, page.getByRole("link", { name: "fact-early", exact: true }), `${CASE_PATH}/facts/fact-early`);
    await holdsPageRules(page, "fact");
    const linkRow = page.locator("main table").first().locator("tr").nth(1);
    assert.match(await linkRow.locator("td").nth(3).innerText(), /cleanup_unresolved/, "the snapshot taken while B1 still captured");
    assert.equal((await linkRow.locator("td").nth(4).innerText()).replace(/\s+/g, " ").trim(), "observed: 12 counted at block granularity, window ended window_closed, complete. Limits: no limits", "the row's reading now, after B1 ended clean");

    // The link opens the row inside its own attempt, with instrument, window, clock and limits.
    await follow(page, page.getByRole("link", { name: "B1 row-b1-coverage", exact: true }), `${CASE_PATH}/attempts/B1/rows/row-b1-coverage`);
    await holdsPageRules(page, "row");
    const rowText = await textOf(page);
    for (const expected of ["In attempt B1 of case", "Instrument coverage", "clock page, 1000 ms to 5000 ms", "main-frame-only", "Phase usable", "Cleanup confirmed"]) assert.ok(rowText.includes(expected), expected);

    // Its attempt, one execution's evidence and nothing else.
    await follow(page, page.locator("main > p").getByRole("link", { name: "B1", exact: true }), `${CASE_PATH}/attempts/B1`);
    await holdsPageRules(page, "attempt");
    const attemptText = await textOf(page);
    assert.ok(attemptText.includes("One attempt's evidence, from one execution."));
    for (const row of ["row-b1-coverage", "row-b1-network", "row-b1-script"]) assert.ok(attemptText.includes(row), row);
    assert.ok(!attemptText.includes("row-b2-coverage"), "another attempt's row");

    // The script row's bytes, as text by digest and offset, never run.
    await follow(page, page.getByRole("link", { name: "row-b1-script", exact: true }), `${CASE_PATH}/attempts/B1/rows/row-b1-script`);
    await follow(page, page.getByRole("link", { name: SCRIPT_DIGEST, exact: true }), `${CASE_PATH}/evidence/${SCRIPT_DIGEST}`);
    await holdsPageRules(page, "evidence");
    const shown = await page.locator("pre").innerText();
    for (const expected of ["U+FEFF// CANARY-SCRIPT-MARKUP", "<script>window.canaryRan = 1</script>", '"><img src=x onerror="window.canaryRan = 2">', '</pre><b id="broke-pre">', "</textarea>", "<style>body{display:none}</style>", "https://tracker.example/pixel?id=CANARY-URL-QUERY", "bidi U+202Edesrever", "nulU+0000byte", "escapeU+001B[31m", "separatorU+2028here"]) {
      assert.ok(shown.includes(expected), expected);
    }
    // Every blank that draws no ink is a token, and trailing spaces and tabs, or a line of nothing else, a count.
    assert.ok(shown.includes(`blanks: ${BLANK_POINTS.map((point) => `aU+${point.toString(16).toUpperCase().padStart(4, "0")}b`).join(" ")}`), "each blank as a token");
    assert.ok(shown.includes("trailing: code();3 spaces 3 tabs\n3 spaces 1 tab\n"), "trailing blanks as a count");
    for (const point of [...BLANK_POINTS, ...PRIVATE_POINTS, ...UNASSIGNED_POINTS]) assert.ok(!shown.includes(String.fromCodePoint(point)), `U+${point.toString(16)} shown raw`);
    const lines = shown.split("\n");
    assert.ok(lines.includes(`private use: ${PRIVATE_POINTS.map((point) => `aU+${point.toString(16).toUpperCase().padStart(4, "0")}b`).join(" ")}`), "each private-use character as a token");
    // Escaped by the Worker in workerd's engine, whose Unicode data says what is unassigned.
    assert.ok(lines.includes(`unassigned: ${UNASSIGNED_POINTS.map((point) => `aU+${point.toString(16).toUpperCase().padStart(4, "0")}b`).join(" ")}`), "each unassigned code point as a token");
    // The security review's payloads in blanks inside a line, each a count, the longer one on one line, and indentation of one kind up to the bound as itself.
    assert.ok(lines.includes(`alpha${blanksCounted(ALPHA_RUN)}omega`), "104 blanks between two words");
    assert.ok(lines.includes(`const ok = 1;${blanksCounted(CODE_RUN)}// end of line`), "328 blanks before a comment");
    assert.deepEqual(await page.locator("pre").evaluate(lineSpan, ["const ok = 1;", "// end of line"] as const), { oneLine: true });
    for (const line of ["function lantern() {", "  if (ready) {", "\t\treturn 1;", "  }", `${" ".repeat(64)}deep();`, "65 spacesdeeper();", `${"\t".repeat(64)}deepTab();`, "1 space 1 tabmixed();", "}"]) {
      assert.ok(lines.includes(line), JSON.stringify(line.slice(0, 24)));
    }
    holdsBlankRule(shown, "the script's bytes");
    // Right-to-left letters lay out in stored order, with the code around them where it was written.
    const laidOut = await page.locator("pre").evaluate((pre) => {
      const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const data = (node as Text).data;
        const start = data.indexOf("rtl: ");
        if (start === -1) continue;
        const end = data.indexOf("\n", start);
        const placed: [number, string][] = [];
        for (let index = start; index < end; index += 1) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          placed.push([range.getBoundingClientRect().left, data[index]]);
        }
        return placed.sort((left, right) => left[0] - right[0]).map(([, character]) => character).join("");
      }
      return null;
    });
    assert.equal(laidOut, `rtl: limit = "${HEBREW}" + 10 + 99;`);
    // Captured text is laid out left to right in stored order, and painted inside its own box.
    assert.deepEqual(await page.locator("pre").evaluate((element) => [getComputedStyle(element).unicodeBidi, getComputedStyle(element).direction, getComputedStyle(element).contain]), ["bidi-override", "ltr", "paint"]);
    assert.equal(await page.locator("pre").evaluate((element) => getComputedStyle(element).whiteSpace), "pre-wrap");
    assert.ok(!shown.includes("END-OF-LONG-LINE"), "the long line runs past the first page");
    await follow(page, page.getByRole("link", { name: "Next page" }).first(), `${CASE_PATH}/evidence/${SCRIPT_DIGEST}?offset=32768`);
    assert.ok((await page.locator("pre").innerText()).endsWith("END-OF-LONG-LINE"));

    // The owner's own words, as text.
    await follow(page, page.getByRole("link", { name: "Case", exact: true }), CASE_PATH);
    await follow(page, page.getByRole("link", { name: "fact-markup", exact: true }).first(), `${CASE_PATH}/facts/fact-markup`);
    await holdsPageRules(page, "the owner's words");
    assert.ok((await textOf(page, "main")).includes('CANARY-OWNER <script>window.ownerRan = 1</script></textarea>"\'><b id="broke-owner">bold</b> U+202EtxetU+2069 nulU+0000end'));

    // Counts across attempts say so, with every denominator: I1 observed, I2 failed with no record and I3 never started.
    await follow(page, page.getByRole("link", { name: "Counts across attempts" }), `${CASE_PATH}/aggregates`);
    await holdsPageRules(page, "aggregates");
    const instrumented = page.locator("tr", { has: page.locator("td code", { hasText: /^instrumented$/ }) });
    assert.equal(await instrumented.count(), 1);
    const counts = await instrumented.locator("td").allInnerTexts();
    assert.deepEqual(counts.slice(5, 11).map((cell) => cell.trim()), ["1", "0", "2", "3", "1", "1"]);
    assert.equal(counts[12].trim(), "aggregate across attempts, not one execution");

    // The reaffirm: the owner reads the flagged interpretation and binds it to the versions shown.
    await follow(page, page.getByRole("link", { name: "Case", exact: true }), CASE_PATH);
    const flagged = page.locator("section", { has: page.getByRole("heading", { name: "reading-host", exact: true }) });
    assert.match(await flagged.innerText(), /Needs review\./);
    assert.match(await flagged.innerText(), /fact-lantern-host: version 2 now, read against version 1/);
    const reaffirmed = await submit(page, flagged.locator("form"), CASE_PATH);
    assert.equal(reaffirmed.status(), 303);
    await holdsPageRules(page, "after the reaffirm");
    const afterReaffirm = await page.locator("section", { has: page.getByRole("heading", { name: "reading-host", exact: true }) }).innerText();
    assert.match(afterReaffirm, /Current\. Reaffirmed 1 times\./);
    assert.match(afterReaffirm, /fact-lantern-host at version 2 \(now version 2\)/);

    // A stale page cannot bind: a second tab still holds the old head, an unrelated write lands from
    // the first, and the second tab's reaffirm is refused with the case as it now stands.
    const stale = await context.newPage();
    await stale.goto(`${VIEWER_ORIGIN}${CASE_PATH}`, { waitUntil: "load", timeout: ACTION_WAIT_MS });
    const assertionForm = page.locator(`form[action="${CASE_PATH}/assertions"]`);
    await assertionForm.locator('input[name="id"]').fill("said-in-between");
    // Typed on two lines: the browser sends the break as CR LF, and the page shows the line feed the owner typed.
    await assertionForm.locator('textarea[name="statement"]').fill("A note written\nin the first tab.");
    assert.equal((await submit(page, assertionForm, CASE_PATH)).status(), 303);
    const noted = await page.content();
    assert.ok(noted.includes("A note written\nin the first tab."), "the owner's line break is a line feed");
    assert.ok(!noted.includes("U+000D"), "no carriage return shows");
    const staleForm = stale.locator("section", { has: stale.getByRole("heading", { name: "reading-both", exact: true }) }).locator("form");
    const refused = await submit(stale, staleForm, `${CASE_PATH}/interpretations/reading-both/reaffirm`);
    assert.equal(refused.status(), 409);
    const staleText = await textOf(stale);
    assert.ok(staleText.includes("Nothing was written."));
    assert.ok(staleText.includes("said-in-between"), "the conflict shows the case as it now stands");
    assert.match(await stale.locator("section", { has: stale.getByRole("heading", { name: "reading-both", exact: true }) }).innerText(), /Needs review\./);
    await holdsPageRules(stale, "the conflict");

    // A later supersede flags the reaffirmed interpretation again.
    await follow(page, page.getByRole("link", { name: "fact-lantern-host", exact: true }).first(), `${CASE_PATH}/facts/fact-lantern-host`);
    const supersede = page.locator(`form[action="${CASE_PATH}/facts/fact-lantern-host/supersede"]`);
    await supersede.locator('textarea[name="statement"]').fill("The lantern script's URL names a host the first party controls.");
    await supersede.locator('textarea[name="reason"]').fill("A sharper wording.");
    assert.equal((await submit(page, supersede, `${CASE_PATH}/facts/fact-lantern-host`)).status(), 303);
    assert.match(await textOf(page, "main"), /Version 3, current\./);
    await follow(page, page.getByRole("link", { name: "Case", exact: true }), CASE_PATH);
    const reflagged = await page.locator("section", { has: page.getByRole("heading", { name: "reading-host", exact: true }) }).innerText();
    assert.match(reflagged, /Needs review\./);
    assert.match(reflagged, /fact-lantern-host was superseded from version 2/);

    // A form on a page of no origin, carrying the owner's assertion, writes nothing.
    const head = await page.locator('input[name="head"]').first().getAttribute("value");
    const elsewhere = await context.newPage();
    await elsewhere.setContent(`<form method="post" action="${VIEWER_ORIGIN}${CASE_PATH}/assertions"><input name="head" value="${head}"><input name="id" value="said-from-elsewhere"><input name="statement" value="Planted."><button type="submit">go</button></form>`);
    const [crossSite] = await Promise.all([
      elsewhere.waitForResponse((response) => response.request().method() === "POST", { timeout: ACTION_WAIT_MS }),
      elsewhere.locator("button").click()
    ]);
    assert.equal(crossSite.status(), 403);
    await page.reload({ waitUntil: "load", timeout: ACTION_WAIT_MS });
    assert.ok(!(await textOf(page)).includes("said-from-elsewhere"));

    // Another site's page: an image of a case page gets nothing, and a link the owner follows to the case still opens it.
    const another = await context.newPage();
    // The gate answers such a load 403, and Cross-Origin-Resource-Policy has the browser block it before it is delivered, so it ends as a failed request.
    const marks = (headers: Record<string, string>) => [headers["sec-fetch-site"], headers["sec-fetch-mode"], headers["sec-fetch-dest"]].join(" ");
    // Playwright reports no fetch metadata for a request the browser blocked, so the gate's answer to
    // this exact shape, cross-site, no-cors, image, is held in viewer.test.ts.
    const imageEnded = new Promise<string>((resolve) => {
      another.on("requestfailed", (request) => {
        if (request.resourceType() === "image") resolve(`failed ${request.failure()?.errorText ?? ""}`);
      });
      another.on("response", (response) => {
        if (response.request().resourceType() === "image") resolve(`answered ${response.status()}`);
      });
    });
    await another.setContent(`<img src="${VIEWER_ORIGIN}${CASE_PATH}/aggregates" alt=""><a href="${VIEWER_ORIGIN}${CASE_PATH}">the case</a>`);
    const image = await imageEnded;
    assert.match(image, /^(?:answered 403|failed net::ERR_BLOCKED_BY_RESPONSE)/, image);
    assert.equal(await another.locator("img").evaluate((element) => (element as HTMLImageElement).naturalWidth), 0);
    const followed = await Promise.all([another.waitForResponse((response) => response.request().isNavigationRequest(), { timeout: ACTION_WAIT_MS }), clickThrough(another, another.locator("a"))]);
    assert.equal(followed[0].status(), 200);
    // The shape of Access sending the owner back after a login: a top-level navigation from another site.
    assert.equal(marks(await followed[0].request().allHeaders()), "cross-site navigate document");
    assert.equal(landedOn(another), CASE_PATH);
    await holdsPageRules(another, "a link followed from another site");

    // Access's return after a sign-in: a link on the team's page, answered 302 to a case page, arrives as a top-level navigation from another site and opens the case.
    const access = await context.newPage();
    await access.goto(`${TEAM_ORIGIN}/`, { waitUntil: "load", timeout: ACTION_WAIT_MS });
    const returned = await Promise.all([access.waitForResponse((response) => response.request().isNavigationRequest() && response.url().startsWith(VIEWER_ORIGIN), { timeout: ACTION_WAIT_MS }), clickThrough(access, access.locator("a"))]);
    assert.equal(returned[0].status(), 200);
    assert.equal(returned[0].request().redirectedFrom()?.url(), `${TEAM_ORIGIN}/login`);
    assert.equal(marks(await returned[0].request().allHeaders()), "cross-site navigate document");
    assert.equal(landedOn(access), `${CASE_PATH}?from=access`);
    await holdsPageRules(access, "Access's return");

    // The owner's own posts carried this origin, exactly, and the planted one carried none.
    assert.deepEqual(
      await Promise.all(posted),
      [
        `${CASE_PATH}/interpretations/reading-host/reaffirm ${VIEWER_ORIGIN}`,
        `${CASE_PATH}/assertions ${VIEWER_ORIGIN}`,
        `${CASE_PATH}/interpretations/reading-both/reaffirm ${VIEWER_ORIGIN}`,
        `${CASE_PATH}/facts/fact-lantern-host/supersede ${VIEWER_ORIGIN}`,
        `${CASE_PATH}/assertions null`
      ]
    );
    // Every response carried the stated headers, refusals and redirects included.
    const ours = seen.filter(({ url }) => url.startsWith(`${VIEWER_ORIGIN}/`));
    assert.ok(ours.length >= 20, `only ${ours.length} responses were seen`);
    for (const response of ours) {
      const html = response.headers["content-type"] === "text/html; charset=utf-8";
      assert.equal(response.headers["content-security-policy"], html ? `${BASE_POLICY}; style-src '${VIEWER_STYLE_HASH}'` : BASE_POLICY, response.url);
      assert.equal(response.headers["x-content-type-options"], "nosniff", response.url);
      assert.equal(response.headers["cache-control"], "no-store", response.url);
      assert.equal(response.headers["referrer-policy"], "same-origin", response.url);
      assert.equal(response.headers["cross-origin-opener-policy"], "same-origin", response.url);
      assert.equal(response.headers["cross-origin-resource-policy"], "same-origin", response.url);
    }
    assert.deepEqual([...new Set(ours.map(({ status }) => status))].sort(), [200, 303, 403, 409]);
    // Nothing was asked of any other host, by the browser or by the Worker but for the team's keys.
    assert.deepEqual(requested.filter((url) => !url.startsWith(`${VIEWER_ORIGIN}/`) && url !== "about:blank"), [`${TEAM_ORIGIN}/`, `${TEAM_ORIGIN}/login`]);
    assert.deepEqual(outbound.refused, []);
    assert.ok(outbound.keyFetches() >= 1);
    // The three refusals above, as the browser reports a load that did not succeed, and nothing else: no policy violation, no error, no dialog.
    assert.deepEqual(problems, [
      "console: Failed to load resource: the server responded with a status of 409 (Conflict)",
      "console: Failed to load resource: the server responded with a status of 403 (Forbidden)",
      "console: Failed to load resource: net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin"
    ]);
  } finally {
    await browser?.close();
    await miniflare?.dispose();
    await team?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
