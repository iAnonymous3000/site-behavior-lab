import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  buildPrivacyPolicySummary,
  classifyEntityMentions,
  extractPolicyClaims,
  isCurrentlyCheckablePolicyClaim,
  isAllowedPrivacyPolicyUrl,
  MIN_POLICY_TEXT_LENGTH,
  pickPrivacyPolicyLink
} from "./privacy-policy";

const PAD = " Lorem ipsum privacy boilerplate.".repeat(30);

test("cookie denials cannot borrow negation or drop a qualification", () => {
  for (const quote of [
    "We do not sell personal information, but we do use third-party cookies.",
    "We do not sell personal information; we use cookies.",
    "We do not use third-party cookies for advertising.",
    "We do not use cookies unless you consent.",
    "We do not use cookies, except for authentication.",
    "We currently do not use cookies.",
    "We do not allow partners to use third-party cookies."
  ]) {
    assert.equal(extractPolicyClaims(quote).some(c => c.kind.includes("cookies")), false, quote);
    for (const kind of ["no-cookies", "no-third-party-cookies"] as const) {
      assert.equal(isCurrentlyCheckablePolicyClaim({kind, quote}), false, quote);
    }
  }
  for (const quote of ["We never use any cookies.", "No cookies are stored on this site."]) {
    assert.deepEqual(extractPolicyClaims(quote).map(c => c.kind), ["no-cookies"]);
  }
});

test("catalog entity names recognize their parent company aliases", () => {
  assert.deepEqual(classifyEntityMentions("Our partners include Amazon and Oracle.", ["Amazon Ads", "Oracle Advertising", "Google"]), {
    mentioned: ["Amazon Ads", "Oracle Advertising"], unmentioned: ["Google"]
  });
});

test("Privacy Centre is not mistaken for a localized settings link", () => {
  assert.equal(pickPrivacyPolicyLink([{href: "https://shop.example/privacy", text: "Privacy Centre"}], "shop.example"), "https://shop.example/privacy");
  assert.equal(pickPrivacyPolicyLink([{href: "https://shop.example/privacy", text: "Centre de preferences"}], "shop.example"), null);
});

test("isAllowedPrivacyPolicyUrl keeps redirects within the site or an approved policy host", () => {
  assert.equal(isAllowedPrivacyPolicyUrl("https://legal.shop.example/privacy", "www.shop.example"), true);
  assert.equal(isAllowedPrivacyPolicyUrl("https://app.termly.io/document/privacy-policy/abc", "shop.example"), true);
  assert.equal(isAllowedPrivacyPolicyUrl("https://policies.other.example/privacy", "shop.example"), false);
  assert.equal(isAllowedPrivacyPolicyUrl("javascript:alert(1)", "shop.example"), false);
  assert.equal(isAllowedPrivacyPolicyUrl("not a url", "shop.example"), false);
});

test("pickPrivacyPolicyLink prefers a same-site privacy policy link", () => {
  const url = pickPrivacyPolicyLink(
    [
      { href: "https://cdn.partner.example/privacy", text: "Privacy Policy" },
      { href: "https://shop.example/legal/privacy-policy", text: "Privacy Policy" },
      { href: "https://shop.example/careers", text: "Careers" }
    ],
    "www.shop.example"
  );
  assert.equal(url, "https://shop.example/legal/privacy-policy");
});

test("pickPrivacyPolicyLink picks the real /privacy/ policy over a 'Privacy features' marketing page", () => {
  // Reproduces the brave.com miss: the marketing link's text contains the word
  // "privacy" while the actual policy's link text ("Brave Browser") does not.
  const url = pickPrivacyPolicyLink(
    [
      { href: "https://brave.com/privacy-features/", text: "Privacy features" },
      { href: "https://brave.com/web-standards-at-brave/4-global-privacy-control/", text: "Global Privacy Control" },
      { href: "https://brave.com/privacy-updates/", text: "Privacy updates" },
      { href: "https://brave.com/privacy/browser/", text: "Brave Browser" },
      { href: "https://brave.com/privacy/website/", text: "Website & email" }
    ],
    "brave.com"
  );
  assert.equal(url, "https://brave.com/privacy/browser/");
});

