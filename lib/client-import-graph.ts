import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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
  // the module as surely as a named import does.
  const importsOf = (file: string) =>
    [...source(file).matchAll(/(?:from\s*|import\s*\(|import\s+)\s*["']([^"']+)["']/g)]
      .map((match) => resolve(file, match[1]))
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
