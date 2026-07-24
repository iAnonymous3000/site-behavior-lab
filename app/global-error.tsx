"use client";

import { AlertTriangle, FlaskConical } from "lucide-react";
import { staticAssetPath } from "./client-runtime";
import "./globals.css";

/**
 * Last-resort boundary for a failure inside the root layout itself, where
 * `app/error.tsx` can no longer render because its own layout never mounted.
 * Next replaces the whole document here, so this file owns `<html>`/`<body>`
 * and cannot rely on the layout's language attribute, theme script, or shell.
 *
 * Recovery links go through `staticAssetPath` so they stay correct under a
 * base-path deployment; that helper only reads build-time inlined constants,
 * so it cannot itself be a casualty of whatever broke the layout.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="app-shell route-state-shell">
          <section className="side-card route-state-card" role="alert" aria-labelledby="global-error-title">
            <div className="brand-mark" aria-hidden="true">
              <FlaskConical size={22} />
            </div>
            <AlertTriangle size={32} aria-hidden="true" />
            <p className="eyebrow">Site Behavior Lab could not load</p>
            <h1 id="global-error-title">The page failed before it could be displayed.</h1>
            <p>
              Retry once. If the page still fails, the evidence library is unaffected: every published report stays
              readable from the public directory.
            </p>
            <div className="route-state-actions">
              <button className="primary-button" type="button" onClick={reset}>Retry</button>
              <a className="secondary-button" href={staticAssetPath("/")}>Scanner home</a>
              <a className="ghost-button" href={staticAssetPath("/directory/")}>Browse reports</a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