test("pickPrivacyPolicyLink breaks ties toward the shallowest (most canonical) policy path", () => {
  const url = pickPrivacyPolicyLink(
    [
      { href: "https://shop.example/legal/privacy/mobile-app/", text: "Privacy" },
      { href: "https://shop.example/privacy/", text: "Privacy" }
    ],
    "shop.example"
  );
  assert.equal(url, "https://shop.example/privacy/");
});

test("pickPrivacyPolicyLink ignores a bare 'privacy' mention with no policy path", () => {
  assert.equal(
    pickPrivacyPolicyLink(
      [
        { href: "https://shop.example/why-privacy-matters", text: "Why privacy matters to us" },
        { href: "https://shop.example/blog/privacy-tips", text: "Our privacy tips" }
      ],
      "shop.example"
    ),
    null
  );
});

test("pickPrivacyPolicyLink accepts a known policy-hosting service but not arbitrary off-site policies", () => {
  // A CMP-hosted document is still the site's own policy.
  assert.equal(
    pickPrivacyPolicyLink([{ href: "https://app.termly.io/document/privacy-policy/abc", text: "Privacy Policy" }], "shop.example"),
    "https://app.termly.io/document/privacy-policy/abc"
  );
  // Another company's policy (Cloudflare challenge page, reCAPTCHA badge) must
  // never be attributed to the scanned site.
  assert.equal(
    pickPrivacyPolicyLink(
      [
        { href: "https://www.cloudflare.com/privacypolicy/", text: "Privacy Policy" },
        { href: "https://policies.google.com/privacy", text: "Privacy Policy" }
      ],
      "shop.example"
    ),
    null
  );
});

test("pickPrivacyPolicyLink never picks Do Not Sell opt-out links or non-http schemes", () => {
  assert.equal(
    pickPrivacyPolicyLink(
      [
        { href: "https://shop.example/dns", text: "Do Not Sell My Personal Information" },
        { href: "javascript:openPrivacy()", text: "Privacy Policy" }
      ],
      "shop.example"
    ),
    null
  );
});

test("pickPrivacyPolicyLink recognizes exact localized policy paths without relying on link text", () => {
  const cases = [
    {
      locale: "Spanish policy",
      href: "https://shop.example/legal/politica-de-privacidad",
      text: "Legal"
    },
    {
      locale: "Spanish privacy notice",
      href: "https://shop.example/legal/aviso-de-privacidad.html",
      text: "Legal"
    },
    {
      locale: "French policy",
      href: "https://shop.example/legal/politique-de-confidentialite",
      text: "Legal"
    },
    {
      locale: "French percent-encoded path",
      href: "https://shop.example/legal/politique-de-confidentialit%C3%A9",
      text: "Legal"
    },
    {
      locale: "German declaration",
      href: "https://shop.example/legal/datenschutzerklaerung",
      text: "Legal"
    },
    {
      locale: "German percent-encoded declaration",
      href: "https://shop.example/legal/datenschutzerkl%C3%A4rung",
      text: "Legal"
    },
    {
      locale: "Dutch policy",
      href: "https://shop.example/legal/privacybeleid",
      text: "Legal"
    },
    {
      locale: "Dutch statement",
      href: "https://shop.example/legal/privacyverklaring",
      text: "Legal"
    },
    {
      locale: "Portuguese policy",
      href: "https://shop.example/legal/politica-de-privacidade",
      text: "Legal"
    },
    {
      locale: "Portuguese notice",
      href: "https://shop.example/legal/aviso-de-privacidade",
      text: "Legal"
    }
  ];

  for (const fixture of cases) {
    assert.equal(
      pickPrivacyPolicyLink([{ href: fixture.href, text: fixture.text }], "shop.example"),
      fixture.href,
      fixture.locale
    );
  }
});

