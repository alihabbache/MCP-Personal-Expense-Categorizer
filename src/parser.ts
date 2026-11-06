import { createHash } from "node:crypto";
import { parseCsv } from "./csv.js";
import type { ColumnMap, ParseOptions, ParseResult, RawTransaction } from "./types.js";

const MAX_WARNINGS = 10;
const HEADER_SCAN_ROWS = 20;

// Alias lists are in priority order: the first alias found in the header wins.
const ALIASES = {
  date: ["transaction date", "trans date", "date", "posted date", "posting date", "post date", "date posted", "booking date", "value date"],
  description: ["description", "transaction description", "original description", "details", "payee", "memo", "narrative", "merchant", "name", "reference"],
  amount: ["amount", "transaction amount", "amt", "value"],
  debit: ["debit", "debits", "debit amount", "withdrawal", "withdrawals", "money out", "paid out"],
  credit: ["credit", "credits", "credit amount", "deposit", "deposits", "money in", "paid in"],
} as const;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

type Cols = { date: number; description: number; amount: number; debit: number; credit: number };

function findCol(headers: string[], aliases: readonly string[], explicit?: string): number {
  if (explicit !== undefined) return headers.indexOf(normHeader(explicit));
  for (const a of aliases) {
    const i = headers.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
}

function resolveColumns(row: string[], map?: ColumnMap): Cols | null {
  const headers = row.map(normHeader);
  const cols: Cols = {
    date: findCol(headers, ALIASES.date, map?.date),
    description: findCol(headers, ALIASES.description, map?.description),
    amount: findCol(headers, ALIASES.amount, map?.amount),
    debit: findCol(headers, ALIASES.debit, map?.debit),
    credit: findCol(headers, ALIASES.credit, map?.credit),
  };
  const hasMoney = cols.amount >= 0 || cols.debit >= 0 || cols.credit >= 0;
  return cols.date >= 0 && cols.description >= 0 && hasMoney ? cols : null;
}

interface DateParts {
  y: number;
  m: number;
  d: number;
}

type RawDate = { kind: "ymd"; parts: DateParts } | { kind: "numeric"; a: number; b: number; y: number } | { kind: "text"; parts: DateParts };

function validDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

function classifyDate(raw: string): RawDate | null {
  const s = raw.trim().replace(/[T\s]\d{1,2}:\d{2}.*$/, "");
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return { kind: "ymd", parts: { y: +m[1], m: +m[2], d: +m[3] } };
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) return { kind: "numeric", a: +m[1], b: +m[2], y: fullYear(+m[3]) };
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*\.?[-\s,]+(\d{2}|\d{4})$/.exec(s); // 03 Jan 2025, 3-Jan-25
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    if (mo > 0) return { kind: "text", parts: { y: fullYear(+m[3]), m: mo, d: +m[1] } };
  }
  m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/.exec(s); // Jan 3, 2025
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    if (mo > 0) return { kind: "text", parts: { y: fullYear(+m[3]), m: mo, d: +m[2] } };
  }
  return null;
}

