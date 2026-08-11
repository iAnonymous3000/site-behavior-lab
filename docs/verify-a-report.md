# Verify a committed report independently

This walks a third party, with no trust in the operator, from a committed
report's bytes back to a Sigstore-attested CI run at an exact git SHA. It
documents the chain that already exists; it does not add one. Read the
boundaries section first so you know what the chain does and does not prove.

## Start here: one command

Most of what follows is automated. From a clone of this repository:

```bash
npm run verify:report -- 20260803-8850a5695425835ae562ece2431a2de6
```

It fetches the report and its provenance sidecar from the live site, checks the
bytes against the digest published in `reports/index.json`, recomputes the
canonical digest and compares it with the sidecar, and runs the same managed
reader the site itself uses. It exits non-zero if any check fails, and prints
what it did not prove.

Those checks all read from one origin, so on their own they prove consistency
rather than provenance. The command therefore adds one check that does not:
it cross-checks the report's wire digest against the append-only transparency
log committed in your clone, recomputing that chain from the log file alone.
When the chain cannot vouch for an id, the verdict downgrades from `Verified`
to `Consistent` and says provenance is not established, rather than passing
quietly.

Pass a full report URL instead of an id if that is what you have. Add
`--from <dir>` to verify local files, or `--origin <url>` to verify another
deployment.

That command covers step 1 below, plus the transparency-log cross-check, and
adds the schema and redaction checks. It does **not** cover steps 2 to 4: it
never downloads or reads the CI evidence manifest, and it says so in its own
closing output. Those steps need the `gh` CLI and verify a different thing:
not that the bytes are self-consistent, but that a specific CI run at a
specific commit produced them.

## What is covered

Committed corpus reports: every `<id>.json` and `<id>.provenance.json` under
[`public/reports/`](../public/reports). These are the reports the gallery,
directory, and corpus statistics are built from. Each is copied byte-identically
into the static export, and the `Record exact-SHA static build evidence` step
(inside the required `Typecheck, Unit Tests, Build` CI job)
hashes every file of that export into a single evidence manifest
(`site-behavior-lab-static-release-evidence.json`). A separate CI job
(`Attest exact-SHA evidence manifests`) that never checks out or executes
candidate code then creates a GitHub artifact attestation (Sigstore) whose
subject is that manifest, per main-branch SHA.

So the chain is:

```
report bytes -> sha256 in the evidence manifest -> manifest attested (Sigstore)
            -> attestation names the exact repo, workflow, and git SHA
```

## Steps

1. Fetch the report bytes and compute their digest. Either from the live site
   or from the repo at the SHA you are verifying:

```bash
curl -sO https://sitebehavior.org/reports/<id>.json
shasum -a 256 <id>.json
```

2. Download the evidence manifest for the SHA. CI uploads it as the artifact
   `exact-sha-static-evidence-<sha>` (90-day retention; for tagged releases the
   receipt is archived permanently under `docs/release-receipts/<version>/`):

```bash
gh run list --repo iAnonymous3000/site-behavior-lab --branch main --workflow CI \
  --json databaseId,headSha --jq '.[] | select(.headSha=="<sha>") | .databaseId'
gh run download <run-id> --repo iAnonymous3000/site-behavior-lab \
  --name exact-sha-static-evidence-<sha>
```

3. Verify the manifest's attestation. This checks the Sigstore signature
   against GitHub's transparency infrastructure and prints the repository,
   workflow path, and commit that produced it:

```bash
gh attestation verify site-behavior-lab-static-release-evidence.json \
  --repo iAnonymous3000/site-behavior-lab
```

4. Confirm your report's digest appears in the manifest at its path:

```bash
python3 - <<'EOF'
import json
m = json.load(open("site-behavior-lab-static-release-evidence.json"))
want = "reports/<id>.json"
for artifact in m["artifacts"]:
    for f in artifact["files"]:
        if f["path"].endswith(want):
            print(artifact["name"], f["path"], f["sha256"])
EOF
```

The manifest holds one entry per built artifact, each with its own `files`
list, so the lookup iterates `artifacts` rather than reading a top-level
`files` key. Confirm the printed `sha256` equals the digest from step 1.

If the digest from step 1 matches step 4 and step 3 verified, the report bytes
are exactly what a green CI run at that public git SHA built, and the git
history (protected by the active `Protect main history` ruleset) shows when
they entered the corpus and every change since.

## A printed copy

