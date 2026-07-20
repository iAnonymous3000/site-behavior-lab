import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

type ToolchainDriftHelpers = {
  assertPinnedSeccompProfile(playwrightVersion: string, localProfile: unknown, taggedProfile: unknown): void;
};

const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ToolchainDriftHelpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "check-toolchain-drift.mjs")).href
);

const reviewedSeccompDigests: Readonly<Record<string, string>> = {
  // microsoft/playwright v1.61.1 utils/docker/seccomp_profile.json
  "1.61.1": "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849"
};

test("promotion CI pins the reviewed seccomp bytes to the exact Playwright version", () => {
  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    dependencies?: { playwright?: string };
  };
  const packageLock = JSON.parse(readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };
  const playwrightVersion = packageJson.dependencies?.playwright;
  if (typeof playwrightVersion !== "string") assert.fail("package.json must pin Playwright exactly");
  assert.equal(playwrightVersion, packageLock.packages?.["node_modules/playwright"]?.version);
  const expectedDigest = reviewedSeccompDigests[playwrightVersion];
  assert.ok(expectedDigest, "Playwright pin needs a reviewed profile digest");

  const profileBytes = readFileSync(path.join(process.cwd(), "scripts", "playwright-seccomp-profile.json"));
  assert.equal(createHash("sha256").update(profileBytes).digest("hex"), expectedDigest);
});

test("Playwright's seccomp profile stays locked to the exact package tag", async () => {
  const { assertPinnedSeccompProfile } = await helpers;
  const localProfile = JSON.parse(
    readFileSync(path.join(process.cwd(), "scripts", "playwright-seccomp-profile.json"), "utf8")
  ) as { defaultAction: string };
  const matchingTaggedProfile = structuredClone(localProfile);

  assert.doesNotThrow(() => assertPinnedSeccompProfile("1.61.1", localProfile, matchingTaggedProfile));

  matchingTaggedProfile.defaultAction = "SCMP_ACT_ALLOW";
  assert.throws(
    () => assertPinnedSeccompProfile("1.61.1", localProfile, matchingTaggedProfile),
    /does not match Playwright v1\.61\.1/
  );
});
