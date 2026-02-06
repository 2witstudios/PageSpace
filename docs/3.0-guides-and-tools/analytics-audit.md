# Analytics & Monitoring Audit Report

**Date:** February 2026
**Scope:** Full audit of analytics infrastructure — model spend tracking, user interaction tracking, monitoring middleware, admin dashboard, and database tables.

---

## Executive Summary

PageSpace has a comprehensive analytics infrastructure spanning 13+ database tables, server-side tracking, client-side tracking, an admin dashboard, and AI cost monitoring. However, significant portions are **not wired up**, several functions are **dead code**, and critical cost tracking has **silent failures** that cause $0 cost entries for the most-used default model.

**Headline findings:**
- **3 AI routes** have zero usage/cost tracking
- **Default model** (`glm-4.5-air`) has no pricing entry — all costs silently recorded as $0
- **5 server-side tracking functions** are dead code (defined, never called)
- **3 database tables** are completely orphaned (no reads or writes)
- **4 monitoring middleware functions** are defined but never wired in

---

## 1. AI Cost Tracking — CRITICAL Issues

### 1.1 Missing Pricing for Default Model

**Severity: CRITICAL**
**File:** `packages/lib/src/monitoring/ai-monitoring.ts`

The application's default AI model is `glm-4.5-air` (set in `apps/web/src/app/api/ai/chat/route.ts:333`). This model has **no entry** in the `AI_PRICING` table. The OpenRouter-prefixed version `z-ai/glm-4.5-air` exists, but the bare name used at runtime does not.

When `calculateCost()` receives an unknown model, it silently falls back to `AI_PRICING.default` which is `{ input: 0, output: 0 }`. Every request using the default model records **$0 cost**.

**Also missing:** `glm-4.5` (bare name without prefix).

**Impact:** Cost dashboard shows artificially low spending. Impossible to know actual AI costs.

**Fix:** Add bare-name pricing entries for all models that are used without their OpenRouter prefix.

### 1.2 Three AI Routes With No Usage Tracking

**Severity: HIGH**

| Route | Purpose | Missing |
|-------|---------|---------|
| `/api/ai/page-agents/consult` | Agent-to-agent consultation via `generateText()` | No `AIMonitoring.trackUsage()` call, no token capture |
| `/api/pulse/generate` | On-demand workspace summary generation | No usage tracking at all |
| `/api/pulse/cron` | Scheduled pulse generation for all active users | No usage tracking — high volume, fully invisible |

These routes call `generateText()` and discard the usage metadata. The pulse cron job is especially concerning as it generates AI content for multiple users on a schedule with zero cost visibility.

**Fix:** Extract `usage` from `generateText()` result and call `AIMonitoring.trackUsage()` in each route.

### 1.3 Silent Fallback for Unknown Models

**Severity: MEDIUM**
**File:** `packages/lib/src/monitoring/ai-monitoring.ts:382`

```typescript
const pricing = AI_PRICING[model] || AI_PRICING.default; // default = { input: 0, output: 0 }
```

No warning is logged when a model falls through to the default. This makes it impossible to detect pricing gaps without manually inspecting the data.

**Fix:** Log a warning when falling back to default pricing so operators can add missing entries.

### 1.4 Pricing Table Dated January 2025

**Severity: MEDIUM**

The pricing comment says "as of 2025-01" but the system is running in February 2026. Several prices may have changed. Preview models marked as free (`gemini-2.0-pro-exp`, `gemini-2.0-flash-exp`) are likely no longer free. Newer models (e.g., `claude-opus-4.6`) may be missing entirely.

**Fix:** Audit all pricing against current provider pricing pages and update the date stamp.

---

## 2. Server-Side Tracking — Dead Code

### 2.1 Dead Functions in `activity-tracker.ts`

**File:** `packages/lib/src/monitoring/activity-tracker.ts`

| Function | Status | Why Dead |
|----------|--------|----------|
| `trackAiUsage()` | DEAD | Never imported anywhere. Code uses `AIMonitoring.trackUsage()` directly instead. |
| `trackSearch()` | DEAD | Never called. `/api/track` route calls `trackActivity()` directly for search events. |
| `trackNavigation()` | DEAD | Never called. Client-side auto page-view tracking handles navigation. |
| `trackApiCall()` | DEAD | Never called. Monitoring middleware handles API metrics via its own buffer. |

### 2.2 Dead Functions in `monitoring.ts` Middleware

**File:** `apps/web/src/middleware/monitoring.ts`

