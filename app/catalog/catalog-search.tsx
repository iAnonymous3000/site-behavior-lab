"use client";

import { useEffect, useMemo, useState } from "react";
import type { TrackerCatalogRecord } from "@/lib/tracker-catalog";
import styles from "./catalog.module.css";

type Props = {
  records: TrackerCatalogRecord[];
};

export function CatalogSearch({ records }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const categories = useMemo(
    () => [...new Set(records.map((record) => record.category))].sort((left, right) => left.localeCompare(right)),
    [records]
  );
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return records.filter((record) => {
      if (category !== "all" && record.category !== category) return false;
      if (!normalizedQuery) return true;
      return `${record.domain} ${record.entity} ${record.category}`.toLowerCase().includes(normalizedQuery);
    });
  }, [category, query, records]);

  const countSummary = `Showing ${visible.length} of ${records.length} maintainer-reviewed domain mappings.`;

  // The count changes on every keystroke, and polite announcements queue rather
  // than replace, so announcing it live turned an eleven-character search into
  // eleven announcements still playing after typing stopped. Sighted users keep
  // the instant count; the announced copy waits for a pause. Same treatment the
  // gallery's search already carries.
  const [announcedCount, setAnnouncedCount] = useState(countSummary);
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncedCount(countSummary), 600);
    return () => window.clearTimeout(timer);
  }, [countSummary]);

  return (
    <div>
      <div className={styles.controls} role="search" aria-label="Search the known-service catalog">
        <label>
          <span>Search services and domains</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Try Google, analytics, or doubleclick.net"
          />
        </label>
        <label>
          <span>Functional label</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">All labels</option>
            {categories.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>

      <p className={styles.resultCount}>
        {countSummary}
        <span className="visually-hidden" role="status" aria-live="polite">
          {announcedCount}
        </span>
      </p>

      {visible.length > 0 ? (
        <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Known-service catalog results">
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col">Named service</th>
                <th scope="col">Functional label</th>
                <th scope="col">Review</th>
                <th scope="col">Entity reference</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((record) => (
                <tr key={record.domain}>
                  <td><code>{record.domain}</code></td>
                  <td>{record.entity}</td>
                  <td>{record.category}</td>
                  <td>
                    <span>{record.provenance.reviewedAt}</span>
                    <small>{record.provenance.reviewer}</small>
                  </td>
                  <td>
                    {record.provenance.entityReferences.map((reference) => (
                      <a key={reference.url} href={reference.url} rel="noreferrer">{reference.title}</a>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.empty}>No catalog record matches those filters.</p>
      )}
    </div>
  );
}
