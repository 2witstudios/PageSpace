# Candid Commit Messages

> Real developer emotions and honest assessments in commit messages

Generated: 2026-01-22T14:51:55.511Z

## Summary

- **Total Candid Commits**: 21

### By Sentiment

| Sentiment | Count | Percentage |
|-----------|-------|------------|
| 😤 frustration | 9 | 42.9% |
| 📝 other | 6 | 28.6% |
| 😌 relief | 4 | 19.0% |
| 😄 humor | 2 | 9.5% |

---

## 😤 Frustration

### 2026-01-10: "fix(canvas): prevent infinite save loop when AI edits canvas pages (#175)"

**Commit**: `2d50e7df`
**Patterns**: stuck

**Full Message**:

```
The canvas page was getting stuck in a save loop causing toast spam.
```

**Files Changed**: Root causes:, 1. saveContent didn't include X-Socket-ID header, so the server, broadcast the update back to the same client that saved, 2. Socket listener used setContent which triggers auto-save,, causing a loop: save -> broadcast -> receive -> setContent -> save (+7 more)

### 2026-01-10: "feat(auth): add socket token endpoint for cross-origin Socket.IO auth (P2-T0)"

**Commit**: `fcf4d31d`
**Patterns**: broken

**Full Message**:

```
Fixes Socket.IO authentication broken by sameSite: 'strict' cookies.
```

**Files Changed**: When web (localhost:3000) connects to realtime (localhost:3001),, httpOnly cookies are not sent due to different origins., Solution:, - Add /api/auth/socket-token endpoint that creates short-lived tokens, - Store token hashes in new socket_tokens table (5 min expiry) (+13 more)

### 2025-12-14: "chore: consolidate test infrastructure and fix broken scripts"

**Commit**: `7f3c2686`
**Patterns**: broken

**Full Message**:

```
- Add `test` task to turbo.json so `pnpm test` works via Turbo
```

**Files Changed**: - Remove broken scripts: test:e2e, test:e2e:ui, test:security (referenced non-existent directories), - Delete orphaned playwright.config.ts and remove @playwright/test dependency, - Migrate apps/processor tests from ts-node to vitest for consistency, - Add apps/processor to vitest.workspace.ts, - Add test scripts to apps/web, apps/realtime package.json (+20 more)

### 2025-11-29: "fix(ai): resolve save button stuck in loading state after saving agent config"

**Commit**: `5e48101f`
**Patterns**: stuck

**Full Message**:

```
Refs don't trigger re-renders in React. The parent component was reading
```

