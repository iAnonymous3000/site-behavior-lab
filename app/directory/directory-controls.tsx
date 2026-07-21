"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { normalizeDirectorySearchQuery } from "@/lib/directory-search";
import styles from "./directory.module.css";

type SearchSite = { domain: string; path: string; category: string; categoryPath: string };
type CategoryOption = { id: string; label: string; path: string; siteCount: number };

export function DirectoryControls({ sites, categories }: { sites: SearchSite[]; categories: CategoryOption[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeDirectorySearchQuery(query);
  const matches = useMemo(
    () => normalizedQuery ? sites.filter((site) => site.domain.includes(normalizedQuery)).slice(0, 8) : [],
    [normalizedQuery, sites]
  );

  function openFirstMatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const exact = sites.find((site) => site.domain === normalizedQuery);
    const destination = exact ?? matches[0];
    if (destination) window.location.assign(destination.path);
  }

  return (
    <section className={styles.controls} aria-label="Find a scanned site">
      <form className={styles.searchForm} onSubmit={openFirstMatch}>
        <label htmlFor="directory-search">Find a site</label>
        <div>
          <input
            autoComplete="off"
            id="directory-search"
            inputMode="url"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="example.com"
            spellCheck={false}
            type="search"
            value={query}
          />
          <button disabled={matches.length === 0} type="submit">Open profile</button>
        </div>
        <p aria-live="polite">
          {normalizedQuery && matches.length === 0 ? "No matching published site profile." : "Searches canonical domains across every directory page."}
        </p>
        {matches.length > 0 && (
          <ul className={styles.searchMatches}>
            {matches.map((site) => (
              <li key={site.domain}>
                <a href={site.path}>{site.domain}</a>
                <span>{site.category}</span>
              </li>
            ))}
          </ul>
        )}
      </form>
      <div className={styles.categoryControl}>
        <label htmlFor="directory-category">Browse a category</label>
        <select
          defaultValue=""
          id="directory-category"
          onChange={(event) => {
            if (event.target.value) router.push(event.target.value);
          }}
        >
          <option value="">Choose a category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.path}>
              {category.label} ({category.siteCount})
            </option>
          ))}
        </select>
        <p>Aggregate pages appear only after the evidence-quality sample floor is met.</p>
      </div>
    </section>
  );
}
