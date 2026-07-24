# Featured corpus r2 rollout

The committed corpus is dual-read. Existing v1 reports remain historical v1
evidence: their schema, report identity, timestamps, and experiment identity
are never upgraded to r2. Reviewed security remediation may re-redact their
stored public bytes and refresh the digest-bound provenance sidecar while
preserving those identities. The committed-report workflows append newly
produced reports under a fail-closed producer mode; they never rewrite a v1
file as r2.

## Current default: r2 when the runner exists, disclosed v1 fallback until then

The moment `FEATURED_RUNNER_LABEL` is configured, scheduled refreshes and every
`repository_dispatch` of the featured workflow are forced to
`FEATURED_REPORT_MODE=r2`; a then-incomplete r2 gate (missing region or
attestation) is rejected visibly in preflight before Chromium starts, and an
automated v1 run is refused outright. Neither workflow ever reads a report-mode
repository variable or payload field.

While the controlled runner is NOT configured, the scheduled refresh keeps
running on the production-proven frozen v1 lane instead of failing every week
against infrastructure that does not exist yet. That fallback is never silent:
the preflight emits a workflow `::warning::` annotation, writes a
"scheduled fallback" line into the run summary, and the publish job commits it
as "Add scheduled v1 fallback scan reports". `scan.yml` (single-site
repository_dispatch) has no scheduled cadence to protect and stays
unconditionally r2 for automated events.

GitHub-hosted runners expose their platform but do not provide a stable,
verifiable outbound region. ScanReport r2 treats an unrecorded egress region as
an unknown comparison dimension, so automated production requires a controlled
self-hosted runner with truthful placement declarations.

## Activating r2 comparisons

Use a controlled runner whose outbound placement is stable and independently
known. Configure these repository Actions variables:

- `FEATURED_RUNNER_LABEL`: the custom label of that self-hosted runner.
- `SCANNER_EGRESS`: a truthful stable egress identifier, not the default
  `github-actions-ubuntu` label.
- `SCANNER_EGRESS_REGION`: the truthful stable outbound region.
- `FEATURED_R2_EGRESS_ATTESTED=1`: explicit operator confirmation
  that the preceding two values describe the runner's actual network path.

`FEATURED_REPORT_MODE` is selected by the workflow, not by a report-mode
repository variable: automated runs are r2 exactly when `FEATURED_RUNNER_LABEL`
exists (the same variable that routes the job to the controlled runner, so mode
and placement cannot disagree). Once the label exists, the remaining variables
decide whether the r2 gate is ready; if they are incomplete, the run is red and
publishes nothing.

The preflight also requires `GITHUB_SHA` to be a full commit equal to checked-out
`HEAD`, a clean worktree, and exact comparison flags. It then enables public r2
and consent verification with that exact commit. Once the runner label exists,
any missing or contradictory prerequisite fails before Next starts or Chromium
visits a site; there is no fallback to v1 and no invented region.

Do not set the attestation merely to make the workflow green. If the controlled
egress cannot be verified, automated corpus production must remain red.

## Privilege boundary and unresolved runner gate

The committed-report workflows split acquisition from publication. The
acquisition job visits hostile public sites with only `contents: read`, no
repository or Actions write permission, no persistent npm cache, and
`SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX=1`. Preflight checks that exact sandbox flag
before Chromium is installed or started, and startup health must independently
report `checks.chromiumSandbox=enabled`. Acquisition can emit only a bounded
data artifact containing JSON reports, provenance sidecars, the report index,
corpus statistics, and a digest manifest tied to the exact source SHA.
For r2, successful preflight also sets the server-only
`SITE_BEHAVIOR_LAB_REPORT_ACQUISITION=ci-workflow` process setting. The scan API
accepts that provenance label only with `CI=1`, r2, sandboxing, and the
operator-attested controlled self-hosted egress facts; request bodies and
headers cannot select it. The publisher then requires every primary and
embedded supporting run to carry that exact acquisition label and source SHA.

A separate `ubuntu-latest` publisher receives the minimum repository and
Actions write permissions. It checks out that exact source SHA, installs locked
dependencies with lifecycle scripts disabled, downloads the artifact by its
immutable artifact id, and treats every downloaded byte as untrusted data. The
publisher rejects malformed UTF-8, duplicate JSON keys, schema/mode mismatch,
undeclared paths, symlinks, traversal, missing sidecars, digest mismatch,
non-canonical manifests/statistics, file/count/byte limit violations, changes
to any existing managed report, or a different set of newly declared report
ids. Before extraction, repo-owned trusted code also binds GitHub artifact
metadata to the exact run, id, name, source SHA, digest, and compressed size,
then parses the raw ZIP central and local records. It rejects ZIP64,
encryption, unsupported methods/flags, duplicate or non-allowlisted paths,
directories/symlinks, traversal, forged sizes/CRC, local-header disagreement,
and aggregate/compressed/inflated limit violations; inflation is output-bounded
and writes are exclusive into a fresh temporary directory. The publisher does
not use `actions/download-artifact` auto-extraction. It copies only new
report/sidecar pairs, then independently applies
retention and rebuilds the public manifest and corpus statistics before a
fast-forward-only push. Featured-refresh issue writes happen in a third
GitHub-hosted job that receives only the bounded, revalidated public aggregate;
per-target diagnostics remain in private workflow logs.

Request binding uses the privacy-preserving public requested-subject shape in
the report. Redirected observed/final destinations are allowed because they are
measurements, not dispatch inputs. Raw path values, query values, and redacted
subdomain labels that intentionally collapse to the same public shape cannot be
distinguished after redaction; the publisher does not claim otherwise.

This software boundary does **not** prove the self-hosted acquisition host is
safe. Automated r2 production remains an external release gate until operators
can produce current evidence that the configured runner is:

- single-use and destroyed after exactly one job, with no persistent workspace,
  package cache, browser profile, or cross-run process state;
- isolated from cloud metadata, control-plane credentials, SSH/deploy keys,
  production secrets, and other internal services;
- routed through the declared stable outbound region and an independently
  enforced egress policy that blocks private, link-local, metadata, and
  non-required destinations;
- registered with the intended repository and labels for only the lifetime of
  the job, with teardown recorded against the Actions run id; and
- monitored well enough to show sandbox availability, host-image identity,
  outbound NAT identity, and successful destruction for each production run.

Repository configuration and source code cannot attest those host controls.
Do not describe the r2 acquisition lane as production-ready, isolated, or
ephemeral until the operator evidence exists and is reviewed; the existing
egress attestation is necessary but is not a substitute for that evidence.

## Manual v1 compatibility lane

`workflow_dispatch` alone exposes `report_mode=v1`. That explicit choice runs
on GitHub-hosted Ubuntu and produces frozen v1 solely for compatibility work.
With the controlled runner configured, the preflight rejects v1 for scheduled
and repository-dispatch events (only the disclosed fallback above may produce
automated v1, and only while the runner is unconfigured); a missing mode is an
error rather than a legacy default. Normal manual runs default to r2.
