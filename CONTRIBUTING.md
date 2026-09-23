# Contributing to Site Behavior Lab

Thank you for improving the project. Changes should preserve the project's
core promise: evidence must stay reproducible, privacy-reduced, and no stronger
than the controlled visit supports.

## Before opening a change

- Search existing issues and pull requests for related work.
- Use a public issue for bugs, usability problems, and evidence disputes.
- Use GitHub private vulnerability reporting for security issues, personal
  data, tokens, or sensitive unredacted URLs.
- Keep generated report artifacts, source logic, and documentation in the same
  change when their contracts move together.

## Development

Use Node.js 24.14.1 with npm 11.11.0 (`.nvmrc`, `package.json`, and CI pin the
same versions).

1. Install dependencies with `npm ci`, then the pinned browser with
   `npx playwright install chromium`. Do not use `npm install` or
   `npm audit fix` for setup: with npm 11.11.0 both rewrite
   `package-lock.json` and drop its root `packageManager` field, which the
   release-evidence and toolchain-provenance tests pin, and
   `npm run supply-chain:third-party:check` then reports the inventory stale,
   so the checks fail on an otherwise clean tree.
2. Run `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=https://example.org npm run check`
   for TypeScript, Cloudflare types, unit tests, and the production build. The
   build refuses to guess the public origin, so the variable is required.
3. When static publication behavior changes, also run npm run build:pages and
   npm run test:smoke:static with the same variable set.
4. Add focused tests for every bug fix and for fail-closed integrity,
   redaction, or eligibility behavior.

The static Pages build requires an exact clean Git revision before it can emit
deployment provenance. Commit the reviewed inputs before running build:pages;
ordinary npm run build remains available while developing.

## Evidence and product language

- Describe one automated visit as an observation, never a universal claim,
  privacy grade, legal conclusion, or causal verdict.
- Keep failed loads, bot walls, incomplete recordings, and unsupported
  evidence families explicit.
- Do not silently rewrite a published report. Follow the public corrections
  policy and append-only ledger.
- Never add raw secrets, cookie or storage values, personal data, sensitive URL
  parameters, or screenshots to a committed report.
- Cite tracker/service catalog additions and document confidence, ownership,
  license, and review date.

## Pull requests

Keep pull requests focused and explain:

- what user or evidence problem the change solves;
- which public claims or data contracts change;
- how the change was tested;
- any migration, deployment, privacy, security, or rollback consideration.

By contributing, you agree that your contribution is provided under the
repository's AGPL-3.0-or-later license.
