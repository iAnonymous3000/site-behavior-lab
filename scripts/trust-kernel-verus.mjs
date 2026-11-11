#!/usr/bin/env node
// Installs the pinned Verus release and runs it on the trust kernel.
//
//   install --into <dir>   download the release for this platform, refuse it
//                          unless its size and sha256 are the pinned ones,
//                          and unpack it
//   verify --verus <dir>   check tools/trust-kernel with it
//
// A green verifier run alone can mean that nothing was asked, so `verify`
// does six things and fails on the first that does not hold:
//
//   1. Source guards. Every file of the kernel crate is read. A word that
//      lets a claim through unchecked is refused in all of them (see
//      ESCAPES). Verus source is allowed in src/encode.rs only. No `cfg`
//      may stand in that file, so no build can compile a function other
//      than the one Verus read. The crate is exactly the files listed here,
//      with no build script. The manifest must ask for verification.
//   2. Pins. The seven checked statements must stand in src/encode.rs word
//      for word, signature, `requires` and `ensures` (STATEMENTS), and the
//      specification they speak about must have the pinned sha256
//      (SPECIFICATION_SHA256). A change to either is a change to the claim
//      and has to be made here too, on purpose.
//   3. The guards' own test. Each entry of GUARD_MUTATIONS is a change that
//      switches part of the proof off or swaps what is compiled. Each is
//      made in a scratch copy, and the guards must refuse that copy for the
//      stated reason. A guard that does not fire fails the run.
//   4. `cargo test` of the same source, as an ordinary build: the functions
//      Verus reads are the functions the tests run.
//   5. `cargo verus verify` on a clean target, which first checks vstd
//      itself and then the kernel, at the checker's default resource limit
//      of 10. Then the kernel alone again under RLIMIT_FLOOR. Each result
//      must be exactly VERIFIED_ITEMS items and no error, and must name
//      each of the seven statements. A proof that only passes near the
//      default limit fails here, before a solver or platform change can
//      tip it. (vstd is not held to the floor: one of its own lemmas needs
//      most of it.)
//   6. The checker's own test. Each entry of VERUS_MUTATIONS breaks the
//      specification or the code in a scratch copy, and Verus must refuse
//      that copy with an error of its own (not a build failure, and not a
//      run answered from a cache).
//
// Nothing here is cached between runs and nothing is fetched except the one
// pinned archive, by `install`, and the crates Cargo.lock names, by cargo.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WORKSPACE = path.join(ROOT, "tools/trust-kernel");
const PINS = JSON.parse(readFileSync(path.join(WORKSPACE, "pins.json"), "utf8"));
const ENCODER = "kernel/src/encode.rs";

// The kernel crate and the WebAssembly crate are these files and no other.
// A file that is not listed (a build script, a second module, a cargo
// configuration) is refused, so nothing unread is compiled.
const CRATE_FILES = [
  "kernel/Cargo.toml",
  "kernel/src/encode.rs",
  "kernel/src/lib.rs",
  "kernel/src/nfc.rs",
  "kernel/src/nfc_tables.rs",
  "kernel/src/number.rs",
  "kernel/src/parse.rs",
  "kernel/src/tests.rs",
  "wasm/Cargo.toml",
  "wasm/src/lib.rs"
];

// A word here widens what is trusted without a proof, lifts a limit, or
// brings in text from elsewhere. None may appear in any Rust file of the
// kernel crate, comments included, so the check stays a plain text search.
// `verifier` covers every attribute of that family in both spellings
// (`#[verifier::external_body]`, `#[verifier(external)]`, `rlimit`,
// `opaque`, `trusted`, `exec_allows_no_decreases_clause`).
const ESCAPES = [
  /\bassume\b/,
  /\badmit\b/,
  /assume_specification/,
  /external/,
  /verifier/,
  /\bopaque\b/,
  /\buninterp\b/,
  /\bunsafe\b/,
  /\brlimit\b/,
  /\bbroadcast\b/,
  /\bglobal\b/,
  /\binclude(?:_str|_bytes)?\s*!/,
  /macro_rules/,
  /#\s*!?\s*\[\s*path\b/,
  /\/\*/
];
// The one axiom the encoder calls, a library fact about the size of a
// vector's element that the termination arguments use. Every other use of
// the word is refused: `axiom fn` declares a statement with no argument.
const ALLOWED_AXIOM = "vstd::std_specs::vec::axiom_vec_index_decreases(";
// Verus source outside the encoder is refused: these mark it.
const VERUS_MARKS = [/verus\s*!/, /\bvstd\b/, /\bproof\s+fn\b/, /\bspec\s+fn\b/, /\bensures\b/, /\brequires\b/];
// The vstd the encoder was checked against, as Cargo.lock must name it: from
// the crates.io registry, with this checksum, which cargo holds the download
// to. A path or a patched copy has no such entry.
const VSTD_LOCK_ENTRY =
  `[[package]]\nname = "vstd"\nversion = "${PINS.verus.vstdCrate}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n` +
  `checksum = "7cfcc2fc379ffbcda31111f1a7da2a34d00bd984407cfa85d1edcf64da38dbd2"\n`;
