# Authenticated hosted evidence

Release readiness does not trust a coherent JSON receipt merely because its
fields agree. For controlled publication, runner destruction, durable
transition/soak, lifecycle, staging teardown, and WAF ceilings, the receipt must
be backed by an immutable hosted-evidence archive under:

```text
research/hosted-evidence/<profile>/<subject-sha256>/
```

`Archive Hosted Evidence` runs only from protected `main` on a GitHub-hosted
runner. Its collection job retains the exact Actions run response, every
bounded jobs/artifacts page, artifact metadata, the public artifact ZIP, and
the profile-required members. The caller selects run and artifact IDs only;
trusted workflow paths, events, job names, artifact names, source roles, and
member sets come from the repository profile contract.

The collector attests canonical `context.json` with GitHub OIDC. A separate
job downloads that exact handoff, verifies the Sigstore bundle, reconstructs
all digests from retained bytes, and proposes the archive through a unique
`automation/hosted-evidence-*` branch. Release verification requires:

- the canonical repository and archive workflow on `refs/heads/main`;
- the exact archiver source commit as signer and source digest;
- GitHub's Actions OIDC issuer and a SLSA provenance predicate;
- `--deny-self-hosted-runners`;
- exact subject path, commit, and SHA-256;
- exact successful source run/attempt/head/event/job/artifact identities; and
- a complete directory with no unenumerated file, symlink, or byte mismatch.

The complete committed archive, including raw public artifact ZIPs and the
Sigstore bundle, is bounded to 64 MiB. API inputs, ZIP members, pagination,
decompression, filenames, CRCs, and redirect destinations have tighter
individual limits. Artifact redirects never receive the GitHub API token.

## Profiles

| Profile | Authenticated sources |
|---|---|
| `controlled-publication` | Trusted `scan-featured.yml` publisher plus exact publication manifest and receipt |
| `runner-destruction` | Controlled collection artifact and a separate hosted provider absence readback |
| `durable-transition` | Exact-SHA CI attestation artifact, promotion job, and clean durable-enabled Production Health artifact |
| `durable-soak` | Authenticated hourly deep-health ledger spanning at least 24 hours with no gap over 90 minutes, a provider runtime transition with second-attempt recovery, and a distinct fixed-target exercise artifact proving normal completion, cancellation, completed-report recovery, and duplicate prevention |
| `lifecycle` | Hosted production R2 lifecycle readback plus same-SHA deep Production Health and delete canary |
| `staging-teardown` | Hosted privacy-safe receipt and sanitized manifest; private provider responses are never archived |
| `waf-ceilings` | Exact-candidate GitHub-hosted WAF Rulesets read, bounded GET/POST probe, correlated Security Events readback, and privacy-safe receipt/manifest |

Runner destruction deliberately uses two workflows. The collection workflow
cannot attest that its VM was later destroyed. The destruction artifact
contains only `destruction-evidence.json`; its immutable artifact ID/digest is
known only after upload, so the version 3 receipt is created afterward and
cross-binds that artifact. Requiring the receipt inside its own digest-bearing
artifact would be circular and is forbidden.

The archive retains the collection run's exact Jobs API bytes. Those bytes
include the self-hosted runner name, group, and labels, so the runner must be
registered with deliberately public-safe opaque metadata before collection:

- runner name: `sbl-controlled-<16 lowercase hex>`;
- runner group: the exact GitHub `Default` group; and
- labels: exactly `self-hosted`, `Linux`, `X64`, and
  `sbl-controlled-r2-<16 lowercase hex>`.

Do not place an IP address, hostname, cloud project/account, ARN, VM/instance
identifier, region, or provider name in runner metadata. The hosted collector
refuses any other shape rather than sanitizing the authenticated raw response.

The durable restart lane is also distinct from Production Health. An ordinary
health response cannot be relabeled as a restart. The restart source must be
the dedicated workflow and must carry provider-backed pre/post runtime
identity references plus a queued-work recovery record. Raw provider instance
IDs are never public: the capture adapter emits only domain-separated
`sha256:<digest>` references and binds them to sanitized provider-observation
digests.

The remaining four behaviors also have a distinct source. The
`durable-soak-exercises.yml` workflow runs on a GitHub-hosted runner from the
exact durable deployment commit and accepts only that commit as its dispatch
input. It has no evidence or receipt input. Using the production synthetic
credential and fixed IANA/W3C targets, it derives a canonical artifact from
live admissions and status/readback responses. One admission is replayed
exactly and must preserve a single job/report identity; that job must complete
and return the same persisted report on a later terminal-status recovery. A
second admission must cancel and remain cancelled without a report on status
readback. The three completed-report observations independently carry the exact
deployment commit, and retained clean health responses bracket the session so
a mid-exercise production convergence cannot be attributed to the original
deployment.

