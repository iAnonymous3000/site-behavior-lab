import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PublicScanError } from "./public-errors";
import { assertScanAccess, scanAccessTokenConfigured } from "./access-control";

const SCAN_ACCESS_TOKEN_ENV = "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN";

afterEach(() => {
  delete process.env[SCAN_ACCESS_TOKEN_ENV];
});

test("assertScanAccess allows requests when no access token is configured", () => {
  assert.equal(scanAccessTokenConfigured(), false);
  assert.doesNotThrow(() => assertScanAccess(new Request("http://localhost/api/scan")));
});

test("assertScanAccess accepts the scanner access header", () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";

  const request = new Request("http://localhost/api/scan", {
    headers: { "x-site-behavior-lab-access-token": "secret-key" }
  });

  assert.equal(scanAccessTokenConfigured(), true);
  assert.doesNotThrow(() => assertScanAccess(request));
});

test("assertScanAccess accepts bearer authorization", () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";

  const request = new Request("http://localhost/api/scan", {
    headers: { authorization: "Bearer secret-key" }
  });

  assert.doesNotThrow(() => assertScanAccess(request));
});

test("assertScanAccess rejects missing or incorrect access keys", () => {
  process.env[SCAN_ACCESS_TOKEN_ENV] = "secret-key";

  assert.throws(
    () => assertScanAccess(new Request("http://localhost/api/scan")),
    (error) => error instanceof PublicScanError && error.status === 401
  );
  assert.throws(
    () =>
      assertScanAccess(
        new Request("http://localhost/api/scan", {
          headers: { "x-site-behavior-lab-access-token": "wrong-key" }
        })
      ),
    (error) => error instanceof PublicScanError && error.status === 401
  );
});
