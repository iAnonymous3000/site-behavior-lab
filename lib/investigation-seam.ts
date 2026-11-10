import type { Frame, Page } from "playwright";
import {
  collectFingerprintObservationsWithCoverage,
  type FingerprintObservationCollection,
  type FingerprintWorkerRealmReadout
} from "./fingerprint-observer";
import type { PublicScanProxyDiagnostics } from "./public-scan-proxy";
import { scanAbortError, type ScanRequestBudgetDiagnostics } from "./scan-runtime";
import { SCROLL_CHECK_DEADLINE_MARGIN_MS, type ScrollCheckBoundary } from "./scroll-check";
import { rememberSeamVisit, SEAM_VISIT_MARKER } from "./seam-visit-mark";
import { sha256Hex } from "./sha256";

/**
 * The scanner's investigation seam: an optional connection a private capture
 * makes into one visit. A caller sets it as one field of the visit options,
 * and the scanner then calls the caller's hooks at fixed points of that visit.
 *
 * Nothing public sets it. The scan API refuses visit options that carry it,
 * and a test refuses any module outside this file and the scanner that names
 * it (lib/runtime-boundaries.test.ts). A visit that did not set it runs the
 * statements it always ran: every use of the seam in the scanner sits inside
 * a condition on its presence.
 *
 * A visit that set it is marked and is never published. A hook holds the
 * live page, so nothing here can say what a seam visit measured compared with
 * an ordinary one, and its result must never stand beside a public report.
 * The mark is carried two ways. By identity: the envelope the visit returns,
 * its result and its measurement are remembered. In band: the result and the
 * measurement each carry one key, SEAM_VISIT_MARKER, which a
 * structured clone, a JSON copy and an object spread all keep. The scan API,
 * both runtime report builders, the report saver, the shadow store and the
 * v1 redactor refuse a value that carries either, on itself or on a
 * top-level member (refuseSeamVisit). The mark and that check live in
 * lib/seam-visit-mark.ts, which the redactor can import wherever it runs.
 *
 * What the mark does not survive is a caller who removes it on purpose: one
 * who deletes the key from a copy, or one who builds a new object by hand
 * from a marked result's fields and leaves the key out. Neither is stopped
 * here, and nothing claims otherwise.
 */

/** What an afterEnvelope hook can read, while the page is still open. */
export type InvestigationSeamReadings = {
  /**
   * The fingerprint observations of each document of the page, read one
   * frame at a time, and then of the page's worker realms together.
   */
  fingerprintBySource(): Promise<InvestigationSeamFingerprintSource[]>;
  /** The visit's request budget and its proxy's budgets, as they stand. */
  budgets(): { request: ScanRequestBudgetDiagnostics; proxy: PublicScanProxyDiagnostics };
  /** Evaluate one expression in every frame; a frame that fails says so. */
  evaluateInFrames(expression: string): Promise<InvestigationSeamFrameValue[]>;
};

export type InvestigationSeamFingerprintSource = {
  source: "main" | "frame" | "workers";
  /** The frame's address; empty for the worker realms. */
  url: string;
  startedAt: number;
  endedAt: number;
  collection: FingerprintObservationCollection;
};

export type InvestigationSeamFrameValue = { url: string; isMain: boolean; value: unknown; error?: string };