test("pickPrivacyPolicyLink accepts localized policy labels on a generic legal path", () => {
  for (const fixture of [
    { href: "https://shop.example/legal/es", text: "Política de privacidad" },
    { href: "https://shop.example/legal/es-notice", text: "Declaración de privacidad" },
    { href: "https://shop.example/legal/fr", text: "Politique de confidentialité" },
    { href: "https://shop.example/legal/fr-data", text: "Politique de protection des données" },
    { href: "https://shop.example/legal/de", text: "Datenschutzerklärung" },
    { href: "https://shop.example/legal/de-notice", text: "Datenschutzhinweise" },
    { href: "https://shop.example/legal/nl", text: "Privacyverklaring" },
    { href: "https://shop.example/legal/nl-data", text: "Gegevensbeschermingsbeleid" },
    { href: "https://shop.example/legal/pt", text: "Política de privacidade" },
    { href: "https://shop.example/legal/pt-notice", text: "Declaração de privacidade" },
    { href: "https://shop.example/legal/pt-data", text: "Política de proteção de dados" },
    { href: "https://shop.example/legal/it", text: "Informativa sulla privacy" },
    { href: "https://shop.example/legal/sv", text: "Integritetspolicy" },
    { href: "https://shop.example/legal/fi", text: "Tietosuojaseloste" },
    { href: "https://shop.example/legal/fi-practice", text: "Tietosuojakäytäntö" },
    // Turkish keeps its dotless i through accent stripping, so "politikası"
    // never becomes the ASCII "politikasi" the href carries.
    { href: "https://shop.example/legal/tr", text: "Gizlilik Politikası" },
    { href: "https://shop.example/legal/tr-notice", text: "Gizlilik Bildirimi" },
    { href: "https://shop.example/legal/cs", text: "Zásady ochrany soukromí" },
    { href: "https://shop.example/legal/hu", text: "Adatvédelmi tájékoztató" },
    // The Nordic ae ligature survives accent stripping the same way.
    { href: "https://shop.example/legal/no", text: "Personvernerklæring" },
    { href: "https://shop.example/legal/no-ascii", text: "Personvernerklaering" },
    { href: "https://shop.example/legal/da", text: "Politik om personoplysninger" },
    { href: "https://shop.example/legal/pl", text: "Polityka prywatności" }
  ]) {
    assert.equal(
      pickPrivacyPolicyLink([{ href: fixture.href, text: fixture.text }], "shop.example"),
      fixture.href,
      fixture.text
    );
  }
});

