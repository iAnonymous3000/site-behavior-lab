// S5c image build step, run inside the offline build only (S5a's step, with more roots). Two things,
// each failing the build:
// 1. The commit's package-lock.json holds, for each of the six packages installed before this step,
//    the same entry as this folder's lockfile (version, resolved, integrity). So the image runs the
//    scanner on the packages that commit pins, or does not build.
// 2. Walks the static import graph from ROOTS and transpiles each module on its own
//    (ts.transpileModule: no type check and no resolution; the repository sets isolatedModules, so a
//    per-file transpile is what it allows) to CommonJS under dist/, as the repository's test build
//    emits. A relative import that resolves to no file fails the build, and so does a package other
//    than the three the scanner uses.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = process.argv[2];
const ts = require(path.join(root, "node_modules/typescript"));
const fail = (message) => { console.error(`check-and-transpile: ${message}`); process.exit(1); };

const own = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")).packages;
const commit = JSON.parse(fs.readFileSync(path.join(root, "commit-package-lock.json"), "utf8")).packages;
for (const name of ["playwright", "playwright-core", "tldts", "tldts-core", "undici", "typescript"]) {
  const key = `node_modules/${name}`;
  for (const field of ["version", "resolved", "integrity"]) {
    if (!commit[key] || commit[key][field] !== own[key][field]) fail(`${key} ${field}: the commit pins ${commit[key]?.[field]}, the image ${own[key][field]}`);
  }
}

// The scanner and its seam, the module the scanner computes first party with, the two core modules
// the runner and the stand-in read events with, and the 6.8.0 recorder shapes the runner reads the
// recorder's outputs with, and the runner's event list the stand-in holds calls to. Only what these
// reach of investigation/core is transpiled.
const ROOTS = ["lib/scanner.ts", "lib/investigation-seam.ts", "lib/domain-utils.ts", "investigation/core/case-events.ts", "investigation/core/canonical-json.ts", "investigation/core/recorder-shapes-6-8-0.ts", "investigation/core/case-runner.ts"];
const SPEC = /(?:^|[\s;])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/gm;
const seen = new Set();
const data = new Set();
const packages = new Set();
const todo = [...ROOTS];
while (todo.length > 0) {
  const file = todo.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(SPEC)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec.startsWith("node:")) continue;
    if (!spec.startsWith(".")) { packages.add(spec); continue; }
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    if (fs.existsSync(path.join(root, `${base}.ts`))) todo.push(`${base}.ts`);
    else if (base.endsWith(".json") && fs.existsSync(path.join(root, base))) data.add(base);
    else fail(`${file}: "${spec}" resolves to no file`);
  }
}
const expectedPackages = ["playwright", "tldts", "undici"];
if ([...packages].sort().join(",") !== expectedPackages.join(",")) fail(`packages imported: ${[...packages].sort().join(",")}`);
if (![...seen].some((file) => file.startsWith("investigation/core/"))) fail("no core module was reached");

const options = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017, esModuleInterop: true, isolatedModules: true };
for (const file of seen) {
  const out = path.join(root, "dist", file.replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const result = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), { compilerOptions: options, fileName: file, reportDiagnostics: true });
  if (result.diagnostics && result.diagnostics.length > 0) fail(`${file}: ${result.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ")}`);
  fs.writeFileSync(out, result.outputText);
}
for (const file of data) fs.copyFileSync(path.join(root, file), path.join(root, "dist", file));

const list = [...seen].sort().join("\n") + "\n";
console.log(`transpiled ${seen.size} modules (${[...seen].filter((f) => f.startsWith("investigation/")).length} of investigation/core), copied ${data.size} data files: ${[...data].sort().join(", ")}`);
console.log(`module list sha256 ${crypto.createHash("sha256").update(list).digest("hex")}`);
console.log(`packages imported: ${[...packages].sort().join(", ")}`);
fs.writeFileSync(path.join(root, "dist", "modules.txt"), list);
