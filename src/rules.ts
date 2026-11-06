import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kind, RawTransaction, Rule, RuleSet, Transaction } from "./types.js";

export const UNCATEGORIZED = "Uncategorized";
const KINDS: readonly Kind[] = ["expense", "income", "transfer"];

const here = dirname(fileURLToPath(import.meta.url));
// Compiled layout is build/src/rules.js, so the repo root is two levels up.
export const DEFAULT_CONFIG_PATH = resolve(here, "..", "..", "config", "default-categories.json");

export function defaultUserRulesPath(): string {
  return process.env.EXPENSE_RULES_PATH ?? join(homedir(), ".personal-expense-categorizer", "rules.json");
}

/** Lowercase, collapse everything that is not a letter/digit to a single space. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isKind(v: unknown): v is Kind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

interface DefaultFile {
  categories: Record<string, { kind: Kind; keywords: string[] }>;
}

interface UserFile {
  categories?: Record<string, Kind>;
  rules?: { category: string; keyword: string }[];
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function loadRuleSet(userRulesPath: string = defaultUserRulesPath()): Promise<RuleSet> {
  const defaults = await readJson<DefaultFile>(DEFAULT_CONFIG_PATH);
  if (!defaults) throw new Error("default-categories.json not found next to the server build.");

  const categories = new Map<string, Kind>();
  const rules: Rule[] = [];
  for (const [name, def] of Object.entries(defaults.categories)) {
    categories.set(name, def.kind);
    for (const kw of def.keywords) rules.push({ category: name, keyword: normalize(kw), source: "default" });
  }

  const user = await readJson<UserFile>(userRulesPath);
  if (user) {
    for (const [name, kind] of Object.entries(user.categories ?? {})) {
      if (isKind(kind)) categories.set(name, kind);
    }
    for (const r of user.rules ?? []) {
      const kw = normalize(r.keyword ?? "");
      if (!kw || !r.category) continue;
      if (!categories.has(r.category)) categories.set(r.category, "expense");
      rules.push({ category: r.category, keyword: kw, source: "user" });
    }
  }
  return { categories, rules };
}

/** Persist a user rule. Creates the rules file (and directory) if needed. Idempotent. */
export async function addUserRule(
  category: string,
  keyword: string,
  kind: Kind | undefined,
  userRulesPath: string = defaultUserRulesPath(),
): Promise<{ path: string; added: boolean }> {
  const kw = normalize(keyword);
  if (!kw) throw new Error("keyword must contain at least one letter or digit.");
  if (!category.trim()) throw new Error("category must not be empty.");
  const data: UserFile = (await readJson<UserFile>(userRulesPath)) ?? {};
  data.categories ??= {};
  data.rules ??= [];
  if (kind) data.categories[category] = kind;
  const exists = data.rules.some((r) => r.category === category && normalize(r.keyword) === kw);
  if (!exists) data.rules.push({ category, keyword: kw });
  await mkdir(dirname(userRulesPath), { recursive: true });
  await writeFile(userRulesPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return { path: userRulesPath, added: !exists };
}

function containsPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${phrase} `);
}

// Payment-processor prefixes and noise stripped when deriving a display merchant name.
const MERCHANT_PREFIX = /^(?:(?:pos|debit|purchase|checkcard|card|ach|sq|tst|pp|paypal|recurring)\s+)+/;
const MERCHANT_SUFFIX = /\s+(?:\d{3,}|[a-z]{2}\s+\d{2,}|#\s*\d+)(?:\s.*)?$/;

export function extractMerchant(description: string): string {
  let m = normalize(description).replace(MERCHANT_PREFIX, "");
  const trimmed = m.replace(MERCHANT_SUFFIX, "");
  if (trimmed.length >= 2) m = trimmed;
  m = m.split(" ").slice(0, 3).join(" ");
  return m
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Longest matching keyword wins; on equal length user rules beat defaults. */
export function categorize(tx: RawTransaction, ruleSet: RuleSet): Transaction {
  const text = normalize(tx.description);
  let best: Rule | null = null;
  for (const r of ruleSet.rules) {
    if (!containsPhrase(text, r.keyword)) continue;
    if (
      !best ||
      r.keyword.length > best.keyword.length ||
      (r.keyword.length === best.keyword.length && r.source === "user" && best.source === "default")
    ) {
      best = r;
    }
  }
  const merchant = extractMerchant(tx.description);
  if (best) {
    return {
      ...tx,
      merchant,
      category: best.category,
      kind: ruleSet.categories.get(best.category) ?? "expense",
      matched_rule: best.keyword,
      source: best.source,
    };
  }
  return {
    ...tx,
    merchant,
    category: UNCATEGORIZED,
    kind: tx.amount < 0 ? "expense" : "income",
    matched_rule: null,
    source: "none",
  };
}

export function categorizeAll(txs: RawTransaction[], ruleSet: RuleSet): Transaction[] {
  return txs.map((t) => categorize(t, ruleSet));
}
