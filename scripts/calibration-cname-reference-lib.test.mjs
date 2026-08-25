import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildCaseWorksheet,
  firstPartyHostsFromHar,
  matchExternalTracker,
  parseTrackerSource,
  registrableDomain
} from "./calibration-cname-reference-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const SUFFIXES = new Set(["com", "co.uk", "net", "org"]);

function har(urls) {
  return { log: { entries: urls.map((url) => ({ request: { url } })) } };
}

test("the reference reads only first-party subdomains from the reviewer's own capture", () => {
  const hosts = firstPartyHostsFromHar(
    har([
      "https://example.com/",
      "https://metrics.example.com/beacon",
      "https://cdn.example.com/app.js",
      "https://www.google-analytics.com/collect",
      "https://example.com/page2"
    ]),
    "https://example.com/",
    SUFFIXES
  );
  // The registrable apex is excluded (it cannot be aliased without breaking the
  // site) and so is every third party; only first-party subdomains remain.
  assert.deepEqual(hosts, ["cdn.example.com", "metrics.example.com"]);
});

test("candidate scope matches the detector's, which skips only the registrable apex", () => {
  // Scanning https://shop.example.com/ makes example.com the apex, so
  // shop.example.com IS a candidate for the detector (lib/cname-uncloaking.ts
  // cnameCloakCandidates skips `host === firstPartyRegistrable`, nothing else).
  // The reference has to draw the same boundary or it manufactures
  // disagreements that are scope differences rather than detector errors.
  const hosts = firstPartyHostsFromHar(
    har(["https://shop.example.com/", "https://metrics.shop.example.com/b"]),
    "https://shop.example.com/",
    SUFFIXES
  );
  assert.deepEqual(hosts, ["metrics.shop.example.com", "shop.example.com"]);
});

test("the reference refuses private and non-public hosts a capture may contain", () => {
  const hosts = firstPartyHostsFromHar(
    har([
      "https://localhost/",
      "http://127.0.0.1/",
      "https://build.internal/",
      "https://metrics.example.com/x"
    ]),
    "https://example.com/",
    SUFFIXES
  );
  assert.deepEqual(hosts, ["metrics.example.com"]);
});

test("external tracker matching respects label boundaries, not substrings", () => {
  const { suffixes } = parseTrackerSource(
    Buffer.from("# comment\nomtrdc.net\n\nexample-tracker.com\n")
  );
  assert.equal(matchExternalTracker("a.b.omtrdc.net", suffixes), "omtrdc.net");
  assert.equal(matchExternalTracker("omtrdc.net", suffixes), "omtrdc.net");
  // "notomtrdc.net" contains the string but is a different registrable name.
  assert.equal(matchExternalTracker("notomtrdc.net", suffixes), null);
  assert.equal(matchExternalTracker("omtrdc.net.evil.com", suffixes), null);
});

test("a tracker source with no usable entries is refused rather than matching nothing", () => {
  assert.throws(() => parseTrackerSource(Buffer.from("# only comments\n\n")));
});

test("registrable comparison uses the reviewer's suffix list, including multi-label suffixes", () => {
  assert.equal(registrableDomain("metrics.shop.co.uk", SUFFIXES), "shop.co.uk");
  assert.equal(registrableDomain("a.b.example.com", SUFFIXES), "example.com");
});

test("a case whose candidate could not be resolved is undetermined, never absent", async () => {
  const worksheet = await buildCaseWorksheet(
    { caseId: "c1", url: "https://example.com/", hosts: ["metrics.example.com"] },
    {
      resolverAddress: "9.9.9.9",
      trackerSuffixes: new Set(["omtrdc.net"]),
      publicSuffixes: SUFFIXES,
      resolve: async () => ({ chain: [], terminated: false, failureCode: "SERVFAIL" })
    }
  );
  // This is the whole point of the flag: "we could not look" must not be
  // recorded as "we looked and found nothing", which would become a silent
  // true negative in the study.
  assert.equal(worksheet.determined, false);
  assert.equal(worksheet.resolutions[0].resolutionFailureCode, "SERVFAIL");
});

