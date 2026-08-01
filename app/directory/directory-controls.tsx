"use client";

import { useMemo, useState, type FormEvent } from "react";
import { normalizeDirectorySearchQuery } from "@/lib/directory-search";
import { plural } from "@/lib/text-format";
import styles from "./directory.module.css";

type SearchSite = { domain: string; path: string; category: string; categoryPath: string };
type CategoryOption = { id: string; label: string; path: string; siteCount: number };

export function DirectoryControls({ sites, categories }: { sites: SearchSite[]; categories: CategoryOption[] }) {
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
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

  function openSelectedCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedCategory) window.location.assign(selectedCategory);
  }

  return (
    <section className={styles.controls} aria-label="Find a scanned site">
      <form className={styles.searchForm} onSubmit={openFirstMatch}>
        <label htmlFor="directory-search">Find a site</label>
        <div>
          <input
            autoComplete="off"
            aria-describedby="directory-search-status"
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
        {/* The has-matches branch used to reuse the idle sentence verbatim, so the region
            never changed and the success path was the only silent one: suggestions
            appeared and the submit button went live with nothing announced. */}
        <p aria-live="polite" id="directory-search-status" role="status">
          {matches.length > 0
            ? `${plural(matches.length, "matching site")} listed below. Enter opens the first.`
            : normalizedQuery
              ? "No matching published site profile."
              : "Searches canonical domains across every directory page."}
        </p>
        {matches.length > 0 && (
          <ul aria-label="Matching site profiles" className={styles.searchMatches}>
            {matches.map((site) => (
              <li key={site.domain}>
                <a href={site.path}>{site.domain}</a>
                <span>{site.category}</span>
              </li>
            ))}
          </ul>
        )}
      </form>
      <form className={`${styles.categoryControl} ${styles.searchForm}`} onSubmit={openSelectedCategory}>
        <label htmlFor="directory-category">Browse a category</label>
        <div>
          <select
            id="directory-category"
            onChange={(event) => setSelectedCategory(event.target.value)}
            value={selectedCategory}
          >
            <option value="">Choose a category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.path}>
                {category.label} ({category.siteCount})
              </option>
            ))}
          </select>
          <button disabled={!selectedCategory} type="submit">Browse category</button>
        </div>
        <p>Aggregate pages appear only after the evidence-quality sample floor is met.</p>
      </form>
    </section>
  );
}
