import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
