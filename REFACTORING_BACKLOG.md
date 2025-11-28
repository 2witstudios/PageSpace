# Codebase Refactoring Backlog

This document tracks ongoing semantic reorganization work and future refactoring tasks.

## Completed

### packages/lib/src Reorganization (PR: feature/codebase-semantic-reorganization)

Moved 68 root-level files into semantic subdirectories:

- `auth/` - Authentication, OAuth, CSRF, rate limiting, device auth
- `content/` - Page content parsing, tree utils, page types, export utils
- `encryption/` - Encryption utilities
- `file-processing/` - File processor
- `logging/` - Logger, logger-browser, logger-config, logger-database
- `monitoring/` - AI monitoring, activity tracker, context calculator
- `notifications/` - Notification system, guards, types
- `permissions/` - Permissions, cached permissions
- `sheets/` - Spreadsheet logic
- `utils/` - General utilities, enums, api-utils

### apps/web/src/lib Reorganization (PR: feature/codebase-semantic-reorganization)

Moved 14 root-level files into semantic subdirectories:

- `auth/` - Auth utilities, auth-fetch, auth-helpers, csrf-validation
- `websocket/` - Socket utils, WebSocket connections, message schemas, security
- `monitoring/` - Admin monitoring queries and types
- `analytics/` - Client-side tracking, device fingerprinting
- `mcp/` - MCP bridge for desktop integration
- `utils/` - General utilities, formatters

---

## Pending - Naming Convention Fixes

### Hooks (apps/web/src/hooks/)

| Current | Should Be | Notes |
|---------|-----------|-------|
| `use-auth.ts` | `useAuth.ts` | kebab → camelCase |
| `use-responsive-panels.ts` | `useResponsivePanels.ts` | kebab → camelCase |
| `use-debounce.ts` | `useDebounce.ts` | kebab → camelCase |
| `use-permissions.ts` | `usePermissions.ts` | kebab → camelCase |
| `use-mobile.ts` | `useMobile.ts` | kebab → camelCase |

### Stores (apps/web/src/stores/)

| Current | Should Be | Notes |
|---------|-----------|-------|
| `notificationStore.ts` | `useNotificationStore.ts` | Add `use` prefix (Zustand convention) |
| `socketStore.ts` | `useSocketStore.ts` | Add `use` prefix (Zustand convention) |

---

## Pending - Large Files to Split

### High Priority (1000+ lines)

| File | Lines | Suggested Split |
|------|-------|-----------------|
| `packages/lib/src/sheets/sheet.ts` | 2,252 | `sheet-types.ts`, `sheet-evaluation.ts`, `sheet-utils.ts` |
| `apps/web/src/components/.../SheetView.tsx` | 1,692 | `SheetGrid.tsx`, `SheetEditor.tsx`, `useSheetState.ts` |
| `apps/web/src/app/api/ai/chat/route.ts` | 1,288 | `chat-handler.ts`, `chat-middleware.ts`, `chat-validation.ts` |
| `apps/web/src/components/landing/PageSpaceDemo.tsx` | 977 | `DemoSidebar.tsx`, `DemoContent.tsx`, `demoData.ts` |

### Medium Priority (700-900 lines)

| File | Lines | Suggested Split |
|------|-------|-----------------|
| `apps/web/src/app/settings/ai/page.tsx` | 906 | `AIProviderCard.tsx`, `useAISettings.ts` |
| `apps/web/src/app/api/ai/global/[id]/messages/route.ts` | 881 | Split HTTP handlers |
| `apps/web/src/lib/ai/tools/page-write-tools.ts` | 822 | Individual tool files |
| `apps/web/src/lib/ai/core/ai-utils.ts` | 809 | Provider-specific files |
| `apps/web/src/lib/auth-fetch.ts` | 718 | `jwt-manager.ts`, `csrf-manager.ts` |

---

## Additional Organizational Issues

### components/dialogs/
- 5 flat files with no subfolder organization
- Consider organizing by feature

### components/ui/
- 33+ shadcn components in flat list
- Consider grouping by category (inputs, layout, feedback, etc.)

### stores/
- Only `page-agents/` is subfolder-organized
- Consider grouping by domain (auth, ui, document, etc.)

### Email Templates
- Exist in both `packages/lib/emails/` and `packages/lib/src/email-templates/`
- Should consolidate to one location

---

## Patterns to Follow

Based on the AI refactoring, use these patterns for future reorganization:

1. **Barrel Exports** - Each folder gets an `index.ts` with JSDoc documentation
2. **Semantic Grouping** - Group by domain/concern, not by file type
3. **Explicit Re-exports** - List exports explicitly when there are conflicts
4. **Colocated Tests** - Keep `__tests__/` folders near implementation
5. **Clear Naming** - Use consistent naming conventions (camelCase for hooks/stores)
