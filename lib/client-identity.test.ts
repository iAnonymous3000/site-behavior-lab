import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clientIdentityForAddress,
  edgeClientIdentity,
  UNKNOWN_CLIENT_IDENTITY
} from "./client-identity";

test("every address of one IPv6 /64 is one client, and the next /64 is another", () => {
  const one = [
    "2001:db8:aaaa:bbbb::1",
    "2001:db8:aaaa:bbbb::2",
    "2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff",
    "2001:0db8:AAAA:BBBB:0000:0000:0000:0001",
    "2001:db8:aaaa:bbbb:1:2:3:4",
    "[2001:db8:aaaa:bbbb::7]",
    "  2001:db8:aaaa:bbbb::8  "
  ].map(clientIdentityForAddress);
  assert.deepEqual([...new Set(one)], ["2001:db8:aaaa:bbbb::/64"]);

  assert.equal(clientIdentityForAddress("2001:db8:aaaa:bbbc::1"), "2001:db8:aaaa:bbbc::/64");
  assert.equal(clientIdentityForAddress("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientIdentityForAddress("::1"), "0:0:0:0::/64");
  assert.equal(clientIdentityForAddress("fe80::1:2:3:4"), "fe80:0:0:0::/64");
});

test("an IPv4 address is its own client, and its IPv6-mapped spelling is the same client", () => {
  assert.equal(clientIdentityForAddress("203.0.113.7"), "203.0.113.7");
  assert.notEqual(clientIdentityForAddress("203.0.113.7"), clientIdentityForAddress("203.0.113.8"));
  for (const mapped of ["::ffff:203.0.113.7", "::FFFF:203.0.113.7", "::ffff:cb00:7107", "0:0:0:0:0:ffff:203.0.113.7"]) {
    assert.equal(clientIdentityForAddress(mapped), "203.0.113.7", mapped);
  }
  // Not the mapped prefix: an ordinary IPv6 address with a dotted tail.
  assert.equal(clientIdentityForAddress("64:ff9b::203.0.113.7"), "64:ff9b:0:0::/64");
});

test("text that is not an address is never merged with other text", () => {
  for (const text of [
    "unknown",
    "not-an-ip",
    "203.0.113.7:4711",
    "[2001:db8::1]:443",
    "2001:db8::1%eth0",
    "1::2::3",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7:",
    "12345::1",
    "g::1",
    "203.0.113.7::1",
    "::ffff:203.0.113.999",
    "1:2:3:4:5:6:7::8",
    ":"
  ]) {
    assert.equal(clientIdentityForAddress(text), text, text);
  }
  assert.equal(clientIdentityForAddress("  padded  "), "padded");
});

test("the edge identity reads only Cloudflare's client address", () => {
  const identity = (headers: Record<string, string>) => edgeClientIdentity(new Headers(headers));

  assert.equal(identity({ "cf-connecting-ip": "203.0.113.7" }), "203.0.113.7");
  assert.equal(identity({ "cf-connecting-ip": " 2001:db8:aaaa:bbbb::9 " }), "2001:db8:aaaa:bbbb::/64");
  // A caller header never moves the identity Cloudflare supplied.
  assert.equal(
    identity({ "cf-connecting-ip": "203.0.113.7", "x-real-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2" }),
    "203.0.113.7"
  );
  // Without Cloudflare's header every request shares one bucket: a caller
  // header must not be able to choose another.
  assert.equal(identity({}), UNKNOWN_CLIENT_IDENTITY);
  assert.equal(identity({ "cf-connecting-ip": "   " }), UNKNOWN_CLIENT_IDENTITY);
  assert.equal(identity({ "x-real-ip": "198.51.100.1" }), UNKNOWN_CLIENT_IDENTITY);
  assert.equal(identity({ "x-forwarded-for": "198.51.100.2, 198.51.100.3" }), UNKNOWN_CLIENT_IDENTITY);
});
