"use client";

import { AlertTriangle, FlaskConical } from "lucide-react";
import { staticAssetPath } from "./client-runtime";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="app-shell route-state-shell">
      <section className="side-card route-state-card" role="alert" aria-labelledby="route-error-title">
        <div className="brand-mark" aria-hidden="true">
          <FlaskConical size={22} />
        </div>
        <AlertTriangle size={32} aria-hidden="true" />
        <p className="eyebrow">Report could not be opened</p>
        <h1 id="route-error-title">The evidence reader hit an unexpected error.</h1>
        <p>
          Retry once. If the report is damaged or temporarily unavailable, return to the scanner or use the public
          directory to open another saved report.
        </p>
        <div className="route-state-actions">
          <button className="primary-button" type="button" onClick={reset}>Retry</button>
          <a className="secondary-button" href={staticAssetPath("/")}>Scanner home</a>
          <a className="ghost-button" href={staticAssetPath("/directory/")}>Browse reports</a>
        </div>
      </section>
    </main>
  );
}
