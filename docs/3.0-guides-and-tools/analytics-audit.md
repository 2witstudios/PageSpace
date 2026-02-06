# Analytics & Monitoring Audit Report

**Date:** February 2026
**Scope:** Full audit of analytics infrastructure — model spend tracking, user interaction tracking, monitoring middleware, admin dashboard, and database tables.

---

## Executive Summary

PageSpace has a comprehensive analytics infrastructure spanning 13+ database tables, server-side tracking, client-side tracking, an admin dashboard, and AI cost monitoring. However, significant portions are **not wired up**, several functions are **dead code**, and critical cost tracking has **silent failures** that cause $0 cost entries for the most-used default model.

**Headline findings:**
- **3 AI routes** have zero usage/cost tracking
- **9 dead tracking functions** removed (see Section 8)
- **4 orphaned database tables** removed from schema (see Section 8)
- Client-side tracking exists but is largely unwired
- PostHog integration recommended to replace custom client analytics (see Section 9)

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

## 2. Server-Side Tracking — Remaining Issues

After cleanup (see Section 8), the canonical tracking paths are now:

| Concern | Canonical Path | Status |
|---------|---------------|--------|
| AI usage/cost | `AIMonitoring.trackUsage()` | Active for 2 of 5 AI routes |
| User activity | `trackActivity()` in `activity-tracker.ts` | Active |
| Page operations | `trackPageOperation()` | Active |
| Drive operations | `trackDriveOperation()` | Active (create only) |
| Auth events | `trackAuthEvent()` | Active (18+ call sites) |
| Feature tracking | `trackFeature()` | Active (2 call sites) |
| API metrics | `MetricsCollector` in monitoring middleware | Active |
| Client tracking | `ClientTracker` | Active (page views only) |

The 3 untracked AI routes (`page-agents/consult`, `pulse/generate`, `pulse/cron`) still need `AIMonitoring.trackUsage()` wired in.

---

## 3. Underutilized Tracking

### 3.1 Drive Operations

`trackDriveOperation()` is only called for `create` operations. Missing tracking for: `access`, `update`, `delete`, `invite_member`, `remove_member`.

### 3.2 Feature Tracking

`trackFeature()` is called in only 2 places:
1. `/api/track` route (generic client feature events)
2. `/api/ai/chat` route (`ai_tools_used`)

No server-side feature tracking for: search usage, export usage, file uploads, collaboration features, editor features, canvas usage.

### 3.3 Client-Side Tracker Functions

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

## 4. What IS Working Well

### 4.1 AI Usage Logging (for tracked routes)
- `aiUsageLogs` table is properly populated for main chat and global assistant routes
- Token counting, cost calculation, and context tracking are comprehensive
- Billing vs. context usage distinction is well-designed
- Real-time updates via Socket.IO work correctly

### 4.2 Auth Event Tracking
- `trackAuthEvent()` is called from 18+ locations across all auth flows
- Covers: login, logout, signup, OAuth, device registration, email verification, failed attempts
- Comprehensive and well-maintained

### 4.3 Page Operation Tracking
- `trackPageOperation()` covers create, update, trash, restore, and export operations
- Properly wired in all page API routes

### 4.4 Monitoring Middleware
- API metrics collection via in-memory buffer is active and functional
- 30-second flush cycle with 1000-item buffer cap
- All API requests get timing, status code, and size tracking

### 4.5 Enterprise Audit Trail
- `activityLogs` table with hash-chain integrity is actively used
- Supports rollback functionality
- Admin export and search work correctly

### 4.6 Admin Dashboard
- All 4 dashboard tabs display data from actively populated tables
- No broken visualizations from orphaned tables (queries fall back gracefully)

---

## 5. Remaining Recommendations

### Priority 1 — Fix AI Cost Tracking

1. **Add usage tracking to 3 untracked AI routes** — `page-agents/consult`, `pulse/generate`, `pulse/cron`
2. **Log warnings for unknown model pricing** — Replace silent $0 fallback with a logged warning
3. **Audit and update pricing table** — Verify against current provider pricing pages, update date stamp

### Priority 2 — Pre-PostHog Wiring

4. **Expand drive operation tracking** — Add `trackDriveOperation()` calls for update, delete, invite, remove
5. **Remove unused client-side tracker methods** — `trackClick()`, `trackSearch()`, `trackTiming()` etc. will be replaced by PostHog

### Priority 3 — PostHog Integration (see Section 9)

---

## 6. Architecture After Cleanup

```
                     ┌─────────────────────────────────────────────┐
                     │              CLIENT SIDE                    │
                     │                                             │
                     │  ClientTracker ─── /api/track ──┐           │
                     │   (auto page views only)        │           │
                     │                                 │           │
                     │  [FUTURE] PostHog JS ───────────┼──► PostHog│
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
                     │   (2 of 5 routes — 3 need wiring)          │
                     │                          │                  │
                     │                          ▼                  │
                     │                   aiUsageLogs table  ✅     │
                     │                                             │
                     │  Auth routes ──► trackAuthEvent()            │
                     │   (18+ call sites)    │                     │
                     │                       ▼                     │
                     │              userActivities table   ✅      │
                     │                                             │
                     │  [FUTURE] PostHog Node ──────────► PostHog  │
                     └─────────────────────────────────────────────┘
```

---

## 7. What Provides Value Today

| System | Value | Data Quality |
|--------|-------|-------------|
| AI usage logging (main chat + global assistant) | HIGH | GOOD (subscription models are $0 by design) |
| Auth event tracking | HIGH — security audit trail | GOOD |
| Page operation tracking | MEDIUM — content audit trail | GOOD |
| API metrics middleware | MEDIUM — performance monitoring | GOOD |
| Enterprise audit trail | HIGH — rollback + compliance | GOOD |
| Client page-view tracking | LOW — counts pageviews but no engagement depth | FAIR |

