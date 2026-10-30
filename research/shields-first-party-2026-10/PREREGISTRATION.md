# Brave Standard and the lab's list simulation on a site's own requests. Declared 2026-10-29

**Status: design declared, not collected.** No visit in this study has run.
The collection and analysis scripts named below must be committed beside this
file, with their SHA-256 recorded here, before the first visit. If any part of
the design changes before collection, this file records the change and the
reason first, or the study is abandoned and redeclared.

**What depends on it.** The owner decided on 2026-10-29 to disclose the
difference now (the copy change that names the Shields numbers as Site Behavior
Lab's list-based simulation) and to hold any change to the simulation itself
until this study's results have been reviewed. Nothing in this study changes the
scanner, a stored report or an identity.

## Why

The scanner checks every eligible request against all six default-enabled
entries of Brave's filter-list catalog, including requests to the page's own
site. brave-core at `c664e847` drops the matches of the default engine for a
request that is same-site with the document that made it, when Aggressive is off
and the `kBraveAdblockDefault1pBlocking` feature is off (its default)
(`components/brave_shields/content/browser/ad_block_engine_wrapper.cc:55-117`,
`components/brave_shields/core/common/features.cc:16`). Entries whose
`first_party_protections` is true load into that default engine
(`components/brave_shields/core/browser/ad_block_component_service_manager.cc:278`).
Brave's published policy says Standard applies no network-level list blocking
to first-party requests at all.

One native check (2026-10-25, Brave Stable 1.98.60, www.everydayhealth.com)
agreed with the source: in Standard mode Brave loaded the site's own `gtm.js`,
`gtag/js` and five GA4 beacons that the lab's engine would block, and in
Aggressive mode it blocked the tag-manager loader. That is one page, one build
and one day. [native-shields-differential.md](../../docs/native-shields-differential.md)
sets the bar for justifying a methodology change from receipts: repeated Stable
and Nightly runs over a preregistered roster. This file is that roster and its
rule.

| Catalog entry | `first_party_protections` | Predicted, Standard, own-site request |
|---|---|---|
| Brave Default Adblock Filters | true | skipped |
| Brave Default Privacy Filters | true | skipped |
| Brave IOS-Specific Filters | true (platforms IOS only) | never loaded on desktop |
| Brave First Party Adblock Filters | absent | applied |
| Cookie notice blocker | absent | applied |
| Mobile app promo blocker | absent | applied |

## Hypotheses

- **H1, the exemption.** In Standard mode, a same-site request whose only
  matches come from entries with `first_party_protections` true is not blocked.
- **H2, the small entries still apply.** In Standard mode, a same-site request
  matched by an entry without `first_party_protections` is blocked.
- **H3, the control.** In Aggressive mode, same-site requests matched by a
  default list are blocked, so the requests fire and Brave's lists match them.
- **H4, third parties unchanged.** Native blocks on third-party requests agree
  with the lab's engine, as in the existing differential receipts.

"Same-site" is brave-core's rule: `SameDomainOrHost(url, request_initiator,
INCLUDE_PRIVATE_REGISTRIES)`, where the initiator is the requesting document's
origin (`browser/net/url_context.cc:471-477`), not the top page.

## Roster (fixed)

The 13 sites behind the 39 reports, among the last 300 committed reports by name
(2026-09-07 to 2026-10-19), whose only Shields matches were requests to the
page's own site, plus the 2026-10-25 page as a positive control. Each is visited
at the URL below and nowhere else.

1. https://duckduckgo.com/
2. https://www.eff.org/
3. https://archive.org/
4. https://www.ietf.org/
5. https://github.com/
6. https://nodejs.org/
7. https://my.gov.au/
8. https://www.facebook.com/
9. https://www.google.com/
10. https://www.fsf.org/
11. https://www.python.org/
12. https://europa.eu/ (the corpus seed URL; its reports redact the host it
    reaches)
13. https://www.linkedin.com/
14. https://www.everydayhealth.com/ (control)

No site is added or dropped after the first visit. A site that refuses the
browser (an HTTP 401 or 403, a challenge page) is recorded as refused and stays
in the denominator of sites attempted. No challenge is solved and no user agent
is changed.

## Instruments

- **Browsers:** Brave Stable and Brave Nightly, as installed when collection
  starts (on 2026-10-29 these read 156.1.98.62 and 157.1.101.5). Each receipt
  records the version it ran. Brave Origin is not used.
- **Profiles:** one marked profile per channel. "Trackers & ads blocking" is set
  and read back through `brave://settings/shields` before each visit, never by
  launching Brave outside the runner's proxy.
