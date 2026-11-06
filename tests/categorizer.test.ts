import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, csvField } from "../src/csv.js";
import { parseAmount, parseBankCsv } from "../src/parser.js";
import { categorize, categorizeAll, extractMerchant, loadRuleSet, normalize } from "../src/rules.js";
import { findRecurring, summarize, toCategorizedCsv } from "../src/analysis.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, "..", "..", "test-data");
const NO_USER_RULES = join(DATA, "does-not-exist.json");
const read = (name: string) => readFileSync(join(DATA, name), "utf8");

async function pipeline(file: string) {
  const parsed = parseBankCsv(read(file));
  const rs = await loadRuleSet(NO_USER_RULES);
  return { parsed, txs: categorizeAll(parsed.transactions, rs), rs };
}

test("csv: quotes, escaped quotes, CRLF, BOM, semicolons", () => {
  assert.deepEqual(parseCsv('a,"b ""q"", c",d\r\n1,2,3\r\n').rows, [["a", 'b "q", c', "d"], ["1", "2", "3"]]);
  assert.equal(parseCsv("\ufeffx;y\n1;2").delimiter, ";");
  assert.deepEqual(parseCsv("x;y\n1;2").rows[1], ["1", "2"]);
});

test("csv: formula injection is neutralised on export", () => {
  assert.equal(csvField("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvField("a,b"), '"a,b"');
});

test("amount: currency, parentheses, European and trailing-minus formats", () => {
  assert.equal(parseAmount("$1,234.56"), 1234.56);
  assert.equal(parseAmount("($19.99)"), -19.99);
  assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("45,60"), 45.6);
  assert.equal(parseAmount("12.50-"), -12.5);
  assert.equal(parseAmount("-4.50"), -4.5);
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount(""), null);
});

test("parser: US checking export with extra columns", () => {
  const { parsed } = { parsed: parseBankCsv(read("sample-checking-us.csv")) };
  assert.equal(parsed.transactions.length, 43);
  assert.equal(parsed.skipped_rows, 0);
  assert.equal(parsed.detected.amount_convention, "negative_is_expense");
  assert.equal(parsed.detected.columns.date, "Transaction Date"); // preferred over Post Date
  assert.equal(parsed.transactions[0].date, "2025-01-02");
  assert.equal(parsed.transactions[0].amount, 3200);
});

test("parser: EU semicolon file with debit/credit columns and DMY dates", () => {
  const p = parseBankCsv(read("sample-bank-eu-debit-credit.csv"));
  assert.equal(p.detected.delimiter, ";");
  assert.equal(p.detected.amount_convention, "debit_credit_columns");
  assert.equal(p.detected.date_format, "DMY");
  assert.equal(p.transactions[0].date, "2025-01-15");
  assert.equal(p.transactions[0].amount, -45.6);
  assert.equal(p.transactions[1].amount, 2500);
  assert.equal(p.transactions[4].amount, -1234.56);
});

test("parser: all-positive credit card export is flipped so purchases are negative", () => {
  const p = parseBankCsv(read("sample-credit-card-positive.csv"));
  assert.equal(p.detected.amount_convention, "positive_is_expense");
  assert.equal(p.transactions[0].amount, -32.1);
  assert.equal(p.transactions[3].amount, 500); // payment reduces the balance owed
  assert.ok(p.warnings.some((w) => w.includes("credit-card")));
});

test("parser: preamble, BOM, bad rows skipped with warnings", () => {
  const p = parseBankCsv(read("sample-edge-cases.csv"));
  assert.equal(p.detected.header_row, 3);
  assert.equal(p.transactions.length, 3);
  assert.equal(p.skipped_rows, 3);
  assert.equal(p.transactions[0].description, 'COFFEE "THE BEAN", MAIN ST');
  assert.equal(p.transactions[2].amount, -19.99);
});

test("parser: ambiguous dates warn and honour override", () => {
  const auto = parseBankCsv(read("sample-ambiguous-dates.csv"));
  assert.equal(auto.transactions[0].date, "2025-03-04");
  assert.ok(auto.warnings.some((w) => w.includes("ambiguous")));
  const dmy = parseBankCsv(read("sample-ambiguous-dates.csv"), { date_format: "DMY" });
  assert.equal(dmy.transactions[0].date, "2025-04-03");
});

test("parser: unknown headers fail clearly; column_map rescues them", () => {
  const csv = "When,What,HowMuch\n2025-01-01,COFFEE,-3.00\n";
  assert.throws(() => parseBankCsv(csv), /column_map/);
  const p = parseBankCsv(csv, { column_map: { date: "When", description: "What", amount: "HowMuch" } });
  assert.equal(p.transactions.length, 1);
});

