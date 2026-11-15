# S4 fixture runner, one image per recorder candidate. Local only, never pushed.
#
# There is deliberately no "# syntax=" line: that would make BuildKit pull a
# Dockerfile frontend image. The built-in frontend supports RUN --mount.
#
# Build (see COMMANDS.md for the exact command): networking off for every
# step (--network=none), the build context is this folder only, and the
# approved downloads arrive as a read-only named context "dl". Nothing is
# fetched; a step that needs a file it does not have fails the build.
#
# The base is a local-only tag of the scanner's pinned base, the same image
# as Dockerfile's playwright-base (digest 6e3fb709...). A local-only tag has
# no registry, so if BuildKit tried to resolve it remotely the build would
# fail instead of pulling. COMMANDS.md checks the tag's image id first.
FROM sbl-s4-runner-base:6e3fb709

ARG TARGETARCH
ARG REA_VERSION

USER root

# The second Node, from the verified archive. Its SHA-256 (from the
# SHASUMS256.txt whose signature was checked against nodejs/release-keys at
# 481637f8, signer 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356) is compared again
# here, inside the build, before the archive is opened. The base has no xz
# binary, so the base's own Python unpacks it, with the "data" filter that
# refuses links and paths outside the target.
RUN --mount=type=bind,from=dl,source=node,target=/dl-node \
    case "$TARGETARCH" in \
      arm64) a=arm64; h=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c ;; \
      amd64) a=x64;   h=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb ;; \
      *) echo "unsupported arch $TARGETARCH"; exit 1 ;; \
    esac \
  && echo "$h  /dl-node/node-v24.22.3-linux-$a.tar.xz" | sha256sum -c - \
  && python3 -I -c "import tarfile,sys; tarfile.open(sys.argv[1],'r:xz').extractall('/opt', filter='data')" "/dl-node/node-v24.22.3-linux-$a.tar.xz" \
  && mv "/opt/node-v24.22.3-linux-$a" /opt/rea-node \
  && test "$(/opt/rea-node/bin/node --version)" = "v24.22.3" \
  && test "$(sha256sum /opt/rea-node/bin/node | cut -d' ' -f1)" = "$(case "$a" in arm64) echo 8f9c2a55879e9705cb285b6cdd649d95df642c6720f052cb30f300d2677da99f ;; x64) echo a7ec1b37e6ff9d187e4198c5b6df9a4eb1c74dd31804fb3bac55cc4ceca1ac01 ;; esac)"

# The recorder, from the approved tarballs only. Each tarball is added to an
# empty npm cache by file; npm ci then runs offline with lifecycle scripts off
# and empty user and global config, so it has no registry to ask. npm checks
# every tarball against the lockfile's integrity. Optional packages that were
# not downloaded (frida, the darwin and win32 prebuilds, the other Linux
# arch) must be skipped; if this npm fails on them offline instead, the build
# stops here and the question goes back, with no change to the approved list.
WORKDIR /opt/rea
COPY package-${REA_VERSION}.json ./package.json
COPY package-lock-${REA_VERSION}.json ./package-lock.json
RUN --mount=type=bind,from=dl,source=npm,target=/dl-npm \
    --mount=type=tmpfs,target=/tmp/rea-cache \
    export PATH=/opt/rea-node/bin:/usr/bin:/bin \
      npm_config_cache=/tmp/rea-cache \
      npm_config_userconfig=/tmp/rea-cache/empty-userconfig \
      npm_config_globalconfig=/tmp/rea-cache/empty-globalconfig \
      npm_config_update_notifier=false \
      npm_config_audit=false \
      npm_config_fund=false \
      npm_config_ignore_scripts=true \
  && : > /tmp/rea-cache/empty-userconfig && : > /tmp/rea-cache/empty-globalconfig \
  && for f in /dl-npm/*.tgz; do npm cache add "$f" --offline || exit 1; done \
  && npm ci --offline --ignore-scripts \
  && test "$(node -p "require('/opt/rea/node_modules/rea-agents/package.json').version")" = "$REA_VERSION" \
  && test ! -e node_modules/frida \
  && case "$TARGETARCH" in arm64) p=arm64 ;; amd64) p=x64 ;; esac \
  && test -f "node_modules/@lydell/node-pty-linux-$p/pty.node" \
  && chown -R root:root /opt/rea && chmod -R a-w /opt/rea /opt/rea-node

# The harness: a fixture server, an allow-one-origin guard proxy and the
# driver. They run on the base's own Node (26.13.0), not on the recorder's.
COPY harness/ /opt/harness/
RUN chmod -R a-w /opt/harness

# Process environment for every container. Nothing comes from the host.
# NO_UPDATE_NOTIFIER and CI suppress the CLI framework's detached update
# check (incur 0.6.1 internal/update.js), which would otherwise fetch from
# the npm registry.
ENV HOME=/tmp/home \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp/cache \
    NO_UPDATE_NOTIFIER=1 \
    CI=1 \
    REA_VERSION=${REA_VERSION} \
    SBL_CHROMIUM=/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux-arm64/chrome-headless-shell

USER pwuser
WORKDIR /tmp
# The wall-clock limit is part of the run itself: timeout is PID 1 and kills the driver, and with it
# the container and everything in it, after 30 minutes. The host-side docker kill is a second limit.
ENTRYPOINT ["/usr/bin/timeout", "-s", "KILL", "1800", "/usr/bin/node", "/opt/harness/run-fixtures.mjs"]
