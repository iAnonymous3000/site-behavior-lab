import { publicPageMetadata } from "@/lib/seo-metadata";
import { loadStatusSnapshot } from "@/lib/status-snapshot-server";
import { SiteChrome } from "../_components/site-chrome";
import { LiveDeploymentStatus } from "./live-deployment-status";
import { StatusEvidence } from "./status-evidence";

export const dynamic = "force-static";

export const metadata = publicPageMetadata({
  title: "Project status and evidence freshness",
  description:
    "Public deployment health, corpus freshness, measurement-toolchain versions, and honest unknown or stale states for Site Behavior Lab.",
  path: "/status/"
});

const ACTIONS_URL = "https://github.com/iAnonymous3000/site-behavior-lab/actions";
const ISSUES_URL = "https://github.com/iAnonymous3000/site-behavior-lab/issues";

export default async function StatusPage() {
  const snapshot = await loadStatusSnapshot();

  return (
    <SiteChrome>
      <div className="legal-page status-page">
      <header className="legal-header">
        <p className="eyebrow">Status &amp; transparency</p>
        <h1>What is current, stale, or unknown</h1>
        <p>
          This page reads public deployment receipts, scanner health, and versioned repository artifacts. Missing,
          malformed, future-dated, or unreachable evidence is shown as unknown, not silently treated as healthy.
        </p>
      </header>

      <LiveDeploymentStatus />

      <StatusEvidence initial={snapshot} />

      <section className="legal-section" aria-labelledby="operations-heading">
        <p className="eyebrow">Monitoring evidence</p>
        <h2 id="operations-heading">Checks and incident visibility</h2>
        <p>
          GitHub Actions runs the production posture monitor and records delivered successes and failures. GitHub
          scheduling is best-effort, so an absent run is not proof of uptime. The browser check above verifies only the
          public endpoints it can reach now. A successful corpus or filter refresh prepares a validated proposal;
          its evidence reaches this page only after review, publication, and deployment.
        </p>
        <ul>
          <li><a href={ACTIONS_URL + "/workflows/production-health.yml"}>Production health history</a></li>
          <li><a href={ACTIONS_URL + "/workflows/scan-featured.yml"}>Featured-corpus refresh history</a></li>
          <li><a href={ACTIONS_URL + "/workflows/update-brave-lists.yml"}>Measurement-input refresh history</a></li>
          <li><a href={ISSUES_URL}>Open project issues and managed incidents</a></li>
        </ul>
      </section>

    </div>
    </SiteChrome>
  );
}
