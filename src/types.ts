/** Shared domain types for the Personal Expense Categorizer. */

export type DateFormat = "auto" | "MDY" | "DMY";
export type AmountConvention = "auto" | "negative_is_expense" | "positive_is_expense";

/** Optional explicit header names, used when auto-detection does not recognise a bank's export. */
export interface ColumnMap {
  date?: string;
  description?: string;
  amount?: string;
  debit?: string;
  credit?: string;
}

export interface ParseOptions {
  date_format?: DateFormat;
  amount_convention?: AmountConvention;
  column_map?: ColumnMap;
}

/** A normalised transaction. `amount` is always signed: negative = money out, positive = money in. */
export interface RawTransaction {
  id: string;
  row: number;
  date: string; // ISO yyyy-mm-dd
  description: string;
  amount: number;
}

export interface ParseResult {
  transactions: RawTransaction[];
  detected: {
    delimiter: string;
    header_row: number;
    columns: Record<string, string>;
    date_format: "ISO" | "MDY" | "DMY";
    amount_convention: string;
  };
  warnings: string[];
  skipped_rows: number;
}

export type Kind = "expense" | "income" | "transfer";
export type RuleSource = "user" | "default" | "none";

export interface Rule {
  category: string;
  keyword: string; // normalised (lowercase, alphanumerics and single spaces)
  source: "user" | "default";
}

export interface RuleSet {
  categories: Map<string, Kind>;
  rules: Rule[];
}

export interface Transaction extends RawTransaction {
  merchant: string;
  category: string;
  kind: Kind;
  matched_rule: string | null;
  source: RuleSource;
}
