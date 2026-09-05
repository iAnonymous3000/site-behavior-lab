import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { installBoundedPageCollector } from "./bounded-page-collector";
import { typeSentinelIntoFields } from "./scanner";

test("the real input probe blocks blur-triggered native submissions and leaves offscreen fields untouched", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await context.addInitScript(installBoundedPageCollector, "probe-test-collector");
    const page = await context.newPage();
    const submissions: string[] = [];
    await page.route("**/*", async route => {
      if (route.request().url().includes("submitted")) submissions.push(route.request().url());
      await route.fulfill({ contentType: "text/html", body: `
        <form action="/submitted"><input id="text"><input type="number"><input type="date"></form>
        <input id="redirected" onfocus="document.getElementById('text').focus()">
        <input id="below" style="position:absolute;top:2000px">
        <script>
          const submit = HTMLFormElement.prototype.submit;
          text.addEventListener('change', () => submit.call(document.forms[0]));
          text.addEventListener('blur', () => document.forms[0].requestSubmit());
        </script>` });
    });
    await page.goto("https://probe.test/");
    const result = await typeSentinelIntoFields(page, "synthetic-value", page.url(), "probe-test-collector", Date.now());
    assert.equal(result.count, 1);
    assert.equal(result.omittedCandidateCount, 4);
    assert.equal(result.preventedFieldCount, 0);
    assert.deepEqual(submissions, []);
    assert.equal(page.url(), "https://probe.test/");
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.equal(await page.locator("#below").inputValue(), "");
    assert.equal(await page.locator("#redirected").inputValue(), "");
    assert.equal(await page.locator("#text").inputValue(), "synthetic-value");
  } finally {
    await browser.close();
  }
});
