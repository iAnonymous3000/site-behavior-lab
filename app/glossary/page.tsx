import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Glossary: the terms reports use",
  description:
    "Plain-language definitions of the terms Site Behavior Lab reports use: Brave Shields, Global Privacy Control, third parties, known services, provenance, fingerprinting, and more.",
  alternates: { canonical: "/glossary/" }
};

type GlossaryEntry = {
  id: string;
  term: string;
  definition: string;
};

// Every entry follows the same rule as the report copy: lead with what the
// thing does, attach the brand or acronym, and state the limits of the
// evidence. Anchor ids are stable so reports and docs can deep-link them.
const ENTRIES: GlossaryEntry[] = [
  {
    id: "brave-shields",
    term: "Brave Shields",
    definition:
      "The ad and tracker blocker built into the Brave browser. Reports run every observed request through Brave's own open-source ad-block engine (adblock-rust) with Brave's default filter lists. Only network requests are matched: cosmetic filtering, which hides page elements, is not simulated."
  },
  {
    id: "brave-would-block",
    term: "“Matched Shields filter lists”",
    definition:
      "The number of a page's requests that matched Brave's default filter lists while the page loaded normally (nothing was blocked). It is one of three distinct Shields numbers a report can carry, and they are deliberately never blended: matched requests (what the engine would target on this visit's traffic), requests the engine actually aborted in a Blocker-comparison visit with blocking active, and the total drop in third-party requests between the paired visits. The total drop is usually the largest: it can include follow-on requests that never started once their sources were blocked, plus ordinary run-to-run variance between the two visits."
  },
  {
    id: "gpc",
    term: "Global Privacy Control (GPC)",
    definition:
      "A signal the browser sends with every request asking the site not to sell or share your data. It carries legal weight in several US states, including California. The GPC diff mode visits the page with and without the signal to show whether the site actually behaves differently."
  },
  {
    id: "third-party",
    term: "Third party",
    definition:
      "Any domain other than the site you scanned and its subdomains. A third-party request is not automatically tracking: content delivery networks and embeds are third parties too. That is why reports separately label known services."
  },
  {
    id: "known-service",
    term: "Known service",
    definition:
      "A third-party domain that matched a curated catalog of recognizable advertising, analytics, social, and session-replay services. The catalog is a lower bound: a third party the catalog does not name can still track."
  },
  {
    id: "fingerprinting",
    term: "Fingerprint-like calls",
    definition:
      "Calls to browser APIs (canvas, WebGL, audio, WebRTC) that can help distinguish your device from others. Many uses are legitimate, such as charts and media, so reports count the calls, flag matched behavior patterns, and treat them as review prompts rather than proof of tracking."
  },
  {
    id: "provenance",
    term: "Provenance",
    definition:
      "The causal chain behind a request: which script started it, and which script injected that script. It answers why the page contacted a domain instead of only recording that it happened."
  },
  {
    id: "keystroke-capture",
    term: "Keystroke capture test",
    definition:
      "The scan types a synthetic sentinel value into the page's form fields (never submitting) and watches outgoing traffic for that value, including base64, hex, and hashed encodings. It covers fields on the loaded page, not flows behind logins or extra steps."
  },
  {
    id: "advertising-pixels",
    term: "Advertising pixels",
    definition:
      "Tracking pixels from platforms like Meta, TikTok, and X. Reports decode which events each pixel fired (PageView, Purchase, and so on) and whether personal-identifier fields were attached. Detection is by parameter name only; the values (which the platforms document as hashed) are never read or stored, so the hashing itself is not verified."
  },
  {
    id: "consent-diff",
    term: "Consent comparison",
    definition:
      'Two paired visits: one clicking "Accept all" on the cookie/consent banner and one clicking "Reject all" (recognized banner controls or an exact accept/reject label, first layer only). The diff shows what differed between the two visits, including tracking companies that still appeared in the Reject-all visit. The scanner dispatches the click but cannot verify the site registered the choice, and each visit records traffic from before and after its click. Banners often appear only in regions that require them, so a visit where no control was found stays pre-consent and the report says so.'
  }
];

export default function GlossaryPage() {
  return (
    <main className="legal-page">
      <header className="legal-header">
        <p className="eyebrow">Glossary</p>
        <h1>The terms reports use</h1>
        <p>
          Reports describe what one controlled visit observed, in the plainest language the evidence allows. These are
          the technical terms that still appear, each defined once here so every report can link to it.
        </p>
        <p className="legal-back">
          <Link href="/">&larr; Back to Site Behavior Lab</Link>
        </p>
      </header>

      {ENTRIES.map((entry) => (
        <section className="legal-section" key={entry.id} id={entry.id}>
          <h2>{entry.term}</h2>
          <p>{entry.definition}</p>
        </section>
      ))}
    </main>
  );
}