// One vocabulary, two files: the bounded in-page collector decides WHICH links
// come back and this selector decides which of them is the policy. A stem the
// collector matches but the selector cannot score is published as "the site
// offers no policy link", an instrument gap reported as a property of the site.
// Derive the cases from the collector's own declared list rather than from a
// hand-written fixture set, so a stem added there without an answer here fails.
test("every policy-link stem the bounded collector matches is answerable at the selector", async () => {
  // href/text pairs a real site would publish for each collector stem. The
  // collector lowercases but does not strip accents, so at least one of the two
  // must contain the stem verbatim in lower case, exactly as the page probe
  // tests it.
  const answers: Record<string, { href: string; text: string }> = {
    privacy: { href: "https://shop.example/privacy", text: "Privacy Policy" },
    privacidad: { href: "https://shop.example/politica-de-privacidad", text: "Política de privacidad" },
    privacidade: { href: "https://shop.example/politica-de-privacidade", text: "Política de privacidade" },
    privatezza: { href: "https://shop.example/informativa-privatezza", text: "Informativa sulla privatezza" },
    datenschutz: { href: "https://shop.example/datenschutzerklaerung", text: "Datenschutzerklärung" },
    confidentialit: { href: "https://shop.example/politique-de-confidentialite", text: "Politique de confidentialité" },
    "protection des donn": { href: "https://shop.example/legal/fr", text: "Politique de protection des données" },
    gegevensbescherming: { href: "https://shop.example/gegevensbeschermingsbeleid", text: "Juridisch" },
    "protecao de dados": { href: "https://shop.example/legal/pt", text: "Politica de protecao de dados" },
    "proteção de dados": { href: "https://shop.example/legal/pt-br", text: "Política de proteção de dados" },
    personvern: { href: "https://shop.example/personvernerklaering", text: "Personvernerklæring" },
    integritetspolicy: { href: "https://shop.example/integritetspolicy", text: "Integritetspolicy" },
    tietosuoja: { href: "https://shop.example/tietosuojaseloste", text: "Tietosuojaseloste" },
    personoplysninger: {
      href: "https://shop.example/politik-om-personoplysninger",
      text: "Politik om personoplysninger"
    },
    prywatno: { href: "https://shop.example/polityka-prywatnosci", text: "Polityka prywatności" },
    gizlilik: { href: "https://shop.example/gizlilik-politikasi", text: "Gizlilik Politikası" },
    soukrom: { href: "https://shop.example/ochrana-soukromi", text: "Ochrana soukromí" },
    adatvedelmi: { href: "https://shop.example/adatvedelmi-tajekoztato", text: "Adatvédelmi tájékoztató" }
  };

  const collector = await readFile(path.join(process.cwd(), "lib/bounded-page-collector.ts"), "utf8");
  const declaration = /const POLICY_LINK_TERMS = \[([\s\S]*?)\];/.exec(collector);
  assert.ok(declaration, "the bounded collector must declare POLICY_LINK_TERMS");
  const stems = (declaration[1].replace(/\/\/[^\n]*/g, "").match(/"([^"]*)"/g) ?? []).map((quoted) =>
    quoted.slice(1, -1)
  );
  assert.ok(stems.length >= 10, `parsed too few collector stems: ${stems.length}`);

  for (const stem of stems) {
    const answer = answers[stem];
    assert.ok(answer, `collector stem "${stem}" has no selector answer`);
    assert.ok(
      answer.href.toLowerCase().includes(stem) || answer.text.toLowerCase().includes(stem),
      `the fixture for "${stem}" would not be collected in the first place`
    );
    assert.equal(
      pickPrivacyPolicyLink([answer], "shop.example"),
      answer.href,
      `collector stem "${stem}" is collected but scores too low at the selector`
    );
  }

  for (const stem of Object.keys(answers)) {
    assert.ok(stems.includes(stem), `stale selector answer for a stem the collector no longer matches: "${stem}"`);
  }
});

test("pickPrivacyPolicyLink keeps localized marketing, preferences, and bare mentions out", () => {
  assert.equal(
    pickPrivacyPolicyLink(
      [
        { href: "https://shop.example/blog/por-que-la-privacidad-importa", text: "Por qué importa la privacidad" },
        { href: "https://shop.example/legal/es", text: "Cómo redactar una política de privacidad" },
        { href: "https://shop.example/legal/fr", text: "Guide de la politique de confidentialité" },
        { href: "https://shop.example/legal/de", text: "Was gehört in eine Datenschutzerklärung?" },
        { href: "https://shop.example/legal/nl", text: "Voorbeeld privacyverklaring" },
        { href: "https://shop.example/legal/pt", text: "Modelo de política de privacidade" },
        { href: "https://shop.example/privacidad", text: "Preferencias de privacidad" },
        { href: "https://shop.example/confidentialite", text: "Préférences de confidentialité" },
        { href: "https://shop.example/datenschutz", text: "Datenschutz-Tipps" },
        { href: "https://shop.example/privacybeleid", text: "Voorbeeld privacybeleid" },
        { href: "https://shop.example/privacidade", text: "Dicas de privacidade" },
        { href: "https://shop.example/legal%2Fprivacy", text: "Legal" },
        { href: "https://shop.example/gdpr", text: "GDPR" },
        // The added localized nouns stay as weak on their own as bare
        // "privacy": a label has to name a policy, notice, or statement.
        { href: "https://shop.example/legal/sv", text: "Integritet" },
        { href: "https://shop.example/legal/no", text: "Personvern" },
        { href: "https://shop.example/legal/fi", text: "Tietosuoja" },
        { href: "https://shop.example/legal/hu", text: "Adatvédelem" }
      ],
      "shop.example"
    ),
    null
  );
});

