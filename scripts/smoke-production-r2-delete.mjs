#!/usr/bin/env node

import {
  readResponseTextWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";

const endpointWire = process.env.PRODUCTION_R2_DELETE_CANARY_URL?.trim() ?? "";
const token = process.env.PRODUCTION_R2_DELETE_CANARY_TOKEN?.trim() ?? "";
const timeoutMs = boundedInteger(process.env.PRODUCTION_R2_DELETE_CANARY_TIMEOUT_MS, 30_000, 5_000, 60_000);
const responseMaxBytes = 64 * 1024;

if (token.length < 32) fail("Production R2 delete-canary token is missing or too short.");

let endpoint;
try {
  endpoint = new URL(endpointWire);
} catch {
  fail("Production R2 delete-canary URL is invalid.");
}
if (
  endpoint.protocol !== "https:" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash ||
  (endpoint.pathname !== "/" && endpoint.pathname !== "")
) {
  fail("Production R2 delete-canary URL must be a credential-free HTTPS origin.");
}

const runUrl = new URL("/run", endpoint.origin);
let response;
let responseWire;
try {
  ({ response, value: responseWire } = await withHttpOperationDeadline(
    { timeoutMs, label: "Production R2 delete canary" },
    async (signal) => {
      const boundedResponse = await fetch(runUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json"
        },
        cache: "no-store",
        redirect: "error",
        signal
      });
      const value = await readResponseTextWithinLimit(boundedResponse, {
        maxBytes: responseMaxBytes,
        label: "Production R2 delete canary"
      });
      return { response: boundedResponse, value };
    }
  ));
} catch (error) {
  if (error instanceof RangeError) fail(error.message);
  fail(`Production R2 delete canary did not respond within ${timeoutMs}ms.`);
}

const contentType = response.headers.get("content-type") ?? "";
if (!contentType.includes("application/json")) {
  fail(`Production R2 delete canary returned ${response.status} with non-JSON content.`);
}

let result;
try {
  result = JSON.parse(responseWire);
} catch {
  fail("Production R2 delete canary returned malformed JSON.");
}

if (
  !response.ok ||
  result?.ok !== true ||
  result?.status !== "passed" ||
  result?.scope !== "r2-write-read-delete" ||
  result?.keyPrefix !== "health/r2-delete-canary/" ||
  result?.created !== true ||
  result?.readBack !== true ||
  result?.deleted !== true
) {
  fail(`Production R2 delete canary failed its bounded contract (HTTP ${response.status}).`);
}

console.log("PASS production R2 canary created, read back, deleted, and proved absence for one isolated object.");

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) fail("Production R2 delete-canary timeout must be an integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`Production R2 delete-canary timeout must be between ${minimum} and ${maximum}ms.`);
  }
  return parsed;
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}
