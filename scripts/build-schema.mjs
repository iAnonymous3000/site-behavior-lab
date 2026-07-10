#!/usr/bin/env node

/**
 * ScanReport v2 schema build (docs/scan-report-v2-rfc.md, 10.3):
 *
 * 1. Compiles the v2 reader/validator lane to dist/schema/ (CommonJS), the
 *    production-safe artifact .mjs scripts consume during consumer migration;
 *    never the .unit-test-dist test tree.
 * 2. Generates the immutable revisioned JSON Schema from the TS types (the
 *    source of truth) and writes it to public/schemas/ plus the stable alias
 *    public/scan-report.schema.json, so both publish with any static build.
 *
 * The generated files are committed; lib/scan-report-schema-parity.test.ts
 * fails on drift between the committed schema and a fresh generation. The
 * Pages builder also reruns this script inside its isolated worktree (which
 * excludes dist/) so the published copy can never go stale.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SCHEMA_ID = "https://sitebehavior.org/schemas/scan-report.v2.r1.schema.json";
const REVISIONED_PATH = path.join(rootDir, "public", "schemas", "scan-report.v2.r1.schema.json");
const ALIAS_PATH = path.join(rootDir, "public", "scan-report.schema.json");

/**
 * THE r1 freeze (RFC 10.2), executable: the published r1 schema is immutable.
 * The drift test alone would pass if the r1 types were edited and both files
 * regenerated together; this pin makes that path fail at build time instead.
 * It never changes. New shapes go into a new revision's types and schema file
 * (scan-report.v2.r2.schema.json), never into r1.
 */
export const R1_SCHEMA_SHA256 = "7b865e6903ecdd1ecc2a5d5e848ffb320b7a1db9742dc108f603e5e21c9756a6";

export function generateScanReportV2Schema() {
  const schema = createGenerator({
    path: path.join(rootDir, "lib", "scan-report-v2.ts"),
    type: "PublicScanReportV2",
    skipTypeCheck: true,
    additionalProperties: false,
    topRef: true
  }).createSchema("PublicScanReportV2");
  return { $id: SCHEMA_ID, ...schema };
}

function main() {
  // Atomicity: verify the freeze BEFORE any other side effect (including the
  // validator-artifact compile), so a rejected mutation leaves nothing behind.
  const schema = generateScanReportV2Schema();
  const serialized = `${JSON.stringify(schema, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  if (digest !== R1_SCHEMA_SHA256) {
    console.error(
      `FATAL: generated r1 schema hash ${digest} does not match the frozen ${R1_SCHEMA_SHA256}.\n` +
        "The published v2 r1 schema is immutable. If the r1 types changed, revert them; " +
        "new shapes belong in a new revision (scan-report.v2.r2.schema.json), never in r1."
    );
    process.exit(1);
  }

  execFileSync(process.execPath, [path.join(rootDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.schema.json"], {
    cwd: rootDir,
    stdio: "inherit"
  });

  mkdirSync(path.dirname(REVISIONED_PATH), { recursive: true });
  writeFileSync(REVISIONED_PATH, serialized);
  writeFileSync(ALIAS_PATH, serialized);
  console.log(`Schema written to ${path.relative(rootDir, REVISIONED_PATH)} (+ stable alias), validator artifact in dist/schema/.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
