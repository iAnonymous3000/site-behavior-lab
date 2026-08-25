#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseCandidateSet } from "./calibration-candidate-set-lib.mjs";
import {
  buildCaseWorksheet,
  firstPartyHostsFromHar,
  harCoversSubject,
  parseTrackerSource,
  sha256Hex,
  worksheetHeader
} from "./calibration-cname-reference-lib.mjs";

/**
 * Reviewer instrument for independent `cname-uncloaking` reference labels.
 *
 *   npm run calibration:cname-reference -- \
 *     --study-id cname-uncloaking-2026-08-prevalence-pilot \
 *     --cases /abs/pilot-set.json \
 *     --har-dir /abs/har \
 *     --frame-tasks /abs/frame-tasks.json \
 *     --tracker-source /abs/external-tracking-domains.txt \
 *     --tracker-source-sha256 <64 hex> \
 *     --public-suffix-source /abs/public_suffix_list.dat \
 *     --public-suffix-sha256 <64 hex> \
 *     --resolver 9.9.9.9 \
 *     --out /abs/worksheet.json
 *
 * `--cases` is the study's committed candidate set,
 * `{ "studyId": "...", "candidates": [{ "caseId": "...", "url": "https://..." }, ...] }`
 * (the same file the frame producer consumes, read by the same reader), and
 * `--har-dir` holds one `<caseId>.har` per case, exported by the REVIEWER's own
 * browser. Nothing produced by this repository's scanner is an accepted input:
 * the blinding that matters here is that the reference never sees the
 * prediction it is going to be scored against.
 */

const options = parseOptions(process.argv.slice(2));

// SHARED DEFINITION PINS: every reviewer classifies against the ONE
// tracker-definition and public-suffix snapshot the frame carries from the
// approved policy artifact. Silently divergent definitions would turn
// definition drift into fake labeling disagreement, so a mismatch refuses
// here, before any worksheet exists; the worksheet still records the
// digests so sealed evidence stays auditable against the pin.
const frameTasksForPins = JSON.parse(readFileSync(options.frameTasks, "utf8"));
const pinned = frameTasksForPins?.externalDefinitions ?? null;
if (!pinned?.trackerDefinition?.sha256 || !pinned?.publicSuffixDefinition?.sha256) {
  fail("the frame-tasks artifact carries no external definition pins for this detector");
}
if (options.trackerSourceSha256 !== pinned.trackerDefinition.sha256) {
  fail(
    `--tracker-source-sha256 ${options.trackerSourceSha256} does not equal the frame's pinned tracker definition ${pinned.trackerDefinition.sha256}`
  );
}
if (options.publicSuffixSha256 !== pinned.publicSuffixDefinition.sha256) {
  fail(
    `--public-suffix-sha256 ${options.publicSuffixSha256} does not equal the frame's pinned public-suffix definition ${pinned.publicSuffixDefinition.sha256}`
  );
}

const trackerBytes = readFileSync(options.trackerSource);
const trackerDigest = sha256Hex(trackerBytes);
if (trackerDigest !== options.trackerSourceSha256) {
  fail(
    `tracker source digest ${trackerDigest} does not match the declared ${options.trackerSourceSha256}`
  );
}
const { suffixes: trackerSuffixes, rejectedRows: trackerRejectedRows } = parseTrackerSource(trackerBytes);

const suffixBytes = readFileSync(options.publicSuffixSource);
const suffixDigest = sha256Hex(suffixBytes);
if (suffixDigest !== options.publicSuffixSha256) {
  fail(
    `public suffix source digest ${suffixDigest} does not match the declared ${options.publicSuffixSha256}`
  );
}
const publicSuffixes = parsePublicSuffixList(suffixBytes);

// The SAME reader the frame producer uses: the committed candidate set is the
// file both consume, so neither may have its own idea of that file's shape.
let candidateSet;
try {
  candidateSet = parseCandidateSet(readFileSync(options.cases, "utf8"));
} catch (error) {
  fail(`${error.message}; --cases takes the study's committed candidate set`);
}
if (candidateSet.studyId !== options.studyId) {
  fail(`candidate set studyId ${candidateSet.studyId} does not match --study-id ${options.studyId}`);
}
const cases = candidateSet.candidates;

assertNoScannerArtifacts(options.harDir);

const worksheets = [];
for (const { caseId, url } of cases) {
  const harPath = path.join(options.harDir, `${caseId}.har`);
  if (!existsSync(harPath)) fail(`no reviewer capture at ${harPath}`);
  const har = JSON.parse(readFileSync(harPath, "utf8"));
  // A capture that never LOADED the subject cannot answer anything about it,
  // and would otherwise be recorded as a determined ABSENT with no candidates
  // and no DNS: the most consequential label, from evidence of nothing.
  if (!harCoversSubject(har, url, publicSuffixes)) {
    fail(
      `the capture for ${caseId} contains no successful response from ${new URL(url).hostname}'s own ` +
        "registrable domain: the subject redirected to another domain, the navigation failed, or the HAR " +
        "is from the wrong tab. Re-capture it, or report the case to the operator if the subject really " +
        "does move off its own domain; either way this is a capture to fix, not a label"
    );
  }
  const hosts = firstPartyHostsFromHar(har, url, publicSuffixes);
  process.stdout.write(`${caseId}: ${hosts.length} first-party subdomains ... `);
  const worksheet = await buildCaseWorksheet(
    {
      caseId,
      url,
      hosts,
      // Bound into the worksheet so a third party can confirm the hostnames
      // were not chosen after the resolutions were seen.
      captureSha256: sha256Hex(readFileSync(harPath))
    },
    {
      resolverAddress: options.resolver,
      trackerSuffixes,
      publicSuffixes,
      maxHops: 10,
      timeoutMs: 5_000
    }
  );
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
    trackerSourceRejectedRows: trackerRejectedRows,
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
    "want to check, and form your own judgement. Record any case you decide differently in a\n" +
    "decisions file, then build and seal YOUR batch:\n" +
    "  npm run calibration:v4-reviewer-batch -- --worksheet <this file> --frame-tasks <frame> \\\n" +
    "    --tasks-dir <tasks> --role labeler|tiebreaker --actor <your github login> \\\n" +
    "    [--decisions <decisions.json>] --out batch.json\n" +
    "  npm run calibration:v4-seal-label-batch -- --role <same> --actor <same> --public-key <pem> \\\n" +
    "    --frame-tasks <frame> --tasks-dir <tasks> --input batch.json --output sealed-envelope.json"
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
    "frame-tasks",
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
    frameTasks: values.get("frame-tasks"),
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
