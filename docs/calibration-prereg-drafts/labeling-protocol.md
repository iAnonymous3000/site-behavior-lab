# Reference labeling protocol (draft)

What a labeler asserts, from what evidence, under what blinding. This document
collects shared rules and detector-specific operational definitions, but each
detector plan's `referenceProtocol` is authoritative. This document must not
widen a plan's proposition or admit a reference source that its plan excludes.

## Ground rules, all detectors

- A label is a property of the preregistered reference evidence for one case,
  not of the site in general. Most detectors use a blinded bundle derived from
  the recorded visit. CNAME labelers instead produce their own independent
  browser and DNS evidence under the protocol below. A labeler never substitutes
  private knowledge about what the site did on another day.
- Labelers see only the admissible evidence declared by that detector's plan.
  They never see the detector's prediction or another labeler's work. CNAME
  labelers must not see this scanner's recorded DNS chains, CNAME prediction,
  or project tracker catalog.
- Every labeler labels every case independently and seals their full-frame
  source to the study public key BEFORE acquisition runs. The tiebreaker
  actor seals theirs the same way, used only for disagreements.
- Uncertain is not an absent label. When the detector-specific protocol cannot
  determine a reference value from its admissible evidence, the case is marked
  not determined and censored as `reference-label-uncertain`; it is never
  coerced to absent. A plan may be stricter, but not weaker, about uncertainty.
- Two to ten distinct GitHub actors label; one additional distinct actor is
  the precommitted tiebreaker. Identities become public provenance. LLM
  labelers were pilot-only; published rates require human reference labels.

## Per-detector operational definitions

### pixel-events: label PRESENT when

The bundle shows at least one request to a documented advertising-pixel
endpoint: `facebook.com/tr` (any subdomain), `analytics.tiktok.com` path
starting `/api/v2/pixel`, or `analytics.twitter.com` or `t.co` path
`/i/adsct`. Query and body content are irrelevant to the label; the endpoint
match is the definition. Otherwise ABSENT.

### consent-banner: label PRESENT when

The retained banner evidence records a consent banner or dialog rendered and
visible in the page or one of its frames at observation time. A CMP loader
request, a consent-framework endpoint, or CMP-shaped markup that never rendered
a visible control is NOT PRESENT. A visible first-party consent dialog may be
present without recorded CMP traffic; it is never inferred from page category.
Otherwise ABSENT.

This definition measures the implemented `banner-visibility@1` calibration
seam only. It does not label the broader published finding, "A consent
management platform was requested." Any rate from this protocol must name the
visible-banner proposition it measured.

### fingerprint-heuristics: label PRESENT when

The bundle shows a request to a documented session-replay or behavioral
analytics vendor endpoint (appendix list: Hotjar, FullStory, LogRocket,
Microsoft Clarity, Mouseflow, Smartlook, Inspectlet, Lucky Orange, and
peers), or the retained API-activity evidence meets a per-kind definition:
canvas readback after text write, WebGL parameter plus pixel reads, offline
audio rendering, WebRTC candidate harvesting without a call surface, or
repeated font-measurement sweeps. Otherwise ABSENT.

### privacy-policy: label PRESENT when

The bundle's link evidence shows a reachable privacy-policy destination:
same-site or approved policy host, path or label matching the policy shapes
(privacy, privacy-policy, datenschutz, confidentialite, and the localized
set in the appendix), excluding do-not-sell links and marketing pages named
privacy. Otherwise ABSENT.

### cname-uncloaking: label PRESENT when

Without using any input produced by this scanner, the labeler uses their own
browser capture of the case URL to enumerate contacted hostnames under the
site's registrable domain, excluding only the registrable apex. They resolve
each candidate's CNAME chain through a resolver they name. Label PRESENT when
at least one chain reaches a host matched by an external, publicly published
tracking-service list pinned by SHA-256 in the detector plan. Label ABSENT only
when every candidate was resolved and no chain matched that list.

If any candidate cannot be resolved, the reference is not determined and must
not be labelled absent. This scanner's recorded DNS chains and this project's
tracker catalog are inadmissible reference inputs: reusing either would reproduce
the instrument's own resolver or classification errors and misstate agreement
as accuracy. A fully resolved chain ending at a general CDN or remaining within
the first party is absent under the pinned external definition.

### keystroke-exfiltration

Not labeled against the open web in this program. See the keystroke memo in
the README before designing anything for this detector.

## Appendix status

Every endpoint, vendor, or behavioral-definition source must be frozen by
digest in the detector plan before sealing. CNAME is the explicit independence
case: its tracking-service list must be external and publicly published, and
must not be drawn from this project's curated catalog. A project-derived list
used by another detector can support rule-conformance or vendor-agreement
labeling only; it is not independent accuracy ground truth merely because it
was frozen. The frame tooling emits the plan-authorized sources alongside the
case files.
