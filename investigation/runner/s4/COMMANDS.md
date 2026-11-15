# S4 runner: the commands as they ran (2026-11-14 and 2026-11-15)

Status. Every command below has run on the owner's go, locally, on linux/arm64 only, with the recorder
release confirmed by the owner afterwards as 6.8.0. CI does not build this image or run any fixture: CI runs
only the harness tests (`npm run test:investigation-runner`) and the adapter tests on recorded output. The
image is built by hand from the approved downloads, which are not in the repository, and is pushed nowhere.

- Builder: `desktop-linux` (the current Docker context's own builder, docker driver).
- Plans that ran: `plans/phase-b.json` (25 steps) and `plans/follow-up.json` (22 steps), for both
  candidates. Runs: phase A (schemas) both; phase B first attempt for 6.8.0 stopped by the wall clock with no
  output (a harness defect, since fixed: progress copied out after every step, a deadline on every driver
  wait); phase B rerun and the follow-up, both candidates, no stop.
- Image ids, last build: 6.8.0 `096ba8bb3d48`, 6.7.0 `abed75d588e9` (base `6e3fb709`).


Recorder: rea-agents 6.8.0, one image. The 6.7.0 fallback was built and run as well (above).
The 6.7.0 package files were removed on 2026-11-15, and the recorded 6.7.0 runs remain, in
`investigation/test/recorded/rea-6.7.0/`.
Browser: the base's `chromium_headless_shell-1254`, Chrome for Testing 158.0.8127.18.
Machine: Docker Desktop VM, linux/arm64, 10 CPUs, 7.7 GiB.

Variables used below, which a reader sets to absolute paths of their own (nothing else from the host). The
commands ran on 2026-11-14 with these three set to local folders outside the repository.

```
CTX=<your checkout>/investigation/runner/s4   # this folder, the build context
DL=<a new empty folder outside the repository, holding the approved downloads>
RUNS=<a new empty folder outside the repository, for the plans and run outputs>
BASE=mcr.microsoft.com/playwright@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d
```

## 0. Before each build or run

1. Check that no other heavy job (a test gate, another build or browser run) is running on the machine.
2. `docker image inspect "$BASE" --format '{{.Id}}'` prints
   `sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d` (present locally; nothing pulled).
3. `docker tag "$BASE" sbl-s4-runner-base:6e3fb709` (a local-only name, so nothing can resolve it remotely).

## 1. Build (two images, networking off for every step)

```
docker buildx build --builder desktop-linux --network=none --pull=false \
  --provenance=false --sbom=false \
  --build-context dl="$DL" \
  --build-arg REA_VERSION=6.8.0 \
  -t sbl-s4-runner:6.8.0 --load "$CTX"
```

The build context is `$CTX` only (Dockerfile, the two package files, `harness/`), never the repository root.
The downloads arrive read-only as the named context `dl` and are bind-mounted into two RUN steps; they never become a layer.

The build stops, with no retry and no change to the approved list, if: the base tag cannot be used without a
registry; the Node archive's SHA-256 or its `bin/node` SHA-256 differs; `npm cache add` or `npm ci --offline`
needs anything not in `$DL/npm` (above all, if npm fails on the optional packages that were not downloaded instead
of skipping them); `frida` appears; the arch's `pty.node` is missing.

Afterwards: `docker image ls sbl-s4-runner` and record both image ids. The images are never pushed.

## 2. Run, phase A: schemas only (the first recorder processes)

One container per candidate. No browser, no fixture server, no page. It runs `rea --version --json` and
`rea <command> --schema --json` for the 11 website commands, so phase B's flags come from the recorder's own
schema rather than a guess.

```
mkdir "$RUNS/A-6.8.0"          # must be new and empty
docker run --rm --name s4-A-680 \
  --network none --read-only \
  --tmpfs /tmp:rw,size=512m,mode=1777 --tmpfs /work:rw,size=512m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges --user 1001:1001 \
  --memory 4g --memory-swap 4g --cpus 2 --pids-limit 1024 --shm-size 256m \
  -v "$RUNS/A-6.8.0":/out:rw \
  sbl-s4-runner:6.8.0 schema
```

Wall clock: the in-image 30-minute kill applies; in a second shell, `sleep 600; docker kill s4-A-680` (phase A needs seconds; ten minutes is the kill).

Then, before phase B, `plan.json` is written from the schemas and reviewed, and it is mounted read-only.

## 3. Run, phase B: fixtures

```
mkdir "$RUNS/B-6.8.0"          # new and empty
docker run --rm --name s4-B-680 \
  --network none --read-only \
  --tmpfs /tmp:rw,size=512m,mode=1777 --tmpfs /work:rw,size=512m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges --user 1001:1001 \
  --memory 4g --memory-swap 4g --cpus 2 --pids-limit 1024 --shm-size 256m \
  -v "$RUNS/plan-6.8.0.json":/in/plan.json:ro \
  -v "$RUNS/B-6.8.0":/out:rw \
  sbl-s4-runner:6.8.0 fixtures
```

Wall clock: the image's ENTRYPOINT is `timeout -s KILL 1800`, so the run kills itself after 30 minutes; `sleep 1900; docker kill s4-B-680` in a second shell is a second limit.

Mounts are exactly: the plan file read-only, the new output folder. No repository, no home folder, no Docker
socket, no `-e` or `--env-file`. The image's ENV and the driver's literal environment are the whole environment.

## 4. Inside the container (phase B)

All on loopback: fixture origin `http://127.0.0.1:8081`, guard proxy `127.0.0.1:8899`, Chromium remote debugging
`127.0.0.1:9222`.

Chromium is started by the driver as the scanner starts it: the 46 switches the scanner's Playwright 1.65.0
passes, captured from the browser's own argv (`harness/chromium-args.mjs`), with these changes, reported before
use:
- removed `--remote-debugging-pipe` (Playwright's control channel; no Playwright here)
- removed `--no-startup-window` (the recorder needs a page target; the browser opens `about:blank`)
- `--remote-debugging-port=9222` (the scanner reserves a free loopback port)
- `--user-data-dir=/tmp/profile-<time>`
- added `--proxy-server=http://127.0.0.1:8899` and `--proxy-bypass-list=<-loopback>` (the scanner applies the same
  routing per context through Playwright, `proxy: { server, bypass: "<-loopback>" }`)

One further launch path the recorder has: `trace-web-module-imports` starts its own Chromium through its
playwright-core 1.58.2 with `executablePath` set to the same headless shell (`REA_BROWSER_EXECUTABLE`). Its switch
set is Playwright 1.58.2's, which differs from 1.65.0's: a static read of both switch lists shows additions and
removals, but 1.58.2's exact argv has not been captured, and some switches are conditional. That command
runs only where a launch the scanner does not make is accepted, and its result is recorded as such.

The recorder runs as `/opt/rea-node/bin/node .../rea.mjs <command> ... --json` with a literal environment:
`PATH`, `HOME=/tmp/home`, `TMPDIR=/tmp`, `XDG_CACHE_HOME=/tmp/cache`, `NO_UPDATE_NOTIFIER=1`, `CI=1`,
`NODE_USE_ENV_PROXY=1`, `HTTP(S)_PROXY=http://127.0.0.1:8899`, `NO_PROXY=127.0.0.1:9222`,
`REA_BROWSER_EXECUTABLE`. The proxy variables make any fetch the recorder's own Node makes visible in the guard
log.

## 5. Fixture list, first run (per candidate)

| # | Name | Page | Commands | Shows |
|---|---|---|---|---|
| 1 | **control** | `control.html` | `observe-web-execution` (5 s window), `inspect-web-page` | Runs against Chrome 158 at all; window ends `window_elapsed`; functions reported, with V8's block-coverage flag true for `branchy` and recorded as reported for `once` |
| 2 | negative-column | `negative-column.html` | `observe-web-execution` | Exploratory reproduction of the October `startColumn` refusal; a typed outcome, or recorded as not reproduced |
| 3 | source-budget | `source-budget.html` (33 MiB script) | `observe-web-execution`, `export-web-scripts` | The 32 MiB refusal, its outcome type, and that other facts are kept |
| 4 | post-budget | `post-budget.html` (9 MiB POST) | `observe-web-execution` | Issue 6474 at this release |
| 5 to 8 | signals | `control.html` | `observe-web-execution` (20 s window) with SIGINT at 3 s; SIGTERM at 3 s; `Page.crash` at 3 s; browser killed at 3 s | Outcome and cleanup for each |
| 9 | emulation | `emulation.html` | `inspect-web-page` | The driver's timezone override still holds after the recorder detaches |
| 10 | workers | `workers.html` | `observe-web-execution`, `inspect-web-page` | No worker-session data; worker inventory only |
| 11 | commands | `commands.html` | each delivered command once: `inspect-web-page`, `capture-web-screenshot`, `export-web-scripts`, `analyze-web-bundle`, `trace-web-source-location`, `trace-web-module-imports`, `observe-web-session`, `compare-web-captures`, `compare-web-screenshots`, `capture-browser-scenario` (connect mode) | Each runs and its output shape is recorded |
| 12 | egress-probe (last) | `egress-probe.html` | `inspect-web-page` | Three deliberate off-origin attempts reach the guard and are refused |

## 6. Limits and what stops a run at once (no retry)

| Limit | Value | Reason |
|---|---|---|
| Memory | 4 GiB, no swap | tmpfs counts against it: `/tmp` 512 MiB + `/work` 512 MiB + shm 256 MiB = 1.25 GiB, leaving about 2.75 GiB for Chromium and two Nodes, one of which handles 64 MiB protocol messages and a 33 MiB script. The VM has 7.7 GiB shared with other sessions |
| CPU | 2 | One page, one recorder at a time; leaves 8 of 10 for the rest of the machine |
| Processes | 1024 | The cgroup counts threads: Chromium's processes and threads run to a few hundred, each Node about twenty |
| Wall clock | 30 minutes, in the image (`timeout -s KILL 1800`), plus a host `docker kill` | 24 recorder invocations in the plan (control 2, negative column 1, source budget 2, POST 1, signals 4, emulation 1, workers 2, commands 10, probe 1) at the 60 s per-invocation deadline is 24 minutes worst case, plus 12 navigations of 1.5 s and browser restarts |
| Output | `/work` tmpfs 512 MiB, 64 MiB stdout per invocation | My proposal: the plan sets no output-folder budget. Its only figures are the recorder's own fixed budgets (6.8.0 `WEB_RUNTIME_LIMITS`): source 32 MiB, retained events 8 MiB, protocol 64 MiB |

Stops:

- A guard refusal in any fixture other than 12 (`connection-outside-fixture-origin`).
- A recorder invocation's stdout over 64 MiB, or a write to `/work` failing (the 512 MiB tmpfs is full).
- The 30-minute kill, or a browser exit not caused by fixtures 5 to 8, twice.
- The control fixture failing: `control-failed`, which goes to the owner as the second-browser decision.
- A recorder invocation past its 60 s deadline is killed and recorded; it does not by itself stop the run.
- A resolver or socket failure (`EAI_AGAIN`, `ENOTFOUND`, `ENETUNREACH`, `EHOSTUNREACH`, `ECONNREFUSED`, `ETIMEDOUT`) naming a non-loopback host in a recorder's stderr (`connection-attempt-in-stderr`). Under `--network none` a direct attempt fails without reaching the guard, so this is the second detector; a raw socket that fails silently is not seen by either.

A stop kills the running recorder and the browser with SIGKILL at once (`harness/run-control.mjs`), writes `STOPPED.json` with the reason, starts nothing else, then copies `/work` to `/out` and exits 3.

## 7. Afterwards

The output is untrusted data: read as bounded JSON or text with my own scripts, never executed, never opened in
a browser on the host. No real site at any point.
