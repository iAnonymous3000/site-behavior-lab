# CNAME prevalence-pilot runbook

## Restarted study (2026-10): this identity supersedes the 2026-08 one

On 2026-10-02 the owner restarted the step-5 reliability sweep. The 2026-08
universe admitted seven development-visited frame domains, because its
builder never read several repository surfaces that record visits; commit
505c3019 fixed the exclusion set (docs/reliability-sweep-cluster-design.md,
"Development exclusion"). A corrected exclusion set changes the partition
seed, so the restart is a new study with a freshly drawn pilot, never an
edit of the 2026-08 one:

- universe studyId: `cname-uncloaking-2026-10`; pilot studyId:
  `cname-uncloaking-2026-10-prevalence-pilot`
- pilot set: calibration/cname-uncloaking-2026-10-prevalence-pilot/pilot-set.json
  (100 cases, sha256
  `06dd74369c4b3092dff23f67b2b2cda51f0bad37c0552344334592e0f97f6c55`),
  bound by pilotSetSha256 inside universe-provenance.json in the same
  directory (sha256
  `2eab6ea4732cee93a601118781fd3313744699e666a9e6da4e8635e5d4674102`)
- built from the tree at 505c3019 with the same pinned sources as 2026-08
  (Tranco N2Q7W; ercexpo us-news-domains v2.0.0 at
  61505468f330000f15494ed302e0d1d719895b83): 2,375 domains after the
  category intersection, 20 excluded, frame 2,355 = 2,255 pool + 100 pilot.
  The pool's candidate set (sha256
  `bc4a846142a92ca8018a87ccfd2f41684c52cbbc76eb5c7d9916f0ff553e7d80`)
  stays outside the repository, as in 2026-08. The partition seed hashes
  the WHOLE derived exclusion list (183 domains, sha256
  `1c22b3d71c5da0d14da7fbc2257e3387bbd8c548b2904304594fc0a61cf89ee7`
  under tldts 7.4.16), not only the 20 that hit the frame, so a rebuild
  reproduces these bytes only from a tree whose derived list has exactly
  that digest. Any recorded domain added or removed anywhere, news or not,
  or a different tldts, changes the seed and the pilot.

No ceremony step has run for this study: no sealing keypair, no carrier K,
no frame F, no labels. Every command below names the 2026-10 study. The
2026-08 pilot set and provenance stay committed as the historical record
and are not used ("Historical: the 2026-08 identity", at the end). The
sweep that sizes this study restarts too: its preregistration amendment,
collection SHA, and feasibility gate are in
docs/reliability-sweep-cluster-design.md, "Restart (2026-10-02)". The
August round-1 feasibility figures do not bind this study.

## The procedure

The complete operator procedure for the 100-site prevalence pilot, in
order, with what refuses if a step is skipped. Study identity:

- studyId: `cname-uncloaking-2026-10-prevalence-pilot`
- detector: `cname-uncloaking`
- protocol: `independent-labeling-protocol@1`, exact bytes
  docs/calibration-prereg-drafts/labeling-protocol.md, sha256
  `d292f4608bfaf67256bfba0cfdb5e6d1f65ded98941e06c93a8cdf749e0c564f`
  (pinned inside the approved policy artifact; do not edit the file)
