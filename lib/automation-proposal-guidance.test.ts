import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const workflowsDirectory = path.join(process.cwd(), ".github", "workflows");
const expectedProposalWorkflows = [
  "anchor-transparency-log.yml",
  "archive-aa-study.yml",
  "archive-hosted-evidence.yml",
  "archive-release-receipt.yml",
  "calibration-study.yml",
  "scan-featured.yml",
  "scan.yml",
  "update-brave-lists.yml"
];

test("every automation proposal explains both CI lanes and the manual approval", () => {
  const proposalWorkflows = readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .filter((name) =>
      readFileSync(path.join(workflowsDirectory, name), "utf8").includes(
        "gh pr create"
      )
    )
    .sort();

  assert.deepEqual(
    proposalWorkflows,
    expectedProposalWorkflows,
    "every workflow that starts opening automation PRs must join this operator-guidance contract"
  );

  for (const workflowName of proposalWorkflows) {
    const source = readFileSync(
      path.join(workflowsDirectory, workflowName),
      "utf8"
    );
    assert.doesNotMatch(
      source,
      /Pushes made with GITHUB_TOKEN never fire|GITHUB_TOKEN(?: pushes|-created PRs)[^\n]*(?:do not|does not|never)[^\n]*trigger/,
      `${workflowName} must not contradict the live-proven parked push-event run`
    );
    const pullRequestCreates = [...source.matchAll(/\bgh pr create\b/g)].map(
      (match) => match.index
    );

    assert.ok(pullRequestCreates.length > 0);
    for (const [index, pullRequestCreate] of pullRequestCreates.entries()) {
      const command = `${workflowName} gh pr create #${index + 1}`;
      // Scope to the step that opens the pull request, then keep only the
      // QUOTED payloads inside it.
      //
      // `lastIndexOf("printf '%s\\n'")` assumed a body is built by exactly one
      // printf. A step that appends a conditional section afterwards -- the
      // Brave-list refresh now appends the measurement identity a maintainer
      // must declare -- moved the anchor past the guidance and failed a
      // workflow whose body still carried every required sentence.
      //
      // Widening to "everything from the first printf onward" would have been
      // the opposite mistake: the slice would then include the shell between
      // the printfs, and a required sentence could be satisfied by a COMMENT
      // that never reaches the pull request. Only quoted strings count, so the
      // guard still asserts what a reviewer will actually read.
      const stepStart = source.lastIndexOf("\n      - name:", pullRequestCreate);
      const stepSource = source.slice(stepStart === -1 ? 0 : stepStart, pullRequestCreate);

      assert.notEqual(
        stepSource.indexOf("printf '%s\\n'"),
        -1,
        `${command} must build a reviewable PR body first`
      );
      const body = [...stepSource.matchAll(/(['"])((?:\\.|(?!\1)[\s\S])*)\1/g)]
        .map((match) => match[2])
        .join("\n");

      assert.match(
        body,
        /Before merge, manually approve this automation proposal's parked push-event CI run; the pull request's required checks remain expected until that run executes\./,
        `${command} must name the required manual approval`
      );
      assert.match(
        body,
        /separate non-promoting [^\n]*workflow_dispatch[^\n]* validates this (?:exact )?proposal branch but does not satisfy (?:the pull request's|the pull request ruleset) required checks; trusted [^\n]*main[^\n]* CI runs only after merge\./,
        `${command} must distinguish proposal validation from required PR checks and post-merge main CI`
      );
      assert.doesNotMatch(
        body,
        /fresh main-branch CI run/,
        `${command} must not imply that pre-merge required checks come from main`
      );
    }
  }
});

test("the transparency anchor extends one proposal branch and never discards a pending proof", () => {
  // A per-run branch re-proposed the same head every week while the first
  // proposal sat unmerged (PRs #238 and #243 both anchored entry 1026). A
  // rebuilt fixed branch would instead throw away the earlier, tighter proof.
  const workflowName = "anchor-transparency-log.yml";
  const source = readFileSync(path.join(workflowsDirectory, workflowName), "utf8");
  const indexOfOrFail = (text: string, marker: string): number => {
    const index = text.indexOf(marker);
    assert.notEqual(index, -1, `${workflowName} no longer contains ${JSON.stringify(marker)}; update this guard`);
    return index;
  };
  const step = (name: string): string => {
    const start = indexOfOrFail(source, `\n      - name: ${name}\n`);
    const next = source.indexOf("\n      - name:", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };

  assert.match(
    source,
    /\n    permissions:\n      contents: write\n      pull-requests: write\n(?:      #[^\n]*\n)*      actions: write\n    env:\n      PROPOSAL_BRANCH: automation\/transparency-anchor\n/
  );
  assert.doesNotMatch(source, /transparency-anchor-\$\{\{/, "the proposal branch must not be per run");
  assert.doesNotMatch(source, /--force-with-lease(?!=)/, "a bare lease rejects re-runs and protects nothing");

  const carry = step("Carry the pending anchor proposal");
  assert.match(carry, /\n        id: pending\n/);
  assert.match(carry, /git ls-remote --exit-code --heads origin "refs\/heads\/\$\{PROPOSAL_BRANCH\}" > \/dev\/null \|\| listed=\$\?/);
  assert.match(carry, /if \[\[ "\$listed" -eq 2 \]\]; then[\s\S]*?exit 0\n\s+fi\n\s+if \[\[ "\$listed" -ne 0 \]\]; then[\s\S]*?exit 1/);
  assert.match(carry, /remote_oid="\$\(git rev-parse FETCH_HEAD\)"/);
  assert.match(carry, /git show "\$\{remote_oid\}:public\/transparency-log\.json" > "\$carry_log"/);

  const submit = step("Submit the current head to the calendars");
  assert.ok(
    indexOfOrFail(source, "\n      - name: Carry the pending anchor proposal\n") <
      indexOfOrFail(source, "\n      - name: Submit the current head to the calendars\n"),
    "the pending proposal must be carried before anything is submitted"
  );
  assert.match(submit, /CARRY_LOG: \$\{\{ steps\.pending\.outputs\.carry_log \}\}/);
  assert.match(submit, /carry_args=\(--carry-anchors "\$CARRY_LOG"\)/);
  assert.match(submit, /npm run transparency:log:anchor -- "\$\{carry_args\[@\]\}"/);

  const publish = step("Publish reviewed anchor proposal");
  // A run that pushed the branch and then failed to open the pull request
  // re-runs with nothing to append. The CLI's carried_pending output is what
  // keeps this step reachable then; `changed` alone read the quiet working
  // tree as nothing to propose and finished green with no pull request.
  assert.match(
    publish,
    /\n        if: steps\.anchor\.outputs\.changed == '1' \|\| steps\.anchor\.outputs\.carried_pending == 'true'\n/
  );
  assert.match(publish, /\n          CHANGED: \$\{\{ steps\.anchor\.outputs\.changed \}\}\n/);
  // The lease is the commit the anchors were carried from, never a re-fetch:
  // a branch that moved in between holds proofs this run never saw.
  assert.match(publish, /REMOTE_OID: \$\{\{ steps\.pending\.outputs\.remote_oid \}\}/);
  assert.doesNotMatch(publish, /git fetch/);
  assert.match(
    publish,
    /if \[\[ -n "\$REMOTE_OID" \]\]; then\n\s+git push \\\n\s+--force-with-lease="refs\/heads\/\$\{PROPOSAL_BRANCH\}:\$\{REMOTE_OID\}" \\\n\s+origin "HEAD:refs\/heads\/\$\{PROPOSAL_BRANCH\}"\n\s+else\n\s+git push origin "HEAD:refs\/heads\/\$\{PROPOSAL_BRANCH\}"\n\s+fi/
  );
  assert.match(publish, /gh pr list \\[\s\S]*?--state open \\[\s\S]*?--head "\$PROPOSAL_BRANCH" \\[\s\S]*?select\(\.isCrossRepository \| not\)/);
  assert.match(publish, /gh pr edit "\$pr_number"/);
  assert.ok(indexOfOrFail(publish, "git push") < indexOfOrFail(publish, "gh pr list"));
  assert.ok(indexOfOrFail(publish, "gh pr list") < indexOfOrFail(publish, "gh pr edit"));
  assert.ok(indexOfOrFail(publish, "gh pr edit") < indexOfOrFail(publish, "gh pr create"));
});

test("an anchor proposal pushed without its pull request is opened on the re-run, and a refused one is red", () => {
  // Run N pushed automation/transparency-anchor and then failed to open the
  // pull request. The re-run checks out the same head, carries the branch,
  // appends nothing, and reaches this step through carried_pending with
  // CHANGED=0. The step itself is executed here against fake gh and git.
  const source = readFileSync(path.join(workflowsDirectory, "anchor-transparency-log.yml"), "utf8");
  const start = source.indexOf("\n      - name: Publish reviewed anchor proposal\n");
  assert.notEqual(start, -1);
  const next = source.indexOf("\n      - name:", start + 1);
  const stepSource = source.slice(start, next === -1 ? undefined : next);
  const runAt = stepSource.indexOf("run: |");
  assert.notEqual(runAt, -1, "the publish step must be a literal shell block");
  const script = stepSource
    .slice(runAt + "run: |".length)
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
    .join("\n");
  assert.doesNotMatch(script, /\$\{\{/, "the executed block must not depend on expression expansion");

  const root = mkdtempSync(path.join(tmpdir(), "anchor-publish-step-"));
  try {
    const fakeBin = path.join(root, "bin");
    mkdirSync(fakeBin);
    writeFileSync(
      path.join(fakeBin, "gh"),
      [
        "#!/usr/bin/env bash",
        'printf \'gh %s\\n\' "$*" >> "$FAKE_LOG"',
        'case "$1 $2" in',
        '  "pr list") if [[ -n "${FAKE_OPEN_PR:-}" ]]; then printf \'%s\\n\' "$FAKE_OPEN_PR"; fi ;;',
        '  "pr create")',
        '    if [[ -n "${FAKE_CREATE_ERROR:-}" ]]; then printf \'%s\\n\' "$FAKE_CREATE_ERROR" >&2; exit 1; fi',
        '    echo "https://github.com/iAnonymous3000/site-behavior-lab/pull/8" ;;',
        '  "pr edit" | "workflow run") ;;',
        "  *) exit 64 ;;",
        "esac",
        ""
      ].join("\n")
    );
    // A recovery run has nothing to commit or push, so any git call at all
    // fails it; the normal path opts in with FAKE_GIT_STATUS=0.
    writeFileSync(
      path.join(fakeBin, "git"),
      ["#!/usr/bin/env bash", 'printf \'git %s\\n\' "$*" >> "$FAKE_LOG"', 'exit "${FAKE_GIT_STATUS:-97}"', ""].join("\n")
    );
    chmodSync(path.join(fakeBin, "gh"), 0o755);
    chmodSync(path.join(fakeBin, "git"), 0o755);

    let runs = 0;
    const runStep = (overrides: Readonly<Record<string, string>>) => {
      runs += 1;
      const log = path.join(root, `calls-${runs}.log`);
      writeFileSync(log, "");
      const result = spawnSync("bash", ["-c", script], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          FAKE_LOG: log,
          CHANGED: "0",
          REMOTE_OID: "e".repeat(40),
          PROPOSAL_BRANCH: "automation/transparency-anchor",
          BASE_BRANCH: "main",
          GH_TOKEN: "unused",
          GITHUB_REPOSITORY: "iAnonymous3000/site-behavior-lab",
          GITHUB_SERVER_URL: "https://github.com",
          RUNNER_TEMP: root,
          ...overrides
        }
      });
      return { ...result, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
    };

    // (a) Recovery with no open pull request: open it and dispatch branch
    // validation, touching no git at all.
    const recovered = runStep({});
    assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
    assert.equal(recovered.calls.filter((call) => call.startsWith("git ")).length, 0, recovered.calls.join("\n"));
    assert.equal(recovered.calls.length, 3, recovered.calls.join("\n"));
    assert.match(recovered.calls[0], /^gh pr list /);
    assert.match(recovered.calls[1], /^gh pr create .*--head automation\/transparency-anchor /);
    assert.match(recovered.calls[2], /^gh workflow run ci\.yml --ref automation\/transparency-anchor /);

    // (b) Recovery with the pull request already open: nothing new was pushed,
    // so neither the pull request nor its validation is touched again.
    const alreadyOpen = runStep({ FAKE_OPEN_PR: "7" });
    assert.equal(alreadyOpen.status, 0, alreadyOpen.stderr);
    assert.equal(alreadyOpen.calls.length, 1, alreadyOpen.calls.join("\n"));
    assert.match(alreadyOpen.calls[0], /^gh pr list /);

    // (c) The repository refuses Actions-created pull requests: validation
    // still starts, but the run is red, like every sibling proposal workflow.
    const refused = runStep({
      FAKE_CREATE_ERROR: "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)"
    });
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stdout, /::error title=Open the proposal manually::/);
    assert.ok(refused.calls.some((call) => call.startsWith("gh workflow run ci.yml ")), refused.calls.join("\n"));

    // (d) Any other creation failure is red before dispatching anything.
    const failed = runStep({ FAKE_CREATE_ERROR: "HTTP 502: Bad Gateway" });
    assert.equal(failed.status, 1, failed.stdout);
    assert.ok(!failed.calls.some((call) => call.startsWith("gh workflow run ")), failed.calls.join("\n"));

    // (e) A run that appended anchors still commits and pushes under the lease
    // before proposing, exactly as before.
    const appended = runStep({ CHANGED: "1", FAKE_GIT_STATUS: "0" });
    assert.equal(appended.status, 0, appended.stderr);
    const push = appended.calls.findIndex((call) => call.startsWith("git push --force-with-lease="));
    const list = appended.calls.findIndex((call) => call.startsWith("gh pr list "));
    assert.notEqual(push, -1, appended.calls.join("\n"));
    assert.ok(push < list, appended.calls.join("\n"));
    assert.match(appended.calls[appended.calls.length - 1], /^gh workflow run ci\.yml /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
