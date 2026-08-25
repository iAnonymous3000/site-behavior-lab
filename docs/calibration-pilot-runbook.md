# CNAME prevalence-pilot runbook

The complete operator procedure for the 100-site prevalence pilot, in
order, with what refuses if a step is skipped. Study identity:

- studyId: `cname-uncloaking-2026-08-prevalence-pilot`
- detector: `cname-uncloaking`
- protocol: `independent-labeling-protocol@1`, exact bytes
  docs/calibration-prereg-drafts/labeling-protocol.md, sha256
  `d292f4608bfaf67256bfba0cfdb5e6d1f65ded98941e06c93a8cdf749e0c564f`
  (pinned inside the approved policy artifact; do not edit the file)
- pilot set: calibration/cname-uncloaking-2026-08-prevalence-pilot/pilot-set.json
  (100 cases, sha256
  `b1760d060c4022ef9bb6b34c82d1bc404c121160a9956afe1f1606cc7236b3f4`,
  bound by pilotSetSha256 inside
  universe-provenance.json in the same directory)
- shared classification definitions (from the approved artifact; every
  reviewer and the tiebreaker MUST use exactly these bytes):
  - tracker definition: AdGuard cname-trackers
    `combined_disguised_trackers_justdomains.txt` at commit
    `d2ef7cb2f6af6db657d3bd23bab21f78cb1d4771`,
    sha256 `cd0f8ab54229dced42f7613f99951be527c582ab9ef8f74a35a70c3a55d8c648`
    <https://raw.githubusercontent.com/AdguardTeam/cname-trackers/d2ef7cb2f6af6db657d3bd23bab21f78cb1d4771/data/combined_disguised_trackers_justdomains.txt>
  - public suffix list at commit
    `e8c9a2b2b2856b6449999dd0ec0d118f364ed0cd`, sha256
    `df6306ec61971424ad259757b399911f4d414486629a5a00e299a2b6c7957089`
    <https://raw.githubusercontent.com/publicsuffix/list/e8c9a2b2b2856b6449999dd0ec0d118f364ed0cd/public_suffix_list.dat>

  These two URLs are the "definition snapshots" step 4 tells the operator to
  send. They are commit-pinned, not branch tips: fetching either project's
  HEAD produces different bytes and the instrument refuses them by digest.

Every pilot CLI refuses unless RELEASE_READINESS.json carries the
named-human approval of the policy artifact (landed 2026-08-25) and the
frame matches the approved artifact's protocol digest and pins.

## 0. What each participant needs

**Reviewers: a git clone and Node, nothing else.** The frame producer, the
reference instrument, the reviewer-batch producer, and the seal CLI all run
from a bare checkout with no `npm ci` and no `dist/`, because every gate on
that path is a committed-bytes check. If one of them ever fails with "build
dist/schema", that is a defect in the tool, not a step a reviewer is
missing.

**The operator, for steps 5 to 7, works from a development checkout**
(`npm ci && npm run build:schema`): close, reveal, and sizing recompute
identity digests through the compiled canonical-JSON module, which is
deliberate. Those steps never run on a reviewer's machine.

## 1. One-use sealing keypair (operator)

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out /secure/offline/pilot-label-reveal-private.pem
openssl pkey -in /secure/offline/pilot-label-reveal-private.pem -pubout \
  -out calibration/cname-uncloaking-2026-08-prevalence-pilot/label-sealing-public-key.pem
