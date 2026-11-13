import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ADDRESS_KERNEL_FILE,
  ADDRESS_KERNEL_SHA256,
  kernelAnswer,
  kernelSaysPublic,
  loadAddressKernel,
  readAddressValue
} from "./address-kernel";
import { isPublicIpAddress } from "./ip-safety";

// Tests of the seam around the checked functions: the pinned bytes, the two
// value entry points and the reader that makes a value from a text. These
// are samples. The statement over every value is Verus's and is about the
// Rust functions; nothing here extends it.

const root = process.cwd();
const vendored = (): Buffer => readFileSync(path.join(root, ADDRESS_KERNEL_FILE));

function publicByValue(text: string): boolean {
  const value = readAddressValue(text);
  assert.ok(value, `${text} has a value`);
  return kernelSaysPublic(loadAddressKernel(), value);
}

test("the vendored module is the bytes the contract records for every host that built it", () => {
  const contract = JSON.parse(readFileSync(path.join(root, "tools/trust-kernel/reproducibility-contract.json"), "utf8")) as {
    observed: Record<string, { bytes: number; sha256: string }>;
  };
  const hosts = Object.keys(contract.observed);
  assert.ok(hosts.length >= 2, "the contract lists at least two hosts");
  const bytes = vendored();
  assert.equal(createHash("sha256").update(bytes).digest("hex"), ADDRESS_KERNEL_SHA256);
  for (const host of hosts) {
    assert.equal(contract.observed[host].sha256, ADDRESS_KERNEL_SHA256, host);
    assert.equal(contract.observed[host].bytes, bytes.length, host);
  }
});

test("a module that is not the pinned bytes is refused, and so is a missing one", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "address-kernel-test-"));
  try {
    const bytes = vendored();
    bytes[bytes.length - 1] ^= 1;
    const changed = path.join(directory, "changed.wasm");
    writeFileSync(changed, bytes);
    assert.throws(() => loadAddressKernel(changed), /not the pinned one/);
    assert.throws(() => loadAddressKernel(path.join(directory, "absent.wasm")), /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an entry point's number is an answer only when it is 1 or 0", () => {
  assert.equal(kernelAnswer(1), true);
  assert.equal(kernelAnswer(0), false);
  for (const code of [2, -1, 0.5, Number.NaN]) assert.throws(() => kernelAnswer(code), /not an answer/);
});

test("a text is read into the value Node gives it, and a text Node does not read has none", () => {
  assert.deepEqual(readAddressValue("1.2.3.4"), { family: 4, value: 0x01020304 });
  assert.deepEqual(readAddressValue("255.255.255.255"), { family: 4, value: 0xffffffff });
  assert.deepEqual(readAddressValue("2001:db8:1:2:3:4:5:6"), {
    family: 6,
    high: BigInt("0x20010db800010002"),
    low: BigInt("0x0003000400050006")
  });
  assert.deepEqual(readAddressValue("2606:4700::1111"), { family: 6, high: BigInt("0x2606470000000000"), low: BigInt("0x1111") });
  assert.deepEqual(readAddressValue("::ffff:1.2.3.4"), { family: 6, high: BigInt(0), low: BigInt("0xffff01020304") });
  assert.deepEqual(readAddressValue("::"), { family: 6, high: BigInt(0), low: BigInt(0) });
  for (const text of ["01.2.3.4", "1.2.3", "256.1.1.1", "example.com", "", "fe80::1%en0", "1::2::3", "[::1]"]) {
    assert.equal(readAddressValue(text), null, text);
  }
});

