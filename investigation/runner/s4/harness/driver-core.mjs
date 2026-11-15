// The S4 driver's own bookkeeping, kept apart from run-fixtures.mjs so the harness tests exercise
// this code itself: progress copied out after every step, a deadline on every driver wait, a CDP
// client whose deliberate fire-and-forget triggers wait for nothing, and the rule for which browser
// exits count toward the repeated-crash stop.
import { writeFileSync, cpSync, readFileSync } from "node:fs";

export function createDriverCore({ workDir, outDir, control, waitMs }) {
  let currentStep = "start";

  // A progress line at each step's begin and end, then the run so far copied to the output folder,
  // so a kill by the wall clock still leaves every finished step and names the one that was running.
  function progress(event) {
    writeFileSync(`${workDir}/progress.jsonl`, JSON.stringify({ t: new Date().toISOString(), step: currentStep, event }) + "\n", { flag: "a" });
    cpSync(workDir, outDir, { recursive: true });
  }

  // Every wait of the driver's own has a deadline; a wait past it stops the run by name.
  function withDeadline(promise, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        control.stop("driver-wait-timeout", `${currentStep}: ${label} gave no answer within ${waitMs} ms`);
        reject(new Error(`driver wait timeout: ${label}`));
      }, waitMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // ws is a WebSocket (or a stub with the same onopen, onerror, onmessage, onclose, send, close).
  function cdpClient(ws) {
    let id = 0;
    const pending = new Map();
    const opened = withDeadline(new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }), "CDP socket open");
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      pending.get(msg.id)?.resolve(msg);
      pending.delete(msg.id);
    };
    // A closed socket fails every call still waiting, instead of leaving it pending.
    ws.onclose = () => { for (const p of pending.values()) p.reject(new Error("CDP socket closed")); pending.clear(); };
    const send = (method, params = {}) => withDeadline(new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    }), `CDP ${method}`);
    // For a command designed never to answer (Page.crash): sent, and nothing waits on a reply.
    const fire = (method, params = {}) => {
      try { ws.send(JSON.stringify({ id: ++id, method, params })); } catch {}
    };
    return { opened, send, fire, close: () => ws.close() };
  }

  // After a step: a browser that is gone after a step that did not end it on purpose counts toward
  // repeated-crash; the crash and kill-browser steps end it on purpose and never count, and the next
  // step gets a fresh browser. The driver's own kill of that browser happens before the next step's
  // check, so it never counts either.
  function afterStep(step, browserAlive) {
    const deliberate = step.signal?.kind === "crash" || step.signal?.kind === "kill-browser";
    if (!step.signal && !browserAlive) control.browserExitedUnexpectedly(step.name);
    return { freshBrowserNext: deliberate };
  }

  return {
    progress, withDeadline, cdpClient, afterStep,
    setStep: (name) => { currentStep = name; },
    get step() { return currentStep; }
  };
}

// Take the object at a JSON pointer in an earlier output (read bounded, untrusted, never executed) and
// write it as its own file. Returns { ok } or { ok: false, error }; a failure is recorded, not thrown.
export const DERIVE_INPUT_CAP = 64 * 1024 * 1024;
export function deriveJsonFile({ from, pointer, to, cap = DERIVE_INPUT_CAP }) {
  try {
    const bytes = readFileSync(from);
    if (bytes.length > cap) throw new Error(`input over ${cap} bytes`);
    let value = JSON.parse(bytes.toString("utf8"));
    for (const part of pointer.split("/").slice(1)) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) throw new Error(`pointer ${pointer} not found at ${part}`);
      value = value[part];
    }
    writeFileSync(to, JSON.stringify(value));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}
