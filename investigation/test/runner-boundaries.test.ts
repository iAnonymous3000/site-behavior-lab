import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCaughtBy, holds } from "../../lib/finite-check";
import { RECORDER_6_8_0 } from "../core/recorder-shapes-6-8-0";

/**
 * The S4 runner folder (investigation/runner) holds a local image's Dockerfile, a fixture harness and
 * its fixture pages. Nothing that builds or serves the scanner, the site or the workspace may reach it,
 * the folder may name no real site, and its guard proxy is the fixture run's own: it allows only the
 * driver's loopback origins and is not the scanner's guard (lib/public-scan-proxy.ts), which refuses
 * loopback by design. Each check below is shown to catch a planted case.
 */
const ROOT = process.cwd();
const RUNNER = "investigation/runner";
const HARNESS = `${RUNNER}/s4/harness`;
const SELF = "investigation/test/runner-boundaries.test.ts";

/**
 * The only files outside the runner folder that may name it: the two harness suites in scripts/, which
 * load the harness to test it, and the inventory generator, which reads the runner's lockfile and its
 * Node manifest as data and imports nothing from the folder.
 */
const NAMERS = ["scripts/investigation-runner-controls.test.mjs", "scripts/investigation-runner-driver-core.test.mjs", "scripts/third-party-inventory.mjs"];

/** Every folder that holds code which builds, serves or tests anything, read for a name of the runner folder. */
const CODE_FOLDERS = ["app", "cloudflare", "lib", "scripts", "research", "calibration", "tools", "investigation/core", "investigation/local", "investigation/test"];
const CODE = /\.(?:tsx?|mjs|cjs|jsx?)$/;

type Read = (file: string) => string;
type List = () => readonly string[];
const read: Read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const filesUnder = (folder: string, keep: RegExp = /./): string[] =>
  (readdirSync(path.join(ROOT, folder), { recursive: true, encoding: "utf8" }) as string[])
    .filter((name) => !name.split(path.sep).includes("node_modules") && !name.split(path.sep).includes("target") && keep.test(name))
    .map((name) => `${folder}/${name.split(path.sep).join("/")}`)
    .filter((file) => statSync(path.join(ROOT, file)).isFile())
    .sort();
const codeFiles: List = () => CODE_FOLDERS.flatMap((folder) => filesUnder(folder, CODE));
const runnerFiles: List = () => filesUnder(RUNNER);

const NAMED = "no code outside the runner folder names it, other than its two harness suites and the inventory generator";
const checkNamers = (readFile: Read = read, list: List = codeFiles) => {
  const files = list();
  holds(NAMED, files.some((file) => file.startsWith("lib/")) && files.some((file) => file.startsWith("app/")), () => "the code folders could not be located");
  for (const file of files) {
    if (file === SELF || NAMERS.includes(file)) continue;
    holds(NAMED, !/investigation\/runner|runner\/s4/.test(readFile(file)), () => file);
  }
};

test("no code outside the runner folder names it, other than its harness suites and the inventory generator that reads it as data", async () => {
  checkNamers();
  const plant = (target: string, line: string): Read => (file) => (file === target ? `${line}\n${read(file)}` : read(file));
  await assertCaughtBy("the scanner's guard importing the fixture guard", NAMED, () => checkNamers(plant("lib/public-scan-proxy.ts", 'import { startGuardProxy } from "../investigation/runner/s4/harness/guard-proxy.mjs";')));
  await assertCaughtBy("a page naming the runner", NAMED, () => checkNamers(plant("app/page.tsx", "// see investigation/runner/s4/COMMANDS.md")));
  await assertCaughtBy("a workspace core module reaching the harness", NAMED, () => checkNamers(plant("investigation/core/recorder-shapes-6-8-0.ts", 'export * from "../runner/s4/harness/driver-core.mjs";')));
});

const SELF_CONTAINED = "the harness imports only Node's own modules and its own files";
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;
const checkImports = (readFile: Read = read) => {
  const modules = filesUnder(HARNESS, /\.mjs$/);
  holds(SELF_CONTAINED, modules.length >= 6, () => "the harness modules could not be located");
  for (const file of modules) {
    for (const [, specifier] of readFile(file).matchAll(SPECIFIER)) {
      const inside = specifier.startsWith("./") && path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).startsWith(`${HARNESS}/`);
      holds(SELF_CONTAINED, specifier.startsWith("node:") || inside, () => ({ file, specifier }));
    }
  }
};

