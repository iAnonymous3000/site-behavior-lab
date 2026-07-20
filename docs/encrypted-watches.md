# Encrypted scheduled rescans

## Status and scope

Encrypted watches are the post-durability retention feature. The repository
ships the storage, scheduling, private preparation, health, and API foundation
behind `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES=1`; both committed Cloudflare
configurations keep it at `0`. Do not enable it until durable jobs report
`readiness: "ready"` in production and have completed their separate replay
canaries and soak.

The first product is deliberately called a **scheduled rescan**, not a change
alert. Each run is an independent controlled visit. Live share reports still
follow the ordinary seven-day and count retention policy, so a watch does not
promise a permanent longitudinal evidence chain and cannot prove why a site
changed.

## Fixed contract

- Accountless create, metadata read, and delete. Targets and options are
  immutable; replace a watch to change them.
- One single-mode r2 scan runs immediately, then at a fixed seven-day cadence.
- A watch expires after 30 days or five scheduled attempts, whichever comes
  first. An attempt that fails before durable-job admission still consumes one
  slot, so an unreachable target cannot retry indefinitely.
- At most 32 active watches exist in the coordinator, with a global budget of
  100 scheduled runs per UTC day. Scheduled work is not linked to an IP or a
  public per-client quota identity.
- Creation and due execution require the scanner's configured access-token
  gate. The open public Turnstile path remains available for ordinary scans but
  cannot consume the coordinator-wide watch capacity; enabling watches without
  token-gated ingress makes only the watch capability misconfigured.
- The payload contains exactly one canonical HTTP(S) URL, with no credentials,
  query, or fragment, plus desktop/mobile, GPC on/off, `reportMode: "r2"`, and
  `comparison: "none"`.
- Each admitted run becomes an ordinary durable scan job and follows its
  fenced execution, publication, reconciliation, and report-retention rules.
- A late or abandoned run advances the watch once and schedules the next run no
  sooner than one full cadence from that attempt. The scheduler never emits a
  catch-up burst, and a watch can hold only one due lease at a time.

Before its first POST, the browser creates and retains a cryptographically random
256-bit capability token. It sends that token in
`x-site-behavior-lab-watch-capability` on create, metadata read, and delete. The
Worker deterministically derives the same opaque 128-bit public watch ID from a
domain-separated SHA-256 of the token bytes, so a response-lost retry addresses
the original watch instead of consuming capacity with an orphan. Authorization
still requires the full independent capability token. The client keeps it in
local state or a URL fragment, which browsers do not send in HTTP requests. The
token must never be placed in a path, query, Referer, analytics event, or log.
Durable Object storage holds only its SHA-256 digest and compares the digest in
constant time.

DELETE is deliberately idempotent and non-oracular after the bounded status
rate limit: any canonical watch ID and canonical capability-shaped token receives
the same `200` deleted acknowledgement, whether no row exists or the token does
not match. The store removes data only for an exact digest match. Malformed
inputs retain the uniform non-reflective `404`, and GET remains a strict
capability-scoped metadata lookup. This lets a browser safely discard a fragment
minted before a POST whose outcome was uncertain without learning record
existence.

## Data handling and SSRF boundary

The normalized target and options are encrypted with AES-256-GCM before the
watch transaction commits. The envelope binds its version, key ID, watch ID,
creation and expiry clocks, cadence, run cap, and a key-derived options
commitment as authenticated context. Ciphertext therefore cannot be
transplanted between records, while low-entropy options do not appear in
plaintext or as an offline-guessable bare digest. The target and options remain
authenticated inside the ciphertext. The encryption keys are Worker-only and
are never sent to the browser or Node container. Unencrypted state is limited
to opaque IDs, capability digest, creation/expiry/cadence clocks, run count,
lease/fencing fields, and bounded job/report outcome linkage; it contains no
target, IP, client hash, Turnstile token, or request credentials.

