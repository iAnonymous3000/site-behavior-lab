import Link from "next/link";
import { publicPageMetadata } from "@/lib/seo-metadata";
import { TrustLinks } from "../_components/trust-links";

export const dynamic = "force-static";

export const metadata = publicPageMetadata({
  title: "Privacy & data handling",
  description:
    "How Site Behavior Lab treats the URLs you scan: what leaves your browser, what is stored, how long it is kept, and what is never collected.",
  path: "/privacy/"
});

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
          own data. A URL can itself be sensitive (query strings often carry tracking ids, tokens, or email
          addresses), so here is exactly what happens to the address you type, in plain terms.
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
            <strong>The address: reduced to origin and path first.</strong> Before the request leaves your
            browser, the query string (everything after <code>?</code>) and fragment (after <code>#</code>) are
            stripped. <code>example.com/account?user=you&amp;token=abc</code> becomes{" "}
            <code>example.com/account</code>. The page in the box is updated so you can see exactly what will be
            scanned.
          </li>
          <li>
            <strong>Your scan options:</strong> the device profile (desktop or mobile), whether to send a Global
            Privacy Control signal, and which run mode: Single (one visit), or a GPC diff, Blocker, or Consent
            comparison (each comparison visits the page twice so the pair can be compared).
          </li>
          <li>
            <strong>A Cloudflare Turnstile token</strong>, used to confirm the request is not automated abuse (see
            Third parties below).
          </li>
          <li>
            <strong>A scanner access key, only on a gated deployment.</strong> If an operator requires this key, it is
            sent only to that scanner for admission, status, or cancellation. The page keeps it in memory while open;
            it is not placed in local or session storage, and a reload requires it again.
          </li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>Local PageGraph imports</h2>
        <p>
          Opening a paired PageGraph <code>.graphml</code> and <code>.meta.json</code> file is a browser-only import.
          The raw artifact bytes are read in your tab and are not sent to the scanner or stored by this service. The
          normalized local report also omits the source-artifact digest so separately shared reports cannot be linked
          back to the same raw capture by that fingerprint.
        </p>
        <p>
          Treat raw PageGraph files as sensitive before selecting or sharing them: captures can contain request
          headers, URLs, storage identifiers, or other page-controlled values. Site Behavior Lab emits only the
          privacy-reduced request evidence supported by this importer and marks cookie, storage, fingerprinting,
          detector, and consent families unsupported.
        </p>
      </section>

      <section className="legal-section">
        <h2>What the scan itself does</h2>
        <p>
          In Single mode the report contains <strong>one measured browser run</strong>; comparison modes contain{" "}
          <strong>two runs</strong>, one per compared condition. Each run records what the page did: the network
          requests it made, the cookies and storage it set, fingerprinting-style API calls, and an immediate
          screenshot <em>of the page</em> (never of you or your device). That screenshot is not saved in the share
          report. The scanned site sees traffic from the scanner&rsquo;s infrastructure, not from your IP address.
        </p>
        <p>
          A run can make additional bounded navigations. Consent verification may reload the page once after a click;
          the input probe may navigate to a blank page at the end so unload beacons fire; and policy analysis may open
          the site&rsquo;s disclosed privacy-policy page through the same SSRF guard after the main request log is frozen.
          Reload- and policy-phase requests are excluded from the main counts. Unload beacons sent by the measured page
          during the input probe remain part of the recorded evidence.
        </p>
        <p>
          When optional restart-safe execution is enabled, a scanner or coordinator failure can abandon an attempt and
          retry it once. The scanned site may therefore see an extra automated visit: it may have loaded only partly,
          or it may have completed before publication or status was lost. A finished report still uses exactly one
          completed attempt per condition; evidence from an abandoned attempt is never merged into the report.
        </p>
        <p>
          Two parts of a visit are active rather than passive, and neither involves your data: the scanner types a
          <strong> synthetic, throwaway string</strong> into a few visible form fields to test whether keystrokes are
          captured and sent off the page (it never types anything about you), and in Consent mode it clicks the
          cookie banner&rsquo;s &ldquo;Accept all&rdquo; or &ldquo;Reject all&rdquo; control. If no banner control is
          found, nothing is clicked and the report says so.
        </p>
      </section>

      <section className="legal-section">
        <h2>What is stored, and for how long</h2>
        <ul>
          <li>
            A live, user-requested scan can be saved as a shareable report so its permalink works. Before public
            report bytes are written, URL credentials, fragments, and query values are removed; non-allowlisted
            path segments become markers such as <code>{"{seg}"}</code>, non-allowlisted subdomain labels are
            generalized, and unrecognized cookie names and storage keys become redaction markers. The scanner uses
            the exact submitted address to perform the visit; it is not written into the public report. Screenshots
            can appear in the immediate result, but are not persisted in the share report.
          </li>
          <li>
            Live share reports <strong>expire after about {RETENTION_DAYS} days</strong> on the reference deployment
            (configurable by whoever runs the instance): an expired report&apos;s link stops working, any read of it
            removes the stored copy, and routine cleanup deletes expired copies that were never read again.
          </li>
          <li>
            A separate, deliberately published research corpus appears in the public directory. Those curated
            reports are versioned files with provenance sidecars and do not use the live-share expiry policy. The
            public directory describes the corpus currently retained under its own age, count, and cohort rules;
            reports cited by the corrections ledger are pinned against that automated pruning.
          </li>
          <li>
            <strong>This tab keeps a short-lived recovery pointer after a scan is accepted.</strong> Its browser
            <code> sessionStorage</code> record contains only the opaque job ID, the strict scanner-relative status
            path derived from that ID, a separate report ID, and acceptance/expiry timestamps. It never contains the
            scanned address, options, access key, Turnstile token, report, screenshot, or page evidence. The record is
            valid for at most 75 minutes and is deleted earlier after a readable result, failure, expiry,
            cancellation, or when you choose &ldquo;Dismiss recovery.&rdquo; It belongs to the current tab&rsquo;s page
            session; treat the tab as private while recovery is active because the status identifier controls polling
            and cancellation on an open-access scanner.
          </li>
          <li>
            <strong>Optional restart-safe queue state is separate from a report.</strong> This mode remains disabled
            unless the deployment explicitly enables its durable-jobs flag, supplies the application encryption key
            and private scanner-coordinator credential, and passes the live lease-expiry recovery gate. When enabled,
            the application encrypts a job record before committing it to Cloudflare Durable Object storage and
            before returning the scan&rsquo;s acceptance response. The encrypted record contains only the address&rsquo;s
            scheme, host, and path (no query string or fragment) plus the selected device and run-mode options. It is
            kept for at most 75 minutes and removed from the active database as soon as the job succeeds, fails,
            expires, or is cancelled.
          </li>
          <li>
            The encrypted queue record never contains your IP address or client hash, Turnstile or access tokens,
            authorization or other request headers, cookies, screenshots, page evidence, or scan results. Bounded
            operational metadata&mdash;opaque job and report IDs, timestamps, status and progress, attempt count, and
            lease/fencing fields&mdash;is stored separately without application encryption and contains neither the
            target address nor a client identifier. After the active encrypted record is deleted, copies of its
            ciphertext may remain temporarily in Cloudflare&rsquo;s platform recovery snapshots until Cloudflare&rsquo;s
            own backup-retention window expires; those copies remain application-encrypted.
          </li>
          <li>
            <strong>Optional encrypted scheduled rescans are separate from live share reports.</strong> When the
            post-durability feature is explicitly enabled, one single-mode scan runs immediately and then at a fixed
            seven-day cadence, for at most five scheduled attempts or 30 days. Failed pre-admission attempts still
            consume that bound. The exact query-free address and its device/GPC options are application-encrypted with
            a separate Worker-only key. The service stores an opaque watch
            ID, only a cryptographic digest of the 256-bit control capability, and bounded scheduling/run metadata;
            it does not link the watch to an IP address, client hash, account, or Turnstile token. Capability-authenticated
            metadata and deletion remain available during rollback even if the feature or decryption key is unavailable,
            while target reads and scheduled execution fail closed. Deletion prevents future runs, but a durable scan
            already admitted may still finish under the ordinary job and report-retention rules.
          </li>
          <li>No report is linked to your identity, and reports do not record your IP address.</li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>Rate limiting and abuse prevention</h2>
        <p>
          To keep the public scanner available, requests are rate-limited per client. Your IP address is used
          transiently for that limit and for the Turnstile bot check. It is not attached to stored reports and
          is not used to profile or track you across visits. The optional restart-safe job record does not copy or
          link either the IP address or its rate-limit client hash; a replay is the same admitted job, so it does not
          repeat the Turnstile check or charge the scan quota again. Scheduled rescan execution uses a small global
          daily budget rather than a stored per-IP identity.
        </p>
      </section>

      <section className="legal-section">
        <h2>Third parties</h2>
        <ul>
          <li>
            <strong>Cloudflare</strong> provides hosting, network protection, and the Turnstile check. The Turnstile
            token (and, for that check, your IP) is processed by Cloudflare under its own terms. If restart-safe jobs
            are enabled, Cloudflare also hosts the application-encrypted active queue record and may retain encrypted
            copies in platform recovery snapshots for its backup-retention window. If scheduled rescans are enabled,
            Cloudflare likewise hosts their application-encrypted target/options and non-content scheduling metadata;
            recovery snapshots can temporarily retain encrypted copies after active deletion.
          </li>
          <li>
            <strong>The site you scan</strong> receives the automated visit and may log it like any other request,
            but it receives the scanner&rsquo;s request, not your browser session or IP.
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

      <TrustLinks />
    </main>
  );
}