The durable-soak hosted profile requires all three source roles in exact order:
`monitor`, `restart`, and `exercises`. It verifies the exercise artifact and
both retained clean production-health responses, contains the exercise session inside
both the authenticated Actions job and ledger window, and requires its source,
live deployment, and config digest to equal the candidate-bound durable
transition. The subject separately binds the verified enable-transition
receipt digest and ledger digest. Its three evidence references bind the exact
run ids and artifact ZIP digests; the committed context binds every retained
run/job/artifact/member byte and its Sigstore bundle. A typed claim or digest
without that archive cannot pass.

The archive is mandatory candidate-verification evidence, not an optional
decoration. The fixed soak attestation predates candidate `C`; its
digest-addressed archive is added through the append-only evidence carrier,
whose binding entries must be set-equal to the authenticated context inventory
and whose retained `subject.json` must byte-equal that attestation. For all
three source roles, release and candidate verification compare the workflow
and the full invoked producer/semantic-verifier source closure at the
authenticated run commit with candidate `C`; unchanged YAML cannot conceal
stale helper code.

The soak itself is not inferred from three point observations. The dedicated
GitHub-hosted monitor enumerates every delivered scheduled Production Health
run in a bounded 24-hour-to-eight-day query. The candidate-owned Production
Health workflow assigns exact source-pinned run names to its deep and shallow
cron lanes. The monitor retains a set-complete workflow-run listing, expands
only `production-health/deep-hourly-v1`, and still cross-checks every rerun
attempt against the authenticated Jobs API marker. A spoofed display title or
a skipped marker therefore fails closed.

The canonical ledger requires every hourly sample and both deep R2 steps to
complete successfully, requires one exact deployment with durable jobs
requested/enabled/ready, and refuses a gap over 90 minutes. The minimum release
evidence is 24 hours; seven days (168 hours) is the recorded target. The
aggregate retains exact workflow-run pages, Jobs pages, artifact-list pages,
artifact ZIP bytes, and extracted health bytes under one digest manifest. The
artifact-list response already binds artifact id, name, digest, size, run id,
and head SHA, so the collector deliberately does not spend another request on
redundant per-artifact metadata.

This multi-day collection never uses the native workflow token. It reuses the
repository-only read App, mints a token narrowed to this repository and
Actions:read, and has no fallback. The collector also enforces a 750-request
runtime ceiling. At the reviewed eight-day maximum its conservative projection
is 607 requests (10 workflow pages, 193 deep runs, 200 deep attempts, and four
restart-source requests), leaving substantial headroom below the installation
token's 5,000-request/hour primary limit. Per-run Jobs and artifact collections
must each fit one 100-item page or collection refuses instead of silently
expanding the request budget. See GitHub's
[primary rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github_app_installations).

This supports the precise claim that every authenticated hourly sample
observed durable jobs enabled and ready; it is not a claim of mathematically
continuous observation between samples.

## Private-provider boundary

Raw private provider responses do not belong in public Actions artifacts or
evidence PRs. A provider capture must obtain them inside a GitHub-hosted job
through a narrowly scoped secret, normalize and redact them with a reviewed
adapter, attest only the privacy-safe receipt/manifest, and destroy the raw
response on the ephemeral runner.

The WAF profile implements this boundary with separate
`WAF_RULES_API_TOKEN` and `WAF_ANALYTICS_API_TOKEN` environment secrets and a
non-secret `CLOUDFLARE_ZONE_ID` binding. The tokens must be distinct. The first
has Zone WAF Read for only the production zone; the second has Account
Analytics Read with its Zone Resources restricted to only that zone. The
adapter selects the human rule ref
`scan-api-rate-limit` but publishes only the immutable provider rule API id and
version. It queries only the six Security Events fields required for exact Ray
correlation, rejects saturation or ambiguity, destroys every raw provider
response before safe output exists, and uploads only `receipt.json` plus
`sanitized-provider-manifest.json`. That manifest binds an ordered SHA-256
closure over the exact trusted workflow, WAF adapter/evidence sources, shared
canonical serializer/digest sources, TypeScript build configuration, and
package manifest/lockfile. The archiver recomputes the closure from the
authenticated capture `head_sha`, never from uncommitted or later checkout
bytes.

