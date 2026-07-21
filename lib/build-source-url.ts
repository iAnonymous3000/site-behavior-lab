const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;
const SAFE_REPOSITORY_PATH = /^[A-Za-z0-9._/-]+$/;

/**
 * Link source evidence to the exact revision that built the public page.
 * Missing local provenance produces no link; it never falls back to a moving
 * branch such as main.
 */
export function githubSourceUrlAtBuildCommit(
  repositoryUrl: string,
  file: string,
  buildCommit: string | undefined
): string | null {
  const commit = buildCommit?.trim().toLowerCase() ?? "";
  const repository = repositoryUrl.replace(/\/+$/, "");
  if (!FULL_GIT_SHA.test(commit)) return null;
  if (!file || file.startsWith("/") || file.includes("..") || !SAFE_REPOSITORY_PATH.test(file)) return null;
  return `${repository}/blob/${commit}/${file}`;
}
