# Verify a committed report independently

This walks a third party, with no trust in the operator, from a committed
report's bytes back to a Sigstore-attested CI run at an exact git SHA. It
documents the chain that already exists; it does not add one. Read the
boundaries section first so you know what the chain does and does not prove.

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
for f in m["files"]:
    if f["path"].endswith(want):
        print(f["path"], f["sha256"])
EOF
```

If the digest from step 1 matches step 4 and step 3 verified, the report bytes
are exactly what a green CI run at that public git SHA built, and the git
history (protected by the active `Protect main history` ruleset) shows when
they entered the corpus and every change since.

## Boundaries: what this does NOT prove

State these honestly when citing a report; an opposing expert will otherwise
state them for you.

- **Ephemeral share reports are not covered.** A report saved from a live scan
  (an R2 share link) carries a provenance sidecar and a public digest
  internally, but no external anchor: it expires on its retention schedule and
  nothing outside the operator's storage attests its bytes today. For anything
  that matters, use or request a committed report, and save the bytes plus
  their digest yourself the moment you rely on them.
- **The chain proves the bytes, not the visit.** The attestation shows CI built
  these bytes at this SHA. For CI-lane scans the same run performed the visit;
  the receipt states which lane produced it. It does not independently prove
  what the scanned site served, and cannot: the site's response to one visit is
  not reproducible by anyone, including us.
- **Timestamps are operator-clock claims.** A committed report's `createdAt`
  is bounded above by its attestation's creation time (a third-party clock) and
  by the git commit that introduced it, but the recorded times inside the
  report come from the scanner's own clock.
- **Production container scans are attested at build, not at scan time.** The
  deployed scanner's image is built from the promoted SHA, and
  production-health checks the live deployment's self-reported SHA hourly, but
  no per-scan record binds an individual live scan to an attested image digest.
  That binding is future evidence-package work (`docs/evidence-package.md`),
  not something to assert today.
