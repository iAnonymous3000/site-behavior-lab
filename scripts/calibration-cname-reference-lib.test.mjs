import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildCaseWorksheet,
  firstPartyHostsFromHar,
  harCoversSubject,
  matchExternalTracker,
  parsePublicSuffixList,
  parseTrackerSource,
  registrableDomain,
  sha256Hex
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
    { caseId: "c1", url: "https://example.com/", hosts: ["metrics.example.com"], captureSha256: "a".repeat(64), subjectLoaded: true },
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
    { caseId: "c2", url: "https://example.com/", hosts: ["metrics.example.com"], captureSha256: "a".repeat(64), subjectLoaded: true },
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
    { caseId: "c3", url: "https://example.com/", hosts: ["www.example.com"], captureSha256: "a".repeat(64), subjectLoaded: true },
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

test("parseTrackerSource records domain-shaped artifacts, refuses filter syntax, and caps the noise", async () => {
  const { parseTrackerSource } = await import("./calibration-cname-reference-lib.mjs");
  // Provider datasets carry DNS-name artifacts that are not LDH hostnames:
  // recorded and skipped, never repaired, never silently dropped.
  const parsed = parseTrackerSource(
    "# comment\ntracker.example\n-access-logs.net.daraz.example\nunder_score.example\nsecond.example\n"
  );
  assert.deepEqual([...parsed.suffixes], ["tracker.example", "second.example"]);
  assert.deepEqual(
    parsed.rejectedRows.map((row) => row.line),
    [3, 4]
  );
  // Filter-list syntax still refuses the whole file: those bytes are not
  // the claimed kind of list, and lenient reduction is dangerous.
  assert.throws(() => parseTrackerSource("||adblock.example^\n"), /is not a plain domain suffix/);
  assert.throws(() => parseTrackerSource("@@||exception.example^\n"), /is not a plain domain suffix/);
  // More than 100 domain-shaped rejections refuses the file outright.
  const noisy =
    Array.from({ length: 101 }, (_, index) => `-bad-${index}.example`).join("\n") +
    "\nreal.example\n";
  assert.throws(() => parseTrackerSource(noisy), /rejected 101 domain-shaped rows/);
});

test("a worksheet case carries the subject it examined and the reviewer's capture digest", async () => {
  const { buildCaseWorksheet } = await import("./calibration-cname-reference-lib.mjs");
  // The subject is recorded so a downstream producer can refuse a worksheet
  // built against a different page than the frame assigned; the capture digest
  // is part of the case, not something a caller staples on afterwards.
  const worksheet = await buildCaseWorksheet(
    {
      caseId: "case-1",
      url: "https://news.example/article",
      hosts: [],
      captureSha256: "b".repeat(64),
      subjectLoaded: true
    },
    {
      resolverAddress: "9.9.9.9",
      trackerSuffixes: new Set(["tracker.example"]),
      publicSuffixes: new Set(["example"]),
      maxHops: 10,
      timeoutMs: 100
    }
  );
  assert.equal(worksheet.subjectUrl, "https://news.example/article");
  assert.equal(worksheet.captureSha256, "b".repeat(64));
  assert.equal(worksheet.determined, true);
  assert.equal(worksheet.proposedLabel, "absent");
  await assert.rejects(
    () =>
      buildCaseWorksheet(
        { caseId: "case-2", url: "https://news.example/", hosts: [], subjectLoaded: true },
        {
          resolverAddress: "9.9.9.9",
          trackerSuffixes: new Set(),
          publicSuffixes: new Set(["example"]),
          maxHops: 10,
          timeoutMs: 100
        }
      ),
    /needs the reviewer capture sha256/
  );
});

