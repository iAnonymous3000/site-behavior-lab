import type { Metadata } from "next";
import { siteOrigin } from "@/lib/site-url";
import "./globals.css";

const TITLE = "Site Behavior Lab";
const DESCRIPTION = "See what a site does, not just what it says. Reproducible, evidence-first web behavior scans.";

// Resolve social-card URLs against the canonical origin when
// NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL is set, else an explicit localhost
// fallback (siteOrigin handles validation). Setting it unconditionally avoids
// Next's "metadataBase is not set" warning without hardcoding any one origin.
export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
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
