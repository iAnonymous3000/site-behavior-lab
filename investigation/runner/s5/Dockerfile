# S5c fixture runner image: the S4 6.8.0 runner image (the recorder, its own Node 24.22.3 checked by
# checksum there, Chromium build 1254 and the S4 harness), plus the scanner (lib/ of one commit,
# transpiled per file), the two core modules the runner reads events with, and the S5c runner with
# its fixture entry. Local only, never pushed, built with networking off. A fixture image only: the
# production entry is not copied in (G-6).
#
# No "# syntax=" line, so BuildKit pulls no frontend image. The base is named by its own repo digest
# and has no registry, so a remote resolve fails instead of pulling.
#
# Named contexts, each read-only through a bind mount or a COPY:
#   scn : the six npm tarballs the scanner graph needs, copied from the host npm cache.
#   src : lib/, investigation/core/, package.json and package-lock.json of the named commit.
FROM sbl-s4-runner:6.8.0@sha256:096ba8bb3d48bbe598887bfbd1339e33579621d315e56dc745ff35fcd9b1ce21

ARG BUILD_COMMIT
ARG IDENTITY_DIGEST
ARG RECORDER_RELEASE=6.8.0

USER root

# The recorder this image runs is the base's, checked here so a base with another release fails the
# build rather than running under this image's name.
RUN test "$(/opt/rea-node/bin/node -p "require('/opt/rea/node_modules/rea-agents/package.json').version")" = "$RECORDER_RELEASE" \
  && test "$(/opt/rea-node/bin/node --version)" = "v24.22.3" \
  && test -f /opt/harness/guard-proxy.mjs

# The scanner's packages, installed offline from the six tarballs with the base's own npm and
# lifecycle scripts off, so playwright's install script never runs and no browser is fetched. npm
# checks every tarball against the lock's integrity.
WORKDIR /opt/scanner
COPY steps/package-1.65.0.json ./package.json
COPY steps/package-lock-1.65.0.json ./package-lock.json
RUN --mount=type=bind,from=scn,target=/dl-scn \
    --mount=type=tmpfs,target=/tmp/scn-cache \
    export npm_config_cache=/tmp/scn-cache \
      npm_config_userconfig=/tmp/scn-cache/empty-userconfig \
      npm_config_globalconfig=/tmp/scn-cache/empty-globalconfig \
      npm_config_update_notifier=false npm_config_audit=false npm_config_fund=false \
      npm_config_ignore_scripts=true \
  && : > /tmp/scn-cache/empty-userconfig && : > /tmp/scn-cache/empty-globalconfig \
  && test "$(npm --version)" = "11.20.0" && test "$(node --version)" = "v26.13.0" \
  && for f in /dl-scn/*.tgz; do npm cache add "$f" --offline || exit 1; done \
  && npm ci --offline --ignore-scripts \
  && test "$(node -p "require('/opt/scanner/node_modules/playwright-core/package.json').version")" = "1.65.0"

# The scanner's source and the two core modules, from the named commit, and the per-file transpile.
# lib/ keeps its place because the scanner reads lib/adblock-wasm and lib/trust-kernel-wasm relative
# to the working directory. Then the reference set, from the transpiled modules themselves.
COPY --from=src lib/ /opt/scanner/lib/
COPY --from=src investigation/core/ /opt/scanner/investigation/core/
COPY --from=src package-lock.json /opt/scanner/commit-package-lock.json
COPY steps/check-and-transpile.cjs steps/reference-set.cjs /opt/scanner-build/
RUN node /opt/scanner-build/check-and-transpile.cjs /opt/scanner \
  && node -e "const s=require('/opt/scanner/dist/lib/scanner.js'); if (typeof s.scanSiteWithMeasurement!=='function'||typeof s.closeSharedBrowserForTests!=='function') process.exit(1)" \
  && mkdir -p /opt/s5 \
  && node /opt/scanner-build/reference-set.cjs /opt/scanner /opt/s5/reference-set.json \
  && chown -R root:root /opt/scanner && chmod -R a-w /opt/scanner

# The runner, the fixture entry and its stand-in, the fixture pages and plans. The production entry
# (entry-production.mjs, beside this file) is not copied: no COPY names it.
COPY runner/ /opt/s5/runner/
COPY fixture/ /opt/s5/fixture/
COPY plans/ /opt/s5/plans/
COPY recorder-domains-6.8.0.json /opt/s5/
RUN test -z "$(find /opt/s5 -name 'entry-production*')" \
  && for f in /opt/s5/runner/*.mjs /opt/s5/fixture/*.mjs; do node --check "$f" || exit 1; done \
  && printf '{"buildCommit":"%s","identityDigest":"%s","recorderRelease":"%s"}\n' "$BUILD_COMMIT" "$IDENTITY_DIGEST" "$RECORDER_RELEASE" > /opt/s5/build.json \
  && node -e "const b=require('/opt/s5/build.json'); if (!/^[0-9a-f]{40}$/.test(b.buildCommit) || !/^[0-9a-f]{64}$/.test(b.identityDigest)) { console.error('BUILD_COMMIT must be 40 hex and IDENTITY_DIGEST 64 hex'); process.exit(1); }" \
  && chown -R root:root /opt/s5 && chmod -R a-w /opt/s5

# Literal environment. Nothing comes from the host. The scanner's Playwright finds the base's headless
# shell 1254 through the base's own PLAYWRIGHT_BROWSERS_PATH.
ENV HOME=/tmp/home \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp/cache \
    NO_UPDATE_NOTIFIER=1 \
    CI=1

USER pwuser
WORKDIR /opt/scanner
# One process tree per container: timeout is PID 1 and kills the runner, and with it the container,
# after 15 minutes. The host-side docker kill is a second limit.
ENTRYPOINT ["/usr/bin/timeout", "-s", "KILL", "900", "/usr/bin/node", "/opt/s5/fixture/entry-fixture.mjs"]
