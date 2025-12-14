# PageSpace Test Coverage Gap Analysis

**Generated**: 2025-12-14
**Goal**: 100% Test Coverage Roadmap
**Current State**: ~149 test files, ~2,500+ tests

---

## Executive Summary

| Area | Total Files | Tested | Untested | Coverage % |
|------|------------|--------|----------|------------|
| **API Routes** | 139 | 54 | 85 | 39% |
| **Hooks** | 31 | 15 | 16 | 48% |
| **Stores** | 12 | 10 | 2 | 83% |
| **Components** | 165+ | 7 | 158+ | 4% |
| **packages/lib** | 45 | 22 | 23 | 49% |
| **apps/web/lib** | 70+ | 20 | 50+ | 29% |
| **apps/processor** | 17 | 1 | 16 | 6% |
| **apps/realtime** | 1 | 1 | 0 | 100% |
| **apps/desktop** | 9 | 6 | 3 | 67% |
| **packages/db** | 15 | 0 | 15 | 0% |

---

## SECTION 1: API Routes (85 untested routes)

**Priority**: HIGH - These are the backend entry points
**Estimated Tests**: ~500+ new tests
**Delegation**: Can be split among 8-10 workers

### 1.1 Account Routes (5 untested)
Location: `apps/web/src/app/api/account/`

| Route | Methods | Status |
|-------|---------|--------|
| `avatar/route.ts` | GET, POST, DELETE | UNTESTED |
| `devices/route.ts` | GET | UNTESTED |
| `devices/[deviceId]/route.ts` | DELETE | UNTESTED |
| `password/route.ts` | PUT | UNTESTED |
| `verification-status/route.ts` | GET | UNTESTED |

**Test File To Create**: `apps/web/src/app/api/account/__tests__/`

---

### 1.2 Admin Routes (5 untested)
Location: `apps/web/src/app/api/admin/`

| Route | Methods | Status |
|-------|---------|--------|
| `contact/route.ts` | GET | UNTESTED |
| `global-prompt/route.ts` | GET, PUT | UNTESTED |
| `schema/route.ts` | GET | UNTESTED |
| `users/route.ts` | GET | UNTESTED |
| `users/[userId]/gift-subscription/route.ts` | POST | UNTESTED |
| `users/[userId]/subscription/route.ts` | GET, PUT | UNTESTED |

**Test File To Create**: `apps/web/src/app/api/admin/__tests__/route.test.ts`

---

### 1.3 AI Routes (8 untested)
Location: `apps/web/src/app/api/ai/`

| Route | Methods | Status |
|-------|---------|--------|
| `chat/route.ts` | POST (streaming) | UNTESTED |
| `global/[id]/messages/route.ts` | GET, POST | UNTESTED |
| `page-agents/[agentId]/conversations/[conversationId]/messages/route.ts` | GET, POST | UNTESTED |
| `page-agents/consult/route.ts` | POST | UNTESTED |
| `page-agents/multi-drive/route.ts` | GET | UNTESTED |

**Test File To Create**: Multiple files in respective `__tests__/` directories

---

### 1.4 Auth Routes (9 untested)
Location: `apps/web/src/app/api/auth/`

| Route | Methods | Status |
|-------|---------|--------|
| `device/refresh/route.ts` | POST | UNTESTED |
| `google/callback/route.ts` | GET | UNTESTED |
| `google/signin/route.ts` | GET | UNTESTED |
| `mcp-tokens/[tokenId]/route.ts` | DELETE | UNTESTED |
| `mobile/login/route.ts` | POST | UNTESTED |
| `mobile/oauth/google/exchange/route.ts` | POST | UNTESTED |
| `mobile/refresh/route.ts` | POST | UNTESTED |
| `mobile/signup/route.ts` | POST | UNTESTED |
| `resend-verification/route.ts` | POST | UNTESTED |

---

### 1.5 Channels Routes (1 untested)
Location: `apps/web/src/app/api/channels/`

| Route | Methods | Status |
|-------|---------|--------|
| `[pageId]/messages/route.ts` | GET, POST | UNTESTED |

---

### 1.6 Connections Routes (3 untested)
Location: `apps/web/src/app/api/connections/`