// The only `cfg` in the crate: the unit tests, which no shipped build holds.
const TESTS_MODULE = "#[cfg(test)]\nmod tests;\n";

// Verus's default is 10. The kernel was measured to pass at 0.5 and to fail
// at 0.4, on macOS arm64 with this release. Its largest function uses
// 1,467,553 of the solver's resource units, the same number on macOS arm64
// and on Linux x86-64, where the default allows 30 million. The kernel must
// pass at 2: a fifth of the default, and four times what was measured.
const RLIMIT_FLOOR = 2;
const VERIFIED_ITEMS = 86;

// The checked statements, word for word: signature, `requires`, `ensures`.
const STATEMENTS = [
  `pub proof fn theorem_encoding_is_injective(t1: Tree, t2: Tree)
    requires
        numbers_are_tokens(t1),
        numbers_are_tokens(t2),
        encode(t1) == encode(t2),
    ensures
        t1 == t2,`,
  `pub proof fn theorem_admitted_numbers_are_tokens(t: Tree)
    requires
        admitted(t),
    ensures
        numbers_are_tokens(t),
    decreases t,`,
  `pub proof fn theorem_admitted_trees_never_share_bytes(t1: Tree, t2: Tree)
    requires
        admitted(t1),
        admitted(t2),
        encode(t1) == encode(t2),
    ensures
        t1 == t2,`,
  `pub proof fn theorem_key_order_is_strict(a: Seq<u16>)
    ensures
        !key_less(a, a),`,
  `pub proof fn theorem_key_order_is_transitive(a: Seq<u16>, b: Seq<u16>, c: Seq<u16>)
    requires
        key_less(a, b),
        key_less(b, c),
    ensures
        key_less(a, c),`,
  `pub proof fn theorem_admitted_object_has_no_key_twice(m: Seq<(Seq<u16>, Tree)>, i: int, j: int)
    requires
        admitted(Tree::Object(m)),
        0 <= i < j < m.len(),
    ensures
        key_less(m[i].0, m[j].0),
        m[i].0 != m[j].0,
    decreases j - i,`,
  `pub fn encode_admitted(v: &Value) -> (r: Option<Vec<u8>>)
    ensures
        match r {
            Some(bytes) => admitted(tree_of(*v)) && bytes@ == encode(tree_of(*v)),
            None => !admitted(tree_of(*v)),
        },`
];
// sha256 of src/encode.rs from `verus! {` up to the line that opens the
// injectivity argument: the value types, `tree_of`, `encode` and the rest of
// the encoding, `admitted`, `numbers_are_tokens`, `key_less`. This text is
// what the statements above mean.
const SPECIFICATION_FROM = "verus! {\n";
const SPECIFICATION_TO = "// ---------------------------------------------------------------------------\n// Injectivity.\n";
const SPECIFICATION_SHA256 = "ea3a9f91fc41edc174599cf85e7693d3280ab65522a3bd44368ac9390080e0c7";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function option(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1 || argv[at + 1] === undefined) throw new Error(`missing ${name} <value>`);
  return argv[at + 1];
}

function asset() {
  const key = `${process.platform}-${process.arch}`;
  const found = PINS.verus.assets[key];
  if (!found) throw new Error(`no pinned Verus release for ${key}`);
  return found;
}

function install(into) {
  const pinned = asset();
  mkdirSync(into, { recursive: true });
  const archive = path.join(into, "verus.zip");
  execFileSync(
    "curl",
    ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--tlsv1.2", "--max-filesize", String(pinned.bytes), "--output", archive, pinned.url],
    { stdio: "inherit" }
  );
  const bytes = readFileSync(archive);
  const digest = sha256(bytes);
  if (bytes.length !== pinned.bytes || digest !== pinned.sha256) {
    rmSync(archive, { force: true });
    throw new Error(`the Verus archive is not the pinned one: ${bytes.length} bytes, sha256 ${digest}`);
  }
  execFileSync("unzip", ["-q", "-o", archive, "-d", into], { stdio: "inherit" });
  rmSync(archive, { force: true });
  const directory = path.join(into, pinned.directory);
  const version = JSON.parse(readFileSync(path.join(directory, "version.json"), "utf8")).verus;
  if (version.version !== PINS.verus.version || version.commit !== PINS.verus.commit) {
    throw new Error(`the unpacked Verus names itself ${version.version} at ${version.commit}`);
  }
  console.log(`Verus ${version.version} (sha256 ${digest}) unpacked to ${directory}`);
  return directory;
}

// ---------------------------------------------------------------------------
// Source guards and pins
// ---------------------------------------------------------------------------

