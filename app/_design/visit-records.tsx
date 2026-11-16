import { SCAN_CHECKS } from "@/lib/scan-checks";

/**
 * What one controlled visit records, on the homepage's first screen.
 *
 * A server component: the homepage's server page renders it and hands the
 * element to the client page, so the block costs HTML and flight data and no
 * homepage JavaScript. On a wide screen it sits in the form's limit column
 * under the scan disclosure; on a phone it follows the form, after More
 * options (app/_design/home.css). Its closing sentence is the block's limit
 * and stays with it.
 */
export function VisitRecords() {
  return (
    <section className="method-card" aria-labelledby="method-card-title">
      <p className="eyebrow">One controlled visit records</p>
      <h2 id="method-card-title">Evidence, then interpretation</h2>
      <ul className="method-list">
        {SCAN_CHECKS.map((check) => (
          <li key={check.label}>
            <strong>{check.label}</strong>
            <span>{check.question}</span>
          </li>
        ))}
      </ul>
      <p className="method-note">
        Every report records its own conditions and which evidence families were captured, censored or
        unsupported. Signals describe one visit, not a verdict about the site.
      </p>
    </section>
  );
}
