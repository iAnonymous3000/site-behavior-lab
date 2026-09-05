import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Four reconcile steps hold issues:write and pick the one canonical issue they
// may rewrite, retitle, reopen or close by running an inline node program over
// every issue in the public tracker. The trust predicate lives only inside
// those programs, so this suite extracts each one from the shipped YAML and
// executes it: two of the four copies carried no author check at all while a
// grep for the marker string passed on every workflow.

const OPENER = "match=$(printf '%s' \"$candidates\" | node -e '\n";

function selectorPrograms(name: string): string[] {
  const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", name), "utf8");
  const programs: string[] = [];
  let from = 0;
  for (;;) {
    const start = workflow.indexOf(OPENER, from);
    if (start === -1) return programs;
    const body = workflow.slice(start + OPENER.length);
    const end = body.search(/\n *'\)\n/);
    assert.notEqual(end, -1, `${name}: an inline selector program must close the quote its opener began`);
    programs.push(body.slice(0, end));
    from = start + OPENER.length + end;
  }
}

type Issue = Record<string, unknown>;

function select(program: string, env: Record<string, string>, issues: Issue[]) {
  const result = spawnSync(process.execPath, ["-e", program], {
    // gh api --paginate --slurp hands the program an array of pages.
    input: JSON.stringify([issues]),
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
  return { status: result.status, selected: result.stdout.trim(), stderr: result.stderr };
}

const ACTIONS_TOKEN = { login: "github-actions[bot]", type: "Bot" };

type Reconciler = {
  file: string;
  // How many selector programs the workflow embeds, and which one this is.
  programs: number;
  index: number;
  marker: string;
  title: string;
  label?: string;
  env: Record<string, string>;
};

const reconcilers: Reconciler[] = [
  {
    file: "update-brave-lists.yml",
    programs: 2,
    index: 0,
    marker: "<!-- site-behavior-lab:brave-list-refresh -->",
    title: "Repair the scheduled Brave Shields list refresh",
    env: {}
  },
  {
    file: "update-brave-lists.yml",
    programs: 2,
    index: 1,
    marker: "<!-- site-behavior-lab:measurement-toolchain-drift -->",
    title: "Update measurement toolchain pins",
    env: {}
  },
  {
    file: "production-health.yml",
    programs: 1,
    index: 0,
    marker: "<!-- site-behavior-lab:production-health -->",
    title: "Repair the production health monitor",
    label: "site-behavior-lab-production-health",
    env: {
      ISSUE_TITLE: "Repair the production health monitor",
      MANAGED_ISSUE_LABEL: "site-behavior-lab-production-health",
      COVERAGE_MARKER_PREFIX: "<!-- site-behavior-lab:production-health-required-lanes: "
    }
  },
  {
    file: "scan-featured.yml",
    programs: 1,
    index: 0,
    marker: "<!-- site-behavior-lab:featured-corpus-refresh:gallery -->",
    title: "Repair the weekly featured corpus refresh (gallery)",
    label: "site-behavior-lab-featured-refresh-gallery",
    env: {
      ISSUE_TITLE: "Repair the weekly featured corpus refresh (gallery)",
      MANAGED_ISSUE_LABEL: "site-behavior-lab-featured-refresh-gallery",
      REFRESH_MARKER: "<!-- site-behavior-lab:featured-corpus-refresh:gallery -->",
      REFRESH_CATALOG: "gallery"
    }
  }
];

for (const reconciler of reconcilers) {
  test(`${reconciler.file} selector ${reconciler.index} acts only on the issue the Actions token filed`, () => {
    const programs = selectorPrograms(reconciler.file);
    assert.equal(programs.length, reconciler.programs, `${reconciler.file} must embed its selector programs`);
    const program = programs[reconciler.index];
    const labels = reconciler.label ? [{ name: reconciler.label }] : [];

    const canonical: Issue = {
      number: 101,
      state: "closed",
      title: reconciler.title,
      body: `${reconciler.marker}\n# Scheduled run\n- Outcome: **completed**`,
      user: ACTIONS_TOKEN,
      labels
    };
    // Every impostor carries the marker, the managed title and the managed
    // label, so only the author check can tell it from the canonical issue.
    const impostors: Issue[] = [
      {
        number: 999,
        state: "open",
        title: reconciler.title,
        body: `look at this ${reconciler.marker} injected`,
        user: { login: "random-stranger", type: "User" },
        labels
      },
      {
        number: 998,
        state: "open",
        title: reconciler.title,
        body: `${reconciler.marker}\nfiled by another app`,
        user: { login: "dependabot[bot]", type: "Bot" },
        labels
      },
      {
        number: 997,
        state: "open",
        title: reconciler.title,
        body: `${reconciler.marker}\na pull request, not an issue`,
        user: ACTIONS_TOKEN,
        pull_request: { url: "https://api.github.com/repos/example/example/pulls/997" },
        labels
      }
    ];

    // The fixture must be selectable at all, or the refusals below would pass
    // for a selector that selects nothing.
    const alone = select(program, reconciler.env, [canonical]);
    assert.equal(alone.status, 0, alone.stderr);
    assert.deepEqual(alone.selected.split("|").slice(0, 2), ["101", "closed"]);

    // An impostor beside the canonical issue must neither be adopted nor make
    // the selection ambiguous: the ambiguity throw fails the step, and on the
    // scheduled reconcilers that turns every run red until someone notices.
    const beside = select(program, reconciler.env, [canonical, ...impostors]);
    assert.equal(beside.status, 0, beside.stderr);
    assert.deepEqual(beside.selected.split("|").slice(0, 2), ["101", "closed"]);

    // With no canonical issue yet, an impostor must not become it: the step
    // would otherwise retitle, rewrite and close a stranger's issue with the
    // repository's own write token.
    const only = select(program, reconciler.env, impostors);
    assert.equal(only.status, 0, only.stderr);
    assert.equal(only.selected, "");
  });
}
