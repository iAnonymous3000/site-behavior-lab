import { DETECTOR_IDS, type DetectorId } from "./scan-report-v2";
import { DETECTOR_REGISTRY_VERSION, DETECTOR_VERSIONS } from "./measurement-kernel";
import { sha256Hex } from "./sha256";

export type ValidationFixtureKind = "positive" | "negative" | "adversarial";
export type ValidationFixtureEnvironment = "unit" | "real-chromium";

export type DetectorValidationFixture = {
  detector: DetectorId;
  kind: ValidationFixtureKind;
  environment: ValidationFixtureEnvironment;
  file: string;
  testName: string;
  verifies: string;
};

export type DetectorValidationRow = {
  detector: DetectorId;
  label: string;
  version: string;
  positiveCases: number;
  negativeCases: number;
  adversarialCases: number;
  realChromiumCases: number;
  limitations: string;
  fixtures: DetectorValidationFixture[];
};

const DETECTOR_PUBLIC_COPY: Readonly<Record<DetectorId, { label: string; limitations: string }>> = {
  "fingerprint-heuristics": {
    label: "Fingerprint and behavior heuristics",
    limitations:
      "These cases exercise selected APIs, attribution paths, and hostile-page behavior. A matching pattern can have a legitimate use, and uninstrumented browser surfaces remain outside coverage."
  },
  "keystroke-exfiltration": {
    label: "Synthetic input sentinel",
    limitations:
      "Coverage is bounded to visible fields the scan probes, captured HTTP requests, and the documented plain, encoded, and hashed sentinel forms. It does not cover arbitrary encryption or uncaptured transports."
  },
  "cname-uncloaking": {
    label: "CNAME uncloaking",
    limitations:
      "Classification depends on the DNS chain observed during the visit and the curated service catalog. A CNAME match is a routing observation, not proof of a request's purpose."
  },
  "pixel-events": {
    label: "Advertising pixel events",
    limitations:
      "Decoding covers reviewed request formats for Meta, TikTok, and X. Unknown products, changed payload formats, and custom event meaning are not inferred."
  },
  "consent-banner": {
    label: "Consent banner and controls",
    limitations:
      "Cases cover known CMP selectors and conservative first-layer labels. Finding or clicking a control does not establish legal validity or prove that every request honored the choice."
  },
  "privacy-policy": {
    label: "Privacy-policy cross-check",
    limitations:
      "The detector checks narrow, testable phrases in an eligible policy page. It does not interpret a complete policy, determine compliance, or infer the meaning of ambiguous legal language."
  }
};

/**
 * Source-pinned acceptance cases selected from the existing test suite. This
 * is an inventory of reviewed fixtures, not a representative labeled corpus.
 * Exact test names are checked in detector-validation.test.ts so a rename or
 * deletion cannot silently leave the public matrix stale.
 */