function toIso(p: DateParts): string | null {
  if (!validDate(p.y, p.m, p.d)) return null;
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function resolveDate(rd: RawDate | null, fmt: "MDY" | "DMY"): string | null {
  if (!rd) return null;
  if (rd.kind !== "numeric") return toIso(rd.parts);
  return fmt === "MDY" ? toIso({ y: rd.y, m: rd.a, d: rd.b }) : toIso({ y: rd.y, m: rd.b, d: rd.a });
}

/** Parse a money string. Handles currency symbols, (1,234.56), trailing minus, and 1.234,56 style. */
export function parseAmount(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^[-−]/.test(s) || /[-−]$/.test(s) || /^[^\d]*[-−]\s*\d/.test(s);
  let t = s.replace(/[^\d.,]/g, "");
  if (!/\d/.test(t)) return null;
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    t = lastComma > lastDot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const single = t.indexOf(",") === lastComma;
    t = single && /,\d{1,2}$/.test(t) ? t.replace(",", ".") : t.replace(/,/g, "");
  } else if (lastDot >= 0 && t.indexOf(".") !== lastDot) {
    t = t.replace(/\./g, "");
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function parseBankCsv(text: string, options: ParseOptions = {}): ParseResult {
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(msg);
    else if (warnings.length === MAX_WARNINGS) warnings.push("Further warnings suppressed.");
  };

  const { rows, delimiter } = parseCsv(text);
  let headerIdx = -1;
  let cols: Cols | null = null;
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    cols = resolveColumns(rows[i], options.column_map);
    if (cols) {
      headerIdx = i;
      break;
    }
  }
  if (!cols || headerIdx < 0) {
    throw new Error(
      "Could not find a header row with date, description and amount (or debit/credit) columns. " +
        "Pass column_map with the exact header names from the file.",
    );
  }
  const c: Cols = cols;
  const headerRow = rows[headerIdx];
  const useDebitCredit = c.amount < 0 && (c.debit >= 0 || c.credit >= 0);

  const body = rows.slice(headerIdx + 1);
  const cell = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i] : "");

  // Decide the numeric date order from all rows so one ambiguous row does not mislead.
  const classified = body.map((r) => classifyDate(cell(r, c.date)));
  let fmt: "MDY" | "DMY";
  let sawNumeric = false;
  if (options.date_format === "MDY" || options.date_format === "DMY") {
    fmt = options.date_format;
  } else {
    const numeric = classified.filter((d): d is Extract<RawDate, { kind: "numeric" }> => d?.kind === "numeric");
    sawNumeric = numeric.length > 0;
    if (numeric.some((d) => d.a > 12)) fmt = "DMY";
    else if (numeric.some((d) => d.b > 12)) fmt = "MDY";
    else {
      fmt = "MDY";
      if (sawNumeric) warn("Date order is ambiguous (all day/month values <= 12); assumed MM/DD/YYYY. Pass date_format to override.");
    }
  }
  const dateFormat: "ISO" | "MDY" | "DMY" = classified.some((d) => d?.kind === "numeric") ? fmt : "ISO";

  // Parse amounts.
  const parsed: { row: number; date: string; description: string; amount: number }[] = [];
  let skipped = 0;
  body.forEach((r, k) => {
    const rowNo = headerIdx + 2 + k; // 1-based line within the parsed (non-blank) rows
    const date = resolveDate(classified[k], fmt);
    const description = cell(r, c.description).replace(/\s+/g, " ").trim();
    let amount: number | null;
    if (useDebitCredit) {
      const d = parseAmount(cell(r, c.debit));
      const cr = parseAmount(cell(r, c.credit));
      amount = d === null && cr === null ? null : (cr === null ? 0 : Math.abs(cr)) - (d === null ? 0 : Math.abs(d));
    } else {
      amount = parseAmount(cell(r, c.amount));
    }
    if (!date || amount === null || !description) {
      skipped++;
      warn(`Skipped row ${rowNo}: missing or unparseable ${!date ? "date" : !description ? "description" : "amount"}.`);
      return;
    }
    parsed.push({ row: rowNo, date, description, amount });
  });

  // Normalise sign: negative = money out.
  let convention: string;
  if (useDebitCredit) {
    convention = "debit_credit_columns";
  } else if (options.amount_convention === "negative_is_expense") {
    convention = "negative_is_expense";
  } else if (options.amount_convention === "positive_is_expense") {
    convention = "positive_is_expense";
    for (const p of parsed) p.amount = -p.amount;
  } else {
    // Card exports list purchases as positive and payments as the occasional negative; checking exports are the reverse.
    const pos = parsed.filter((p) => p.amount > 0).length;
    const nonZero = parsed.filter((p) => p.amount !== 0).length;
    if (nonZero > 0 && pos / nonZero >= 0.75) {
      convention = "positive_is_expense";
      for (const p of parsed) p.amount = -p.amount;
      warn("Most amounts are positive; assumed a credit-card style export where positive = purchase. Pass amount_convention to override.");
    } else {
      convention = "negative_is_expense";
    }
  }

  // Stable IDs: hash of date|description|amount plus occurrence index for identical rows.
  const seen = new Map<string, number>();
  const transactions: RawTransaction[] = parsed.map((p) => {
    const amount = round2(p.amount);
    const base = `${p.date}|${p.description.toLowerCase()}|${amount.toFixed(2)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const id = createHash("sha1").update(`${base}|${n}`).digest("hex").slice(0, 12);
    return { id, row: p.row, date: p.date, description: p.description, amount };
  });

  const columns: Record<string, string> = {
    date: headerRow[c.date],
    description: headerRow[c.description],
  };
  if (useDebitCredit) {
    if (c.debit >= 0) columns.debit = headerRow[c.debit];
    if (c.credit >= 0) columns.credit = headerRow[c.credit];
  } else {
    columns.amount = headerRow[c.amount];
  }

  return {
    transactions,
    detected: { delimiter, header_row: headerIdx + 1, columns, date_format: dateFormat, amount_convention: convention },
    warnings,
    skipped_rows: skipped,
  };
}
