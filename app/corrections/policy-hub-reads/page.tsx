import { SiteChrome } from "@/app/_components/site-chrome";
import { publicPageMetadata } from "@/lib/seo-metadata";
import Link from "next/link";

export const dynamic = "force-static";
export const metadata = publicPageMetadata({
  title: "Privacy hubs read as the policy",
  description: "Why the policy cards of 52 committed reports that read a privacy hub as the site's policy are not evidence that the policy omits a company.",
  path: "/corrections/policy-hub-reads/"
});

export default function PolicyHubReadsCorrectionPage() {
  return <SiteChrome><div className="legal-page"><section className="legal-section">
    <h1>Privacy hubs read as the policy</h1>
    <p>Correction SBL-CORR-2026-005 is a reviewed clarification for 52 committed reports. In each, the privacy-policy cross-check read a privacy hub, a page that links to the site&apos;s policy without containing it, as the policy itself. The reports and their provenance are unchanged. The <Link href="/corrections/">public ledger</Link> identifies every affected report. Two of them are redacted copies that replaced their originals for privacy under SBL-CORR-2026-004, so the ledger names those two through their originals, and the copies carry this clarification.</p>
    <h2>What the reports published</h2>
    <p>The cross-check reads the page a site&apos;s privacy link leads to and looks there for the names of the tracking companies the visit sent requests to. On five sites in the committed corpus that page is a hub: the Guardian&apos;s /info/privacy page, Discover&apos;s and Walgreens&apos; privacy centers, Capital One&apos;s privacy protections page, and Home Depot&apos;s privacy and security center. Each links to a policy it does not contain. The policy card of each of these reports lists the tracking companies whose names were not found on the hub as companies the policy does not appear to name. The 52 cards list 245 such companies, and 100 of them are named in the site&apos;s policy as published on October 18, 2026. The Guardian&apos;s October 12 report listed ten, among them The Trade Desk, LiveRamp, Criteo, Lotame and Comscore, all five named in its privacy policy.</p>
    <h2>What changed</h2>
    <p>Since policy-text-cross-check@10, the scanner withholds a read and compares none of its text when three things hold. The page&apos;s title and top-level headings name no policy, notice, statement, terms or practices. Its text holds under 3,000 characters of prose sentences. And it links to another document the scanner would read as the site&apos;s policy. Only pages written mostly in Latin script are judged. Of the five hubs, the rule withholds the Guardian&apos;s, Discover&apos;s, Capital One&apos;s and Home Depot&apos;s, and their October 19 reports publish no policy card.</p>
    <h2>What remains</h2>
    <p>A stored policy result keeps no record of the links on the page it read, so the report reader cannot tell a hub read from a policy read, and these cards still render. This clarification is the notice that applies to them. Hub reads whose card already says the cross-check was not established are not cited. Earlier clarifications of these reports still apply. Walgreens&apos; privacy center holds 7,457 characters of prose in hidden dialogs, so the scanner still reads it as the policy. Its October 19 report is cited here, and a Walgreens report recorded later can list companies the same way without being named.</p>
  </section></div></SiteChrome>;
}