| Route | Methods | Status |
|-------|---------|--------|
| `route.ts` | GET, POST | UNTESTED |
| `[connectionId]/route.ts` | GET, DELETE | UNTESTED |
| `search/route.ts` | GET | UNTESTED |

---

### 1.7 Cron Routes (1 untested)
Location: `apps/web/src/app/api/cron/`

| Route | Methods | Status |
|-------|---------|--------|
| `cleanup-tokens/route.ts` | POST | UNTESTED |

---

### 1.8 Debug Routes (1 untested)
Location: `apps/web/src/app/api/debug/`

| Route | Methods | Status |
|-------|---------|--------|
| `chat-messages/route.ts` | GET | UNTESTED |

---

### 1.9 Drives Routes (7 untested)
Location: `apps/web/src/app/api/drives/`

| Route | Methods | Status |
|-------|---------|--------|
| `[driveId]/agents/route.ts` | GET | UNTESTED |
| `[driveId]/members/invite/route.ts` | POST | UNTESTED |
| `[driveId]/pages/route.ts` | GET | UNTESTED |
| `[driveId]/permissions-tree/route.ts` | GET | UNTESTED |
| `[driveId]/restore/route.ts` | POST | UNTESTED |
| `[driveId]/trash/route.ts` | GET, DELETE | UNTESTED |

---

### 1.10 Files Routes (3 untested)
Location: `apps/web/src/app/api/files/`

| Route | Methods | Status |
|-------|---------|--------|
| `[id]/convert-to-document/route.ts` | POST | UNTESTED |
| `[id]/download/route.ts` | GET | UNTESTED |
| `[id]/view/route.ts` | GET | UNTESTED |

---

### 1.11 MCP Routes (3 untested)
Location: `apps/web/src/app/api/mcp/` and `apps/web/src/app/api/mcp-ws/`

| Route | Methods | Status |
|-------|---------|--------|
| `mcp-ws/route.ts` | GET (WebSocket) | PARTIAL (security only) |
| `mcp/documents/route.ts` | GET, PUT | UNTESTED |
| `mcp/drives/route.ts` | GET | UNTESTED |

---

### 1.12 Mentions Routes (1 untested)
Location: `apps/web/src/app/api/mentions/`

| Route | Methods | Status |
|-------|---------|--------|
| `search/route.ts` | GET | UNTESTED |

---

### 1.13 Messages Routes (3 untested)
Location: `apps/web/src/app/api/messages/`

| Route | Methods | Status |
|-------|---------|--------|
| `[conversationId]/route.ts` | GET, DELETE | UNTESTED |
| `conversations/route.ts` | GET, POST | UNTESTED |
| `threads/route.ts` | GET | UNTESTED |

---

### 1.14 Monitoring Routes (1 untested)
Location: `apps/web/src/app/api/monitoring/`

| Route | Methods | Status |
|-------|---------|--------|
| `[metric]/route.ts` | GET | UNTESTED |

---

### 1.15 Notifications Routes (4 untested)
Location: `apps/web/src/app/api/notifications/`

| Route | Methods | Status |
|-------|---------|--------|
| `route.ts` | GET | UNTESTED |
| `[id]/route.ts` | DELETE | UNTESTED |
| `[id]/read/route.ts` | POST | UNTESTED |
| `read-all/route.ts` | POST | UNTESTED |
| `unsubscribe/[token]/route.ts` | GET, POST | UNTESTED |

---

### 1.16 Pages Routes (8 untested)
Location: `apps/web/src/app/api/pages/`

| Route | Methods | Status |
|-------|---------|--------|
| `[pageId]/agent-config/route.ts` | GET, PUT | UNTESTED |
| `[pageId]/ai-usage/route.ts` | GET | UNTESTED |
| `[pageId]/breadcrumbs/route.ts` | GET | UNTESTED |
| `[pageId]/children/route.ts` | GET | UNTESTED |
| `[pageId]/processing-status/route.ts` | GET | UNTESTED |
| `[pageId]/reprocess/route.ts` | POST | UNTESTED |
| `[pageId]/restore/route.ts` | POST | UNTESTED |
| `[pageId]/tasks/[taskId]/route.ts` | GET, PUT, DELETE | UNTESTED |
| `[pageId]/tasks/reorder/route.ts` | PUT | UNTESTED |

---

