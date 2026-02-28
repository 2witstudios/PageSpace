# QA Regression Review: ppg/sandbox-ui-agents

**Date:** 2026-02-27
**Branch:** ppg/sandbox-ui-agents
**Scope:** Integration audit log filtering, CSV export, agent tool access UI

---

## Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `apps/web/src/app/api/drives/[driveId]/integrations/audit/route.ts` | Modified | Added agentId, dateFrom, dateTo, toolName filter params; replaced helper functions with inline Drizzle query |
| `apps/web/src/app/api/drives/[driveId]/integrations/audit/export/route.ts` | **New** | CSV export endpoint for audit logs with same filter params |
| `apps/web/src/components/ai/page-agents/AgentIntegrationsPanel.tsx` | Modified | Added tool access UI section with removable tool badges |
| `apps/web/src/components/integrations/IntegrationAuditLogPage.tsx` | **New** | Full audit log viewer: table, filters, pagination, stats, export |
| `apps/web/src/hooks/useIntegrations.ts` | Modified | Exported AuditLogsParams; added 4 new filter params to interface + hook |
| `apps/web/src/components/ai/page-agents/__tests__/AgentIntegrationsPanel.test.tsx` | **New** | Component tests for AgentIntegrationsPanel |
| `apps/web/src/components/integrations/__tests__/IntegrationAuditLogPage.test.tsx` | **New** | Component tests for IntegrationAuditLogPage |

---

## HIGH Risk Findings

### H1. CSV Injection Vulnerability in Export Route
**Risk: HIGH** | File: `export/route.ts:54-73`

The `escapeCsv` helper escapes commas, quotes, and newlines — but does **not** protect against CSV formula injection. Values starting with `=`, `+`, `-`, or `@` can execute formulas when opened in Excel/Sheets.

Critically, `log.agentId` and `log.connectionId` (lines 66-67) are **not passed through `escapeCsv` at all** — they're inserted raw into CSV output.

**Reproduction:** An agentId containing `=HYPERLINK("http://evil.com","click")` would be injected verbatim.

**Fix:** Prefix values with a tab or single-quote, and pass all fields through escapeCsv.

---

### H2. No Input Validation on Date Params — Invalid Date Reaches DB
**Risk: HIGH** | Files: `audit/route.ts:55-60`, `export/route.ts:41-42`

`new Date(dateFrom)` and `new Date(dateTo)` accept arbitrary strings. `new Date('not-a-date')` produces `Invalid Date`, which will be passed to the Drizzle `gte()`/`lte()` operators and sent to PostgreSQL. Depending on driver behavior this could error or produce unexpected results.

**Fix:** Validate date strings before constructing Date objects:
```typescript
const parsedDate = new Date(dateFrom);
if (isNaN(parsedDate.getTime())) {
  return NextResponse.json({ error: 'Invalid dateFrom format' }, { status: 400 });
}
```

---

### H3. Missing `isValidId` on agentId/toolName in Audit Route
**Risk: HIGH** | File: `audit/route.ts:52-63`

`connectionId` is validated with `isValidId()` (line 40) but `agentId` is not. The export route validates **none** of its ID params. This inconsistency means malformed IDs can reach DB queries.

**Fix:** Apply same validation pattern to agentId (and connectionId in export route).

---

### H4. Export Route Unbounded Memory — Hardcoded 10,000 Limit
**Risk: HIGH** | File: `export/route.ts:50`

The export fetches up to 10,000 rows into memory, serializes them all to a CSV string, then returns the full response. For drives with heavy integration usage, this could cause OOM on the server.

**Fix:** Consider streaming the CSV response, or add a configurable lower limit with pagination support in the export.

---

## MEDIUM Risk Findings

### M1. Stats Computed from Current Page Only — Misleading UX
**Risk: MEDIUM** | File: `IntegrationAuditLogPage.tsx:101-105`

`successRate` and `avgDuration` are computed from `logs` (the current page of 50 results), not the full dataset. The stats card labels them generically ("Success Rate", "Avg Duration") without indicating they reflect only the visible page. Users will interpret these as aggregate stats.

**Fix:** Either compute stats server-side across the full filtered dataset, or label clearly: "Page Success Rate".

---

### M2. Silent Error Swallowing in Export Handler
**Risk: MEDIUM** | File: `IntegrationAuditLogPage.tsx:150`

The `handleExport` catch block is empty: `catch { }`. Export failures are invisible to users — no toast, no error state. The comment says "Error is visible to user via console" but most users never open devtools.

**Fix:** Add `toast.error('Failed to export audit logs')` in the catch block.

---

