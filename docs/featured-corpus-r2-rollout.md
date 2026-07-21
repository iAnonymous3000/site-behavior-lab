# Featured corpus r2 rollout

The committed corpus is dual-read. Existing v1 reports are historical evidence
and remain unchanged. The featured workflow appends newly produced reports in
one explicitly selected mode; it never rewrites a v1 file as r2.

## Current safe default

Scheduled refreshes use `FEATURED_REPORT_MODE=v1` and retain the existing
Shields comparison. GitHub-hosted runners expose the runner platform but do not
provide a stable, verifiable outbound region. ScanReport r2 treats an unrecorded
egress region as an unknown comparison dimension, so the workflow must not
claim eligible r2 deltas from that environment.

GitHub-hosted refreshes remain v1 even when dispatched as single runs. This
keeps one corpus producer gate and prevents an operator from accidentally
turning the same unknown placement into an r2 comparison later.

## Activating r2 comparisons

Use a controlled runner whose outbound placement is stable and independently
known. Configure these repository Actions variables:

- `FEATURED_RUNNER_LABEL`: the custom label of that self-hosted runner.
- `SCANNER_EGRESS`: a truthful stable egress identifier, not the default
  `github-actions-ubuntu` label.
- `SCANNER_EGRESS_REGION`: the truthful stable outbound region.
- `FEATURED_R2_EGRESS_ATTESTED=1`: explicit operator confirmation
  that the preceding two values describe the runner's actual network path.
- `FEATURED_REPORT_MODE=r2`: moves scheduled refreshes to r2 only after the
  controlled runner is ready.

The preflight also requires `GITHUB_SHA` to be a full commit equal to checked-out
`HEAD`, a clean worktree, and exact comparison flags. It then enables public r2
and consent verification with that exact commit. Any missing or contradictory
prerequisite fails before Next starts or Chromium visits a site; there is no
fallback to v1 and no invented region.

Do not set the attestation merely to make the workflow green. If the controlled
egress cannot be verified, retain v1 comparisons or publish r2 single runs.
