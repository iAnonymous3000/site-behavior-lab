import assert from "node:assert/strict";
import { test } from "node:test";
import { corpusSiteDomainKey, corpusSiteKeyForRun } from "./corpus-site-domain";

test("public redaction labels never become distinct corpus sites", () => {
  assert.equal(corpusSiteDomainKey("{label}.mit.edu"), "mit.edu");
  assert.equal(corpusSiteDomainKey("{label}.{label}.Example.COM."), "example.com");
  assert.equal(corpusSiteDomainKey("WWW.Stanford.edu."), "stanford.edu");
  assert.equal(corpusSiteDomainKey("www.example.co.uk"), "example.co.uk");
  assert.equal(corpusSiteDomainKey("{label}.example.co.uk"), "example.co.uk");
  assert.equal(corpusSiteDomainKey("not/a/hostname"), "");
});

test("a visit asked for a generalized host belongs to no site; one that landed on one still does", () => {
  // The seed catalog curates plato.stanford.edu beside stanford.edu; the
  // publication generalizes the sub-property to `{label}.stanford.edu`. Keyed
  // by the observed host alone, that visit became stanford.edu's and, being
  // newer, represented it everywhere. The reader cannot tell which property
  // was visited, so the visit keys to nothing.
  const plato = { domain: "{label}.stanford.edu", conditions: { requestedUrl: "https://{label}.stanford.edu/" } };
  assert.equal(corpusSiteKeyForRun(plato), "");
  // A v2 run's `domain` is already the observed registrable domain, so the
  // marker is visible only on the requested URL, which is why it is read there.
  const platoV2 = { domain: "stanford.edu", conditions: { requestedUrl: "https://{label}.stanford.edu/" } };
  assert.equal(corpusSiteKeyForRun(platoV2), "");
  assert.equal(corpusSiteKeyForRun({ domain: "mit.edu", conditions: { requestedUrl: "https://{label}.mit.edu/{seg}" } }), "");

  // The flagship's own visit, and the flagship's visit that a redirect carried
  // onto a generalized host of the same site (www.clevelandclinic.org answers
  // from my.clevelandclinic.org), both belong to the site.
  assert.equal(
    corpusSiteKeyForRun({ domain: "www.stanford.edu", conditions: { requestedUrl: "https://www.stanford.edu/" } }),
    "stanford.edu"
  );
  assert.equal(
    corpusSiteKeyForRun({
      domain: "{label}.clevelandclinic.org",
      conditions: { requestedUrl: "https://www.clevelandclinic.org/" }
    }),
    "clevelandclinic.org"
  );
  assert.equal(
    corpusSiteKeyForRun({ domain: "{label}.europa.eu", conditions: { requestedUrl: "https://europa.eu/" } }),
    "europa.eu"
  );
  // A marker anywhere in the requested host, not only its first label.
  assert.equal(
    corpusSiteKeyForRun({ domain: "example.com", conditions: { requestedUrl: "https://shop.{label}.example.com/" } }),
    ""
  );
  // A host label that merely contains the word is a real label.
  assert.equal(
    corpusSiteKeyForRun({ domain: "labels.example.com", conditions: { requestedUrl: "https://labels.example.com/" } }),
    "example.com"
  );
  // Unparseable or unkeyable input stays unkeyed rather than attributed.
  assert.equal(corpusSiteKeyForRun({ domain: "not/a/hostname", conditions: { requestedUrl: "nonsense" } }), "");
});
