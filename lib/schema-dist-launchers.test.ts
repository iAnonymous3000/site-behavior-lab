import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/**
 * Every consumer of the dist/schema production artifact must be able to skip
 * its own compile when an orchestrator has already built it for the whole run.
 *
 * The flag is not decorative. scripts/run-ci-scan.mjs runs the remediation
 * check once PER SITE and sets it expressly to prevent the recompile, so an
 * npm script with an inline `tsc &&` made a full featured refresh pay for one
 * whole schema build per scanned site while the caller believed it had
 * suppressed them.
 */
const SCHEMA_DIST_READY = "SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY";

test("no npm script compiles the schema artifact where an orchestrator cannot skip it", () => {
  const inline = Object.entries(packageJson.scripts).filter(
    ([, command]) => /tsc\s+-p\s+tsconfig\.schema\.json\s*&&/.test(command)
  );
  assert.deepEqual(
    inline.map(([name]) => name),
    [],
    "route these through a scripts/*.mjs launcher that honors the schema-dist flag"
  );
});

test("every schema-artifact launcher honors the orchestrator's build flag", () => {
  const launchers = [
    ...new Set(
      Object.values(packageJson.scripts)
        .map((command) => command.match(/^node (scripts\/[\w-]+\.mjs)/)?.[1])
        .filter((file): file is string => file !== undefined)
    )
  ]
    // Consumers RUN something out of dist/schema. scripts/build-schema.mjs
    // produces that artifact and must always compile, so it is not one.
    .filter((file) => {
      const source = readFileSync(path.join(root, file), "utf8");
      return source.includes("tsconfig.schema.json") && /"dist", "schema"/.test(source);
    });

  assert.ok(launchers.length > 0, "the schema launchers could not be located");
  assert.ok(launchers.includes("scripts/run-schema-cli.mjs"));
  for (const file of launchers) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.match(
      source,
      new RegExp(`if \\(process\\.env\\.${SCHEMA_DIST_READY} !== "1"\\) \\{`),
      `${file} must skip its compile when the artifact is already built`
    );
  }
});

test("the shared schema launcher forwards arguments and refuses unknown targets", () => {
  // `npm run reports:remediate -- --check` is the fail-closed corpus gate; a
  // launcher that dropped the flag would silently REWRITE every report in CI.
  const launcher = path.join(root, "scripts", "run-schema-cli.mjs");
  const source = readFileSync(launcher, "utf8");
  assert.match(source, /\.\.\.forwarded/);

  for (const [name, command] of Object.entries(packageJson.scripts)) {
    const target = command.match(/^node scripts\/run-schema-cli\.mjs ([\w-]+)$/)?.[1];
    if (!target) continue;
    assert.match(source, new RegExp(`"${target}": \\[`), `${name} names a target the launcher does not define`);
  }

  const refused = spawnSync(process.execPath, [launcher, "../../etc/passwd"], { cwd: root, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Unknown schema CLI/);
});

test("the release governance selection check reaches its verifier through the schema launcher", () => {
  // The verifier's canonical-JSON check loads dist/schema/lib/canonical-json.js
  // and falls back to any older tree, so `npm run
  // release:governance:verify-selection` must build it first. The flag skips
  // only the compile here; the target must still resolve to the verifier and
  // surface its own usage refusal and exit code. Three sibling operator
  // commands reach the same lazy canonicalizers, so they build first too.
  for (const [name, target] of [
    ["release:governance:verify-selection", "release-governance-verify-selection"],
    ["release:attestation-scaffold", "release-attestation-scaffold"],
    ["runner:expected-environment", "runner-expected-environment"],
    ["staging:teardown-targets", "staging-teardown-targets"]
  ]) {
    assert.equal(packageJson.scripts[name], `node scripts/run-schema-cli.mjs ${target}`, name);
  }
  const refused = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "run-schema-cli.mjs"), "release-governance-verify-selection"],
    { cwd: root, encoding: "utf8", env: { ...process.env, [SCHEMA_DIST_READY]: "1" } }
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Usage: node scripts\/verify-release-governance-selection\.mjs/);
});

