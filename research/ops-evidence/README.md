# Operator evidence inputs

This directory holds canonical machine-verified receipts beneath the separate
human attestations in `research/ops-receipts/`. Generate files only with the
create-only commands in
[`docs/operator-evidence-capture.md`](../../docs/operator-evidence-capture.md).
The WAF flow also retains its canonical sanitized probe transcript here so the
final receipt can re-derive and bind its exact source bytes.
The staging teardown command consumes only an already-sanitized same-session
provider transcript; it is a data-only receipt builder and never performs the
teardown itself.
Local validation does not authenticate who captured a private WAF, log,
egress, or staging provider source. Those release gates therefore stay red
until a dedicated trusted hosted capture attests the privacy-safe manifest and
receipt after observing the exact provider bytes. Caller-supplied hashes are
never accepted as a substitute. Container licensing instead follows the
candidate-resident inventory/Sigstore chain documented in the runbook.
An absent receipt means the corresponding release gate remains open.
