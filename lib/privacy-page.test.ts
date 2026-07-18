import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function readNormalized(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8").replace(/\s+/g, " ");
}

test("privacy page pins the durable-queue data boundary", () => {
  const privacyPage = readNormalized("app/privacy/page.tsx");

  assert.match(privacyPage, /scheme, host, and path/);
  assert.match(privacyPage, /at most 75 minutes/);
  assert.match(privacyPage, /never contains your IP address or client hash/);
  assert.match(privacyPage, /Turnstile or access tokens/);
  assert.match(privacyPage, /request headers, cookies, screenshots, page evidence, or scan results/);
  assert.match(privacyPage, /encrypts a job record before committing it/);
  assert.match(privacyPage, /recovery snapshots.*copies remain application-encrypted/);
});

test("methodology page discloses retry behavior without merging attempts", () => {
  const methodologyPage = readNormalized("app/methodology/page.tsx");

  assert.match(methodologyPage, /fenced lease with at most two attempts/);
  assert.match(methodologyPage, /extra automated visit that was partial or that completed before its result was lost/);
  assert.match(methodologyPage, /never combines requests or other evidence across attempts/);
  assert.match(methodologyPage, /reconciles that exact report instead of visiting the site again/);
});
