import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { githubSourceUrlAtBuildCommit } from "./build-source-url";

const REPOSITORY = "https://github.com/iAnonymous3000/site-behavior-lab";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("source links pin the exact public build commit", () => {
  assert.equal(
    githubSourceUrlAtBuildCommit(REPOSITORY, "lib/scanner.test.ts", COMMIT),
    `${REPOSITORY}/blob/${COMMIT}/lib/scanner.test.ts`
  );
});

test("source links never fall back to a moving or malformed revision", () => {
  assert.equal(githubSourceUrlAtBuildCommit(REPOSITORY, "lib/scanner.test.ts", "main"), null);
  assert.equal(githubSourceUrlAtBuildCommit(REPOSITORY, "../outside.ts", COMMIT), null);
  assert.equal(githubSourceUrlAtBuildCommit(REPOSITORY, "lib/scanner.test.ts", undefined), null);
});

test("catalog fixture links use the public build commit and no moving branch", () => {
  const source = readFileSync(path.join(process.cwd(), "app", "catalog", "page.tsx"), "utf8");
  assert.match(source, /NEXT_PUBLIC_SITE_BEHAVIOR_LAB_BUILD_COMMIT/);
  assert.match(source, /githubSourceUrlAtBuildCommit/);
  assert.doesNotMatch(source, /blob\/main/);
});
