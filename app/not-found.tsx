import type { Metadata } from "next";
import { FileQuestion, FlaskConical } from "lucide-react";
import { staticAssetPath } from "./client-runtime";

// Without this the 404 inherits the root layout, so a dead report permalink produced a
// tab title, bookmark, history entry, and social card that all claimed to be the scanner
// home page while the body said the report was missing. Report links are the product's
// main shared artifact, so expired ones are routine rather than an edge case.
export const metadata: Metadata = {
  title: "Report or page not available",
  description:
    "This link is incomplete, expired, or points to a report that was not published. Browse the retained public evidence library instead.",
  robots: { index: false, follow: true },
  openGraph: {
    title: "Report or page not available · Site Behavior Lab",
    description: "This link is incomplete, expired, or points to a report that was not published."
  }
};

export default function NotFound() {
  return (
    <main className="app-shell route-state-shell">
      <section className="side-card route-state-card" aria-labelledby="not-found-title">
        <div className="brand-mark" aria-hidden="true">
          <FlaskConical size={22} />
        </div>
        <FileQuestion size={32} aria-hidden="true" />
        <p className="eyebrow">Evidence not found</p>
        <h1 id="not-found-title">This report or page is not available.</h1>
        <p>
          The link may be incomplete, expired, or point to a report that was not published. You can return to the
          scanner or browse the currently retained public evidence library.
        </p>
        <div className="route-state-actions">
          <a className="primary-button" href={staticAssetPath("/")}>Scan a site</a>
          <a className="secondary-button" href={staticAssetPath("/directory/")}>Browse reports</a>
        </div>
      </section>
    </main>
  );
}