### 1.17 Permissions Routes (1 untested)
Location: `apps/web/src/app/api/permissions/`

| Route | Methods | Status |
|-------|---------|--------|
| `batch/route.ts` | POST | UNTESTED |

---

### 1.18 Search Routes (2 untested)
Location: `apps/web/src/app/api/search/`

| Route | Methods | Status |
|-------|---------|--------|
| `route.ts` | GET | UNTESTED |
| `multi-drive/route.ts` | GET | UNTESTED |

---

### 1.19 Settings Routes (1 untested)
Location: `apps/web/src/app/api/settings/`

| Route | Methods | Status |
|-------|---------|--------|
| `notification-preferences/route.ts` | GET, PUT | UNTESTED |

---

### 1.20 Storage Routes (2 untested)
Location: `apps/web/src/app/api/storage/`

| Route | Methods | Status |
|-------|---------|--------|
| `check/route.ts` | GET | UNTESTED |
| `info/route.ts` | GET | UNTESTED |

---

### 1.21 Subscriptions Routes (1 untested)
Location: `apps/web/src/app/api/subscriptions/`

| Route | Methods | Status |
|-------|---------|--------|
| `usage/route.ts` | GET | UNTESTED |

---

### 1.22 Track Routes (1 untested)
Location: `apps/web/src/app/api/track/`

| Route | Methods | Status |
|-------|---------|--------|
| `route.ts` | POST | UNTESTED |

---

### 1.23 Trash Routes (2 untested)
Location: `apps/web/src/app/api/trash/`

| Route | Methods | Status |
|-------|---------|--------|
| `[pageId]/route.ts` | DELETE | UNTESTED |
| `drives/[driveId]/route.ts` | GET | UNTESTED |

---

### 1.24 Upload Routes (1 untested)
Location: `apps/web/src/app/api/upload/`

| Route | Methods | Status |
|-------|---------|--------|
| `route.ts` | POST | UNTESTED |

---

### 1.25 Users Routes (2 untested)
Location: `apps/web/src/app/api/users/`

| Route | Methods | Status |
|-------|---------|--------|
| `find/route.ts` | GET | UNTESTED |
| `search/route.ts` | GET | UNTESTED |

---

### 1.26 Internal Routes (1 untested)
Location: `apps/web/src/app/api/internal/`

| Route | Methods | Status |
|-------|---------|--------|
| `monitoring/ingest/route.ts` | POST | UNTESTED |

---

### 1.27 Misc Routes (3 untested)

| Route | Methods | Status |
|-------|---------|--------|
| `avatar/[userId]/[filename]/route.ts` | GET | UNTESTED |
| `compiled-css/route.ts` | GET | UNTESTED |
| `contact/route.ts` | POST | UNTESTED |

---

## SECTION 2: Hooks (16 untested)

**Priority**: HIGH - Critical for UI behavior
**Estimated Tests**: ~150 new tests
**Delegation**: Can be split among 2-3 workers

Location: `apps/web/src/hooks/`

### 2.1 Untested Hooks

| Hook | Complexity | Description |
|------|------------|-------------|
| `usePageAgents.ts` | HIGH | Page agent management |
| `use-responsive-panels.ts` | MEDIUM | Panel responsiveness |
| `use-debounce.ts` | LOW | Debounce utility |
| `usePageTreeSocket.ts` | HIGH | Real-time tree updates |
| `useGlobalDriveSocket.ts` | HIGH | Drive socket events |
| `useUI.ts` | LOW | UI state management |
| `usePerformanceMonitor.ts` | MEDIUM | Performance tracking |
| `useSuggestionCore.ts` | MEDIUM | Suggestion core logic |
| `useUnsavedChanges.ts` | MEDIUM | Dirty state tracking |
| `useSuggestion.ts` | MEDIUM | Suggestion UI |
| `use-token-refresh.ts` | HIGH | Token refresh logic |
| `useMCP.ts` | HIGH | MCP integration |
| `use-breakpoint.ts` | LOW | Responsive breakpoints |
| `useHasHydrated.ts` | LOW | Hydration check |
| `use-toast.ts` | LOW | Toast notifications |
| `use-mobile.ts` | LOW | Mobile detection |

**Test File To Create**: `apps/web/src/hooks/__tests__/{hookName}.test.ts`

