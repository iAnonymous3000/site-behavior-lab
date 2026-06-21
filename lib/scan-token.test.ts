import assert from "node:assert/strict";
import { test } from "node:test";
import { scanTokenFromHeaders, SCAN_TOKEN_REQUEST_HEADERS } from "./scan-token";

test("scanTokenFromHeaders reads a Bearer authorization token", () => {
  assert.equal(scanTokenFromHeaders(new Headers({ authorization: "Bearer  secret-token " })), "secret-token");
});

test("scanTokenFromHeaders reads the documented access-token header", () => {
  assert.equal(scanTokenFromHeaders(new Headers({ "x-site-behavior-lab-access-token": " secret-token " })), "secret-token");
});

test("scanTokenFromHeaders reads the legacy Worker header", () => {
  assert.equal(scanTokenFromHeaders(new Headers({ "x-sbl-scan-token": "secret-token" })), "secret-token");
});

test("scanTokenFromHeaders prefers Bearer, then access-token, then legacy", () => {
  const headers = new Headers({
    authorization: "Bearer bearer-token",
    "x-site-behavior-lab-access-token": "access-token",
    "x-sbl-scan-token": "legacy-token"
  });
  assert.equal(scanTokenFromHeaders(headers), "bearer-token");

  const withoutBearer = new Headers({
    "x-site-behavior-lab-access-token": "access-token",
    "x-sbl-scan-token": "legacy-token"
  });
  assert.equal(scanTokenFromHeaders(withoutBearer), "access-token");
});

test("scanTokenFromHeaders returns an empty string when no token is present", () => {
  assert.equal(scanTokenFromHeaders(new Headers()), "");
  assert.equal(scanTokenFromHeaders(new Headers({ authorization: "Basic abc" })), "");
});

test("SCAN_TOKEN_REQUEST_HEADERS lists the non-standard token headers for CORS", () => {
  assert.deepEqual([...SCAN_TOKEN_REQUEST_HEADERS], ["x-site-behavior-lab-access-token", "x-sbl-scan-token"]);
});
