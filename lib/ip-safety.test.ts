import assert from "node:assert/strict";
import { test } from "node:test";
import { isIpAddress, isPublicIpAddress, normalizeHostname } from "./ip-safety";

test("normalizeHostname lowercases brackets and trailing dots", () => {
  assert.equal(normalizeHostname("[2606:4700:4700::1111]."), "2606:4700:4700::1111");
  assert.equal(normalizeHostname("Example.COM."), "example.com");
});

test("isPublicIpAddress allows public IPv4 and IPv6 addresses", () => {
  assert.equal(isIpAddress("1.1.1.1"), true);
  assert.equal(isPublicIpAddress("1.1.1.1"), true);
  assert.equal(isIpAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicIpAddress("2001:4860:4860::8888"), true);
});

test("isPublicIpAddress blocks private and reserved IPv4 addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.10.20",
    "172.16.0.1",
    "192.0.2.10",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.9",
    "203.0.113.2",
    "224.0.0.1"
  ]) {
    assert.equal(isIpAddress(address), true, address);
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test("isPublicIpAddress blocks private and reserved IPv6 addresses", () => {
  for (const address of [
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "100::1",
    "64:ff9b::1",
    "2001::1",
    "2001:2::1",
    "2001:0db8::1",
    "2002::1"
  ]) {
    assert.equal(isIpAddress(address), true, address);
    assert.equal(isPublicIpAddress(address), false, address);
  }
});