---

## 8. Cleanup Completed (February 2026)

### Dead Functions Removed

**From `packages/lib/src/monitoring/activity-tracker.ts`:**
- `trackAiUsage()` — Never imported; `AIMonitoring.trackUsage()` is the canonical path
- `trackSearch()` — Never called; `/api/track` route calls `trackActivity()` directly
- `trackNavigation()` — Never called; client auto page-view tracking handles navigation
- `trackApiCall()` — Never called; monitoring middleware handles API metrics via `MetricsCollector`

**From `apps/web/src/middleware/monitoring.ts`:**
- `monitorAIRequest()` — Never called; AI tracking uses `AIMonitoring.trackUsage()`
- `monitorDatabaseQuery()` — Never called; no DB query instrumentation exists
- `trackUserActivity()` — Never called; duplicated `activity-tracker.ts`
- `trackFeatureUsage()` — Never called; duplicated `activity-tracker.ts`

**From `packages/lib/src/logging/logger-database.ts`:**
- `writePerformanceMetric()` — Never called; `performanceMetrics` table was never written to

### Orphaned Tables Removed from Schema

| Table | Reason |
|-------|--------|
| `performanceMetrics` | Writer existed but was never called. Dashboard uses `apiMetrics`. |
| `dailyAggregates` | No writer, no reader. Pre-computed stats never implemented. |
| `alertHistory` | No writer, no reader. Alert system never built. |
| `retentionPolicies` | No writer, no reader. Retention archival never implemented. |
| `subscriptionTierEnum` | Only used by `retentionPolicies`. |

**Note:** These tables may still exist in the database. Run `pnpm db:generate` to create a migration that drops them, then review and run the migration.

---

## 9. PostHog Integration Plan

### Why PostHog

The custom `ClientTracker` provides only auto page-view tracking. The granular methods (`trackClick`, `trackSearch`, `trackTiming`, `trackError`, `trackFeature`, `trackAction`) are defined but never wired to components. Rather than investing in wiring these up, PostHog provides:

- **Auto-capture** — clicks, form submissions, page views with zero instrumentation
- **Session replay** — understand user behavior without building custom tracking
- **Feature flags** — A/B test and progressive rollout
- **Funnels and retention** — product analytics out of the box
- **Heatmaps** — visual engagement data
- **Self-hosted option** — keeps data on your infrastructure

### What to Keep vs Replace

| Current System | Disposition | Reason |
|---------------|-------------|--------|
| `ClientTracker` + `/api/track` | **Replace with PostHog** | PostHog auto-capture is strictly better |
| `client-tracker.ts` | **Remove** | Dead methods; PostHog JS replaces all of it |
| `device-fingerprint.ts` | **Remove** | PostHog handles device/session identity |
| `userActivities` table | **Keep** | Server-side audit trail, not product analytics |
| `AIMonitoring.trackUsage()` | **Keep** | Domain-specific cost tracking PostHog can't do |
| `MetricsCollector` middleware | **Keep** | API performance monitoring, different concern |
| `activityLogs` (audit trail) | **Keep** | Enterprise compliance, hash-chain integrity |
| `trackAuthEvent()` | **Keep** | Security audit trail |
| `trackPageOperation()` | **Keep** | Content audit trail |

### Implementation Steps

**Phase 1 — Install and configure (small)**
1. `pnpm --filter web add posthog-js posthog-node`
2. Create `apps/web/src/lib/analytics/posthog.ts` — PostHog client init with project API key
3. Create `apps/web/src/components/providers/PostHogProvider.tsx` — React context provider
4. Add `PostHogProvider` to `apps/web/src/app/layout.tsx`
5. Add `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` to env

**Phase 2 — Replace client-side tracking (small)**
1. Remove `apps/web/src/lib/analytics/client-tracker.ts`
2. Remove `apps/web/src/lib/analytics/device-fingerprint.ts`
3. PostHog auto-capture handles page views, clicks, and form submissions automatically
4. Update `/api/track` route — either remove it entirely or slim it down to only handle server-side activity tracking that PostHog can't cover

**Phase 3 — Add custom events for key flows (medium)**
1. Identify user to PostHog on login: `posthog.identify(userId, { email, plan, role })`
2. Track key product events:
   - `page_created`, `page_shared`, `drive_created`
   - `ai_conversation_started`, `ai_tool_used`
   - `file_uploaded`, `search_performed`
   - `canvas_created`, `collaboration_started`
3. Set up group analytics for drives/workspaces: `posthog.group('drive', driveId, { name, memberCount })`

**Phase 4 — Server-side events (optional, medium)**
1. Create `packages/lib/src/analytics/posthog-server.ts` with PostHog Node client
2. Forward key server events that don't originate from the browser:
   - AI cost events (enriched with token/cost data)
   - Cron-triggered operations
   - Webhook-triggered events
3. This is optional — the server-side audit trail already captures these for operational purposes

### Environment Variables

```env
NEXT_PUBLIC_POSTHOG_KEY=phc_xxx            # PostHog project API key
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com  # Or self-hosted URL
```

### Self-Hosted vs Cloud

For a local-first app like PageSpace, self-hosted PostHog is worth considering:
- **Docker deployment** fits the existing Mac Studio infrastructure
- **Data stays local** — no third-party data sharing
- **Free tier** is generous for self-hosted (unlimited events)
- Tradeoff: you maintain the PostHog instance
