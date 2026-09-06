# Maintainer workflow

Routine maintainer changes go directly to `main` after appropriate local
validation. Do not create a feature branch or pull request unless the user
explicitly requests that workflow.

Production remains gated by the existing main CI checks, exact-source
attestation, promotion App, and live verification. Preserve those gates and
their evidence; direct-to-main does not mean direct-to-production.

When moving work from an existing PR into this workflow, use a fresh commit on
main. Reusing a PR head SHA can attach cancelled PR checks to the production
candidate and block GitHub's required checks despite successful main CI.

Do not add assistant or model attribution to commits, PRs, or release text.