test("the harness imports only Node's own modules and its own files, never the scanner's code", async () => {
  checkImports();
  const plant = (line: string): Read => (file) => (file === `${HARNESS}/run-fixtures.mjs` ? `${line}\n${read(file)}` : read(file));
  await assertCaughtBy("the driver importing the scanner", SELF_CONTAINED, () => checkImports(plant('import { scanSite } from "../../../../lib/scanner.ts";')));
  await assertCaughtBy("the driver importing a package", SELF_CONTAINED, () => checkImports(plant('import { chromium } from "playwright-core";')));
  await assertCaughtBy("a relative import that climbs out", SELF_CONTAINED, () => checkImports(plant('import x from "./../../../core/ids.ts";')));
});

/** A host's labels joined at run time, so this file's own text holds no host it lists. */
const dotted = (...labels: readonly string[]) => labels.join(".");
/**
 * The real hosts the runner folder names on purpose, none of them a site a fixture visits: the registry
 * of the scanner's pinned base image, in the command list; and in the second Node's manifest, the
 * Node.js release site its archives and checksum file came from and the raw file host of the pinned
 * release-keys commit that signed them.
 */
const ALLOWED_HOSTS = new Set([dotted("mcr", "microsoft", "com"), dotted("nodejs", "org"), dotted("raw", "githubusercontent", "com")]);
/** Where every runner lockfile entry must come from. */
const REGISTRY = `https://${dotted("registry", "npmjs", "org")}/`;
const HOST = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|gov|edu|dev|app|ai|tv|me|us|uk|de|fr|jp|cn|ru|xyz|info|biz|site|online|cloud|page)\b/gi;
const IP = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/** Loopback and the three documentation ranges (RFC 5737), which route nowhere. */
const harmlessIp = (ip: string) => /^127\./.test(ip) || /^192\.0\.2\./.test(ip) || /^198\.51\.100\./.test(ip) || /^203\.0\.113\./.test(ip);
/**
 * The three second-level names RFC 2606 reserves for examples, and every name under them: the S3
 * fixture hosts and the scan URL the S5c fixture runs visit, which the scanner's own proxy hands to
 * the fixture origin inside a container with no network. A name that only ends like one of them is
 * not one of them.
 */
const RESERVED_NAMES = [dotted("example", "com"), dotted("example", "org"), dotted("example", "net")];
const reservedName = (host: string) => RESERVED_NAMES.some((name) => host === name || host.endsWith(`.${name}`));
/**
 * The one address outside those ranges the folder may name, and the one file that may name it: the S5c
 * stub resolver's answer. The scanner's guard refuses a target whose address it does not read as
 * public before it connects, so the stub must answer with one that does; the container has no network,
 * so it is never contacted. lib/investigation-seam-setting.test.ts gives the same answer.
 */
const STUB_FILE = `${RUNNER}/s5/fixture/stub-resolver.mjs`;
const STUB_ADDRESS = dotted("93", "184", "216", "34");

const NO_SITE = "the runner folder names no real site: its lockfiles resolve only from the registry, and every other file names only listed hosts, reserved names and harmless addresses";
const checkRunnerHosts = (readFile: Read = read, list: List = runnerFiles) => {
  const files = list();
  holds(NO_SITE, files.some((file) => /package-lock-[0-9.]+\.json$/.test(file)) && files.some((file) => file.endsWith(".html")), () => "the runner files could not be located");
  for (const file of files) {
    const text = readFile(file);
    if (/package-lock-[0-9.]+\.json$/.test(file)) {
      const lock = JSON.parse(text) as { packages: Record<string, { resolved?: string }> };
      for (const [entry, value] of Object.entries(lock.packages)) {
        if (entry !== "") holds(NO_SITE, typeof value.resolved === "string" && value.resolved.startsWith(REGISTRY), () => ({ file, entry }));
      }
      continue;
    }
    // In code, a host can only be said in a string, a template or a comment; a chain of property reads
    // is code, not a host. Pages, the Dockerfile and the command list are read whole.
    const said = file.endsWith(".mjs") ? [...text.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g)].map(([part]) => part).join("\n") : text;
    for (const [host] of said.matchAll(HOST)) holds(NO_SITE, ALLOWED_HOSTS.has(host.toLowerCase()) || reservedName(host.toLowerCase()), () => ({ file, host }));
    for (const [ip] of text.matchAll(IP)) holds(NO_SITE, harmlessIp(ip) || (ip === STUB_ADDRESS && file === STUB_FILE), () => ({ file, ip }));
  }
};

