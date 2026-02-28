# Code Quality Review

Scope reviewed: current branch working-tree changes relative to `master` (repo has no local `main` branch).

## Critical Findings (Fixed)

1. **[Critical] Inconsistent/unsafe query validation in audit API routes**
   - Files: `apps/web/src/app/api/drives/[driveId]/integrations/audit/route.ts`, `apps/web/src/app/api/drives/[driveId]/integrations/audit/export/route.ts`
   - Problem: list/export endpoints duplicated filter parsing and allowed malformed values (`success`, dates, pagination) to flow into queries, which could cause incorrect filtering or 500s.
   - Fix: introduced shared parser + where-clause builder in `apps/web/src/app/api/drives/[driveId]/integrations/audit/audit-filters.ts`, and reused it from both routes.
   - Result: strict validation for `connectionId`, `agentId`, `success`, `dateFrom/dateTo`, `toolName`, `limit`, and `offset` with deterministic 400 responses.

2. **[Critical] CSV export formula-injection risk + partial escaping**
   - File: `apps/web/src/app/api/drives/[driveId]/integrations/audit/export/route.ts`
   - Problem: CSV output escaped only some string fields and did not guard against spreadsheet formula execution for values beginning with `=`, `+`, `-`, or `@`.
   - Fix: added centralized `escapeCsvValue(...)` used for every exported column, including spreadsheet formula neutralization.
   - Result: safer CSV downloads and consistent escaping across all fields.

3. **[High] Export action swallowed errors in UI**
   - File: `apps/web/src/components/integrations/IntegrationAuditLogPage.tsx`
   - Problem: export failures were silently ignored.
   - Fix: added user-visible error feedback via `toast.error('Failed to export audit logs')`.

## Non-Critical Notes

1. `IntegrationAuditLogPage` carries `agentId` filter state/query wiring without a corresponding visible input control yet; this is not breaking, but it is currently unreachable from the UI.

## Verification

- `pnpm --filter web exec next lint --file ...` (touched files): **pass**
- `pnpm --filter web exec vitest run src/components/ai/page-agents/__tests__/AgentIntegrationsPanel.test.tsx src/components/integrations/__tests__/IntegrationAuditLogPage.test.tsx`: **pass**