test("pickPrivacyPolicyLink never attributes a localized policy to another site", () => {
  assert.equal(
    pickPrivacyPolicyLink(
      [{ href: "https://other.example/legal", text: "Política de privacidad" }],
      "shop.example"
    ),
    null
  );
});

test("extractPolicyClaims matches first-person testable statements with quotes", () => {
  const claims = extractPolicyClaims(
    "About us. We do not use third-party cookies on this website. " +
      "We will not sell or share your personal information with anyone. " +
      "We honor the Global Privacy Control signal as a valid opt-out."
  );

  const kinds = claims.map((claim) => claim.kind).sort();
  assert.deepEqual(kinds, ["honors-gpc", "no-selling-or-sharing", "no-third-party-cookies"]);
  const cookieClaim = claims.find((claim) => claim.kind === "no-third-party-cookies");
  assert.ok(cookieClaim?.quote.includes("third-party cookies"));
});

test("extractPolicyClaims never reads a negated GPC sentence as an honors-gpc claim", () => {
  // Each of these states the OPPOSITE of honoring GPC; extracting them as
  // support would invert the policy's meaning.
  for (const sentence of [
    "We do not honor Global Privacy Control signals.",
    "Our systems will not process Global Privacy Control signals at this time.",
    "This website does not currently recognize Global Privacy Control.",
    "We cannot honor Global Privacy Control requests."
  ]) {
    assert.deepEqual(extractPolicyClaims(sentence), [], sentence);
  }

  // The plain positive statement still extracts.
  const positive = extractPolicyClaims("We honor Global Privacy Control signals.");
  assert.deepEqual(
    positive.map((claim) => claim.kind),
    ["honors-gpc"]
  );
});

test("extractPolicyClaims ignores opt-out link labels and scoped cookie statements", () => {
  const claims = extractPolicyClaims(
    "Do Not Sell Or Share My Personal Information. " +
      "We do not use cookies for advertising purposes. " +
      "Your Privacy Choices."
  );
  assert.deepEqual(claims, []);
});

test("extractPolicyClaims keeps only blanket combined no-selling-and-sharing statements", () => {
  for (const sentence of [
    "We do not sell or share your personal information with anyone.",
    "We never share or sell personal data.",
    "Our website will not rent, sell, or share your personal information.",
    "We do not sell your personal information to third parties, nor share it with advertisers."
  ]) {
    assert.deepEqual(
      extractPolicyClaims(sentence).map((claim) => claim.kind),
      ["no-selling-or-sharing"],
      sentence
    );
  }
});

test("extractPolicyClaims requires selling and sharing under the same explicit negation", () => {
  for (const sentence of [
    "We do not sell your personal information.",
    "We do not share your personal information.",
    "We do not sell personal data. We do not share personal data.",
    "We do not sell personal data and we do not share it.",
    "We do not sell and share personal information.",
    "We do not restrict partners from selling or sharing your personal information.",
    "We do not sell personal information to partners who share it."
  ]) {
    assert.deepEqual(extractPolicyClaims(sentence), [], sentence);
  }
});

test("extractPolicyClaims does not turn qualified real-policy wording into blanket combined claims", () => {
  // These reproduce the clauses that generated false policy conflicts in the
  // committed eHarmony, Scholastic, Citi, and Psychology Today reports.
  const qualifiedOrContradictory = [
    "We do not knowingly collect, share, or sell the personal information of minors under 16 years of age.",
    "We do not knowingly sell children’s CCPA Personal Information.",
    "Please also note, for purposes of California law, we do not knowingly sell or share the Personal Information of minors under 16 years of age.",
    "Although we do not “sell” personal data for direct monetary gain, some data sharing for cross-context behavioral advertising may be considered a “sale” under CCPA.",
    "While we do not currently sell personal data for monetary gain, certain types of data sharing may qualify as a sale under applicable state laws."
  ];

  for (const sentence of qualifiedOrContradictory) {
    assert.deepEqual(extractPolicyClaims(sentence), [], sentence);
  }
});