```

Commit ONLY the public half. `.gitignore` ignores `*.pem` with a single
exception for `calibration/*/label-sealing-public-key.pem`, so the public key
commits normally and a stray private key in the same directory still cannot:
rehearsing this step is how we learned that `git add -A` had been skipping the
public key in silence. The private key never enters the repository,
any cloud sync, or any machine other than the offline reveal machine. The
keyId every tool checks is the sha256 of the public key's SPKI DER
(`calibrationLabelPublicKeyIdentity`).

## 2. The two commits, and why there are two

A frame binds `candidateCommit` into `frame-tasks.json` and into every
`tasks/<caseId>.json`. A commit that contained those files could therefore
only be named by bytes that already contain its own sha: one commit cannot
be both the input to the frame and the place the frame lives. The ceremony
has two commits, and they are not interchangeable:

- **K, the input carrier.** The commit that lands `pilot-set.json`,
  `universe-provenance.json`, and `label-sealing-public-key.pem`, and NO
  frame files. K is the identity every batch, envelope, authorization, and
  resolved artifact binds. For this pilot `candidateCommit` means K: a
  prevalence pilot has no acquisition and no frozen scanner candidate, so
  the field names the commit whose bytes the frame was derived from,
  which is the only freeze a pilot has.
- **F, the frame freeze.** The later commit that lands `frame-tasks.json`,
  `tasks/`, and `pilot-carrier.txt` (one line: K's sha). F is what
  reviewers check out. `pilot-carrier.txt` is a record of the derivation,
  never a checkout target.

Read K from `origin/main` AFTER its PR merges. This repository
rebase-merges, so the sha on your branch is not the sha that lands, and a
frame bound to a branch sha binds a commit no reviewer can fetch:

```bash
git fetch origin
git log origin/main -1 --format=%H     # K, once the key PR has merged
```

The claim that F's frame really derives from K is checked, not asserted:

```bash
npm run calibration:v4-pilot-carrier-check -- \
  --study-dir calibration/cname-uncloaking-2026-08-prevalence-pilot
```

It extracts K's tree, runs K's OWN frame producer against K's pilot set and
protocol bytes, and requires the result to equal the committed frame byte
for byte; it also requires K to carry no frame files, to have landed on
`origin/main`, and the pilot set, provenance, and key to be unchanged
since. Running the carrier's own producer, rather than reassembling its
arguments in the checker, keeps the build recipe in one place and fixes
which code the derivation claims: the code as it stood at K. CI runs the
same gate on every PR, keyed on the frame's existence, so a committed frame
with no carrier file fails rather than skipping the check.

If the gate goes red after F has merged, do not rewrite history to fix it:
main is protected, and the frame is what reviewers may already hold. Retire
that carrier, land a fresh K, rebuild the frame from it, and freeze a new F.
Nothing sealed under the retired frame may be used, because its identity is
the thing in question.

## 3. Frame-task generation (operator, from a clean checkout of K)

```bash
git fetch origin && git checkout <K>
npm run calibration:v4-frame-tasks -- build \
  --study-id cname-uncloaking-2026-08-prevalence-pilot \
  --detector cname-uncloaking \
  --candidate-commit <K> \
  --protocol-id independent-labeling-protocol@1 \
  --protocol-file docs/calibration-prereg-drafts/labeling-protocol.md \
  --cases calibration/cname-uncloaking-2026-08-prevalence-pilot/pilot-set.json \
  --output-root calibration/cname-uncloaking-2026-08-prevalence-pilot
```

Refuses while the decision is pending, if the detector were held, or if
the protocol file's digest disagrees with the approved artifact. The frame
freezes the protocol digest and the shared definition pins; `check` mode
re-verifies every task byte. Open the F PR with `frame-tasks.json`,
`tasks/`, and `pilot-carrier.txt` containing exactly K's sha and a
trailing newline; run the carrier check from step 2 before requesting
review.

## 4. Reviewer dispatch (two labelers, one blind tiebreaker)

Each reviewer works from a clean checkout of **F**, the frame-freeze
commit (the frame files exist only there; K carries the inputs). They
receive: F's sha, the two definition-snapshot URLs and digests above, and
these commands. Reviewers capture each case with THEIR OWN browser (fresh
profile, HAR export per case, named `<caseId>.har`, and nothing else in
that directory). A capture with no successful response from the
case's own registrable domain is refused by name rather than recorded as a
confident absent. That covers the three shapes which otherwise look
identical to a clean site: a subject that redirects to another registrable
domain, a navigation that failed, and a HAR from the wrong tab. Re-capture
it; if the subject genuinely moves off its own domain, report the case to
the operator rather than labeling it.

```bash
git fetch origin && git checkout <F>

# verify the shared definitions byte-for-byte before anything else
shasum -a 256 downloaded-trackers.txt downloaded-psl.dat

npm run calibration:cname-reference -- \
  --study-id cname-uncloaking-2026-08-prevalence-pilot \
  --cases calibration/cname-uncloaking-2026-08-prevalence-pilot/pilot-set.json \
  --har-dir <their-har-dir> \
  --frame-tasks calibration/cname-uncloaking-2026-08-prevalence-pilot/frame-tasks.json \
  --tracker-source downloaded-trackers.txt \
  --tracker-source-sha256 cd0f8ab54229dced42f7613f99951be527c582ab9ef8f74a35a70c3a55d8c648 \
  --public-suffix-source downloaded-psl.dat \
  --public-suffix-sha256 df6306ec61971424ad259757b399911f4d414486629a5a00e299a2b6c7957089 \
  --resolver <their-resolver-ip> --out worksheet.json

# Review the worksheet: read the recorded chains, re-run any verifyCommand
# you want to check, and record per-case decisions in decisions.json as
# [{"caseId": "...", "value": "present|absent|uncertain"}].
#
# ABSENT is the one value with a precondition, straight from the protocol
# ("Label ABSENT only when every candidate was resolved and no chain
# matched that list"): a case with an unresolved candidate, or one whose
# own chains matched the pinned list, cannot be labeled absent and the
# producer refuses by name. Downgrade to uncertain instead. If you believe
# a recorded match is itself wrong, that is a defect in the capture or the
# pinned definition, not a label: say so to the operator and re-run the
# instrument, rather than overriding the evidence in your own batch.
npm run calibration:v4-reviewer-batch -- \
  --worksheet worksheet.json \
  --frame-tasks calibration/cname-uncloaking-2026-08-prevalence-pilot/frame-tasks.json \
  --tasks-dir calibration/cname-uncloaking-2026-08-prevalence-pilot/tasks \
  --role labeler --actor <their-github-login> \
  [--decisions decisions.json] --out batch.json

npm run calibration:v4-seal-label-batch -- \
  --role labeler --actor <their-github-login> \
  --public-key calibration/cname-uncloaking-2026-08-prevalence-pilot/label-sealing-public-key.pem \
  --frame-tasks calibration/cname-uncloaking-2026-08-prevalence-pilot/frame-tasks.json \
  --tasks-dir calibration/cname-uncloaking-2026-08-prevalence-pilot/tasks \
  --input batch.json --output sealed-envelope.json
```

The tiebreaker does the same with `--role tiebreaker`, blind to the
labelers' batches (everything they see is sealed). Worksheets, HARs, and
decisions files stay PRIVATE reviewer evidence until reveal; only sealed
envelopes travel.

> **STOP. Sealing is as far as this ceremony currently runs.** Do not
> dispatch reviewers past this point, and do not promise them a commitment
> step: the hosted `Calibration Label Commitment` workflow cannot mint a
> commitment for a prevalence pilot, so steps 5 through 8 below have no
> inputs and are NOT executable as written. Verified by execution against
> the committed code:
>
> - `.github/workflows/calibration-label-batch.yml` runs
>   `npm run calibration:preflight -- --dispatch` and then
>   `scripts/calibration-label-batch-build.mjs --candidate-root <carrier>`.
>   Both call `validateCalibrationCandidateFiles`, which opens
>   `calibration/<studyId>/preregistration.json` and `frame.json`: the v3
>   candidate shape. A pilot carrier has neither by construction (it carries
>   the pilot set, the provenance, and the sealing public key), and the v4
>   frame is `frame-tasks.json` plus `tasks/`. Running it today refuses with
>   `ENOENT ... preregistration.json`.
> - Landing v3 artifacts at the carrier to satisfy it does not work either:
>   `assertCalibrationCandidateCanSatisfyRatePolicy` imposes a structural
>   floor of 200 planned cases, and this pilot is 100 by design.
> - Preflight additionally requires a verified measurement-candidate
>   binding, which a prevalence pilot has no acquisition to produce.
> - Step 5's "fetch through the authenticated fetcher" names a library
>   function (`fetchAuthenticatedCalibrationLabelCommitments`) that no
>   command wraps, and whose inputs include the same v3 candidate object.
>   Nothing produces the `<fetched-records-dir>` steps 5 and 6 both consume,
>   and that record file's schema is published nowhere.
>
> What the pilot needs before reviewers are dispatched is an authenticated
> commitment path for a v4 frame: a hosted workflow that binds the reviewer's
> own GitHub identity to their sealed envelope against `frame-tasks.json`
> rather than a v3 candidate, plus a command that writes the fetched records
> in the shape `calibration:v4-pilot-close` reads. Until that exists, a
> reviewer who follows step 4 can seal an envelope that no one can close,
> reveal, or score.

## 5. Close (operator, after all three commitments exist) - BLOCKED

The steps below are written against the intended ceremony and are kept so the
gap above is legible, but they cannot run until the commitment path exists.
Nothing in steps 5 to 8 has ever been executed against a real reviewer
commitment.

Fetch the three commitment records through the authenticated fetcher
(`fetchAuthenticatedCalibrationLabelCommitments` over the GitHub API,
which verifies run, actor, artifact, and archive bytes), write one record
file per commitment into a directory, then:

```bash
npm run calibration:v4-pilot-close -- \
  --frame-tasks calibration/cname-uncloaking-2026-08-prevalence-pilot/frame-tasks.json \
  --commitments-dir <fetched-records-dir> \
  --key-id <sha256-of-public-key-spki> \
  --out calibration/cname-uncloaking-2026-08-prevalence-pilot/pilot-labeling-authorization.json
```

The close freezes the labeling-close instant and the authorized commitment
set together, and it is the irreversible step, so it runs the same set
custody the reveal later runs: 2 through 10 distinct labelers, exactly one
blind tiebreaker, distinct actors, unique source, envelope, and ciphertext
commitments, and every commitment before the close. It recomputes each
record's envelope digest and checks each wrapper's keyId against the keyId
inside its own sealed envelope, all without the private key.

**Record filenames are load-bearing.** Records are read in lexicographic
filename order and that becomes the authorized order, so renaming a file
after the close changes the frozen set and the reveal reports it as a
substituted record. Name them once, before the close, and do not touch them
afterwards.

What the close CANNOT establish is that GitHub really ran the workflow a
record describes: only the authenticated fetcher can, which is part of the
commitment path this pilot does not yet have.
Commit the authorization via PR; the repository commit is the anchor the
reveal trusts. After it merges, labeling is closed: later commitments
self-defeat against the authorized set.

## 6. Reveal (operator, offline reveal machine)

On the machine holding the private key, from a verified checkout of the
authorization commit:

```bash
CALIBRATION_LABEL_REVEAL_PRIVATE_KEY="$(cat /secure/offline/pilot-label-reveal-private.pem)" \
npm run calibration:v4-reveal -- \
  --frame-tasks calibration/cname-uncloaking-2026-08-prevalence-pilot/frame-tasks.json \
  --tasks-dir calibration/cname-uncloaking-2026-08-prevalence-pilot/tasks \
  --authorization calibration/cname-uncloaking-2026-08-prevalence-pilot/pilot-labeling-authorization.json \
  --commitments-dir <fetched-records-dir> \
  --out-dir <reveal-out>
```

Key-free custody runs first (frame, tasks, authorization equality,
chronology, and the output destination being free); the key is read only
after all of it passes, and the key you supply must be the key the
authorization was closed under, checked by deriving its identity rather
than by trusting the artifact's own claim. Point `--out-dir` at an empty
directory: reveal writes are create-only, and a directory holding a
previous reveal is refused before the key is read rather than after every
envelope is open. Output:
resolved-labels.json (a pure projection of the assembly bridge, carrying
the authorized commitmentSetSha256) plus per-case adjudication artifacts
for tiebreaker-resolved disagreements. Commit them beside the
authorization.

## 7. Sizing and the feasibility gate

```bash
npm run calibration:v4-pilot-sizing -- \
  --resolved-labels <reveal-out>/resolved-labels.json \
  --frame-tasks calibration/cname-uncloaking-2026-08-prevalence-pilot/frame-tasks.json \
  --swept-eligible-pool <rounds-1-2 eligible count> \
  --out calibration/cname-uncloaking-2026-08-prevalence-pilot/pilot-sizing.json
```

N derives through the preregistered uncertainty envelope. The
preregistered gate (docs/reliability-sweep-cluster-design.md): at the
round-1 optimistic ceiling of 1,126, the pilot must resolve 18..82
present (necessary-only, zero-uncertain boundary). INFEASIBLE means a
larger universe and fresh sweep rounds; never a relaxed rule.

The gate is enforced, not merely printed: an INFEASIBLE determination
writes its artifact and then exits non-zero, so no later step runs on it.
`--swept-eligible-pool` is required, because a run that recorded no
determination would otherwise read exactly like a run that passed. The
claimed-class floor is NOT typed here: it comes from the approved policy
artifact's publication profile (100 for `two-class-accuracy`), and
`--minimum-per-class` is accepted only when it agrees with that pin. A
pilot whose estimate admits no frame size at all is recorded the same way,
with `derivedN: null` and the reason, rather than raised as an error: the
one outcome that stops the study is the outcome it most needs on file.

## 8. Key destruction (operator, after the resolved artifacts are committed)

```bash
shred -u /secure/offline/pilot-label-reveal-private.pem 2>/dev/null || \
  rm -P /secure/offline/pilot-label-reveal-private.pem
```

**What that command does and does not guarantee.** macOS, the operator's
platform, ships no `shred`, so the fallback runs; and `rm -P` overwrites in
place, which APFS's copy-on-write allocator does not honour. On an APFS
volume neither command reliably destroys the bytes, so attesting
"destroyed" on the strength of running them would be a false attestation.
Generate and hold the private key on an encrypted volume for the whole
ceremony (FileVault, or a disk image you create for this pilot), and let
the destruction claim be the one that is true there: the file is removed
and the volume's key is discarded. Record which of the two you did.

Record the destruction instant in the sizing PR's description. The
keypair is one-use: nothing may ever be sealed to it again, and a future
pilot mints a fresh pair.
