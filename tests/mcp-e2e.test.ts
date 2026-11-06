import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
const SERVER = join(ROOT, "build", "src", "index.js");
const US = join(ROOT, "test-data", "sample-checking-us.csv");

/** Minimal newline-delimited JSON-RPC client for the stdio transport. */
function startClient(env: Record<string, string>) {
  const child = spawn("node", [SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (v: any) => void>();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((res, rej) => {
      const myId = ++id;
      const t = setTimeout(() => rej(new Error(`timeout: ${method}`)), 10000);
      pending.set(myId, (m) => {
        clearTimeout(t);
        res(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  const notify = (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  const call = async (name: string, args: unknown) => {
    const r = await request("tools/call", { name, arguments: args });
    assert.ok(r.result, JSON.stringify(r));
    return r.result as { content: { text: string }[]; isError?: boolean };
  };
  return { child, request, notify, call };
}

test("mcp e2e: handshake, tools, rule learning, export", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pec-"));
  const rulesPath = join(tmp, "rules.json");
  const { child, request, notify, call } = startClient({ EXPENSE_RULES_PATH: rulesPath });
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(init.result.serverInfo.name, "personal-expense-categorizer");
    notify("notifications/initialized");

    const list = await request("tools/list");
    const names = list.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, [
      "add_category_rule",
      "categorize_transactions",
      "export_categorized_csv",
      "find_recurring_charges",
      "list_categories",
      "summarize_spending",
    ]);

    const exportTool = list.result.tools.find((t: any) => t.name === "export_categorized_csv");
    assert.equal(exportTool.annotations.destructiveHint, true, "export can replace files, so it must be marked destructive");
    assert.equal(exportTool.annotations.readOnlyHint, false);

    const unc = await call("categorize_transactions", { file_path: US, only_uncategorized: true });
    const uncBody = JSON.parse(unc.content[0].text);
    assert.equal(uncBody.uncategorized, 2);
    assert.ok(uncBody.transactions.every((t: any) => t.category === "Uncategorized"));

    const add = await call("add_category_rule", { keyword: "Mystery Vendor", category: "Misc Shopping" });
    assert.equal(JSON.parse(add.content[0].text).added, true);
    assert.ok((await readFile(rulesPath, "utf8")).includes("mystery vendor"));

    const after = JSON.parse((await call("categorize_transactions", { file_path: US, only_uncategorized: true })).content[0].text);
    assert.equal(after.uncategorized, 0);

    const sum = JSON.parse((await call("summarize_spending", { file_path: US })).content[0].text);
    assert.equal(sum.totals.income, 9600);

    const out = join(tmp, "out.csv");
    await call("export_categorized_csv", { file_path: US, output_path: out });
    assert.ok((await readFile(out, "utf8")).startsWith("id,date,"));
    const again = await call("export_categorized_csv", { file_path: US, output_path: out });
    assert.equal(again.isError, true, "must refuse to overwrite by default");

    const tooLong = await request("tools/call", {
      name: "add_category_rule",
      arguments: { keyword: "x".repeat(101), category: "Dining" },
    });
    assert.ok(tooLong.error || tooLong.result?.isError, "over-long keyword must be rejected by the schema");

    const bad = await call("summarize_spending", { file_path: join(tmp, "nope.csv") });
    assert.equal(bad.isError, true);
    const wrongExt = await call("summarize_spending", { file_path: "/etc/passwd" });
    assert.equal(wrongExt.isError, true);
  } finally {
    child.kill();
    await rm(tmp, { recursive: true, force: true });
  }
});