test("the runner folder names no real site, by its lockfiles' sources and by the shape of a host or an address", async () => {
  checkRunnerHosts();
  const plant = (target: string, line: string): Read => (file) => (file === target ? `${line}\n${read(file)}` : read(file));
  await assertCaughtBy("a fixture page loading from a real host", NO_SITE, () => checkRunnerHosts(plant(`${HARNESS}/fixtures/control.html`, `<script src="https://${dotted("cdn", "lamplighter", "net")}/a.js"></script>`)));
  await assertCaughtBy("a real host in the driver's strings", NO_SITE, () => checkRunnerHosts(plant(`${HARNESS}/run-fixtures.mjs`, `const MIRROR = "https://${dotted("cdn", "lamplighter", "net")}/";`)));
  await assertCaughtBy("a fixture page reaching a routable address", NO_SITE, () => checkRunnerHosts(plant(`${HARNESS}/fixtures/egress-probe.html`, '<img src="http://8.8.4.4/x.png">')));
  const lock = `${RUNNER}/s4/package-lock-6.8.0.json`;
  const moved: Read = (file) => (file === lock ? read(file).replace(REGISTRY, `https://${dotted("mirror", "lamplighter", "net")}/`) : read(file));
  await assertCaughtBy("a lockfile entry resolved from another host", NO_SITE, () => checkRunnerHosts(moved));
  // The reserved names and the stub's address (the Q-1 ruling), each admitted narrowly.
  const page = `${RUNNER}/s5/fixture/pages/planted.html`;
  const withFile = (file: string, text: string): [Read, List] => [(name) => (name === file ? text : read(name)), () => [...runnerFiles(), file]];
  const stubText = `export const STUB_ADDRESS = "${STUB_ADDRESS}";\n`;
  checkRunnerHosts(...withFile(STUB_FILE, stubText));
  checkRunnerHosts(...withFile(page, `<img src="http://static.${RESERVED_NAMES[0]}/x.png"><script src="http://cdn.${RESERVED_NAMES[1]}/a.js"></script>`));
  await assertCaughtBy("a real host in an s5 file", NO_SITE, () => checkRunnerHosts(...withFile(page, `<script src="https://${dotted("cdn", "lamplighter", "net")}/a.js"></script>`)));
  await assertCaughtBy("a routable address other than the stub's in the stub's file", NO_SITE, () => checkRunnerHosts(...withFile(STUB_FILE, `${stubText}export const OTHER = "8.8.4.4";\n`)));
  await assertCaughtBy("the stub's address in a fixture page", NO_SITE, () => checkRunnerHosts(...withFile(page, `<img src="http://${STUB_ADDRESS}/x.png">`)));
  await assertCaughtBy("a name that only ends like a reserved one", NO_SITE, () => checkRunnerHosts(...withFile(page, `<img src="http://www.not${RESERVED_NAMES[0]}/x.png">`)));
});