Any report page prints. The print carries the evidence, the standing scope
caveat, the approved use boundary, and a footer with the exact wire SHA-256 of
the bytes it renders, plus the command above. It states in its own first
sentence that it is a rendering and that the JSON wire is canonical, because a
printed page is where evidence most easily detaches from its provenance.

On the static site, which is where committed reports are served, a printed copy
does not carry: interactive controls, the request-log filters, and any evidence
the reader never expanded. Disclosures that were
already rendered print open, but the interactive evidence explorer mounts on
demand, so a print taken without opening it carries the summary and the receipt
rather than the request rows. The page says so on the paper. For a printed
comparison report, the arm shown is named explicitly, since the tables render
one arm and paper cannot switch.

The scanner container additionally serves a complete printable rendering at
`/reports/<id>/print`, linked from the report's evidence receipt as "Printable
version". It server-renders every disclosure and raises the row caps, so the
limitation above does not apply to it. That route is container-only and does not
exist on the static site.

If you intend to keep a copy, read [evidence-custody.md](evidence-custody.md)
first: the paper is a rendering, and the bytes are the artefact.

## Boundaries: what this does NOT prove

State these honestly when citing a report; an opposing expert will otherwise
state them for you.

- **Ephemeral share reports are not covered.** A report saved from a live scan
  (an R2 share link) carries a provenance sidecar and a public digest
  internally, but no external anchor: it expires on its retention schedule and
  nothing outside the operator's storage attests its bytes today. For anything
  that matters, use or request a committed report, and save the bytes plus
  their digest yourself the moment you rely on them.
- **A log entry outlives the report it names.** The transparency log is
  append-only and report bundles are pruned on the corpus retention policy, so
  the log always holds some ids whose bundles are no longer published (eleven
  of 676 entries as of 2026-08-11, from the ordinary pruner). That count moves
  with every prune, so re-derive it rather than trusting this sentence:

```bash
jq -r '.entries[].reportId' public/transparency-log.json | while read -r id; do
  [ -f "public/reports/$id.json" ] || echo "$id"
done
```

  A logged id that returns 404 was pruned, not withdrawn; a withdrawal appears
  in `public/corrections.json` instead. Log membership is evidence that a
  report was published, never that it still is.
- **Anchors cover a prefix of the log, not all of it.** An OpenTimestamps anchor
  bounds only the entries beneath the head it names. Entries published after the
  newest anchor have no external time bound until the next weekly anchoring run
  (`.github/workflows/anchor-transparency-log.yml`), and CI holds that gap under
  a declared ceiling rather than assuming it is zero.
- **The chain proves the bytes, not the visit.** The attestation shows CI built
  these bytes at this SHA. For CI-lane scans the same run performed the visit;
  the receipt states which lane produced it. It does not independently prove
  what the scanned site served, and cannot: the site's response to one visit is
  not reproducible by anyone, including us.
- **Timestamps inside a report are operator-clock claims.** A committed
  report's `createdAt` is bounded above by its attestation's creation time (a
  third-party clock) and by the git commit that introduced it, but the
  recorded times inside the report come from the scanner's own clock.
  Independently of both, the transparency log's chain heads are anchored
  through OpenTimestamps: once an anchor carries its Bitcoin attestation,
  every log entry beneath that head provably existed before the block that
  confirms it, on a clock nobody involved controls. Extract and check an
  anchor with the standard tooling:

```bash
jq -r '.anchors[0].proof' public/transparency-log.json | base64 -d > head.ots
ots upgrade head.ots
ots verify -d "$(jq -r '.anchors[0].head' public/transparency-log.json)" head.ots
```

  The `-d` form is required because the proof anchors a digest rather than a
  file on disk; a bare `ots verify head.ots` looks for a file named `head` and
  fails. The final block-header check needs a local Bitcoin node; without one,
  `ots info head.ots` prints the complete operation tree and attestations.
  Both commands were exercised against the committed anchors with the
  reference client (opentimestamps-client 0.7.2).

  A fresh anchor is a calendar's signed promise until the aggregation window
  closes (typically hours); `npm run transparency:log:anchor:status` reports
  which state each committed anchor is in, and never claims more than the
  proof carries.
- **Production container scans are attested at build, not at scan time.** The
  deployed scanner's image is built from the promoted SHA, and
  production-health checks the live deployment's self-reported SHA hourly, but
  no per-scan record binds an individual live scan to an attested image digest.
  That binding is future evidence-package work (`docs/evidence-package.md`),
  not something to assert today.
