import { readFile } from "node:fs/promises";
import { parseCorrectionsLedger, parsedCorrectionsLedgerReportIds, type CorrectionsLedgerParseOptions, type ParsedCorrectionsLedger } from "./corrections-ledger-model";
export * from "./corrections-ledger-model";

/** Read and strictly parse the public append-only corrections ledger. */
export async function readCorrectionsLedger(
  filePath: string,
  options: CorrectionsLedgerParseOptions = {}
): Promise<ParsedCorrectionsLedger> {
  let wire: string;
  try {
    wire = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read corrections ledger ${filePath}: ${(error instanceof Error ? error.message : String(error))}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(wire) as unknown;
  } catch {
    throw new Error(`Corrections ledger ${filePath} is not valid JSON.`);
  }

  try {
    return parseCorrectionsLedger(value, options);
  } catch (error) {
    throw new Error(`Corrections ledger ${filePath} is invalid: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

export async function readCorrectionsLedgerReportIds(
  filePath: string,
  options: CorrectionsLedgerParseOptions = {}
): Promise<ReadonlySet<string>> {
  return parsedCorrectionsLedgerReportIds(await readCorrectionsLedger(filePath, options));
}