| Function | Status | Why Dead |
|----------|--------|----------|
| `monitorAIRequest()` | DEAD | Defined (line 439) but never called. AI tracking uses a separate path. |
| `monitorDatabaseQuery()` | DEAD | Defined (line 486) but never called. No DB query instrumentation exists. |
| `trackUserActivity()` | DEAD | Defined (line 529) but never called. Duplicates `activity-tracker.ts`. |
| `trackFeatureUsage()` | DEAD | Defined (line 547) but never called. Duplicates `activity-tracker.ts`. |

### 2.3 Dead Function in `logger-database.ts`

| Function | Status | Why Dead |
|----------|--------|----------|
| `writePerformanceMetric()` | DEAD | Exported but never called from anywhere. The `performanceMetrics` table is never written to. |

**Total: 9 dead tracking functions** creating confusion about which tracking path is canonical.

**Recommendation:** Remove dead functions or consolidate into a single tracking API. Having two parallel tracking systems (`activity-tracker.ts` vs `monitoring.ts` middleware) with overlapping function names is a maintenance hazard.

---

## 3. Orphaned Database Tables

These tables have schemas and indexes defined but **zero reads and zero writes**:

| Table | Schema Location | Issue |
|-------|----------------|-------|
| `performanceMetrics` | `packages/db/src/schema/monitoring.ts` | Writer function exists but is never called. Dashboard queries bypass this table and use `apiMetrics` instead. |
| `dailyAggregates` | `packages/db/src/schema/monitoring.ts` | No writer function. No cron job. No reader. Designed for pre-computed stats that were never implemented. |
| `alertHistory` | `packages/db/src/schema/monitoring.ts` | No writer. No reader. Alert system was designed but never built. |
| `retentionPolicies` | `packages/db/src/schema/monitoring.ts` | No writer. No reader. Subscription-based retention archival was never implemented. |

**Impact:** 4 tables with indexes consuming database resources, generating migration complexity, and misleading developers.

**Recommendation:** Either implement write paths for these tables or drop them from the schema. If keeping as "planned features," add clear comments marking them as unimplemented.

---

## 4. Underutilized Tracking

### 4.1 Drive Operations

`trackDriveOperation()` is only called for `create` operations. Missing tracking for: `access`, `update`, `delete`, `invite_member`, `remove_member`.

### 4.2 Feature Tracking

`trackFeature()` is called in only 2 places:
1. `/api/track` route (generic client feature events)
2. `/api/ai/chat` route (`ai_tools_used`)

No server-side feature tracking for: search usage, export usage, file uploads, collaboration features, editor features, canvas usage.

### 4.3 Client-Side Tracker Functions

The `ClientTracker` singleton is properly initialized and auto-tracks page views. However, several exported methods are **never called from any component**:

| Method | Called? |
|--------|---------|
| `trackPageView()` | Auto-called via history interception |
| `trackFeature()` | Not called from components |
| `trackAction()` | Not called from components |
| `trackClick()` | Not called from components |
| `trackSearch()` | Not called from components |
| `trackError()` | Not called from components |
| `trackTiming()` | Not called from components |

Only auto page-view tracking is operational client-side. All the granular interaction tracking methods exist but are never wired into UI components.

---

## 5. What IS Working Well

### 5.1 AI Usage Logging (for tracked routes)
- `aiUsageLogs` table is properly populated for main chat and global assistant routes
- Token counting, cost calculation, and context tracking are comprehensive
- Billing vs. context usage distinction is well-designed
- Real-time updates via Socket.IO work correctly

### 5.2 Auth Event Tracking
- `trackAuthEvent()` is called from 18+ locations across all auth flows
- Covers: login, logout, signup, OAuth, device registration, email verification, failed attempts
- Comprehensive and well-maintained

### 5.3 Page Operation Tracking
- `trackPageOperation()` covers create, update, trash, restore, and export operations
- Properly wired in all page API routes

### 5.4 Monitoring Middleware
- API metrics collection via in-memory buffer is active and functional
- 30-second flush cycle with 1000-item buffer cap
- All API requests get timing, status code, and size tracking

### 5.5 Enterprise Audit Trail
- `activityLogs` table with hash-chain integrity is actively used
- Supports rollback functionality
- Admin export and search work correctly

### 5.6 Admin Dashboard
- All 4 dashboard tabs display data from actively populated tables
- No broken visualizations from orphaned tables (queries fall back gracefully)

---

## 6. Recommendations

### Priority 1 — Fix Cost Tracking (Critical)

1. **Add missing model pricing entries** — At minimum, add `glm-4.5-air` and `glm-4.5` to `AI_PRICING`
2. **Add usage tracking to untracked AI routes** — `page-agents/consult`, `pulse/generate`, `pulse/cron`
3. **Log warnings for unknown model pricing** — Replace silent $0 fallback with a logged warning
4. **Audit and update all pricing** — Verify against current provider pricing pages

### Priority 2 — Remove Dead Code (High)

