import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Every workflow job runs on one pinned GitHub-hosted image, never a moving
 * `-latest` label.
 *
 * GitHub moves `ubuntu-latest` to Ubuntu 26 starting 2026-10-19. A moving
 * label changes the operating system under every job with no commit here: the
 * required CI gates, the release and promotion jobs, the evidence producers,
 * and the hosted frozen-v1 compatibility scan lane would all start running on
 * a different image, and nothing in the repository would say so.
 * `ubuntu-24.04` is what `ubuntu-latest` resolved to when the pin landed, so
 * pinning changed nothing; moving to a newer image is now a reviewed diff.
 *
 * The check fails closed. A `runs-on` value passes only as the literal pinned
 * image, or as an expression whose every result literal is that image and
 * whose every other operand is a comparison or a named controlled-runner
 * source. A list, a `group:` or `labels:` block, a matrix variable, or any
 * other form fails and names the file and line, so a new shape is reviewed
 * here instead of slipping past a pattern that did not expect it.
 */
const PINNED_HOSTED_RUNNER = "ubuntu-24.04";

/**
 * Expression operands that name a controlled self-hosted runner label, never
 * a GitHub-hosted image. The featured and single-site scan workflows read the
 * operator's `FEATURED_RUNNER_LABEL` variable; the A/A and calibration
 * producers run on the label their own preflight verified.
 */
const CONTROLLED_RUNNER_SOURCES = new Set([
  "vars.FEATURED_RUNNER_LABEL",
  "needs.preflight.outputs.runner_label"
]);

const MOVING_LABEL = /\b(?:ubuntu|windows|macos)-latest\b/;
const workflowDir = path.join(process.cwd(), ".github", "workflows");

/**
 * Comparisons such as `github.event_name == 'workflow_dispatch'` only choose a
 * branch; they never name a runner. Everything left after removing them is a
 * branch result, and each one must be the pinned image or a controlled source.
 */
function expressionOperands(body: string): { unreviewed: string[]; pinnedLiterals: number } {
  const operand = String.raw`(?:'[^']*'|[A-Za-z_][\w.-]*)`;
  const comparison = new RegExp(String.raw`${operand}\s*[!=]=\s*${operand}`, "g");
  const unreviewed: string[] = [];
  let pinnedLiterals = 0;
  for (const token of body.replace(comparison, " ").split(/&&|\|\||[()]/)) {
    const value = token.trim();
    if (value === "") continue;
    if (value === `'${PINNED_HOSTED_RUNNER}'`) {
      pinnedLiterals += 1;
    } else if (!CONTROLLED_RUNNER_SOURCES.has(value)) {
      unreviewed.push(value);
    }
  }
  return { unreviewed, pinnedLiterals };
}

test("every workflow job runs on the pinned hosted image or a named controlled runner, never a moving label", () => {
  const files = readdirSync(workflowDir)
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .sort();
  assert.ok(files.length > 0, "no workflow files were read");

  const problems: string[] = [];
  let plainPins = 0;
  let expressionPins = 0;
  for (const file of files) {
    readFileSync(path.join(workflowDir, file), "utf8")
      .split("\n")
      .forEach((text, index) => {
        const where = `${file}:${index + 1}`;
        if (MOVING_LABEL.test(text)) {
          problems.push(`${where} names a moving runner label: ${text.trim()}`);
        }
        if (!text.includes("runs-on")) return;
        const match = /^\s+runs-on:(.*)$/.exec(text);
        if (!match) {
          problems.push(`${where} mentions runs-on in a form this check does not parse: ${text.trim()}`);
          return;
        }
        const value = match[1].replace(/\s+#.*$/, "").trim();
        if (value === PINNED_HOSTED_RUNNER) {
          plainPins += 1;
          return;
        }
        const expression = /^\$\{\{(.*)\}\}$/.exec(value);
        if (!expression) {
          problems.push(
            `${where} runs-on must be ${PINNED_HOSTED_RUNNER} or a reviewed expression, found: ${value || "a block on the following lines"}`
          );
          return;
        }
        const { unreviewed, pinnedLiterals } = expressionOperands(expression[1]);
        expressionPins += pinnedLiterals;
        for (const operand of unreviewed) {
          problems.push(
            `${where} runs-on expression result is neither '${PINNED_HOSTED_RUNNER}' nor a named controlled runner: ${operand}`
          );
        }
      });
  }

  assert.deepEqual(problems, []);
  assert.ok(plainPins > 0, "no plain runs-on line was examined");
  assert.ok(
    expressionPins > 0,
    "no hosted fallback inside a runs-on expression was examined, so that branch of this check went dead"
  );
});
