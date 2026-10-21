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
 * joined on the request URL, and a URL is claimed only when the join can back
 * every row of it:
 *
 * - Every observation of the URL agrees. A page that fetches one URL several
 *   times with different initiators cannot be joined that way, and guessing
 *   FIFO would publish an attribution the evidence does not support.
 * - The page reported no more requests for the URL than the session observed.
 *   The session is attached to the page's own target. A dedicated worker is a
 *   target of its own, so none of the requests it makes are observed, while
 *   Playwright reports them as the page's. A URL a worker shares with the page
 *   would otherwise publish the page's initiator on the worker's row too.
 *
 * The second rule counts every request the page reported, not only the rows
 * the log keeps. The session also observes the page's requests that the log
 * leaves out (blocked, aborted, over the cap, or a reload whose traffic is
 * excluded), and counting rows alone would let one of those observations stand
 * in for a worker's row. Refused rows stay unattributed and are counted in
 * stats(), which the scanner does not persist yet.
 */

import { isRecord } from "./guards";

/** Bounds each join table so a pathological page cannot grow it without limit. */
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
  /**
   * Rows left unattributed because the page reported more requests for their
   * URL than the session observed, though every observation named one
   * initiator. These are the rows the join would otherwise have credited with
   * an observation that may not be theirs, such as a dedicated worker's copy
   * of a page request. A row whose request was never counted is refused and
   * counted here too. A URL with no observation counts as neither this nor
   * ambiguous.
   */
  refusedUnobserved: number;
  /** Observations dropped because the observation table reached its bound. */
  dropped: number;
  /** Requests left uncounted because the request table reached its bound. Their rows are refused. */
  requestsDropped: number;
};

/**
 * Join table from a request URL to the initiator Chromium reported for it.
 *
 * Records every observation and counts every request the page reported, then
 * answers only when every observation for that URL agrees and there were no
 * more requests for it than observations. Disagreement and shortfall are
 * reported rather than resolved.
 */
export class RequestInitiatorIndex {
  private readonly byUrl = new Map<
    string,
    { initiatorUrl: string | null; conflicting: boolean; observations: number }
  >();
  private readonly requestsByUrl = new Map<string, number>();
  private observed = 0;
  private attributed = 0;
  private ambiguous = 0;
  private refusedUnobserved = 0;
  private dropped = 0;
  private requestsDropped = 0;

  record(observation: InitiatorObservation): void {
    if (observation.initiatorUrl !== null) this.observed += 1;
    const existing = this.byUrl.get(observation.requestUrl);
    if (existing) {
      existing.observations += 1;
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
      conflicting: false,
      observations: 1
    });
  }

  /**
   * Count one request the page reported, whether or not it becomes a row.
   *
   * The caller reports every request event of the measured page, from before
   * the visit navigates until the claims are made, ahead of any filter that
   * decides whether the request is recorded. Either stream may arrive first.
   */
  noteRequest(requestUrl: string): void {
    const count = this.requestsByUrl.get(requestUrl);
    if (count !== undefined) {
      this.requestsByUrl.set(requestUrl, count + 1);
      return;
    }
    if (this.requestsByUrl.size >= MAX_TRACKED_INITIATORS) {
      this.requestsDropped += 1;
      return;
    }
    this.requestsByUrl.set(requestUrl, 1);
  }

  /**
   * The initiator URL for a request row, or null when it cannot be claimed.
   *
   * A row whose request was never counted is refused, so a caller that skips
   * noteRequest gets no attribution rather than the join that let a worker's
   * row inherit the page's initiator.
   */
  claim(requestUrl: string): string | null {
    const entry = this.byUrl.get(requestUrl);
    if (!entry) return null;
    if (entry.conflicting) {
      this.ambiguous += 1;
      return null;
    }
    if (entry.initiatorUrl === null) return null;
    const requests = this.requestsByUrl.get(requestUrl) ?? 0;
    if (requests === 0 || requests > entry.observations) {
      this.refusedUnobserved += 1;
      return null;
    }
    this.attributed += 1;
    return entry.initiatorUrl;
  }

  stats(): RequestInitiatorStats {
    return {
      observed: this.observed,
      attributed: this.attributed,
      ambiguous: this.ambiguous,
      refusedUnobserved: this.refusedUnobserved,
      dropped: this.dropped,
      requestsDropped: this.requestsDropped
    };
  }
}