test("the candidate set has ONE reader, shared with the sweep, and it refuses the shapes that used to diverge", async () => {
  const { parseCandidateSet } = await import("./calibration-candidate-set-lib.mjs");
  const { parseCandidateSet: viaSweep } = await import("./calibration-reliability-sweep-run-lib.mjs");
  const good = `${JSON.stringify(
    { studyId: "s-prevalence-pilot", candidates: [{ caseId: "a.example", url: "https://a.example/" }] },
    null,
    2
  )}\n`;
  assert.deepEqual(parseCandidateSet(good).candidates, [{ caseId: "a.example", url: "https://a.example/" }]);
  // The sweep's reader and the frame/reference reader are the same function,
  // not two graders of one file.
  assert.equal(viaSweep, parseCandidateSet);
  // The bare array the reference instrument used to require is refused.
  assert.throws(
    () => parseCandidateSet('[{"caseId":"a.example","url":"https://a.example/"}]'),
    /candidate set must be an object/
  );
  const dup = `${JSON.stringify(
    {
      studyId: "s-prevalence-pilot",
      candidates: [
        { caseId: "a.example", url: "https://a.example/" },
        { caseId: "a.example", url: "https://a.example/2" }
      ]
    },
    null,
    2
  )}\n`;
  assert.throws(() => parseCandidateSet(dup), /duplicate caseId/);
  assert.throws(() => parseCandidateSet(good.replace("https://", "http://")), /must be https/);
  // The COMMITTED pilot set parses under that one reader, and its digest is
  // the digest the runbook and the universe provenance both name.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const committed = readFileSync(
    path.join(repoRoot, "calibration", "cname-uncloaking-2026-08-prevalence-pilot", "pilot-set.json"),
    "utf8"
  );
  const parsed = parseCandidateSet(committed);
  assert.equal(parsed.candidates.length, 100);
  assert.equal(parsed.studyId, "cname-uncloaking-2026-08-prevalence-pilot");
  assert.equal(
    parsed.candidateSetDigest,
    JSON.parse(
      readFileSync(
        path.join(repoRoot, "calibration", "cname-uncloaking-2026-08-prevalence-pilot", "universe-provenance.json"),
        "utf8"
      )
    ).pilotSetSha256
  );
});

test("a capture that never LOADED the subject is refused, not read as a confident absent", async () => {
  const { harCoversSubject } = await import("./calibration-cname-reference-lib.mjs");
  const suffixes = new Set(["example"]);
  const har = (entries) => ({ log: { entries } });
  const req = (url, status) => ({ request: { url }, response: { status } });
  const covers = (entries) => harCoversSubject(har(entries), "https://news.example/", suffixes);

  // A capture that actually loaded the subject, including one where the
  // document is served from a subdomain or reached through an in-domain
  // redirect.
  assert.equal(covers([req("https://news.example/", 200)]), true);
  assert.equal(covers([req("https://www.news.example/", 200)]), true);
  assert.equal(covers([req("https://news.example/", 301), req("https://www.news.example/", 200)]), true);

  // The three capture defects that otherwise yield an EMPTY candidate list
  // and therefore a determined ABSENT from evidence of nothing. The first is
  // the one this guard is named for and the one an earlier version missed:
  // the fixture omitted the initial hop, so it asserted a HAR shape that
  // never occurs. A real off-domain redirect leaves its own request in the
  // HAR, which is why presence is not the question and success is.
  assert.equal(covers([req("https://news.example/", 301), req("https://elsewhere.example/", 200)]), false);
  assert.equal(covers([req("https://news.example/", 0)]), false);
  assert.equal(covers([req("https://elsewhere.example/", 200)]), false);
  assert.equal(covers([]), false);

  // A HAR entry with no response object at all is not evidence of a load.
  assert.equal(harCoversSubject(har([{ request: { url: "https://news.example/" } }]), "https://news.example/", suffixes), false);
});

test("a subject that never answered on its own domain is UNCERTAIN, and does not abort the run", async () => {
  const { buildCaseWorksheet } = await import("./calibration-cname-reference-lib.mjs");
  const options = {
    resolverAddress: "9.9.9.9",
    trackerSuffixes: new Set(["tracker.example"]),
    publicSuffixes: new Set(["example"]),
    maxHops: 10,
    timeoutMs: 100
  };
  // philly.com serves www.inquirer.com and cbslocal.com serves
  // www.cbsnews.com; both are in this study's committed pilot set. An earlier
  // version refused the whole run on such a case, which produced no worksheet
  // at all for a hundred cases because of a handful, and no partial worksheet
  // can be sealed.
  const moved = await buildCaseWorksheet(
    {
      caseId: "moved.example",
      url: "https://moved.example/",
      hosts: [],
      captureSha256: "c".repeat(64),
      subjectLoaded: false
    },
    options
  );
  assert.equal(moved.subjectLoaded, false);
  assert.equal(moved.determined, false);
  // The emptiest possible evidence must not read as determined: "every" over
  // an empty resolutions array is true.
  assert.deepEqual(moved.resolutions, []);
  // Omitting coverage refuses rather than defaulting: a default of true would
  // state that a capture reached its subject on behalf of a caller that
  // supplied no evidence either way, and the consumer's boolean shape check
  // cannot tell a defaulted claim from a measured one.
  await assert.rejects(
    () =>
      buildCaseWorksheet(
        { caseId: "silent.example", url: "https://silent.example/", hosts: [], captureSha256: "e".repeat(64) },
        options
      ),
    /needs whether the capture reached the subject/
  );

  const clean = await buildCaseWorksheet(
    {
      caseId: "clean.example",
      url: "https://clean.example/",
      hosts: [],
      captureSha256: "d".repeat(64),
      subjectLoaded: true
    },
    options
  );
  assert.equal(clean.subjectLoaded, true);
  assert.equal(clean.determined, true);
  assert.equal(clean.proposedLabel, "absent");
});

