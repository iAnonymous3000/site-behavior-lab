import { randomBytes } from "node:crypto";
import {
  kernelSaysPublic,
  loadAddressKernel,
  readAddressValue,
  type AddressKernel,
  type AddressValue
} from "./address-kernel";
import { isIpAddress, isPublicIpAddress, normalizeHostname } from "./ip-safety";

// Live fail-closed enforcement for the Verus-verified address classifier.
//
// Per docs/address-kernel-flip-criteria.md (2026-11-13 ruling):
// - An address is public ONLY when the pinned Verus-checked WASM function
//   (`is_public_ipv4` / `is_public_ipv6`) answers `true` AND `lib/ip-safety.ts`
//   also answers `true` (preserving the TypeScript spelling refusals beside
//   the value rule).
// - Any kernel load failure, digest mismatch, trap, reader disagreement, or
//   negative verdict from either side fails closed (`false`).
// - Differences continue to be counted and logged without ever including the
//   address or host text.
//
// Node only, like lib/address-kernel.ts.

/** The three places that ask whether an address is public. */
export const ADDRESS_DECISION_SITES = ["url-resolved-addresses", "url-address-literal", "proxy-connect-addresses"] as const;
export type AddressDecisionSite = (typeof ADDRESS_DECISION_SITES)[number];

/** The outcomes of one comparison, as the flip criteria define them. */
export const ADDRESS_COMPARISON_RECORDS = [
  "agreed",
  "not-an-address",
  "decision-differs",
  "reader-differs",
  "kernel-unavailable"
] as const;
export type AddressComparisonRecord = (typeof ADDRESS_COMPARISON_RECORDS)[number];

export type AddressComparisonFamily = "ipv4" | "ipv6" | "none";
export type AddressComparisonCounts = Record<
  AddressDecisionSite,
  Record<AddressComparisonRecord, Record<AddressComparisonFamily, number>>
>;

/** A line is logged for each of the first few records of a kind at a place; the rest are counted only. */
export const ADDRESS_COMPARISON_LOGGED_PER_KIND = 10;
/** A line with the totals is logged each time this many comparisons have been made in the process. */
export const ADDRESS_COMPARISON_SUMMARY_EVERY = 1000;
/** A line with the totals is logged when no comparison has been made for this long, if the totals changed. */
export const ADDRESS_COMPARISON_QUIET_MS = 5000;

/** What the comparison needs of a timer. `unref` must keep it from holding the process open. */
export interface AddressComparisonTimer {
  unref(): void;
  cancel(): void;
}

export interface AddressComparisonOptions {
  loadKernel?: () => AddressKernel;
  readValue?: (text: string) => AddressValue | null;
  log?: (line: string) => void;
  setTimer?: (callback: () => void, ms: number) => AddressComparisonTimer;
}

export interface AddressComparison {
  /** `isPublicIpAddress(address)`, exactly, with the comparison made beside it. */
  isPublicIpAddressCompared(address: string, site: AddressDecisionSite): boolean;
  counts(): AddressComparisonCounts;
  /** The random id of this comparison, which every totals line carries. */
  readonly processId: string;
}

interface Outcome {
  record: AddressComparisonRecord;
  family: AddressComparisonFamily;
  kernelAnswer?: boolean;
}

const say = (isPublic: boolean): string => (isPublic ? "public" : "not public");

