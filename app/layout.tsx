import type { Metadata } from "next";
import { serializeJsonLd } from "@/lib/jsonld-script";
import { SITE_TITLE_SUFFIX } from "@/lib/seo-metadata";
import { siteBaseUrl, siteUrl } from "@/lib/site-url";
import "./globals.css";

const BRAND = "Site Behavior Lab";
const HOME_TITLE = "Website privacy scanner and evidence library";
const HOME_PAGE_TITLE = `${HOME_TITLE}${SITE_TITLE_SUFFIX}`;
const DESCRIPTION =
  "Scan a website to see third-party requests, service-catalog matches, cookie records, privacy signals, and browser behavior observed during one controlled visit.";
const STATIC_EXPORT = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";

// Resolve canonical and social-card URLs against one validated origin.
// Development can use the explicit localhost fallback; production builds fail
// closed when the public HTTPS origin is absent or invalid.
export const metadata: Metadata = {
  metadataBase: new URL(`${siteBaseUrl()}/`),
  title: {
    default: HOME_PAGE_TITLE,
    template: `%s${SITE_TITLE_SUFFIX}`
  },
  description: DESCRIPTION,
  applicationName: BRAND,
  alternates: {
    canonical: siteUrl("/")
  },
  openGraph: {
    title: HOME_PAGE_TITLE,
    description: DESCRIPTION,
    siteName: BRAND,
    type: "website",
    url: siteUrl("/")
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_PAGE_TITLE,
    description: DESCRIPTION
  },
  // The container hostname is an execution origin, not a second public copy
  // of the evidence library. Static Pages output is the indexable surface.
  robots: STATIC_EXPORT
    ? { index: true, follow: true }
    : { index: false, follow: false, noarchive: true }
};

// Set the theme before first paint to avoid a flash of the wrong colour scheme.
const themeScript = `(function(){try{var t=localStorage.getItem('sbl-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t}}catch(e){}})();`;

// Sitewide structured data. Identifies the app to search engines and supports
// richer results; report pages add their own per-report Dataset JSON-LD.
const structuredData = [
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: BRAND,
    url: siteUrl("/"),
    description: DESCRIPTION
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: BRAND,
    applicationCategory: "SecurityApplication",
    operatingSystem: "Web",
    url: siteUrl("/"),
    description: DESCRIPTION,
    isAccessibleForFree: true,
    license: "https://www.gnu.org/licenses/agpl-3.0.html"
  }
];

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
