/**
 * Lightweight server-side reader for committed `public/v3/corpus-snapshot.json`
 * used to enrich static site profiles (`/sites/[domain]`) with deep multi-arm
 * signal summaries and links to interactive reports.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { IndexedReportRowV3 } from "./schema";

type PublicSeedSnapshotFile = {
  schemaVersion?: number;
  items?: IndexedReportRowV3[];
};

let cachedByDomain: Map<string, IndexedReportRowV3> | null = null;

function loadSeedSnapshotMap(): Map<string, IndexedReportRowV3> {
  if (cachedByDomain) return cachedByDomain;
  const map = new Map<string, IndexedReportRowV3>();
  const filePath = path.join(process.cwd(), "public", "v3", "corpus-snapshot.json");
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as PublicSeedSnapshotFile;
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          if (item && typeof item.canonicalDomain === "string") {
            map.set(item.canonicalDomain.toLowerCase(), item);
          }
        }
      }
    } catch {
      // Ignore corrupt/missing optional snapshot; site profiles render normally without it.
    }
  }
  cachedByDomain = map;
  return map;
}

export function findSeededV3SiteSnapshot(canonicalDomain: string): IndexedReportRowV3 | null {
  const normalized = canonicalDomain.trim().toLowerCase().replace(/^www\./, "");
  return loadSeedSnapshotMap().get(normalized) ?? null;
}
