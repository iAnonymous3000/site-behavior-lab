import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "How a Site Behavior Lab scan works: what the automated visit does, what is recorded, how comparisons are paired, what the Brave-list blocking simulation means, and what the reports can and cannot claim.",
  alternates: { canonical: "/methodology/" }
};

export default function MethodologyPage() {
  return (
    <main className="legal-page">
      <header className="legal-header">
        <p className="eyebrow">Methodology</p>
        <h1>How a scan works</h1>
        <p>
          Every report is built from one or two controlled, automated browser visits, and every number in it is an
          observation from those visits, not a general claim about the site. This page describes the measurement:
          what the visit does, what is recorded, and where the honest limits are. Terms are defined in the{" "}
          <Link href="/glossary/">glossary</Link>; how scan data is handled is on the{" "}
          <Link href="/privacy/">privacy page</Link>.
        </p>
        <p className="legal-back">
          <Link href="/">&larr; Back to Site Behavior Lab</Link>
        </p>
      </header>

      <section className="legal-section">
        <h2>The visit</h2>
        <p>
          The scanner loads the page in a headless Chromium browser with a fixed profile: en-US locale, UTC
          timezone, a desktop or mobile viewport, and a disclosed egress network. It does not scroll, click, or log
          in, with exactly two bounded exceptions described below. The visit ends after a capped duration, and the
          report records the scan conditions (browser version, viewport, timezone, locale, GPC state, catalog
          version, egress) so the result is reproducible for that configuration. Sites can behave differently for
          real users, regions, accounts, or network locations, so results are evidence to check, not a verdict.
        </p>
        <p>
          The scanner never disguises itself: it is an honest automated browser. Sites that block automation are
          reported as failed loads rather than being scanned through evasion, because a report gathered under a
          disguised identity would misdescribe its own conditions.
        </p>
      </section>

      <section className="legal-section">
        <h2>What is recorded</h2>
        <ul>
          <li>Network requests (URL, domain, method, resource type, status), classified first/third party.</li>
          <li>Curated service labels from a hand-maintained, US-biased catalog of recognizable services.</li>
          <li>Cookies and local/session storage keys as an end-of-visit snapshot (values redacted).</li>
          <li>
            High-entropy browser API calls and behavioral fingerprinting heuristics (canvas, WebGL, audio, WebRTC,
            listener coverage).
          </li>
          <li>Advertising-pixel events (Meta, TikTok, X) and whether their identifier fields carried values.</li>
          <li>DNS CNAME-uncloaking of first-party subdomains that alias to known trackers.</li>
          <li>A privacy-policy cross-check: the site&apos;s own policy text compared against the observed evidence.</li>
        </ul>
        <p>
          Counts are lower bounds. Activity inside Web or Service Workers and WebSocket traffic is not observed,
          storage keys are read from the top frame only, and trackers that load only after interaction or consent
          are not seen by a passive visit.
        </p>
      </section>

      <section className="legal-section">
        <h2>The two bounded interactions</h2>
        <p>
          First, the input probe: the scanner types a synthetic, non-personal test value into up to a handful of
          visible form fields, never submits, and watches whether that value leaves to a third party in plain,
          encoded, or hashed form. Second, in consent comparison mode only, the scanner clicks one accept-all or
          reject-all control on the cookie banner&apos;s first layer (known consent-platform controls first, then a
          conservative whole-label match). Every report discloses exactly what was typed into or clicked, or that
          nothing was.
        </p>
        <p>
          A consent click is <strong>dispatched, not verified</strong>: the scanner clicks the control but cannot
          assume the site registered the choice, and each visit&apos;s recording covers traffic from before and
          after its click. Report wording never attributes traffic to the choice for that reason. When the
          registered-state readback is enabled on a deployment, the scanner additionally reads the site&apos;s
          consent-platform state (and may reload the page once, disclosed in the report, with that reload&apos;s
          requests excluded from the counts) so a future report generation can distinguish a dispatched click from
          a registered choice.
        </p>
      </section>

      <section className="legal-section">
        <h2>Comparisons</h2>
        <p>
          A comparison is two sequential visits that differ in one declared condition: Global Privacy Control off
          versus on, no blocking versus Brave-list block simulation, or an accept-all versus reject-all consent
          click. The two visits run in randomized (counterbalanced) order so time-ordered site behavior cannot load
          systematically onto one arm, and each report discloses which visit ran first. Before any comparative
          wording is used, an eligibility gate checks that both visits completed, hit no recording caps, and held
          the non-compared conditions constant; ineligible pairs render as two independent visits with the reasons
          stated. Differences between two visits can still reflect timing, experiments, caching, consent state, or
          bot detection, so comparison wording stays descriptive: it reports what differed between the visits,
          never that the compared setting caused the difference.
        </p>
      </section>

      <section className="legal-section">
        <h2>The Brave-list blocking simulation</h2>
        <p>
          Blocking evidence uses Brave&apos;s own ad-block engine (the open-source adblock-rust crate compiled to
          WebAssembly) with the default-enabled Brave Shields filter lists, vendored as a pinned snapshot. Matching
          requests are aborted in this scanner&apos;s browser: a simulation of Brave&apos;s default list blocking,
          not a live Brave-browser visit. Each request is matched with its actual HTTP method against the document
          that initiated it, network rules only (no cosmetic rules). Blocked counts are a close lower-bound
          approximation of Brave&apos;s default Shields for that page load, and the report separately states
          filter-list matches, engine-blocked requests, and the total third-party reduction, which are three
          different measurements.
        </p>
      </section>

      <section className="legal-section">
        <h2>Publication and redaction</h2>
        <p>
          Reports cross a default-deny sanitizer before anything is stored or shared: query strings and fragments
          are stripped in the browser before a scan is even submitted, and stored reports keep only reviewed,
          exact literals for paths, query keys, subdomain labels, cookie names, and storage keys, generalizing
          everything else. Report warnings come from a closed scanner vocabulary, so page-controlled text cannot
          impersonate the scanner. Shared reports live behind unguessable IDs and expire; reports published into
          the public corpus are deliberately permanent evidence.
        </p>
      </section>

      <section className="legal-section">
        <h2>The corpus and percentiles</h2>
        <p>
          Findings like &quot;more third-party domains than about 90% of sites scanned so far&quot; rank a report
          against the measured public corpus: one data point per distinct site, using only fully measured visits
          (failed and recording-capped visits are excluded from the distributions). The corpus is a curated set of
          popular sites plus a diversity seed list, not a random sample of the web, and the wording says so. Site
          history pages compare a site only against its own earlier reports with a compatible method, browser,
          device, and filter snapshot; retention alone never makes two reports comparable.
        </p>
      </section>

      <section className="legal-section">
        <h2>Reproducibility</h2>
        <p>
          The scanner, catalog, eligibility gates, and report UI are open source (AGPL-3.0-or-later), every report
          embeds its scan conditions and methodology identity, and the evidence is exportable as sanitized JSON and
          CSV. The public corpus, its percentile statistics, and the researcher export are regenerated from the
          same committed report files this site renders, so the numbers cannot disagree with the evidence behind
          them.
        </p>
      </section>
    </main>
  );
}