The production restart workflow now uses its reviewed, repository-pinned
Cloudflare Containers adapter. It still fails closed unless the protected
environment supplies the scoped provider read credential and account binding,
the durable-enabled production health matches the workflow commit, and the
provider exposes a distinct pre/post singleton identity around an exact
second-attempt recovery. Runtime destruction uses a fixed
`Container.destroy()` RPC, never SSH. Before the soak-start source is captured,
generate one strong value that aliases no scan, Turnstile, durable-job, R2,
watch, or provider credential; install it as the Worker secret
`SITE_BEHAVIOR_LAB_DURABLE_RESTART_TOKEN` and the protected
`release-evidence` environment secret `DURABLE_RESTART_CONTROL_TOKEN`. The
client HMAC-binds the stable GitHub `run_id` and admitted job/report identity;
the ScannerContainer verifies that authorization and atomically consumes the
run id before issuing the fixed destroy. GitHub keeps `run_id` stable across
run attempts, so rerunning the job or workflow cannot destroy a replacement
runtime. A fresh explicit dispatch receives a new run id. Consumed run ids are
retained for 45 days, beyond GitHub's 30-day rerun window, in a bounded
fail-closed ledger. Leave both bindings unchanged through soak-end and
attestation, then remove them from both control planes. Removing them mid-soak
changes the exact deployment/configuration binding and invalidates the
governed soak window.

If a first dispatch fails after the run id is consumed, its marker remains
`pending`: the destroy may already have occurred. The capture client retries
the exact same run/job/report binding on bounded transport and 5xx failures;
an authenticated matching pending marker returns a private retryable 503, and
a completed marker returns the original bounded snapshot without another
destroy. If those retries exhaust, do not automatically replace the refusal
with a fresh dispatch. Inspect the provider state and restart the ceremony
deliberately under a new protected approval. A rerun of the original Actions
run is safely refused; a newly approved dispatch is a new destructive ceremony
and can destroy once.

Create a separate custom Cloudflare API token for provider readback with only
the account-scoped **Containers Read** permission and restrict its resources to
the production Cloudflare account (plus an appropriate TTL/IP restriction
where operationally possible). Store it only as the protected
`release-evidence` environment secret
`DURABLE_RESTART_PROVIDER_API_TOKEN`; the workflow maps it to
`CLOUDFLARE_API_TOKEN` only for the pinned local Wrangler read subprocess.
Keep the exact production account id in the environment variable
`CLOUDFLARE_ACCOUNT_ID`. Do not grant Containers Edit/Write, Workers, R2, zone,
or user permissions: this token lists the fixed application and its instances
and cannot initiate the restart.

The staging teardown workflow still fails closed
until its exact provider adapter and scoped credential are reviewed. The
controlled-runner destruction workflow likewise remains red until a runner VM
provider is selected. A caller-supplied URL, transcript, or digest is not a
substitute. These remaining red workflows are operational blockers, not
permission to accept self-authored evidence.

### Hosted producer source-trust inventory

Every digest-addressed hosted archive below is introduced after candidate `C`
through the append-only evidence carrier; `C` contains the fixed subject and
source inputs, never the later authenticated archive. Verification requires
the exact carrier bytes and one linear `C <= archiver <= carrier S` history.
Every hosted role has one explicit source-trust mechanism:

| Profile / role | Source-trust mechanism |
|---|---|
| controlled publication / publisher | candidate-to-carrier accepted-producer history |
| runner destruction / collection, destruction | candidate-to-carrier accepted-producer history |
| durable transition / CI | exact candidate-approved workflow; the retained attestation job is inline and its three subjects are independently digest- and Sigstore-bound |
| durable transition / promotion | exact workflow plus the required-job registry and verifier |
| durable transition / production health | exact workflow plus both invoked smoke clients and their complete local import closure |
| durable soak / monitor, restart, exercises | exact workflow plus each complete invoked producer and semantic-verifier closure |
| lifecycle / readback | candidate-to-carrier accepted-producer history |
| lifecycle / production health | exact workflow plus both invoked smoke clients and their complete local import closure |
| staging teardown / provider capture | authenticated manifest with an exact ordered producer closure, then source-to-candidate byte comparison |
| WAF ceilings / provider capture | authenticated manifest with an exact ordered producer closure and exact candidate identity |

“Accepted-producer history” is not a documentation assumption: release
readiness accepts those source commits only when the candidate-to-carrier
history permits evidence-carrier changes and no executable producer drift.
The hosted archiver is separately pinned by workflow identity and source
commit; candidate-owned canonical verification replays its complete semantic
checks over the retained API and artifact bytes.

Generated evidence proposals must not be hand-merged across conflicts. Close
the conflicting proposal and rerun the archive workflow so one trusted run
recomputes the complete archive from one source set.
