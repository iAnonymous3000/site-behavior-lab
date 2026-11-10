ARG SITE_BEHAVIOR_LAB_BUILD_COMMIT=""
ARG SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF=""

# Keep one literal, immutable external base so Docker Dependabot can update it.
# lib/toolchain-provenance.test.ts ties this tag to package.json and requires
# the digest, preventing the runtime image from drifting behind the scanner.
FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d AS playwright-base

# The digest-pinned Playwright base intentionally carries a newer runtime than
# the host/Actions authoring toolchain, and from the v1.65.0-noble base a
# newer major: Node 26 here, Node 24 there. Fail the image build if that
# immutable base ever resolves to different Node or npm bytes without a
# reviewed epoch.
#
# Production launches the headless shell in this base's own /ms-playwright:
# the runner stage below is FROM playwright-base and copies only /app from the
# build, so the deps stage's `npx playwright install chromium` never reaches
# it (and keeps a revision folder the base already completed). That folder
# must hold the build playwright-core's browsers.json names, the one CI and
# local tests install, so this stage requires exactly one headless shell in
# that revision's folder, at that exact Chrome for Testing version, before
# either stage builds on it. A base rebuilt with a newer patch under the same
# revision fails here. lib/toolchain-provenance.test.ts ties the revision and
# version to browsers.json.
#
# Both checks are one step, and this stage has no other. A step that changes
# no file still adds a layer, the same empty one each time, and the container
# package inventory refuses an image whose rootfs lists one layer twice. Every
# image built FROM this stage inherits its layers, so two checking steps here
# are two copies of that layer in the runtime image. An emulated build does
# not show it: there these commands leave Node's compile cache in /tmp, so the
# layer is not empty, while a native build leaves nothing.
RUN test "$(node --version)" = "v26.13.0" \
  && test "$(npm --version)" = "11.20.0" \
  && set -- /ms-playwright/chromium_headless_shell-1254/*/chrome-headless-shell \
  && test "$#" -eq 1 \
  && test -x "$1" \
  && test "$("$1" --version)" = "Google Chrome for Testing 158.0.8127.18"

# Dependencies depend on the lockfile and pinned base, not the source commit
# or public build identity. Keep these layers reusable when either changes;
# source checks and the application build below still receive the exact SHA.
# They form their own stage so CI can export exactly these reusable layers to
# its build cache, and not the per-commit source and check layers after them.
FROM playwright-base AS deps

# Independent ZIP interoperability checks use the system reader. Install it
# only in the build stages; the scanner runtime does not need archive tools.
#
# The apt that downloads here is the base's 2.8.3, the one CVE-2026-109518
# names (remote code execution via hard link reuse during package download
# retries, fixed in 2.8.4ubuntu0.1). So it downloads with its retries off and
# from HTTPS sources only, and a failed download fails the step. The runner
# stage's upgrade step, which does the same, says why at length.
RUN sed -i 's|^URIs: http://|URIs: https://|' /etc/apt/sources.list.d/ubuntu.sources \
  && ! grep -rqsE '^[^#]*http://' /etc/apt/sources.list /etc/apt/sources.list.d \
  && apt-get -o Acquire::Retries=0 -o APT::Update::Error-Mode=any update \
  && apt-get -o Acquire::Retries=0 install -y --no-install-recommends unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci && npx playwright install chromium

FROM deps AS build

ARG SITE_BEHAVIOR_LAB_BUILD_COMMIT
ARG SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF

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
# dns.lookup is getaddrinfo on libuv's threadpool, four threads by default and
# shared by the whole Next process. The scan proxy resolves every host a page
# reaches on it, and so does the scanned URL's preflight under its 5 s bound,
# which counts time spent queued. Two concurrent scans could pin all four
# threads on slow third-party hosts and queue the other scan's preflight past
# that bound into a refused scan.
ENV UV_THREADPOOL_SIZE=16

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
#
# The image scan refuses a base package with a HIGH or CRITICAL advisory, so
# this step upgrades exactly the packages one names to the patched Ubuntu
# version. CVE-2026-109518 (HIGH, remote code execution via hard link reuse
# during package download retries): the base ships apt and libapt-pkg6.0t64
# 2.8.3, fixed in 2.8.4ubuntu0.1. The upgrade installs no package and removes
# none. The container package ledger keys packages by upstream version, and
# the apt fix changes the version its apt and libapt-pkg6.0t64 rows key on,
# so they move with it. Drop each pin when a base digest ships its fix.
# The base already ships libssl3t64 and openssl 3.0.13-0ubuntu3.16, past
# CVE-2026-84782 (HIGH, OpenSSL), and libbrotli1 1.1.0-2ubuntu0.1, past
# CVE-2026-111497 (HIGH, an out-of-bounds write in the Brotli decoder), so
# they are not pinned; the end of this step fails the build if a base ever
# ships an older one.
#
# That check fails the image build unless every package an advisory above
# names is installed exactly once and at or past its fix: libssl3t64, openssl
# and libbrotli1, which only this check holds, and each package this step
# pins, in case a pin is dropped. dpkg-query prints the status of each copy
# it knows, so the check passes only for one copy whose status is installed:
# a missing package, one left as configuration files or half installed, and a
# second architecture's copy, whose version the read would join to the first
# one's, all stop the chain. It ends this step rather than taking a step of
# its own: a step that changes no file still adds a layer, the same empty one
# each time, the base stage's browser check already adds one, and the
# container package inventory refuses an image that lists one layer twice.
# lib/toolchain-provenance.test.ts ties this list to the pins and to those
# three packages, and keeps the check in this step.
#
# The apt that downloads in this step, and in the deps stage's step, is the
# base's 2.8.3: the fixed apt is in place only once this step's install has
# ended. CVE-2026-109518 is in that apt's download retries, so every apt-get
# that downloads in the two steps carries -o Acquire::Retries=0, and the
# retry path stays off until the fixed apt is the one downloading. apt's
# built-in default is 3 retries and no file in the base sets another, so
# until this was added the build let the vulnerable apt retry. With retries
# off, a download that fails fails the step. That is the intended trade:
# build again. apt-get update would not keep it by itself: it exits 0 when
# an index fails to download, and the install after it then reads whatever
# indexes did arrive. So each apt-get update also carries
# -o APT::Update::Error-Mode=any, and one failed index fails the command:
# with retries off, a failed index must fail the step, not thin the package
# lists silently. The step is not retried from the shell either: a second
# attempt in the same layer would meet whatever files the first left behind,
# and reuse of what an earlier attempt left is what the advisory names.
#
# The base's Ubuntu sources are plain http. Each of the two steps first
# moves them to https, then fails if any apt source still names http://, so
# the vulnerable apt fetches only from hosts whose certificate it checked
# and a base whose sources the rewrite misses cannot leave it on plain http
# unseen. The base ships ca-certificates; without it the fetch fails, and
# nothing falls back to http. The runtime image keeps the https sources.
# Drop the option with the apt pin, when a base ships the fixed apt:
# lib/toolchain-provenance.test.ts requires it while the pin stands, and at
# any time refuses a retry count above 0 and a plain http apt source.
RUN sed -i 's|^URIs: http://|URIs: https://|' /etc/apt/sources.list.d/ubuntu.sources \
  && ! grep -rqsE '^[^#]*http://' /etc/apt/sources.list /etc/apt/sources.list.d \
  && apt-get -o Acquire::Retries=0 -o APT::Update::Error-Mode=any update \
  && apt-get -o Acquire::Retries=0 install -y --no-install-recommends --only-upgrade \
    apt=2.8.4ubuntu0.1 libapt-pkg6.0t64=2.8.4ubuntu0.1 \
  && apt-get purge -y gstreamer1.0-plugins-bad libgstreamer-plugins-bad1.0-0 \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/lib/node_modules /usr/local/lib/node_modules \
  && rm -f /usr/bin/npm /usr/bin/npx /usr/bin/corepack /usr/bin/yarn /usr/bin/yarnpkg \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && ! command -v npm && ! command -v npx && ! command -v yarn && ! command -v corepack \
  && test "$(dpkg-query -W -f='${db:Status-Status}' libssl3t64)" = installed \
  && v=$(dpkg-query -W -f='${Version}' libssl3t64) \
  && dpkg --compare-versions "$v" ge 3.0.13-0ubuntu3.16 \
  && test "$(dpkg-query -W -f='${db:Status-Status}' openssl)" = installed \
  && v=$(dpkg-query -W -f='${Version}' openssl) \
  && dpkg --compare-versions "$v" ge 3.0.13-0ubuntu3.16 \
  && test "$(dpkg-query -W -f='${db:Status-Status}' libbrotli1)" = installed \
  && v=$(dpkg-query -W -f='${Version}' libbrotli1) \
  && dpkg --compare-versions "$v" ge 1.1.0-2ubuntu0.1 \
  && test "$(dpkg-query -W -f='${db:Status-Status}' apt)" = installed \
  && v=$(dpkg-query -W -f='${Version}' apt) \
  && dpkg --compare-versions "$v" ge 2.8.4ubuntu0.1 \
  && test "$(dpkg-query -W -f='${db:Status-Status}' libapt-pkg6.0t64)" = installed \
  && v=$(dpkg-query -W -f='${Version}' libapt-pkg6.0t64) \
  && dpkg --compare-versions "$v" ge 2.8.4ubuntu0.1

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
