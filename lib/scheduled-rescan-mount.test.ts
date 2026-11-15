import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { encryptedWatchManagementUrl, parseEncryptedWatchCredentialsFromUrl } from "./encrypted-watch-client";
import { WATCH_FRAGMENT_PREFIX } from "./scheduled-rescan-mount";

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, ...relative.split("/")), "utf8");

// Scheduled rescans are off by default, and the homepage's first load has
// almost no room left in its script budget. The panel and the watch client it
// imports are therefore loaded only when wanted. These tests hold the off path:
// nothing of the watch client is in the first load, the panel still loads for a
// held management link, and the link prefix has one source.

const WATCH_MODULES = [
  "app/_components/scheduled-rescans.tsx",
  "lib/encrypted-watch-client.ts",
  "lib/scheduled-rescan-ui.ts"
];

test("the prefix module holds the constant and nothing else", async () => {
  assert.equal(WATCH_FRAGMENT_PREFIX, "#watch=");
  const module = await import("./scheduled-rescan-mount");
  assert.deepEqual(Object.keys(module).filter((key) => key !== "__esModule"), ["WATCH_FRAGMENT_PREFIX"]);
  const code = read("lib/scheduled-rescan-mount.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .trim();
  assert.equal(code, 'export const WATCH_FRAGMENT_PREFIX = "#watch=";');
});

test("every management link the client writes starts with the shared prefix", () => {
  // The same fixture credentials as lib/encrypted-watch-client.test.ts.
  const credentials = Object.freeze({
    watchId: "103d0ebdaea7dce9e2910bd227af5c2c",
    capabilityToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
  });
  const href = encryptedWatchManagementUrl("https://example.test/#scan", credentials);
  assert.deepEqual(parseEncryptedWatchCredentialsFromUrl(href), credentials, "the fixture must be a link the client accepts");
  const hash = new URL(href).hash;
  assert.ok(hash.startsWith(WATCH_FRAGMENT_PREFIX), `the client wrote ${hash}`);
  // One source: the client parses with the same constant this module exports.
  const client = read("lib/encrypted-watch-client.ts");
  assert.match(client, /^import \{ WATCH_FRAGMENT_PREFIX \} from "\.\/scheduled-rescan-mount";$/m);
  assert.doesNotMatch(client, /WATCH_FRAGMENT_PREFIX\s*=/, "the client must not restate the prefix");
  assert.doesNotMatch(client, /["']#watch=/, "the client must not spell the prefix itself");
});

/** Static imports only: a lazy import() is a separate chunk, and a type import is erased. */
function staticImports(file: string, files: ReadonlySet<string>): string[] {
  const source = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found: string[] = [];
  for (const match of source.matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/gm)) {
    if (match[2]) continue;
    found.push(match[4]);
  }
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.push(match[1]);
  return found.flatMap((specifier) => {
    const base = specifier.startsWith("@/")
      ? specifier.slice(2)
      : specifier.startsWith(".")
        ? path.posix.join(path.posix.dirname(file), specifier)
        : null;
    if (base === null) return [];
    const resolved = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) =>
      files.has(candidate)
    );
    return resolved ? [resolved] : [];
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

test("the homepage's first load has no static path to the watch client", () => {
  const files = new Set([...sourceFiles("app"), ...sourceFiles("lib")]);
  for (const module of WATCH_MODULES) assert.ok(files.has(module), `${module} is missing, so the walk would check nothing`);
  const start = "app/site-behavior-app.tsx";
  const seen = new Map<string, string>([[start, start]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const next of staticImports(file, files)) {
      if (seen.has(next)) continue;
      seen.set(next, `${seen.get(file)} -> ${next}`);
      queue.push(next);
    }
  }
  // The walk must reach the modules it is meant to see, or it proves nothing.
  assert.ok(seen.has("app/_hooks/use-scan-runtime.ts"), "the walk did not reach the scan runtime");
  assert.ok(seen.has("lib/scheduled-rescan-mount.ts"), "the walk did not reach the prefix module");
  for (const module of WATCH_MODULES) {
    assert.equal(seen.get(module), undefined, `the homepage statically imports ${module}: ${seen.get(module)}`);
  }
  // The prefix module is in the first load, so it must stay a leaf.
  assert.deepEqual(staticImports("lib/scheduled-rescan-mount.ts", files), []);
  assert.doesNotMatch(read("lib/scheduled-rescan-mount.ts"), /\bimport\b/);
});

test("the homepage mounts the lazy panel only when wanted, and keeps it mounted", () => {
  const app = read("app/site-behavior-app.tsx");
  assert.match(
    app,
    /const LazyScheduledRescans = lazy\(\(\) =>\n\s+import\("\.\/_components\/scheduled-rescans"\)\.then\(\(module\) => \(\{ default: module\.ScheduledRescans \}\)\)\n\);/
  );
  assert.doesNotMatch(app, /<ScheduledRescans\b/, "the panel must render only through the lazy component");
  assert.equal([...app.matchAll(/<LazyScheduledRescans\b/g)].length, 1);
  assert.match(
    app,
    /\{scheduledRescansMounted && \(\n\s+<Suspense fallback=\{null\}>\n\s+<LazyScheduledRescans\n\s+enabled=\{scheduledRescansEnabled\}/
  );
  // The latch: set only to true, when advertised or for a management link,
  // on mount and on every hashchange until it holds.
  assert.deepEqual(
    [...app.matchAll(/setScheduledRescansMounted\(([^)]*)\)/g)].map((match) => match[1]),
    ["true"],
    "the mount latch must never reset"
  );
  assert.match(
    app,
    /if \(scheduledRescansEnabled \|\| window\.location\.hash\.startsWith\(WATCH_FRAGMENT_PREFIX\)\) \{\n\s+setScheduledRescansMounted\(true\);\n\s+\}/
  );
  assert.match(app, /^import \{ WATCH_FRAGMENT_PREFIX \} from "@\/lib\/scheduled-rescan-mount";$/m);
  assert.doesNotMatch(app, /["']#watch=/, "the homepage must not spell the prefix itself");
  assert.match(app, /mountWhenWanted\(\);\n\s+window\.addEventListener\("hashchange", mountWhenWanted\);/);
  assert.match(app, /return \(\) => window\.removeEventListener\("hashchange", mountWhenWanted\);/);
  assert.match(app, /\}, \[scheduledRescansEnabled, scheduledRescansMounted\]\);/);
});
