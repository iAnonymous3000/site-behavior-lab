import {
  PRIVACY_SAFE_OBSERVABILITY_PATH,
  type PrivacySafeObservabilityEvent,
  parsePrivacySafeObservabilityEvent
} from "./privacy-safe-observability";

export const AGGREGATE_METRICS_FLAG = "SITE_BEHAVIOR_LAB_AGGREGATE_METRICS" as const;
export const AGGREGATE_METRICS_BINDING = "AGGREGATE_METRICS" as const;
export const PRIVACY_SAFE_EVENT_MAX_BYTES = 320;

export type AggregateMetricsDataPoint = {
  indexes: [string];
  blobs: string[];
  doubles: [number];
};

export type AggregateMetricsDataset = {
  writeDataPoint(point: AggregateMetricsDataPoint): void;
};

export type AggregateMetricsEdgeConfig = {
  enabledFlag?: string;
  allowedOrigin?: string;
  dataset?: AggregateMetricsDataset;
};

/**
 * Edge-only aggregate collector. It never logs a payload and it writes no raw
 * request metadata: the sink receives fixed enum dimensions and count=1 only.
 */
export async function handleAggregateMetricsRequest(
  request: Request,
  config: AggregateMetricsEdgeConfig
): Promise<Response> {
  if (config.enabledFlag !== "1") return response(404);

  const allowedOrigin = exactHttpsOrigin(config.allowedOrigin);
  if (!allowedOrigin) return response(503);
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== allowedOrigin) return response(403);

  const cors = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin"
  };

  const url = new URL(request.url);
  if (url.pathname !== PRIVACY_SAFE_OBSERVABILITY_PATH || url.search || url.hash) {
    return response(404, cors);
  }
  if (request.method === "OPTIONS") return response(204, cors);
  if (request.method !== "POST") return response(405, { ...cors, Allow: "POST, OPTIONS" });
  if (!config.dataset) return response(503, cors);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return response(415, cors);
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > PRIVACY_SAFE_EVENT_MAX_BYTES) {
    return response(413, cors);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return response(400, cors);
  }
  if (new TextEncoder().encode(raw).byteLength > PRIVACY_SAFE_EVENT_MAX_BYTES) return response(413, cors);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return response(400, cors);
  }
  const event = parsePrivacySafeObservabilityEvent(parsed);
  if (!event) return response(400, cors);

  try {
    config.dataset.writeDataPoint(aggregateMetricsDataPoint(event));
  } catch {
    // Do not log the event or request on failure. Product interactions must not
    // depend on telemetry availability, and unsafe fallback storage is forbidden.
    return response(503, cors);
  }
  return response(204, cors);
}

/**
 * Stable Analytics Engine layout:
 *   index1 = contract version
 *   blob1  = event name
 *   blob2..blob5 = event-specific, closed-vocabulary dimensions
 *   double1 = 1 (aggregate count)
 */
export function aggregateMetricsDataPoint(event: PrivacySafeObservabilityEvent): AggregateMetricsDataPoint {
  switch (event.name) {
    case "route-view":
      return point(event.name, event.route);
    case "core-web-vital":
      return point(event.name, event.route, event.metric, event.rating);
    case "scan-funnel":
      return point(event.name, event.surface, event.stage, event.mode, event.device);
    case "share-action":
      return point(event.name, event.surface, event.channel, event.outcome);
    case "profile-action":
      return point(event.name, event.source, event.action);
    case "rescan-action":
      return point(event.name, event.surface, event.stage, event.mode, event.device);
  }
}

function point(name: string, ...dimensions: string[]): AggregateMetricsDataPoint {
  return { indexes: ["site-behavior-lab-v1"], blobs: [name, ...dimensions], doubles: [1] };
}

function exactHttpsOrigin(value: string | undefined): string | null {
  if (!value || value === "*") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers
    }
  });
}
