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
 *     [--pilot <pilot-size> <pilot-out.json>]
 *
 * Each manifest names the provider, its PERMANENT snapshot id, the retrieval
 * url and instant, and the sha256 of the exact bytes; the build refuses
 * bytes that do not hash to the manifest's digest. A population scope exists
 * only through --category (base order intersected with the category
 * source's membership); there is no scope string to type. --pilot carves a
 * disjoint prefix for the precommitted prevalence pilot.
 *
 * The exclusion set is derived HERE, from every repository surface that
 * carries a development-visited domain, and is applied only to REMOVE.
 * Nothing from the repository ranks or admits a candidate; the source list's
 * own order is the only ordering.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCandidateUniverse } from "./calibration-candidate-universe-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function registrableHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Every repository surface that names a development-visited site. Additive
 * on purpose: a domain wrongly excluded costs one source-list slot, while a
 * development domain wrongly ADMITTED contaminates the frame, so this
 * derivation errs toward exclusion.
 */
export function deriveDevelopmentCorpusExclusions() {
  const domains = new Set();
  const add = (value) => {
    const host = value?.includes?.("://") ? registrableHost(value) : value?.toLowerCase?.();
    if (typeof host === "string" && host.length > 0) {
      domains.add(host.replace(/^www\./, ""));
    }
  };

  // Committed public reports: the development corpus itself.
  const reportsDir = path.join(rootDir, "public", "reports");
  if (existsSync(reportsDir)) {
    for (const file of readdirSync(reportsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const report = JSON.parse(readFileSync(path.join(reportsDir, file), "utf8"));
        add(report?.run?.summary?.firstPartyDomain ?? report?.summary?.firstPartyDomain);
        add(report?.baseline?.summary?.firstPartyDomain);
        add(report?.run?.conditions?.finalUrl ?? report?.conditions?.finalUrl);
      } catch {
        // An unreadable report cannot name a domain; nothing to exclude.
      }
    }
  }

  // The scanner-fidelity frame, the repeatability studies, and any featured
  // catalogs: all development-visited.
  const jsonSources = [
    ["public", "scanner-fidelity-sites.json"],
    ["research", "repeatability", "urls.json"]
  ];
  for (const parts of jsonSources) {
    const file = path.join(rootDir, ...parts);
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const entries = Array.isArray(parsed) ? parsed : parsed.sites ?? [];
    for (const entry of entries) add(typeof entry === "string" ? entry : entry?.url);
  }
  const catalogDir = path.join(rootDir, "config");
  if (existsSync(catalogDir)) {
    for (const file of readdirSync(catalogDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const text = readFileSync(path.join(catalogDir, file), "utf8");
        for (const match of text.matchAll(/https?:\/\/[^\s"']+/g)) add(match[0]);
      } catch {
        // Ignore unreadable catalogs.
      }
    }
  }
  return [...domains].sort();
}

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
    "usage: calibration-candidate-universe-build.mjs <study-id> <base.txt> <base-manifest.json> <pool-size> <candidates-out.json> <provenance-out.json> [--category <src> <manifest>] [--pilot <size> <out.json>]"
  );
  process.exit(1);
}
if (flags.category !== null && (!flags.category.sourcePath || !flags.category.manifestPath)) {
  console.error("--category needs <category-source.txt> <category-manifest.json>");
  process.exit(1);
}
if (flags.pilot !== null && (!Number.isSafeInteger(flags.pilot.size) || !flags.pilot.outPath)) {
  console.error("--pilot needs <pilot-size> <pilot-out.json>");
  process.exit(1);
}

const exclusions = deriveDevelopmentCorpusExclusions();
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
  pilotSize: flags.pilot?.size ?? 0
});
writeFileSync(candidatesOut, candidateSetBytes);
writeFileSync(provenanceOut, `${JSON.stringify(provenance, null, 2)}\n`);
if (pilotSetBytes !== null && flags.pilot !== null) {
  writeFileSync(flags.pilot.outPath, pilotSetBytes);
}
console.log(
  `universe: ${provenance.poolSize} pool + ${provenance.pilotSize} pilot from ${provenance.sourceDomains} base domains` +
    (provenance.category === null ? "" : ` (${provenance.category.intersection} after category intersection)`) +
    `; ${provenance.excludedDomains.length} development-corpus domains excluded (${exclusions.length} in the exclusion set)`
);
console.log(`population: ${provenance.population}`);
console.log(`candidates written to ${candidatesOut}; provenance to ${provenanceOut}`);
