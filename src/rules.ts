import { chmod, readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kind, RawTransaction, Rule, RuleSet, Transaction } from "./types.js";

export const UNCATEGORIZED = "Uncategorized";
export const MAX_KEYWORD_LENGTH = 100;
export const MAX_CATEGORY_LENGTH = 60;
export const MAX_USER_RULES = 5000;
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

/** Reject malformed rules.json content with an error that names the file and the offending entry. */
export function validateUserFile(data: unknown, path: string): UserFile {
  const bad = (msg: string): never => {
    throw new Error(`Invalid rules file ${path}: ${msg}`);
  };
  if (typeof data !== "object" || data === null || Array.isArray(data)) return bad("top level must be an object.");
  const { categories, rules } = data as Record<string, unknown>;
  if (categories !== undefined) {
    if (typeof categories !== "object" || categories === null || Array.isArray(categories)) return bad('"categories" must be an object.');
    for (const [name, kind] of Object.entries(categories)) {
      if (!isValidCategoryName(name)) bad(`category name ${JSON.stringify(name.slice(0, 40))} is not allowed.`);
      if (!isKind(kind)) bad(`category ${JSON.stringify(name)} has kind ${JSON.stringify(kind)}; expected expense, income or transfer.`);
    }
  }
  if (rules !== undefined) {
    if (!Array.isArray(rules)) return bad('"rules" must be an array.');
    if (rules.length > MAX_USER_RULES) bad(`more than ${MAX_USER_RULES} rules.`);
    rules.forEach((r, i) => {
      if (typeof r !== "object" || r === null || Array.isArray(r)) return bad(`rules[${i}] must be an object.`);
      const { category, keyword } = r as Record<string, unknown>;
      if (typeof category !== "string" || !isValidCategoryName(category)) bad(`rules[${i}].category must be a valid category name.`);
      if (typeof keyword !== "string" || keyword.length > MAX_KEYWORD_LENGTH) {
        bad(`rules[${i}].keyword must be a string of at most ${MAX_KEYWORD_LENGTH} characters.`);
      }
    });
  }
  return data as UserFile;
}

function isValidCategoryName(name: string): boolean {
  return (
    name.trim().length > 0 &&
    name.length <= MAX_CATEGORY_LENGTH &&
    name !== "__proto__" &&
    !/[\u0000-\u001f\u007f]/.test(name)
  );
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

  const rawUser = await readJson<unknown>(userRulesPath);
  if (rawUser !== null) {
    const user = validateUserFile(rawUser, userRulesPath);
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
  if (keyword.length > MAX_KEYWORD_LENGTH) throw new Error(`keyword must be at most ${MAX_KEYWORD_LENGTH} characters.`);
  if (!kw) throw new Error("keyword must contain at least one letter or digit.");
  if (!isValidCategoryName(category)) {
    throw new Error(`category must be 1 to ${MAX_CATEGORY_LENGTH} characters with no control characters.`);
  }
  const rawData = await readJson<unknown>(userRulesPath);
  const data: UserFile = rawData === null ? {} : validateUserFile(rawData, userRulesPath);
  data.categories ??= {};
  data.rules ??= [];
  if (kind) data.categories[category] = kind;
  const exists = data.rules.some((r) => r.category === category && normalize(r.keyword) === kw);
  if (!exists) {
    if (data.rules.length >= MAX_USER_RULES) throw new Error(`Rules file already holds ${MAX_USER_RULES} rules.`);
    data.rules.push({ category, keyword: kw });
  }
  // The file reveals spending habits: owner-only, even if it already existed with looser permissions.
  await mkdir(dirname(userRulesPath), { recursive: true, mode: 0o700 });
  await writeFile(userRulesPath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(userRulesPath, 0o600);
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
