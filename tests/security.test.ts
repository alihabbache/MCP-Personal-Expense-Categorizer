import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRecurring } from "../src/analysis.js";
import { categorizeAll, MAX_KEYWORD_LENGTH, addUserRule, loadRuleSet } from "../src/rules.js";
import { parseBankCsv } from "../src/parser.js";
import { exportCsv, readBankFile } from "../src/service.js";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
const US = join(ROOT, "test-data", "sample-checking-us.csv");

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pec-sec-"));
  try {
    return await fn(dir);
  } finally {
    delete process.env.EXPENSE_ALLOWED_DIRS;
    await rm(dir, { recursive: true, force: true });
  }
}

test("recurring: grouping does not copy arrays and still detects subscriptions", async () => {
  const rs = await loadRuleSet(join(ROOT, "does-not-exist.json"));
  const txs = categorizeAll(parseBankCsv(readFileSync(US, "utf8")).transactions, rs);
  assert.ok(findRecurring(txs).some((r) => r.merchant === "Netflix Com"));
  assert.ok(!/\[\.\.\.\(groups\.get/.test(readFileSync(join(ROOT, "src", "analysis.ts"), "utf8")));
});

test("gitignore: only the five fixtures are allowed, other data formats are blocked", () => {
  const gi = readFileSync(join(ROOT, ".gitignore"), "utf8");
  for (const p of ["*.tsv", "*.txt", "*.xlsx", "*.ofx", "*.qfx", "*.pdf", ".env.*", "rules.json"]) {
    assert.ok(gi.split("\n").includes(p), `missing ${p}`);
  }
  assert.ok(!gi.includes("!test-data/*.csv"), "wildcard exception must be gone");
  for (const f of ["sample-ambiguous-dates", "sample-bank-eu-debit-credit", "sample-checking-us", "sample-credit-card-positive", "sample-edge-cases"]) {
    assert.ok(gi.includes(`!test-data/${f}.csv`), `missing exception for ${f}`);
  }
});

test("export: refuses to overwrite a file this server did not create, even with overwrite=true", async () => {
  await withTmp(async (dir) => {
    const victim = join(dir, "notes.csv");
    await writeFile(victim, "my precious data\n");
    await assert.rejects(exportCsv(US, victim, {}, true), /not created by this server/);
    assert.equal(await readFile(victim, "utf8"), "my precious data\n");

    const out = join(dir, "out.csv");
    await exportCsv(US, out, {});
    await assert.rejects(exportCsv(US, out, {}), /already exists/);
    await exportCsv(US, out, {}, true); // our own export may be replaced
  });
});

test("export: a symlink cannot redirect the write to a foreign file", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "target.csv");
    await writeFile(target, "keep me\n");
    const link = join(dir, "link.csv");
    await symlink(target, link);
    await assert.rejects(exportCsv(US, link, {}, true), /not created by this server/);
    assert.equal(await readFile(target, "utf8"), "keep me\n");
  });
});

test("read: a .csv symlink pointing at a non-allowed extension is refused", async () => {
  await withTmp(async (dir) => {
    const secret = join(dir, "secret.pem");
    await writeFile(secret, "-----BEGIN KEY-----\n");
    const link = join(dir, "innocent.csv");
    await symlink(secret, link);
    await assert.rejects(readBankFile(link), /only .csv, .tsv or .txt/);
  });
});

test("EXPENSE_ALLOWED_DIRS restricts reads and writes, including via symlinks", async () => {
  await withTmp(async (dir) => {
    const allowed = join(dir, "allowed");
    const outside = join(dir, "outside");
    const { mkdir, copyFile } = await import("node:fs/promises");
    await mkdir(allowed);
    await mkdir(outside);
    await copyFile(US, join(allowed, "in.csv"));
    await copyFile(US, join(outside, "in.csv"));
    await symlink(join(outside, "in.csv"), join(allowed, "link.csv"));
    process.env.EXPENSE_ALLOWED_DIRS = allowed;

    assert.ok((await readBankFile(join(allowed, "in.csv"))).length > 0);
    await assert.rejects(readBankFile(join(outside, "in.csv")), /EXPENSE_ALLOWED_DIRS/);
    await assert.rejects(readBankFile(join(allowed, "link.csv")), /EXPENSE_ALLOWED_DIRS/);
    await assert.rejects(readBankFile(join(allowed, "..", "outside", "in.csv")), /EXPENSE_ALLOWED_DIRS/);

    await exportCsv(join(allowed, "in.csv"), join(allowed, "out.csv"), {});
    await assert.rejects(exportCsv(join(allowed, "in.csv"), join(outside, "out.csv"), {}), /EXPENSE_ALLOWED_DIRS/);
  });
});

test("rules: keyword and category lengths are capped", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "rules.json");
    await assert.rejects(addUserRule("Dining", "a".repeat(MAX_KEYWORD_LENGTH + 1), undefined, p), /at most/);
    await assert.rejects(addUserRule("C".repeat(61), "ok", undefined, p), /category/);
    await assert.rejects(addUserRule("Bad\nName", "ok", undefined, p), /category/);
  });
});

test("rules: malformed rules.json is rejected with a clear error", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "rules.json");
    for (const body of [
      "[]",
      '{"rules":"nope"}',
      '{"rules":[{"category":"A"}]}',
      '{"rules":[{"category":"A","keyword":5}]}',
      '{"rules":[{"category":"","keyword":"x"}]}',
      '{"categories":{"A":"bogus"}}',
      JSON.stringify({ rules: [{ category: "A", keyword: "k".repeat(MAX_KEYWORD_LENGTH + 1) }] }),
    ]) {
      await writeFile(p, body);
      await assert.rejects(loadRuleSet(p), /Invalid rules file/, body);
      await assert.rejects(addUserRule("Dining", "cafe", undefined, p), /Invalid rules file/, body);
    }
    await writeFile(p, '{"categories":{"Pets":"expense"},"rules":[{"category":"Pets","keyword":"petco"}]}');
    assert.ok((await loadRuleSet(p)).categories.has("Pets"));
  });
});

test("rules: file is written with mode 600, and existing loose permissions are tightened", async () => {
  if (process.platform === "win32") return;
  await withTmp(async (dir) => {
    const p = join(dir, "sub", "rules.json");
    await addUserRule("Dining", "blue bottle", undefined, p);
    assert.equal((await stat(p)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(p))).mode & 0o777, 0o700);
    await chmod(p, 0o644);
    await addUserRule("Dining", "philz", undefined, p);
    assert.equal((await stat(p)).mode & 0o777, 0o600);
  });
});
