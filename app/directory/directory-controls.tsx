"use client";

import { useMemo, useState } from "react";
import { normalizeDirectorySearchQuery } from "@/lib/directory-search";
import type { SiteEvidenceRow } from "@/lib/site-evidence-row";
import { displayHost, plural } from "@/lib/text-format";
import { SiteEvidenceTable } from "../_components/site-evidence-table";
import styles from "./directory.module.css";

/**
 * One search that filters the table in place.
 *
 * The page used to carry two forms above the table, each with a submit button
 * that stayed disabled until the reader had typed or chosen something: a
 * "Find a site" box that navigated to the first matching profile, and a
 * "Browse a category" select that navigated to a category page. Below them
 * sat a table with its own filter box over the same rows. A reader looking
 * for one site typed into whichever box they saw first and got a different
 * result from each.
 *
 * Now the query narrows the table the reader is looking at, the status line
 * says how many rows remain, and an exact match offers its profile as a plain
 * link. Nothing navigates on input: a change filters, only a link moves. The
 * categories are links in the page header, where a select used to be.
 */
export function DirectoryControls({ rows, caption }: { rows: SiteEvidenceRow[]; caption: string }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeDirectorySearchQuery(query);
  const exact = useMemo(
    () => (normalizedQuery ? rows.find((row) => row.domain === normalizedQuery) ?? null : null),
    [normalizedQuery, rows]
  );
  const matching = useMemo(
    () =>
      normalizedQuery
        ? rows.filter(
            (row) =>
              row.domain.includes(normalizedQuery) ||
              displayHost(row.domain).toLowerCase().includes(normalizedQuery) ||
              row.categoryLabel.toLowerCase().includes(normalizedQuery)
          ).length
        : rows.length,
    [normalizedQuery, rows]
  );

  return (
    <div className={styles.sites}>
      <div className={styles.searchForm} role="search">
        <label htmlFor="directory-search">Find a site</label>
        <div>
          <input
            autoComplete="off"
            aria-describedby="directory-search-status"
            id="directory-search"
            inputMode="url"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="example.com, or a category"
            spellCheck={false}
            type="search"
            value={query}
          />
          {exact && (
            <a className="secondary-button" href={exact.profileHref}>
              Open {displayHost(exact.domain)}
            </a>
          )}
        </div>
        <p aria-live="polite" id="directory-search-status" role="status">
          {normalizedQuery
            ? matching === 0
              ? "No scanned site matches. The table below is empty until the query changes."
              : `${plural(matching, "matching site")} in the table below.`
            : "Filters the table below by domain or category as you type."}
        </p>
      </div>
      <SiteEvidenceTable caption={caption} externalQuery={normalizedQuery} rows={rows} />
    </div>
  );
}
