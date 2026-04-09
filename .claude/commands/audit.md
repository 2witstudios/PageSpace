# Pre-Merge Audit

Conduct a pre-merge audit of a PR against its epic/task plan using the pre-merge-audit.mdc rule.

Usage: `/audit` (will prompt for PR number and plan file)

1. Ask which PR to audit if not obvious from context
2. Identify the corresponding task/epic plan in `tasks/`
3. Run the full audit process from pre-merge-audit.mdc
4. Output the structured audit report

This is NOT a code review — it's a requirements compliance check. Use `/review` for code quality. Use `/audit` for plan adherence.