---

## SECTION 3: Stores (2 untested)

**Priority**: MEDIUM
**Estimated Tests**: ~30 new tests
**Delegation**: 1 worker

Location: `apps/web/src/stores/`

| Store | Status |
|-------|--------|
| `useLayoutStore.ts` | UNTESTED |
| `useDocumentManagerStore.ts` | UNTESTED |

**Test File To Create**: `apps/web/src/stores/__tests__/{storeName}.test.ts`

---

## SECTION 4: Components (158+ untested)

**Priority**: MEDIUM - Large effort
**Estimated Tests**: ~800+ new tests
**Delegation**: Can be split among 10+ workers by directory

### 4.1 AI Components (~25 files)
Location: `apps/web/src/components/ai/`

**Subdirectories**:
- `page-agents/` (2 files)
- `shared/` (~20 files)
- `task/` (1 file)

**Key Files**:
- `PageAgentHistoryTab.tsx`
- `PageAgentSettingsTab.tsx`
- `TaskManagementToolRenderer.tsx`
- `AiUsageMonitor.tsx`
- `MessageRenderer.tsx`
- `AiInput.tsx`
- `ErrorBoundary.tsx`
- `GroupedToolCallsRenderer.tsx`
- `MessageEditor.tsx`
- `DeleteMessageDialog.tsx`

---

### 4.2 Admin Components (2 files)
Location: `apps/web/src/components/admin/`

- `SchemaTable.tsx`
- `ContactSubmissionsTable.tsx`

---

### 4.3 Billing Components (~5 files)
Location: `apps/web/src/components/billing/`

- `PromoCodeInput.tsx` (**HAS TEST**)
- (other billing components)

---

### 4.4 Canvas Components (1 file)
Location: `apps/web/src/components/canvas/`

- `ShadowCanvas.tsx`

---

### 4.5 Devices Components (4 files)
Location: `apps/web/src/components/devices/`

- `DeviceList.tsx`
- `DeviceRow.tsx`
- `RevokeDeviceDialog.tsx`
- `RevokeAllDevicesDialog.tsx`

---

### 4.6 Dialogs Components (4 files)
Location: `apps/web/src/components/dialogs/`

- `DeleteAccountDialog.tsx` (**HAS TEST**)
- `DriveOwnershipDialog.tsx` (**HAS TEST**)
- `DeletePageDialog.tsx` - UNTESTED
- `DeleteDriveDialog.tsx` - UNTESTED
- `RenameDialog.tsx` - UNTESTED

---

### 4.7 Editors Components (4 files)
Location: `apps/web/src/components/editors/`

- `RichEditor.tsx` - UNTESTED
- `MonacoEditor.tsx` - UNTESTED
- `Toolbar.tsx` - UNTESTED
- `TableMenu.tsx` - UNTESTED

---

### 4.8 Layout Components (~40 files)
Location: `apps/web/src/components/layout/`

**Subdirectories**:
- `left-sidebar/` (~10 files)
- `right-sidebar/` (~8 files)
- `middle-content/` (~20 files)
- `main-header/` (1 file)

**High Priority**:
- `Layout.tsx`
- `LayoutErrorBoundary.tsx`
- `NavigationProvider.tsx`
- `PageTree.tsx`
- `PageTreeItem.tsx`

---

### 4.9 Members Components (4 files)
Location: `apps/web/src/components/members/`

- `DriveMembers.tsx`
- `MemberRow.tsx`
- `PermissionsGrid.tsx`
- `UserSearch.tsx`

---

### 4.10 Mentions Components (1 file)
Location: `apps/web/src/components/mentions/`

- `SuggestionPopup.tsx`

---

### 4.11 Messages Components (2 files)
Location: `apps/web/src/components/messages/`

- `ChatInput.tsx`
- `MessagePartRenderer.tsx`

---

### 4.12 Notifications Components (2 files)
Location: `apps/web/src/components/notifications/`

- `NotificationBell.tsx`
- `VerifyEmailButton.tsx`

---

### 4.13 Providers Components (3 files)
Location: `apps/web/src/components/providers/`

- `SuggestionProvider.tsx`
- `ThemeProvider.tsx`
- `ClientTrackingProvider.tsx`

---

### 4.14 Search Components (2 files)
Location: `apps/web/src/components/search/`

