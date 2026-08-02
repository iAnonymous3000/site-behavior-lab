#!/usr/bin/env node

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  buildFeaturedReadjudicationCycle,
  buildFeaturedReadjudicationReceipt,
  canonicalFeaturedReadjudicationText,
  FEATURED_READJUDICATION_CATALOG,
  FEATURED_READJUDICATION_RECEIPT_PATH,
  FEATURED_READJUDICATION_REPOSITORY,
  FEATURED_READJUDICATION_SCHEDULE,
  FEATURED_READJUDICATION_WORKFLOW,
  featuredReadjudicationCycleIssues,
  parseFeaturedReadjudicationCycle,
  parseFeaturedReadjudicationReceipt
} from "./featured-readjudication-lib.mjs";

const CYCLE_FLAGS = new Set([
  "--catalog",
  "--summary",
  "--output"
]);
const AGGREGATE_FLAGS = new Set([
  "--checkout-root",
  "--aug-3-outcomes",
  "--aug-3-artifact-id",
  "--aug-3-artifact-digest",
  "--aug-10-outcomes",
  "--aug-10-artifact-id",
  "--aug-10-artifact-digest",
  "--featured-sites",
  "--output"
]);
const VERIFY_FLAGS = new Set([
  "--receipt",
  "--featured-sites"
]);

function parseArgs(argv) {
  const modes = argv.filter((value) =>
    ["--cycle", "--aggregate", "--verify"].includes(value)
  );
  if (modes.length !== 1) {
    throw new Error("choose exactly one of --cycle, --aggregate, or --verify");
  }
  const mode = modes[0];
  const allowed =
    mode === "--cycle"
      ? CYCLE_FLAGS
      : mode === "--aggregate"
        ? AGGREGATE_FLAGS
        : VERIFY_FLAGS;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === mode) continue;
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    values.set(flag, value);
  }
  return { mode, values };
}

function required(values, flag) {
  const value = values.get(flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function absolute(values, flag) {
  const value = required(values, flag);
  if (!path.isAbsolute(value)) throw new Error(`${flag} must be absolute`);
  return value;
}

function readRegular(file, maximum = 1024 * 1024) {
  let descriptor;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size <= 0 || info.size > maximum) {
      throw new Error(`${file} must be a bounded non-empty regular file`);
    }
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function optionalSummary(file) {
  if (!file) return null;
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readRegular(file))
    );
  } catch {
    // The outcome artifact must still exist when acquisition failed before it
    // could write diagnostics. Missing/malformed evidence becomes the closed
    // navigation-incomplete outcome for every unproven domain.
    return null;
  }
}

function positiveId(value, label) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large`);
  return parsed;
}

function digest(value, label) {
  const normalized = value?.startsWith("sha256:")
    ? value.slice(7)
    : value;
  if (!/^[0-9a-f]{64}$/.test(normalized ?? "")) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return normalized;
}

function cycleMode(values) {
  const catalogPath = absolute(values, "--catalog");
  const output = absolute(values, "--output");
  const catalogBytes = readRegular(catalogPath, 2 * 1024 * 1024);
  const cycle = buildFeaturedReadjudicationCycle({
    repository: process.env.GITHUB_REPOSITORY,
    workflow: FEATURED_READJUDICATION_WORKFLOW,
    runId: positiveId(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    runAttempt: positiveId(
      process.env.GITHUB_RUN_ATTEMPT,
      "GITHUB_RUN_ATTEMPT"
    ),
    headSha: process.env.GITHUB_SHA,
    event: process.env.GITHUB_EVENT_NAME,
    schedule: process.env.GITHUB_EVENT_SCHEDULE,
    catalogPath: process.env.FEATURED_SITES_FILE,
    catalogBytes,
    summary: optionalSummary(
      values.has("--summary") ? absolute(values, "--summary") : undefined
    )
  });
  const issues = featuredReadjudicationCycleIssues(cycle);
  if (issues.length > 0) throw new Error(issues.join("; "));
  if (
    process.env.GITHUB_REPOSITORY !== FEATURED_READJUDICATION_REPOSITORY ||
    process.env.FEATURED_SITES_FILE !== FEATURED_READJUDICATION_CATALOG ||
    process.env.GITHUB_EVENT_SCHEDULE !== FEATURED_READJUDICATION_SCHEDULE
  ) {
    throw new Error("cycle environment is not the exact scheduled gallery lane");
  }
  writeFileSync(output, canonicalFeaturedReadjudicationText(cycle), {
    flag: "wx",
    mode: 0o600
  });
}

function aggregateMode(values) {
  const checkoutRoot = absolute(values, "--checkout-root");
  const output = absolute(values, "--output");
  const expectedOutput = path.join(
    checkoutRoot,
    ...FEATURED_READJUDICATION_RECEIPT_PATH.split("/")
  );
  if (path.resolve(output) !== expectedOutput) {
    throw new Error(`--output must be exactly ${expectedOutput}`);
  }
  const featuredSites = readRegular(
    absolute(values, "--featured-sites"),
    2 * 1024 * 1024
  );
  const cycleInputs = [
    {
      file: "--aug-3-outcomes",
      id: "--aug-3-artifact-id",
      digest: "--aug-3-artifact-digest"
    },
    {
      file: "--aug-10-outcomes",
      id: "--aug-10-artifact-id",
      digest: "--aug-10-artifact-digest"
    }
  ];
  const cycles = cycleInputs.map((entry) => {
    const cycleText = new TextDecoder("utf-8", { fatal: true }).decode(
      readRegular(absolute(values, entry.file))
    );
    const cycle = parseFeaturedReadjudicationCycle(cycleText);
    return {
      cycle,
      artifactId: positiveId(required(values, entry.id), entry.id),
      artifactName:
        `featured-readjudication-outcomes-${cycle.actionsRun.id}-${cycle.actionsRun.attempt}`,
      artifactSha256: digest(required(values, entry.digest), entry.digest)
    };
  });
  const receipt = buildFeaturedReadjudicationReceipt({
    cycles,
    featuredSitesBytes: featuredSites
  });
  writeFileSync(output, canonicalFeaturedReadjudicationText(receipt), {
    flag: "wx",
    mode: 0o600
  });
}

function verifyMode(values) {
  const receiptText = new TextDecoder("utf-8", { fatal: true }).decode(
    readRegular(absolute(values, "--receipt"))
  );
  const catalog = readRegular(
    absolute(values, "--featured-sites"),
    2 * 1024 * 1024
  );
  const receipt = parseFeaturedReadjudicationReceipt(receiptText, catalog);
  process.stdout.write(
    `PASS verified ${receipt.dispositions.length} featured re-adjudication dispositions\n`
  );
}

try {
  const { mode, values } = parseArgs(process.argv.slice(2));
  if (mode === "--cycle") cycleMode(values);
  else if (mode === "--aggregate") aggregateMode(values);
  else verifyMode(values);
} catch (error) {
  process.stderr.write(
    `Featured re-adjudication failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`
  );
  process.exitCode = 1;
}
