import Link from "next/link";
import { CLAIM_BOUNDARY, claimBoundaryParagraph } from "@/lib/claim-boundary";
import { publicPageMetadata } from "@/lib/seo-metadata";
import { SiteChrome } from "../_components/site-chrome";

export const dynamic = "force-static";

export const metadata = publicPageMetadata({
  title: "About: what this site is and why it exists",
  description:
    "Site Behavior Lab records what websites actually do when you visit them, and publishes the evidence rather than a score. What the project is for, what it contains, how it works in plain terms, and who is responsible.",
  path: "/about/"
});

const SOURCE_URL = "https://github.com/iAnonymous3000/site-behavior-lab";
const AUTHOR_URL = "https://github.com/iAnonymous3000";

/**
 * The plain-language entry point.
 *
 * Everything on this page is either a link to a surface that already exists or
 * a statement the rest of the site can be held to. The claim boundary comes
 * from lib/claim-boundary.ts rather than being restated here, so this page
 * cannot drift from the approved decision the reports themselves render.
 *
 * Deliberately not a second methodology page: /methodology/ owns the precise
 * definitions, and this one earns its place only by being shorter and answering
 * "what is this and why should I trust it" for someone who has never heard of
 * the project.
 */
export default function AboutPage() {
  return (
    <SiteChrome>
      <div className="legal-page">
      <header className="legal-header">
          <p className="eyebrow">About</p>
          <h1>See what a site does, not just what it says.</h1>
          <p>
          Site Behavior Lab uses a controlled browser to visit a public website, records bounded evidence from
          that visit, and publishes the record. Not a rating. Not a grade. The observations themselves, with
          enough detail that you can check them.
          </p>
      </header>

      <section className="legal-section" aria-labelledby="problem">
          <h2 id="problem">The problem</h2>
          <p>
          A privacy policy describes what a company says it does. It is written by that company, in language
          it chose, and it is not evidence of anything in particular. Meanwhile the page you just opened may
          have contacted dozens of other companies before you finished reading the first sentence, and there
          is no ordinary way to see that.
          </p>
          <p>
          Tools that try to close this gap usually hand you a letter grade or a score out of a hundred. That
          is worse than it looks. A score compresses hundreds of observations into one number using weights
          nobody published, so you cannot tell whether a bad grade means the site is hostile or just uses a
          common analytics tool. You cannot check it, argue with it, or cite it. You either trust the scorer
          or you do not.
          </p>
          <p>Three things follow from that, and they are the problems this project is interested in:</p>
          <ul>
          <li>
          <strong>Invisibility.</strong> What a site loads is observable, but not by the person visiting it.
          </li>
          <li>
          <strong>Unfalsifiability.</strong> A score cannot be wrong in any useful sense, because there is
          nothing to check it against.
          </li>
          <li>
          <strong>Impermanence.</strong> Sites change. A claim about one made last year is worth little
          without a dated record of what was seen and how.
          </li>
          </ul>
      </section>

      <section className="legal-section" aria-labelledby="goals">
          <h2 id="goals">What this site is trying to do</h2>
          <p>
          The goal is to make site behavior <em>checkable</em>. Every design decision here follows from that,
          and each one addresses a specific problem above.
          </p>
          <ul>
          <li>
          <strong>Report observations, not verdicts.</strong> A report says a request was made to a
          particular domain, that a cookie was set, that a script called a particular browser API. Where
          the site interprets those facts, it says so and shows the facts underneath.
          </li>
          <li>
          <strong>State the conditions.</strong> Current Node reports record the browser and scanner versions,
          viewport, timezone, locale, privacy signals and tracker catalog used. Older reports may not contain
          every version field; the viewer labels those fields as not recorded instead of filling them in later.
          </li>
          <li>
          <strong>Say what was missed.</strong> If part of a visit failed, or a limit was hit, or a
          detector did not finish, the report says so rather than quietly reporting less. Silence about
          gaps is the easiest way for a measurement tool to mislead.
          </li>
          <li>
          <strong>Publish corrections.</strong> When a report turns out to be wrong, the correction is
          published against it in an append-only <Link href="/corrections/">corrections ledger</Link>{" "}
          instead of being edited away.
          </li>
          <li>
          <strong>Be inspectable.</strong> The scanner, the catalogs, the detectors and this page are
          open source under AGPL-3.0-or-later, so anyone can check whether the code does what the site
          claims.
          </li>
          </ul>
      </section>

      <section className="legal-section" aria-labelledby="contains">
          <h2 id="contains">What is here</h2>
          <ul>
          <li>
          <strong>A scanner.</strong> Enter any public URL on the <Link href="/">home page</Link> and get
          a report. You can also compare two visits: with and without a privacy signal, with and without
          ad blocking, or accepting versus rejecting a cookie banner.
          </li>
          <li>
          <strong>Reports already run for you.</strong> The{" "}
          <Link href="/directory/">directory</Link> holds scans of well-known sites grouped by what they
          are for, from banking and health to news and shopping, so you can see real evidence without
          running anything yourself.
          </li>
          <li>
          <strong>A research corpus.</strong> Those reports form a dated, versioned collection that makes
          statements like &ldquo;more third-party requests than most sites measured the same way&rdquo;
          mean something specific.
          </li>
          <li>
          <strong>Reference material.</strong> A <Link href="/glossary/">glossary</Link> in plain language,
          the <Link href="/catalog/">tracker catalog</Link> behind the labels, and the full{" "}
          <Link href="/methodology/">methodology</Link>.
          </li>
          <li>
          <strong>Accountability surfaces.</strong> The <Link href="/status/">status page</Link>,{" "}
          <Link href="/corrections/">corrections</Link>, <Link href="/privacy/">privacy</Link> and{" "}
          <Link href="/security/">security</Link> pages, plus a published transparency log recording every
          report committed to the public corpus. Share reports from live scans expire and join no log.
          </li>
          </ul>
      </section>

      <section className="legal-section" aria-labelledby="how">
          <h2 id="how">How it works, briefly</h2>
          <p>
          The <Link href="/methodology/">methodology</Link> has the precise version. This is the short one.
          </p>
          <ol>
          <li>
          <strong>A real browser opens the page.</strong> Not a simulation and not a source-code reader: a
          controlled Chromium browser on our server loads the public page under the conditions recorded in
          the report, and waits for it to settle.
          </li>
          <li>
          <strong>Bounded evidence is recorded.</strong> The scanner retains captured HTTP requests, cookies,
          top-frame storage keys and selected browser-feature calls within published limits. Reports disclose
          caps, unsupported surfaces and collection failures, so their counts are lower bounds rather than
          complete transcripts.
          </li>
          <li>
          <strong>Requests are matched against public catalogs.</strong> That turns a raw domain name into
          something readable, and separates advertising and analytics services from ordinary content.
          </li>
          <li>
          <strong>The comparison modes run the page twice.</strong> Once as a baseline, once with one
          thing changed. Reporting the difference between two visits of the same page is far more
          defensible than reporting one visit and guessing.
          </li>
          <li>
          <strong>The result is written down and fingerprinted.</strong> Each saved report gets a link, a
          machine-readable copy and a cryptographic digest. Runtime share links can expire under the ordinary
          retention policy; selected reports committed to the research corpus are retained separately.
          </li>
          </ol>
          <p>
          Two limits worth stating plainly. A scan is <em>one visit, at one moment, from one place</em> —
          sites behave differently by country, by device and by time. And the scanner observes what a page
          does, never why: it can record that a request was sent to an advertising company, not what that
          company did with it.
          </p>
      </section>

      <section className="legal-section" aria-labelledby="responsible">
          <h2 id="responsible">Who made this</h2>
          <p>
          Site Behavior Lab is an independent project built and maintained by{" "}
          <a href={AUTHOR_URL}>iAnonymous3000</a>. It is not affiliated with, sponsored by, or endorsed by
          any of the sites it scans, any browser vendor, or any company whose services appear in its
          catalogs. Work began in June 2026 and continues in the open at{" "}
          <a href={SOURCE_URL}>the source repository</a>, where every change is public.
          </p>
          <p>
          The motivation is the gap described at the top of this page. Privacy tooling asks people to trust
          a verdict, and that request is backwards: the entire point of measuring something is that others
          can check the measurement. So this project publishes evidence instead of conclusions, records the
          conditions that produced it, keeps its corrections where the mistakes were, and licenses itself
          under the AGPL so the code behind any claim can be read by whoever the claim is about. Those are
          not features added later. They are the reason it exists.
          </p>
          <p>
          If a report is wrong, say so. The{" "}
          <Link href="/corrections/">corrections page</Link> explains how, and corrections are published
          rather than quietly applied.
          </p>
      </section>

      {CLAIM_BOUNDARY && (
        <section className="legal-section" aria-labelledby="boundary">
          <h2 id="boundary">What a report is, and is not</h2>
          {/* Single-sourced from the approved decision the reports render, so
            this page cannot state a wider claim than the evidence allows. */}
          <p>Every report on this site carries the same boundary, and it is worth reading before you cite one:</p>
          <blockquote>{claimBoundaryParagraph(CLAIM_BOUNDARY)}</blockquote>
        </section>
      )}

    </div>
    </SiteChrome>
  );
}