// An excerpt in the Public Suffix List's own rule syntax. Every test below reads
// it through parsePublicSuffixList, never through a hand-built Set, so the
// matcher cannot agree with its fixture by construction: the reader and the
// matcher were two halves of one contract that each passed their own tests
// while wildcard and exception rules were lost between them.
const PSL_EXCERPT = [
  "// excerpt",
  "com",
  "uk",
  "co.uk",
  "*.sch.uk",
  "jp",
  "kobe.jp",
  "*.kobe.jp",
  "!city.kobe.jp",
  "*.kawasaki.jp",
  "!city.kawasaki.jp",
  "ck",
  "*.ck",
  "!www.ck",
  "cn",
  "公司.cn",
  ""
].join("\n");

test("the public-suffix reader keeps wildcard, exception and IDN rules and registrableDomain applies them", () => {
  const rules = parsePublicSuffixList(Buffer.from(PSL_EXCERPT));
  assert.ok(rules.has("*.ck"));
  assert.ok(rules.has("!www.ck"));
  assert.ok(rules.has("xn--55qx5d.cn"));
  // Each expected value is the PSL algorithm's answer, and matches tldts
  // getDomain(host, { allowPrivateDomains: true }) ?? host over the same rules.
  const expected = {
    // A wildcard makes the suffix one label deeper.
    "b.test.ck": "b.test.ck",
    "a.b.test.ck": "b.test.ck",
    "b.c.kobe.jp": "b.c.kobe.jp",
    "a.b.c.kobe.jp": "b.c.kobe.jp",
    "www.foo.kawasaki.jp": "www.foo.kawasaki.jp",
    "www.stjohns.herts.sch.uk": "stjohns.herts.sch.uk",
    // An exception prevails over the wildcard. Reducing `*.ck` to `ck` used to
    // land on these by accident, so a wildcard-only fix would break them.
    "www.ck": "www.ck",
    "www.www.ck": "www.ck",
    "foo.www.ck": "www.ck",
    "www.city.kobe.jp": "city.kobe.jp",
    "www.city.kawasaki.jp": "city.kawasaki.jp",
    // Hostnames and DNS answers are ASCII, so a Unicode rule must be too.
    "www.shishi.xn--55qx5d.cn": "shishi.xn--55qx5d.cn",
    "www.example.xn--55qx5d.cn": "example.xn--55qx5d.cn",
    // A host that is itself a public suffix keys on itself.
    "test.ck": "test.ck",
    "herts.sch.uk": "herts.sch.uk",
    // Plain rules are unchanged.
    "metrics.shop.co.uk": "shop.co.uk",
    "a.b.example.com": "example.com"
  };
  for (const [host, registrable] of Object.entries(expected)) {
    assert.equal(registrableDomain(host, rules), registrable, host);
  }
});

test("the public-suffix reader refuses what is not a rule", () => {
  assert.throws(() => parsePublicSuffixList(Buffer.from("com\na.*.b\n")), /line 2 is not a public-suffix rule/);
  assert.throws(() => parsePublicSuffixList(Buffer.from("// only a comment\n")), /contains no entries/);
});

test("candidate scope under a wildcard suffix stops at the registrant", () => {
  const hosts = firstPartyHostsFromHar(
    har([
      "https://www.stjohns.herts.sch.uk/",
      "https://metrics.stjohns.herts.sch.uk/b",
      "https://cdn.otherschool.herts.sch.uk/a.js",
      "https://www.otherschool.herts.sch.uk/"
    ]),
    "https://www.stjohns.herts.sch.uk/",
    parsePublicSuffixList(Buffer.from(PSL_EXCERPT))
  );
  // Another school's hosts are another registrant's; the detector never looks
  // at them, so neither may the reference.
  assert.deepEqual(hosts, ["metrics.stjohns.herts.sch.uk", "www.stjohns.herts.sch.uk"]);
});

test("a redirect to another registrant under a wildcard suffix does not cover the subject", () => {
  const capture = {
    log: {
      entries: [
        { request: { url: "https://www.stjohns.herts.sch.uk/" }, response: { status: 301 } },
        { request: { url: "https://www.otherschool.herts.sch.uk/" }, response: { status: 200 } }
      ]
    }
  };
  assert.equal(
    harCoversSubject(capture, "https://www.stjohns.herts.sch.uk/", parsePublicSuffixList(Buffer.from(PSL_EXCERPT))),
    false
  );
});

