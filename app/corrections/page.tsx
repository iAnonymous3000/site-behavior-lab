import Link from "next/link";
import corrections from "@/public/corrections.json";
import { parseCorrectionsLedger, type CorrectionsLedgerEvent } from "@/lib/corrections-ledger";
import { publicPageMetadata } from "@/lib/seo-metadata";
import { sitePagesBasePath } from "@/lib/site-url";
import { SiteChrome } from "../_components/site-chrome";

export const dynamic = "force-static";

export const metadata = publicPageMetadata({
  title: "Evidence corrections and disputes",
  description:
    "How to report an evidence problem, how Site Behavior Lab reviews it, and the public append-only corrections ledger.",
  path: "/corrections/"
});

const EVIDENCE_ISSUE_URL = "https://github.com/iAnonymous3000/site-behavior-lab/issues/new?template=evidence-problem.yml";
const PRIVATE_REPORT_URL = "https://github.com/iAnonymous3000/site-behavior-lab/security/advisories/new";
const ledger = parseCorrectionsLedger(corrections);

export default function CorrectionsPage() {
  return (
    <SiteChrome>
      <div className="legal-page">
      <header className="legal-header">
        <p className="eyebrow">Corrections</p>
        <h1>Challenge the evidence, with a public record</h1>
        <p>
          A report is one controlled observation, not a verdict. If its artifact, label, explanation, or methodology
          disclosure is wrong, report the exact problem. Confirmed corrections are appended to a public ledger; the
          original artifact is not silently rewritten.
        </p>
        <p className="status-actions">
          <a className="primary-button" href={EVIDENCE_ISSUE_URL}>Report an evidence problem</a>
          <a href={sitePagesBasePath() + "/corrections.json"}>Download the corrections ledger</a>
        </p>
      </header>

      <section className="legal-section">
        <h2>What happens after a report</h2>
        <ol>
          <li>We pin the questioned report against automated retention and identify its report ID, source revision, scan time, and methodology.</li>
          <li>We reproduce the claim from the stored evidence and separate an artifact defect from ordinary visit-to-visit variation.</li>
          <li>We publish the result as active, corrected, superseded, or withdrawn, with a plain-language reason and supporting link.</li>
          <li>Any replacement report receives a new identity and is pinned too; publication requires every referenced static report and provenance receipt to remain available.</li>
        </ol>
      </section>

      <section className="legal-section">
        <h2>Current ledger</h2>
        <p>
          {ledger.entries.length === 0
            ? "No correction events have been published. An empty ledger is not a claim that every report is flawless; it means no reviewed event has yet been recorded."
            : ledger.entries.length.toLocaleString() + " correction events are currently published."}
        </p>
        <p>
          The machine-readable ledger follows its{" "}
          <a href={sitePagesBasePath() + "/corrections.schema.json"}>versioned JSON Schema</a>.
        </p>
        {ledger.entries.length > 0 && (
          <div className="correction-ledger" aria-label="Published correction events">
            {[...ledger.entries].reverse().map((event) => <CorrectionEvent event={event} key={event.eventId} />)}
          </div>
        )}
      </section>

      <section className="legal-section">
        <h2>Keep sensitive reports private</h2>
        <p>
          Do not put a vulnerability, personal data, access token, or unredacted sensitive URL into a public evidence
          issue. Use the <a href={PRIVATE_REPORT_URL}>private security reporting channel</a> instead.
        </p>
      </section>

    </div>
    </SiteChrome>
  );
}

function CorrectionEvent({ event }: { event: CorrectionsLedgerEvent }) {
  return (
    <article className={`correction-event state-${event.state}`}>
      <div className="correction-event-heading">
        <div>
          <p className="eyebrow">{event.eventId}</p>
          <h3>{correctionStateLabel(event.state)}</h3>
        </div>
        <time dateTime={event.publishedAt}>{formatPublishedAt(event.publishedAt)}</time>
      </div>
      <p>{event.summary}</p>
      <dl>
        <div>
          <dt>Questioned reports</dt>
          <dd>{event.reportIds.map((id) => <Link href={`/reports/${id}/`} key={id}><code>{id}</code></Link>)}</dd>
        </div>
        {(event.replacementReportIds?.length ?? 0) > 0 && (
          <div>
            <dt>Replacement evidence</dt>
            <dd>{event.replacementReportIds?.map((id) => <Link href={`/reports/${id}/`} key={id}><code>{id}</code></Link>)}</dd>
          </div>
        )}
      </dl>
      <p><a href={event.detailsUrl}>Read the public review record</a></p>
    </article>
  );
}

function correctionStateLabel(state: CorrectionsLedgerEvent["state"]): string {
  return state === "active"
    ? "Reviewed clarification"
    : state === "corrected"
      ? "Evidence corrected"
      : state === "superseded"
        ? "Evidence superseded"
        : "Evidence withdrawn";
}

function formatPublishedAt(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}