- `GlobalSearch.tsx`
- `InlineSearch.tsx`

---

### 4.15 Shared Components (3 files)
Location: `apps/web/src/components/shared/`

- `AuthButtons.tsx`
- `ContactForm.tsx`
- `UserDropdown.tsx`

---

### 4.16 UI Components (shadcn)
Location: `apps/web/src/components/ui/`

**Note**: These are typically shadcn/ui components - may not need custom tests if using library defaults.

---

## SECTION 5: packages/lib (23 untested files)

**Priority**: HIGH - Core business logic
**Estimated Tests**: ~300 new tests
**Delegation**: Can be split among 3-4 workers

Location: `packages/lib/src/`

### 5.1 Auth Module (3 untested)

| File | Status |
|------|--------|
| `auth/oauth-utils.ts` | UNTESTED |
| `auth/oauth-types.ts` | UNTESTED (types only) |
| `auth/verification-utils.ts` | UNTESTED |

---

### 5.2 Content Module (2 untested)

| File | Status |
|------|--------|
| `content/export-utils.ts` | UNTESTED |
| `content/page-types.config.ts` | UNTESTED |

---

### 5.3 Logging Module (4 untested)

| File | Status |
|------|--------|
| `logging/logger.ts` | UNTESTED |
| `logging/logger-browser.ts` | UNTESTED |
| `logging/logger-config.ts` | UNTESTED |
| `logging/logger-database.ts` | UNTESTED |

---

### 5.4 Monitoring Module (3 untested)

| File | Status |
|------|--------|
| `monitoring/activity-tracker.ts` | UNTESTED |
| `monitoring/ai-context-calculator.ts` | UNTESTED |
| `monitoring/ai-monitoring.ts` | UNTESTED |

---

### 5.5 Notifications Module (1 untested)

| File | Status |
|------|--------|
| `notifications/guards.ts` | UNTESTED |

---

### 5.6 Services Module (7 untested)

| File | Status |
|------|--------|
| `services/email-service.ts` | UNTESTED |
| `services/memory-monitor.ts` | UNTESTED |
| `services/notification-email-service.ts` | UNTESTED |
| `services/page-tree-cache.ts` | UNTESTED |
| `services/service-auth.ts` | UNTESTED |
| `services/shared-redis.ts` | UNTESTED |
| `services/storage-limits.ts` | UNTESTED |
| `services/subscription-utils.ts` | UNTESTED |
| `services/upload-semaphore.ts` | UNTESTED |

---

### 5.7 Utils Module (3 untested)

| File | Status |
|------|--------|
| `utils/api-utils.ts` | UNTESTED |
| `utils/enums.ts` | UNTESTED |
| `utils/environment.ts` | UNTESTED |
| `utils/file-security.ts` | UNTESTED |
| `utils/utils.ts` | UNTESTED |

---

### 5.8 Pages Module (1 untested)

| File | Status |
|------|--------|
| `pages/circular-reference-guard.ts` | UNTESTED |

---

### 5.9 Other (1 untested)

| File | Status |
|------|--------|
| `email-templates/shared-styles.ts` | UNTESTED |

---

## SECTION 6: apps/web/src/lib (50+ untested)

**Priority**: HIGH
**Estimated Tests**: ~400 new tests
**Delegation**: Can be split among 5-6 workers

### 6.1 AI Core Module (12 untested)
Location: `apps/web/src/lib/ai/core/`

| File | Status |
|------|--------|
| `agent-awareness.ts` | UNTESTED |
| `ai-providers-config.ts` | UNTESTED |
| `ai-utils.ts` | UNTESTED |
| `complete-request-builder.ts` | UNTESTED |
| `inline-instructions.ts` | UNTESTED |
| `mcp-tool-converter.ts` | UNTESTED |
| `mention-processor.ts` | UNTESTED |
| `message-utils.ts` | UNTESTED |
| `model-capabilities.ts` | UNTESTED |
| `page-tree-context.ts` | UNTESTED |
| `schema-introspection.ts` | UNTESTED |
| `system-prompt.ts` | UNTESTED |
| `timestamp-utils.ts` | UNTESTED |
| `tool-filtering.ts` | UNTESTED |
| `types.ts` | UNTESTED (types only) |

---

