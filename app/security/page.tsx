import { publicPageMetadata } from "@/lib/seo-metadata";
import { SiteChrome } from "../_components/site-chrome";

export const dynamic = "force-static";

export const metadata = publicPageMetadata({
  title: "Security and responsible disclosure",
  description: "How to report a Site Behavior Lab vulnerability privately, what is in scope, and what details help us respond.",
  path: "/security/"
});

const PRIVATE_REPORT_URL = "https://github.com/iAnonymous3000/site-behavior-lab/security/advisories/new";
const POLICY_URL = "https://github.com/iAnonymous3000/site-behavior-lab/security/policy";

export default function SecurityPage() {
  return (
    <SiteChrome>
      <div className="legal-page">
      <header className="legal-header">
        <p className="eyebrow">Security</p>
        <h1>Report vulnerabilities privately</h1>
        <p>
          Please avoid a public issue for a vulnerability or suspected data exposure. Use GitHub&apos;s private
          reporting channel so the impact can be investigated before disclosure.
        </p>
        <p className="status-actions">
          <a className="primary-button" href={PRIVATE_REPORT_URL}>Open a private security report</a>
          <a href={POLICY_URL}>Read the full security policy</a>
        </p>
      </header>

      <section className="legal-section">
        <h2>What to include</h2>
        <ul>
          <li>A concise description of the issue and the realistic impact.</li>
          <li>Reproduction steps, including the affected route, input, or target when safe to share.</li>
          <li>The affected report ID, deployment revision, or scanner version if known.</li>
          <li>Any proof-of-concept data minimized to what is necessary to verify the issue.</li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>High-priority areas</h2>
        <p>
          SSRF and network-boundary escapes, report data leakage, scanner resource exhaustion, authorization bypasses,
          and integrity failures in public evidence are especially important. The full repository policy documents the
          current safeguards and known platform boundary.
        </p>
      </section>

    </div>
    </SiteChrome>
  );
}