export type InvestigationSeam = {
  /**
   * Receive the visit's page while it is still about:blank, before the
   * scanner installs its fingerprint observer, its routes and its recorders,
   * and before it navigates. Awaited inside the visit's own scan deadline, so
   * the time it takes comes out of the time the visit has to load its page.
   * The page is the visit's own: nothing limits what the hook does with it.
   */
  pageReady?: (page: Page) => void | Promise<void>;
  /**
   * Script source the scanner adds to the page as an init script, right
   * after pageReady and before its own fingerprint observer. In each
   * document it runs after the scanner's bounded page collector and before
   * the observer, so the observer wraps over whatever this script wraps: a
   * page's call reaches the observer first and this script's wrapper second.
   */
  initScript?: string;
  /**
   * Observe the scanner's own final fingerprint read, the moment it is made.
   * Synchronous: the scanner does not wait for anything it returns, and a
   * returned promise fails the visit. The collection is a copy. The read is
   * the scanner's tentative one: a visit whose page then leaves its site
   * discards it. Not called on a visit whose page had already left.
   */
  finalFingerprintRead?: (collection: FingerprintObservationCollection) => void;
  /**
   * Called once the visit's result is built and frozen, before a check after
   * scrolling begins and before the visit closes its page. Awaited, for at
   * most afterEnvelopeTimeoutMs.
   */
  afterEnvelope?: (read: InvestigationSeamReadings) => void | Promise<void>;
  /**
   * How long afterEnvelope may take before the visit fails, in milliseconds:
   * an integer from MIN_AFTER_ENVELOPE_TIMEOUT_MS to
   * MAX_AFTER_ENVELOPE_TIMEOUT_MS. DEFAULT_AFTER_ENVELOPE_TIMEOUT_MS when
   * absent.
   */
  afterEnvelopeTimeoutMs?: number;
  /**
   * Called at each of a check after scrolling's four boundaries, with a way
   * to read the page's fingerprint observations at that moment. Awaited
   * inside the check's own deadline. Its time falls: for check-start, in the
   * settle; for control-start, before the window with no input opens; for
   * control-end, at the end of that window, which is longer by it; for
   * scroll-end, after the scroll window has closed. scroll-end is called
   * only when a scroll window ran to its end.
   */
  scrollCheckBoundary?: (
    boundary: ScrollCheckBoundary,
    readFingerprint: () => Promise<FingerprintObservationCollection>
  ) => void | Promise<void>;
  /**
   * Replaces SCROLL_CHECK_DEADLINE_MARGIN_MS for this visit's check, in
   * milliseconds, so a boundary callback has time to run: an integer from
   * that constant to MAX_SEAM_SCROLL_CHECK_DEADLINE_MARGIN_MS. It can
   * lengthen the check's deadline and never shorten it.
   */
  scrollCheckDeadlineMarginMs?: number;
};

export const INVESTIGATION_SEAM_VERSION = "investigation-seam@1";
export const DEFAULT_AFTER_ENVELOPE_TIMEOUT_MS = 30_000;
export const MIN_AFTER_ENVELOPE_TIMEOUT_MS = 1_000;
export const MAX_AFTER_ENVELOPE_TIMEOUT_MS = 600_000;
export const MAX_SEAM_SCROLL_CHECK_DEADLINE_MARGIN_MS = 600_000;

/**
 * What a seam asks of a visit, known before the visit runs: which hooks are
 * set, the init script's sha256 over its UTF-8 bytes (never its text), and
 * the two bounds as they apply. Its keys are always these, in this order, so
 * JSON.stringify of it is stable.
 */
export type InvestigationSeamDescription = Readonly<{
  version: typeof INVESTIGATION_SEAM_VERSION;
  pageReady: boolean;
  initScriptSha256: string | null;
  finalFingerprintRead: boolean;
  afterEnvelope: boolean;
  afterEnvelopeTimeoutMs: number;
  scrollCheckBoundary: boolean;
  scrollCheckDeadlineMarginMs: number;
}>;

/**
 * What a seam did on one visit: its description, and how long each hook call
 * took by the scanner's own clock, in milliseconds. A hook that is not set
 * reads null. A boundary callback the check stopped waiting for, at its
 * deadline or on a cancellation, reads null for its time and keeps it,
 * whatever the callback does afterwards.
 */
export type InvestigationSeamUse = Readonly<{
  description: InvestigationSeamDescription;
  hookDurationsMs: Readonly<{
    pageReady: number | null;
    finalFingerprintRead: number | null;
    afterEnvelope: number | null;
    scrollCheckBoundary: readonly Readonly<{ boundary: ScrollCheckBoundary; ms: number | null }>[];
  }>;
}>;

/** An afterEnvelope hook did not settle within its bound. */
export class InvestigationSeamHookTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The investigation seam's afterEnvelope hook did not settle within ${timeoutMs} ms.`);
    this.name = "InvestigationSeamHookTimeoutError";
  }
}

const SEAM_KEYS = [
  "pageReady",
  "initScript",
  "finalFingerprintRead",
  "afterEnvelope",
  "afterEnvelopeTimeoutMs",
  "scrollCheckBoundary",
  "scrollCheckDeadlineMarginMs"
] as const;

type ReadSeam = {
  pageReady: InvestigationSeam["pageReady"];
  initScript: string | undefined;
  finalFingerprintRead: InvestigationSeam["finalFingerprintRead"];
  afterEnvelope: InvestigationSeam["afterEnvelope"];
  afterEnvelopeTimeoutMs: number | undefined;
  scrollCheckBoundary: InvestigationSeam["scrollCheckBoundary"];
  scrollCheckDeadlineMarginMs: number | undefined;
};

/**
 * Read a seam's fields once, refusing anything this module does not know. A
 * misspelled hook would otherwise run a marked visit with nothing attached.
 */