Initial creation links run 1 to its admitted durable job in the same coordinator
transaction. Every later lease resolution appends one of at most five history
records. Admission truth (`admitted` or `failed`) is distinct from durable
terminal truth (`succeeded`, `failed`, `expired`, or `cancelled`); the latter is
copied into bounded watch history before the short-lived durable row is purged.
No intermediate `running` state is inferred. Identical terminal callbacks are
idempotent, while contradictory callbacks fail closed.

Creation validates the public target. Every due claim then decrypts only in the
Worker and sends the strict plaintext payload through the authenticated private
`/api/internal/durable-scans/prepare-watch` boundary. Node performs a **fresh DNS
and public-address validation for every run** before minting a durable admission
envelope. Chromium still uses the connect-time public-address proxy. A hostname
that later resolves to local, private, link-local, or metadata space therefore
fails closed instead of inheriting an old DNS decision.

Target reads and due claims require the current watch keyring and full feature
readiness. Capability-authenticated metadata reads and deletion remain available
when creation is disabled or a key is temporarily unavailable, because rollback
must not trap retained ciphertext. Deleting a watch prevents future claims and
removes its active ciphertext; a durable job already admitted before deletion is
independent and may still reach its terminal result. Cloudflare recovery copies
may retain application-encrypted bytes until the platform backup window expires.

All synchronous store mutations run inside the authoritative Durable Object
`transactionSync` boundary. Random credentials, SHA-256 digests, AES-GCM
envelopes, and lease credentials are prepared before that boundary. Admission,
daily-budget charging, due claiming, run linkage, terminal-history updates, and
alarm selection must commit atomically with their caller's coordinator changes.
When arming an alarm, retain the earliest existing hard wake; remote activity
must never postpone a due lease, TTL purge, or budget-reset wake.

## Key configuration and rotation

Use secrets distinct from the durable-job key, internal coordinator token,
Turnstile secret, scan token, and R2 credentials:

```text
SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_KEY=<32 random bytes, unpadded base64url>
SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_PREVIOUS_KEY=<optional former key>
```

The current key encrypts every new write. Its stable SHA-256-derived key ID is
stored in each envelope; decryption accepts the current key or the one optional
previous key selected by that ID. A safe rotation is:

1. Generate a new independent 32-byte key and retain the old current value.
2. Deploy the new key as current and the old value as previous, with the feature
   still at its existing flag state.
3. Confirm health and a gated create/run/read/delete canary.
4. Keep the previous key for at least the maximum 30-day watch lifetime, or
   explicitly delete every watch encrypted under it.
5. Remove the previous key. Never reuse or swap the two values.

A malformed key, aliased secret, unknown envelope key ID, authentication-tag
failure, invalid decrypted payload, or unavailable durable-job dependency makes
creation/decryption fail closed. Health must not expose key material or key IDs.

## Activation and rollback

Activate this separately from durable jobs and container sharding:

1. Confirm exact production provenance, empty warnings, durable jobs `ready`,
   R2/public-r2 healthy, and normal/replay canaries complete.
2. Keep ingress token-gated. Install the distinct current watch key as a Worker
   secret and leave the optional previous key unset for first activation.
3. Deploy with `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES=1`. Require health to report
   `checks.encryptedWatches.readiness: "ready"` and
   `capabilities.scheduledRescans: true`.
4. Create one watch for a controlled public fixture without a query string.
   Preserve its capability only in the test client, do not poll to drive work,
   and confirm the immediate run is scheduled by the coordinator.
5. Read metadata with the custom capability header, retrieve the normal report,
   delete the watch, and confirm subsequent metadata reflects deletion or is
   unavailable without ever returning the plaintext target.
6. Audit structured logs for opaque identifiers only. Keep ingress token-gated
   for as long as watches remain enabled; disable watches before reopening the
   ordinary public scan path.

For rollback, set the flag to `0` first. New creation and due target decryption
stop, while capability-authenticated metadata read/delete remains available.
Keep the keyring installed until retained watches have been deleted or expired;
removing it sooner intentionally makes target decryption impossible. The
production health workflow derives the expected flag from the reviewed
`wrangler.container.jsonc` and rejects readiness/capability drift in either
state.