export const DETECTOR_VALIDATION_FIXTURES: readonly DetectorValidationFixture[] = [
  {
    detector: "fingerprint-heuristics",
    kind: "positive",
    environment: "unit",
    file: "lib/fingerprint-observer.test.ts",
    testName: "fingerprintObserverInitScript flags the canvas heuristic after text write and readback",
    verifies: "A qualifying canvas write-and-read pattern produces a review finding."
  },
  {
    detector: "fingerprint-heuristics",
    kind: "negative",
    environment: "unit",
    file: "lib/fingerprint-observer.test.ts",
    testName: "fingerprintObserverInitScript does not flag benign first-party form listeners",
    verifies: "First-party form listeners are not mislabeled as third-party input monitoring."
  },
  {
    detector: "fingerprint-heuristics",
    kind: "adversarial",
    environment: "real-chromium",
    file: "lib/fingerprint-observer.test.ts",
    testName: "first-party addEventListener wrappers do not hide a deferred third-party registrant",
    verifies:
      "A synchronous first-party wrapper whose call chain fits the bounded stack capture neither censors the frame nor hides the deferred third-party registrant it delegates for."
  },
  {
    detector: "fingerprint-heuristics",
    kind: "adversarial",
    environment: "real-chromium",
    file: "lib/fingerprint-observer.test.ts",
    testName: "a wrapper chain deeper than the stack bound records coverage loss instead of a clean read",
    verifies:
      "A wrapper chain that saturates even the deeper 512-frame stack capture keeps the frame readable and counts it as listener-attribution loss instead of a clean, complete read."
  },
  {
    detector: "fingerprint-heuristics",
    kind: "positive",
    environment: "real-chromium",
    file: "lib/fingerprint-observer.test.ts",
    testName:
      "React 19's commit recursion past 64 frames reads as the frame's own registration and keeps its listener findings",
    verifies:
      "A page whose own React-shaped commit traversal registers a listener 64 or 82 frames below its scheduler task reads as a first-party registration instead of bounded coverage, and a third-party session recorder beside it publishes its finding."
  },
  {
    detector: "fingerprint-heuristics",
    kind: "adversarial",
    environment: "real-chromium",
    file: "lib/fingerprint-observer.test.ts",
    testName:
      "a widget's headline layout keeps a frame's canvas and audio fingerprinting and withholds only the canvas-font summary in real Chromium",
    verifies:
      "A recommendation widget that measures hundreds of distinct one- and two-character strings to fit its headlines, beside a real canvas readback and an offline audio render, keeps the frame readable: the canvas and audio findings publish, and the canvas-font summary is withheld as bounded coverage instead of published from layout calls or nulling the frame."
  },
  {
    detector: "fingerprint-heuristics",
    kind: "positive",
    environment: "real-chromium",
    file: "lib/fingerprint-observer.test.ts",
    testName: "two third-party origins in one registration chain attribute the chain instead of censoring the frame",
    verifies:
      "A deferred registration whose bounded call chain contains two distinct third-party origins keeps the frame readable and records a detection naming both chain origins."
  },
  {
    detector: "fingerprint-heuristics",
    kind: "positive",
    environment: "real-chromium",
    file: "lib/fingerprint-observer.test.ts",
    testName: "fingerprintObserverInitScript flags canvas readback on an OffscreenCanvas 2D context in real Chromium",
    verifies:
      "Text drawn on an OffscreenCanvas and read back through getImageData or exported through convertToBlob produces the same canvas finding a page canvas does, with the export named as convertToBlob."
  },
  {
    detector: "fingerprint-heuristics",
    kind: "adversarial",
    environment: "real-chromium",
    file: "lib/worker-fingerprint-realm.test.ts",
    testName:
      "real Chromium: a worker that ends before it can vouch for its owner read is no loss when it recorded nothing, and unread when it fingerprinted",
    verifies:
      "Two dedicated workers that end themselves while the owner read's frame tree is held, so neither can vouch for its document: the one that recorded nothing costs nothing, and the one that drew and read a canvas is one unread realm whose evidence is never credited."
  },
  {
    detector: "keystroke-exfiltration",
    kind: "positive",
    environment: "unit",
    file: "lib/keystroke-exfiltration.test.ts",
    testName: "findSentinelLeaks detects the plain value in a third-party request URL",
    verifies: "A synthetic value sent to a third party is identified without retaining the value."
  },
  {
    detector: "keystroke-exfiltration",
    kind: "negative",
    environment: "unit",
    file: "lib/keystroke-exfiltration.test.ts",
    testName: "findSentinelLeaks ignores requests that do not contain the sentinel",
    verifies: "Unrelated first- and third-party requests do not produce a sentinel match."
  },
  {
    detector: "keystroke-exfiltration",
    kind: "adversarial",
    environment: "unit",
    file: "lib/keystroke-exfiltration.test.ts",
    testName: "findSentinelLeaks bounds the per-field search so a padded body cannot exhaust it",
    verifies: "Oversized padding cannot force unbounded scanning or smuggle evidence past the declared cap."
  },
  {
    detector: "cname-uncloaking",
    kind: "positive",
    environment: "unit",
    file: "lib/cname-uncloaking.test.ts",
    testName: "classifyCnameCloak flags a first-party subdomain CNAME'd to a tracking vendor",
    verifies: "A first-party alias resolving to a curated service is reported with its DNS chain."
  },
  {
    detector: "cname-uncloaking",
    kind: "negative",
    environment: "unit",
    file: "lib/cname-uncloaking.test.ts",
    testName: "classifyCnameCloak ignores a CNAME to a non-tracker CDN",
    verifies: "A non-catalog CDN alias does not become a tracker label."
  },
  {
    detector: "cname-uncloaking",
    kind: "adversarial",
    environment: "unit",
    file: "lib/cname-uncloaking.test.ts",
    testName: "resolveCnameCloaks skips a host whose DNS resolution throws",
    verifies: "A failed DNS lookup stays an explicit absence of evidence rather than a fabricated match."
  },
  {
    detector: "pixel-events",
    kind: "positive",
    environment: "unit",
    file: "lib/pixel-events.test.ts",
    testName: "Meta: a plain /tr GET yields the event name and no advanced matching",
    verifies: "A reviewed Meta Pixel request shape yields its standard event label."
  },
  {
    detector: "pixel-events",
    kind: "negative",
    environment: "unit",
    file: "lib/pixel-events.test.ts",
    testName: "a non-pixel request decodes to null",
    verifies: "Unrelated and share-link requests do not become advertising pixel events."
  },
  {
    detector: "pixel-events",
    kind: "adversarial",
    environment: "unit",
    file: "lib/pixel-events.test.ts",
    testName: "decodePixelRequest ignores an over-large POST body but still reads the URL",
    verifies: "Oversized bodies are skipped while bounded URL evidence remains available."
  },
  {
    detector: "consent-banner",
    kind: "positive",
    environment: "unit",
    file: "lib/consent-banner.test.ts",
    testName: "detectConsentPlatform names a CMP from its loader host (suffix + exact)",
    verifies: "Reviewed CMP loader domains produce a platform label."
  },
  {
    detector: "consent-banner",
    kind: "negative",
    environment: "unit",
    file: "lib/consent-interaction.test.ts",
    testName: "whole-label matching rejects partial and page-authored phrases",
    verifies: "Ambiguous or page-authored text is not treated as a consent decision."
  },
  {
    detector: "consent-banner",
    kind: "adversarial",
    environment: "real-chromium",
    file: "lib/consent-interaction.test.ts",
    testName: "browser probes retain trusted DOM brands and methods after hostile intrinsic poisoning",
    verifies: "Consent probes preserve bounded behavior under hostile page prototype changes in Chromium."
  },
  {
    detector: "privacy-policy",
    kind: "positive",
    environment: "real-chromium",
    file: "lib/scanner.test.ts",
    testName: "a direct PDF privacy policy completes through the bounded scan proxy",
    verifies: "A direct PDF policy is fetched through the SSRF proxy and produces a complete cross-check."
  },
  {
    detector: "privacy-policy",
    kind: "negative",
    environment: "unit",
    file: "lib/privacy-policy.test.ts",
    testName: "extractPolicyClaims does not turn qualified real-policy wording into blanket combined claims",
    verifies: "Population, knowledge, monetary, temporal, and contradictory qualifiers are not promoted to blanket claims."
  },
  {
    detector: "privacy-policy",
    kind: "adversarial",
    environment: "unit",
    file: "lib/privacy-policy.test.ts",
    testName: "pickPrivacyPolicyLink accepts a known policy-hosting service but not arbitrary off-site policies",
    verifies: "An unrelated company's policy cannot be attributed to the scanned site."
  },
  {
    detector: "privacy-policy",
    kind: "positive",
    environment: "real-chromium",
    file: "lib/scanner-policy-navigation.test.ts",
    testName: "a policy that renders its text after the render delay is read in full",
    verifies: "A policy page that fetches its text after load, as a CMP-hosted notice does, is read once its network goes quiet, and the company it names counts as named."
  },
  {
    detector: "privacy-policy",
    kind: "negative",
    environment: "real-chromium",
    file: "lib/scanner-policy-navigation.test.ts",
    testName: "a policy still fetching its text when the settle wait ends is never read as the policy",
    verifies: "A short page shell read while its policy request is still open publishes no policy and no company the policy does not name."
  },
  {
    detector: "privacy-policy",
    kind: "positive",
    environment: "real-chromium",
    file: "lib/scanner-policy-navigation.test.ts",
    testName: "a short page that names itself a policy is read even when it links to another policy document",
    verifies: "A short policy that calls itself one is read, and the company it names counts as named, though it links to a state notice."
  },
  {
    detector: "privacy-policy",
    kind: "negative",
    environment: "real-chromium",
    file: "lib/scanner-policy-navigation.test.ts",
    testName: "a privacy hub that keeps its policy on another page is never read as the policy",
    verifies: "A privacy landing page that calls itself no policy, carries no prose and links to the policy elsewhere publishes no policy and no company the policy does not name."
  },
  {
    detector: "privacy-policy",
    kind: "negative",
    environment: "real-chromium",
    file: "lib/scanner-policy-navigation.test.ts",
    testName: "a privacy hub that keeps its prose in closed panels is never read as the policy",
    verifies: "A privacy center whose prose sits in tabs it has not selected and a consent preference center it has not opened, and which links to the policy elsewhere, publishes no policy and no company the policy does not name."
  },
  {
    detector: "privacy-policy",
    kind: "positive",
    environment: "real-chromium",
    file: "lib/scanner-policy-navigation.test.ts",
    testName: "a policy titled with only the site's name is read with its collapsed sections, though it links to another policy document",
    verifies: "A policy titled with only the site's name that links to a state notice and folds most of its prose into collapsed sections, beside a consent dialog it has not opened, is read, and the company it names counts as named."
  },
  {
    detector: "privacy-policy",
    kind: "negative",
    environment: "real-chromium",
    file: "lib/scanner-policy-navigation.test.ts",
    testName: "a policy read cut at the scanner's character cap is withheld, not compared as the whole policy",
    verifies: "A policy longer than the 400,000 characters the scanner reads, which names its company only past them, publishes no policy and no company the policy does not name."
  },
  {
    detector: "privacy-policy",
    kind: "negative",
    environment: "real-chromium",
    file: "lib/scanner-policy-navigation.test.ts",
    testName: "a policy read cut at the collector's node bound is withheld, not compared as the whole policy",
    verifies: "A policy behind a menu past the collector's 20,000-node bound, a read with no sign of the cut, publishes no policy and no company the policy does not name."
  },
  {
    detector: "keystroke-exfiltration",
    kind: "negative",
    environment: "real-chromium",
    file: "lib/scanner.test.ts",
    testName: "a typed value the Shields engine stops names no recipient on either wire, and the visit without blocking still names it",
    verifies: "In a Brave Shields block simulation, a typed value whose every request the engine stopped names no recipient on either wire, while the visit without blocking names the recipient that received it."
  },
  {
    detector: "keystroke-exfiltration",
    kind: "positive",
    environment: "real-chromium",
    file: "lib/scanner.test.ts",
    testName: "a typed value the route guard refuses still names its recipient, never a complete finding that it stayed",
    verifies: "A typed value sent to a host the scanner's own public-address guard refuses still names that recipient rather than reading as a value that stayed."
  },
  {
    detector: "cname-uncloaking",
    kind: "positive",
    environment: "real-chromium",
    file: "lib/scanner.test.ts",
    testName: "a CNAME chain whose tracker sits four names down yields the cloak",
    verifies: "A first-party subdomain whose CNAME chain reaches a curated tracker after three other aliases is reported as a cloak."
  },
  {
    detector: "cname-uncloaking",
    kind: "adversarial",
    environment: "real-chromium",
    file: "lib/scanner.test.ts",
    testName: "a CNAME loop records the failed-lookup loss, never a complete negative",
    verifies: "A CNAME chain that loops back to a name it passed is recorded as a lookup that did not complete, never as a complete absence."
  }
] as const;