const OWN_GUARD = "the fixture guard lets through only the driver's loopback origins, and is not the scanner's guard";
const checkGuard = (readFile: Read = read) => {
  const driver = readFile(`${HARNESS}/run-fixtures.mjs`);
  const guard = readFile(`${HARNESS}/guard-proxy.mjs`);
  const origins = [...driver.matchAll(/^const (ORIGIN|CDP_ORIGIN) = `([^`]+)`;$/gm)].map(([, name, value]) => ({ name, value }));
  holds(OWN_GUARD, origins.length === 2 && origins.every(({ value }) => /^http:\/\/127\.0\.0\.1:\$\{[A-Z_]+\}$/.test(value)), () => origins);
  const calls = [...driver.matchAll(/startGuardProxy\(\{([\s\S]*?)\}\);/g)].map(([, body]) => body);
  holds(OWN_GUARD, calls.length === 2 && calls.every((body) => /allowedOrigins: \[ORIGIN, CDP_ORIGIN\]/.test(body)), () => calls);
  holds(OWN_GUARD, /^export function startGuardProxy\b/m.test(guard) && !/startPublicScanProxy|public-scan-proxy\.ts"/.test(guard.replace(/^\/\/.*$/gm, "")), () => "guard-proxy.mjs");
  holds(OWN_GUARD, /lib\/public-scan-proxy\.ts\) refuses loopback/.test(guard), () => "guard-proxy.mjs no longer says it is not the scanner's guard");
};

test("the fixture guard lets through only the driver's loopback origins, and says it is not the scanner's guard", async () => {
  checkGuard();
  const edit = (target: string, find: string, replace: string): Read => (file) => (file === target ? read(file).replace(find, replace) : read(file));
  await assertCaughtBy("a fixture origin off loopback", OWN_GUARD, () => checkGuard(edit(`${HARNESS}/run-fixtures.mjs`, "const ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;", "const ORIGIN = `http://10.0.0.8:${FIXTURE_PORT}`;")));
  await assertCaughtBy("a third origin let through", OWN_GUARD, () => checkGuard(edit(`${HARNESS}/run-fixtures.mjs`, "allowedOrigins: [ORIGIN, CDP_ORIGIN]", "allowedOrigins: [ORIGIN, CDP_ORIGIN, process.env.EXTRA]")));
  await assertCaughtBy("the guard's statement removed", OWN_GUARD, () => checkGuard(edit(`${HARNESS}/guard-proxy.mjs`, "(lib/public-scan-proxy.ts) refuses loopback", "refuses nothing")));
});

// ---------------------------------------------------------------------------------------------------
// The S5c runner (investigation/runner/s5). It may import the scanner and the core modules it reads
// events and recorder outputs with, as transpiled into its image, and the base image's S4 guard; the
// S4 harness rule above stays as it is (G-5). The list below is exact: an import added or dropped
// anywhere in the folder fails it. The four tests after it need no container (tests 13 to 16).
// ---------------------------------------------------------------------------------------------------

const S5 = `${RUNNER}/s5`;
const S5_CODE = /\.(?:mjs|cjs)$/;
/** Every specifier from outside the folder, by the file that names it. Relative imports inside the folder and node: built-ins are not listed. */
const S5_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  [`${S5}/entry-production.mjs`]: [
    "/opt/harness/guard-proxy.mjs",
    "/opt/scanner/dist/investigation/core/recorder-shapes-6-8-0.js",
    "/opt/scanner/dist/investigation/core/recorder-shapes.js",
    "/opt/scanner/dist/lib/domain-utils.js",
    "/opt/scanner/dist/lib/scanner.js"
  ],
  [`${S5}/fixture/entry-fixture.mjs`]: [
    "/opt/harness/guard-proxy.mjs",
    "/opt/scanner/dist/investigation/core/case-events.js",
    "/opt/scanner/dist/investigation/core/case-runner.js",
    "/opt/scanner/dist/investigation/core/recorder-shapes-6-8-0.js",
    "/opt/scanner/dist/investigation/core/recorder-shapes.js",
    "/opt/scanner/dist/lib/domain-utils.js",
    "/opt/scanner/dist/lib/scanner.js"
  ],
  // The hand-run container test script reads stored recorder outputs with the host's compiled core.
  [`${S5}/run-container-tests.mjs`]: [
    "../../../.investigation-test-dist/investigation/core/recorder-shapes-6-8-0.js",
    "../../../.investigation-test-dist/investigation/core/recorder-shapes.js"
  ]
};
const S5_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