- **Receipts:** the repository's native differential runner
  (`npm run shields:native-diff`), which records Brave's
  `Network.requestAdblockInfoReceived` events and the lab's engine decision for
  each correlated request.
- **Responses:** a response recorder for the page's own requests (status,
  failure reason, native event), keeping host and path only. A Standard-mode
  receipt alone cannot tell a quiet allowed request from one that never fired,
  because Brave raises no event for a dropped match.
- **Per-entry classification:** each recorded request is evaluated by the lab's
  pinned engine once per catalog entry, so every match is attributed to the
  entries that produce it.

## Procedure

For each channel, for each roster site, in roster order:

1. Standard, responses recorded (visit S1).
2. Standard, responses recorded (visit S2).
3. Aggressive, receipt and responses recorded (visit A).
4. Set back to Standard and read back.

Every visit uses a 30,000 ms dwell and a 60,000 ms timeout, the values of the
2026-10-25 check. That is 14 sites, 2 channels and 3 visits: 84 visits. A visit
that fails to load is retried once and otherwise recorded as failed.

## Outcomes and decision rule

A **qualifying request** is a request in S1 or S2 that is same-site with its
initiator, that the lab's engine would block, and whose matches all come from
entries with `first_party_protections` true. A request is **blocked** when it
carries a native block event or fails with `net::ERR_BLOCKED_BY_CLIENT`.
It is **allowed** when it receives an HTTP response or fails for any other
reason (recorded).

A qualifying request is **confirmed** when the same channel's visit A blocks a
request with the same host and path, or blocks the same-site script that loads
it (so it never starts). Unconfirmed qualifying requests are reported but do
not count toward the thresholds, because Brave's live lists can differ from the
pinned snapshot.

Per channel:

- **H1 is supported** when at least 10 confirmed qualifying requests on at least
  4 distinct sites are observed in Standard and none of them is blocked.
- **H1 is refuted** when any confirmed qualifying request is blocked in
  Standard. Each such request is listed with its matching entries and examined;
  an error in the per-entry classification found that way is reported as an
  analysis defect, not discarded.
- **Otherwise H1 is inconclusive** on that channel.
- **H2** is reported per request (blocked or allowed in Standard) and is "not
  tested" when no same-site request matches an entry without
  `first_party_protections`.
- **H3 and H4** are reported as counts: same-site blocks in A, and native
  third-party blocks that agree or disagree with the lab's engine.

**Decision.** A simulation change is proposed to the owner only when H1 is
supported on both channels and refuted on neither. The proposal then follows
brave-core for the details this study cannot test on its roster: the
initiator-based same-site rule with private registries, the three small entries
kept on for such requests unless H2 is refuted, and Aggressive forced for a
youtube.com initiator. It lands as one detector epoch, which also drops the
iOS-only entry from the desktop snapshot. Any other result is reported and the
simulation stays as it is. The owner reviews the result before any change.

## Analysis outputs

- Per channel and site: visits attempted, loaded, refused or failed; qualifying
  requests (confirmed and not); blocked and allowed counts; H2 requests.
- Every refuting request, with host and path, matching entries, the native
  event and the response.
- The browser versions, and Brave's list component versions where
  `brave://components` shows them.

## Known limits

- One region (the operator's network in the United States), one machine, and one
  day per channel.
- The runner's mandatory proxy turns off Brave's own CNAME uncloaking. Standard
  skips it for first-party requests anyway.
- The roster was chosen because the lab's reports showed only own-site matches
  there, so it is designed to find the exemption, not to estimate how common it
  is.
- A request inside a third-party frame is same-site only with its own frame's
  document. The roster may contain few such requests; the result says how many.