### M3. IntegrationAuditLogPage Not Wired into Any Route
**Risk: MEDIUM** | File: `IntegrationAuditLogPage.tsx`

The new `IntegrationAuditLogPage` component exists but is not rendered by any page. The dashboard settings page (`app/dashboard/[driveId]/settings/page.tsx`) still uses the older `IntegrationAuditLog` component. This is either incomplete integration or dead code.

---

### M4. Removed Helper Functions Still Exported from Library
**Risk: MEDIUM** | File: `packages/lib/src/integrations/index.ts`

`getAuditLogsByDrive`, `getAuditLogsByConnection`, `getAuditLogsBySuccess` were removed from the audit route's imports and replaced with inline Drizzle queries. These functions still exist and are exported from `@pagespace/lib/integrations`. The inline query in the route could drift from the repository pattern, leading to inconsistent filtering behavior.

---

### M5. Export Route Missing `connectionId` Validation
**Risk: MEDIUM** | File: `export/route.ts:38`

The audit list route validates `connectionId` format with `isValidId()` (and returns 400 if invalid). The export route does not validate any IDs — it passes them directly to the query.

---

## LOW Risk Findings

### L1. No `toolName` Filter in the Audit Log UI
**Risk: LOW** | File: `IntegrationAuditLogPage.tsx`

The API and hook both support `toolName` filtering, but the UI has no control for it. This is a feature gap rather than a bug.

---

### L2. URL.revokeObjectURL Called Synchronously After click()
**Risk: LOW** | File: `IntegrationAuditLogPage.tsx:148`

`window.URL.revokeObjectURL(url)` is called immediately after `a.click()`. The download may not have started by that point. Consider wrapping in `setTimeout(() => ..., 100)`.

---

### L3. Calendar Date Pickers Missing Accessible Labels
**Risk: LOW** | File: `IntegrationAuditLogPage.tsx:293-343`

The date filter popover trigger buttons show "From Date" / "To Date" as placeholder text, but have no explicit `aria-label`. Screen readers will read the button content, which is acceptable, but explicit labels would be clearer.

---

### L4. Stats Cards Lack Screen Reader Context
**Risk: LOW** | File: `IntegrationAuditLogPage.tsx:216-228`

The stats (Total Calls, Success Rate, Avg Duration) are rendered as visual text. Adding `aria-label` or a visually-hidden summary would improve accessibility.

---

## Test Coverage Gaps

| Gap | Severity | Location |
|-----|----------|----------|
| No API route tests for new filter params (agentId, dateFrom, dateTo, toolName) | HIGH | `audit/route.ts` |
| No tests for export route (CSV generation, auth, permissions, filtering) | HIGH | `export/route.ts` |
| Export button click silently catches errors — no test verifies error handling | MEDIUM | `IntegrationAuditLogPage.test.tsx` |
| Pagination next/previous navigation not tested | MEDIUM | `IntegrationAuditLogPage.test.tsx` |
| "Clear filters" test doesn't actually test clearing — just checks text exists | MEDIUM | `IntegrationAuditLogPage.test.tsx` |
| No test for removing last tool (should set allowedTools to null) | MEDIUM | `AgentIntegrationsPanel.test.tsx` |
| No test for invalid date params reaching the API | MEDIUM | Missing |
| No test for CSV injection vectors | HIGH | Missing |

---

## Integration Risks

1. **Schema alignment**: The inline Drizzle query in `route.ts` now bypasses the repository functions in `@pagespace/lib/integrations`. If the repository functions are updated (e.g., adding joins or computed fields), the route won't benefit.

2. **Type drift**: `AuditLogsParams` is now exported from `useIntegrations.ts` and imported by `IntegrationAuditLogPage.tsx`. If the API adds/removes params, both must stay in sync manually.

3. **Existing IntegrationAuditLog component**: The older component in `apps/web/src/components/settings/IntegrationAuditLog.tsx` still uses the simpler API without the new filter params. Two competing audit log UIs could confuse maintenance.

---

## Recommendations

| Priority | Action |
|----------|--------|
| **P0** | Fix CSV injection: sanitize all fields, prefix formula-triggering chars |
| **P0** | Validate dateFrom/dateTo as valid ISO dates before `new Date()` |
| **P0** | Add `isValidId()` checks for agentId in both routes |
| **P1** | Add toast.error to export failure catch block |
| **P1** | Wire IntegrationAuditLogPage into a route, or document it as unused |
| **P1** | Add API route tests for new filter params |
| **P2** | Compute stats server-side or label as "page-only" |
| **P2** | Stream CSV export or add server-side pagination for large datasets |
| **P2** | Add toolName filter UI to the audit log page |
