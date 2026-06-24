// Fetches the constituent filter lists that make up Brave's default ad-block
// component (from Brave's own list catalog) and vendors a pinned, gzipped
// snapshot for the WASM adblock engine. Brave-owned supply chain only, no
// competitor dataset. Refresh with: npm run lists:brave
import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const CATALOG_URL =
  "https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json";
const OUT_DIR = path.join(process.cwd(), "lib", "adblock-wasm");

function collectDefaultSources(catalog) {
  const lists = Array.isArray(catalog)
    ? catalog
    : Object.values(catalog).find(Array.isArray) ?? [];
  const urls = lists
    .filter((entry) => entry && entry.default_enabled === true)
    .flatMap((entry) => (Array.isArray(entry.sources) ? entry.sources : []))
    .map((source) => source && source.url)
    .filter((url) => typeof url === "string" && url.length > 0);
  return [...new Set(urls)];
}

async function main() {
  console.log(`Fetching Brave list catalog: ${CATALOG_URL}`);
  const catalogResponse = await fetch(CATALOG_URL);
  if (!catalogResponse.ok) throw new Error(`catalog HTTP ${catalogResponse.status}`);
  const catalog = await catalogResponse.json();

  const urls = collectDefaultSources(catalog);
  if (urls.length === 0) throw new Error("No default_enabled source URLs found in catalog.");
  console.log(`Default-enabled source lists: ${urls.length}`);

  const parts = [];
  const fetched = [];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      parts.push(`! ===== source: ${url} =====\n${text}`);
      fetched.push(url);
      console.log(`  ok   ${url} (${(text.length / 1024).toFixed(0)} KB)`);
    } catch (error) {
      console.warn(`  SKIP ${url}: ${error.message}`);
    }
  }

  const fetchedAt = new Date().toISOString();
  const header =
    `! Brave default ad-block filters, pinned snapshot\n` +
    `! Fetched ${fetchedAt} from ${fetched.length}/${urls.length} sources in Brave's catalog\n` +
    `! Catalog: ${CATALOG_URL}\n`;
  const combined = `${header}${parts.join("\n")}\n`;
  const gz = gzipSync(Buffer.from(combined, "utf8"));

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "brave-default-filters.txt.gz"), gz);
  await writeFile(
    path.join(OUT_DIR, "brave-default-filters.meta.json"),
    `${JSON.stringify({ fetchedAt, catalog: CATALOG_URL, sourceCount: fetched.length, sources: fetched, rawBytes: combined.length, gzipBytes: gz.length }, null, 2)}\n`
  );

  console.log(
    `\nWrote lib/adblock-wasm/brave-default-filters.txt.gz, ${(gz.length / 1024).toFixed(0)} KB gz / ${(combined.length / 1024 / 1024).toFixed(1)} MB raw, from ${fetched.length} sources.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
