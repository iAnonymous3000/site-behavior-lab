import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runtimeImportWalk, staticImports, type RuntimeReach } from "./client-import-graph";

// Two rules over what Node loads at run time, both read through the one
// import reader of lib/client-import-graph.ts.
//
// Closure: a hosted-evidence source role trusts the bytes of the files its
// trustedSourcePaths list. A trusted script that loads a file the list does
// not name runs bytes no one compared, so every file a trusted script reaches,
// directly or through a lib module, must be listed.
//
// Extensions: a scripts/*.mjs file that imports a lib .ts module has Node load
// it by type stripping, and Node resolves no specifier without its extension.
// So such a module, and every module it loads in turn, imports each runtime
// dependency by its full file name.

type Contract = { exactRoles: string[]; sources: Record<string, { workflows: string[]; trustedSourcePaths: string[] }> };
type Hosted = { HOSTED_EVIDENCE_PROFILES: readonly string[]; hostedEvidenceCollectionContract(profile: string): Contract };

const root = process.cwd();
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Hosted>;
const hosted = nativeImport(pathToFileURL(path.join(root, "scripts", "hosted-evidence-provenance-lib.mjs")).href);
const RUNTIME_FILE = /\.(?:mjs|js|cjs|ts|tsx|mts)$/;

/**
 * Every file a role's trusted scripts reach that the role does not list. The
 * walk starts at the scripts under scripts/ alone, so a file the list names is
 * still followed into what it loads.
 */
function closureProblems(label: string, trusted: readonly string[], base = root): string[] {
  const listed = new Set(trusted);
  return runtimeImportWalk(trusted.filter((file) => file.startsWith("scripts/") && RUNTIME_FILE.test(file)), base)
    .filter((reach) => !listed.has(reach.file))
    .map((reach) => `${label} reaches ${reach.file} by ${reach.trail.join(" -> ")}, which its trustedSourcePaths do not list`);
}

/** The lib modules scripts load by type stripping, and every runtime import of theirs with no extension. */
function strippedModules(scripts: readonly string[], base = root): { modules: RuntimeReach[]; problems: string[] } {
  const modules = runtimeImportWalk(scripts, base).filter((reach) => /\.(?:ts|mts|tsx)$/.test(reach.file));
  const problems = modules.flatMap((module) =>
    staticImports(readFileSync(path.join(base, module.file), "utf8"))
      .filter((found) => !found.typeOnly && found.specifier.startsWith(".") && !/\.(?:ts|mts|tsx|mjs|js|cjs|json)$/.test(found.specifier))
      .map((found) => `${module.file} imports "${found.specifier}" with no extension; Node loads it by type stripping from ${module.trail.join(" -> ")}`)
  );
  return { modules, problems };
}

function fixture(files: Record<string, string>): string {
  const base = mkdtempSync(path.join(tmpdir(), "sbl-runtime-imports-"));
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(base, relative)), { recursive: true });
    writeFileSync(path.join(base, relative), text);
  }
  return base;
}

test("the reader finds named, side-effect, dynamic and re-exported imports, and marks only type-only statements", () => {
  const found = staticImports([
    'import { a } from "./a.ts";',
    'import "./side.mjs";',
    'const late = await import("./late.mjs");',
    'export { b } from "./b.ts";',
    'export * from "./star.ts";',
    'import type { T } from "./types";',
    'export type { U } from "./more-types";',
    'import { type V, type W } from "./inline-types";',
    'import { type X, y } from "./mixed.ts";',
    'import d, { type Z } from "./default.ts";',
    'import type from "./named-type.ts";',
    'import {\n  type Long,\n  type Lines\n} from "./multiline-types";'
  ].join("\n"));
  assert.deepEqual(found, [
    { specifier: "./a.ts", typeOnly: false },
    { specifier: "./side.mjs", typeOnly: false },
    { specifier: "./late.mjs", typeOnly: false },
    { specifier: "./b.ts", typeOnly: false },
    { specifier: "./star.ts", typeOnly: false },
    { specifier: "./types", typeOnly: true },
    { specifier: "./more-types", typeOnly: true },
    { specifier: "./inline-types", typeOnly: true },
    { specifier: "./mixed.ts", typeOnly: false },
    { specifier: "./default.ts", typeOnly: false },
    { specifier: "./named-type.ts", typeOnly: false },
    { specifier: "./multiline-types", typeOnly: true }
  ]);
});

