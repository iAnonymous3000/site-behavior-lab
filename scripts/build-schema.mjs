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
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SCHEMA_ID = "https://sitebehavior.org/schemas/scan-report.v2.r1.schema.json";
const REVISIONED_PATH = path.join(rootDir, "public", "schemas", "scan-report.v2.r1.schema.json");
const ALIAS_PATH = path.join(rootDir, "public", "scan-report.schema.json");

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
  execFileSync(process.execPath, [path.join(rootDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.schema.json"], {
    cwd: rootDir,
    stdio: "inherit"
  });

  const schema = generateScanReportV2Schema();
  const serialized = `${JSON.stringify(schema, null, 2)}\n`;
  mkdirSync(path.dirname(REVISIONED_PATH), { recursive: true });
  writeFileSync(REVISIONED_PATH, serialized);
  writeFileSync(ALIAS_PATH, serialized);
  console.log(`Schema written to ${path.relative(rootDir, REVISIONED_PATH)} (+ stable alias), validator artifact in dist/schema/.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
