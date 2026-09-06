import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";

// Cloudflare saves <root>/.next/cache. The Pages worktree is deliberately
// recreated for every build, so mount just the compiler cache from a
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
  // Next includes its server-reference key in Webpack's cache identity. Keep
  // Next's metadata (and its normal expiry/rotation), plus TypeScript's
  // incremental compilation state. Neither file contains rendered report data.
  for (const metadata of [".rscinfo", ".tsbuildinfo"]) {
    await symlink(
      path.join(rootDir, ".next", "cache", "pages", metadata),
      path.join(workCache, metadata),
      "file",
    );
  }
}
