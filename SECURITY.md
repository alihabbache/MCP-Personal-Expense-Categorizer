# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
["Report a vulnerability"](../../security/advisories/new) form on this repository (Security tab), not in a public issue.
Include the affected version, steps to reproduce and the impact you expect. Do not attach real bank statements;
use the synthetic files in `test-data/` or redact your data.

You can expect an acknowledgement within 7 days. This is a small project maintained on a best-effort basis.

## Supported versions

Only the latest release on `main` receives fixes.

## Threat model

The server is a local stdio process that runs with your user's privileges and has no network code. It handles
financial data, so the relevant risks are file access driven by tool arguments (which a prompt-injected model could
influence) and accidental disclosure of your data.

| Control | Detail |
|---|---|
| Read allow-list | Only `.csv`, `.tsv`, `.txt` up to 10 MB. The extension is checked on both the given path and the path after resolving symlinks |
| Folder sandbox | Set `EXPENSE_ALLOWED_DIRS` (paths separated by `:` on macOS/Linux, `;` on Windows) to restrict every read and write to those folders, symlinks resolved. Unset means unrestricted. **Recommended** |
| Export safety | Must end in `.csv`. Existing files are replaced only if `overwrite=true` **and** the file starts with this tool's export header. Annotated as destructive so clients can prompt for confirmation |
| Rules file | `~/.personal-expense-categorizer/rules.json` is validated on load, field lengths are capped, and it is written with mode 600 (directory 700) |
| Formula injection | Exported text fields starting with `= + - @` are prefixed with `'` |
| Repository hygiene | `.gitignore` blocks bank-export formats, `.env.*` and `rules.json`; only five synthetic fixtures are allowed |

## Residual risks

- Without `EXPENSE_ALLOWED_DIRS`, any `.csv`/`.tsv`/`.txt` file your user can read can be parsed on request.
- Your Bob client may send tool results (transaction descriptions and amounts) to its model provider.
- Dependencies (`@modelcontextprotocol/server`, `zod`) are tracked by Dependabot; run `npm audit` before releases.
