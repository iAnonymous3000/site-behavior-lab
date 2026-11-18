import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Test support: the one reader of import specifiers in this repository's
 * tests, and the two walks built on it.
 *
 * `staticImports` reads `from "x"`, `import("x")` and a side-effect
 * `import "x"` out of a source text, in order, and says of each whether its
 * statement is type-only (`import type`, `export type`, or braces whose every
 * name is marked `type`), which TypeScript and Node's type stripping erase.
 * The specifiers it finds are exactly those of the pattern the client walk
 * has always used; the type-only flag is read from the statement around each.
 */
export type StaticImport = { specifier: string; typeOnly: boolean };

const SPECIFIER = /(?:from\s*|import\s*\(|import\s+)\s*["']([^"']+)["']/g;

/** True when the statement that ends at a `from` names types only. */
function statementIsTypeOnly(statement: string): boolean {
  const text = statement.replace(/\s+/g, " ").trim();
  if (/^(?:import|export) type (?!from\b)/.test(text)) return true;
  const braces = /^(?:import|export) \{([^}]*)\}\s*from$/.exec(text);
  if (braces === null) return false;
  const names = braces[1].split(",").map((name) => name.trim()).filter((name) => name !== "");
  return names.length > 0 && names.every((name) => /^type\s/.test(name));
}

export function staticImports(source: string): StaticImport[] {
  return [...source.matchAll(SPECIFIER)].map((match) => {
    const at = match.index ?? 0;
    if (!/^from/.test(match[0])) return { specifier: match[1], typeOnly: false };
    // The statement a `from` closes starts at the last import or export
    // keyword before it.
    const before = source.slice(0, at);
    const starts = [...before.matchAll(/(?:^|[^\w$.])(import|export)\b/g)];
    const last = starts[starts.length - 1];
    if (last === undefined) return { specifier: match[1], typeOnly: false };
    const start = (last.index ?? 0) + last[0].indexOf(last[1]);
    return { specifier: match[1], typeOnly: statementIsTypeOnly(`${source.slice(start, at)}from`) };
  });
}

/**
 * Test support: the import trails by which a "use client" module reaches
 * `target` (a path such as "lib/report-visit-summary.ts").
 *
 * In the App Router a "use client" directive is inherited through imports: a
 * module with no directive that a client component imports ships in the client
 * bundle with it, so grepping each file for the directive cannot answer
 * whether a server-only module stays server-only. This walks the graph from
 * every client root over app/ and lib/, following relative and "@/"
 * specifiers (packages are not followed), side-effect imports included.
 * Type-only imports count too, which errs toward refusing a module the
 * bundler would have erased.
 */
export function clientImportTrails(target: string, root = process.cwd()): string[] {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(relative);
      return /\.tsx?$/.test(entry.name) ? [relative] : [];
    });
  const files = new Set([...sourceFiles("app"), ...sourceFiles("lib")]);
  if (!files.has(target)) throw new Error(`${target} is not a source file under app/ or lib/`);
  const source = (file: string) => readFileSync(path.join(root, file), "utf8");
  const resolve = (from: string, specifier: string): string | null => {
    const base = specifier.startsWith("@/")
      ? specifier.slice(2)
      : specifier.startsWith(".")
        ? path.posix.join(path.posix.dirname(from), specifier)
        : null;
    if (base === null) return null;
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => files.has(candidate)) ?? null;
  };
  // `from "x"`, `import("x")`, and a side-effect `import "x"`, which bundles
  // the module as surely as a named import does. Type-only imports included.
  const importsOf = (file: string) =>
    staticImports(source(file))
      .map((found) => resolve(file, found.specifier))
      .filter((resolved): resolved is string => resolved !== null);
  const clientRoots = [...files].filter((file) => /^\s*["']use client["']/m.test(source(file)));
  if (clientRoots.length === 0) throw new Error("no client components were found, so the walk would check nothing");
  const trails: string[] = [];
  for (const start of clientRoots) {
    if (start === target) {
      trails.push(start);
      continue;
    }
    const seen = new Set([start]);
    const queue = [[start]];
    while (queue.length > 0) {
      const trail = queue.shift()!;
      for (const next of importsOf(trail[trail.length - 1])) {
        if (seen.has(next)) continue;
        seen.add(next);
        if (next === target) trails.push([...trail, next].join(" -> "));
        queue.push([...trail, next]);
      }
    }
  }
  return trails;
}

/** A file a runtime walk reached, the trail that first reached it, and the specifier that named it. */
export type RuntimeReach = { file: string; trail: string[]; specifier: string };

/**
 * Test support: every repository file that Node loads at run time from
 * `starts` (repository paths), transitively. Only relative specifiers are
 * followed, from any file of the walk; packages and `node:` modules are not.
 * Type-only imports are left out, since type stripping erases them. A
 * specifier with no extension, which Node itself would not resolve, is still
 * resolved here as TypeScript would (`.ts`, `.tsx`, `index.ts`), so the walk
 * goes on and a rule can name it. A specifier that names no file is refused.
 */
export function runtimeImportWalk(starts: readonly string[], root = process.cwd()): RuntimeReach[] {
  const isFile = (relative: string) => existsSync(path.join(root, relative)) && statSync(path.join(root, relative)).isFile();
  const resolve = (from: string, specifier: string): string => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(isFile);
    if (found === undefined) throw new Error(`${from} imports ${specifier}, which names no file`);
    return found;
  };
  const reached: RuntimeReach[] = [];
  const seen = new Set<string>();
  const queue: RuntimeReach[] = [];
  for (const start of starts) {
    if (!isFile(start)) throw new Error(`${start} is not a file`);
    if (seen.has(start)) continue;
    seen.add(start);
    queue.push({ file: start, trail: [start], specifier: start });
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!/\.(?:mjs|js|cjs|ts|tsx|mts)$/.test(current.file)) continue;
    for (const found of staticImports(readFileSync(path.join(root, current.file), "utf8"))) {
      if (found.typeOnly || !found.specifier.startsWith(".")) continue;
      const next = resolve(current.file, found.specifier);
      if (seen.has(next)) continue;
      seen.add(next);
      const reach = { file: next, trail: [...current.trail, next], specifier: found.specifier };
      reached.push(reach);
      queue.push(reach);
    }
  }
  return reached;
}