**Files Changed**: isSaving from a ref, so it never knew when to update. Added a callback, prop to notify the parent when saving state changes., 🤖 Generated with [Claude Code](https://claude.com/claude-code), Co-Authored-By: Claude <noreply@anthropic.com>, apps/web/src/components/ai/page-agents/PageAgentSettingsTab.tsx (+1 more)

### 2025-11-26: "fix: switch AiUsageMonitor to pageId for agent mode in sidebar"

**Commit**: `2cc4afb5`
**Patterns**: broken

**Full Message**:

```
The sidebar's usage monitor was broken when an agent was selected
```

**Files Changed**: because it always used conversationId. Now it switches to pageId, when an agent is selected, matching how GlobalAssistantView handles it:, - Global mode: Uses conversationId for per-conversation usage, - Agent mode: Uses pageId (agent's page ID) for aggregated usage, 🤖 Generated with [Claude Code](https://claude.com/claude-code) (+2 more)

### 2025-10-20: "fixed broken stream"

**Commit**: `2f456035`
**Patterns**: broken

**Files Changed**: apps/web/src/components/layout/Layout.tsx, apps/web/src/components/layout/middle-content/page-views/canvas/CanvasPageView.tsx, apps/web/src/components/layout/middle-content/page-views/dashboard/GlobalAssistantView.tsx, apps/web/src/components/layout/right-sidebar/ai-assistant/AssistantChatTab.tsx, apps/web/src/components/layout/right-sidebar/index.tsx (+4 more)

### 2025-10-14: "fixed broken loading state for oauth"

**Commit**: `f187093c`
**Patterns**: broken

**Files Changed**: apps/web/src/hooks/use-auth.ts

### 2025-09-22: "MCP fixed without the broken web stuff too"

**Commit**: `3dcf12d9`
**Patterns**: broken

**Files Changed**: AUTHENTICATION_ISSUE_ANALYSIS.md, Tools.md, apps/web/src/app/api/agents/[agentId]/config/route.ts, apps/web/src/app/api/agents/consult/route.ts, apps/web/src/app/api/agents/create/route.ts (+20 more)

### 2025-09-12: "it technically works but right now it is crashing due to not enough ram"

**Commit**: `0dfd8fee`
**Patterns**: crashing

**Files Changed**: apps/web/package.json, apps/web/src/app/api/ai/chat/route.ts, apps/web/src/app/api/ai_conversations/[id]/messages/route.ts, apps/web/src/lib/ai/model-capabilities.ts, apps/web/src/lib/ai/tools/page-read-tools.ts (+10 more)

## 😌 Relief

### 2025-11-09: "sidebar finally fixed"

**Commit**: `21694851`
**Patterns**: finally

**Files Changed**: RIGHT_SIDEBAR_WIDTH_FIX.md, apps/web/src/components/ai/CompactMessageRenderer.module.css, apps/web/src/components/ai/MemoizedMarkdown.tsx, apps/web/src/components/layout/right-sidebar/ai-assistant/AssistantChatTab.tsx

### 2025-10-28: "finally working but needs polish. but zod saving config"

**Commit**: `847c3500`
**Patterns**: finally

**Files Changed**: apps/desktop/electron.vite.config.ts, apps/desktop/package.json, apps/desktop/src/main/index.ts, apps/desktop/src/main/mcp-manager.ts, apps/desktop/src/shared/mcp-validation.ts (+3 more)

### 2025-10-17: "saved state finally fixed and prettier doesnt show in save indicator"

**Commit**: `4d256e37`
**Patterns**: finally

**Files Changed**: apps/web/src/components/editors/RichEditor.tsx, apps/web/src/components/layout/middle-content/page-views/document/DocumentView.tsx, apps/web/src/hooks/useDocument.ts

### 2025-09-11: "docx rendering finally works"

**Commit**: `aabe4a3a`
**Patterns**: finally

**Files Changed**: apps/web/package.json, apps/web/src/components/layout/middle-content/CenterPanel.tsx, apps/web/src/components/layout/middle-content/page-views/file/viewers/DocxViewer.tsx, pnpm-lock.yaml

## 😄 Humor

### 2025-10-04: "restarted db lol"

**Commit**: `7ba124af`
**Patterns**: lol

**Files Changed**: packages/db/drizzle/0000_worried_the_anarchist.sql, packages/db/drizzle/0001_supreme_sage.sql, packages/db/drizzle/0002_living_lady_ursula.sql, packages/db/drizzle/0003_bent_senator_kelly.sql, packages/db/drizzle/0004_petite_gladiator.sql (+9 more)

### 2025-09-14: "will have to do traditional OCR i cant figure it out lol"

**Commit**: `0084a8e7`
**Patterns**: cant/can't, lol

**Files Changed**: apps/web/src/app/api/ai/chat/route.ts, apps/web/src/lib/ai/tools/page-read-tools.ts, apps/web/src/lib/ai/visual-content-utils.ts

## 📝 Other

### 2025-12-28: "fix: show AI chat action buttons after streaming completes (#144)"

**Commit**: `41bc9666`
**Patterns**: undo

**Full Message**:

```
The message action buttons (edit, delete, retry, undo) were not visible
```

**Files Changed**: after AI streaming finished because they were wrapped inside a, `{createdAt && ...}` conditional. During streaming, the AI SDK's useChat, hook creates messages without a createdAt timestamp (only populated when, saved to DB), causing the entire footer with buttons to not render., Fixed by separating the button rendering from the timestamp condition: (+4 more)

### 2025-12-28: "Unify rollback/redo into single undo mechanism (#142)"

**Commit**: `b6d41134`
**Patterns**: undo

**Full Message**:

```
* refactor: unify rollback/redo into single undo mechanism
```

**Files Changed**: - Remove confusing "Redo rollback" button - now just "Undo this change", - Allow rollback activities to be rolled back (undo the undo), - Delete separate /redo endpoint - all undo operations go through /rollback, - Simplify UI components by removing redo-specific logic, - Update tests to reflect new unified behavior (+39 more)

### 2025-12-28: "feat: add 'Rollback to this point' feature + CSRF/undo fixes (#139)"

**Commit**: `d990765e`
**Patterns**: undo

**Full Message**:

```
* feat: add "Rollback to this point" feature + CSRF/undo fixes
```

**Files Changed**: ## New Feature: Rollback to this Point, - Add rollback-to-point-service.ts with preview and execute functions, - Add /api/activities/[activityId]/rollback-to-point endpoint (GET/POST), - Add RollbackToPointDialog component showing all activities to be undone, - Integrate into ActivityItem, VersionHistoryItem, and SidebarActivityTab (+31 more)

### 2025-12-25: "fix: AI undo UI refresh and drive settings/members navigation"

**Commit**: `979fc6cb`
**Patterns**: undo

**Full Message**:

```
- Fix AI undo not re-rendering messages after success
```

**Files Changed**: - Add onUndoSuccess prop to ChatLayout and pass to ChatMessagesArea, - Implement message refresh handlers in AiChatView and GlobalAssistantView, - Add undo functionality to right sidebar (CompactMessageRenderer + SidebarChatTab), - Fix drive settings and members navigation showing blank content, - Add settings and members to full-page route regex in dashboard layout (+8 more)

### 2025-12-25: "fix: Rollback system improvements - transaction safety, idempotency, UI (#123)"

**Commit**: `8e1d4beb`
**Patterns**: undo

**Full Message**:

```
* feat: add DEBUG logging to rollback and undo features
```

**Files Changed**: Add comprehensive debug logging throughout the rollback system:, Backend services:, - ai-undo-service.ts: preview/execute lifecycle, message lookups, - rollback-service.ts: preview, permission checks, handler execution, - rollback-permissions.ts: permission decisions with context (+139 more)

### 2025-12-24: "fix: resolve AI chat undo feature not working (#122)"

**Commit**: `20372551`
**Patterns**: undo

**Full Message**:

```
* feat: add version history and rollback functionality
```

**Files Changed**: Implement comprehensive version history browsing and rollback capabilities, for PageSpace, allowing users to restore resources to previous states., ## Schema Changes, - Add 'rollback' operation to activity_operation enum, - Add rollbackFromActivityId and contentFormat fields to activity_logs (+296 more)

## Verification

```bash
# Find commits with candid messages
git log --grep="lol\|haha\|cant\|broken\|hack" --oneline -i
```