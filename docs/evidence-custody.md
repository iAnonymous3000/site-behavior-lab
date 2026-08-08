# Keeping a report you intend to rely on

Procedural guidance for a reader who has a Site Behavior Lab report and expects
to still have it, provably unchanged, later. It says what to save and when. It
is not legal advice, and it does not tell you what a report is good for: that
is the [approved use boundary](#the-boundary-this-does-not-move), which every
report page and every printed copy now carries.

## Save these four things, at the moment you decide to rely on the report

1. **The report JSON.** From `/reports/<id>.json` on the static site, or
   `/api/reports/<id>` on the scanner. The API returns the stored wire bytes
   byte-for-byte and never re-serialises them, so the digest you compute is the
   digest the project published.
2. **Its SHA-256.** `shasum -a 256 <id>.json`. This is the number printed in the
   footer of any paper copy, and the number `reports/index.json` publishes for
   committed reports.
3. **The provenance sidecar**, `/reports/<id>.provenance.json`, for committed
   reports. It carries the canonical digest, which is a different number over a
   different serialisation and answers a different question.
4. **Where and when you fetched them.** The URL and the retrieval time, in your
   own records. Nothing in the report can establish this for you.

Then confirm the bytes are what the project published, offline, against the copy
you just saved:

```bash
npm run verify:report -- <id> --from <your-directory>
```

`--from` matters. Without it the command fetches from the live site, which
checks the project's current bytes rather than yours.

## Time-limited shares expire, and nothing outside the operator holds them

A report saved from a live scan is a share link. It carries a provenance sidecar
and a digest, but it joins no transparency log, no external anchor covers it,
and it is deleted on its retention schedule with no exemption path: the storage
bucket removes the whole prefix on its own timer regardless of any application
setting. There is no hold mechanism, and asking for one does not create one.

So for a share, step 1 is not optional and it is not deferrable. After expiry the
digest on your paper copy is the only way to authenticate a copy you kept, and
only against a copy you kept.

If the matter is adversarial, prefer a committed corpus report, or request one.

## Committed reports have a chain, and it has edges

A committed report's bytes hash into a per-commit evidence manifest that a
separate CI job attests with Sigstore, and its publication is chained into
`public/transparency-log.json`. [docs/verify-a-report.md](verify-a-report.md)
walks that chain end to end and states plainly what it does not prove.

Two limits are worth carrying into your own records rather than discovering
later:

- **A log entry outlives its report.** Entries are permanent; report bundles are
  pruned on the corpus retention policy. A logged id that now returns 404 was
  pruned, not withdrawn. A withdrawal appears in `public/corrections.json`.
- **Anchors cover a prefix, not the whole log.** An OpenTimestamps anchor bounds
  the entries beneath the head it names. Entries published after the newest
  anchor have no external time bound until the next anchoring run, and a fresh
  anchor is a calendar's promise until its Bitcoin attestation completes.

## Anchor it yourself if the matter is adversarial

Everything above is the project attesting its own bytes. Independent of that,
you can bound the time at which *you* held them, on a clock neither party
controls, by timestamping your saved digest through your own notarisation or
timestamping service. Do it when you save, not when you need it.

## Never rely on the live site staying available

Not this project's site, and not the scanned site. A report describes one visit
to a third party's website at one moment. The site can change or disappear, and
so can the report. The bytes you saved are the durable artefact; everything else
is convenience.

## The boundary this does not move

Saving bytes carefully makes a report *authentic*. It does not make it say more
than it says.

This page deliberately does not restate the approved use boundary. It is a
signed decision in `RELEASE_READINESS.json`, rendered from that single source
onto every report page, every printed copy, and the
[methodology page](https://sitebehavior.org/methodology/#trust-boundaries).
Read it there, where it cannot have drifted from the decision.

What custody discipline does not change is worth stating plainly: detector error
rates are not published in this release, so a perfectly preserved report whose
detector accuracy is unquantified is exactly as strong, and exactly as weak, as
the boundary says it is.
