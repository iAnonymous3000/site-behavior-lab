# Address classifier: criteria for letting the kernel decide

Written 2026-11-13, before the comparison mode existed and before any
comparison record existed. A later edit to a criterion is a new decision by
the owner and is dated here, below the criterion it changes. It is not a
correction.

## What this is about

`lib/ip-safety.ts` decides whether an address is public, and so where a scan
may connect. `tools/trust-kernel/kernel/src/address.rs` holds the same
decision on address values, and Verus accepts that its two executable
functions return what a written table and rule say, for every 32-bit and
every 128-bit value.

In comparison mode the TypeScript answer decides, as before. Beside it the
checked function answers for the same address, given the address as a value,
and the two answers are compared. This file says what must be seen before the
checked function's answer may become the deciding one ("the flip"), and how
the decision must fail after that. The flip is a separate change with its own
review. Nothing here performs it.

## What is compared, and what is not

- Compared: the three decisions that call `isPublicIpAddress` (the resolved
  addresses in `lib/url-safety.ts`, the address literal in its shape check,
  and the addresses the scan proxy is about to connect to).
- Not compared: the three places that call `isIpAddress` alone. That question
  is "is this text an address", the kernel's only answer to it is its text
  reader, and the text reader is not checked by Verus. Those places stay on
  TypeScript, in comparison mode and after a flip.
- The value handed to the checked function is read from the text by Node
  (`net.isIPv4`, `net.isIPv6` and the URL parser), not by `lib/ip-safety.ts`
  and not by the kernel's text reader. That reading is ordinary code and is
  proved by nothing.

## Records

Each comparison ends in one of these, counted for each of the three places:

| Record | Meaning |
|---|---|
| `agreed` | Both read an address and gave the same answer. |
| `not-an-address` | Neither TypeScript nor Node reads the text as an address. The checked function was not asked. |
| `decision-differs` | Both read an address. The answers differ. |
| `reader-differs` | One of TypeScript and Node reads an address and the other does not, or Node gives no value. The checked function was not asked. |
| `kernel-unavailable` | The module is missing, is not the pinned bytes, did not start, or its call failed. |

## Criteria

All of these, at one commit, with the comparison code and the module
unchanged since the counting began:

1. **The module is the pinned one.** The vendored module's sha256 is the one
   `tools/trust-kernel/reproducibility-contract.json` records for every host
   it lists, and the Trust Kernel workflow passed on `main` at that commit:
   its two clean builds gave those bytes on the hosted runner, and Verus
   accepted the kernel.
2. **Volume in production.** At least 10,000 comparisons recorded as `agreed`
   in the production container, over at least 7 consecutive days, with at
   least 100 `agreed` for IPv6 addresses. If production does not produce 100
   IPv6 comparisons in that time, the owner decides whether to wait or to
   flip IPv4 alone. This file does not decide that.
3. **No unexplained difference.** Zero `decision-differs` in that period. One
   is enough to stop the count. It restarts only after the cause is written
   down and either fixed or accepted by the owner in writing.
4. **No reader difference on an address a scan would use.** Zero
   `reader-differs` in that period, on the same terms.
5. **The module loads.** Zero `kernel-unavailable` in that period after the
   first container start that carries the module.
6. **The generated comparison still passes.** The address differential
   (`scripts/trust-kernel-address-differential.mjs`) passes at that commit
   with zero differences, and the test of the value entry points passes
   against the vendored module.
7. **The spelling cases are ruled on.** `lib/ip-safety.ts` refuses three
   spellings that the value rule admits: an IPv4-mapped address not spelled
   `::ffff:` and the dotted or two-word form, and the three protocol anycast
   addresses not spelled `2001:1::1`, `2001:1::2`, `2001:1::3`. A value has no
   spelling. Before a flip the owner rules on one of: keep the TypeScript
   spelling refusal beside the kernel's answer (both must say public), or
   accept that those spellings become public. The first changes no verdict.

A count is read from the container's log lines and from the counters the
comparison module keeps. Both restart with the process, so the period's
numbers are a sum over restarts and the report of a flip decision must say
how they were summed.

## After a flip: how it fails

- The address is public only when the checked function says so. A module
  that is missing, is not the pinned bytes, did not start, or throws means
  "not public". So does a text that Node gives no value for. A refused scan
  target is visible and recoverable. An admitted internal address is neither.
- TypeScript keeps answering beside it for at least one further release, and
  every difference is recorded as now. During that time an address is public
  only when both say so.
- There is no automatic return to TypeScript deciding alone. Going back is a
  reviewed change.
- The flip does not change `isIpAddress`, any report byte, or what a scan
  records.

## What these criteria do not show

- That the table and the rule in `address.rs` are what the IANA registries
  list. That is a dated human reading.
- That Node's reading of a text is the value the connection will use.
- Anything about addresses production never met. The criteria count what was
  observed. The statement over every value is Verus's, and it speaks about
  the Rust functions, not about the WebAssembly bytes or the code around
  them.
