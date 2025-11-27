# Knip Dead Code Audit Report

**Generated:** 2025-11-27
**Tool:** [Knip](https://knip.dev) v5.70.2
**Scope:** Full monorepo analysis
**Status:** ✅ **CLEANUP COMPLETED** (2025-11-27)

## Executive Summary

The Knip audit identified **35 unused files**, **30 unused dependencies**, **65 unused exports**, and **13 unused types** across the PageSpace monorepo.

### Cleanup Results

| Category | Found | Removed | Remaining |
|----------|-------|---------|-----------|
| Unused Files | 35 | 30+ | ~5 (false positives) |
| Unused Dependencies | 30 | 15 | ~15 (false positives) |
| Duplicate Exports | 4 | 4 | 0 |
| Lines of Code | - | ~4,600 | - |

**Commits:**
- `c29cbcc` - feat: add Knip for dead code detection
- `2a6ce84` - chore: remove dead code identified by Knip audit

---

## 1. Unused Files (35 files)

These files were identified as unused. Items marked ✅ have been deleted.

### Desktop App (`apps/desktop`)
| File | Status |
|------|--------|
| `src/main/mcp-bridge.ts` | ✅ Deleted - unused stub code |

### Processor Service (`apps/processor`)
| File | Status |
|------|--------|
| `src/middleware/validation.ts` | ✅ Deleted |

### Realtime Service (`apps/realtime`)
| File | Status |
|------|--------|
| `src/test/socket-helpers.ts` | ✅ Deleted |

### Web App (`apps/web`)
| File | Status |
|------|--------|
| `test-glm-web-search.ts` | ✅ Deleted |
| `src/scripts/migrate-permissions.ts` | ✅ Deleted |
| `src/lib/auth-utils.ts` | ✅ Deleted |
| `src/lib/cache-utils.ts` | ✅ Deleted |
| `src/lib/debug-utils.ts` | ✅ Deleted |
| `src/lib/server-auth.ts` | ✅ Deleted |
| `src/stores/useAssistantStore.ts` | ✅ Deleted |
| `src/test/ai-helpers.ts` | ✅ Deleted |
| `src/test/api-helpers.ts` | ✅ Deleted |
| `src/components/ai/MCPTokenManager.tsx` | ✅ Deleted |
| `src/components/dialogs/ConfirmDialog.tsx` | ✅ Deleted |
| `src/components/mentions/SuggestionList.tsx` | ✅ Deleted |
| `src/components/sandbox/*` | ✅ Deleted (entire directory) |
| `src/components/shared/ThemeToggle.tsx` | ✅ Deleted |
| `src/components/storage/StorageIndicator.tsx` | ✅ Deleted |
| `src/lib/admin/subscription-management.ts` | ✅ Deleted |
| `src/lib/ai/conversation-state-server.ts` | ✅ Deleted |
| `src/lib/canvas/css-sanitizer-fixed.ts` | ✅ Deleted |
| `src/components/layout/right-sidebar/DashboardSettingsNavigation.tsx` | ✅ Deleted |
| `src/components/layout/right-sidebar/MemoizedRightPanel.tsx` | ✅ Deleted |
| `src/components/layout/middle-content/content-header/DriveHeader.tsx` | ✅ Deleted |
| `src/components/layout/middle-content/page-views/dashboard/UserDashboardView.tsx` | ✅ Deleted |
| `src/components/layout/middle-content/page-views/drive/*` | ✅ Deleted (entire directory) |

### Packages (`packages/*`)
| File | Status |
|------|--------|
| `packages/lib/src/server.ts` | ⚠️ Kept - used via package exports |
| `packages/lib/src/email-templates/NotificationEmail.tsx` | ⚠️ Kept - planned feature |
| `packages/db/src/migrate-permissions.ts` | ✅ Deleted |
| `packages/db/src/server.ts` | ⚠️ Kept - used via package exports |

---

## 2. Unused Dependencies (20 packages)

Items marked ✅ have been removed.

### Desktop App (`apps/desktop`)
| Package | Status |
|---------|--------|
| `ai` | ✅ Removed |

### Processor Service (`apps/processor`)
| Package | Status |
|---------|--------|
| `jsonwebtoken` | ✅ Removed |
| `@types/jsonwebtoken` | ✅ Removed |

### Realtime Service (`apps/realtime`)
| Package | Status |
|---------|--------|
| `drizzle-orm` | ✅ Removed - uses @pagespace/db instead |
| `ioredis` | ✅ Removed |

### Web App (`apps/web`)
| Package | Status |
|---------|--------|
| `@floating-ui/dom` | ✅ Removed |
| `@tiptap/extension-link` | ✅ Removed |
| `@tiptap/extension-list` | ✅ Removed |
| `@tiptap/suggestion` | ✅ Removed |
| `framer-motion` | ✅ Removed |
| `fuse.js` | ✅ Removed |
| `slate`, `slate-history`, `slate-react` | ✅ Removed |
| `@radix-ui/react-navigation-menu` | ⚠️ Kept - used by UI components |
| `@radix-ui/react-slider` | ⚠️ Kept - used by UI components |
| `next-ws` | ⚠️ Kept - used for WebSocket patching |
| `react-dom` | ⚠️ Kept - required by React |

### Packages (`packages/lib`)
| Package | Status |
|---------|--------|
| `pg-boss` | ⚠️ Kept - used in processor |
| `react-email` | ⚠️ Kept - used for emails |

---

## 3. Unused devDependencies (10 packages)

### Root (`package.json`)
| Package | Action |
|---------|--------|
| `@turbo/gen` | Remove if not using Turbo generators |
| `concurrently` | Remove if not using concurrently |
| `tsx` | Keep - used for running TypeScript scripts |
| `vite-tsconfig-paths` | Keep - used by Vitest |

### Desktop App
| Package | Action |
|---------|--------|
| `cross-env` | Remove if not used in scripts |

### Web App
| Package | Action |
|---------|--------|
| `@next/eslint-plugin-next` | Keep - used by eslint-config-next |
| `@types/react-dom` | Keep - required for TypeScript |
| `eslint` | Keep - used for linting |
| `eslint-plugin-react-hooks` | Keep - used for hooks rules |
| `tailwindcss` | Keep - required for CSS |
| `tw-animate-css` | Keep if using animations |

---

## 4. Unused Exports (65 exports)

High-impact unused exports that should be reviewed:

### Desktop App
- `clearCommandCache` in `command-resolver.ts`
- `validateServerConfig` in `mcp-validation.ts`

### Processor Service
- `requireTenantContext`, `ensureFileLinked`, `getLinkForPage`, `optimizeImageForAllPresets`, `needsOCR`

### Web App - AI System
- `buildBothModePayloads`, `isMCPTool`, `createMentionToolInstructions`, `hasMentions`, `extractPageIds`
- `getSuggestedToolCapableModels`, `formatSchemaForDisplay`
- `getWelcomeMessage`, `getErrorMessage`, `estimateSystemPromptTokens`

### Web App - Authentication
- `requireAdmin`, `isMCPAuthResult`, `isWebAuthResult`
- `checkAIRateLimit`

### Web App - Utilities
- `slugify`, `fetchJSON`, `buildTree`
- Multiple tracking functions in `client-tracker.ts`
- Multiple WebSocket functions in `ws-connections.ts`, `ws-security.ts`

### Web App - Components
- `useErrorHandler`, `withErrorBoundary` in LayoutErrorBoundary
- `withNavigation`, `NavigationLink` in NavigationProvider
- `useCanEdit`, `useCanShare`, `useCanDelete` permission hooks
- `useRenderPerformance`, `MentionConfigManager`
- Various UI hooks in `useUI.ts`

### Web App - Monitoring
- `monitorAIRequest`, `monitorDatabaseQuery`, `trackUserActivity`, `trackFeatureUsage`, `getMetricsSummary`

### Packages
- `divider` in email templates
- `requireResource` in service-auth

---

## 5. Unused Exported Types (13 types)

| Type | File | Action |
|------|------|--------|
| `FileMetadata` | `apps/processor/src/types/index.ts` | Review if needed |
| `AIModel` | `apps/web/src/lib/ai/ai-providers-config.ts` | Review if needed |
| `PageSpaceTools` | `apps/web/src/lib/ai/ai-tools.ts` | Review if needed |
| `ApiMetricsData` | `apps/web/src/lib/monitoring-types.ts` | Review if needed |
| `PerformanceMetricsData` | `apps/web/src/lib/monitoring-types.ts` | Review if needed |
| WebSocket types | `apps/web/src/lib/ws-message-schemas.ts` | Review if needed |
| `NavigateOptions` | `apps/web/src/stores/useLayoutStore.ts` | Review if needed |
| Mention types | `apps/web/src/types/mentions.ts` | Review if needed |

---

## 6. Duplicate Exports (4 files) - ✅ FIXED

All duplicate exports have been resolved by removing default exports:

| File | Status |
|------|--------|
| `AgentSelector.tsx` | ✅ Fixed - removed default export |
| `content-header/index.tsx` | ✅ Fixed - removed default export |
| `ai-monitoring.ts` | ✅ Fixed - removed default export |
| `logger.ts` | ✅ Fixed - removed default export |

---

## 7. Unresolved Imports (Test Files)

Several test files have broken imports that need fixing:

| Test File | Missing Import |
|-----------|----------------|
| `AgentSelector.test.tsx` | `@/hooks/useAgents`, `@/stores/useAgentStore` |
| `DriveOwnershipDialog.test.tsx` | `@/lib/auth-fetch` |
| Multiple API tests | `@/lib/auth` |
| `route.security.test.ts` | `@/lib/ws-connections`, `@/lib/ws-security` |

---

## Recommendations

### Immediate Actions
1. **Remove unused dependencies** - Start with clear wins like `slate`, `slate-history`, `slate-react`, `framer-motion`
2. **Delete orphaned files** - Focus on the `/drive/` view components that appear replaced
3. **Fix test imports** - Update or remove broken test files

### Short-term
1. **Consolidate duplicate exports** - Choose named or default, not both
2. **Remove unused exports** - After verifying they're truly unused
3. **Clean up unused types** - Archive or delete type definitions not in use

### Long-term
1. **Add Knip to CI** - Run `pnpm knip` in CI to prevent new dead code
2. **Set thresholds** - Configure acceptable limits for unused code
3. **Regular audits** - Schedule quarterly dead code reviews

---

## Running the Audit

```bash
# Run the full audit
pnpm knip

# Run with JSON output
pnpm knip --reporter json

# Auto-fix some issues
pnpm knip --fix
```

---

## Configuration

The Knip configuration is in `knip.json` at the project root. It's configured for the monorepo structure with workspace-specific settings.