### 6.2 AI Shared Module (2 untested)
Location: `apps/web/src/lib/ai/shared/`

| File | Status |
|------|--------|
| `chat-types.ts` | UNTESTED (types only) |
| `error-messages.ts` | UNTESTED |

---

### 6.3 AI Hooks Module (4 untested)
Location: `apps/web/src/lib/ai/shared/hooks/`

| File | Status |
|------|--------|
| `useMessageActions.ts` | UNTESTED |
| `useConversations.ts` | UNTESTED |
| `useMCPTools.ts` | UNTESTED |
| `useProviderSettings.ts` | UNTESTED |

---

### 6.4 Analytics Module (2 untested)
Location: `apps/web/src/lib/analytics/`

| File | Status |
|------|--------|
| `client-tracker.ts` | UNTESTED |
| `device-fingerprint.ts` | UNTESTED |

---

### 6.5 Auth Module (2 untested)
Location: `apps/web/src/lib/auth/`

| File | Status |
|------|--------|
| `auth-fetch.ts` | UNTESTED |
| `auth-helpers.ts` | UNTESTED |

---

### 6.6 Canvas Module (1 untested)
Location: `apps/web/src/lib/canvas/`

| File | Status |
|------|--------|
| `css-sanitizer.ts` | UNTESTED |

---

### 6.7 Editor Module (5 untested)
Location: `apps/web/src/lib/editor/`

| File | Status |
|------|--------|
| `prettier.ts` | UNTESTED |
| `pagination/constants.ts` | UNTESTED |
| `pagination/utils.ts` | UNTESTED |
| `pagination/PaginationExtension.ts` | UNTESTED |

---

### 6.8 Logging Module (2 untested)
Location: `apps/web/src/lib/logging/`

| File | Status |
|------|--------|
| `client-logger.ts` | UNTESTED |
| `mask.ts` | UNTESTED |

---

### 6.9 Mentions Module (1 untested)
Location: `apps/web/src/lib/mentions/`

| File | Status |
|------|--------|
| `mentionConfig.ts` | UNTESTED |

---

### 6.10 Monitoring Module (2 untested)
Location: `apps/web/src/lib/monitoring/`

| File | Status |
|------|--------|
| `monitoring-queries.ts` | UNTESTED |
| `monitoring-types.ts` | UNTESTED (types only) |

---

### 6.11 Stripe Module (2 untested)
Location: `apps/web/src/lib/stripe/`

| File | Status |
|------|--------|
| `client.ts` | UNTESTED |
| `price-config.ts` | UNTESTED |

Plus legacy files:
- `stripe-config.ts` | UNTESTED
- `stripe-customer.ts` | UNTESTED
- `stripe-errors.ts` | UNTESTED

---

### 6.12 Subscription Module (1 untested)
Location: `apps/web/src/lib/subscription/`

| File | Status |
|------|--------|
| `rate-limit-middleware.ts` | UNTESTED |

---

### 6.13 Tree Module (1 untested)
Location: `apps/web/src/lib/tree/`

| File | Status |
|------|--------|
| `sortable-tree.ts` | UNTESTED |

---

### 6.14 Utils Module (2 untested)
Location: `apps/web/src/lib/utils/`

| File | Status |
|------|--------|
| `formatters.ts` | UNTESTED |
| `utils.ts` | UNTESTED |

---

### 6.15 WebSocket Module (1 untested)
Location: `apps/web/src/lib/websocket/`

| File | Status |
|------|--------|
| `ws-security.ts` | UNTESTED |

---

## SECTION 7: apps/processor (16 untested)

**Priority**: HIGH - File processing is critical
**Estimated Tests**: ~100 new tests
**Delegation**: 1-2 workers

Location: `apps/processor/src/`

### 7.1 API Handlers (5 untested)

| File | Status |
|------|--------|
| `api/avatar.ts` | UNTESTED |
| `api/ingest.ts` | UNTESTED |
| `api/optimize.ts` | UNTESTED |
| `api/serve.ts` | UNTESTED |
| `api/upload.ts` | UNTESTED |

---

### 7.2 Middleware (2 untested)

| File | Status |
|------|--------|
| `middleware/auth.ts` | UNTESTED |
| `middleware/rate-limit.ts` | UNTESTED |

---

