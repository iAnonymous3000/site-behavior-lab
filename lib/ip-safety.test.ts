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
    "fec0::1",
    "feff::1",
    "ff02::1",
    "100::1",
    "64:ff9b::1",
    "2001::1",
    "2001:2::1",
    "2001:0db8::1",
    "2002::1",
    "3fff::1",
    "3fff:0fff:ffff::1",
    "5f00::1",
    "5f00:ffff::1"
  ]) {
    assert.equal(isIpAddress(address), true, address);
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test("isPublicIpAddress keeps the 3fff::/20 documentation block on its exact CIDR boundary", () => {
  // The block's upper neighbour is global unicast and stays public. 5f00::/16
  // has no public neighbour to pin: it sits in 4000::/3, which the
  // global-unicast rule refuses whole (next test).
  assert.equal(isPublicIpAddress("3fff:0fff:ffff::1"), false);
  assert.equal(isIpAddress("3fff:1000::1"), true);
  assert.equal(isPublicIpAddress("3fff:1000::1"), true);
});

test("isPublicIpAddress refuses every IPv6 address outside global unicast, 2000::/3", () => {
  // IANA assigns public IPv6 from 2000::/3 and nowhere else. The rest is a
  // special range or "Reserved by IETF", and reserved space is what overlay
  // and mesh networks borrow (0200::/7 for one), so a self-hosted scanner can
  // hold a route to it. Reading any of it as public lets a scanned page have
  // the proxy dial into that network.
  for (const address of [
    "1::1",
    "ff::1",
    "101::1",
    "200::1",
    "201:abcd::1",
    "300::1",
    "3ff:ffff::1",
    "400::1",
    "800::1",
    "1000::1",
    "1fff::1",
    "1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "4000::",
    "4000::1",
    "5eff:ffff::1",
    "5f01::1",
    "6000::1",
    "8000::1",
    "a000::1",
    "c000::1",
    "e000::1",
    "f000::1",
    "f800::1",
    "fbff::1",
    "fe00::1",
    "fe7f::1"
  ]) {
    assert.equal(isIpAddress(address), true, address);
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test("isPublicIpAddress refuses every special-purpose address the registries list, in both families", () => {
  for (const address of [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.254",
    "192.0.0.1",
    "192.0.0.192",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.19.255.254",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "::127.0.0.1",
    "::7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:0:7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1",
    "64:ff9b:1::a00:1",
    "100::1",
    "100:0:0:1::1",
    "2001::1",
    "2001:0:7f00:1::1",
    "2001:2::1",
    "2001:10::1",
    "2001:20::1",
    "2001:30::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "2002:a00:1::1",
    "3fff::1",
    "3fff:fff::1",
    "5f00::1",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "ff0e::1"
  ]) {
    assert.equal(isIpAddress(address), true, address);
    assert.equal(isPublicIpAddress(address), false, address);
  }

  // Not addresses at all, so never public: a zone id, a short or long dotted
  // form, and the hex and short spellings a URL parser would have rewritten.
  for (const value of ["fe80::1%lo0", "::1%0", "1.2.3", "1.2.3.4.5", "0x7f.0.0.1", "127.1"]) {
    assert.equal(isPublicIpAddress(value), false, value);
  }
});

test("isPublicIpAddress still admits ordinary public addresses in both families", () => {
  // The global-unicast rule must cost no honest target: these are routable,
  // and a scanner that declines them is declining real sites.
  for (const address of [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.0.1",
    "172.32.0.1",
    "192.0.1.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.175.48.1",
    "198.17.0.1",
    "198.20.0.1",
    "223.255.255.254",
    // The first and last global unicast words, then prefixes each regional
    // registry has delegated.
    "2000::1",
    "3fff:ffff::1",
    "2001:200::1",
    "2001:4860:4860::8888",
    "2400:cb00:2048:1::c629:d7a2",
    "2606:4700:4700::1111",
    "2620:fe::fe",
    "2620:4f:8000::1",
    "2800:3f0:4001:800::200e",
    "2a00:1450::1",
    "2a03:2880:f12f:83:face:b00c:0:25de",
    "2c0f:fb50:4003:802::200e",
    "3ffe::1",
    // Inside 2001::/23, the assignments the registry marks reachable.
    "2001:1::1",
    "2001:1::2",
    "2001:1::3",
    "2001:3::1",
    "2001:4:112::1",
    // An IPv4-mapped address is judged as the IPv4 address it carries.
    "::ffff:8.8.8.8",
    "::ffff:808:808"
  ]) {
    assert.equal(isIpAddress(address), true, address);
    assert.equal(isPublicIpAddress(address), true, address);
  }
});

test("a dotted quad with a leading zero in an octet is not an IPv4 address", () => {
  // inet_aton reads a leading zero as octal, and getaddrinfo and URL parsers
  // follow it: 0177.0.0.1 is loopback to them. Reading it as decimal
  // 177.0.0.1 calls a loopback spelling public and skips the resolver, so
  // the form is not an address here and its resolved answer is checked.
  for (const value of [
    "0177.0.0.1",
    "0177.0.0.01",
    "010.0.0.1",
    "8.8.8.08",
    "127.000.000.001",
    "00.0.0.0",
    "0177.0.0.1.",
    "::ffff:0177.0.0.1",
    "2606:4700::0177.0.0.1"
  ]) {
    assert.equal(isIpAddress(value), false, value);
    assert.equal(isPublicIpAddress(value), false, value);
  }

  // A lone zero octet is not a leading zero.
  for (const value of ["8.8.8.8", "1.0.0.1", "100.200.0.255", "::ffff:8.8.0.8"]) {
    assert.equal(isIpAddress(value), true, value);
    assert.equal(isPublicIpAddress(value), true, value);
  }
  assert.equal(isIpAddress("0.0.0.0"), true);
  assert.equal(isIpAddress("255.255.255.255"), true);
  assert.equal(isIpAddress("256.1.1.1"), false);
  assert.equal(isIpAddress("1.1.1.1000"), false);
});