test("the IPv4 entry point answers as the reference on both sides of every block edge", () => {
  const edges = [
    "0.0.0.0", "0.255.255.255", "1.0.0.0", "9.255.255.255", "10.0.0.0", "10.255.255.255", "11.0.0.0",
    "100.63.255.255", "100.64.0.0", "100.127.255.255", "100.128.0.0", "126.255.255.255", "127.0.0.0",
    "127.255.255.255", "128.0.0.0", "169.253.255.255", "169.254.0.0", "169.254.255.255", "169.255.0.0",
    "172.15.255.255", "172.16.0.0", "172.31.255.255", "172.32.0.0", "191.255.255.255", "192.0.0.0",
    "192.0.0.255", "192.0.1.0", "192.0.1.255", "192.0.2.0", "192.0.2.255", "192.0.3.0", "192.88.98.255",
    "192.88.99.0", "192.88.99.255", "192.88.100.0", "192.167.255.255", "192.168.0.0", "192.168.255.255",
    "192.169.0.0", "198.17.255.255", "198.18.0.0", "198.19.255.255", "198.20.0.0", "198.51.99.255",
    "198.51.100.0", "198.51.100.255", "198.51.101.0", "203.0.112.255", "203.0.113.0", "203.0.113.255",
    "203.0.114.0", "223.255.255.255", "224.0.0.0", "255.255.255.255"
  ];
  let publicCount = 0;
  for (const text of edges) {
    const expected = isPublicIpAddress(text);
    assert.equal(publicByValue(text), expected, text);
    if (expected) publicCount += 1;
  }
  // Both answers must occur, or the loop compared nothing of interest.
  assert.equal(publicCount, 26);
  assert.equal(publicByValue("8.8.8.8"), true);
  assert.equal(publicByValue("10.0.0.1"), false);
  // The first octet is the most significant byte: 1.0.0.10 is public and
  // 10.0.0.1 is not, so reversed octets would be seen.
  assert.equal(publicByValue("1.0.0.10"), true);
});

test("the IPv6 entry point answers as the reference, and each half of the value is where it belongs", () => {
  const kernel = loadAddressKernel();
  const texts = [
    "::", "::1", "2606:4700:4700::1111", "2001:4860:4860::8888", "1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2000::", "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "4000::", "2001::1", "2001:1::", "2001:1::1",
    "2001:1::2", "2001:1::3", "2001:1::4", "2001:2::1", "2001:3::1", "2001:4:111::1", "2001:4:112::1",
    "2001:4:113::1", "2001:10::1", "2001:20::1", "2001:30::1", "2001:1ff:ffff::1", "2001:200::1",
    "2001:db8::1", "2001:db7:ffff::1", "2001:db9::1", "2002::1", "2003::1", "3fff::1", "3fff:fff:ffff::1",
    "3fff:1000::1", "64:ff9b::808:808", "100::1", "fc00::1", "fe80::1", "fec0::1", "ff02::1",
    "::ffff:8.8.8.8", "::ffff:10.0.0.1", "::ffff:808:808", "::ffff:a00:1"
  ];
  let publicCount = 0;
  for (const text of texts) {
    const expected = isPublicIpAddress(text);
    assert.equal(publicByValue(text), expected, text);
    if (expected) publicCount += 1;
  }
  assert.ok(publicCount >= 10 && texts.length - publicCount >= 10, `${publicCount} of ${texts.length} public`);

  // The answer follows the first half: the same number is public as the
  // first eight bytes and not public as the last eight.
  assert.equal(kernel.isPublicIpv6(BigInt("0x2606470000000001"), BigInt(0)), true);
  assert.equal(kernel.isPublicIpv6(BigInt(0), BigInt("0x2606470000000001")), false);
  // The answer follows the second half: 2001:1::1 is one of three public
  // addresses in its block and 2001:1::4 is not.
  assert.equal(kernel.isPublicIpv6(BigInt("0x2001000100000000"), BigInt(1)), true);
  assert.equal(kernel.isPublicIpv6(BigInt("0x2001000100000000"), BigInt(4)), false);
  // And the far end of each half is read: the last bit, and the first.
  assert.equal(kernel.isPublicIpv6(BigInt("0x2001000100000000"), BigInt("0x8000000000000001")), false);
  assert.equal(kernel.isPublicIpv6(BigInt("0xa001000100000000"), BigInt(1)), false);
});

test("a value spelled another way is the same value, where the reference follows the spelling", () => {
  // The reference refuses these spellings; the value rule cannot see a
  // spelling. This is the difference the flip criteria name, pinned here so
  // a change on either side is seen.
  for (const [spelled, canonical] of [
    ["0:0:0:0:0:ffff:8.8.8.8", "::ffff:8.8.8.8"],
    ["2001:1:0:0:0:0:0:1", "2001:1::1"]
  ]) {
    assert.deepEqual(readAddressValue(spelled), readAddressValue(canonical));
    assert.equal(isPublicIpAddress(canonical), true, canonical);
    assert.equal(isPublicIpAddress(spelled), false, spelled);
    assert.equal(publicByValue(spelled), true, spelled);
  }
});
