// P2 (D-1, spike (i) ruling): the DevTools port of the scanner's own browser, read from outside the
// scanner, from the browser process's own argv in this one-attempt container. Nothing under lib/ is
// changed. It rests on the scanner launching its browser with --remote-debugging-port (lib/scanner.ts,
// the shared browser's launch); if that flag goes, no port is found, the recorder never starts, and the
// container test for the P2 route fails (test 11).
//
// The browser process is the headless shell whose argv carries no --type= switch; renderers and
// helpers carry one. Exactly one must exist. The profile's DevToolsActivePort file is a cross-check:
// a file that exists and names another port withholds the port.
import { readdirSync, readFileSync } from "node:fs";

const SHELL = "/chrome-headless-shell";
const portIn = (args) => {
  const flag = args.find((a) => /^--remote-debugging-port=\d+$/.test(a));
  return flag ? Number(flag.split("=")[1]) : null;
};

/** Every process of the headless shell in this container: pid and whether it is the browser process. */
export function shellProcesses() {
  const found = [];
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    let argv;
    try { argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
    if (argv.length === 0 || !argv[0].endsWith(SHELL)) continue;
    found.push({ pid: Number(pid), browser: !argv.some((a) => a.startsWith("--type=")), argv });
  }
  return found;
}

export function findPortP2() {
  const record = { method: "P2", browserProcesses: 0, argvPort: null, activePortFile: null, fileCheck: null, port: null, error: null };
  try {
    const browsers = shellProcesses().filter((p) => p.browser);
    record.browserProcesses = browsers.length;
    if (browsers.length !== 1) { record.error = `expected one browser process, saw ${browsers.length}`; return record; }
    const { argv } = browsers[0];
    record.argvPort = portIn(argv);
    const profile = argv.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length) ?? null;
    if (profile) {
      try {
        const first = readFileSync(`${profile}/DevToolsActivePort`, "utf8").split("\n")[0];
        record.activePortFile = /^\d+$/.test(first) ? Number(first) : "unreadable";
      } catch (e) { record.activePortFile = `absent: ${String(e?.code ?? "error").slice(0, 20)}`; }
    }
    record.fileCheck = typeof record.activePortFile !== "number" ? "absent-or-unreadable" : record.activePortFile === record.argvPort ? "agrees" : "disagrees";
    if (record.argvPort === null) record.error = "no --remote-debugging-port in the browser's argv";
    else if (record.fileCheck === "disagrees") record.error = "the DevToolsActivePort file names another port";
    else record.port = record.argvPort;
  } catch (error) {
    record.error = String(error?.message ?? error).slice(0, 300);
  }
  return record;
}

/** The page's target id, through one short page session that is detached before this returns. */
export async function pageTargetId(page, waitMs = 10_000) {
  const within = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: no answer within ${waitMs} ms`)), waitMs))]);
  const session = await within(page.context().newCDPSession(page), "newCDPSession");
  try {
    const info = await within(session.send("Target.getTargetInfo"), "Target.getTargetInfo");
    return info?.targetInfo?.targetId ?? null;
  } finally {
    await within(session.detach(), "detach").catch(() => undefined);
  }
}