const S5_BOUNDED = "the S5c runner imports exactly its listed modules from outside its folder, and nothing outside it imports the runner";
const checkS5Imports = (readFile: Read = read, list: List = () => filesUnder(S5, S5_CODE)) => {
  const files = list();
  holds(S5_BOUNDED, files.includes(`${S5}/runner/core.mjs`) && files.includes(`${S5}/fixture/entry-fixture.mjs`) && files.includes(`${S5}/entry-production.mjs`), () => "the runner's modules could not be located");
  const named: Record<string, string[]> = {};
  for (const file of files) {
    for (const [, specifier] of readFile(file).matchAll(S5_SPECIFIER)) {
      if (specifier.startsWith("node:")) continue;
      const inside = specifier.startsWith("./") || specifier.startsWith("../") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).startsWith(`${S5}/`) : false;
      if (inside) continue;
      (named[file] ??= []).push(specifier);
    }
  }
  const sorted = (value: Readonly<Record<string, readonly string[]>>) => JSON.stringify(Object.keys(value).sort().map((file) => [file, [...value[file]].sort()]));
  holds(S5_BOUNDED, sorted(named) === sorted(S5_IMPORTS), () => named);
};

test("the S5c runner imports exactly what its rule lists, and the S4 harness rule is unchanged (G-5, test 14)", async () => {
  checkS5Imports();
  const plant = (target: string, line: string): Read => (file) => (file === target ? `${line}\n${read(file)}` : read(file));
  await assertCaughtBy("the runner importing a package", S5_BOUNDED, () => checkS5Imports(plant(`${S5}/runner/core.mjs`, 'import { chromium } from "playwright-core";')));
  await assertCaughtBy("the runner reaching the S4 harness by a relative path", S5_BOUNDED, () => checkS5Imports(plant(`${S5}/runner/labels.mjs`, 'import { startFixtureServer } from "../../s4/harness/fixture-server.mjs";')));
  await assertCaughtBy("the runner requiring another core module", S5_BOUNDED, () => checkS5Imports(plant(`${S5}/runner/core.mjs`, 'const ids = require("/opt/scanner/dist/investigation/core/ids.js");')));
  await assertCaughtBy("a listed import dropped", S5_BOUNDED, () => checkS5Imports((file) => (file === `${S5}/fixture/entry-fixture.mjs` ? read(file).replace('require("/opt/scanner/dist/investigation/core/case-runner.js")', "{}") : read(file))));
});

/** Every runner module the production entry reaches through relative imports, the entry included. */
function productionGraph(readFile: Read): string[] {
  const reached = new Set<string>();
  const todo = [`${S5}/entry-production.mjs`];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const [, specifier] of readFile(file).matchAll(S5_SPECIFIER)) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) todo.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
    }
  }
  return [...reached].sort();
}

const PRODUCTION_CLEAN = "the production entry and every runner module it reaches name no test option of the scanner and nothing of the stand-in or the fixture";
const checkProductionEntry = (readFile: Read = read) => {
  const graph = productionGraph(readFile);
  holds(PRODUCTION_CLEAN, graph.includes(`${S5}/runner/core.mjs`) && graph.includes(`${S5}/runner/handler-client.mjs`), () => graph);
  for (const file of graph) {
    holds(PRODUCTION_CLEAN, !file.startsWith(`${S5}/fixture/`), () => file);
    const text = readFile(file);
    holds(PRODUCTION_CLEAN, !/ForTests/.test(text), () => ({ file, names: "a ForTests option" }));
    holds(PRODUCTION_CLEAN, !/stand-?in|standin|fixture/i.test(text.replace(/^\s*\/\/.*$/gm, "")), () => ({ file, names: "the stand-in or the fixture" }));
  }
};

test("the production entry's import graph and text name no ForTests option and no stand-in (G-6, answer 4, test 15)", async () => {
  checkProductionEntry();
  const plant = (target: string, line: string): Read => (file) => (file === target ? `${line}\n${read(file)}` : read(file));
  await assertCaughtBy("the shared core setting a test option", PRODUCTION_CLEAN, () => checkProductionEntry(plant(`${S5}/runner/core.mjs`, "const o = { connectProxyUpstreamForTests: () => null };")));
  await assertCaughtBy("the shared core importing the stand-in", PRODUCTION_CLEAN, () => checkProductionEntry(plant(`${S5}/runner/core.mjs`, 'import { startStandIn } from "../fixture/standin.mjs";')));
  await assertCaughtBy("the production entry naming the stand-in", PRODUCTION_CLEAN, () => checkProductionEntry(plant(`${S5}/entry-production.mjs`, 'const where = "the standin";')));
  const fixture = read(`${S5}/fixture/entry-fixture.mjs`);
  assert.match(fixture, /connectProxyUpstreamForTests/, "the fixture entry no longer sets the scanner's test option, so the check above holds nothing apart");
});

