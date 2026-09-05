# Native Brave Shields Differential

## Purpose

Site Behavior Lab's public Shields comparison is a controlled Playwright
Chromium intervention using the vendored `adblock-rust` engine and a pinned
snapshot of Brave's default filter lists. Its counts describe that simulation.
They do not establish actual Brave behavior or a lower bound on its blocking.
This differential runner can supply independent diagnostic observations, but
its existence does not establish representative accuracy.

Brave exposes a browser-only CDP event,
`Network.requestAdblockInfoReceived`, for a request that the native engine
blocked or allowed through a matched exception. This research runner captures
that event from a disposable Brave session and compares it with Site Behavior
Lab's boolean `would block` decision for the correlated ordinary CDP request.
The result is a companion diagnostic receipt. It is not a ScanReport producer,
does not enter the public corpus, and does not change the frozen v2/r2 wire.

Primary source:

- Brave protocol type and event:
  <https://github.com/brave/brave-core/blob/df5bd689d4b9b9e32d50d6d118f6688f00fadd03/chromium_src/third_party/blink/public/devtools_protocol/browser_protocol.pdl#L28-L47>
- Brave event-population path:
  <https://github.com/brave/brave-core/blob/04d22c890676332d280dcb3f86d12905577f1480/browser/net/brave_ad_block_tp_network_delegate_helper.cc#L251>
- Small reference debugger:
  <https://github.com/ShivanKaul/brave-adblock-cdp-debugger>

## Run

```sh
npm run shields:native-diff -- \
  --url https://example.com \
  --output /tmp/native-shields-example.json \
  --brave "/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly" \
  --label brave-nightly
```

`--brave` is optional when Stable, Beta, or Nightly is installed at a standard
macOS or Linux path. The runner is headless by default; pass `--headed` when a
browser build does not expose native Shields behavior headlessly. Use
`npm run shields:native-diff -- --help` for the bounded dwell and navigation
options.

For repeated measurements, give the runner a dedicated profile that is not a
normal Brave profile:

```sh
npm run shields:native-diff -- \
  --url https://example.com \
  --output /tmp/native-shields-example-1.json \
  --profile-dir /tmp/sbl-brave-research-profile
```

The first run creates an ownership marker. Later runs may reuse only a marked
directory. The runner refuses Brave's standard user-data roots and any
pre-existing non-empty unmarked directory, preventing accidental reuse of
personal browser state. Reuse allows Brave's component-backed filter state to
initialize across runs; receipts still label its effective configuration as
unverified. A brand-new profile can therefore produce an `inconclusive`
zero-event receipt on its first run. That receipt is valid evidence of the
observation, not evidence that Shields allowed the requests; repeat the same
preregistered target with the marked profile before treating native capture as
demonstrated.

The command:

1. Rejects non-public, non-HTTP(S), credential-bearing, and non-standard-port
   targets using the repository's URL guard.
2. Hashes the exact browser launcher and runtime binary. On macOS the latter is
   the versioned Brave framework binary loaded by the small app launcher.
3. Launches Brave with either a disposable persistent profile or an explicitly
   marked dedicated research profile (isolated equivalents of the normal tab
   used by the reference extension) and routes every network connection
   through Site Behavior Lab's connect-time public-address proxy. The launcher
   retains Brave's component and extension behavior instead of Playwright's
   generic component-disabling defaults. Temporary profiles are removed after
   the browser closes.
4. Enables the ordinary CDP Network and Page domains and listens for Brave's
   extension event without installing the debugger extension.
5. Keeps raw URLs and request ids only in process memory. The receipt contains
   default-deny redacted URLs and a SHA-256 request-id join key.
6. Writes the destination with mode `0600` and refuses to overwrite it.

## Receipt contract

The authoritative validator and builder are in
`lib/native-shields-differential.ts`. The closed root identity is:

```json
{
  "schemaVersion": 1,
  "artifactKind": "site-behavior-native-shields-differential"
}
```

Each native event records:

- a per-capture salted digest of the CDP request id, which groups events within
  one receipt and is deliberately not comparable across receipts, and whether an
  ordinary request correlated. A record correlates only when it carries the same
  URL the native engine checked, because CDP reuses one request id across every
  redirect hop;
- redacted request, checked, and optional rewritten URLs;
- redacted source host, resource type, method, and whether the native engine
  checked a different hostname;
- native block, exception, important-rule, aggressive, mock, and rewrite flags;
- the local boolean result for the request URL and, when different, the native
  checked URL; and
- an agreement category such as `agrees-block`,
  `native-block-local-canonical-match`, `native-block-local-miss`, or a native
  exception category.

Brave can block early enough that no ordinary `Network.requestWillBeSent`
record is emitted. Such an event remains explicitly uncorrelated. The local
comparison may use the native event's source host and resource type as a
labeled `native-source-host` fallback, while the missing request-level join
still makes the overall receipt `partial`.

Coverage counters disclose uncorrelated native events, proxy blocks/resource
caps, and ordinary request records for which no native event was seen. That last
count is only coverage: it is never an allowed-request count. Discards are
counted in two separate families, because they are different evidence:
`droppedNetworkRequestRecords`/`droppedNativeEvents` mean a retention ceiling was
reached and the capture can be re-run with a higher bound, while
`unparsableNetworkRecords`/`unparsableNativeEvents` mean this parser refused a
payload, which is possible schema drift worth investigating.

Receipt `status` is derived by one exported function that both the builder and
the receipt validator call, so the two cannot word the rule differently:

- `complete` when at least one event was captured, the local engine was
  available, and no declared capture loss occurred;
- `partial` when events exist but navigation, proxy, capture, or local-engine
  evidence is incomplete; or
- `inconclusive` when no native event was observed.

Capture loss includes any event Brave itself flagged as mock data, and any event
whose resource type this project's vocabulary did not recognise. Both would
otherwise let a receipt claim `complete` while resting on synthetic data or on a
request type that was guessed.

## Interpretation limits

The Brave source emits the event only for a native block or a matched
exception. Therefore:

- no event does **not** mean the request was allowed;
- the event stream is not a denominator for false-positive or false-negative
  rates;
- the temporary profile's exact effective Shields/list configuration is not
  read back or attested; and
- a fresh profile's component readiness is not attested, so the first run can
  be inconclusive even when a later run captures native events; and
- the Site Behavior Lab side remains a boolean `would block` answer, so a
  local non-block cannot distinguish a list miss from an exception; and
- `checkedHostDiffers` is named for what is observed, a checked URL on a
  different host, and not for a cause. That is consistent with CNAME uncloaking
  but also with URL rewriting and redirect canonicalisation, and this receipt
  cannot separate them.

The mandatory safety proxy is also methodologically important. Brave's native
CNAME-uncloaking implementation may skip its separate DNS resolution when a
proxy is configured. A receipt can faithfully record a differing `checkedUrl`
when Brave supplies one, but a lack of such events under this runner is not
evidence that native CNAME uncloaking never applies. A future direct-network
lane requires a separately proven external egress boundary; this CLI offers no
unsafe bypass.

Finally, this is regression and parity evidence, not an absolute oracle. Site
behavior, Brave component state, browser channel, region, and time can all move
the observed result. Repeated Stable/Nightly runs over a preregistered roster
are required before using the receipts to justify a methodology change.
