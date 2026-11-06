import { lstat, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseBankCsv } from "./parser.js";
import { categorizeAll, loadRuleSet, UNCATEGORIZED } from "./rules.js";
import { EXPORT_HEADER, findRecurring, summarize, toCategorizedCsv } from "./analysis.js";
import type { ParseOptions, ParseResult, Transaction } from "./types.js";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXT = new Set([".csv", ".tsv", ".txt"]);

/** Resolve symlinks for the longest existing prefix of a path (the path itself may not exist yet). */
async function realpathLoose(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return join(await realpathLoose(resolve(p, "..")), basename(p));
  }
}

/** Optional sandbox: EXPENSE_ALLOWED_DIRS is a path-delimiter separated list. Unset means unrestricted. */
async function assertAllowed(realPath: string, what: string): Promise<void> {
  const raw = process.env.EXPENSE_ALLOWED_DIRS;
  if (!raw || !raw.trim()) return;
  const roots = await Promise.all(raw.split(delimiter).filter((d) => d.trim()).map((d) => realpathLoose(resolve(d))));
  const ok = roots.some((root) => {
    const rel = relative(root, realPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!ok) throw new Error(`Refusing ${what} ${realPath}: it is outside the folders allowed by EXPENSE_ALLOWED_DIRS.`);
}

function assertExt(path: string): void {
  if (!ALLOWED_EXT.has(extname(path).toLowerCase())) {
    throw new Error(`Refusing to read ${path}: only .csv, .tsv or .txt files are accepted.`);
  }
}

/** Read a bank export from disk with safety checks (symlink-resolved extension and folder checks, size cap). */
export async function readBankFile(filePath: string): Promise<string> {
  const abs = resolve(filePath);
  assertExt(abs);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new Error(`File not found: ${abs}`);
  }
  // A symlink named x.csv must not expose a file that is not a bank export.
  assertExt(real);
  await assertAllowed(real, "to read");
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`Not a regular file: ${abs}`);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`File is ${(info.size / 1048576).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB.`);
  }
  return readFile(real, "utf8");
}

/** True when the file starts with the header this server writes, i.e. a previous export of ours. */
async function isOurExport(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(EXPORT_HEADER.length + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.toString("utf8", 0, bytesRead).startsWith(EXPORT_HEADER + "\n");
  } finally {
    await fh.close();
  }
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
  const realOut = await realpathLoose(out);
  await assertAllowed(realOut, "to write");
  if (realOut === (await realpathLoose(resolve(filePath)))) throw new Error("output_path must differ from the input file.");

  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(realOut);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing) {
    if (!existing.isFile()) throw new Error(`${out} is not a regular file; refusing to write to it.`);
    if (!overwrite) throw new Error(`${out} already exists. Set overwrite=true to replace it.`);
    if (!(await isOurExport(realOut))) {
      throw new Error(`${out} was not created by this server (it does not start with the export header); refusing to overwrite it.`);
    }
  }

  const { transactions } = await loadAndCategorize(filePath, options, rulesPath);
  try {
    // "wx" fails if the file appeared since the check above, so a new file is never clobbered.
    await writeFile(realOut, toCategorizedCsv(transactions), { encoding: "utf8", flag: existing ? "w" : "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${out} already exists. Set overwrite=true to replace it.`);
    throw e;
  }
  return { output_path: realOut, rows: transactions.length };
}