const PINNED_DOMAINS = "the domains table, the recorder release this image checks and the core's 6.8.0 pin name one release";
const checkDomainsTable = (readFile: Read = read) => {
  const table = JSON.parse(readFile(`${S5}/recorder-domains-6.8.0.json`)) as { release: string; label: string; commands: Record<string, unknown> };
  const dockerfile = readFile(`${S5}/Dockerfile`);
  const pinned = /^ARG RECORDER_RELEASE=([0-9.]+)$/m.exec(dockerfile)?.[1] ?? null;
  const base = /^FROM sbl-s4-runner:([0-9.]+)@sha256:[0-9a-f]{64}$/m.exec(dockerfile)?.[1] ?? null;
  holds(PINNED_DOMAINS, table.release === RECORDER_6_8_0.release && pinned === table.release && base === table.release, () => ({ table: table.release, dockerfile: pinned, base, core: RECORDER_6_8_0.release }));
  holds(PINNED_DOMAINS, table.label === "observed on the control fixture, not measured in this visit", () => table.label);
  holds(PINNED_DOMAINS, JSON.stringify(Object.keys(table.commands).sort()) === JSON.stringify(["inspect-web-page", "observe-web-execution"]), () => Object.keys(table.commands));
};

test("the domains table moves with the recorder release, or a test fails (answer 3, test 13)", async () => {
  checkDomainsTable();
  const edit = (target: string, find: string, replace: string): Read => (file) => (file === target ? read(file).replace(find, replace) : read(file));
  await assertCaughtBy("the image's recorder release moved and the table not", PINNED_DOMAINS, () => checkDomainsTable(edit(`${S5}/Dockerfile`, "ARG RECORDER_RELEASE=6.8.0", "ARG RECORDER_RELEASE=6.9.0")));
  await assertCaughtBy("the base moved to another release and the table not", PINNED_DOMAINS, () => checkDomainsTable(edit(`${S5}/Dockerfile`, "FROM sbl-s4-runner:6.8.0@", "FROM sbl-s4-runner:6.9.0@")));
  await assertCaughtBy("the table's label changed", PINNED_DOMAINS, () => checkDomainsTable(edit(`${S5}/recorder-domains-6.8.0.json`, "not measured in this visit", "measured")));
});

const TWO_COMMANDS = "the runner's recorder commands are exactly observe-web-execution and inspect-web-page, and only recorder.mjs starts the recorder";
const checkCommands = (readFile: Read = read) => {
  const recorder = readFile(`${S5}/runner/recorder.mjs`);
  const clis = [...recorder.matchAll(/\bcli: "([a-z-]+)"/g)].map(([, cli]) => cli).sort();
  holds(TWO_COMMANDS, JSON.stringify(clis) === JSON.stringify(["inspect-web-page", "observe-web-execution"]), () => clis);
  const keys = /export const COMMANDS = Object\.freeze\(\{\s*observe: Object\.freeze\(\{ cli: "observe-web-execution"[\s\S]*?\}\),\s*inspect: Object\.freeze\(\{ cli: "inspect-web-page"[\s\S]*?\}\)\s*\}\);/.test(recorder);
  holds(TWO_COMMANDS, keys, () => "COMMANDS is not exactly observe and inspect");
  holds(TWO_COMMANDS, /Object\.hasOwn\(COMMANDS, name\) \? COMMANDS\[name\] : null/.test(recorder), () => "runRecorder no longer refuses a name outside COMMANDS");
  for (const file of filesUnder(S5, S5_CODE)) {
    if (file === `${S5}/runner/recorder.mjs`) continue;
    const text = readFile(file);
    holds(TWO_COMMANDS, !/rea-agents\/scripts\/rea\.mjs|\/opt\/rea-node\/bin\/node/.test(text), () => ({ file, starts: "the recorder" }));
    holds(TWO_COMMANDS, !/"(?:observe|inspect|trace|capture)-web-[a-z-]+"/.test(text.replace(/^\s*\/\/.*$/gm, "")), () => ({ file, names: "a recorder command" }));
  }
};

