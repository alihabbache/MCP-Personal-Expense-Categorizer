#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { addUserRule, defaultUserRulesPath, loadRuleSet } from "./rules.js";
import { categorizeReport, exportCsv, recurringReport, summaryReport } from "./service.js";

const server = new McpServer({ name: "personal-expense-categorizer", version: "0.1.0" });

const parseShape = {
  file_path: z.string().describe("Absolute path to the bank-export CSV on this machine."),
  date_format: z.enum(["auto", "MDY", "DMY"]).optional().describe("Order of numeric dates such as 03/04/2025. Default auto-detects."),
  amount_convention: z
    .enum(["auto", "negative_is_expense", "positive_is_expense"])
    .optional()
    .describe("Sign convention for a single Amount column. Default auto-detects."),
  column_map: z
    .object({
      date: z.string().optional(),
      description: z.string().optional(),
      amount: z.string().optional(),
      debit: z.string().optional(),
      credit: z.string().optional(),
    })
    .optional()
    .describe("Exact header names, only needed when auto-detection fails."),
};
const parseInput = z.object(parseShape);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

server.registerTool(
  "categorize_transactions",
  {
    description:
      "Parse a CSV bank export and tag every transaction with a category, kind (expense/income/transfer), merchant and the rule that matched. Returns detected format, warnings and per-category counts. Set only_uncategorized to review what rules missed.",
    inputSchema: parseInput.extend({
      only_uncategorized: z.boolean().optional().describe("Return only transactions no rule matched."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max transactions returned (default 200)."),
    }),
    annotations: readOnly,
  },
  async ({ file_path, only_uncategorized, limit, ...options }) =>
    run(() => categorizeReport(file_path, options, { only_uncategorized, limit })),
);

server.registerTool(
  "summarize_spending",
  {
    description:
      "Totals by category and by month for a CSV bank export. Transfers are excluded from income and expense totals; reports how much money is still uncategorized.",
    inputSchema: parseInput,
    annotations: readOnly,
  },
  async ({ file_path, ...options }) => run(() => summaryReport(file_path, options)),
);

server.registerTool(
  "find_recurring_charges",
  {
    description: "Detect subscriptions and other recurring charges (weekly, monthly, yearly) with typical amount and next expected date.",
    inputSchema: parseInput,
    annotations: readOnly,
  },
  async ({ file_path, ...options }) => run(() => recurringReport(file_path, options)),
);

server.registerTool(
  "add_category_rule",
  {
    description:
      "Teach the categorizer: transactions whose description contains the keyword will be assigned the category. Saved to the user's local rules file and applied on the next call. Only call after the user has confirmed the mapping.",
    inputSchema: z.object({
      keyword: z.string().min(1).describe("Merchant text to match, e.g. 'blue bottle'. Case and punctuation are ignored."),
      category: z.string().min(1).describe("Category name, e.g. 'Dining'. A new name creates a new category."),
      kind: z.enum(["expense", "income", "transfer"]).optional().describe("Only needed when creating a new category (default expense)."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ keyword, category, kind }) => run(() => addUserRule(category, keyword, kind)),
);

server.registerTool(
  "list_categories",
  {
    description: "List all categories with their kind and rule counts, and the location of the user's custom rules file.",
    inputSchema: z.object({}),
    annotations: readOnly,
  },
  async () =>
    run(async () => {
      const rs = await loadRuleSet();
      return {
        user_rules_path: defaultUserRulesPath(),
        categories: [...rs.categories.entries()].map(([name, kind]) => ({
          name,
          kind,
          user_rules: rs.rules.filter((r) => r.category === name && r.source === "user").length,
          default_rules: rs.rules.filter((r) => r.category === name && r.source === "default").length,
        })),
      };
    }),
);

server.registerTool(
  "export_categorized_csv",
  {
    description:
      "Write the categorized transactions to a new CSV file (id,date,description,merchant,amount,category,kind,source). Refuses to overwrite an existing file unless overwrite is true.",
    inputSchema: parseInput.extend({
      output_path: z.string().describe("Absolute path for the new .csv file."),
      overwrite: z.boolean().optional().describe("Replace output_path if it exists (default false)."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ file_path, output_path, overwrite, ...options }) => run(() => exportCsv(file_path, output_path, options, overwrite)),
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error("personal-expense-categorizer MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
