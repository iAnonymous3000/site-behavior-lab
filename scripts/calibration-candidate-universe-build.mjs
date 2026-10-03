#!/usr/bin/env node
/**
 * Build a calibration candidate universe from an operator-supplied external
 * source list (scripts/calibration-candidate-universe-lib.mjs holds the
 * rules; docs/reliability-sweep-cluster-design.md the design).
 *
 *   node scripts/calibration-candidate-universe-build.mjs <study-id> \
 *     <base-source.txt> <base-manifest.json> <pool-size> \
 *     <candidates-out.json> <provenance-out.json> \
 *     [--category <category-source.txt> <category-manifest.json>] \
 *     --pilot <pilot-size> <pilot-out.json>
 *
 * Each manifest names the provider, its PERMANENT snapshot id, the retrieval
 * url and instant, and the sha256 of the exact bytes; the build refuses
 * bytes that do not hash to the manifest's digest. A population scope exists
 * only through --category (base order intersected with the category
 * source's membership); there is no scope string to type. --pilot is
 * REQUIRED: it sizes the precommitted prevalence pilot, split from the fixed
 * frame by a seeded random partition whose seed derives from the committed
 * inputs, never a prefix and never a free parameter.
 *
 * The exclusion set is derived from every repository surface that records
 * a development visit (scripts/calibration-development-exclusions-lib.mjs
 * declares them; a missing or reshaped surface refuses the build) and is
 * applied only to REMOVE. Nothing from the repository ranks or admits a
 * candidate; the source list's own order is the only ordering. The set is a
 * function of the whole tree, so a universe is re-derivable only from the
 * commit it was built at.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCandidateUniverse } from "./calibration-candidate-universe-lib.mjs";
import { deriveDevelopmentExclusions } from "./calibration-development-exclusions-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const positional = [];
const flags = { category: null, pilot: null };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--category") {
    flags.category = { sourcePath: argv[index + 1], manifestPath: argv[index + 2] };
    index += 2;
  } else if (argv[index] === "--pilot") {
    flags.pilot = { size: Number(argv[index + 1]), outPath: argv[index + 2] };
    index += 2;
  } else {
    positional.push(argv[index]);
  }
}
const [studyId, sourcePath, manifestPath, poolSizeRaw, candidatesOut, provenanceOut] = positional;
if (!studyId || !sourcePath || !manifestPath || !poolSizeRaw || !candidatesOut || !provenanceOut) {
  console.error(
    "usage: calibration-candidate-universe-build.mjs <study-id> <base.txt> <base-manifest.json> <pool-size> <candidates-out.json> <provenance-out.json> [--category <src> <manifest>] --pilot <size> <out.json>"
  );
  process.exit(1);
}
if (flags.category !== null && (!flags.category.sourcePath || !flags.category.manifestPath)) {
  console.error("--category needs <category-source.txt> <category-manifest.json>");
  process.exit(1);
}
if (flags.pilot === null || !Number.isSafeInteger(flags.pilot.size) || !flags.pilot.outPath) {
  console.error("--pilot <pilot-size> <pilot-out.json> is required: a confirmatory universe without a pilot has no prevalence estimate");
  process.exit(1);
}

const { domains: exclusions, surfaces } = deriveDevelopmentExclusions({ rootDir });
const { candidateSetBytes, pilotSetBytes, provenance } = buildCandidateUniverse({
  studyId,
  base: {
    bytes: readFileSync(sourcePath, "utf8"),
    manifest: JSON.parse(readFileSync(manifestPath, "utf8"))
  },
  category:
    flags.category === null
      ? null
      : {
          bytes: readFileSync(flags.category.sourcePath, "utf8"),
          manifest: JSON.parse(readFileSync(flags.category.manifestPath, "utf8"))
        },
  exclusions,
  poolSize: Number(poolSizeRaw),
  pilotSize: flags.pilot.size
});
writeFileSync(candidatesOut, candidateSetBytes);
writeFileSync(provenanceOut, `${JSON.stringify(provenance, null, 2)}\n`);
writeFileSync(flags.pilot.outPath, pilotSetBytes);
console.log(
  `universe: ${provenance.poolSize} pool + ${provenance.pilotSize} pilot from ${provenance.sourceDomains} base domains` +
    (provenance.category === null ? "" : ` (${provenance.category.intersection} after category intersection)`) +
    `; ${provenance.excludedDomains.length} development-corpus domains excluded (${exclusions.length} in the exclusion set)`
);
for (const surface of surfaces) {
  console.log(`exclusion surface ${surface.path}: ${surface.records} records, ${surface.domains} domains`);
}
console.log(`population: ${provenance.population}`);
console.log(`candidates written to ${candidatesOut}; provenance to ${provenanceOut}`);