function readSeam(seam: unknown): ReadSeam {
  if (typeof seam !== "object" || seam === null || Array.isArray(seam)) {
    throw new TypeError("The investigation seam must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(seam) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("The investigation seam must be a plain object.");
  }
  const given = seam as Record<string, unknown>;
  for (const key of Reflect.ownKeys(given)) {
    if (typeof key !== "string" || !(SEAM_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`The investigation seam has no field ${String(key)}.`);
    }
  }
  const hook = (key: "pageReady" | "finalFingerprintRead" | "afterEnvelope" | "scrollCheckBoundary"): unknown => {
    const value = given[key];
    if (value !== undefined && typeof value !== "function") {
      throw new TypeError(`The investigation seam's ${key} must be a function.`);
    }
    return value;
  };
  const bounded = (key: "afterEnvelopeTimeoutMs" | "scrollCheckDeadlineMarginMs", min: number, max: number): number | undefined => {
    const value = given[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new TypeError(`The investigation seam's ${key} must be an integer from ${min} to ${max}.`);
    }
    return value;
  };
  const initScript = given.initScript;
  if (initScript !== undefined && (typeof initScript !== "string" || initScript.length === 0)) {
    throw new TypeError("The investigation seam's initScript must be script source text.");
  }
  return {
    pageReady: hook("pageReady") as ReadSeam["pageReady"],
    initScript,
    finalFingerprintRead: hook("finalFingerprintRead") as ReadSeam["finalFingerprintRead"],
    afterEnvelope: hook("afterEnvelope") as ReadSeam["afterEnvelope"],
    afterEnvelopeTimeoutMs: bounded("afterEnvelopeTimeoutMs", MIN_AFTER_ENVELOPE_TIMEOUT_MS, MAX_AFTER_ENVELOPE_TIMEOUT_MS),
    scrollCheckBoundary: hook("scrollCheckBoundary") as ReadSeam["scrollCheckBoundary"],
    scrollCheckDeadlineMarginMs: bounded(
      "scrollCheckDeadlineMarginMs",
      SCROLL_CHECK_DEADLINE_MARGIN_MS,
      MAX_SEAM_SCROLL_CHECK_DEADLINE_MARGIN_MS
    )
  };
}

function describe(read: ReadSeam): InvestigationSeamDescription {
  return Object.freeze({
    version: INVESTIGATION_SEAM_VERSION,
    pageReady: read.pageReady !== undefined,
    initScriptSha256: read.initScript === undefined ? null : sha256Hex(read.initScript),
    finalFingerprintRead: read.finalFingerprintRead !== undefined,
    afterEnvelope: read.afterEnvelope !== undefined,
    afterEnvelopeTimeoutMs: read.afterEnvelopeTimeoutMs ?? DEFAULT_AFTER_ENVELOPE_TIMEOUT_MS,
    scrollCheckBoundary: read.scrollCheckBoundary !== undefined,
    scrollCheckDeadlineMarginMs: read.scrollCheckDeadlineMarginMs ?? SCROLL_CHECK_DEADLINE_MARGIN_MS
  });
}

/**
 * A seam's description, without running anything. A caller records this
 * before a visit, so a visit that throws, and so returns no envelope to read
 * a use from, still has its record.
 */
export function describeInvestigationSeam(seam: InvestigationSeam): InvestigationSeamDescription {
  return describe(readSeam(seam));
}

/** The seam each marked envelope's visit ran with. */
const seamByEnvelope = new WeakMap<object, OpenInvestigationSeam>();

/**
 * Settle with `work`, or reject as soon as the visit is cancelled or the
 * bound passes. The listener and the timer are gone once any of the three
 * happens. `work` is not stopped: a hook that never settles stays pending,
 * and what it holds is released when the visit closes its page.
 *
 * A wait can also be abandoned: the scan deadline ends a visit that is still
 * waiting on pageReady, and nothing above would then take this wait's
 * listener off the caller's signal. Each wait therefore leaves its cleanup in
 * `pending` until it ends, for the visit to run on its way out.
 */
function settleWithin(
  work: Promise<void>,
  signal: AbortSignal | undefined,
  pending: Set<() => void>,
  bound?: { ms: number; expired: () => Error }
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      work.catch(() => undefined);
      reject(scanAbortError(signal));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pending.delete(finish);
    };
    pending.add(finish);
    const onAbort = (): void => {
      finish();
      reject(scanAbortError(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (bound) {
      timer = setTimeout(() => {
        finish();
        reject(bound.expired());
      }, bound.ms);
    }
    work.then(
      () => {
        finish();
        resolve();
      },
      (error: unknown) => {
        finish();
        reject(error);
      }
    );
  });
}

/**
 * One visit's seam: the caller's hooks as they were when the visit began,
 * what the visit records of them, and the mark. The scanner makes one per
 * seam visit (openInvestigationSeam) and none otherwise.
 */
export class OpenInvestigationSeam {
  readonly description: InvestigationSeamDescription;
  /** The init script to add, or null. */
  readonly initScript: string | null;
  /** Whether a boundary callback is set, so a check is handed one only then. */
  readonly hasScrollCheckBoundary: boolean;
  /** The margin the caller gave, or null when the scanner's constant applies. */
  readonly scrollCheckDeadlineMarginMs: number | null;

  private readonly hooks: ReadSeam;
  private pageReadyMs: number | null = null;
  private finalFingerprintReadMs: number | null = null;
  private afterEnvelopeMs: number | null = null;
  private readonly boundaryCalls: { boundary: ScrollCheckBoundary; ms: number | null }[] = [];
  private boundaryFailure: { error: unknown } | null = null;
  /** The cleanup of each wait on a hook that has not ended yet. */
  private readonly pendingWaits = new Set<() => void>();

  constructor(seam: InvestigationSeam) {
    this.hooks = readSeam(seam);
    this.description = describe(this.hooks);
    this.initScript = this.hooks.initScript ?? null;
    this.hasScrollCheckBoundary = this.hooks.scrollCheckBoundary !== undefined;
    this.scrollCheckDeadlineMarginMs = this.hooks.scrollCheckDeadlineMarginMs ?? null;
  }

  /** Call pageReady, if set. Rejects as soon as the visit is cancelled. */
  async pageReady(page: Page, signal: AbortSignal | undefined): Promise<void> {
    const hook = this.hooks.pageReady;
    if (!hook) return;
    const started = Date.now();
    await settleWithin((async () => hook(page))(), signal, this.pendingWaits);
    this.pageReadyMs = Date.now() - started;
  }

  /**
   * Hand finalFingerprintRead, if set, a copy of the scanner's own read. The
   * copy keeps a hook from altering what the visit records. Never waits: a
   * hook that returns a promise fails the visit, since nothing would hear
   * that promise reject.
   */
  finalFingerprintRead(collection: FingerprintObservationCollection): void {
    const hook = this.hooks.finalFingerprintRead;
    if (!hook) return;
    const started = Date.now();
    const returned: unknown = hook(structuredClone(collection));
    this.finalFingerprintReadMs = Date.now() - started;
    if (returned !== null && typeof returned === "object" && typeof (returned as { then?: unknown }).then === "function") {
      Promise.resolve(returned).catch(() => undefined);
      throw new TypeError("The investigation seam's finalFingerprintRead is synchronous and must not return a promise.");
    }
  }

  /**
   * Call afterEnvelope, if set. Rejects when the hook does, when its bound
   * passes, and as soon as the visit is cancelled.
   */
  async afterEnvelope(read: InvestigationSeamReadings, signal: AbortSignal | undefined): Promise<void> {
    const hook = this.hooks.afterEnvelope;
    if (!hook) return;
    const timeoutMs = this.description.afterEnvelopeTimeoutMs;
    const started = Date.now();
    await settleWithin((async () => hook(read))(), signal, this.pendingWaits, {
      ms: timeoutMs,
      expired: () => new InvestigationSeamHookTimeoutError(timeoutMs)
    });
    this.afterEnvelopeMs = Date.now() - started;
  }

  /**
   * Call the boundary callback. The check bounds the returned promise by its
   * own deadline and aborts `waiting` once it has stopped waiting for it.
   * Only a callback the check was still awaiting counts: its time is
   * recorded, and its error is remembered, because the check, which never
   * throws, would otherwise end as one cut short (rethrowBoundaryFailure).
   * A callback the check gave up on keeps a time of null and cannot fail the
   * visit, whatever it does later.
   */
  async scrollCheckBoundary(
    boundary: ScrollCheckBoundary,
    readFingerprint: () => Promise<FingerprintObservationCollection>,
    waiting: AbortSignal
  ): Promise<void> {
    const hook = this.hooks.scrollCheckBoundary;
    if (!hook) return;
    const call: { boundary: ScrollCheckBoundary; ms: number | null } = { boundary, ms: null };
    this.boundaryCalls.push(call);
    const started = Date.now();
    try {
      await hook(boundary, readFingerprint);
    } catch (error) {
      if (!waiting.aborted) this.boundaryFailure ??= { error };
      throw error;
    }
    if (!waiting.aborted) call.ms = Date.now() - started;
  }

  /** Fail the visit with the first error a boundary callback threw, if one did. */
  rethrowBoundaryFailure(): void {
    if (this.boundaryFailure !== null) throw this.boundaryFailure.error;
  }

  /**
   * Take what a wait the visit abandoned still holds: its listener on the
   * caller's signal and its timer. The visit calls this on every way out.
   */
  release(): void {
    for (const finish of [...this.pendingWaits]) finish();
  }

  /**
   * Put the in-band mark on a visit's result and measurement, before the
   * envelope is built from them. An enumerable own key, so a structured
   * clone, a JSON copy and a spread keep it; fixed, so it cannot be taken off
   * the visit's own objects.
   */
  markParts(result: object, measurement: object): void {
    for (const part of [result, measurement]) {
      Object.defineProperty(part, SEAM_VISIT_MARKER, {
        value: INVESTIGATION_SEAM_VERSION,
        enumerable: true,
        writable: false,
        configurable: false
      });
    }
  }

  /** Remember the envelope the visit built, with its result and measurement, as a seam visit's. */
  markVisit(envelope: { result: object; measurement: object }): void {
    rememberSeamVisit(envelope, envelope.result, envelope.measurement);
    seamByEnvelope.set(envelope, this);
  }

  /** What this seam did on its visit, as it stands now. */
  use(): InvestigationSeamUse {
    return Object.freeze({
      description: this.description,
      hookDurationsMs: Object.freeze({
        pageReady: this.pageReadyMs,
        finalFingerprintRead: this.finalFingerprintReadMs,
        afterEnvelope: this.afterEnvelopeMs,
        scrollCheckBoundary: Object.freeze(this.boundaryCalls.map((call) => Object.freeze({ ...call })))
      })
    });
  }
}

/** Open a visit's seam. Throws, before the visit does any work, on a seam this module cannot read. */
export function openInvestigationSeam(seam: InvestigationSeam): OpenInvestigationSeam {
  return new OpenInvestigationSeam(seam);
}

/**
 * What the seam did on the visit that returned exactly this envelope, or
 * undefined for a visit that did not use the seam and for any copy. Complete
 * once the visit has returned. A runner stores this after a visit that
 * returned, and describeInvestigationSeam's value for one that threw.
 */
export function investigationSeamUse(envelope: object): InvestigationSeamUse | undefined {
  return seamByEnvelope.get(envelope)?.use();
}

/**
 * The readings an afterEnvelope hook gets, and the one read a boundary
 * callback gets, over the visit's own page. The scanner supplies its worker
 * realm readout, its budgets and the call that runs an expression in a
 * frame, so this module runs no page code of its own and the scanner stays
 * the one place that does. Nothing here keeps a reading.
 */
export function investigationSeamReadings(input: {
  page: Page;
  workerRealms: () => FingerprintWorkerRealmReadout | Promise<FingerprintWorkerRealmReadout>;
  budgets: () => { request: ScanRequestBudgetDiagnostics; proxy: PublicScanProxyDiagnostics };
  runInFrame: (frame: Frame, expression: string) => Promise<unknown>;
}): { readings: InvestigationSeamReadings; readFingerprint: () => Promise<FingerprintObservationCollection> } {
  const { page } = input;
  return {
    readFingerprint: () => collectFingerprintObservationsWithCoverage(page.frames(), input.workerRealms()),
    readings: {
      fingerprintBySource: async () => {
        const sources: InvestigationSeamFingerprintSource[] = [];
        for (const frame of page.frames()) {
          const startedAt = Date.now();
          const collection = await collectFingerprintObservationsWithCoverage([frame]);
          sources.push({
            source: frame === page.mainFrame() ? "main" : "frame",
            url: frame.url(),
            startedAt,
            endedAt: Date.now(),
            collection
          });
        }
        const startedAt = Date.now();
        const collection = await collectFingerprintObservationsWithCoverage([], input.workerRealms());
        sources.push({ source: "workers", url: "", startedAt, endedAt: Date.now(), collection });
        return sources;
      },
      // The scanner's own getters, each of which builds a new snapshot.
      budgets: () => input.budgets(),
      evaluateInFrames: async (expression) => {
        const values: InvestigationSeamFrameValue[] = [];
        for (const frame of page.frames()) {
          const isMain = frame === page.mainFrame();
          try {
            values.push({ url: frame.url(), isMain, value: await input.runInFrame(frame, expression) });
          } catch (error) {
            values.push({ url: frame.url(), isMain, value: null, error: String(error).slice(0, 160) });
          }
        }
        return values;
      }
    }
  };
}
