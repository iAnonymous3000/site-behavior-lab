#!/usr/bin/env node
/**
 * Build a calibration candidate universe from an operator-supplied external
 * source list (scripts/calibration-candidate-universe-lib.mjs holds the
 * rules; docs/reliability-sweep-cluster-design.md the design).
 *
 *   node scripts/calibration-candidate-universe-build.mjs \
 *     <study-id> <external-source.txt> "<source description>" <pool-size> \
 *     <candidates-out.json> <provenance-out.json>
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

const [, , studyId, sourcePath, sourceDescription, poolSizeRaw, candidatesOut, provenanceOut] =
  process.argv;
if (!studyId || !sourcePath || !sourceDescription || !poolSizeRaw || !candidatesOut || !provenanceOut) {
  console.error(
    "usage: calibration-candidate-universe-build.mjs <study-id> <source.txt> <description> <pool-size> <candidates-out.json> <provenance-out.json>"
  );
  process.exit(1);
}

const exclusions = deriveDevelopmentCorpusExclusions();
const { candidateSetBytes, provenance } = buildCandidateUniverse({
  studyId,
  sourceBytes: readFileSync(sourcePath, "utf8"),
  sourceDescription,
  exclusions,
  poolSize: Number(poolSizeRaw)
});
writeFileSync(candidatesOut, candidateSetBytes);
writeFileSync(provenanceOut, `${JSON.stringify(provenance, null, 2)}\n`);
console.log(
  `universe: ${provenance.poolSize} candidates from ${provenance.sourceDomains} source domains; ` +
    `${provenance.excludedDomains.length} development-corpus domains excluded (${exclusions.length} in the exclusion set)`
);
console.log(`candidates written to ${candidatesOut}; provenance to ${provenanceOut}`);