test("the runner's command list is exactly observe and inspect (answer 5, test 16)", async () => {
  checkCommands();
  const edit = (target: string, find: string, replace: string): Read => (file) => (file === target ? read(file).replace(find, replace) : read(file));
  await assertCaughtBy("a third command added", TWO_COMMANDS, () => checkCommands(edit(`${S5}/runner/recorder.mjs`, '  inspect: Object.freeze({ cli: "inspect-web-page"', '  trace: Object.freeze({ cli: "trace-web-module-imports", args: () => [] }),\n  inspect: Object.freeze({ cli: "inspect-web-page"')));
  await assertCaughtBy("the refusal of other names dropped", TWO_COMMANDS, () => checkCommands(edit(`${S5}/runner/recorder.mjs`, "Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null", "COMMANDS[name] ?? { cli: name, args: () => [] }")));
  await assertCaughtBy("another module starting the recorder", TWO_COMMANDS, () => checkCommands(edit(`${S5}/runner/core.mjs`, 'import { createHash } from "node:crypto";', 'import { createHash } from "node:crypto";\nconst cli = "/opt/rea/node_modules/rea-agents/scripts/rea.mjs";')));
});

const SAME_FIELDS = "the stand-in takes each runner call with exactly the fields the case object takes";
const checkStandInFields = (readFile: Read = read) => {
  const host = /const RUNNER_CALL_FIELDS: [^=]+= (\{[^\n]+\});/.exec(readFile("investigation/core/case-host.ts"))?.[1] ?? null;
  const standIn = /export const CALL_FIELDS = Object\.freeze\(\{\s*"runner-token": (\[[^\]]*\]),\s*runner: (\[[^\]]*\]),\s*"runner-object": (\[[^\]]*\])\s*\}\);/.exec(readFile(`${S5}/fixture/standin.mjs`));
  holds(SAME_FIELDS, host !== null && standIn !== null, () => "the field lists could not be located");
  const hostFields = JSON.parse((host as string).replace(/([{,]\s*)([a-z]+):/g, '$1"$2":')) as Record<string, string[]>;
  const [, token, runner, object] = standIn as RegExpExecArray;
  holds(SAME_FIELDS, JSON.stringify(hostFields["runner-token"]) === token.replace(/\s/g, "") && JSON.stringify(hostFields.runner) === runner.replace(/\s/g, ""), () => ({ host: hostFields, standIn: [token, runner] }));
  holds(SAME_FIELDS, object.replace(/\s/g, "") === JSON.stringify(["body", "call", "caseId", "token"]), () => object);
};

test("the stand-in's call fields are the case object's own, and O-2's for runner-object", async () => {
  checkStandInFields();
  const edit = (target: string, find: string, replace: string): Read => (file) => (file === target ? read(file).replace(find, replace) : read(file));
  await assertCaughtBy("the stand-in taking an actor beside the token", SAME_FIELDS, () => checkStandInFields(edit(`${S5}/fixture/standin.mjs`, 'runner: ["call", "caseId", "event", "token", "viewedHead"]', 'runner: ["actor", "call", "caseId", "event", "token", "viewedHead"]')));
  await assertCaughtBy("the case object changing a call and the stand-in not", SAME_FIELDS, () => checkStandInFields(edit("investigation/core/case-host.ts", '"runner-token": ["attemptId", "call", "caseId"]', '"runner-token": ["attemptId", "call", "caseId", "slot"]')));
});

