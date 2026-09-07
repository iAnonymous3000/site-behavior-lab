# Real-site report acceptance, September 6, 2026

A public Microsoft scan failed with HTTP 500 after Turnstile succeeded. The same request failed locally in the public r2 persistence path: `redaction-not-idempotent`. The browser visit completed, but its Azure Front Door service match became `{invalid-host}` at the first public boundary and disappeared at the next boundary. That changed both total and per-phase catalog counts, so the managed reader correctly refused the report.

Catalog suffixes are instrument metadata. The reviewed `azurefd.net` and `azureedge.net` entries are public suffixes rather than tenant hostnames; their exact catalog names now survive. Observed request URLs and tenant names still follow the existing policy. The normalization identity records this change, closed producer tuples retain their exact identities, and no published measurement or schema is rewritten. Catalog-wide repeated-boundary tests, forged-match negatives, and a builder-to-managed-store regression exercise the fix.

Visual review found a separate defect that structural checks missed: Reddit served a network-security block page with HTTP 200 and two requests, yet the old subject classifier called it normal. Subject validity v3 recognizes its specific denial and appeal instructions together on a sparse page. A single phrase or a normal-sized article quoting those instructions is insufficient. This is a suspected block classification, not an attempt to evade it. Historical reports retain the methodology that originally interpreted them.

The real-site fidelity driver also treated endpoint 500 responses as skipped targets, allowing enough unrelated successful sites to produce a green run. Endpoint 5xx and unreadable response bodies now fail the driver. A target's HTTP error inside a valid measurement remains a report to validate. Microsoft and Reddit are included in the regular fidelity target set.

## Acceptance scope

The local operational sweep exercised 15 URLs: Microsoft apex and www, Walmart, Example Domain, Wikipedia Privacy, EFF, GitHub, weather.gov, The Guardian, BBC News, WebMD, Home Depot, LinkedIn, Reddit, and The New York Times. It included Microsoft mobile, GPC and blocker comparisons and a BBC consent comparison: 19 cases / 22 visits, plus targeted rechecks after the subject-classifier fix.

Every case required an API report, successful persistence and reread, identical canonical evidence across those boundaries, schema/semantic acceptance, and consistent report-view/headline/findings/JSON-LD results. The sweep ran on local macOS Chromium with isolated S3-compatible test storage and normal scanner safety controls. It is not proof of Cloudflare's network behavior; production verification is separate.

Three real-scan PDF evidence bundles covered Microsoft single (226 request rows), Microsoft blocker comparison (448 rows), and BBC consent comparison (345 rows). All 1,019 references appeared once in visit order, with recorded timings and resource types. Bundled JSON matched the stored bytes, all package hashes matched, PDF source/correction digests matched, and bookmarks, reading structure and links survived. Sample cover and evidence pages were inspected visually.

These checks establish specific operational and internal-consistency properties. They do not establish detector error rates, universal site accessibility, the behavior of an ordinary human visit, or that sparse/HTTP-200 responses are always normal pages. Reddit's initial false-normal result is an explicit counterexample to treating an invariant-clean report as independently proven accurate. Coverage losses and unsuccessful visits must remain visible, and broader calibration remains separate.