export const detectorValidationMetadata = {
  version: "detector-fixture-matrix-v1",
  registryVersion: DETECTOR_REGISTRY_VERSION,
  cases: DETECTOR_VALIDATION_FIXTURES.length,
  digest: sha256Hex(JSON.stringify(DETECTOR_VALIDATION_FIXTURES))
};

export function detectorValidationRows(): DetectorValidationRow[] {
  return DETECTOR_IDS.map((detector) => {
    const fixtures = DETECTOR_VALIDATION_FIXTURES.filter((fixture) => fixture.detector === detector).map((fixture) => ({ ...fixture }));
    const copy = DETECTOR_PUBLIC_COPY[detector];
    return {
      detector,
      label: copy.label,
      version: DETECTOR_VERSIONS[detector],
      positiveCases: fixtures.filter((fixture) => fixture.kind === "positive").length,
      negativeCases: fixtures.filter((fixture) => fixture.kind === "negative").length,
      adversarialCases: fixtures.filter((fixture) => fixture.kind === "adversarial").length,
      realChromiumCases: fixtures.filter((fixture) => fixture.environment === "real-chromium").length,
      limitations: copy.limitations,
      fixtures
    };
  });
}

export function validateDetectorValidationManifest(fixtures: readonly DetectorValidationFixture[]): string[] {
  const issues: string[] = [];
  const identities = new Set<string>();

  for (const [index, fixture] of fixtures.entries()) {
    const label = `${fixture.detector} fixture ${index + 1}`;
    if (!DETECTOR_IDS.includes(fixture.detector)) issues.push(`${label}: unknown detector`);
    if (!fixture.file.startsWith("lib/") || !fixture.file.endsWith(".test.ts") || fixture.file.includes("..")) {
      issues.push(`${label}: source must be a repository lib/*.test.ts path`);
    }
    if (!fixture.testName.trim()) issues.push(`${label}: exact test name is required`);
    if (!fixture.verifies.trim()) issues.push(`${label}: verification scope is required`);
    const identity = `${fixture.file}\u0000${fixture.testName}`;
    if (identities.has(identity)) issues.push(`${label}: duplicate source test`);
    identities.add(identity);
  }

  for (const detector of DETECTOR_IDS) {
    const detectorFixtures = fixtures.filter((fixture) => fixture.detector === detector);
    for (const kind of ["positive", "negative", "adversarial"] as const) {
      if (!detectorFixtures.some((fixture) => fixture.kind === kind)) {
        issues.push(`${detector}: missing ${kind} fixture`);
      }
    }
  }

  return issues;
}