test("extractPolicyClaims rejects other population, time, value, and exception qualifiers", () => {
  for (const sentence of [
    "We currently do not sell or share your personal information.",
    "We do not sell or share your personal information at this time.",
    "We do not sell or share sensitive personal information.",
    "We do not sell or share personal data for monetary consideration.",
    "We do not sell or share personal data in exchange for payment.",
    'We do not "sell" or "share" Personal Data as defined under those laws.',
    "We do not sell or share your personal information except to complete a merger.",
    "We do not sell or share your personal information without your consent.",
    "We do not sell personal data, but we may share it with advertising partners.",
    "We do not restrict our partners from selling or sharing your personal information."
  ]) {
    assert.deepEqual(extractPolicyClaims(sentence), [], sentence);
  }
});

test("a qualified combined transfer sentence does not suppress other checkable policy claims", () => {
  const claims = extractPolicyClaims(
    "We do not knowingly sell or share the personal information of minors under 16 years of age. " +
      "We do not use third-party cookies. " +
      "We honor Global Privacy Control signals."
  );

  assert.deepEqual(
    claims.map((claim) => claim.kind).sort(),
    ["honors-gpc", "no-third-party-cookies"]
  );
});

test("extractPolicyClaims matches a blanket no-cookies statement", () => {
  const claims = extractPolicyClaims("We do not use cookies on this site at all.");
  assert.deepEqual(
    claims.map((claim) => claim.kind),
    ["no-cookies"]
  );
});

test("classifyEntityMentions applies aliases (Facebook counts as Meta, Twitter as X)", () => {
  const { mentioned, unmentioned } = classifyEntityMentions(
    "We share data with Facebook and with Twitter for advertising.",
    ["Meta", "X", "Criteo"]
  );
  assert.deepEqual(mentioned, ["Meta", "X"]);
  assert.deepEqual(unmentioned, ["Criteo"]);
});

test("buildPrivacyPolicySummary rejects text too short to be a real policy", () => {
  assert.equal(
    buildPrivacyPolicySummary({ url: "https://shop.example/privacy", policyText: "404 not found", trackingEntities: ["Meta"] }),
    null
  );
});

test("buildPrivacyPolicySummary builds claims and mention lists from real-length text", () => {
  const text = `We do not use third-party cookies. We work with Google for analytics.${PAD}`;
  assert.ok(text.length >= MIN_POLICY_TEXT_LENGTH);

  const summary = buildPrivacyPolicySummary({
    url: "https://shop.example/privacy",
    policyText: text,
    trackingEntities: ["Google", "Meta"]
  });

  assert.ok(summary);
  assert.deepEqual(
    summary.claims.map((claim) => claim.kind),
    ["no-third-party-cookies"]
  );
  assert.deepEqual(summary.mentionedEntities, ["Google"]);
  assert.deepEqual(summary.unmentionedEntities, ["Meta"]);
  assert.equal(summary.policyTextLength, text.length);
});

test("a policy naming Meta by its own name is a mention, not an accusation", () => {
  // "meta" cannot join the case-insensitive alias list ("meta tags", "metadata"),
  // and that gap published "Meta is never named" over policies that disclosed
  // "Meta Platforms" by legal name. Over-matching merely withholds an accusation;
  // under-matching invents one.
  const named = classifyEntityMentions(
    "We share information with Meta Platforms, Inc. and with our analytics vendors.",
    ["Meta"]
  );
  assert.deepEqual(named.mentioned, ["Meta"]);

  const midSentence = classifyEntityMentions("Advertising partners such as Meta receive hashed identifiers.", ["Meta"]);
  assert.deepEqual(midSentence.mentioned, ["Meta"]);

  // Ordinary uses of the word must not count as naming the company.
  const metaTags = classifyEntityMentions("We use meta tags and collect meta data about usage.", ["Meta"]);
  assert.deepEqual(metaTags.unmentioned, ["Meta"]);

  const xNamed = classifyEntityMentions("We share conversion data with X for advertising measurement.", ["X"]);
  assert.deepEqual(xNamed.mentioned, ["X"]);

  const xAxis = classifyEntityMentions("charts plot time on the x axis of the dashboard", ["X"]);
  assert.deepEqual(xAxis.unmentioned, ["X"]);
});
