import { FileQuestion, FlaskConical } from "lucide-react";
import { staticAssetPath } from "./client-runtime";

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
          scanner or browse the permanent public evidence library.
        </p>
        <div className="route-state-actions">
          <a className="primary-button" href={staticAssetPath("/")}>Scan a site</a>
          <a className="secondary-button" href={staticAssetPath("/directory/")}>Browse reports</a>
        </div>
      </section>
    </main>
  );
}