type Reference = { name: string; text: string; length: number; sha256: string };
type ReferenceSet = { minChars: number; references: Reference[] };
type Found = { method: string; reference: string; excess: number } | null;
type Identify = (text: string, references: ReferenceSet) => Found;
type LabelsModule = { CONTAINMENT_MAX_EXCESS: number; identify: Identify; labelScripts: (observe: unknown, context: unknown) => { counts: Record<string, number>; rows: Array<{ label: string; method: string | null; excess: number | null }> } };

/** The runner's labels module, loaded from the working root so a mutant copy there is the one tested. */
const loadLabels = (): LabelsModule => require(path.join(ROOT, `${S5}/runner/labels.mjs`)) as LabelsModule;

const BOUNDED_CONTAINMENT = "an empty-URL script is the scanner's by containment only when it holds at most 1,024 characters beyond the reference (L-1)";
const PLANTED_TEXT = Array.from({ length: 40 }, (_, i) => `function planted${i}(a, b) { return a + b * ${i}; }`).join("\n");
const PLANTED: ReferenceSet = {
  minChars: 40,
  references: [{ name: "init:planted", text: PLANTED_TEXT, length: PLANTED_TEXT.length, sha256: createHash("sha256").update(PLANTED_TEXT, "utf8").digest("hex") }]
};
const otherCode = (n: number) => "x".repeat(n);
const checkBoundedContainment = (identify: Identify, labelScripts: LabelsModule["labelScripts"], bound: number) => {
  holds(BOUNDED_CONTAINMENT, bound === 1024, () => ({ bound }));
  const same = identify(PLANTED_TEXT, PLANTED);
  holds(BOUNDED_CONTAINMENT, same?.method === "sha256" && same.excess === 0, () => same);
  const wrapped = `(${PLANTED_TEXT})(1, 2)`;
  const small = identify(wrapped, PLANTED);
  holds(BOUNDED_CONTAINMENT, small?.method === "containment" && small.excess === wrapped.length - PLANTED_TEXT.length, () => small);
  const atBound = identify(PLANTED_TEXT + otherCode(1024), PLANTED);
  holds(BOUNDED_CONTAINMENT, atBound?.method === "containment" && atBound.excess === 1024, () => atBound);
  holds(BOUNDED_CONTAINMENT, identify(PLANTED_TEXT + otherCode(1025), PLANTED) === null, () => "1,025 characters beyond the reference were labelled the scanner's");
  // The ruled case: a copy of a reference followed by 10,000 characters of other code.
  holds(BOUNDED_CONTAINMENT, identify(PLANTED_TEXT + otherCode(10_000), PLANTED) === null, () => "a reference plus 10,000 characters was labelled the scanner's");
  const table = labelScripts({ normalized_result: { sources: [{ script_id: "1", url: "", source: { text: PLANTED_TEXT + otherCode(10_000) } }, { script_id: "2", url: "", source: { text: wrapped } }] } }, { references: PLANTED, siteKey: "fixture.test", partyKey: (host: string) => host });
  holds(BOUNDED_CONTAINMENT, table.rows.length === 2 && table.rows[0].label === "origin-not-identified" && table.rows[0].method === null && table.rows[0].excess === null, () => table.rows[0]);
  holds(BOUNDED_CONTAINMENT, table.rows[1].label === "scanner" && table.rows[1].excess === wrapped.length - PLANTED_TEXT.length, () => table.rows[1]);
};

test("a reference plus 10,000 characters of other code is origin not identified; a small wrapper stays the scanner's, with its excess (L-1)", async () => {
  const labels = loadLabels();
  checkBoundedContainment(labels.identify, labels.labelScripts, labels.CONTAINMENT_MAX_EXCESS);
  const unbounded: Identify = (text, references) => {
    const found = labels.identify(text, references);
    if (found) return found;
    const holder = references.references.find((r) => r.length >= references.minChars && text.includes(r.text));
    return holder ? { method: "containment", reference: holder.name, excess: text.length - holder.length } : null;
  };
  await assertCaughtBy("containment with the bound removed", BOUNDED_CONTAINMENT, () => checkBoundedContainment(unbounded, labels.labelScripts, labels.CONTAINMENT_MAX_EXCESS));
  await assertCaughtBy("the bound raised", BOUNDED_CONTAINMENT, () => checkBoundedContainment(labels.identify, labels.labelScripts, 4096));
});
