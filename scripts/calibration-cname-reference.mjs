#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  buildCaseWorksheet,
  firstPartyHostsFromHar,
  parseTrackerSource,
  sha256Hex,
  worksheetHeader
} from "./calibration-cname-reference-lib.mjs";

/**
 * Reviewer instrument for independent `cname-uncloaking` reference labels.
 *
 *   npm run calibration:cname-reference -- \
 *     --study-id cname-uncloaking-2026-08 \
 *     --cases /abs/cases.json \
 *     --har-dir /abs/har \
 *     --tracker-source /abs/external-tracking-domains.txt \
 *     --tracker-source-sha256 <64 hex> \
 *     --public-suffix-source /abs/public_suffix_list.dat \
 *     --public-suffix-sha256 <64 hex> \
 *     --resolver 9.9.9.9 \
 *     --out /abs/worksheet.json
 *
 * `cases.json` is `[{ "caseId": "...", "url": "https://..." }, ...]`, and
 * `--har-dir` holds one `<caseId>.har` per case, exported by the REVIEWER's own
 * browser. Nothing produced by this repository's scanner is an accepted input:
 * the blinding that matters here is that the reference never sees the
 * prediction it is going to be scored against.
 */

const options = parseOptions(process.argv.slice(2));

const trackerBytes = readFileSync(options.trackerSource);
const trackerDigest = sha256Hex(trackerBytes);
if (trackerDigest !== options.trackerSourceSha256) {
  fail(
    `tracker source digest ${trackerDigest} does not match the declared ${options.trackerSourceSha256}`
  );
}
const { suffixes: trackerSuffixes } = parseTrackerSource(trackerBytes);

const suffixBytes = readFileSync(options.publicSuffixSource);
const suffixDigest = sha256Hex(suffixBytes);
if (suffixDigest !== options.publicSuffixSha256) {
  fail(
    `public suffix source digest ${suffixDigest} does not match the declared ${options.publicSuffixSha256}`
  );
}
const publicSuffixes = parsePublicSuffixList(suffixBytes);

const cases = JSON.parse(readFileSync(options.cases, "utf8"));
if (!Array.isArray(cases) || cases.length === 0) fail("cases file must be a non-empty array");

assertNoScannerArtifacts(options.harDir);

const worksheets = [];
for (const [index, entry] of cases.entries()) {
  const caseId = String(entry?.caseId ?? "");
  const url = String(entry?.url ?? "");
  if (!caseId || !url.startsWith("https://")) {
    fail(`case ${index} must carry a caseId and an https url`);
  }
  const harPath = path.join(options.harDir, `${caseId}.har`);
  if (!existsSync(harPath)) fail(`no reviewer capture at ${harPath}`);
  const har = JSON.parse(readFileSync(harPath, "utf8"));
  const hosts = firstPartyHostsFromHar(har, url, publicSuffixes);
  process.stdout.write(`${caseId}: ${hosts.length} first-party subdomains ... `);
  const worksheet = await buildCaseWorksheet(
    { caseId, url, hosts },
    {
      resolverAddress: options.resolver,
      trackerSuffixes,
      publicSuffixes,
      maxHops: 10,
      timeoutMs: 5_000
    }
  );
  // The reviewer's own capture is bound into the worksheet so a third party can
  // confirm the hostnames were not chosen after the resolutions were seen.
  worksheet.captureSha256 = sha256Hex(readFileSync(harPath));
  worksheets.push(worksheet);
  console.log(
    worksheet.determined ? worksheet.proposedLabel : `${worksheet.proposedLabel} (UNDETERMINED)`
  );
}

const output = {
  ...worksheetHeader({
    studyId: options.studyId,
    resolverAddress: options.resolver,
    trackerSourcePath: options.trackerSource,
    trackerSourceDigest: trackerDigest,
    publicSuffixSourcePath: options.publicSuffixSource,
    publicSuffixSourceDigest: suffixDigest,
    capturedAt: new Date().toISOString()
  }),
  cases: worksheets
};
writeFileSync(options.out, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });

const undetermined = worksheets.filter((entry) => !entry.determined);
const present = worksheets.filter((entry) => entry.determined && entry.proposedLabel === "present");
console.log(
  `\nWrote ${options.out}: ${worksheets.length} cases, ${present.length} proposed present, ` +
    `${undetermined.length} undetermined.`
);
if (undetermined.length > 0) {
  console.log(
    "Undetermined cases had a candidate this resolver could not resolve. Do not label them\n" +
      "absent on this evidence: resolve the cause or record the case as one you could not\n" +
      "determine, exactly as a scan that could not capture is censored rather than negative."
  );
}
console.log(
  "\nThis worksheet is a proposal. Read the recorded chains, re-run any verifyCommand you\n" +
    "want to check, form your own judgement, then seal YOUR labels with\n" +
    "`npm run calibration:seal-label-source`."
);

/**
 * Fail closed if the reviewer's capture directory contains anything this
 * project produced. A reference label is only independent while the reviewer
 * has not seen the prediction, and a scan report sitting beside the HARs is the
 * easiest way for that to stop being true by accident.
 */
function assertNoScannerArtifacts(dir) {
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".har")) continue;
    fail(
      `reviewer capture directory contains ${name}; it must hold only <caseId>.har files so a ` +
        "scan report or detector output cannot leak into reference labelling"
    );
  }
}

function parsePublicSuffixList(bytes) {
  const suffixes = new Set();
  for (const line of Buffer.from(bytes).toString("utf8").split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("//")) continue;
    suffixes.add(value.replace(/^[*!]\./, "").toLowerCase());
  }
  if (suffixes.size === 0) fail("public suffix source contains no entries");
  return suffixes;
}

function parseOptions(argv) {
  const required = [
    "study-id",
    "cases",
    "har-dir",
    "tracker-source",
    "tracker-source-sha256",
    "public-suffix-source",
    "public-suffix-sha256",
    "resolver",
    "out"
  ];
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) fail(`unexpected argument ${key}`);
    values.set(key.slice(2), argv[i + 1]);
  }
  for (const key of required) {
    if (!values.get(key)) fail(`--${key} is required`);
  }
  for (const key of ["tracker-source-sha256", "public-suffix-sha256"]) {
    if (!/^[0-9a-f]{64}$/.test(values.get(key))) {
      fail(`--${key} must be 64 lowercase hex characters`);
    }
  }
  return {
    studyId: values.get("study-id"),
    cases: values.get("cases"),
    harDir: values.get("har-dir"),
    trackerSource: values.get("tracker-source"),
    trackerSourceSha256: values.get("tracker-source-sha256"),
    publicSuffixSource: values.get("public-suffix-source"),
    publicSuffixSha256: values.get("public-suffix-sha256"),
    resolver: values.get("resolver"),
    out: values.get("out")
  };
}

function fail(message) {
  console.error(`calibration:cname-reference: ${message}`);
  process.exit(1);
}