test("a chain into another registrant under a wildcard suffix is not skipped as same-site", async () => {
  // The detector keys on stjohns.herts.sch.uk, sees adtrack.herts.sch.uk as a
  // different party, and says PRESENT. A reference that folded both into
  // herts.sch.uk skipped the link as same-site and scored that correct
  // PRESENT as a false positive.
  const worksheet = await buildCaseWorksheet(
    {
      caseId: "stjohns",
      url: "https://www.stjohns.herts.sch.uk/",
      hosts: ["metrics.stjohns.herts.sch.uk"],
      captureSha256: "a".repeat(64),
      subjectLoaded: true
    },
    {
      resolverAddress: "9.9.9.9",
      trackerSuffixes: new Set(["adtrack.herts.sch.uk"]),
      publicSuffixes: parsePublicSuffixList(Buffer.from(PSL_EXCERPT)),
      resolve: async () => ({ chain: ["client1.adtrack.herts.sch.uk"], terminated: true, failureCode: null })
    }
  );
  assert.equal(worksheet.proposedLabel, "present");
  assert.equal(worksheet.resolutions[0].matchedExternalSuffix, "adtrack.herts.sch.uk");
  assert.equal(worksheet.resolutions[0].matchedChainLink, "client1.adtrack.herts.sch.uk");
});

function runReferenceCli(root, pslBytes, candidates, captures) {
  const trackerBytes = Buffer.from("adtrack.example\n");
  writeFileSync(path.join(root, "trackers.txt"), trackerBytes);
  writeFileSync(path.join(root, "psl.dat"), pslBytes);
  writeFileSync(
    path.join(root, "frame-tasks.json"),
    `${JSON.stringify(
      {
        externalDefinitions: {
          trackerDefinition: { sha256: sha256Hex(trackerBytes) },
          publicSuffixDefinition: { sha256: sha256Hex(pslBytes) }
        }
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    path.join(root, "cases.json"),
    `${JSON.stringify({ studyId: "s-prevalence-pilot", candidates }, null, 2)}\n`
  );
  // The capture directory may hold nothing but HARs.
  const harDir = path.join(root, "har");
  mkdirSync(harDir);
  for (const [caseId, capture] of Object.entries(captures)) {
    writeFileSync(path.join(harDir, `${caseId}.har`), `${JSON.stringify(capture)}\n`);
  }
  return spawnSync(
    process.execPath,
    [
      path.join(here, "calibration-cname-reference.mjs"),
      "--study-id", "s-prevalence-pilot",
      "--cases", path.join(root, "cases.json"),
      "--har-dir", harDir,
      "--frame-tasks", path.join(root, "frame-tasks.json"),
      "--tracker-source", path.join(root, "trackers.txt"),
      "--tracker-source-sha256", sha256Hex(trackerBytes),
      "--public-suffix-source", path.join(root, "psl.dat"),
      "--public-suffix-sha256", sha256Hex(pslBytes),
      // Loopback, so a run that does resolve fails locally and fast.
      "--resolver", "127.0.0.1",
      "--out", path.join(root, "out.json")
    ],
    { encoding: "utf8" }
  );
}

test("the reference CLI reads the suffix source through the rule-aware reader, by EXECUTION", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cname-psl-"));
  const result = runReferenceCli(
    root,
    Buffer.from(PSL_EXCERPT),
    [{ caseId: "stjohns.herts.sch.uk", url: "https://stjohns.herts.sch.uk/" }],
    {
      "stjohns.herts.sch.uk": {
        log: {
          entries: [
            { request: { url: "https://stjohns.herts.sch.uk/" }, response: { status: 200 } },
            { request: { url: "https://cdn.otherschool.herts.sch.uk/a.js" }, response: { status: 200 } }
          ]
        }
      }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const worksheet = JSON.parse(readFileSync(path.join(root, "out.json"), "utf8"));
  // Under *.sch.uk the subject is its own registrable apex and the other
  // school is another registrant, so nothing is a candidate and no DNS runs.
  assert.deepEqual(worksheet.cases[0].hostsExamined, []);
  assert.equal(worksheet.cases[0].determined, true);
  assert.equal(worksheet.cases[0].proposedLabel, "absent");
});

test("the reference CLI refuses a suffix source that is not rules, by name and before any DNS", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cname-psl-bad-"));
  const result = runReferenceCli(
    root,
    Buffer.from("com\na.*.b\n"),
    [{ caseId: "a.example", url: "https://a.example/" }],
    { "a.example": { log: { entries: [] } } }
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^calibration:cname-reference: public suffix source line 2 is not a public-suffix rule: "a\.\*\.b"$/m
  );
});
