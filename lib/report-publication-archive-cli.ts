import path from "node:path";
import {
  extractReportPublicationArchive,
  validateGithubReportPublicationArtifactMetadata
} from "./report-publication-archive";

type Options = {
  command: "validate-metadata" | "extract";
  metadataPath: string;
  artifactId: string;
  artifactName: string;
  runId: string;
  sourceCommit: string;
  digest: string;
  archivePath?: string;
  artifactDir?: string;
};

async function main(): Promise<void> {
  const options = parseReportPublicationArchiveOptions(process.argv.slice(2));
  const metadata = await validateGithubReportPublicationArtifactMetadata({
    metadataPath: options.metadataPath,
    expectedArtifactId: options.artifactId,
    expectedArtifactName: options.artifactName,
    expectedRunId: options.runId,
    expectedSourceCommit: options.sourceCommit,
    expectedDigest: options.digest
  });
  if (options.command === "validate-metadata") {
    console.log(`Validated exact GitHub artifact metadata (${metadata.archiveBytes} archive bytes).`);
    return;
  }
  const extracted = await extractReportPublicationArchive({
    archivePath: options.archivePath!,
    destinationDir: options.artifactDir!,
    expectedDigest: options.digest,
    expectedArchiveBytes: metadata.archiveBytes
  });
  console.log(
    `Safely extracted ${extracted.entries} publication entries ` +
      `(${extracted.compressedBytes} compressed, ${extracted.uncompressedBytes} uncompressed bytes).`
  );
}

export function parseReportPublicationArchiveOptions(args: string[]): Options {
  let command: Options["command"] | null = null;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--validate-metadata" || argument === "--extract") {
      if (command !== null) throw new Error("Specify exactly one archive command.");
      command = argument === "--extract" ? "extract" : "validate-metadata";
      continue;
    }
    if (![
      "--metadata",
      "--artifact-id",
      "--artifact-name",
      "--run-id",
      "--source-commit",
      "--digest",
      "--archive",
      "--artifact-dir"
    ].includes(argument)) {
      throw new Error(`Unknown archive argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    if (values.has(argument)) throw new Error(`Duplicate archive argument: ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  if (command === null) throw new Error("Specify --validate-metadata or --extract.");
  const required = ["--metadata", "--artifact-id", "--artifact-name", "--run-id", "--source-commit", "--digest"];
  for (const name of required) if (!values.has(name)) throw new Error(`Missing required archive argument: ${name}.`);
  if (command === "extract") {
    for (const name of ["--archive", "--artifact-dir"]) {
      if (!values.has(name)) throw new Error(`Missing required archive argument: ${name}.`);
    }
  } else if (values.has("--archive") || values.has("--artifact-dir")) {
    throw new Error("Archive paths are valid only with --extract.");
  }
  const absolute = ["--metadata", ...(command === "extract" ? ["--archive", "--artifact-dir"] : [])];
  for (const name of absolute) if (!path.isAbsolute(values.get(name)!)) throw new Error(`${name} must be absolute.`);
  return {
    command,
    metadataPath: values.get("--metadata")!,
    artifactId: values.get("--artifact-id")!,
    artifactName: values.get("--artifact-name")!,
    runId: values.get("--run-id")!,
    sourceCommit: values.get("--source-commit")!,
    digest: values.get("--digest")!,
    ...(command === "extract"
      ? { archivePath: values.get("--archive")!, artifactDir: values.get("--artifact-dir")! }
      : {})
  };
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
