/**
 * Who asked for this request?
 *
 * Every request row in every live report renders "Not attributed", because
 * `NetworkRequestProvenance` is populated only by the PageGraph import path. The
 * slot is already on the frozen r2 wire; a live scan simply never filled it. So
 * a reader can see that a page contacted a tracker and cannot see what on the
 * page reached for it, which is the single question a reader with DevTools open
 * answers in one glance.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM.
 *
 * Chromium reports an `initiator` for each request, with a type
 * (`parser`, `script`, `preload`, `other`) plus a URL and sometimes a JS stack.
 * This module takes ONLY the URL. It never populates `initiatorType`, for a
 * reason that is easy to get wrong: that field is redacted against a PageGraph
 * NODE-TYPE vocabulary, where `parser` and `script` also appear but mean
 * something else. The collision is lexical, not semantic. Writing a CDP type
 * into it would put two different kinds of evidence under one field name, and
 * would widen an admitted public string, which retires the r2 normalization
 * identity for every already-published report.
 *
 * So the claim this supports is narrower and true: "the request for X was
 * initiated by Y". It is NOT script-to-request causality. A script URL in an
 * initiator position may be a loader that was itself told what to fetch, and a
 * `parser`-initiated request carries the document's URL rather than the markup
 * that referenced it. Only PageGraph's instrumented causal graph supports the
 * stronger statement, and reports built from it say so.
 *
 * ATTRIBUTE ONLY WHAT CORRELATES UNAMBIGUOUSLY.
 *
 * Playwright's request objects carry no CDP request id, so the two streams are
 * joined on the request URL. A page that fetches one URL several times with
 * different initiators cannot be joined that way, and guessing FIFO would
 * publish an attribution the evidence does not support. Such rows stay
 * unattributed and are counted, so the report can state how much of the log was
 * attributed rather than implying it was all of it.
 */

import { isRecord } from "./guards";

/** Bounds the join table so a pathological page cannot grow it without limit. */
export const MAX_TRACKED_INITIATORS = 4_000;

export type InitiatorObservation = {
  requestUrl: string;
  /** null when Chromium reported an initiator with no usable URL. */
  initiatorUrl: string | null;
};

/**
 * Read one `Network.requestWillBeSent` payload.
 *
 * The initiator URL is taken from `initiator.url` when present, else from the
 * nearest stack frame that has one. Both are URLs Chromium attributes to the
 * thing that asked; neither is a causal proof.
 */
export function initiatorObservationFromCdpParams(params: unknown): InitiatorObservation | null {
  if (!isRecord(params)) return null;
  const request = params.request;
  if (!isRecord(request)) return null;
  const requestUrl = typeof request.url === "string" ? request.url : "";
  if (!requestUrl) return null;

  const initiator = isRecord(params.initiator) ? params.initiator : null;
  if (!initiator) return { requestUrl, initiatorUrl: null };

  const direct = typeof initiator.url === "string" && initiator.url ? initiator.url : null;
  return { requestUrl, initiatorUrl: direct ?? topStackUrl(initiator.stack) };
}

function topStackUrl(stack: unknown): string | null {
  if (!isRecord(stack)) return null;
  const frames = stack.callFrames;
  if (Array.isArray(frames)) {
    for (const frame of frames) {
      if (isRecord(frame) && typeof frame.url === "string" && frame.url) return frame.url;
    }
  }
  // An async chain's parent can hold the URL when the immediate frames are
  // anonymous (a common shape for tag managers).
  return topStackUrl(stack.parent);
}

export type RequestInitiatorStats = {
  /** Requests Chromium reported an initiator URL for. */
  observed: number;
  /** Rows this index attributed. */
  attributed: number;
  /**
   * Rows left unattributed because the same URL was requested with more than
   * one distinct initiator, so the join could not identify which was which.
   */
  ambiguous: number;
  /** Observations dropped because the table reached its bound. */
  dropped: number;
};

/**
 * Join table from a request URL to the initiator Chromium reported for it.
 *
 * Records every observation, then answers only when every observation for that
 * URL agrees. Disagreement is reported rather than resolved.
 */
export class RequestInitiatorIndex {
  private readonly byUrl = new Map<string, { initiatorUrl: string | null; conflicting: boolean }>();
  private observed = 0;
  private attributed = 0;
  private ambiguous = 0;
  private dropped = 0;

  record(observation: InitiatorObservation): void {
    if (observation.initiatorUrl !== null) this.observed += 1;
    const existing = this.byUrl.get(observation.requestUrl);
    if (existing) {
      // A second, different initiator for the same URL makes both unusable:
      // nothing in the joined data says which row belongs to which.
      if (existing.initiatorUrl !== observation.initiatorUrl) existing.conflicting = true;
      return;
    }
    if (this.byUrl.size >= MAX_TRACKED_INITIATORS) {
      this.dropped += 1;
      return;
    }
    this.byUrl.set(observation.requestUrl, {
      initiatorUrl: observation.initiatorUrl,
      conflicting: false
    });
  }

  /** The initiator URL for a request row, or null when it cannot be claimed. */
  claim(requestUrl: string): string | null {
    const entry = this.byUrl.get(requestUrl);
    if (!entry) return null;
    if (entry.conflicting) {
      this.ambiguous += 1;
      return null;
    }
    if (entry.initiatorUrl === null) return null;
    this.attributed += 1;
    return entry.initiatorUrl;
  }

  stats(): RequestInitiatorStats {
    return {
      observed: this.observed,
      attributed: this.attributed,
      ambiguous: this.ambiguous,
      dropped: this.dropped
    };
  }
}
