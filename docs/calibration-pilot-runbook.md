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
  - public suffix list at commit
    `e8c9a2b2b2856b6449999dd0ec0d118f364ed0cd`, sha256
    `df6306ec61971424ad259757b399911f4d414486629a5a00e299a2b6c7957089`

Every pilot CLI refuses unless RELEASE_READINESS.json carries the
named-human approval of the policy artifact (landed 2026-08-25) and the
frame matches the approved artifact's protocol digest and pins.

## 1. One-use sealing keypair (operator)

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out /secure/offline/pilot-label-reveal-private.pem
openssl pkey -in /secure/offline/pilot-label-reveal-private.pem -pubout \
  -out calibration/cname-uncloaking-2026-08-prevalence-pilot/label-sealing-public-key.pem
```

Commit ONLY the public half. The private key never enters the repository,
any cloud sync, or any machine other than the offline reveal machine. The
keyId every tool checks is the sha256 of the public key's SPKI DER
(`calibrationLabelPublicKeyIdentity`).

## 2. Pilot carrier freeze (candidate-commit semantics)

`candidateCommit` for this pilot is the merge commit at which ALL of the
following are committed together on main: pilot-set.json,
universe-provenance.json, label-sealing-public-key.pem, and the frame
tasks from step 3. That one commit is the identity every batch, envelope,
authorization, and resolved artifact binds; it plays the role the
candidate freeze plays in the confirmatory ceremony. Record it once,
verbatim, in this directory as `pilot-carrier.txt` in the freeze commit's
own PR.

## 3. Frame-task generation (operator, after the key commit)

```bash
npm run calibration:v4-frame-tasks -- build \
  --study-id cname-uncloaking-2026-08-prevalence-pilot \
  --detector cname-uncloaking \
  --candidate-commit <pilot-carrier-sha> \
  --protocol-id independent-labeling-protocol@1 \
  --protocol-file docs/calibration-prereg-drafts/labeling-protocol.md \
  --cases calibration/cname-uncloaking-2026-08-prevalence-pilot/pilot-set.json \
  --output-root calibration/cname-uncloaking-2026-08-prevalence-pilot
```

Refuses while the decision is pending, if the detector were held, or if
the protocol file's digest disagrees with the approved artifact. The
frame freezes the protocol digest and the shared definition pins;
`check` mode re-verifies every task byte. Commit frame-tasks.json and
tasks/ in the carrier-freeze PR of step 2.

## 4. Reviewer dispatch (two labelers, one blind tiebreaker)

Each reviewer works from a clean checkout of the pilot carrier commit and
receives: the frame directory, the two definition-snapshot URLs and
digests above, and these commands. Reviewers capture each case with THEIR
OWN browser (fresh profile, HAR export per case, named `<caseId>.har`),
then:

```bash
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
  --public-suffix-source-sha256 df6306ec61971424ad259757b399911f4d414486629a5a00e299a2b6c7957089 \
  --resolver <their-resolver-ip> --out worksheet.json

# review the worksheet; record any per-case overrides in decisions.json
# as [{"caseId": "...", "value": "present|absent|uncertain"}]; an
# unresolved no-match case can never be overridden to absent.
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
labelers' batches (everything they see is sealed). Each reviewer then
dispatches the hosted `Calibration Label Commitment` workflow with their
sealed envelope, producing the authenticated commitment artifact under
their own GitHub actor. Worksheets, HARs, and decisions files stay
PRIVATE reviewer evidence until reveal; only sealed envelopes travel.

## 5. Close (operator, after all three commitments exist)

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

The close freezes the labeling-close instant and the authorized
commitment set together (a mismatched keyId refuses here, key-free).
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
chronology); the key is read only after all of it passes. Output:
resolved-labels.json (a pure projection of the assembly bridge, carrying
the authorized commitmentSetSha256) plus per-case adjudication artifacts
for tiebreaker-resolved disagreements. Commit them beside the
authorization.

## 7. Sizing and the feasibility gate

```bash
npm run calibration:v4-pilot-sizing -- \
  --resolved-labels <reveal-out>/resolved-labels.json \
  --frame-tasks calibration/cname-uncloaking-2026-08-prevalence-pilot/frame-tasks.json \
  --minimum-per-class 100 \
  --swept-eligible-pool <rounds-1-2 eligible count> \
  --out calibration/cname-uncloaking-2026-08-prevalence-pilot/pilot-sizing.json
```

N derives through the preregistered uncertainty envelope. The
preregistered gate (docs/reliability-sweep-cluster-design.md): at the
round-1 optimistic ceiling of 1,126, the pilot must resolve 18..82
present (necessary-only, zero-uncertain boundary). INFEASIBLE means a
larger universe and fresh sweep rounds; never a relaxed rule.

## 8. Key destruction (operator, after the resolved artifacts are committed)

```bash
shred -u /secure/offline/pilot-label-reveal-private.pem 2>/dev/null || \
  rm -P /secure/offline/pilot-label-reveal-private.pem
```

Record the destruction instant in the sizing PR's description. The
keypair is one-use: nothing may ever be sealed to it again, and a future
pilot mints a fresh pair.
