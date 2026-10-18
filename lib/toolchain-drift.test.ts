import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

type ToolchainDriftHelpers = {
  assertPinnedSeccompProfile(playwrightVersion: string, localProfile: unknown, taggedProfile: unknown): void;
  driftRows(
    pinned: {
      adblock: string;
      playwright: string;
      chromium: { version: string };
      tldts: string;
      pdfjs: string;
      undici: string;
    },
    upstream: {
      adblock: string;
      playwright: string;
      chromeStable: string;
      tldts: string;
      pdfjs: string;
      undici: string;
    }
  ): Array<{
    component: string;
    drift: boolean;
    actionable: boolean;
    action: string;
  }>;
  markdownReport(
    rows: Array<{
      component: string;
      pinned: string;
      upstream: string;
      drift: boolean;
      actionable: boolean;
      action: string;
    }>,
    checkedAt: string
  ): string;
  resolvedLockedDependency(packageLock: unknown, name: string): string;
};

const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ToolchainDriftHelpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "check-toolchain-drift.mjs")).href
);

const reviewedSeccompDigests: Readonly<Record<string, string>> = {
  // microsoft/playwright v1.61.1 utils/docker/seccomp_profile.json
  "1.61.1": "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849",
  // v1.62.0 ships the SAME bytes: the upstream profile was fetched at that tag
  // and is byte-identical to v1.61.1's, so the container's syscall policy did
  // not move with the toolchain. Same digest here records a completed review,
  // not a skipped one.
  "1.62.0": "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849",
  // v1.62.1 likewise: utils/docker/seccomp_profile.json at that tag is
  // byte-identical to the reviewed file, fetched and compared when the
  // measurement epoch moved. Reviewed, not skipped.
  "1.62.1": "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849",
  // v1.63.0 likewise: utils/docker/seccomp_profile.json at the v1.63.0 tag
  // (commit 1b025d7e20a026371cd5f98ba0cdce48892737c8) was fetched and is
  // byte-identical to the committed profile. Reviewed, not skipped.
  "1.63.0": "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849"
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

test("browser-channel lag stays visible without opening an unactionable maintenance issue", async () => {
  const { driftRows, markdownReport } = await helpers;
  const rows = driftRows(
    {
      adblock: "0.13.2",
      playwright: "1.61.1",
      chromium: { version: "149.0.7827.55" },
      tldts: "7.4.9",
      pdfjs: "6.3.289",
      undici: "8.11.2"
    },
    {
      adblock: "0.13.2",
      playwright: "1.61.1",
      chromeStable: "150.0.7871.128",
      tldts: "7.4.9",
      pdfjs: "6.3.289",
      undici: "8.11.2"
    }
  );

  const chromium = rows.find((row) => row.component.startsWith("Bundled Chromium"));
  assert.deepEqual(chromium && { drift: chromium.drift, actionable: chromium.actionable }, {
    drift: true,
    actionable: false
  });
  assert.equal(rows.some((row) => row.actionable), false);

  const reportRows = driftRows(
    {
      adblock: "0.13.2",
      playwright: "1.61.1",
      chromium: { version: "149.0.7827.55" },
      tldts: "7.4.9",
      pdfjs: "6.3.289",
      undici: "8.11.2"
    },
    {
      adblock: "0.13.2",
      playwright: "1.61.1",
      chromeStable: "150.0.7871.128",
      tldts: "7.4.9",
      pdfjs: "6.3.289",
      undici: "8.11.2"
    }
  ).map((row) => ({ ...row, pinned: "pinned", upstream: "upstream", action: "upgrade" }));
  const report = markdownReport(reportRows, "2026-07-21T00:00:00.000Z");
  assert.match(report, /waiting on stable Playwright/);
  assert.match(report, /supported upgrade paths/);
  assert.doesNotMatch(report, /\*\*Bundled Chromium/);
});

test("supported package upgrades remain actionable", async () => {
  const { driftRows } = await helpers;
  const rows = driftRows(
    {
      adblock: "0.13.1",
      playwright: "1.60.0",
      chromium: { version: "148.0.0.0" },
      tldts: "7.4.8",
      pdfjs: "6.3.289",
      undici: "8.11.2"
    },
    {
      adblock: "0.13.2",
      playwright: "1.61.1",
      chromeStable: "150.0.0.0",
      tldts: "7.4.9",
      pdfjs: "6.4.299",
      undici: "8.12.2"
    }
  );

  assert.deepEqual(
    rows.map((row) => [row.component, row.actionable]),
    [
      ["adblock-rust", true],
      ["Playwright", true],
      ["Bundled Chromium / Chrome Stable (Linux)", false],
      ["tldts", true],
      ["pdfjs-dist", true],
      ["undici", true]
    ]
  );
});

test("pdf.js and undici drift at the version the lock resolves and move only through their detector guard", async () => {
  const { driftRows, resolvedLockedDependency } = await helpers;
  // package.json declares pdfjs-dist as a range, so a regenerated lock can
  // resolve a newer release than the range names. npm ci installs that one.
  const packageLock = {
    packages: {
      "": { dependencies: { "pdfjs-dist": "^6.3.289", undici: "8.11.2" } },
      "node_modules/pdfjs-dist": { version: "6.4.299" },
      "node_modules/undici": { version: "8.11.2" }
    }
  };
  assert.equal(resolvedLockedDependency(packageLock, "pdfjs-dist"), "6.4.299");
  assert.equal(resolvedLockedDependency(packageLock, "undici"), "8.11.2");
  assert.throws(
    () => resolvedLockedDependency({ packages: { "node_modules/undici": { version: "8.11.2" } } }, "undici"),
    /must declare undici/
  );
  assert.throws(
    () => resolvedLockedDependency({ packages: { "": { dependencies: { undici: "8.11.2" } } } }, "undici"),
    /resolved undici version is missing or malformed/
  );

  const rows = driftRows(
    {
      adblock: "0.13.3",
      playwright: "1.63.0",
      chromium: { version: "153.0.8010.12" },
      tldts: "7.4.16",
      pdfjs: "6.3.289",
      undici: "8.11.2"
    },
    {
      adblock: "0.13.3",
      playwright: "1.63.0",
      chromeStable: "153.0.8010.70",
      tldts: "7.4.16",
      pdfjs: "6.3.289",
      undici: "8.12.2"
    }
  );
  assert.deepEqual(
    rows.filter((row) => row.actionable).map((row) => row.component),
    ["undici"]
  );
  for (const row of rows.filter((candidate) => ["pdfjs-dist", "undici"].includes(candidate.component))) {
    assert.match(row.action, /detector epoch/);
    const guard = /lib\/[\w.-]+\.test\.ts/.exec(row.action)?.[0];
    assert.ok(guard && existsSync(path.join(process.cwd(), guard)), `${row.component} must name its existing guard`);
  }
});