test("the runtime walk follows a script into lib and on through lib, and leaves out type-only imports and packages", () => {
  const base = fixture({
    "scripts/run.mjs": 'import { a } from "../lib/a.ts";\nimport "node:fs";\nimport x from "some-package";\nconst late = () => import("./late.mjs");\n',
    "scripts/late.mjs": "export {};\n",
    "lib/a.ts": 'import type { T } from "./types";\nimport { b } from "./b.ts";\nexport const a = b;\n',
    "lib/b.ts": "export const b = 1;\n",
    "lib/types.ts": "export type T = number;\n"
  });
  try {
    const reached = runtimeImportWalk(["scripts/run.mjs"], base);
    assert.deepEqual(reached.map((reach) => reach.file).sort(), ["lib/a.ts", "lib/b.ts", "scripts/late.mjs"]);
    assert.deepEqual(reached.find((reach) => reach.file === "lib/b.ts")?.trail, ["scripts/run.mjs", "lib/a.ts", "lib/b.ts"]);
    assert.throws(() => runtimeImportWalk(["scripts/missing.mjs"], base), /scripts\/missing\.mjs is not a file/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("closure: a file reached through a lib module and not listed is refused, by its trail", () => {
  const base = fixture({
    "scripts/smoke.mjs": 'import { a } from "../lib/first.ts";\n',
    "lib/first.ts": 'import { b } from "./second.ts";\nexport const a = b;\n',
    "lib/second.ts": "export const b = 1;\n"
  });
  try {
    assert.deepEqual(closureProblems("fixture:role", ["scripts/smoke.mjs", "lib/first.ts", "lib/second.ts"], base), []);
    assert.deepEqual(closureProblems("fixture:role", ["scripts/smoke.mjs", "lib/first.ts"], base), [
      "fixture:role reaches lib/second.ts by scripts/smoke.mjs -> lib/first.ts -> lib/second.ts, which its trustedSourcePaths do not list"
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("closure: every file each hosted-evidence role's trusted scripts reach at run time is in that role's trustedSourcePaths", async () => {
  const { HOSTED_EVIDENCE_PROFILES, hostedEvidenceCollectionContract } = await hosted;
  let rolesWithScripts = 0;
  const problems: string[] = [];
  for (const profile of HOSTED_EVIDENCE_PROFILES) {
    const contract = hostedEvidenceCollectionContract(profile);
    for (const role of contract.exactRoles) {
      const source = contract.sources[role];
      const trusted = [...source.workflows, ...source.trustedSourcePaths];
      if (!source.trustedSourcePaths.some((file) => file.startsWith("scripts/") && RUNTIME_FILE.test(file))) continue;
      rolesWithScripts += 1;
      problems.push(...closureProblems(`${profile}:${role}`, trusted));
    }
  }
  // An empty walk would pass whatever the table says.
  assert.ok(rolesWithScripts >= 3, `only ${rolesWithScripts} roles list a trusted script`);
  assert.deepEqual(problems, []);
});

test("extensions: no lib module a script loads by type stripping imports a runtime dependency without its extension", (t) => {
  const scripts = readdirSync(path.join(root, "scripts"))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => `scripts/${name}`);
  const { modules, problems } = strippedModules(scripts);
  const files = modules.map((module) => module.file).sort();
  t.diagnostic(`${files.length} lib modules loaded by type stripping: ${files.join(", ")}`);
  // Two modules the production health smoke loads, so an empty walk fails here.
  assert.ok(files.includes("lib/strict-json.ts") && files.includes("lib/production-synthetic.ts"), files.join(", "));
  assert.deepEqual(problems, []);
});

test("extensions: an extensionless runtime import in a stripped module is refused, and a type-only one is not", () => {
  const base = fixture({
    "scripts/run.mjs": 'import { a } from "../lib/a.ts";\n',
    "lib/a.ts": 'import type { T } from "./types";\nimport { b } from "./b";\nexport const a = b;\n',
    "lib/b.ts": "export const b = 1;\n",
    "lib/types.ts": "export type T = number;\n"
  });
  try {
    assert.deepEqual(strippedModules(["scripts/run.mjs"], base).problems, [
      'lib/a.ts imports "./b" with no extension; Node loads it by type stripping from scripts/run.mjs -> lib/a.ts'
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
