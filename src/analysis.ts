import { csvField } from "./csv.js";
import type { Transaction } from "./types.js";

export interface CategoryTotal {
  category: string;
  total: number;
  count: number;
  share_pct: number;
}

export interface Summary {
  period: { from: string; to: string } | null;
  totals: { expenses: number; income: number; net: number; transfers_excluded: number };
  by_category: CategoryTotal[];
  by_month: { month: string; expenses: number; income: number }[];
  uncategorized: { count: number; total: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Spending summary. Transfers are excluded from income/expense totals so paying a card is not double counted. */
export function summarize(txs: Transaction[]): Summary {
  let expenses = 0;
  let income = 0;
  let transfers = 0;
  const cat = new Map<string, { total: number; count: number }>();
  const months = new Map<string, { expenses: number; income: number }>();
  let unCount = 0;
  let unTotal = 0;

  for (const t of txs) {
    if (t.kind === "transfer") {
      transfers += Math.abs(t.amount);
      continue;
    }
    const month = t.date.slice(0, 7);
    const m = months.get(month) ?? { expenses: 0, income: 0 };
    if (t.kind === "income") {
      income += t.amount;
      m.income += t.amount;
    } else {
      expenses += -t.amount; // refunds (positive amounts in expense categories) reduce spend
      m.expenses += -t.amount;
      const c = cat.get(t.category) ?? { total: 0, count: 0 };
      c.total += -t.amount;
      c.count++;
      cat.set(t.category, c);
    }
    months.set(month, m);
    if (t.category === "Uncategorized") {
      unCount++;
      unTotal += Math.abs(t.amount);
    }
  }

  const by_category = [...cat.entries()]
    .map(([category, v]) => ({
      category,
      total: r2(v.total),
      count: v.count,
      share_pct: expenses > 0 ? r2((v.total / expenses) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const dates = txs.map((t) => t.date).sort();
  return {
    period: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    totals: { expenses: r2(expenses), income: r2(income), net: r2(income - expenses), transfers_excluded: r2(transfers) },
    by_category,
    by_month: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, expenses: r2(v.expenses), income: r2(v.income) })),
    uncategorized: { count: unCount, total: r2(unTotal) },
  };
}

export interface RecurringGroup {
  merchant: string;
  category: string;
  cadence: "weekly" | "monthly" | "yearly";
  occurrences: number;
  typical_amount: number;
  last_date: string;
  next_expected: string;
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Detect recurring charges: same merchant, >= 3 expense occurrences, a consistent weekly/monthly/yearly
 * gap between dates, and amounts within 15% of the median.
 */
export function findRecurring(txs: Transaction[]): RecurringGroup[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (t.kind !== "expense" || t.amount >= 0 || !t.merchant) continue;
    const key = t.merchant.toLowerCase();
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const out: RecurringGroup[] = [];
  for (const list of groups.values()) {
    if (list.length < 3) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const amounts = list.map((t) => Math.abs(t.amount));
    const med = median(amounts);
    const stable = amounts.filter((a) => Math.abs(a - med) <= med * 0.15);
    if (stable.length < 3) continue;
    const gaps: number[] = [];
    for (let i = 1; i < list.length; i++) gaps.push(dayDiff(list[i - 1].date, list[i].date));
    const gap = median(gaps);
    let cadence: RecurringGroup["cadence"] | null = null;
    let nominal = 0;
    if (gap >= 6 && gap <= 8) [cadence, nominal] = ["weekly", 7];
    else if (gap >= 27 && gap <= 34) [cadence, nominal] = ["monthly", 30];
    else if (gap >= 360 && gap <= 370) [cadence, nominal] = ["yearly", 365];
    if (!cadence) continue;
    if (gaps.filter((g) => Math.abs(g - gap) <= 4).length < gaps.length * 0.7) continue;
    const last = list[list.length - 1];
    out.push({
      merchant: last.merchant,
      category: last.category,
      cadence,
      occurrences: list.length,
      typical_amount: r2(med),
      last_date: last.date,
      next_expected: addDays(last.date, nominal),
    });
  }
  return out.sort((a, b) => b.typical_amount - a.typical_amount);
}

export const EXPORT_HEADER = "id,date,description,merchant,amount,category,kind,source";

export function toCategorizedCsv(txs: Transaction[]): string {
  const lines = [EXPORT_HEADER];
  for (const t of txs) {
    lines.push(
      [
        csvField(t.id),
        csvField(t.date),
        csvField(t.description),
        csvField(t.merchant),
        t.amount.toFixed(2), // numeric: no formula escaping so negatives stay numbers
        csvField(t.category),
        csvField(t.kind),
        csvField(t.source),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