test("a cloaked subdomain is proposed present, with the chain and a command to re-check it", async () => {
  const worksheet = await buildCaseWorksheet(
    { caseId: "c2", url: "https://example.com/", hosts: ["metrics.example.com"] },
    {
      resolverAddress: "9.9.9.9",
      trackerSuffixes: new Set(["omtrdc.net"]),
      publicSuffixes: SUFFIXES,
      resolve: async () => ({
        chain: ["example.tt.omtrdc.net"],
        terminated: true,
        failureCode: null
      })
    }
  );
  assert.equal(worksheet.proposedLabel, "present");
  assert.equal(worksheet.determined, true);
  assert.equal(worksheet.resolutions[0].matchedExternalSuffix, "omtrdc.net");
  assert.equal(
    worksheet.resolutions[0].verifyCommand,
    "dig +noall +answer @9.9.9.9 metrics.example.com CNAME"
  );
});

test("a CNAME that stays inside the site's own domain is not a cloak", async () => {
  const worksheet = await buildCaseWorksheet(
    { caseId: "c3", url: "https://example.com/", hosts: ["www.example.com"] },
    {
      resolverAddress: "9.9.9.9",
      trackerSuffixes: new Set(["omtrdc.net"]),
      publicSuffixes: SUFFIXES,
      resolve: async () => ({ chain: ["origin.example.com"], terminated: true, failureCode: null })
    }
  );
  assert.equal(worksheet.proposedLabel, "absent");
  assert.equal(worksheet.determined, true);
});

test("the reference instrument imports nothing this project uses to make the prediction", () => {
  // The independence claim in the module docblock is only worth as much as this
  // check. A future edit that reaches for lib/tracker-catalog "just to reuse
  // the matcher" would make the reference agree with the detector by
  // construction, and the study would report the agreement as accuracy.
  const source = readFileSync(path.join(here, "calibration-cname-reference-lib.mjs"), "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  // Only node builtins. Any repository import at all is the failure mode:
  // reusing "just the matcher" from lib/tracker-catalog would make the
  // reference agree with the detector by construction, and the study would
  // report that agreement as accuracy.
  assert.deepEqual(
    imports.filter((specifier) => !specifier.startsWith("node:")),
    [],
    `the reference must import only node builtins, found: ${imports.join(", ")}`
  );
});

test("filter-list syntax is refused, not silently coerced into a dead entry", () => {
  // A lenient parser turns `@@||adobe.com^` into the literal entry
  // "@@||adobe.com^", which matches no host. The vendor silently drops out of
  // the reference and every site using it becomes a detector false negative.
  for (const line of ["@@||adobe.com^", "||omtrdc.net^", "!comment", "*.omtrdc.net", "/ads/"]) {
    assert.throws(
      () => parseTrackerSource(Buffer.from(`omtrdc.net\n${line}\n`)),
      /not a plain domain suffix/,
      `${line} must be refused`
    );
  }
});

test("plain suffix lists with comments and blank lines still parse", () => {
  const { suffixes } = parseTrackerSource(
    Buffer.from("# vendors\n\nomtrdc.net\n.online-metrix.net.\nat-o.net  # inline\n")
  );
  assert.deepEqual([...suffixes].sort(), ["at-o.net", "omtrdc.net", "online-metrix.net"]);
});

test("the reference CLI refuses a tracker or suffix source that diverges from the frame's pins, by EXECUTION", () => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const root = mkdtempSync(path.join(tmpdir(), "cname-pin-"));
  const framePath = path.join(root, "frame-tasks.json");
  writeFileSync(
    framePath,
    `${JSON.stringify(
      {
        externalDefinitions: {
          trackerDefinition: { sha256: "a".repeat(64) },
          publicSuffixDefinition: { sha256: "b".repeat(64) }
        }
      },
      null,
      2
    )}\n`
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(moduleDir, "calibration-cname-reference.mjs"),
      "--study-id", "s-prevalence-pilot",
      "--cases", path.join(root, "cases.json"),
      "--har-dir", root,
      "--frame-tasks", framePath,
      "--tracker-source", path.join(root, "trackers.txt"),
      "--tracker-source-sha256", "c".repeat(64),
      "--public-suffix-source", path.join(root, "psl.dat"),
      "--public-suffix-sha256", "b".repeat(64),
      "--resolver", "9.9.9.9",
      "--out", path.join(root, "out.json")
    ],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /--tracker-source-sha256 c{64} does not equal the frame's pinned tracker definition/
  );
});
