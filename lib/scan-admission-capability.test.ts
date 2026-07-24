import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  SCAN_ADMISSION_CAPABILITY_HEADER,
  SCAN_ADMISSION_COMMITMENT_HEADER,
  hashScanAdmissionCapabilityToken,
  isScanAdmissionCapabilityToken,
  isScanAdmissionCommitment,
  mintScanAdmissionCredential,
  scanAdmissionCredentialFromHeaders,
  scanAdmissionCredentialMatchesSemantics,
  scanAdmissionSemanticsFromBody
} from "./scan-admission-capability";

const TOKEN_BYTES = Uint8Array.from({ length: 32 }, (_value, index) => index);
const CAPABILITY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const BODY = {
  url: "https://EXAMPLE.com:443/path",
  device: "desktop",
  gpcEnabled: true,
  compareGpc: true,
  compareShields: false,
  compareConsent: false,
  consentMode: "observe",
  turnstileToken: "one-shot-human-verification"
} as const;

test("a 256-bit browser capability is HMAC-bound to canonical scan semantics", async () => {
  const semantics = scanAdmissionSemanticsFromBody(BODY);
  assert.deepEqual(semantics, {
    version: 1,
    url: "https://example.com/path",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: true,
    compareShields: false,
    compareConsent: false,
    consentMode: "observe"
  });
  assert.ok(semantics);

  const credential = await mintScanAdmissionCredential(semantics, () => TOKEN_BYTES);
  assert.equal(credential.capabilityToken, CAPABILITY);
  const canonical = JSON.stringify(semantics);
  const expected = createHmac("sha256", TOKEN_BYTES)
    .update(`site-behavior-lab/scan-admission/commitment/v1\0${canonical}`)
    .digest("base64url");
  assert.equal(credential.requestCommitment, expected);
  assert.equal(isScanAdmissionCapabilityToken(credential.capabilityToken), true);
  assert.equal(isScanAdmissionCommitment(credential.requestCommitment), true);
  assert.equal(await scanAdmissionCredentialMatchesSemantics(credential, semantics), true);

  assert.deepEqual(
    Buffer.from(await hashScanAdmissionCapabilityToken(CAPABILITY)),
    createHash("sha256").update(TOKEN_BYTES).digest()
  );
});

test("authorization tokens are excluded while every scan-behavior change alters the commitment", async () => {
  const first = scanAdmissionSemanticsFromBody(BODY);
  const second = scanAdmissionSemanticsFromBody({
    ...BODY,
    turnstileToken: "different-one-shot-token"
  });
  assert.deepEqual(second, first);
  assert.ok(first);
  assert.ok(second);

  const credential = await mintScanAdmissionCredential(first, () => TOKEN_BYTES);
  assert.equal(await scanAdmissionCredentialMatchesSemantics(credential, second), true);

  const changed = scanAdmissionSemanticsFromBody({
    ...BODY,
    compareGpc: false,
    gpcEnabled: false
  });
  assert.ok(changed);
  assert.equal(await scanAdmissionCredentialMatchesSemantics(credential, changed), false);

  const changedQuery = scanAdmissionSemanticsFromBody({
    ...BODY,
    url: "https://example.com/path?account=second"
  });
  assert.ok(changedQuery);
  assert.equal(await scanAdmissionCredentialMatchesSemantics(credential, changedQuery), false);
});

test("header parsing is strict and optionally verifies the semantic commitment", async () => {
  const semantics = scanAdmissionSemanticsFromBody(BODY);
  assert.ok(semantics);
  const credential = await mintScanAdmissionCredential(semantics, () => TOKEN_BYTES);
  const headers = new Headers({
    [SCAN_ADMISSION_CAPABILITY_HEADER]: credential.capabilityToken,
    [SCAN_ADMISSION_COMMITMENT_HEADER]: credential.requestCommitment
  });
  assert.deepEqual(await scanAdmissionCredentialFromHeaders(headers), credential);
  assert.deepEqual(await scanAdmissionCredentialFromHeaders(headers, semantics), credential);

  const changed = scanAdmissionSemanticsFromBody({ ...BODY, device: "mobile" });
  assert.ok(changed);
  assert.equal(await scanAdmissionCredentialFromHeaders(headers, changed), null);

  headers.set(
    SCAN_ADMISSION_COMMITMENT_HEADER,
    `${credential.requestCommitment.slice(0, -1)}${credential.requestCommitment.endsWith("A") ? "B" : "A"}`
  );
  assert.equal(await scanAdmissionCredentialFromHeaders(headers, semantics), null);
});

test("invalid or ambiguous request semantics and capability sources fail before use", async () => {
  assert.equal(scanAdmissionSemanticsFromBody({ ...BODY, compareShields: true }), null);
  assert.equal(scanAdmissionSemanticsFromBody({ ...BODY, unexpected: true }), null);
  assert.equal(
    scanAdmissionSemanticsFromBody({ ...BODY, url: "https://example.com/?secret=1#private" })?.url,
    "https://example.com/?secret=1"
  );
  assert.equal(scanAdmissionSemanticsFromBody({ ...BODY, turnstileToken: 123 }), null);
  assert.equal(isScanAdmissionCapabilityToken(`${CAPABILITY}=`), false);
  assert.equal(isScanAdmissionCommitment(CAPABILITY.slice(1)), false);

  const semantics = scanAdmissionSemanticsFromBody(BODY);
  assert.ok(semantics);
  await assert.rejects(
    mintScanAdmissionCredential(semantics, () => new Uint8Array(31)),
    /Invalid scan-admission capability source/
  );
  await assert.rejects(
    hashScanAdmissionCapabilityToken(`${CAPABILITY}=`),
    /Invalid scan-admission capability token/
  );
});