export function createAddressComparison(options: AddressComparisonOptions = {}): AddressComparison {
  const loadKernel = options.loadKernel ?? (() => loadAddressKernel());
  const readValue = options.readValue ?? readAddressValue;
  const log = options.log ?? ((line: string) => console.warn(line));
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number): AddressComparisonTimer => {
      const timer = setTimeout(callback, ms);
      return { unref: () => void timer.unref(), cancel: () => clearTimeout(timer) };
    });
  // Random, and made before any address is seen: it says which process a
  // totals line came from and nothing about a scan.
  const processId = randomBytes(8).toString("hex");

  // undefined: not tried yet. null: tried and failed; it is not tried again
  // in this process, so a missing file costs one read, not one per decision.
  let kernel: AddressKernel | null | undefined;
  let total = 0;
  let totalAtLastTotalsLine = 0;
  let quietTimer: AddressComparisonTimer | undefined;
  const counts = emptyCounts();

  function logTotals(): void {
    const totals = ADDRESS_COMPARISON_RECORDS.map((kind) => {
      const ipv4 = sum2(counts, kind, "ipv4");
      const ipv6 = sum2(counts, kind, "ipv6");
      const none = sum2(counts, kind, "none");
      return `${kind} ${ipv4 + ipv6 + none} (ipv4 ${ipv4}, ipv6 ${ipv6}, none ${none})`;
    });
    // Marked before the line is written, so a log that throws is not tried
    // again for the same totals.
    totalAtLastTotalsLine = total;
    log(`Address kernel comparison totals: process ${processId}, ${total} comparisons: ${totals.join(", ")}.`);
  }

  function armQuietTimer(): void {
    try {
      quietTimer?.cancel();
      quietTimer = setTimer(() => {
        // This runs outside any caller. Nothing may leave it: an exception
        // here would be an uncaught one in the scanner's process.
        try {
          quietTimer = undefined;
          if (total !== totalAtLastTotalsLine) logTotals();
        } catch {
          // An observer's log failed. There is nobody to tell.
        }
      }, ADDRESS_COMPARISON_QUIET_MS);
      quietTimer.unref();
    } catch {
      // A timer that cannot be armed costs a totals line and nothing else.
    }
  }

  function compare(address: string, decision: boolean): Outcome {
    const readsAsAddress = isIpAddress(address);
    let value: AddressValue | null;
    try {
      value = readValue(normalizeHostname(address));
    } catch {
      value = null;
    }
    if (!readsAsAddress && value === null) return { record: "not-an-address", family: "none" };
    const family: AddressComparisonFamily = value ? (value.family === 4 ? "ipv4" : "ipv6") : "none";
    if (!readsAsAddress || value === null) return { record: "reader-differs", family };

    if (kernel === undefined) {
      try {
        kernel = loadKernel();
      } catch {
        kernel = null;
      }
    }
    if (kernel === null) return { record: "kernel-unavailable", family };
    let kernelAnswer: boolean;
    try {
      kernelAnswer = kernelSaysPublic(kernel, value);
    } catch {
      return { record: "kernel-unavailable", family };
    }
    return { record: kernelAnswer === decision ? "agreed" : "decision-differs", family, kernelAnswer };
  }

  function note(site: AddressDecisionSite, decision: boolean, outcome: Outcome): void {
    const { record, family } = outcome;
    counts[site][record][family] += 1;
    total += 1;
    armQuietTimer();
    if (record !== "agreed" && record !== "not-an-address") {
      const seen = sum(counts[site][record]);
      if (seen <= ADDRESS_COMPARISON_LOGGED_PER_KIND) {
        const answers =
          outcome.kernelAnswer === undefined
            ? `TypeScript says ${say(decision)}`
            : `TypeScript says ${say(decision)}, the kernel says ${say(outcome.kernelAnswer)}`;
        const last = seen === ADDRESS_COMPARISON_LOGGED_PER_KIND ? " Further records of this kind here are counted, not logged." : "";
        log(`Address kernel comparison: ${record} at ${site} (${family}; ${answers}). Refused fail-closed.${last}`);
      }
    }
    if (total % ADDRESS_COMPARISON_SUMMARY_EVERY === 0) logTotals();
  }

  return {
    isPublicIpAddressCompared(address, site) {
      const tsDecision = isPublicIpAddress(address);
      const outcome = compare(address, tsDecision);
      try {
        note(site, tsDecision, outcome);
      } catch {
        // Logging failures must never alter the fail-closed decision.
      }
      // Fail-closed live flip: public ONLY when BOTH the Verus-checked kernel
      // and the TypeScript spelling guard agree that the address is public.
      return tsDecision && outcome.record === "agreed";
    },
    counts: () => JSON.parse(JSON.stringify(counts)) as AddressComparisonCounts,
    processId
  };
}

function emptyCounts(): AddressComparisonCounts {
  const bySite = {} as AddressComparisonCounts;
  for (const site of ADDRESS_DECISION_SITES) {
    const byRecord = {} as AddressComparisonCounts[AddressDecisionSite];
    for (const record of ADDRESS_COMPARISON_RECORDS) byRecord[record] = { ipv4: 0, ipv6: 0, none: 0 };
    bySite[site] = byRecord;
  }
  return bySite;
}

const sum = (byFamily: Record<AddressComparisonFamily, number>): number => byFamily.ipv4 + byFamily.ipv6 + byFamily.none;

function sum2(counts: AddressComparisonCounts, record: AddressComparisonRecord, family: AddressComparisonFamily): number {
  return ADDRESS_DECISION_SITES.reduce((value, site) => value + counts[site][record][family], 0);
}

/** The comparison of this process. Its counts restart with the process. */
export const addressComparison = createAddressComparison();

/** `isPublicIpAddress(address)`, exactly, with the kernel asked beside it. */
export function isPublicIpAddressCompared(address: string, site: AddressDecisionSite): boolean {
  return addressComparison.isPublicIpAddressCompared(address, site);
}
