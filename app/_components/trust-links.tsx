import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";

const SOURCE_URL = "https://github.com/iAnonymous3000/site-behavior-lab";

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
        <Link href="/about/">About</Link>
        <Link href="/glossary/">Glossary</Link>
        <Link href="/status/">Status</Link>
        <Link href="/catalog/">Catalog</Link>
        <Link href="/methodology/">Methodology</Link>
        <Link href="/privacy/">Privacy</Link>
        <Link href="/security/">Security</Link>
        <Link href="/corrections/">Corrections</Link>
        <a href={SOURCE_URL}>Source</a>
      </nav>
      <ThemeToggle />
    </div>
  );
}
