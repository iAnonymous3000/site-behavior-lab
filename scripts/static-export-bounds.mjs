import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Bounds on the published static export, stated once.
 *
 * Two checks read them: the static smoke (scripts/smoke-static-site.mjs)
 * measures the directory a build wrote, and the deploy path
 * (scripts/published-pages-lib.mjs) refuses a receipt outside them. They were
 * restated in each file before, which let one move without the other.
 *
 * Two are the host's limits and one is ours.
 *
 * STATIC_EXPORT_MAX_FILES and STATIC_EXPORT_MAX_FILE_BYTES are Cloudflare
 * Pages' published limits, read on 2026-11-14 at
 * https://developers.cloudflare.com/pages/platform/limits/: 20,000 files for a
 * site on the Free plan (the smaller of the plan limits, so the bound holds
 * whichever plan the account is on) and 25 MiB for one file. An export past
 * either is one the host refuses, so these are the failures a deploy would
 * otherwise be the first to report. Measured on 2026-11-14 at 46cc0aab: 11,263
 * files, ten of them under out/reports for each report, and a largest file of
 * 3.5 MiB.
 *
 * STATIC_EXPORT_MAX_BYTES is not a host limit. That page states no limit on
 * the total size of a site. The earlier value, 700 MiB, was set on 2026-08-08
 * under GitHub Pages' 1 GB limit, from 318 MiB measured over 574 reports and an
 * estimate of 554 MiB for a corpus at the pruner's count limit of 1,000. The
 * site left GitHub Pages, and the estimate was low: measured on 2026-11-14 at
 * 46cc0aab, the export is 641.0 MiB over 1,029 reports, about 0.62 MiB for each
 * report, with out/reports nearly all of it.
 *
 * So the number is a tripwire and nothing else. It exists to stop a change that
 * multiplies the export by accident, such as prerendering the printable route
 * for every report, before it is published. It is the measured export of a
 * corpus at its limit with a quarter added (641.0 MiB by 1.25 is 801 MiB),
 * which keeps the margin the first derivation used (554 to 700) and still
 * fails well before the export doubles.
 *
 * It is not a budget that evidence must be cut to fit. A change that adds
 * bytes to every report on purpose may raise it, in the same change, with the
 * export measured before and after and the reason stated here. A change that
 * breaches it without meaning to add anything has found what it is for.
 */
export const STATIC_EXPORT_MAX_FILES = 20_000;
export const STATIC_EXPORT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const STATIC_EXPORT_MAX_BYTES = 800 * 1024 * 1024;

/**
 * The first bound a measured export breaks, as a sentence, or null.
 *
 * `largestFileBytes` is the size of the largest single file. Both callers pass
 * what they measured, so the two cannot disagree about what a bound means.
 */
export function staticExportBoundViolation({ fileCount, bytes, largestFileBytes }) {
  for (const [name, value] of [["file count", fileCount], ["total bytes", bytes], ["largest file bytes", largestFileBytes]]) {
    if (!Number.isSafeInteger(value) || value < 0) return `static export ${name} is not a count: ${String(value)}`;
  }
  if (fileCount < 1 || bytes < 1) return "static export is empty";
  if (fileCount > STATIC_EXPORT_MAX_FILES) {
    return `static export has ${fileCount} files; the host accepts ${STATIC_EXPORT_MAX_FILES}`;
  }
  if (largestFileBytes > STATIC_EXPORT_MAX_FILE_BYTES) {
    return `static export's largest file is ${largestFileBytes} bytes; the host accepts ${STATIC_EXPORT_MAX_FILE_BYTES} for one file`;
  }
  if (bytes > STATIC_EXPORT_MAX_BYTES) {
    return `static export is ${(bytes / 1024 / 1024).toFixed(1)} MiB; ceiling is ${(STATIC_EXPORT_MAX_BYTES / 1024 / 1024).toFixed(0)} MiB`;
  }
  return null;
}

/**
 * Measure a directory as the bounds read it: every entry that is not a
 * directory is one file of its own size, dotfiles included. `stat` follows a
 * symlink, so a link counts as what it points at and cannot make an export
 * read smaller than what would be published.
 *
 * `entries` lists the top level, largest first, so a breach can say what grew.
 */
export async function measureStaticExport(directory) {
  const total = { fileCount: 0, bytes: 0, largestFileBytes: 0, largestFile: "", entries: [] };
  const add = (into, from) => {
    into.fileCount += from.fileCount;
    into.bytes += from.bytes;
    if (from.largestFileBytes > into.largestFileBytes) {
      into.largestFileBytes = from.largestFileBytes;
      into.largestFile = from.largestFile;
    }
  };
  const walk = async (current, relative) => {
    const measure = { fileCount: 0, bytes: 0, largestFileBytes: 0, largestFile: "" };
    const names = (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of names) {
      const child = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      let inner;
      if (entry.isDirectory()) {
        inner = await walk(child, childRelative);
      } else {
        const { size } = await stat(child);
        inner = { fileCount: 1, bytes: size, largestFileBytes: size, largestFile: childRelative };
      }
      add(measure, inner);
      if (!relative) total.entries.push({ name: entry.name, fileCount: inner.fileCount, bytes: inner.bytes });
    }
    return measure;
  };
  add(total, await walk(directory, ""));
  total.entries.sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1));
  return total;
}

/**
 * The size of every report page in an export, largest first.
 *
 * The static smoke opens one report in a browser, and its HTML budget used to
 * be read from that one page, the first in the index. A budget read from one
 * page says nothing of the largest, so the smoke reads this list instead. A
 * report directory with no page is returned with `bytes: null`: the caller
 * decides, and cannot mistake an absent page for a small one.
 */
export async function reportPageHtmlSizes(directory) {
  const reportsDir = path.join(directory, "reports");
  const pages = [];
  for (const entry of await readdir(reportsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let bytes = null;
    try {
      bytes = (await stat(path.join(reportsDir, entry.name, "index.html"))).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    pages.push({ id: entry.name, bytes });
  }
  return pages.sort((a, b) => (b.bytes ?? Infinity) - (a.bytes ?? Infinity) || (a.id < b.id ? -1 : 1));
}
