import { execFileSync } from "node:child_process";
import path from "node:path";
import { listStaticReportCandidateIds } from "./static-report-files";
import {
  prepareReportPublicationArtifact,
  publishReportPublicationArtifact,
  type ReportPublicationKind,
  type ReportPublicationMode
} from "./report-publication-artifact";
import {
  featuredReportPublicationRequest,
  singleReportPublicationRequest
} from "./report-publication-request";

type Command = "prepare" | "publish";

type Options = {
  command: Command;
  artifactDir: string;
  sourceCommit: string;
  publicationKind: ReportPublicationKind;
  reportMode: ReportPublicationMode;
  expectedReportIds: string[];
};

async function main(): Promise<void> {
  const root = process.cwd();
  const options = parseOptions(process.argv.slice(2));
  const head = git(root, ["rev-parse", "HEAD"]).toLowerCase();
  if (head !== options.sourceCommit) {
    throw new Error(`Checked-out HEAD ${head} does not match publication source ${options.sourceCommit}.`);
  }

  if (options.command === "prepare") {
    assertOnlyReportOutputsChanged(root);
    const currentIds = await listStaticReportCandidateIds(path.join(root, "public", "reports"));
    const baseIds = trackedReportIds(root);
    const newIds = currentIds.filter((id) => !baseIds.has(id));
    if (options.publicationKind === "single") {
      if (options.expectedReportIds.length !== 1 || newIds.length !== 1 || newIds[0] !== options.expectedReportIds[0]) {
        throw new Error(
          `Single acquisition must produce exactly its declared report (found ${newIds.length}, declared ${options.expectedReportIds.length}).`
        );
      }
    } else if (options.expectedReportIds.length > 0) {
      throw new Error("Featured acquisition derives its new-report set; do not supply --expected-report-id.");
    }

    const prepared = await prepareReportPublicationArtifact({
      sourceRoot: root,
      artifactDir: options.artifactDir,
      sourceCommit: options.sourceCommit,
      publicationKind: options.publicationKind,
      reportMode: options.reportMode,
      expectedReportIds: newIds
    });
    console.log(
      `Prepared bounded ${options.publicationKind} publication artifact with ${prepared.reportIds.length} managed report(s), ` +
        `${newIds.length} new report(s), and ${prepared.totalBytes} data byte(s).`
    );
    return;
  }

  assertCleanCheckout(root);
  if (options.expectedReportIds.length > 0) {
    throw new Error("Publisher reads the exact new-report declaration from the artifact; do not supply --expected-report-id.");
  }
  const expectedRequest = options.publicationKind === "single"
    ? singleReportPublicationRequest(process.env)
    : await featuredReportPublicationRequest(root, process.env);
  const published = await publishReportPublicationArtifact({
    checkoutRoot: root,
    artifactDir: options.artifactDir,
    expectedSourceCommit: options.sourceCommit,
    expectedPublicationKind: options.publicationKind,
    expectedReportMode: options.reportMode,
    expectedRequest
  });
  console.log(
    `Validated ${published.artifactReportIds.length} artifact report(s) and copied ${published.newReportIds.length} new managed bundle(s).`
  );
}

function parseOptions(args: string[]): Options {
  let command: Command | null = null;
  let artifactDir = "";
  let sourceCommit = "";
  let publicationKind: ReportPublicationKind | null = null;
  let reportMode: ReportPublicationMode | null = null;
  const expectedReportIds: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--prepare" || argument === "--publish") {
      const next = argument === "--prepare" ? "prepare" : "publish";
      if (command !== null) throw new Error("Specify exactly one of --prepare or --publish.");
      command = next;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    index += 1;
    if (argument === "--artifact-dir") artifactDir = value;
    else if (argument === "--source-commit") sourceCommit = value;
    else if (argument === "--kind") {
      if (value !== "single" && value !== "featured") throw new Error("--kind must be single or featured.");
      publicationKind = value;
    } else if (argument === "--report-mode") {
      if (value !== "v1" && value !== "r2") throw new Error("--report-mode must be v1 or r2.");
      reportMode = value;
    } else if (argument === "--expected-report-id") expectedReportIds.push(value);
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (command === null || !artifactDir || !sourceCommit || publicationKind === null || reportMode === null) {
    throw new Error(
      "Usage: --prepare|--publish --artifact-dir <absolute-path> --source-commit <sha> --kind single|featured --report-mode v1|r2 [--expected-report-id <id>]"
    );
  }
  if (!path.isAbsolute(artifactDir)) throw new Error("--artifact-dir must be absolute.");
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("--source-commit must be a full lowercase Git SHA.");
  const sortedIds = [...new Set(expectedReportIds)].sort();
  if (sortedIds.length !== expectedReportIds.length || sortedIds.some((id, index) => id !== expectedReportIds[index])) {
    throw new Error("--expected-report-id values must be unique and sorted.");
  }
  return { command, artifactDir, sourceCommit, publicationKind, reportMode, expectedReportIds: sortedIds };
}

function assertOnlyReportOutputsChanged(root: string): void {
  const changed = new Set([
    ...gitLines(root, ["diff", "--name-only", "HEAD", "--"]),
    ...gitLines(root, ["ls-files", "--others", "--exclude-standard"])
  ]);
  for (const file of changed) {
    if (file === "public/corpus-stats.json" || file.startsWith("public/reports/")) continue;
    throw new Error(`Acquisition changed non-report path ${file}; refusing publication handoff.`);
  }
}

function assertCleanCheckout(root: string): void {
  const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (status !== "") throw new Error("Trusted publisher checkout is not clean before artifact validation.");
}

function trackedReportIds(root: string): Set<string> {
  const ids = new Set<string>();
  for (const file of gitLines(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", "public/reports"])) {
    const match = /^public\/reports\/([0-9]{8}-[0-9a-f]{32})\.json$/.exec(file);
    if (match) ids.add(match[1]);
  }
  return ids;
}

function gitLines(root: string, args: string[]): string[] {
  const output = git(root, args);
  return output === "" ? [] : output.split("\n").filter(Boolean);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
