import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  INSPECTED_ADDRESS_MAX_CHARS,
  inspectedAddressFromRowUrl,
  isPublishedAddressShape
} from "./connection-inspection-address";
import { isInspectableAddress } from "./connection-inspection";
import allowlists from "./redaction-allowlists.json";

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

test("every committed third-party row's address is one the grammar and the gate both accept", () => {
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const files = readdirSync(reportsDir).filter((name) => /^[0-9]{8}-[0-9a-f]{32}\.json$/.test(name));
  let rows = 0;
  for (const file of files) {
    const report = JSON.parse(readFileSync(path.join(reportsDir, file), "utf8"));
    if (report.schemaVersion !== 2) continue;
    const runs = report.run ? [report.run] : [report.baseline, report.variant];
    for (const run of runs) {
      for (const request of run.evidence.requests as Array<{ url: string; thirdParty: boolean }>) {
        if (!request.thirdParty) continue;
        rows += 1;
        const address = inspectedAddressFromRowUrl(request.url);
        if (request.url === "{invalid-url}") {
          assert.equal(address, null);
          continue;
        }
        assert.ok(address, `${file}: ${request.url} names no address`);
        assert.equal(request.url.startsWith(address), true);
        assert.equal(isInspectableAddress(address), true, `${file}: the gate refuses ${address}`);
      }
    }
  }
  assert.ok(rows > 1_000, `only ${rows} committed third-party rows; this walk would be vacuous`);
});

test("a row link names no address for a row redaction could not publish", () => {
  assert.equal(inspectedAddressFromRowUrl("{invalid-url}"), null);
  assert.equal(inspectedAddressFromRowUrl("https://cdn.example.net/{seg}?%5Bredacted%5D=&id="), "https://cdn.example.net/{seg}");
  assert.equal(inspectedAddressFromRowUrl("https://cdn.example.net/"), "https://cdn.example.net/");
});
