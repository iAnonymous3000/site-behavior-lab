import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { AddressKernel } from "./address-kernel";
import {
  ADDRESS_COMPARISON_LOGGED_PER_KIND,
  ADDRESS_COMPARISON_SUMMARY_EVERY,
  addressComparison,
  createAddressComparison
} from "./address-kernel-comparison";
import { isPublicIpAddress } from "./ip-safety";
import { assertPublicHttpUrlShape } from "./url-safety";

// Comparison mode is an observer: these tests hold that the decision is the
// TypeScript one whatever the kernel says or does, that every outcome is
// counted where a test and an operator can read it, and that a record never
// carries the address.

const SAMPLE = [
  "8.8.8.8", "10.0.0.1", "192.168.1.1", "1.1.1.1", "127.0.0.1", "[2606:4700:4700::1111]", "fc00::1", "::1",
  "2001:db8::1", "::ffff:8.8.8.8", "::ffff:10.0.0.1", "2001:1::1", "example.com", "0177.0.0.1", "8.8.8.8."
];

const LINE =
  /^Address kernel comparison: (decision-differs|reader-differs|kernel-unavailable) at (url-resolved-addresses|url-address-literal|proxy-connect-addresses) \((ipv4|ipv6|none); TypeScript says (not )?public(, the kernel says (not )?public)?\)\. TypeScript decided\.( Further records of this kind here are counted, not logged\.)?$/;

function collect() {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
}

const opposite = (kernel: AddressKernel): AddressKernel => ({
  isPublicIpv4: (value) => !kernel.isPublicIpv4(value),
  isPublicIpv6: (high, low) => !kernel.isPublicIpv6(high, low)
});

test("with the vendored kernel every sampled address agrees, and nothing is logged", () => {
  const { lines, log } = collect();
  const comparison = createAddressComparison({ log });
  for (const address of SAMPLE) {
    assert.equal(comparison.isPublicIpAddressCompared(address, "proxy-connect-addresses"), isPublicIpAddress(address), address);
  }
  const counts = comparison.counts()["proxy-connect-addresses"];
  assert.deepEqual(counts.agreed, { ipv4: 6, ipv6: 7, none: 0 });
  assert.deepEqual(counts["not-an-address"], { ipv4: 0, ipv6: 0, none: 2 });
  assert.deepEqual(lines, []);
  assert.deepEqual(comparison.counts()["url-address-literal"].agreed, { ipv4: 0, ipv6: 0, none: 0 });
});

test("a kernel that answers the opposite changes no decision, and each difference is recorded without the address", async () => {
  const { loadAddressKernel } = await import("./address-kernel");
  const { lines, log } = collect();
  const comparison = createAddressComparison({ loadKernel: () => opposite(loadAddressKernel()), log });
  for (const address of SAMPLE) {
    assert.equal(comparison.isPublicIpAddressCompared(address, "url-resolved-addresses"), isPublicIpAddress(address), address);
  }
  const counts = comparison.counts()["url-resolved-addresses"];
  assert.deepEqual(counts["decision-differs"], { ipv4: 6, ipv6: 7, none: 0 });
  assert.deepEqual(counts.agreed, { ipv4: 0, ipv6: 0, none: 0 });
  assert.equal(lines.length, ADDRESS_COMPARISON_LOGGED_PER_KIND);
  assert.equal(
    lines[0],
    "Address kernel comparison: decision-differs at url-resolved-addresses (ipv4; TypeScript says public, the kernel says not public). TypeScript decided."
  );
  for (const line of lines) {
    assert.match(line, LINE);
    // No address, in any spelling: a line has no digit beside none, and no
    // text of a sampled address.
    assert.doesNotMatch(line.replace(/ipv[46]/g, ""), /\d/);
    for (const address of SAMPLE) assert.equal(line.includes(address), false);
  }
  assert.match(lines[ADDRESS_COMPARISON_LOGGED_PER_KIND - 1], /counted, not logged\.$/);
});

test("the reference refuses a spelling the value rule admits, and that is recorded as a difference", () => {
  const { lines, log } = collect();
  const comparison = createAddressComparison({ log });
  assert.equal(comparison.isPublicIpAddressCompared("0:0:0:0:0:ffff:8.8.8.8", "url-address-literal"), false);
  assert.deepEqual(comparison.counts()["url-address-literal"]["decision-differs"], { ipv4: 0, ipv6: 1, none: 0 });
  assert.deepEqual(lines, [
    "Address kernel comparison: decision-differs at url-address-literal (ipv6; TypeScript says not public, the kernel says public). TypeScript decided."
  ]);
});

