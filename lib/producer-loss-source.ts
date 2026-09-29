import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { EvidenceFamily } from "./scan-report-v2";

// Reads which capture-loss details the producers record from their own source,
// for the unit tests that must stay connected to the producers rather than to
// a hand-maintained list. Test-only: nothing at runtime reads source text.

/**
 * Every exported `const NAME = "value"` in lib, so a producer that writes
 * `detail: PAGE_SUBJECT_CAPTURE_LOSS_DETAIL` is resolved rather than skipped.
 * The first version of this guard matched string literals only and therefore
 * still passed with the registry entry deleted -- the test shared the bug's
 * blind spot.
 */
export function stringConstants(libDir: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const file of readdirSync(libDir)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const source = readFileSync(path.join(libDir, file), "utf8");
    for (const match of source.matchAll(
      /export const ([A-Z][A-Z0-9_]*)\s*=\s*"([^"\n]+)"/g
    )) {
      constants.set(match[1], match[2]);
    }
  }
  return constants;
}

/** `detail:` / `exhaustBudget({ name:` arguments, literal or named constant. */
export function recordedDetails(source: string, constants: Map<string, string>): string[] {
  const details = new Set<string>();
  const add = (raw: string) => {
    const resolved = raw.startsWith('"') ? raw.slice(1, -1) : constants.get(raw);
    if (resolved !== undefined) details.add(resolved);
  };
  for (const match of source.matchAll(/detail:\s*("[^"\n]+"|[A-Z][A-Z0-9_]*)/g)) {
    add(match[1]);
  }
  // exhaustBudget({ name: ... }) becomes `detail: name` downstream.
  for (const match of source.matchAll(
    /exhaustBudget\(\{[^}]*?name:\s*("[^"\n]+"|[A-Z][A-Z0-9_]*)/g
  )) {
    add(match[1]);
  }
  return [...details];
}

export function recordedFamilyDetails(
  source: string,
  constants: Map<string, string>
): Array<{ detail: string; family: EvidenceFamily }> {
  const entries: Array<{ detail: string; family: EvidenceFamily }> = [];
  const addBlock = (block: string, detailKey: "detail" | "name") => {
    const family = block.match(/family:\s*"([a-z-]+)"/)?.[1] as EvidenceFamily | undefined;
    const rawDetail = block.match(new RegExp(`${detailKey}:\\s*("[^"\\n]+"|[A-Z][A-Z0-9_]*)`))?.[1];
    if (family === undefined || rawDetail === undefined) return;
    const detail = rawDetail.startsWith('"') ? rawDetail.slice(1, -1) : constants.get(rawDetail);
    if (detail !== undefined) entries.push({ detail, family });
  };
  for (const call of source.split("recordCaptureLoss({").slice(1)) {
    addBlock(call.slice(0, call.indexOf("})")), "detail");
  }
  for (const call of source.split("exhaustBudget({").slice(1)) {
    addBlock(call.slice(0, call.indexOf("})")), "name");
  }
  return entries;
}
