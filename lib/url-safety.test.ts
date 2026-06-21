import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicHttpUrl, assertPublicHttpUrlShape, normalizeUrl } from "./url-safety";

test("normalizeUrl trims input, adds https, and removes fragments", () => {
  assert.equal(normalizeUrl(" example.com/path?x=1#frag ").toString(), "https://example.com/path?x=1");
  assert.equal(normalizeUrl("HTTP://Example.com/a#section").toString(), "http://example.com/a");
});

test("normalizeUrl rejects empty input and non-http protocols", () => {
  assert.throws(() => normalizeUrl(""), /Enter a public URL/);
  assert.throws(() => normalizeUrl("file:///etc/passwd"), /Only HTTP and HTTPS/);
  assert.throws(() => normalizeUrl("javascript:alert(1)"), /Only HTTP and HTTPS/);
});

test("normalizeUrl rejects credentials", () => {
  assert.throws(() => normalizeUrl("https://user:pass@example.com"), /Credentials in URLs/);
});

test("normalizeUrl canonicalizes non-decimal IPv4 forms before safety checks", () => {
  assert.equal(normalizeUrl("http://2130706433/").hostname, "127.0.0.1");
  assert.equal(normalizeUrl("http://0177.0.0.1/").hostname, "127.0.0.1");
  assert.equal(normalizeUrl("http://0x7f.0.0.1/").hostname, "127.0.0.1");
  assert.equal(normalizeUrl("http://127.1/").hostname, "127.0.0.1");
});

test("assertPublicHttpUrl allows public IP literals without DNS", async () => {
  await assert.doesNotReject(() => assertPublicHttpUrl(new URL("https://1.1.1.1/")));
  await assert.doesNotReject(() => assertPublicHttpUrl(new URL("https://[2606:4700:4700::1111]/")));
  await assert.doesNotReject(() => assertPublicHttpUrl(new URL("https://[2001:4860:4860::8888]/")));
});

test("assertPublicHttpUrlShape performs structural checks without DNS", () => {
  assert.doesNotThrow(() => assertPublicHttpUrlShape(new URL("https://unresolved.invalid/")));
  assert.throws(() => assertPublicHttpUrlShape(new URL("https://127.0.0.1/")), /Local and private/);
  assert.throws(() => assertPublicHttpUrlShape(new URL("https://example.com:8443/")), /standard HTTP and HTTPS ports/);
});

test("assertPublicHttpUrl blocks localhost names without DNS", async () => {
  await assertLocalBlocked("http://localhost/");
  await assertLocalBlocked("http://localhost./");
  await assertLocalBlocked("http://scan.localhost/");
  await assertLocalBlocked("http://printer.local/");
  await assertLocalBlocked("http://router.internal/");
});

test("assertPublicHttpUrl blocks private and reserved IPv4 literals", async () => {
  const blocked = [
    "http://0.0.0.0/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f.0.0.1/",
    "http://127.1/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://127.0.0.1/",
    "http://169.254.10.20/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.0.0.1/",
    "http://192.0.2.10/",
    "http://192.88.99.1/",
    "http://192.168.1.1/",
    "http://198.18.0.1/",
    "http://198.51.100.9/",
    "http://203.0.113.2/",
    "http://224.0.0.1/"
  ];

  await Promise.all(blocked.map((url) => assertLocalBlocked(url)));
});

test("assertPublicHttpUrl blocks private and reserved IPv6 literals", async () => {
  const blocked = [
    "http://[::]/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fc00::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[febf::1]/",
    "http://[ff02::1]/",
    "http://[2001::1]/",
    "http://[2001:2::1]/",
    "http://[2001:db8::1]/",
    "http://[2002::1]/"
  ];

  await Promise.all(blocked.map((url) => assertLocalBlocked(url)));
});

test("assertPublicHttpUrl blocks custom ports", async () => {
  await assert.rejects(
    () => assertPublicHttpUrl(new URL("https://1.1.1.1:8443/")),
    /standard HTTP and HTTPS ports/
  );
  await assert.rejects(
    () => assertPublicHttpUrl(new URL("http://127.0.0.1:3000/")),
    /Local and private network targets are blocked/
  );
});

async function assertLocalBlocked(url: string): Promise<void> {
  await assert.rejects(() => assertPublicHttpUrl(new URL(url)), /Local and private network targets are blocked/);
}
