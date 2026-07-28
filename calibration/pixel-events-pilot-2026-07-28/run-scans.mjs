#!/usr/bin/env node
/**
 * Pilot step 1: attempt every prespecified case under fixed conditions, record
 * the raw artifact, derive the detector's PREDICTION, and emit a labeling
 * packet with the prediction stripped out.
 *
 * The packet is what a reference labeler sees. It carries the recorded request
 * log (host, path, method, third-party flag) and nothing that reveals what
 * pixel-events concluded, so the reference stays blinded to the prediction.
 * The stratum is withheld for the same reason.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CALIBRATION_BASE_URL || "http://127.0.0.1:3100";
const frame = JSON.parse(readFileSync(path.join(here, "frame.json"), "utf8"));

const artifactsDir = path.join(here, "artifacts");
const packetsDir = path.join(here, "packets");
mkdirSync(artifactsDir, { recursive: true });
mkdirSync(packetsDir, { recursive: true });

const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

const conditions = frame.conditions;
const conditionDigest = digest(conditions);

const results = [];
for (const site of frame.sites) {
  const started = Date.now();
  let payload = null;
  let transport = "ok";
  try {
    const res = await fetch(`${BASE}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: site.url,
        device: conditions.device,
        gpcEnabled: conditions.gpcEnabled,
        consentMode: conditions.consentMode
      })
    });
    const text = await res.text();
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { ok: false, error: `unparseable response (HTTP ${res.status})` };
      transport = "unreadable";
    }
    if (!res.ok) transport = "refused";
  } catch (error) {
    payload = { ok: false, error: String(error).slice(0, 300) };
    transport = "threw";
  }

  writeFileSync(path.join(artifactsDir, `${site.caseId}.json`), JSON.stringify(payload, null, 2));

  const report = payload?.report ?? payload;
  const summary = report?.summary ?? null;
  const status = summary?.status ?? null;
  const requests = Array.isArray(report?.requests) ? report.requests : [];
  const pixelEvents = Array.isArray(report?.pixelEvents) ? report.pixelEvents : [];

  // Capture is usable only when the page actually served. A block page or a
  // transport failure is censored, never scored as a true negative: absence of
  // a pixel on a page that never loaded says nothing about the detector.
  const loaded = transport === "ok" && summary !== null && status !== null && status >= 200 && status < 400;

  results.push({
    caseId: site.caseId,
    url: site.url,
    stratum: site.stratum,
    transport,
    status,
    durationMs: summary?.durationMs ?? null,
    totalRequests: summary?.totalRequests ?? null,
    loaded,
    prediction: loaded ? (pixelEvents.length > 0 ? "detected" : "not-detected") : null,
    pixelPlatforms: pixelEvents.map((event) => event.platform),
    artifactDigest: digest(payload),
    conditionDigest,
    elapsedMs: Date.now() - started
  });

  if (loaded) {
    // Blinded packet: the request log only. No pixelEvents, no stratum, no
    // prediction, no headline or findings copy.
    const packet = {
      caseId: site.caseId,
      conditionDigest,
      recordedRequests: requests.map((request) => ({
        host: request.domain ?? null,
        path: pathOf(request.url),
        method: request.method ?? null,
        resourceType: request.resourceType ?? null,
        thirdParty: request.thirdParty === true,
        status: request.status ?? null
      }))
    };
    writeFileSync(path.join(packetsDir, `${site.caseId}.json`), JSON.stringify(packet, null, 2));
  }

  console.log(
    `${site.caseId.padEnd(7)} ${String(status).padStart(4)}  reqs=${String(summary?.totalRequests ?? "-").padStart(4)}  ` +
      `loaded=${loaded}  prediction=${results.at(-1).prediction ?? "CENSORED"}  ${site.url}`
  );
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

writeFileSync(
  path.join(here, "scan-results.json"),
  JSON.stringify({ frameDigest: digest(frame), conditionDigest, results }, null, 2)
);

const loadedCount = results.filter((entry) => entry.loaded).length;
console.log(`\n${loadedCount}/${results.length} cases produced usable capture; ${results.length - loadedCount} censored.`);
console.log(`frame digest ${digest(frame)}`);
console.log(`condition digest ${conditionDigest}`);
