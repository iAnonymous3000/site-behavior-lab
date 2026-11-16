# Recorded recorder output (S4 fixture runs)

Copied byte for byte from the S4 fixture runs on local pages (linux/arm64, Chromium 158.0.8127.18). Read by
investigation/test/recorder-shapes-6-8-0.test.ts as data only: never executed, never opened in a browser.
Each file, its run and step, and its SHA-256:

| File | Run, step | SHA-256 |
|---|---|---|
| `rea-6.8.0/observe-control.json` | B2-6.8.0, 01-control-observe | `58c8d00674ef474b5d71c21eeaa1871d95fb6d4d3bbdc892766d261e7d1dab7d` |
| `rea-6.8.0/inspect-control.json` | B2-6.8.0, 02-control-inspect | `998ca2be87863546b239bb887dd2ec6183ad7c09909135aef7ee86c9178fa775` |
| `rea-6.8.0/failure-source-budget.json` | B2-6.8.0, 04-budget-observe | `7dc94f7406f452ad7ba43670f4b5e44fec30c6b5d4808a4e2e3edee5b75885d2` |
| `rea-6.8.0/failure-sigint.json` | B2-6.8.0, 08-signal-sigint | `f6c2a5cfab25cce4727d888b9a0a3c56ba6472d4338b056af9816e0f2104bbee` |
| `rea-6.8.0/failure-page-crash.json` | B2-6.8.0, 10-signal-crash | `c4f7a70a2213abc173921b3a1c4816a5f4ebeffc4701094bdcd6107f7bb5f080` |
| `rea-6.8.0/failure-large-post.json` | F-6.8.0, 03-post-observe | `6cc90a6fc5a0b0538f7b20094c21823e4684cf7a03963e182b7eb23f0772b8b5` |
| `rea-6.8.0/failure-input.json` | F-6.8.0, 16-compare-captures-passive | `737fd37bb9f5359f832daa2579f2795f57dd19f44b7534b931d881086f17be83` |
| `rea-6.8.0/script-manifest.json` | B2-6.8.0, 06-budget-export/manifest.json | `155f1371f589d7c5249f7ab8c279c7d136d100f6d0591d201b1cdde2d6931003` |
| `rea-6.7.0/failure-source-budget.json` | B2-6.7.0, 04-budget-observe | `94f7617d623a32e827ad03f9563817214a859f53a1290773367085a6fc3f133a` |

# Recorded live attempts (S5c's final container pass)

Copied byte for byte from S5c's final container pass at the runner commit e2bfd8f5, fixture pages only
(linux/arm64, no network), for investigation/test/live-attempt.test.ts. Each object is the stored output a
row named by digest, saved under its instrument's name; `calls.jsonl` is that run's stand-in call log (the
events the runner wrote, its heads and the object answers; never a token). The scanner's own injected script
text is inside the stored recorder outputs, as the runner stores them; nothing comes from a real site.
`s5c-reference-set/reference-set.json` is a snapshot of the reference set as S5c's image build computed it
at that commit (set digest `6f46e641c52194e25615b08caa6f240630975b832b5105177f909f4a2aa9bdf2`). It is not a
live copy of lib/, and no test asserts it equals today's lib/. Read as data only: never executed, never
opened in a browser.

| File | Bytes | SHA-256 |
|---|---|---|
| `s5c-pass5/ref-consent/calls.jsonl` | 7943 | `ad8c5dc57014bd2cd9ada4be741172763547bc093258d5eb23ce46d4739d8192` |
| `s5c-pass5/ref-consent/rea-inspect.json` | 10130 | `6d8e4b6d45674b3748e5bc21386d8e5cefb67d4d9c1c69f6b7749e8b8b451837` |
| `s5c-pass5/ref-consent/rea-observe.json` | 250006 | `e467aeb3f81c102cb14c907673b0c73e3598e4185d75eaa5e570f234d89b8f87` |
| `s5c-pass5/ref-consent/runner.json` | 9842 | `2f6775a0b707f9f12d5715dc6e6300f8a02adb5b309e377be6dabe0269a2a0bb` |
| `s5c-pass5/ref-consent/scanner.json` | 18841 | `146f380ecac431ede8c43bd98b0230e4fe476f636c9e2860887be446e29e9f04` |
| `s5c-pass5/ref-default/calls.jsonl` | 7942 | `b4f1cb403a1fc3db0f282f08b1bf3ab52089b69dcd85f961fae5e39b286d1462` |
| `s5c-pass5/ref-default/rea-inspect.json` | 7943 | `8d37dfe5da1ac1c624550d3487c3ef7a32f07f8fa109b2828e87b3c0a076bb01` |
| `s5c-pass5/ref-default/rea-observe.json` | 146164 | `22c593979437bc96a726dc72b2994f24ddaca48d3ce1033dee147a49662013ec` |
| `s5c-pass5/ref-default/runner.json` | 4952 | `7582aa89bf08419e33cc935383de7edefcd51a6341559c77fdc1e10e52538495` |
| `s5c-pass5/ref-default/scanner.json` | 15328 | `226ecc471c550cbdd4173b88e8f749c10b8e900956e005b94022ae74cb113523` |
| `s5c-pass5/ref-gpc/calls.jsonl` | 7942 | `726591ba2af841d3660f15dbb59dd1e164e07349e4f3678697eabeb31b361c2e` |
| `s5c-pass5/ref-gpc/rea-inspect.json` | 7943 | `e06d4de5a9471b4c433de23bd6388cfac0e400ad7172b8ef0541388fc85d3cd9` |
| `s5c-pass5/ref-gpc/rea-observe.json` | 166117 | `9840d76e9ab8414b093443b6b86e8b143c802873920706ecd6c4a560a604570c` |
| `s5c-pass5/ref-gpc/runner.json` | 5741 | `5c466680c328f26674afb6aa0c449d9d3b6074b902de9b0ec3064937ee7d0580` |
| `s5c-pass5/ref-gpc/scanner.json` | 15327 | `a2cb2d6441c886010d84c6386183ac6d467f7879aeb9d0af8a77024c71c8c5e0` |
| `s5c-pass5/s3-page-baseline/calls.jsonl` | 5154 | `187daab3d31a0b94303208c1ad5342785a63303975f0ca3b660601e95adfba7a` |
| `s5c-pass5/s3-page-baseline/runner.json` | 1150 | `7200aef4c5cdbc0e314175a1bd81242eaa385aed5086cb1c14bcba1f4849e2ff` |
| `s5c-pass5/s3-page-baseline/scanner.json` | 20972 | `6c0a852143f69d4de7b727bb15f2115812dd13458e107355517d3277d63a5189` |
| `s5c-reference-set/reference-set.json` | 192086 | `3c7bce32a1ab5a6201acc0857c3ad192b3dae87da1a2a39da812b948da80995f` |
