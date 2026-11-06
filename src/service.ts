import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseBankCsv } from "./parser.js";
import { categorizeAll, loadRuleSet, UNCATEGORIZED } from "./rules.js";
import { findRecurring, summarize, toCategorizedCsv } from "./analysis.js";
import type { ParseOptions, ParseResult, Transaction } from "./types.js";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXT = new Set([".csv", ".tsv", ".txt"]);

/** Read a bank export from disk with basic safety checks (extension allow-list, size cap). */
export async function readBankFile(filePath: string): Promise<string> {
  const abs = resolve(filePath);
  if (!ALLOWED_EXT.has(extname(abs).toLowerCase())) {
    throw new Error(`Refusing to read ${abs}: only .csv, .tsv or .txt files are accepted.`);
  }
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new Error(`File not found: ${abs}`);
  }
  if (!info.isFile()) throw new Error(`Not a regular file: ${abs}`);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`File is ${(info.size / 1048576).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB.`);
  }
  return readFile(abs, "utf8");
}

export interface Loaded {
  parse: ParseResult;
  transactions: Transaction[];
}

export async function loadAndCategorize(filePath: string, options: ParseOptions, rulesPath?: string): Promise<Loaded> {
  const parse = parseBankCsv(await readBankFile(filePath), options);
  const ruleSet = await loadRuleSet(rulesPath);
  return { parse, transactions: categorizeAll(parse.transactions, ruleSet) };
}

export async function categorizeReport(
  filePath: string,
  options: ParseOptions,
  opts: { only_uncategorized?: boolean; limit?: number } = {},
  rulesPath?: string,
) {
  const { parse, transactions } = await loadAndCategorize(filePath, options, rulesPath);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const uncategorized = transactions.filter((t) => t.category === UNCATEGORIZED);
  const list = opts.only_uncategorized ? uncategorized : transactions;
  const counts = new Map<string, number>();
  for (const t of transactions) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  return {
    detected: parse.detected,
    warnings: parse.warnings,
    skipped_rows: parse.skipped_rows,
    total_transactions: transactions.length,
    categorized: transactions.length - uncategorized.length,
    uncategorized: uncategorized.length,
    category_counts: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
    transactions: list.slice(0, limit),
    truncated: list.length > limit,
  };
}

export async function summaryReport(filePath: string, options: ParseOptions, rulesPath?: string) {
  const { parse, transactions } = await loadAndCategorize(filePath, options, rulesPath);
  return { warnings: parse.warnings, ...summarize(transactions) };
}

export async function recurringReport(filePath: string, options: ParseOptions, rulesPath?: string) {
  const { parse, transactions } = await loadAndCategorize(filePath, options, rulesPath);
  const recurring = findRecurring(transactions);
  return {
    warnings: parse.warnings,
    recurring,
    estimated_monthly_total: Math.round(
      recurring.reduce((s, r) => s + (r.cadence === "monthly" ? r.typical_amount : r.cadence === "weekly" ? (r.typical_amount * 52) / 12 : r.typical_amount / 12), 0) * 100,
    ) / 100,
  };
}

export async function exportCsv(
  filePath: string,
  outputPath: string,
  options: ParseOptions,
  overwrite = false,
  rulesPath?: string,
): Promise<{ output_path: string; rows: number }> {
  const out = resolve(outputPath);
  if (extname(out).toLowerCase() !== ".csv") throw new Error("output_path must end in .csv");
  if (out === resolve(filePath)) throw new Error("output_path must differ from the input file.");
  const { transactions } = await loadAndCategorize(filePath, options, rulesPath);
  try {
    await writeFile(out, toCategorizedCsv(transactions), { encoding: "utf8", flag: overwrite ? "w" : "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${out} already exists. Set overwrite=true to replace it.`);
    throw e;
  }
  return { output_path: out, rows: transactions.length };
}
