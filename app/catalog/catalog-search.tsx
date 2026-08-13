"use client";

import { useMemo, useState } from "react";
import { useAnnouncedValue } from "../_hooks/use-announced-value";
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
  const announcedCount = useAnnouncedValue(countSummary);

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
            <caption className="visually-hidden">
              Catalogued service domains matching the current filter, with their named service,
              functional label and review status.
            </caption>
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
