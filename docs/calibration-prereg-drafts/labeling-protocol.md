# Reference labeling protocol (draft)

What a labeler asserts, from what evidence, under what blinding. One
protocol, six detectors, so every study's referenceProtocol string can point
here and the definitions cannot drift apart between studies.

## Ground rules, all detectors

- A label is a property of the RECORDED EVIDENCE for one case, not of the
  site in general. If the evidence bundle does not show it, the label is
  absent, even when the labeler privately knows the site does it on other
  days. Anything else breaks the blinding model.
- Labelers see the blinded bundle only: distinct third-party requests (host,
  path, method, count) and the per-detector evidence surfaces listed below.
  Never the detector's prediction, never another labeler's work.
- Every labeler labels every case independently and seals their full-frame
  source to the study public key BEFORE acquisition runs. The tiebreaker
  actor seals theirs the same way, used only for disagreements.
- Uncertain is not a label. The protocol's per-detector definition decides
  every case; a labeler who cannot decide from the evidence labels absent,
  because the reference claim is "the evidence shows X", not "X happened".
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

The bundle shows a consent offer: a request to a documented CMP loader host
(OneTrust, Cookiebot, Usercentrics, TrustArc, Osano, Didomi, Quantcast, or
the IAB TCF framework endpoints listed in the appendix), or the retained
banner evidence records a visible consent surface. A consent-shaped first
party dialog with no recorded CMP traffic counts only via the retained
banner evidence, never inferred from page category. Otherwise ABSENT.

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

The recorded DNS evidence shows a first-party subdomain whose CNAME chain
terminates at a documented tracking vendor (appendix list drawn from the
curated catalog's CNAME vendors), regardless of what the requests to it
contained. A chain ending at a general CDN is ABSENT. A chain that stays
within the first party is ABSENT.

### keystroke-exfiltration

Not labeled against the open web in this program. See the keystroke memo in
the README before designing anything for this detector.

## Appendix status

The endpoint and vendor lists referenced above must be frozen as part of
each study's referenceProtocol before sealing, drawn from the curated
catalog at the candidate commit so labels and catalog cannot disagree about
what a vendor is. The frame tooling emits them alongside the case files.