test("parser: IDs are stable and unique for identical rows", () => {
  const csv = "Date,Description,Amount\n2025-01-01,COFFEE,-3.00\n2025-01-01,COFFEE,-3.00\n";
  const a = parseBankCsv(csv).transactions;
  const b = parseBankCsv(csv).transactions;
  assert.notEqual(a[0].id, a[1].id);
  assert.deepEqual(a.map((t) => t.id), b.map((t) => t.id));
});

test("rules: normalisation and merchant extraction", () => {
  assert.equal(normalize("PG&E  WEB-ONLINE"), "pg e web online");
  assert.equal(extractMerchant("WHOLE FOODS MKT #10234 AUSTIN TX"), "Whole Foods Mkt");
  assert.equal(extractMerchant("SQ *BLUE BOTTLE COFFEE"), "Blue Bottle Coffee");
});

test("categorize: known merchants land in the right category", async () => {
  const { txs } = await pipeline("sample-checking-us.csv");
  const cat = (needle: string) => txs.find((t) => t.description.includes(needle))!;
  assert.equal(cat("WHOLE FOODS").category, "Groceries");
  assert.equal(cat("NETFLIX").category, "Subscriptions");
  assert.equal(cat("RENT -").category, "Housing");
  assert.equal(cat("PAYROLL").kind, "income");
  assert.equal(cat("TRANSFER TO SAVINGS").kind, "transfer");
  assert.equal(cat("UBER TRIP").category, "Transport");
  assert.equal(cat("PG&E").category, "Utilities");
  assert.equal(cat("DOORDASH").category, "Dining");
  assert.equal(cat("MYSTERY").category, "Uncategorized");
  assert.equal(cat("MYSTERY").source, "none");
});

test("categorize: whole-phrase matching avoids substring false positives", async () => {
  const rs = await loadRuleSet(NO_USER_RULES);
  const tx = { id: "x", row: 1, date: "2025-01-01", description: "ABPS CORPORATE TRAINING", amount: -10 }; // contains 'bp' only as substring
  assert.equal(categorize(tx, rs).category, "Uncategorized");
});

test("categorize: longest keyword wins, user rule overrides default", async () => {
  const dir = join(DATA, "..", "build", "tmp-rules.json");
  const { writeFile, rm } = await import("node:fs/promises");
  await writeFile(dir, JSON.stringify({ rules: [{ category: "Coffee Habit", keyword: "starbucks" }] }));
  try {
    const rs = await loadRuleSet(dir);
    const tx = { id: "x", row: 1, date: "2025-01-01", description: "STARBUCKS STORE 1", amount: -5 };
    const r = categorize(tx, rs);
    assert.equal(r.category, "Coffee Habit");
    assert.equal(r.source, "user");
    const uber = categorize({ ...tx, description: "UBER EATS ORDER" }, rs);
    assert.equal(uber.category, "Dining"); // 'uber eats' (9) beats 'uber' (4)
  } finally {
    await rm(dir, { force: true });
  }
});

test("summary: transfers excluded, refund nets against spend, month split", async () => {
  const { txs } = await pipeline("sample-checking-us.csv");
  const s = summarize(txs);
  assert.deepEqual(s.period, { from: "2025-01-02", to: "2025-03-28" });
  assert.equal(s.totals.income, 9600);
  assert.equal(s.totals.transfers_excluded, 900);
  assert.equal(s.by_month.length, 3);
  assert.equal(s.uncategorized.count, 2);
  const shopping = s.by_category.find((c) => c.category === "Shopping")!;
  assert.equal(shopping.total, 54.99); // 54.99 + 23.47 - 23.47 refund
  const pct = s.by_category.reduce((a, c) => a + c.share_pct, 0);
  assert.ok(Math.abs(pct - 100) < 0.1);
  assert.equal(s.by_category[0].category, "Housing");
});

test("recurring: finds monthly subscriptions, ignores one-offs", async () => {
  const { txs } = await pipeline("sample-checking-us.csv");
  const rec = findRecurring(txs);
  const names = rec.map((r) => r.merchant);
  assert.ok(names.includes("Netflix Com"), names.join(","));
  assert.ok(names.includes("Spotify Usa"));
  assert.ok(names.includes("Planet Fitness Monthly"));
  assert.ok(!names.some((n) => n.startsWith("Delta")));
  const nf = rec.find((r) => r.merchant === "Netflix Com")!;
  assert.equal(nf.cadence, "monthly");
  assert.equal(nf.typical_amount, 15.49);
  assert.equal(nf.next_expected, "2025-04-03");
});

test("export: CSV is escaped and re-parseable", async () => {
  const { txs } = await pipeline("sample-edge-cases.csv");
  const out = toCategorizedCsv(txs);
  assert.ok(out.startsWith("id,date,description,merchant,amount,category,kind,source\n"));
  assert.ok(out.includes("'=HYPERLINK"), "formula text must be prefixed with a quote");
  const back = parseCsv(out).rows;
  assert.equal(back.length, txs.length + 1);
  assert.equal(back[1][2], 'COFFEE "THE BEAN", MAIN ST');
});
