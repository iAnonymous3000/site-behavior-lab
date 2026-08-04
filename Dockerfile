ARG SITE_BEHAVIOR_LAB_BUILD_COMMIT=""
ARG SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF=""

# Keep one literal, immutable external base so Docker Dependabot can update it.
# lib/toolchain-provenance.test.ts ties this tag to package.json and requires
# the digest, preventing the runtime image from drifting behind the scanner.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS playwright-base

# The digest-pinned Playwright base intentionally carries a newer runtime than
# the host/Actions authoring toolchain. Fail the image build if that immutable
# base ever resolves to different Node or npm bytes without a reviewed epoch.
RUN test "$(node --version)" = "v24.18.1" \
  && test "$(npm --version)" = "11.16.0"

FROM playwright-base AS build

ARG SITE_BEHAVIOR_LAB_BUILD_COMMIT
ARG SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV SITE_BEHAVIOR_LAB_BUILD_COMMIT=${SITE_BEHAVIOR_LAB_BUILD_COMMIT}
ENV SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF=${SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF}

# Every production image must identify the exact source revision that built it.
# The deploy wrapper supplies Workers Builds' tested commit (or local HEAD);
# rejecting empty/placeholders keeps health and future v2 provenance honest.
RUN node -e "const value=process.argv[1]; if(!/^[0-9a-f]{40}$/.test(value)) throw new Error('SITE_BEHAVIOR_LAB_BUILD_COMMIT must be a full lowercase Git SHA')" "${SITE_BEHAVIOR_LAB_BUILD_COMMIT}"
RUN node -e "const value=process.argv[1]; if(value && (value.length>4096 || !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error('SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF must be empty or one bounded base64url proof')" "${SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF}"

# Public origin baked into the build so shared live-scan report links unfurl with
# their Open Graph / X card. NEXT_PUBLIC_ vars are inlined by `next build`, so a
# runtime env cannot change it, and Cloudflare Workers Builds builds this image
# without passing a --build-arg, so the default below is what ships. Defaults to
# this deployment's scanner origin; override with --build-arg for a self-host, or
# set "" to omit the card image (links still render the report).
ARG NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL="https://scan.sitebehavior.org"
ENV NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=${NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL}

# Public Turnstile site key, inlined into the client bundle the container also
# serves. The scanner enforces Turnstile, so without this the scan form on the
# container origin (including on shared /reports/:id pages) shows a "no site
# key" error and cannot scan. As with SITE_URL, NEXT_PUBLIC_ vars are inlined at
# build time and Workers Builds passes no --build-arg, so this default is what
# ships. Turnstile *site* keys are public (rendered to every visitor); only the
# secret key is server-side. Self-hosts on another domain override with their own.
ARG NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY="0x4AAAAAADo4etedrrGyi43a"
ENV NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY=${NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY}

# Public evidence-library origin, inlined into the client bundle. The container's
# /status/ page fetches <origin>/deployment.json to compare the live site and
# scanner revisions, so a self-host that leaves the default in place compares
# its own revision against sitebehavior.org and reports "degraded" for an
# unrelated project's deploy. Override with --build-arg to your own Pages
# origin. Scheme and host only.
ARG NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN="https://sitebehavior.org"
ENV NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN=${NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN}

COPY package.json package-lock.json ./
RUN npm ci && npx playwright install chromium

COPY . .
# .next/cache is the build's SWC and webpack cache, not runtime state: Next
# recreates what it needs. Left in place it crosses the stage boundary with the
# wholesale .next copy below and ships in the runtime image, where it is by far
# the largest thing present and is never read.
RUN npm run check && rm -rf .next/cache && npm prune --omit=dev

FROM playwright-base AS runner

ARG SITE_BEHAVIOR_LAB_BUILD_COMMIT

# Standard OCI labels make the locally tested image independently inspectable.
# The release-evidence gate requires this revision to match clean Git HEAD and
# the runtime health identity; labels never substitute for live deployment
# readback or proof of the separately configured Cloudflare deployment path.
LABEL org.opencontainers.image.title="Site Behavior Lab" \
  org.opencontainers.image.source="https://github.com/iAnonymous3000/site-behavior-lab" \
  org.opencontainers.image.revision="${SITE_BEHAVIOR_LAB_BUILD_COMMIT}" \
  org.opencontainers.image.licenses="AGPL-3.0-or-later"

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV SITE_BEHAVIOR_LAB_REPORT_STORE_DIR=/var/lib/site-behavior-lab/reports
ENV SITE_BEHAVIOR_LAB_BUILD_COMMIT=${SITE_BEHAVIOR_LAB_BUILD_COMMIT}

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/lib/adblock-wasm ./lib/adblock-wasm
COPY --from=build /app/public ./public
COPY --from=build /app/scripts/public-build-commit.mjs ./scripts/public-build-commit.mjs
COPY --from=build /app/next.config.mjs ./next.config.mjs

# The runtime serves the already-built app with node alone. Remove the base
# image's global package managers (their bundled tar, undici, and sigstore
# copies are exactly the kind of fixed-upstream vulnerable code this image
# would otherwise ship without ever executing) and the WebKit-only GStreamer
# "bad" plugin set that the Chromium-only scanner never loads. The build stage
# above still uses the base's npm; this stage must end with no package manager
# at all, and container release evidence independently asserts that absence.
RUN apt-get purge -y gstreamer1.0-plugins-bad libgstreamer-plugins-bad1.0-0 \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/lib/node_modules /usr/local/lib/node_modules \
  && rm -f /usr/bin/npm /usr/bin/npx /usr/bin/corepack /usr/bin/yarn /usr/bin/yarnpkg \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && ! command -v npm && ! command -v npx && ! command -v yarn && ! command -v corepack

# Scans open attacker-controlled pages, so the runtime must not be root. The
# scanner also launches Chromium with an explicit environment allowlist, so its
# child processes do not inherit R2, Turnstile, or access-token secrets from the
# Next process. pwuser ships with the Playwright base image; .next needs
# ownership because `next start` writes .next/cache.
RUN mkdir -p /var/lib/site-behavior-lab/reports \
  && chown -R pwuser:pwuser /var/lib/site-behavior-lab/reports /app/.next
VOLUME ["/var/lib/site-behavior-lab/reports"]
USER pwuser

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
