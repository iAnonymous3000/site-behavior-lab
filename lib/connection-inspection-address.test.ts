import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  INSPECTED_ADDRESS_MAX_CHARS,
  INSPECTION_DURABLE_REFUSAL,
  INSPECTION_V1_PRODUCER_REFUSAL,
  inspectedAddressFromRowUrl,
  isPublishedAddressShape,
  scanBodyNamesInspection
} from "./connection-inspection-address";
import { isInspectableAddress } from "./connection-inspection";
import allowlists from "./redaction-allowlists.json";
import { requestInspectionLink } from "./request-inspection-link";
import { resolveScanPrefillNavigation } from "./scan-prefill";

/**
 * Three checks read one address grammar: the scan form's prefill parser and
 * the row link (syntactic, lib/connection-inspection-address.ts), and the
 * scan gate (authoritative, isInspectableAddress). They must agree on every
 * address a report actually publishes.
 */

test("the grammar takes published addresses and refuses everything redaction never writes", () => {
  for (const accepted of [
    "https://pixel.example.net/{seg}",
    "http://cdn.example.net/",
    "https://{label}.{label}.example.com/{n}/api/{seg}",
    "https://www.googletagmanager.com/{seg}",
    "https://xn--bcher-kva.example/{seg}",
    "https://cdn.example.net/{seg}/{seg}/{seg}/{seg}/{seg}/{seg}"
  ]) {
    assert.equal(isPublishedAddressShape(accepted), true, accepted);
  }
  for (const refused of [
    "https://pixel.example.net/{seg}?id=",
    "https://pixel.example.net/{seg}#x",
    "https://pixel.example.net:443/{seg}",
    "https://alice:secret@pixel.example.net/{seg}",
    "https://Pixel.example.net/{seg}",
    "https://pixel.example.net/{seg}/",
    "https://pixel.example.net",
    "https://pixel.example.net/p.gif",
    "https://pixel.example.net/%7Bseg%7D",
    "https://localhost/{seg}",
    "https://203.0.113.9/{seg}",
    "https://[2001:db8::1]/{seg}",
    "javascript://pixel.example.net/{seg}",
    "https://pixel.example.net/{seg}/{seg}/{seg}/{seg}/{seg}/{seg}/{seg}",
    `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.example.net/{seg}`,
    " https://pixel.example.net/{seg}",
    "https://pixel.example.net/{seg}\n"
  ]) {
    assert.equal(isPublishedAddressShape(refused), false, JSON.stringify(refused));
  }
  assert.equal(isPublishedAddressShape(`https://cdn.example.net/${"a".repeat(INSPECTED_ADDRESS_MAX_CHARS)}`), false);
});

test("every reviewed literal fits the grammar's label and segment classes", () => {
  // A literal the grammar could not read would make every row naming it
  // offer no link, with nothing else failing.
  for (const label of allowlists.subdomainLabels.literals) {
    assert.equal(isPublishedAddressShape(`https://${label}.example.net/{seg}`), true, label);
  }
  for (const literal of allowlists.routeLiterals.literals) {
    assert.equal(isPublishedAddressShape(`https://cdn.example.net/${literal}`), true, literal);
  }
});

test("every committed third-party row's link is one the row minter, the form and the gate all accept", () => {
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const files = readdirSync(reportsDir).filter((name) => /^[0-9]{8}-[0-9a-f]{32}\.json$/.test(name));
  const context = { page: "https://www.example.com/", from: "20261022-0123456789abcdef0123456789abcdef", basePath: "/lab" };
  let rows = 0;
  let firstParty = 0;
  for (const file of files) {
    const report = JSON.parse(readFileSync(path.join(reportsDir, file), "utf8"));
    if (report.schemaVersion !== 2) continue;
    const runs = report.run ? [report.run] : [report.baseline, report.variant];
    for (const run of runs) {
      for (const request of run.evidence.requests as Array<{ url: string; thirdParty: boolean }>) {
        // The real minter the explorer renders.
        const link = requestInspectionLink(request, context);
        if (!request.thirdParty) {
          firstParty += 1;
          assert.equal(link, null, `${file}: a first-party row offers an inspection`);
          continue;
        }
        rows += 1;
        if (request.url === "{invalid-url}") {
          assert.equal(link, null, `${file}: a row redaction could not publish offers an inspection`);
          continue;
        }
        assert.ok(link, `${file}: ${request.url} offers no inspection`);
        assert.equal(link.address, inspectedAddressFromRowUrl(request.url));
        assert.equal(request.url.startsWith(link.address), true);
        // The real form parser reads the link back to the same page and address.
        assert.ok(link.href.startsWith(`${context.basePath}/#scan?`));
        const navigation = resolveScanPrefillNavigation(`https://sitebehavior.org${link.href.slice(context.basePath.length)}`);
        assert.deepEqual(
          [navigation?.targetUrl, navigation?.mode, navigation?.inspect, navigation?.from],
          [context.page, null, link.address, context.from],
          `${file}: the form reads ${link.href} as another inspection`
        );
        // And the gate's authoritative check accepts it.
        assert.equal(isInspectableAddress(link.address), true, `${file}: the gate refuses ${link.address}`);
      }
    }
  }
  assert.ok(rows > 1_000, `only ${rows} committed third-party rows; this walk would be vacuous`);
  assert.ok(firstParty > 100, `only ${firstParty} committed first-party rows; this walk would be vacuous`);
});

// The two dash characters no copy may hold, built from their code points.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

test("each refusal is one sentence of at most 30 words with no dash", () => {
  for (const sentence of [INSPECTION_DURABLE_REFUSAL, INSPECTION_V1_PRODUCER_REFUSAL]) {
    assert.ok(sentence.split(/\s+/).length <= 30, sentence);
    assert.equal(sentence.match(/[.!?](\s|$)/g)?.length, 1, sentence);
    assert.equal(DASHES.test(sentence), false, sentence);
  }
  assert.notEqual(INSPECTION_DURABLE_REFUSAL, INSPECTION_V1_PRODUCER_REFUSAL);
});

test("the durable edge's check finds an inspection key in any scan body that has one", () => {
  assert.equal(scanBodyNamesInspection(JSON.stringify({ url: "https://www.example.com/", inspect: "https://pixel.example.net/{seg}" })), true);
  // Any value names one: the edge refuses the key, the gate judges values.
  assert.equal(scanBodyNamesInspection(JSON.stringify({ url: "https://www.example.com/", inspect: null })), true);
  assert.equal(scanBodyNamesInspection(JSON.stringify({ url: "https://www.example.com/" })), false);
  assert.equal(scanBodyNamesInspection(JSON.stringify({ url: "https://www.example.com/", nested: { inspect: "x" } })), false);
  assert.equal(scanBodyNamesInspection(JSON.stringify([{ inspect: "x" }])), false);
  assert.equal(scanBodyNamesInspection("{"), false);
  assert.equal(scanBodyNamesInspection("null"), false);
});

test("a row link names no address for a row redaction could not publish", () => {
  assert.equal(inspectedAddressFromRowUrl("{invalid-url}"), null);
  assert.equal(inspectedAddressFromRowUrl("https://cdn.example.net/{seg}?%5Bredacted%5D=&id="), "https://cdn.example.net/{seg}");
  assert.equal(inspectedAddressFromRowUrl("https://cdn.example.net/"), "https://cdn.example.net/");
});