5. **Delete dead tracking functions** — Remove the 9 unused functions from `activity-tracker.ts`, `monitoring.ts`, and `logger-database.ts`
6. **Consolidate tracking APIs** — Decide on one canonical tracking path instead of two parallel systems
7. **Drop or annotate orphaned tables** — Either implement `performanceMetrics`, `dailyAggregates`, `alertHistory`, `retentionPolicies` or remove them

### Priority 3 — Wire Up Existing Tracking (Medium)

8. **Expand drive operation tracking** — Add `trackDriveOperation()` calls for update, delete, invite, remove
9. **Add feature tracking** — Instrument key user actions: search, export, file upload, collaboration, editor, canvas
10. **Wire client-side tracking methods** — Add `trackFeature()`, `trackAction()`, `trackSearch()` calls to relevant components, or remove unused methods

### Priority 4 — Improve Analytics Value (Low)

11. **Implement daily aggregates** — Add a cron job to populate `dailyAggregates` for dashboard performance
12. **Implement alerting** — Build threshold-based alerting using `alertHistory` for cost spikes, error rates
13. **Set `MONITORING_INGEST_KEY`** — Enable the background ingest queue for more detailed API metrics
14. **Add retention policies** — Implement the data retention system for subscription-tier-based cleanup

---

## 7. Architecture Assessment

### Current State

```
                     ┌─────────────────────────────────────────────┐
                     │              CLIENT SIDE                    │
                     │                                             │
                     │  ClientTracker ─── /api/track ──┐           │
                     │   (auto page views only)        │           │
                     │   (other methods unused)        │           │
                     └─────────────────────────────────┼───────────┘
                                                       │
                     ┌─────────────────────────────────┼───────────┐
                     │           SERVER SIDE            │           │
                     │                                 ▼           │
                     │  /api/track ──► activity-tracker.ts         │
                     │                    │                        │
                     │                    ▼                        │
                     │            writeUserActivity()              │
                     │                    │                        │
                     │                    ▼                        │
                     │           userActivities table    ✅        │
                     │                                             │
                     │  monitoring middleware ──► MetricsCollector  │
                     │   (all API requests)         │              │
                     │                              ▼              │
                     │                       apiMetrics table  ✅  │
                     │                                             │
                     │  AI chat routes ──► AIMonitoring.trackUsage │
                     │   (2 of 5 routes)        │                  │
                     │                          ▼                  │
                     │                   aiUsageLogs table  ✅     │
                     │                                             │
                     │  Auth routes ──► trackAuthEvent()            │
                     │   (18+ call sites)    │                     │
                     │                       ▼                     │
                     │              userActivities table   ✅      │
                     │                                             │
                     │  ┌─ DEAD CODE ──────────────────────┐       │
                     │  │ trackAiUsage()                   │       │
                     │  │ trackSearch()                    │       │
                     │  │ trackNavigation()                │       │
                     │  │ trackApiCall()                   │       │
                     │  │ monitorAIRequest()               │       │
                     │  │ monitorDatabaseQuery()           │       │
                     │  │ trackUserActivity() (middleware)  │       │
                     │  │ trackFeatureUsage() (middleware)  │       │
                     │  │ writePerformanceMetric()         │       │
                     │  └──────────────────────────────────┘       │
                     │                                             │
                     │  ┌─ ORPHANED TABLES ────────────────┐       │
                     │  │ performanceMetrics (no writes)   │       │
                     │  │ dailyAggregates (no writes)      │       │
                     │  │ alertHistory (no writes)         │       │
                     │  │ retentionPolicies (no writes)    │       │
                     │  └──────────────────────────────────┘       │
                     └─────────────────────────────────────────────┘
```

### What Provides Value Today

| System | Value | Data Quality |
|--------|-------|-------------|
| AI usage logging (main chat + global assistant) | HIGH — cost visibility for most AI spend | DEGRADED — default model shows $0 |
| Auth event tracking | HIGH — security audit trail | GOOD |
| Page operation tracking | MEDIUM — content audit trail | GOOD |
| API metrics middleware | MEDIUM — performance monitoring | GOOD |
| Client page-view tracking | LOW — counts pageviews but no engagement depth | FAIR |
| Enterprise audit trail | HIGH — rollback + compliance | GOOD |

### What Provides Little/No Value Today

| System | Issue |
|--------|-------|
| 9 dead tracking functions | Confusion about canonical tracking path |
| 4 orphaned database tables | Schema bloat, misleading infrastructure |
| Client-side granular tracking (click, search, timing, error) | Defined but never called from components |
| Monitoring middleware duplicate functions | Overlaps with activity-tracker, neither fully wired |
| Feature tracking | Only 2 call sites — insufficient for product analytics |
