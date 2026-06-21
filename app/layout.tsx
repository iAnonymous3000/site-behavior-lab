import type { Metadata } from "next";
import { siteOrigin } from "@/lib/site-url";
import "./globals.css";

const TITLE = "Site Behavior Lab";
const DESCRIPTION = "See what a site does, not just what it says. Reproducible, evidence-first web behavior scans.";

// Optional canonical origin (e.g. https://sitebehaviorlab.org). When set, social
// cards resolve to absolute URLs, which X and other unfurlers prefer.
const siteUrl = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL?.trim();

export const metadata: Metadata = {
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  title: {
    default: TITLE,
    template: "%s · Site Behavior Lab"
  },
  description: DESCRIPTION,
  applicationName: TITLE,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: TITLE,
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION
  }
};

// Set the theme before first paint to avoid a flash of the wrong colour scheme.
const themeScript = `(function(){try{var t=localStorage.getItem('sbl-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t}}catch(e){}})();`;

// Sitewide structured data. Identifies the app to search engines and supports
// richer results; report pages add their own per-report Dataset JSON-LD.
const structuredData = [
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: TITLE,
    url: siteOrigin(),
    description: DESCRIPTION
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: TITLE,
    applicationCategory: "SecurityApplication",
    operatingSystem: "Web",
    url: siteOrigin(),
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
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
