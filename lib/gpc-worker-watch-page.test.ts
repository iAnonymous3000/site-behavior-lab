import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  GPC_WORKER_WATCH_PAGE_URL,
  GPC_WORKER_WATCH_PING_RECORDED_URL,
  GPC_WORKER_WATCH_PING_URL,
  GPC_WORKER_WATCH_WORKER_DELAY_MS
} from "./gpc-worker-watch-page";
import { redactUrlV2 } from "./redaction-v2";

const root = process.cwd();
const PAGE = path.join(root, "public", "monitor", "gpc-worker", "index.html");
const WORKER = path.join(root, "public", "monitor", "gpc-worker", "worker.js");
const PING = path.join(root, "public", "monitor", "gpc-worker", "ping", "ok.txt");

function pageScript(): string {
  const html = readFileSync(PAGE, "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1, "the watch page has exactly one inline script");
  return scripts[0];
}

test("the watch page is one fixed page on this site's own origin, served from public/monitor/gpc-worker/", () => {
  assert.equal(new URL(GPC_WORKER_WATCH_PAGE_URL).origin, "https://sitebehavior.org");
  assert.equal(new URL(GPC_WORKER_WATCH_PAGE_URL).pathname, "/monitor/gpc-worker/");
  assert.ok(statSync(PAGE).isFile());
  // The page URL is the module's one literal: the ping is derived from it.
  const source = readFileSync(path.join(root, "lib", "gpc-worker-watch-page.ts"), "utf8");
  assert.equal([...source.matchAll(/"https?:\/\/[^"]*"/g)].length, 1);
  assert.equal(new URL(GPC_WORKER_WATCH_PING_URL).origin, new URL(GPC_WORKER_WATCH_PAGE_URL).origin);
});

test("the watch ping's recorded form is the redactor's and is deeper than every other path the page loads", () => {
  assert.equal(redactUrlV2(GPC_WORKER_WATCH_PING_URL).value, GPC_WORKER_WATCH_PING_RECORDED_URL);
  const workerUrl = new URL("/monitor/gpc-worker/worker.js", GPC_WORKER_WATCH_PAGE_URL).href;
  for (const other of [GPC_WORKER_WATCH_PAGE_URL, workerUrl, new URL("/favicon.ico", GPC_WORKER_WATCH_PAGE_URL).href]) {
    assert.notEqual(redactUrlV2(other).value, GPC_WORKER_WATCH_PING_RECORDED_URL, other);
  }
  assert.equal(redactUrlV2(GPC_WORKER_WATCH_PAGE_URL).value, "https://sitebehavior.org/{seg}/{seg}");
});

test("the watch page starts one same-origin dedicated worker on the declared timer and says nothing else", () => {
  const html = readFileSync(PAGE, "utf8");
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<title>GPC worker monitor<\/title>/);
  // No prose: the body is empty and nothing but the title is text.
  assert.match(html, /<body><\/body>/);
  const script = pageScript();
  const workers = [...script.matchAll(/new Worker\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(workers, ["/monitor/gpc-worker/worker.js"]);
  assert.doesNotMatch(html, /blob:|data:|https?:\/\//, "no blob:, data: or absolute URL on the page");
  const delays = [...script.matchAll(/setTimeout\([\s\S]*?\},\s*(\d+)\)/g)].map((match) => Number(match[1]));
  assert.deepEqual(delays, [GPC_WORKER_WATCH_WORKER_DELAY_MS]);
  assert.match(script, /addEventListener\("load"/);
  // Inside the scanner's passive window: Playwright's network idle needs 500 ms
  // without network activity, so the worker starts before the page can idle.
  assert.ok(GPC_WORKER_WATCH_WORKER_DELAY_MS < 500);
});

test("the watch worker fetches the one fixed same-origin file once", () => {
  const worker = readFileSync(WORKER, "utf8");
  const fetches = [...worker.matchAll(/fetch\("([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(fetches, [new URL(GPC_WORKER_WATCH_PING_URL).pathname]);
  assert.doesNotMatch(worker, /https?:\/\/|importScripts|new Worker/);
  assert.ok(statSync(PING).isFile());
  assert.deepEqual(readdirSync(path.dirname(PAGE)).sort(), ["index.html", "ping", "worker.js"]);
});

test("nothing on the site links to the watch page", () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|mdx?|json)$/.test(entry.name) && readFileSync(full, "utf8").includes("/monitor/gpc-worker")) hits.push(path.relative(root, full));
    }
  };
  walk(path.join(root, "app"));
  assert.deepEqual(hits, []);
});