class GuardRefusal extends Error {
  constructor(rule, message) {
    super(`[${rule}] ${message}`);
    this.rule = rule;
  }
}

function filesUnder(directory, base = directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full, base));
    else found.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return found;
}

/** The text of one checked statement: from its first line up to its body. */
function statementAt(source, statement) {
  const head = statement.slice(0, statement.indexOf("(") + 1);
  const at = source.indexOf(head);
  if (at === -1 || source.indexOf(head, at + 1) !== -1) return null;
  const end = source.indexOf("\n{\n", at);
  return end === -1 ? null : source.slice(at, end);
}

/** Throws a GuardRefusal unless the workspace at `workspace` passes every source guard and pin. */
function checkWorkspace(workspace) {
  const present = [...filesUnder(path.join(workspace, "kernel")), ...filesUnder(path.join(workspace, "wasm"))]
    .map((file, index, all) => (index < filesUnder(path.join(workspace, "kernel")).length ? `kernel/${file}` : `wasm/${file}`))
    .sort();
  const expected = [...CRATE_FILES].sort();
  if (JSON.stringify(present) !== JSON.stringify(expected)) {
    const extra = present.filter((file) => !expected.includes(file));
    const missing = expected.filter((file) => !present.includes(file));
    throw new GuardRefusal("file-set", `the crates are not the listed files: unlisted ${JSON.stringify(extra)}, missing ${JSON.stringify(missing)}`);
  }
  for (const place of [".cargo", "kernel/.cargo", "wasm/.cargo", "build.rs"]) {
    if (existsSync(path.join(workspace, place))) throw new GuardRefusal("file-set", `${place} must not exist in the workspace`);
  }

  const read = (file) => readFileSync(path.join(workspace, file), "utf8");
  for (const file of CRATE_FILES.filter((name) => name.startsWith("kernel/src/"))) {
    const source = read(file);
    for (const pattern of ESCAPES) {
      if (pattern.test(source)) throw new GuardRefusal("escape", `${file} holds ${pattern}, which lets a claim through unchecked`);
    }
    const axioms = source.split("axiom").length - 1;
    const allowed = file === ENCODER ? source.split(ALLOWED_AXIOM).length - 1 : 0;
    if (axioms !== allowed) throw new GuardRefusal("escape", `${file} names an axiom other than the one library fact the encoder may call`);
    if (file !== ENCODER) {
      for (const pattern of VERUS_MARKS) {
        if (pattern.test(source)) throw new GuardRefusal("verus-outside-encoder", `${file} holds Verus source (${pattern}); only ${ENCODER} may`);
      }
    }
    const withoutTests = file === "kernel/src/lib.rs" ? source.replace(TESTS_MODULE, "") : source;
    if (file === "kernel/src/lib.rs" && withoutTests.length !== source.length - TESTS_MODULE.length) {
      throw new GuardRefusal("cfg", `${file} must hold the unit test module once, as ${JSON.stringify(TESTS_MODULE)}`);
    }
    if (/\bcfg\b|cfg_attr|cfg!/.test(withoutTests)) {
      throw new GuardRefusal("cfg", `${file} holds a cfg, which can swap the function that is compiled for another than the one that is checked`);
    }
  }
  // The WebAssembly shim cannot carry forbid(unsafe_code), because the lint
  // counts an exported symbol name. Its comments say so, so they are left
  // out of this one search; a line that is only a comment holds no code.
  const shim = read("wasm/src/lib.rs");
  const shimCode = shim.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  if (/\bunsafe\b/.test(shimCode)) throw new GuardRefusal("unsafe", "wasm/src/lib.rs holds unsafe code");
  for (const pattern of VERUS_MARKS) {
    if (pattern.test(shim)) throw new GuardRefusal("verus-outside-encoder", `wasm/src/lib.rs holds Verus source (${pattern})`);
  }
  if (!read("kernel/src/lib.rs").includes("#![forbid(unsafe_code)]\n")) {
    throw new GuardRefusal("unsafe", "kernel/src/lib.rs no longer forbids unsafe code");
  }

  const manifest = read("kernel/Cargo.toml");
  if (!/^\[package\.metadata\.verus\]\nverify = true$/m.test(manifest) || (manifest.match(/\bverify\b/g) ?? []).length !== 1) {
    throw new GuardRefusal("manifest", "kernel/Cargo.toml must ask for verification once, as [package.metadata.verus] verify = true");
  }
  if (/^\s*\[features\]|^\s*build\s*=|^\s*\[build-dependencies\]|^\s*\[target\./m.test(manifest)) {
    throw new GuardRefusal("manifest", "kernel/Cargo.toml must have no features, no build script and no target-specific section");
  }
  if (!manifest.includes(`\n[dependencies]\nvstd = "=${PINS.verus.vstdCrate}"\n`) || (manifest.match(/^\[.*dependencies.*\]$/gm) ?? []).length !== 1) {
    throw new GuardRefusal("manifest", `kernel/Cargo.toml must depend on vstd =${PINS.verus.vstdCrate} and on nothing else`);
  }
  const lock = read("Cargo.lock");
  if (!lock.includes(VSTD_LOCK_ENTRY) || lock.split('name = "vstd"').length - 1 !== 1) {
    throw new GuardRefusal("manifest", "Cargo.lock does not resolve vstd to the pinned registry crate and checksum");
  }
  if (/^\s*\[(patch|replace)\b/m.test(read("Cargo.toml"))) {
    throw new GuardRefusal("manifest", "the workspace manifest must not patch or replace a crate");
  }

  const encoder = read(ENCODER);
  // One block, opened once and closed on the last line. A macro call opens
  // with its name at the start of a line; the comments name it mid-line.
  if ((encoder.match(/^\s*verus\s*!/gm) ?? []).length !== 1 || !encoder.includes("\nverus! {\n") || !encoder.trimEnd().endsWith("\n} // verus!")) {
    throw new GuardRefusal("statement", `${ENCODER} must be one verus! block to its last line`);
  }
  for (const statement of STATEMENTS) {
    const name = /fn (\w+)\(/.exec(statement)[1];
    const found = statementAt(encoder, statement);
    if (found !== statement) {
      throw new GuardRefusal("statement", `${ENCODER} no longer states ${name} as pinned. Pinned:\n${statement}\nFound:\n${found ?? "(not there, or there twice)"}`);
    }
  }
  const from = encoder.indexOf(SPECIFICATION_FROM);
  const to = encoder.indexOf(SPECIFICATION_TO);
  if (from === -1 || to <= from || encoder.indexOf(SPECIFICATION_TO, to + 1) !== -1) {
    throw new GuardRefusal("specification", `${ENCODER} no longer holds the specification between its two marks`);
  }
  const digest = sha256(Buffer.from(encoder.slice(from, to), "utf8"));
  if (digest !== SPECIFICATION_SHA256) {
    throw new GuardRefusal("specification", `the specification in ${ENCODER} has sha256 ${digest}; the pin is ${SPECIFICATION_SHA256}`);
  }
  for (const mutation of [...GUARD_MUTATIONS, ...VERUS_MUTATIONS]) {
    for (const edit of mutation.edits) {
      if (edit.from !== undefined && read(edit.file).split(edit.from).length - 1 !== 1) {
        throw new GuardRefusal("self-test", `${edit.file} no longer holds, exactly once, the text the self-test "${mutation.name}" changes`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mutations: changes the guards, or Verus, must refuse
// ---------------------------------------------------------------------------

const MAIN_LEMMA_FIRST_LINE = "    lemma_first_byte(t1);\n    lemma_first_byte(t2);\n    lemma_first_of_concat(encode(t1), r1);";
const ENTRY_POINT_CHECK = "    if !admitted_exec(v) {\n        return None;\n    }\n    let mut out: Vec<u8> = Vec::new();";
const KEY_ORDER_CLAUSE =
  "        Tree::Object(m) => (forall|i: int| 0 <= i < m.len() ==> admitted((#[trigger] m[i]).1)) && (\n" +
  "        forall|i: int| 0 < i < m.len() ==> key_less(m[i - 1].0, (#[trigger] m[i]).0)),";
const PUSH_TWO =
  "fn push_two(out: &mut Vec<u8>, a: u8, b: u8)\n    ensures\n        final(out)@ == old(out)@ + seq![a, b],\n{\n" +
  "    out.push(a);\n    out.push(b);\n    assert(out@ =~= old(out)@ + seq![a, b]);\n}\n";
const THEOREM_REQUIRES = "        numbers_are_tokens(t2),\n        encode(t1) == encode(t2),\n    ensures\n        t1 == t2,\n{\n    let none = Seq::<u8>::empty();";

/**
 * Text changes the source guards must refuse, each with the rule that has
 * to fire. The first seven are the independent review's: M5, M6b, M9 and
 * M12 passed the first version of this script with a green result; M4, M8
 * and M2 were caught then (M2 only by accident, through the resource limit).
 */
const GUARD_MUTATIONS = [
  {
    name: "M5: an unproved lemma in another file, called from the main lemma",
    rule: "escape",
    edits: [
      { file: ENCODER, from: MAIN_LEMMA_FIRST_LINE, to: `    crate::number::lemma_digits();\n${MAIN_LEMMA_FIRST_LINE}` },
      {
        file: "kernel/src/number.rs",
        append: "\nuse vstd::prelude::*;\nverus! {\n#[verifier::external_body]\npub proof fn lemma_digits()\n    ensures false,\n{\n}\n}\n"
      }
    ]
  },
  {
    name: "M5 without the attribute: Verus source in another file",
    rule: "verus-outside-encoder",
    edits: [{ file: "kernel/src/number.rs", append: "\nuse vstd::prelude::*;\nverus! {\npub proof fn lemma_digits()\n{\n}\n}\n" }]
  },
  {
    name: "M6b: false among the hypotheses of the injectivity theorem",
    rule: "statement",
    edits: [{ file: ENCODER, from: THEOREM_REQUIRES, to: THEOREM_REQUIRES.replace("encode(t1) == encode(t2),", "encode(t1) == encode(t2),\n        false,") }]
  },
  {
    name: "M9: a cfg gives the ordinary build another push_two than the checked one",
    rule: "cfg",
    edits: [
      {
        file: ENCODER,
        from: PUSH_TWO,
        to: `#[cfg(verus_keep_ghost)]\n${PUSH_TWO}\n#[cfg(not(verus_keep_ghost))]\nfn push_two(out: &mut Vec<u8>, a: u8, _b: u8) {\n    out.push(a);\n}\n`
      }
    ]
  },
  {
    name: "M12: the entry point taken out of verification with the older attribute spelling",
    rule: "escape",
    edits: [
      { file: ENCODER, from: "pub fn encode_admitted(v: &Value) -> (r: Option<Vec<u8>>)", to: "#[verifier(external)]\npub fn encode_admitted(v: &Value) -> (r: Option<Vec<u8>>)" },
      { file: ENCODER, from: ENTRY_POINT_CHECK, to: "    let mut out: Vec<u8> = Vec::new();" }
    ]
  },
  {
    name: "M4: assume(false) in the main lemma",
    rule: "escape",
    edits: [{ file: ENCODER, from: MAIN_LEMMA_FIRST_LINE, to: `    assume(false);\n${MAIN_LEMMA_FIRST_LINE}` }]
  },
  {
    name: "M8: the manifest tells cargo verus not to verify the crate",
    rule: "manifest",
    edits: [{ file: "kernel/Cargo.toml", from: "verify = true", to: "verify = false" }]
  },
  {
    name: "M2: the key order clause dropped from the admitted domain",
    rule: "specification",
    edits: [{ file: ENCODER, from: KEY_ORDER_CLAUSE, to: "        Tree::Object(m) => (forall|i: int| 0 <= i < m.len() ==> admitted((#[trigger] m[i]).1))," }]
  },
  {
    name: "the entry point's promise weakened back to nothing on a refusal",
    rule: "statement",
    edits: [{ file: ENCODER, from: "            None => !admitted(tree_of(*v)),", to: "            None => true," }]
  },
  {
    name: "admit() in the main lemma",
    rule: "escape",
    edits: [{ file: ENCODER, from: MAIN_LEMMA_FIRST_LINE, to: `    admit();\n${MAIN_LEMMA_FIRST_LINE}` }]
  },
  {
    name: "a declared axiom",
    rule: "escape",
    edits: [{ file: ENCODER, append: "\nverus! {\npub axiom fn everything()\n    ensures false;\n}\n" }]
  },
  {
    name: "a function given a resource limit of its own",
    rule: "escape",
    edits: [{ file: ENCODER, from: "proof fn lemma_encode_injective(", to: "#[verifier::rlimit(1000)]\nproof fn lemma_encode_injective(" }]
  },
  {
    name: "a checked statement moved into a comment, the function gone",
    rule: "escape",
    edits: [{ file: ENCODER, from: "/// Every admitted tree is in the domain of the theorem above.\n", to: "/*\n" }, { file: ENCODER, from: "/// Two admitted trees with the same bytes are the same tree.\n", to: "*/\n" }]
  },
  {
    name: "a build script",
    rule: "file-set",
    edits: [{ file: "kernel/build.rs", create: 'fn main() {\n    println!("cargo:rustc-cfg=verus_keep_ghost");\n}\n' }]
  },
  {
    name: "a cargo configuration in the workspace",
    rule: "file-set",
    edits: [{ file: ".cargo/config.toml", create: '[build]\nrustflags = ["--cfg", "verus_keep_ghost"]\n' }]
  },
  {
    name: "a second module file",
    rule: "file-set",
    edits: [{ file: "kernel/src/extra.rs", create: "pub fn nothing() {}\n" }]
  },
  {
    name: "a feature in the manifest",
    rule: "manifest",
    edits: [{ file: "kernel/Cargo.toml", append: "\n[features]\nfast = []\n" }]
  },
  {
    name: "vstd replaced by a local copy",
    rule: "manifest",
    edits: [
      { file: "Cargo.toml", append: '\n[patch.crates-io]\nvstd = { path = "vendored-vstd" }\n' },
      { file: "Cargo.lock", from: VSTD_LOCK_ENTRY, to: `[[package]]\nname = "vstd"\nversion = "${PINS.verus.vstdCrate}"\n` }
    ]
  },
  {
    name: "a patch section alone in the workspace manifest",
    rule: "manifest",
    edits: [{ file: "Cargo.toml", append: '\n[patch.crates-io]\nvstd = { path = "vendored-vstd" }\n' }]
  },
  {
    name: "unsafe code in the WebAssembly shim",
    rule: "unsafe",
    edits: [{ file: "wasm/src/lib.rs", append: "\npub fn peek(at: *const u8) -> u8 {\n    unsafe { *at }\n}\n" }]
  },
  {
    name: "the kernel no longer forbids unsafe code",
    rule: "unsafe",
    edits: [{ file: "kernel/src/lib.rs", from: "#![forbid(unsafe_code)]\n", to: "" }]
  }
];

/**
 * Changes Verus itself must refuse. The first writes a quote with no
 * escape, so two strings share bytes. M7 is the review's: before the entry
 * point promised anything about a refusal, Verus accepted it. M2 passed
 * Verus under a higher resource limit while injectivity was the only
 * statement; the key order statements now need the clause. M1 drops the
 * comma between items in the specification and in the code.
 */
const VERUS_MUTATIONS = [
  {
    name: "a quote written with no escape",
    edits: [{ file: ENCODER, from: "    if u == 0x22 {\n        seq![0x5cu8, 0x22u8]\n    } else if u == 0x5c {", to: "    if u == 0x22 {\n        seq![0x22u8]\n    } else if u == 0x5c {" }]
  },
  {
    name: "M7: the entry point refuses everything",
    edits: [{ file: ENCODER, from: ENTRY_POINT_CHECK, to: ENTRY_POINT_CHECK.replace("if !admitted_exec(v) {", "if !admitted_exec(v) || true {") }]
  },
  {
    name: "M2: the key order clause dropped, in the specification and in the code",
    edits: [
      { file: ENCODER, from: KEY_ORDER_CLAUSE, to: "        Tree::Object(m) => (forall|i: int| 0 <= i < m.len() ==> admitted((#[trigger] m[i]).1))," },
      { file: ENCODER, from: "                    forall|j: int| 0 < j < i ==> key_less(members[j - 1].0, (#[trigger] members[j]).0),\n", to: "" },
      {
        file: ENCODER,
        from: "                if i > 0 && !key_less_exec(&m[i - 1].0, &m[i].0) {\n                    assert(!key_less(members[i - 1].0, members[i as int].0));\n                    return false;\n                }\n",
        to: ""
      }
    ]
  },
  {
    name: "M1: no comma between items, in the specification and in the code",
    edits: [
      { file: ENCODER, from: "    if i > 0 {\n        seq![0x2cu8]\n    } else {\n        Seq::empty()\n    }", to: "    Seq::empty()" },
      {
        file: ENCODER,
        from: "        if i > 0 {\n            out.push(0x2c);\n        }\n        assert(out@ =~= before + separator(i as int));\n        proof {",
        to: "        assert(out@ =~= before + separator(i as int));\n        proof {"
      },
      {
        file: ENCODER,
        from: "        if i > 0 {\n            out.push(0x2c);\n        }\n        assert(out@ =~= before + separator(i as int));\n        out.push(0x22);",
        to: "        assert(out@ =~= before + separator(i as int));\n        out.push(0x22);"
      }
    ]
  }
];

function copyWorkspace(into) {
  mkdirSync(into, { recursive: true });
  cpSync(WORKSPACE, into, { recursive: true, filter: (from) => path.basename(from) !== "target" });
  return into;
}

function applyMutation(copy, mutation) {
  for (const edit of mutation.edits) {
    const file = path.join(copy, edit.file);
    if (edit.create !== undefined) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, edit.create);
      continue;
    }
    const before = readFileSync(file, "utf8");
    if (edit.append !== undefined) {
      writeFileSync(file, before + edit.append);
      continue;
    }
    if (before.split(edit.from).length - 1 !== 1) throw new Error(`self-test "${mutation.name}": ${edit.file} does not hold its text exactly once`);
    writeFileSync(file, before.replace(edit.from, () => edit.to));
  }
}

function guardSelfTest(scratch) {
  GUARD_MUTATIONS.forEach((mutation, index) => {
    const copy = copyWorkspace(path.join(scratch, `guard-${index}`));
    applyMutation(copy, mutation);
    let refusal = null;
    try {
      checkWorkspace(copy);
    } catch (error) {
      if (!(error instanceof GuardRefusal)) throw error;
      refusal = error;
    }
    if (refusal === null) throw new Error(`the source guards did not refuse: ${mutation.name}`);
    if (refusal.rule !== mutation.rule) {
      throw new Error(`the source guards refused "${mutation.name}" for another reason than ${mutation.rule}: ${refusal.message.split("\n")[0]}`);
    }
    rmSync(copy, { recursive: true, force: true });
  });
  return GUARD_MUTATIONS.length;
}

// ---------------------------------------------------------------------------
// cargo and Verus
// ---------------------------------------------------------------------------

/** The environment for cargo: nothing ambient that changes flags, profiles, the solver or the compiler. */
function cargoEnvironment(extra) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(RUSTFLAGS|RUSTDOCFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTC_BOOTSTRAP|__CARGO_DEFAULT_LIB_METADATA)$/.test(name) || /^(CARGO_BUILD_|CARGO_PROFILE_|CARGO_TARGET_|VERUS_)/.test(name)) {
      delete env[name];
    }
  }
  return { ...env, ...extra };
}

function runTests(scratch) {
  const result = spawnSync("cargo", ["test", "--locked", "-p", "sbl-trust-kernel"], {
    cwd: WORKSPACE,
    encoding: "utf8",
    env: cargoEnvironment({ CARGO_TARGET_DIR: path.join(scratch, "test-target") }),
    maxBuffer: 1 << 26
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const summary = /^test result: ok\. (\d+) passed; 0 failed; 0 ignored; 0 measured; 0 filtered out/m.exec(output);
  const named = ["tests::the_encoder_returns_bytes_exactly_for_admitted_trees ... ok", "tests::an_admitted_tree_need_not_be_canonical ... ok"];
  if (result.status !== 0 || !summary || Number(summary[1]) < 1 || !named.every((line) => output.includes(line))) {
    process.stderr.write(output);
    throw new Error(`cargo test of the kernel did not pass (exit ${result.status ?? result.signal})`);
  }
  return Number(summary[1]);
}

/** Every JSON document at the top level of a text, in order. */
function jsonDocuments(text) {
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      if (depth > 0) inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          found.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // Not a document of the checker's; cargo may print braces too.
        }
      }
    }
  }
  return found;
}

/**
 * Makes cargo forget its result for the kernel in a target directory, and
 * nothing else, so the next run checks the kernel again and reuses vstd.
 * `cargo verus` answers a second run on unchanged source from its cache
 * even when the arguments after `--` differ; such a run prints no report,
 * which the callers treat as a failure.
 */
function forgetKernel(targetDirectory) {
  execFileSync("cargo", ["clean", "--locked", "-p", "sbl-trust-kernel"], {
    cwd: WORKSPACE,
    env: cargoEnvironment({ CARGO_TARGET_DIR: targetDirectory }),
    stdio: "ignore"
  });
}

/** The one report for the kernel in a run, required to be clean and complete; throws otherwise. */
function acceptedReport(run, how) {
  const report = run.reports.length === 1 ? run.reports[0] : null;
  const results = report?.["verification-results"];
  if (run.status !== 0 || !report || !results.success || results.errors !== 0 || run.library.some((library) => !library.success || library.errors !== 0)) {
    process.stderr.write(run.stderr);
    throw new Error(`Verus did not check the kernel ${how} (exit ${run.status ?? run.signal}, ${run.reports.length} report(s) for the kernel)`);
  }
  if (report.verus?.version !== PINS.verus.version || report.verus?.commit !== PINS.verus.commit) {
    throw new Error(`the checker that ran names itself ${report.verus?.version} at ${report.verus?.commit}`);
  }
  if (results.verified !== VERIFIED_ITEMS) {
    throw new Error(`Verus verified ${results.verified} items of the kernel; the pin is ${VERIFIED_ITEMS}. An item has left or joined the check: change the pin on purpose.`);
  }
  for (const statement of STATEMENTS) {
    const name = `sbl_trust_kernel::encode::${/fn (\w+)\(/.exec(statement)[1]}`;
    if (!(name in report["func-details"])) throw new Error(`Verus's report does not name ${name}`);
  }
  return report;
}

/**
 * Runs `cargo verus verify` on the kernel in `workspace`. The kernel's
 * result is read from the checker's own JSON report, found by the names of
 * the kernel's functions, never by its place in the output: with
 * verification switched off there is no such report, and a run answered
 * from cargo's cache prints none either.
 */
function runVerus(workspace, verusDirectory, targetDirectory, rlimit) {
  const result = spawnSync(
    "cargo",
    ["verus", "verify", "--locked", "-p", "sbl-trust-kernel", "--", ...(rlimit === null ? [] : ["--rlimit", String(rlimit)]), "--time-expanded", "--output-json"],
    {
      cwd: workspace,
      encoding: "utf8",
      env: cargoEnvironment({ PATH: `${verusDirectory}${path.delimiter}${process.env.PATH}`, CARGO_TARGET_DIR: targetDirectory }),
      maxBuffer: 1 << 28
    }
  );
  const stderr = result.stderr ?? "";
  const documents = jsonDocuments(result.stdout ?? "").filter((document) => document["verification-results"]);
  const ofKernel = (document) => Object.keys(document["func-details"] ?? {}).some((name) => name.startsWith("sbl_trust_kernel::"));
  // On a clean target cargo verus first checks vstd itself; that report
  // names no function of the kernel.
  return {
    status: result.status,
    signal: result.signal,
    stderr,
    reports: documents.filter(ofKernel),
    library: documents.filter((document) => !ofKernel(document)).map((document) => document["verification-results"])
  };
}

function largestFunction(report) {
  const functions = (report["times-ms"]?.smt?.["smt-run-module-times"] ?? []).flatMap((module) => module["function-breakdown"] ?? []);
  return functions.reduce((largest, entry) => (largest === null || entry.rlimit > largest.rlimit ? entry : largest), null);
}

function verify(verusDirectory) {
  if (!existsSync(path.join(verusDirectory, "cargo-verus"))) {
    throw new Error(`no cargo-verus in ${verusDirectory}; run install first`);
  }
  const version = JSON.parse(readFileSync(path.join(verusDirectory, "version.json"), "utf8")).verus;
  if (version.version !== PINS.verus.version || version.commit !== PINS.verus.commit) {
    throw new Error(`this is Verus ${version.version}, and the pin is ${PINS.verus.version}`);
  }
  checkWorkspace(WORKSPACE);

  const scratch = mkdtempSync(path.join(os.tmpdir(), "sbl-trust-kernel-verus-"));
  try {
    const guardsFired = guardSelfTest(scratch);
    const tests = runTests(scratch);

    const target = path.join(scratch, "target");
    const started = Date.now();
    const atDefault = runVerus(WORKSPACE, verusDirectory, target, null);
    acceptedReport(atDefault, "at the default resource limit");
    if (atDefault.library.length !== 1 || atDefault.library[0].verified < 1) {
      throw new Error(`expected vstd to be checked once on a clean target; saw ${atDefault.library.length} report(s) for it`);
    }
    const defaultSeconds = ((Date.now() - started) / 1000).toFixed(1);
    forgetKernel(target);
    const restarted = Date.now();
    const report = acceptedReport(runVerus(WORKSPACE, verusDirectory, target, RLIMIT_FLOOR), `under --rlimit ${RLIMIT_FLOOR}`);
    const floorSeconds = ((Date.now() - restarted) / 1000).toFixed(1);
    const results = report["verification-results"];
    const largest = largestFunction(report);

    // Each of these copies must be refused by Verus itself: a report for
    // the kernel with at least one error. The copies share the target, so
    // vstd is not checked again; each copy has its own path, so cargo
    // cannot answer one from another's result.
    const refused = [];
    VERUS_MUTATIONS.forEach((mutation, index) => {
      const copy = copyWorkspace(path.join(scratch, `verus-${index}`));
      applyMutation(copy, mutation);
      const broken = runVerus(copy, verusDirectory, target, RLIMIT_FLOOR);
      const brokenResults = broken.reports.length === 1 ? broken.reports[0]["verification-results"] : null;
      if (broken.status === 0 || broken.signal !== null || !brokenResults || brokenResults.errors < 1) {
        process.stderr.write(broken.stderr);
        throw new Error(`Verus did not refuse: ${mutation.name}`);
      }
      if (/resource limit/.test(broken.stderr) && !/assertion failed|postcondition not satisfied|precondition not satisfied|invariant not satisfied/.test(broken.stderr)) {
        process.stderr.write(broken.stderr);
        throw new Error(`Verus refused "${mutation.name}" only by running out of its resource limit, which shows nothing`);
      }
      const kinds = [...new Set([...broken.stderr.matchAll(/^error: (.*)$/gm)].map((found) => found[1]))].filter(
        (kind) => !/^could not compile|^aborting due to/.test(kind)
      );
      refused.push(`  ${mutation.name}: ${brokenResults.errors} error(s): ${kinds.join("; ")}`);
      rmSync(copy, { recursive: true, force: true });
    });

    console.log(
      `Source guards hold and refused all ${guardsFired} mutations made to test them. cargo test: ${tests} passed.\n` +
        `Verus ${version.version} on ${report.verus.platform?.os}/${report.verus.platform?.arch}: vstd ${atDefault.library[0].verified} items and ` +
        `${results.verified} items of ${ENCODER} verified, 0 errors, at the default limit of 10, in ${defaultSeconds} s; ` +
        `the kernel again under --rlimit ${RLIMIT_FLOOR}, in ${floorSeconds} s.\n` +
        `Largest function: ${largest?.function} used ${largest?.rlimit} resource units; ${RLIMIT_FLOOR * 3_000_000} are allowed at this limit and 30000000 at the default.\n` +
        `Verus refused all ${refused.length} broken copies:\n${refused.join("\n")}`
    );
    return { verified: results.verified, seconds: Number(defaultSeconds) + Number(floorSeconds), largest, refused };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "install") {
    install(path.resolve(option(rest, "--into")));
    return;
  }
  if (command === "verify") {
    const directory = path.resolve(option(rest, "--verus"));
    if (!statSync(directory).isDirectory()) throw new Error(`${directory} is not a directory`);
    verify(directory);
    return;
  }
  throw new Error("Usage: trust-kernel-verus.mjs install --into <dir> | verify --verus <dir>");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