- pilot set: calibration/cname-uncloaking-2026-10-prevalence-pilot/pilot-set.json
  (100 cases, sha256
  `06dd74369c4b3092dff23f67b2b2cda51f0bad37c0552344334592e0f97f6c55`,
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

**Reviewers label and seal with a git clone and Node, nothing else.** The
frame producer, the reference instrument, the reviewer-batch producer, and
the seal CLI all run from a bare checkout with no `npm ci` and no `dist/`,
because every gate on that path is a committed-bytes check. If one of them
ever fails with "build dist/schema", that is a defect in the tool, not a step
a reviewer is missing. Committing the sealed envelope needs one more thing:
write access to this repository, to push one branch and dispatch one
workflow, from `gh` or the repository's Actions tab. The workflow does its
own install on GitHub.

**The operator, for steps 5 and 6, works from a development checkout**
(`npm ci && npm run build:schema`): the close and the reveal recompute the
commitment-set identity through the compiled canonical-JSON module, which is
deliberate. Step 7's sizing does not need it, and neither step ever runs on a
reviewer's machine.

## 1. One-use sealing keypair (operator)

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out /secure/offline/pilot-label-reveal-private.pem
openssl pkey -in /secure/offline/pilot-label-reveal-private.pem -pubout \
  -out calibration/cname-uncloaking-2026-10-prevalence-pilot/label-sealing-public-key.pem
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
  --study-dir calibration/cname-uncloaking-2026-10-prevalence-pilot
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

**What the gate establishes, and what it does not.** It proves the frame
derives from its carrier, and that each later artifact NAMES the one before
it: the authorization names this frame, this carrier, and the committed
sealing key; the resolved labels name that authorization's commitment set and
exactly the frame's cases; the sizing names those labels. It does not prove
the label VALUES came out of the sealed envelopes, because no ciphertext is
committed and the reveal is where that is established. It does not re-run the
close's commitment custody, which needs the reviewer records rather than the
summary the authorization carries. And it does not check the sizing
arithmetic or the swept pool. The gate's own output says so on every run, and
none of those gaps is closed by adding another digest.

If the gate goes red after F has merged, read WHICH refusal fired before
doing anything, because the remedies are not interchangeable:

- **A failure to read the repository** (the message says so, and carries what
  git or tar reported) is an environment problem. Fix the environment and
  re-run. It is not a finding about the carrier and no artifact is in doubt.
- **A sizing refusal** means the artifact does not NAME the frame, carrier, or
  resolved labels committed beside it. Sizing is a pure derivation over
  committed evidence and nothing is sealed to it, so re-run step 7 and commit
  what it produces.
- **A carrier, frame, authorization, or resolved-labels refusal** is the
  serious case. Do not rewrite history: main is protected, and the frame is
  what reviewers may already hold. Retire that carrier, land a fresh K,
  rebuild the frame from it, and freeze a new F. Nothing sealed under the
  retired frame may be used, because its identity is the thing in question.

## 3. Frame-task generation (operator, from a clean checkout of K)

```bash
git fetch origin && git checkout <K>
npm run calibration:v4-frame-tasks -- build \
  --study-id cname-uncloaking-2026-10-prevalence-pilot \
  --detector cname-uncloaking \
  --candidate-commit <K> \
  --protocol-id independent-labeling-protocol@1 \
  --protocol-file docs/calibration-prereg-drafts/labeling-protocol.md \
  --cases calibration/cname-uncloaking-2026-10-prevalence-pilot/pilot-set.json \
  --output-root calibration/cname-uncloaking-2026-10-prevalence-pilot
```

Refuses while the decision is pending, if the detector were held, or if
the protocol file's digest disagrees with the approved artifact. The frame
freezes the protocol digest and the shared definition pins; `check` mode
re-verifies every task byte. Open the F PR with `frame-tasks.json`,
`tasks/`, and `pilot-carrier.txt` containing exactly K's sha and a
trailing newline; run the carrier check from step 2 before requesting
review.

## 4. Reviewer dispatch (two labelers, one blind tiebreaker)

Precondition: the restarted round 1's feasibility band is already recorded
on main in docs/reliability-sweep-cluster-design.md ("Restart
(2026-10-02)"). Dispatching earlier would let a pilot label exist before
the gate it is judged against.

Each reviewer works from a clean checkout of **F**, the frame-freeze
commit (the frame files exist only there; K carries the inputs). They
receive: F's sha, the two definition-snapshot URLs and digests above, and
these commands. Reviewers capture each case with THEIR OWN browser (fresh
profile, HAR export per case, named `<caseId>.har`, and nothing else in
that directory). A capture with no successful response from the
case's own registrable domain is recorded as NOT determined, so it can only
be labelled uncertain, never absent. That covers the three shapes which
otherwise look identical to a clean site: a subject that redirects to
another registrable domain, a navigation that failed, and a HAR from the
wrong tab. The run continues and lists those cases at the end.

This is not hypothetical: in the superseded 2026-08 pilot set, `philly.com`
answered on `www.inquirer.com` and `cbslocal.com` on `www.cbsnews.com`
when this runbook was first written. Re-capture
if the cause was your browser or your network. If the subject genuinely
serves another domain now, tell the operator: replacing a case is a decision
about the study's universe, and it changes the pilot set, its digest, and
therefore the carrier. It is never a label a reviewer may supply.

```bash
git fetch origin && git checkout <F>

# verify the shared definitions byte-for-byte before anything else
shasum -a 256 downloaded-trackers.txt downloaded-psl.dat

npm run calibration:cname-reference -- \
  --study-id cname-uncloaking-2026-10-prevalence-pilot \
  --cases calibration/cname-uncloaking-2026-10-prevalence-pilot/pilot-set.json \
  --har-dir <their-har-dir> \
  --frame-tasks calibration/cname-uncloaking-2026-10-prevalence-pilot/frame-tasks.json \
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
  --frame-tasks calibration/cname-uncloaking-2026-10-prevalence-pilot/frame-tasks.json \
  --tasks-dir calibration/cname-uncloaking-2026-10-prevalence-pilot/tasks \
  --role labeler --actor <their-github-login> \
  [--decisions decisions.json] --out batch.json

npm run calibration:v4-seal-label-batch -- \
  --role labeler --actor <their-github-login> \
  --public-key calibration/cname-uncloaking-2026-10-prevalence-pilot/label-sealing-public-key.pem \
  --frame-tasks calibration/cname-uncloaking-2026-10-prevalence-pilot/frame-tasks.json \
  --tasks-dir calibration/cname-uncloaking-2026-10-prevalence-pilot/tasks \
  --input batch.json --output sealed-envelope.json
```

The tiebreaker does the same with `--role tiebreaker`, blind to the
labelers' batches (everything they see is sealed). Worksheets, HARs, and
decisions files stay PRIVATE reviewer evidence until reveal; only sealed
envelopes travel.

### Commit the sealed envelope (each reviewer, on GitHub)

A sealed envelope on a reviewer's machine is not evidence yet. Each reviewer
turns theirs into one authenticated commitment by dispatching the hosted
`Calibration v4 Pilot Commitment` workflow
(.github/workflows/calibration-v4-pilot-commitment.yml) themselves, signed in
as the login they sealed under. The workflow reads the frame, its tasks,
`pilot-carrier.txt`, the sealing public key, and the approval from main as it
stands at dispatch, never from the reviewer's commit. The reviewer's commit
supplies only the sealed envelope, which the producer reads as the Git blob at
that commit and path and never opens. It refuses a dispatch made on someone
else's behalf, a dispatcher who is not the envelope's reviewer, a role the
envelope does not carry, a carrier record that disagrees with the committed
frame, a task byte that drifted, and a study that is not a prevalence pilot.

Commit `sealed-envelope.json` alone on a branch cut from F and push it to this
repository. The workflow resolves `source_ref` inside its own clone of this
repository, so a commit that exists only in a fork cannot be found.
Dispatching needs write access to the repository, and so does the push. Then
dispatch from main:

```bash
git switch -c pilot-envelope-<their-github-login>
git add sealed-envelope.json
git commit -m "Seal one pilot label batch"
git push origin HEAD
gh workflow run calibration-v4-pilot-commitment.yml --ref main \
  -f role=labeler \
  -f study_id=cname-uncloaking-2026-10-prevalence-pilot \
  -f source_ref="$(git rev-parse HEAD)" \
  -f source_path=sealed-envelope.json
```

The tiebreaker dispatches with `-f role=tiebreaker`. When the run succeeds, its
summary prints five values: role, run id, run attempt, artifact id, and
artifact digest. Send those five to the operator; they are the reviewer's
coordinates. If the run is re-run, report its latest attempt: the fetch reads
the run as GitHub reports it at fetch time, so an earlier attempt's coordinates
are refused. The artifact holds ciphertext and authenticated run metadata
only.

## 5. Close (operator, after all three commitments exist)

Nothing in steps 5 to 8 has yet run against a real reviewer commitment, and
the commitment workflow has never run on GitHub. The ceremony test
(scripts/calibration-v4-pilot-ceremony.test.mjs) runs every command from
sealing to sizing, through a stubbed GitHub API.

Collect the reviewers' coordinates into one file: a JSON array with one object
per reviewer, holding exactly these five fields, the ids and the attempt as
JSON integers and the digest as 64 lowercase hex characters:

```text
[
  { "role": "labeler", "runId": <run id>, "runAttempt": <run attempt>,
    "artifactId": <artifact id>, "archiveSha256": "<artifact digest>" },
  ...
]
```

Then fetch the records, signed in to `gh` with read access to this
repository's Actions:

```bash
git fetch origin
npm run calibration:v4-fetch-commitments -- \
  --study-dir calibration/cname-uncloaking-2026-10-prevalence-pilot \
  --coordinates coordinates.json \
  --out-dir <fetched-records-dir>
```

The fetch re-reads each run and its artifact through the GitHub API and
downloads the archive. It refuses a run that is not one successful,
non-delegated dispatch of the pilot workflow from main; an artifact whose
name, id, digest, or owning run disagrees with the coordinates; a producer
commit older than F or absent from `origin/main`; an F that is not on
`origin/main`; a record bound to another carrier or sealing key; a repeated
run, artifact, or digest; and two commitments from one actor. It writes one
record per reviewer into `--out-dir`, which must not exist yet. Write the
coordinates file once and keep it: the order of its entries names the record
files, and the record files' order is what the close freezes.

Then close:

```bash
npm run calibration:v4-pilot-close -- \
  --frame-tasks calibration/cname-uncloaking-2026-10-prevalence-pilot/frame-tasks.json \
  --commitments-dir <fetched-records-dir> \
  --public-key calibration/cname-uncloaking-2026-10-prevalence-pilot/label-sealing-public-key.pem \
  --out calibration/cname-uncloaking-2026-10-prevalence-pilot/pilot-labeling-authorization.json
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
substituted record. The fetch names them; do not rename them.

What the close CANNOT establish is that GitHub really ran the workflow a
record describes. The fetch established that when it wrote the directory, so
close only from a directory `calibration:v4-fetch-commitments` wrote.
Commit the authorization via PR; the repository commit is the anchor the
reveal trusts. After it merges, labeling is closed: later commitments
self-defeat against the authorized set.

## 6. Reveal (operator, offline reveal machine)

On the machine holding the private key, from a verified checkout of the
authorization commit. "Verified" is these three commands, not a feeling:

```bash
git fetch origin && git checkout <authorization-commit>
git status --porcelain            # must print nothing
shasum -a 256 calibration/cname-uncloaking-2026-10-prevalence-pilot/pilot-labeling-authorization.json
```

The digest must equal the one the close printed and the authorization PR
recorded. The reveal cannot check this for you: it reads a file path, and on
the offline machine there is no CI to attest the tree. This is the anchor the
whole reveal rests on, so do it by hand and record that you did.

Then:

```bash
CALIBRATION_LABEL_REVEAL_PRIVATE_KEY="$(cat /secure/offline/pilot-label-reveal-private.pem)" \
npm run calibration:v4-reveal -- \
  --frame-tasks calibration/cname-uncloaking-2026-10-prevalence-pilot/frame-tasks.json \
  --tasks-dir calibration/cname-uncloaking-2026-10-prevalence-pilot/tasks \
  --authorization calibration/cname-uncloaking-2026-10-prevalence-pilot/pilot-labeling-authorization.json \
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
  --frame-tasks calibration/cname-uncloaking-2026-10-prevalence-pilot/frame-tasks.json \
  --swept-eligible-pool <rounds-1-2 eligible count> \
  --out calibration/cname-uncloaking-2026-10-prevalence-pilot/pilot-sizing.json
```

N derives through the preregistered uncertainty envelope. The
preregistered early gate is the rule in
docs/reliability-sweep-cluster-design.md ("Restart (2026-10-02)"): the
band of present counts whose zero-uncertain N fits under the restarted
round 1's bare-load-valid count, recorded there before step 4
(necessary-only, zero-uncertain boundary). The August figures are
superseded and do not apply to this study. INFEASIBLE means a larger
universe and fresh sweep rounds; never a relaxed rule.

The gate is enforced, not merely printed: an INFEASIBLE determination
writes its artifact and then exits non-zero, so no later step runs on it.
`--swept-eligible-pool` is required, because a run that recorded no
determination would otherwise read exactly like a run that passed.

**The pool is the one number nothing can check for you.** No committed
artifact states it yet, so CI can only confirm that the feasibility verdict
follows FROM the pool the artifact declares. A mistyped pool (10000 for
1000) turns an infeasible pilot feasible and every check still passes. Quote
it from the sweep's own receipt, read it back before you commit the
artifact, and record in the sizing PR where you took it from. The
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

## Historical: the 2026-08 identity

Superseded on 2026-10-02 and kept only as the record of what was drawn. No
ceremony step ever ran for it: no sealing key, carrier, frame, or label
exists. Nothing above may be run against it.

- studyId: `cname-uncloaking-2026-08-prevalence-pilot` (universe
  `cname-uncloaking-2026-08`)
- pilot set: calibration/cname-uncloaking-2026-08-prevalence-pilot/pilot-set.json
  (100 cases, sha256
  `b1760d060c4022ef9bb6b34c82d1bc404c121160a9956afe1f1606cc7236b3f4`),
  bound by pilotSetSha256 inside universe-provenance.json in the same
  directory (sha256
  `6f67a243648b585c35e799d4d5eab5d61a817542c2496d4398069c9001c7ea62`)
- why superseded: its frame admitted seven development-visited domains, and
  the sweep that would have sized it collected one round on a build whose
  driver failed open (docs/reliability-sweep-cluster-design.md, "Restart
  (2026-10-02)")