test("a kernel that cannot load, or throws, changes no decision and is tried once", () => {
  for (const failure of ["load", "call"] as const) {
    const { lines, log } = collect();
    let loads = 0;
    const comparison = createAddressComparison({
      log,
      loadKernel: () => {
        loads += 1;
        if (failure === "load") throw new Error("absent");
        return {
          isPublicIpv4: () => {
            throw new Error("trap");
          },
          isPublicIpv6: () => {
            throw new Error("trap");
          }
        };
      }
    });
    for (const address of SAMPLE) {
      assert.equal(comparison.isPublicIpAddressCompared(address, "proxy-connect-addresses"), isPublicIpAddress(address), address);
    }
    assert.equal(loads, 1, failure);
    assert.deepEqual(comparison.counts()["proxy-connect-addresses"]["kernel-unavailable"], { ipv4: 6, ipv6: 7, none: 0 }, failure);
    assert.equal(lines.length, ADDRESS_COMPARISON_LOGGED_PER_KIND);
    for (const line of lines) assert.match(line, LINE);
    assert.match(lines[0], /^Address kernel comparison: kernel-unavailable at proxy-connect-addresses \(ipv4; TypeScript says public\)\./);
  }
});

test("a text the two readers do not agree is an address is recorded, and the kernel is not asked", () => {
  let asked = 0;
  const kernel: AddressKernel = { isPublicIpv4: () => (asked += 1) > 0, isPublicIpv6: () => (asked += 1) > 0 };
  const cases: [string, () => ReturnType<typeof import("./address-kernel").readAddressValue>, string][] = [
    ["8.8.8.8", () => null, "none"],
    ["8.8.8.8", () => { throw new Error("reader"); }, "none"],
    ["example.com", () => ({ family: 4, value: 0x08080808 }), "ipv4"]
  ];
  for (const [address, readValue, family] of cases) {
    const { lines, log } = collect();
    const comparison = createAddressComparison({ loadKernel: () => kernel, readValue, log });
    assert.equal(comparison.isPublicIpAddressCompared(address, "url-resolved-addresses"), isPublicIpAddress(address));
    const counts = comparison.counts()["url-resolved-addresses"]["reader-differs"];
    assert.equal(counts[family as "none" | "ipv4"], 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], LINE);
  }
  assert.equal(asked, 0);
});

test("a log that throws changes no decision", () => {
  const comparison = createAddressComparison({
    loadKernel: () => {
      throw new Error("absent");
    },
    log: () => {
      throw new Error("log");
    }
  });
  assert.equal(comparison.isPublicIpAddressCompared("8.8.8.8", "url-address-literal"), true);
  assert.equal(comparison.isPublicIpAddressCompared("10.0.0.1", "url-address-literal"), false);
});

test("the totals are logged once for each thousand comparisons", () => {
  const { lines, log } = collect();
  const comparison = createAddressComparison({ log });
  for (let index = 0; index < ADDRESS_COMPARISON_SUMMARY_EVERY; index += 1) {
    comparison.isPublicIpAddressCompared(index % 4 === 0 ? "2606:4700::1" : "8.8.8.8", "proxy-connect-addresses");
  }
  assert.deepEqual(lines, [
    "Address kernel comparison: 1000 comparisons in this process: agreed 1000 (ipv4 750, ipv6 250), not-an-address 0 (ipv4 0, ipv6 0), decision-differs 0 (ipv4 0, ipv6 0), reader-differs 0 (ipv4 0, ipv6 0), kernel-unavailable 0 (ipv4 0, ipv6 0)."
  ]);
});

test("the three decisions go through the comparison, and the image carries the module", () => {
  const source = (file: string): string => readFileSync(path.join(process.cwd(), file), "utf8");
  const urlSafety = source("lib/url-safety.ts");
  const proxy = source("lib/public-scan-proxy.ts");
  // Neither file asks the reference directly, so no decision is uncounted.
  assert.doesNotMatch(urlSafety, /\bisPublicIpAddress\b/);
  assert.doesNotMatch(proxy, /\bisPublicIpAddress\b/);
  assert.equal(urlSafety.match(/isPublicIpAddressCompared\(address, "url-resolved-addresses"\)/g)?.length, 1);
  assert.equal(urlSafety.match(/isPublicIpAddressCompared\(hostname, "url-address-literal"\)/g)?.length, 1);
  assert.equal(proxy.match(/isPublicIpAddressCompared\(address, "proxy-connect-addresses"\)/g)?.length, 1);
  assert.match(source("Dockerfile"), /^COPY --from=build \/app\/lib\/trust-kernel-wasm \.\/lib\/trust-kernel-wasm$/m);

  // And the process's own comparison is the one a real decision reaches.
  const before = addressComparison.counts()["url-address-literal"].agreed.ipv4;
  assert.throws(() => assertPublicHttpUrlShape(new URL("http://10.0.0.1/")), /Local and private network targets are blocked/);
  assertPublicHttpUrlShape(new URL("http://8.8.8.8/"));
  assert.equal(addressComparison.counts()["url-address-literal"].agreed.ipv4, before + 2);
});
