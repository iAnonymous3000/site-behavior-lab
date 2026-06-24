import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Privacy & data handling",
  description:
    "How Site Behavior Lab treats the URLs you scan: what leaves your browser, what is stored, how long it is kept, and what is never collected.",
  alternates: { canonical: "/privacy/" }
};

// Mirrors lib/report-store.ts DEFAULT_REPORT_MAX_AGE_DAYS so the copy stays
// truthful if the default ever changes here it should change there too.
const RETENTION_DAYS = 7;

export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <header className="legal-header">
        <p className="eyebrow">Privacy &amp; data handling</p>
        <h1>How your scans are handled</h1>
        <p>
          Site Behavior Lab inspects how a website behaves, so it would be a poor tool if it were careless with your
          own data. A URL can itself be sensitive &mdash; query strings often carry tracking ids, tokens, or email
          addresses &mdash; so here is exactly what happens to the address you type, in plain terms.
        </p>
        <p className="legal-back">
          <Link href="/">&larr; Back to Site Behavior Lab</Link>
        </p>
      </header>

      <section className="legal-section">
        <h2>What leaves your browser when you scan</h2>
        <p>Submitting a scan sends the following to the scanner:</p>
        <ul>
          <li>
            <strong>The address &mdash; reduced to origin and path first.</strong> Before the request leaves your
            browser, the query string (everything after <code>?</code>) and fragment (after <code>#</code>) are
            stripped. <code>example.com/account?user=you&amp;token=abc</code> becomes{" "}
            <code>example.com/account</code>. The page in the box is updated so you can see exactly what will be
            scanned.
          </li>
          <li>
            <strong>Your scan options:</strong> the device profile (desktop or mobile), whether to send a Global
            Privacy Control signal, and which run mode (single, GPC diff, or Shields comparison).
          </li>
          <li>
            <strong>A Cloudflare Turnstile token</strong>, used to confirm the request is not automated abuse (see
            Third parties below).
          </li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>What the scan itself does</h2>
        <p>
          The scanner makes <strong>one automated browser visit</strong> to the page and records what the page did:
          the network requests it made, the cookies and storage it set, fingerprinting-style API calls, and a
          screenshot <em>of the page</em> (never of you or your device). That observation is the report. The scanned
          site sees a visit from the scanner&rsquo;s infrastructure, not from your IP address.
        </p>
      </section>

      <section className="legal-section">
        <h2>What is stored, and for how long</h2>
        <ul>
          <li>
            Each scan is saved as a shareable report so its permalink works. The address stored in the report is{" "}
            <strong>origin and path only</strong> &mdash; query strings, URL credentials, and fragments are removed
            before anything is written or shared.
          </li>
          <li>
            Stored reports are <strong>automatically deleted after about {RETENTION_DAYS} days</strong> on the
            reference deployment (configurable by whoever runs the instance).
          </li>
          <li>No report is linked to your identity, and reports do not record your IP address.</li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>Rate limiting and abuse prevention</h2>
        <p>
          To keep the public scanner available, requests are rate-limited per client. Your IP address is used
          transiently for that limit and for the Turnstile bot check &mdash; it is not attached to stored reports and
          is not used to profile or track you across visits.
        </p>
      </section>

      <section className="legal-section">
        <h2>Third parties</h2>
        <ul>
          <li>
            <strong>Cloudflare</strong> provides hosting, network protection, and the Turnstile check. The Turnstile
            token (and, for that check, your IP) is processed by Cloudflare under its own terms.
          </li>
          <li>
            <strong>The site you scan</strong> receives the automated visit and may log it like any other request,
            but it receives the scanner&rsquo;s request &mdash; not your browser session or IP.
          </li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>What this site does not do</h2>
        <ul>
          <li>No accounts, sign-ups, or passwords.</li>
          <li>No advertising, analytics profiles, or cross-site tracking cookies of our own.</li>
          <li>No selling, renting, or sharing of scan data with data brokers.</li>
          <li>No storing of the query strings or fragments you remove before scanning.</li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>Open source and self-hosting</h2>
        <p>
          Site Behavior Lab is open source, so all of the above is verifiable in the code rather than taken on trust.
          Anyone running their own instance controls their own storage and retention. This statement describes the
          reference deployment&rsquo;s defaults and may be updated as the tool changes.
        </p>
      </section>
    </main>
  );
}
