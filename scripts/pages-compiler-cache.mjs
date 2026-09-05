import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";

// Cloudflare saves <root>/.next/cache. The Pages worktree is deliberately
// recreated for every build, so mount just the compiler directories from a
// separate namespace there. Never retain fetch data, generated routes, report
// manifests, schemas, or deployment receipts. Webpack owns source/config/lock
// invalidation; the runtime build keeps its own cache outside this namespace.
export async function attachPagesCompilerCache(rootDir, workDir) {
  const workCache = path.join(workDir, ".next", "cache");
  await mkdir(workCache, { recursive: true });
  for (const compiler of ["webpack", "swc"]) {
    const persistent = path.join(rootDir, ".next", "cache", "pages", compiler);
    await mkdir(persistent, { recursive: true });
    await symlink(persistent, path.join(workCache, compiler), "junction");
  }
}