test("the schema launcher surfaces a target's own exit status, and exits 1 for a failed compile whatever status tsc gave", () => {
  // The toolchain canary's compare exits 2 for an inconclusive comparison,
  // which is neither a pass nor a failure, and an operator reads that status
  // through this launcher. tsc exits 2 as well, when it reports diagnostics
  // and still writes its output, so a launcher that surfaced the compile's
  // status would let a type error read as an inconclusive canary. The launcher
  // is run from a copy beside a stand-in compiler and a stand-in target, so
  // each status is the one the stand-in was told to give.
  const directory = mkdtempSync(path.join(tmpdir(), "sbl-schema-launcher-"));
  try {
    mkdirSync(path.join(directory, "scripts"));
    mkdirSync(path.join(directory, "node_modules", "typescript", "bin"), { recursive: true });
    for (const file of ["run-schema-cli.mjs", "measurement-freeze-retention-lib.mjs"]) {
      copyFileSync(path.join(root, "scripts", file), path.join(directory, "scripts", file));
    }
    writeFileSync(
      path.join(directory, "node_modules", "typescript", "bin", "tsc"),
      "console.log(`compiled: ${process.argv.slice(2).join(\" \")}`);\nprocess.exit(Number(process.env.STAND_IN_TSC_STATUS));\n"
    );
    writeFileSync(
      path.join(directory, "scripts", "toolchain-canary.mjs"),
      "console.log(`target ran: ${process.argv.slice(2).join(\" \")}`);\nprocess.exitCode = Number(process.env.STAND_IN_TARGET_STATUS);\n"
    );
    const launch = (distReady: string, tscStatus: number, targetStatus: number) =>
      spawnSync(process.execPath, [path.join(directory, "scripts", "run-schema-cli.mjs"), "toolchain-canary", "compare"], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, [SCHEMA_DIST_READY]: distReady, STAND_IN_TSC_STATUS: String(tscStatus), STAND_IN_TARGET_STATUS: String(targetStatus) }
      });

    for (const tscStatus of [1, 2]) {
      const failedCompile = launch("", tscStatus, 0);
      assert.equal(failedCompile.status, 1, `tsc exit ${tscStatus}`);
      assert.equal(failedCompile.stdout, "compiled: -p tsconfig.schema.json\n", `tsc exit ${tscStatus}`);
    }
    for (const targetStatus of [0, 1, 2]) {
      const compiled = launch("", 0, targetStatus);
      assert.equal(compiled.status, targetStatus, `target exit ${targetStatus}`);
      assert.equal(compiled.stdout, "compiled: -p tsconfig.schema.json\ntarget ran: compare\n", `target exit ${targetStatus}`);
      // With the artifact already built the compile is skipped, so its status
      // cannot reach the caller at all.
      const skipped = launch("1", 2, targetStatus);
      assert.equal(skipped.status, targetStatus, `target exit ${targetStatus}, compile skipped`);
      assert.equal(skipped.stdout, "target ran: compare\n", `target exit ${targetStatus}, compile skipped`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  // The real launcher and the real command, on committed receipts whose
  // guardian repetitions spread beyond the tolerance within one build. They
  // are read with the replay command, on the committed panel they carry, so
  // this holds whichever panel is current.
  const inconclusive = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "run-schema-cli.mjs"),
      "toolchain-canary",
      "replay",
      "--baseline",
      path.join("docs", "toolchain-epoch-2026-10", "round-1-baseline-receipt.json"),
      "--candidate",
      path.join("docs", "toolchain-epoch-2026-10", "round-1-candidate-receipt.json")
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, [SCHEMA_DIST_READY]: "1" } }
  );
  assert.equal(inconclusive.status, 2, inconclusive.stderr);
  assert.match(inconclusive.stderr, /^REPLAY INCONCLUSIVE f9d6c46e744c60a3485eba3951f0b168b9170941 -> 34d6847b54d804c449bed160a53129ca2e1f16ef: not a pass\./m);
});
