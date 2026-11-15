import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { assertCaughtBy, holds } from "../../lib/finite-check";

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

/** The only files outside the runner folder that may name it: the two harness suites in scripts/. */
const NAMERS = ["scripts/investigation-runner-controls.test.mjs", "scripts/investigation-runner-driver-core.test.mjs"];

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

const NAMED = "no code outside the runner folder names it, other than its two harness suites";
const checkNamers = (readFile: Read = read, list: List = codeFiles) => {
  const files = list();
  holds(NAMED, files.some((file) => file.startsWith("lib/")) && files.some((file) => file.startsWith("app/")), () => "the code folders could not be located");
  for (const file of files) {
    if (file === SELF || NAMERS.includes(file)) continue;
    holds(NAMED, !/investigation\/runner|runner\/s4/.test(readFile(file)), () => file);
  }
};

test("no code outside the runner folder names it, so nothing that builds or serves anything can reach it", async () => {
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
/** The one real host the runner folder names on purpose: the registry of the scanner's pinned base image, in the command list. */
const ALLOWED_HOSTS = new Set([dotted("mcr", "microsoft", "com")]);
/** Where every runner lockfile entry must come from. */
const REGISTRY = `https://${dotted("registry", "npmjs", "org")}/`;
const HOST = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|gov|edu|dev|app|ai|tv|me|us|uk|de|fr|jp|cn|ru|xyz|info|biz|site|online|cloud|page)\b/gi;
const IP = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/** Loopback and the three documentation ranges (RFC 5737), which route nowhere. */
const harmlessIp = (ip: string) => /^127\./.test(ip) || /^192\.0\.2\./.test(ip) || /^198\.51\.100\./.test(ip) || /^203\.0\.113\./.test(ip);

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
    for (const [host] of said.matchAll(HOST)) holds(NO_SITE, ALLOWED_HOSTS.has(host.toLowerCase()), () => ({ file, host }));
    for (const [ip] of text.matchAll(IP)) holds(NO_SITE, harmlessIp(ip), () => ({ file, ip }));
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
