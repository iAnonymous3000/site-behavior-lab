// S5c image build step: the reference set of the scanner's injected text (R-c, answer 6), built from
// the scanner's own transpiled modules in this image, never from a copy kept elsewhere. Written to
// argv[3] as JSON: each reference's name, text, length and sha256, and the set's own sha256 over its
// names and digests. The runner labels an empty-URL script with it; the texts never leave the image.
//
// Three kinds, each named in the reference's name:
// - init: the scanner's four init scripts, as the modules export them (the bounded page collector, the
//   consent capture, the fingerprint observer and the GPC install).
// - evaluate: every function or string the scanner hands to a page evaluation call
//   (evaluate, evaluateHandle, $eval, $$eval, waitForFunction, addInitScript), read from the
//   transpiled sources by parse. A function given by name is taken from the module that exports it,
//   or from its declaration in the same file.
// - Playwright's generated injected sources, as S5a looked for them. None existed in 1.65.0; the
//   count is recorded either way.
// Nothing is evaluated: function texts are read with Function.prototype.toString or by source slice.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = process.argv[2];
const outFile = process.argv[3];
const ts = require(path.join(root, "node_modules/typescript"));
const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const fail = (message) => { console.error(`reference-set: ${message}`); process.exit(1); };
// A reference shorter than this is too generic to identify anything by containment.
const MIN_CHARS = 40;

const refs = new Map();
const add = (name, text) => {
  if (typeof text !== "string" || text.length < MIN_CHARS) return;
  const digest = sha256(text);
  if ([...refs.values()].some((r) => r.sha256 === digest)) return;
  refs.set(name, { name, length: text.length, sha256: digest, text });
};

const INIT = [
  ["bounded-page-collector", "installBoundedPageCollector"],
  ["consent-interaction", "installConsentShadowRootCapture"],
  ["fingerprint-observer", "fingerprintObserverInitScript"],
  ["gpc-injection", "installGlobalPrivacyControlWithWorkerRegistration"]
];
for (const [mod, fn] of INIT) {
  const value = require(path.join(root, "dist/lib", `${mod}.js`))[fn];
  if (typeof value !== "function") fail(`${mod}.${fn} is not a function`);
  add(`init:${fn}`, Function.prototype.toString.call(value));
}
const initCount = refs.size;
if (initCount !== INIT.length) fail(`init references: ${initCount}`);

const CALLS = new Set(["evaluate", "evaluateHandle", "$eval", "$$eval", "waitForFunction", "addInitScript", "evaluateAll"]);
const modules = fs.readFileSync(path.join(root, "dist/modules.txt"), "utf8").split("\n").filter((f) => f.startsWith("lib/"));
const byName = new Map();
for (const file of modules) {
  let exported;
  try { exported = require(path.join(root, "dist", file.replace(/\.ts$/, ".js"))); } catch { continue; }
  for (const [key, value] of Object.entries(exported ?? {})) if (typeof value === "function") byName.set(key, [...(byName.get(key) ?? []), { file, value }]);
}
let calls = 0;
for (const file of modules) {
  const js = file.replace(/\.ts$/, ".js");
  const text = fs.readFileSync(path.join(root, "dist", js), "utf8");
  const source = ts.createSourceFile(js, text, ts.ScriptTarget.Latest, true);
  const local = new Map();
  for (const statement of source.statements) if (ts.isFunctionDeclaration(statement) && statement.name) local.set(statement.name.text, statement.getText(source));
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && CALLS.has(node.expression.name.text)) {
      const call = node.expression.name.text;
      const args = node.arguments;
      const first = call === "$eval" || call === "$$eval" ? args[1] : args[0];
      if (first) {
        calls += 1;
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const name = `evaluate:${file}:${line}:${call}`;
        if (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) add(name, first.getText(source));
        else if (ts.isStringLiteralLike(first)) add(name, first.text);
        else if (ts.isIdentifier(first) || ts.isPropertyAccessExpression(first)) {
          const id = ts.isIdentifier(first) ? first.text : first.name.text;
          if (local.has(id)) add(`${name}:${id}`, local.get(id));
          for (const found of byName.get(id) ?? []) add(`${name}:${found.file}:${id}`, Function.prototype.toString.call(found.value));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

let generated = 0;
const pwLib = path.join(root, "node_modules/playwright-core/lib");
const walk = (dir, depth) => {
  if (depth > 4) return;
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (!fs.statSync(p).isDirectory()) continue;
    if (n !== "generated") { walk(p, depth + 1); continue; }
    for (const f of fs.readdirSync(p).filter((x) => /Source\.js$/.test(x)).sort()) {
      for (const [k, v] of Object.entries(require(path.join(p, f)) ?? {})) if (typeof v === "string") { generated += 1; add(`playwright:${path.relative(pwLib, p)}/${f}:${k}`, v); }
    }
  }
};
walk(pwLib, 0);

const list = [...refs.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
if (list.length <= initCount) fail("no evaluate reference was found");
const setDigest = sha256(list.map((r) => `${r.name}\n${r.sha256}\n`).join(""));
fs.writeFileSync(outFile, JSON.stringify({ sha256: setDigest, minChars: MIN_CHARS, references: list }));
console.log(`reference set: ${list.length} references (init ${initCount}, evaluate calls read ${calls}, playwright generated ${generated}), sha256 ${setDigest}`);
