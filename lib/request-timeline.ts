import type { NetworkRequestRecord } from "./types";

/** Decorative timeline nodes are bounded independently of retained evidence. */
export const REQUEST_TIMELINE_MARK_LIMIT = 500;

export type RequestTimelineMark = Readonly<{
  xRatio: number;
  role: "first-party" | "third-party" | "tracker";
}>;

export type RequestTimelineModel = Readonly<{
  maxTime: number;
  marks: readonly RequestTimelineMark[];
}>;

export function buildRequestTimelineModel(
  requests: readonly NetworkRequestRecord[],
  markLimit = REQUEST_TIMELINE_MARK_LIMIT
): RequestTimelineModel {
  if (!Number.isSafeInteger(markLimit) || markLimit <= 0) {
    throw new TypeError("timeline mark limit must be a positive integer");
  }
  let maxTime = 1;
  for (const request of requests) maxTime = Math.max(maxTime, request.startedAtMs);

  if (requests.length <= markLimit) {
    return Object.freeze({
      maxTime,
      marks: Object.freeze(requests.map((request) => Object.freeze({
        xRatio: request.startedAtMs / maxTime,
        role: requestRole(request)
      })))
    });
  }

  // One strongest signal per time bucket preserves the overall distribution
  // without creating attacker-controlled SVG node counts.
  const buckets = new Map<number, RequestTimelineMark>();
  for (const request of requests) {
    const bucket = Math.min(markLimit - 1, Math.floor((request.startedAtMs / maxTime) * markLimit));
    const candidate = Object.freeze({
      xRatio: markLimit === 1 ? 0 : bucket / (markLimit - 1),
      role: requestRole(request)
    });
    const current = buckets.get(bucket);
    if (!current || rolePriority(candidate.role) > rolePriority(current.role)) buckets.set(bucket, candidate);
  }
  return Object.freeze({
    maxTime,
    marks: Object.freeze([...buckets.entries()].sort(([left], [right]) => left - right).map(([, mark]) => mark))
  });
}

function requestRole(request: NetworkRequestRecord): RequestTimelineMark["role"] {
  if (request.tracker) return "tracker";
  return request.thirdParty ? "third-party" : "first-party";
}

function rolePriority(role: RequestTimelineMark["role"]): number {
  return role === "tracker" ? 2 : role === "third-party" ? 1 : 0;
}
