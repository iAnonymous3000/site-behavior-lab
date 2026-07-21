import Link from "next/link";

const SOURCE_URL = "https://github.com/iAnonymous3000/site-behavior-lab";

/** Public trust surfaces kept together so policy pages do not drift. */
export function TrustLinks() {
  return (
    <nav className="trust-links" aria-label="Project trust and transparency">
      <Link href="/status/">Status</Link>
      <Link href="/catalog/">Catalog</Link>
      <Link href="/methodology/">Methodology</Link>
      <Link href="/privacy/">Privacy</Link>
      <Link href="/security/">Security</Link>
      <Link href="/corrections/">Corrections</Link>
      <a href={SOURCE_URL}>Source</a>
    </nav>
  );
}
