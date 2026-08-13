"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import styles from "./directory.module.css";

/**
 * The directory as one sortable table instead of a paginated grid of cards.
 *
 * The card grid could not answer the question a directory exists for. Every
 * card carried the site's headline sentence, and for the great majority of the
 * corpus that sentence is the same one ("... recorded N fewer third-party
 * requests in the visit configured for Brave-list blocking"), so a reader
 * scanning the page saw a hundred near-identical paragraphs and no way to
 * compare the numbers underneath them. Twenty-four sites per page over five
 * pages meant "which sites loaded the most tracking-service requests" could not
 * be answered at all without opening every page and reading by eye.
 *
 * Sorting happens in the browser over the WHOLE set, which is why the table
 * takes every row rather than a page slice: a sort that only reorders the
 * current twenty-four says "most" and means "most of these twenty-four".
 *
 * The headline is not thrown away. It moves under the domain as secondary text,
 * where it explains a row a reader has already found rather than competing with
 * the numbers for the row's first line.
 */

export type DirectoryTableRow = {
  domain: string;
  profileHref: string;
  reportHref: string;
  headline: string;
  tone: string;
  categoryLabel: string;
  reportCount: number;
  scannedAt: string;
  scannedLabel: string;
  device: string;
  kindLabel: string;
  thirdPartyRequests: number;
  trackerRequests: number;
  thirdPartyCookies: number;
  requestEvidenceComplete: boolean;
  cookieEvidenceComplete: boolean;
  capped: boolean;
};

type SortKey = "domain" | "thirdPartyRequests" | "trackerRequests" | "thirdPartyCookies" | "scannedAt";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "domain", label: "Site", numeric: false },
  { key: "thirdPartyRequests", label: "Third-party requests", numeric: true },
  { key: "trackerRequests", label: "Third-party tracking-service requests", numeric: true },
  { key: "thirdPartyCookies", label: "Third-party cookies", numeric: true },
  { key: "scannedAt", label: "Latest visit", numeric: false }
];

export function DirectoryTable({ rows }: { rows: DirectoryTableRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: "domain",
    descending: false
  });
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? rows.filter(
          (row) =>
            row.domain.toLowerCase().includes(needle) ||
            row.categoryLabel.toLowerCase().includes(needle)
        )
      : rows;
    const direction = sort.descending ? -1 : 1;
    return [...filtered].sort((left, right) => {
      if (sort.key === "domain") return direction * left.domain.localeCompare(right.domain);
      if (sort.key === "scannedAt") {
        return direction * (Date.parse(left.scannedAt) - Date.parse(right.scannedAt));
      }
      // A count that was never measured must not sort as zero, which would rank
      // "not measured" alongside a site that genuinely set none. Those rows sink
      // to the bottom of either direction instead.
      const leftMeasured = measured(left, sort.key);
      const rightMeasured = measured(right, sort.key);
      if (leftMeasured !== rightMeasured) return leftMeasured ? -1 : 1;
      return (
        direction * (left[sort.key] - right[sort.key]) || left.domain.localeCompare(right.domain)
      );
    });
  }, [query, rows, sort]);

  function toggle(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, descending: !current.descending }
        : // Numbers are interesting from the top; names from the start.
          { key, descending: key !== "domain" }
    );
  }

  return (
    <div className={styles.tableSection}>
      <div className={styles.tableTools}>
        <label className={styles.tableFilter}>
          <span className="visually-hidden">Filter sites by domain or category</span>
          <input
            type="search"
            placeholder="Filter by domain or category"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <p className={styles.tableCount} role="status">
          {visible.length === rows.length
            ? `${rows.length.toLocaleString()} sites`
            : `${visible.length.toLocaleString()} of ${rows.length.toLocaleString()} sites`}
        </p>
      </div>

      <div className={styles.siteTableWrap} role="region" aria-label="Scanned site profiles" tabIndex={0}>
        <table className={styles.siteTable}>
          <caption className="visually-hidden">
            One current profile per scanned site, sortable by request, tracking-service and cookie
            counts, and by the date of the latest retained visit.
          </caption>
          <thead>
            <tr>
              {COLUMNS.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    // The sort state belongs on the header, not only in the icon:
                    // it is how a screen reader reports which column orders the
                    // table and in which direction.
                    aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}
                    className={column.numeric ? styles.numericColumn : undefined}
                  >
                    <button type="button" onClick={() => toggle(column.key)}>
                      {column.label}
                      {active ? (
                        sort.descending ? (
                          <ArrowDown size={13} aria-hidden="true" />
                        ) : (
                          <ArrowUp size={13} aria-hidden="true" />
                        )
                      ) : (
                        <ChevronsUpDown size={13} aria-hidden="true" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr className={`tone-${row.tone}`} key={row.domain}>
                <th scope="row" data-label="Site">
                  <a className={styles.siteLink} href={row.profileHref}>
                    {row.domain}
                  </a>
                  <span className={styles.siteHeadline}>{row.headline}</span>
                  <span className={styles.siteMeta}>
                    {row.categoryLabel} · {row.reportCount}{" "}
                    {row.reportCount === 1 ? "report" : "reports"} ·{" "}
                    <a href={row.reportHref}>Open latest evidence</a>
                  </span>
                </th>
                <td className={styles.numericColumn} data-label="Third-party requests">
                  {!row.requestEvidenceComplete && <span className={styles.bound}>at least </span>}
                  {row.thirdPartyRequests.toLocaleString()}
                </td>
                <td className={styles.numericColumn} data-label="Third-party tracking-service requests">
                  {!row.requestEvidenceComplete && <span className={styles.bound}>at least </span>}
                  {row.trackerRequests.toLocaleString()}
                </td>
                <td className={styles.numericColumn} data-label="Third-party cookies">
                  {row.cookieEvidenceComplete ? (
                    row.thirdPartyCookies.toLocaleString()
                  ) : (
                    <span className={styles.notMeasured}>Not measured</span>
                  )}
                </td>
                <td data-label="Latest visit">
                  {row.scannedLabel}
                  <span className={styles.siteMeta}>
                    {row.kindLabel} · {row.device}
                    {!row.requestEvidenceComplete &&
                      ` · ${row.capped ? "recording capped" : "request evidence incomplete"}`}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className={styles.tableEmpty}>No scanned site matches &ldquo;{query}&rdquo;.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Whether this row's count for `key` is a real measurement.
 *
 * A withheld cookie count is carried as a zero with `cookieEvidenceComplete`
 * false, so sorting on the raw number alone would rank a site whose cookies were
 * never measured next to one that genuinely set none. The directory already
 * refuses to publish that number as a figure; it must not publish it as a rank
 * either.
 */
function measured(row: DirectoryTableRow, key: Exclude<SortKey, "domain" | "scannedAt">): boolean {
  return key === "thirdPartyCookies" ? row.cookieEvidenceComplete : row.requestEvidenceComplete;
}
