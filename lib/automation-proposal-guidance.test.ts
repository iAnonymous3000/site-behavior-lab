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
      const bodyStart = source.lastIndexOf("printf '%s\\n'", pullRequestCreate);

      assert.notEqual(
        bodyStart,
        -1,
        `${command} must build a reviewable PR body first`
      );
      const body = source.slice(bodyStart, pullRequestCreate);

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
