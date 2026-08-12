import Link from "next/link";
import { SITE_TRUST_LINKS, SOURCE_REPOSITORY_URL } from "@/lib/site-navigation";
import { ThemeToggle } from "./theme-toggle";

/**
 * Public trust surfaces kept together so policy pages do not drift, plus the theme
 * control. The toggle previously existed on the home and report shells only, so a reader
 * arriving from a search result on any library or policy page (all of which are indexed,
 * with /sites/* at the highest sitemap priority) could not change theme at all.
 */
export function TrustLinks() {
  return (
    <div className="trust-links-row">
      <nav className="trust-links" aria-label="Project trust and transparency">
        {SITE_TRUST_LINKS.map((link) => (
          <Link key={link.href} href={link.href}>
            {link.label}
          </Link>
        ))}
        <a href={SOURCE_REPOSITORY_URL}>Source</a>
      </nav>
      <ThemeToggle />
    </div>
  );
}