### 7.3 Services (2 untested)

| File | Status |
|------|--------|
| `services/file-links.ts` | UNTESTED |
| `services/rbac.ts` | UNTESTED |

---

### 7.4 Workers (4 untested)

| File | Status |
|------|--------|
| `workers/image-processor.ts` | UNTESTED |
| `workers/ocr-processor.ts` | UNTESTED |
| `workers/queue-manager.ts` | UNTESTED |
| `workers/text-extractor.ts` | UNTESTED |

---

### 7.5 Cache (1 untested)

| File | Status |
|------|--------|
| `cache/content-store.ts` | UNTESTED |

---

### 7.6 Core (2 untested)

| File | Status |
|------|--------|
| `db.ts` | UNTESTED |
| `logger.ts` | UNTESTED |
| `server.ts` | UNTESTED |

---

## SECTION 8: apps/desktop (3 untested)

**Priority**: MEDIUM
**Estimated Tests**: ~30 new tests
**Delegation**: 1 worker

Location: `apps/desktop/src/`

| File | Status |
|------|--------|
| `main/command-resolver.ts` | UNTESTED |
| `main/logger.ts` | UNTESTED |
| `main/mcp-manager.ts` | UNTESTED |
| `main/ws-client.ts` | UNTESTED |
| `preload/index.ts` | UNTESTED |
| `shared/mcp-types.ts` | UNTESTED (types only) |
| `shared/mcp-validation.ts` | UNTESTED |

---

## SECTION 9: packages/db (15 untested)

**Priority**: LOW - Schemas don't need unit tests
**Note**: Schema files typically don't need tests. Focus on query helpers if any exist.

Location: `packages/db/src/`

| File | Needs Test? |
|------|-------------|
| `schema/*.ts` | NO (schema definitions) |
| `migrate.ts` | NO (one-time migration) |
| `promote-admin.ts` | MAYBE (utility script) |
| `server.ts` | NO (connection setup) |
| `test/factories.ts` | NO (test helper) |

---

## SECTION 10: Middleware (0 additional)

Location: `apps/web/src/middleware/`

| File | Status |
|------|--------|
| `monitoring.ts` | **HAS TEST** |

---

## Delegation Strategy

### Team Structure Recommendation

| Team | Focus Area | Files | Est. Time |
|------|------------|-------|-----------|
| **Team 1** | API Routes (Auth, Account, Admin) | ~20 routes | 2-3 days |
| **Team 2** | API Routes (AI, Pages) | ~20 routes | 2-3 days |
| **Team 3** | API Routes (Drives, Files, MCP) | ~20 routes | 2-3 days |
| **Team 4** | API Routes (Remaining) | ~25 routes | 2-3 days |
| **Team 5** | Hooks | 16 hooks | 1-2 days |
| **Team 6** | packages/lib | 23 files | 2-3 days |
| **Team 7** | apps/web/lib AI | 20 files | 2-3 days |
| **Team 8** | apps/web/lib Other | 20 files | 2 days |
| **Team 9** | apps/processor | 16 files | 2-3 days |
| **Team 10** | Components (AI, Editors) | ~30 components | 3-4 days |
| **Team 11** | Components (Layout) | ~40 components | 4-5 days |
| **Team 12** | Components (Other) | ~90 components | 5-6 days |

### Priority Order

1. **Critical Path** (Week 1):
   - API Routes (Auth, Drives, Pages) - Security critical
   - packages/lib core modules
   - apps/processor

2. **High Priority** (Week 2):
   - Remaining API Routes
   - Hooks
   - apps/web/lib

3. **Medium Priority** (Week 3-4):
   - Components
   - apps/desktop
   - Stores

---

## Test File Template

```typescript
// __tests__/{filename}.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('{ModuleName}', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('{functionName}', () => {
    it('should handle valid input', () => {
      // Arrange
      // Act
      // Assert
    })

    it('should handle edge case', () => {
      // Test edge cases
    })

    it('should handle error conditions', () => {
      // Test error handling
    })
  })
})
```

---

## Summary Statistics

- **Total Source Files**: ~450+
- **Currently Tested**: ~120 (27%)
- **Tests Needed**: ~330+ files
- **Estimated New Tests**: ~2,500+
- **Target Total Tests**: ~5,000+
