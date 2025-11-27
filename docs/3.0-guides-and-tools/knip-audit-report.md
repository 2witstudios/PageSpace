# Knip Dead Code Audit Report

**Generated:** 2025-11-27
**Tool:** [Knip](https://knip.dev) v5.70.2
**Scope:** Full monorepo analysis

## Executive Summary

The Knip audit identified **35 unused files**, **30 unused dependencies**, **65 unused exports**, and **13 unused types** across the PageSpace monorepo. Addressing these issues will reduce bundle sizes, improve maintainability, and lower technical debt.

---

## 1. Unused Files (35 files)

These files exist in the codebase but are not imported anywhere:

### Desktop App (`apps/desktop`)
| File | Recommendation |
|------|---------------|
| `src/main/mcp-bridge.ts` | Delete - appears to be unused bridge code |

### Processor Service (`apps/processor`)
| File | Recommendation |
|------|---------------|
| `src/middleware/validation.ts` | Delete - validation middleware not in use |

### Realtime Service (`apps/realtime`)
| File | Recommendation |
|------|---------------|
| `src/test/socket-helpers.ts` | Keep if tests need it, otherwise delete |

### Web App (`apps/web`)
| File | Recommendation |
|------|---------------|
| `test-glm-web-search.ts` | Delete - appears to be a test/debug file |
| `src/scripts/migrate-permissions.ts` | Delete if migration completed |
| `src/lib/auth-utils.ts` | Consolidate with `@pagespace/lib/auth-utils` |
| `src/lib/cache-utils.ts` | Delete if functionality moved elsewhere |
| `src/lib/debug-utils.ts` | Delete or keep for debugging |
| `src/lib/server-auth.ts` | Delete - duplicate of lib package auth |
| `src/stores/useAssistantStore.ts` | Delete - replaced by other stores |
| `src/test/ai-helpers.ts` | Keep for tests or delete |
| `src/test/api-helpers.ts` | Keep for tests or delete |
| `src/components/ai/MCPTokenManager.tsx` | Delete if MCP moved to settings |
| `src/components/dialogs/ConfirmDialog.tsx` | Delete - use AlertDialog instead |
| `src/components/mentions/SuggestionList.tsx` | Delete if mentions redesigned |
| `src/components/sandbox/SafePreview.tsx` | Delete if not used |
| `src/components/sandbox/Sandbox.tsx` | Delete if not used |
| `src/components/shared/ThemeToggle.tsx` | Delete if using next-themes |
| `src/components/storage/StorageIndicator.tsx` | Delete if storage moved elsewhere |
| `src/lib/admin/subscription-management.ts` | Delete if moved to server |
| `src/lib/ai/conversation-state-server.ts` | Delete if conversation logic refactored |
| `src/lib/canvas/css-sanitizer-fixed.ts` | Delete if using DOMPurify |
| `src/components/layout/right-sidebar/DashboardSettingsNavigation.tsx` | Delete if navigation redesigned |
| `src/components/layout/right-sidebar/MemoizedRightPanel.tsx` | Delete if not used |
| `src/components/layout/middle-content/content-header/DriveHeader.tsx` | Delete if drive header redesigned |
| `src/components/layout/middle-content/page-views/dashboard/UserDashboardView.tsx` | Delete if dashboard redesigned |
| `src/components/layout/middle-content/page-views/drive/DriveView.tsx` | Delete if drive view redesigned |
| `src/components/layout/middle-content/page-views/drive/DriveViewHeader.tsx` | Delete if drive header redesigned |
| `src/components/layout/middle-content/page-views/drive/GridView.tsx` | Delete if grid view redesigned |
| `src/components/layout/middle-content/page-views/drive/ListView.tsx` | Delete if list view redesigned |
| `src/components/layout/middle-content/page-views/drive/types.ts` | Delete with other drive view files |

### Packages (`packages/*`)
| File | Recommendation |
|------|---------------|
| `packages/lib/src/server.ts` | Delete - exports moved to index.ts |
| `packages/lib/src/email-templates/NotificationEmail.tsx` | Keep if notifications planned |
| `packages/db/src/migrate-permissions.ts` | Delete if migration completed |
| `packages/db/src/server.ts` | Delete - db access via index.ts |

---

## 2. Unused Dependencies (20 packages)

### Desktop App (`apps/desktop`)
| Package | Action |
|---------|--------|
| `ai` | Remove - not used in desktop app |

### Processor Service (`apps/processor`)
| Package | Action |
|---------|--------|
| `jsonwebtoken` | Remove - using jose instead |
| `@types/jsonwebtoken` | Remove with jsonwebtoken |

### Realtime Service (`apps/realtime`)
| Package | Action |
|---------|--------|
| `drizzle-orm` | Keep - may be used indirectly via @pagespace/db |
| `ioredis` | Remove if not using Redis |

### Web App (`apps/web`)
| Package | Action |
|---------|--------|
| `@ai-sdk/provider` | Remove - interface types only |
| `@floating-ui/dom` | Remove - using Radix popovers |
| `@radix-ui/react-navigation-menu` | Remove if not used |
| `@radix-ui/react-slider` | Remove if not used |
| `@tiptap/extension-link` | Remove if link extension not used |
| `@tiptap/extension-list` | Remove if using built-in lists |
| `@tiptap/suggestion` | Remove if not using suggestions |
| `framer-motion` | Remove - using motion instead |
| `fuse.js` | Remove if search redesigned |
| `next-ws` | Keep - used for WebSocket patching |
| `react-dom` | Keep - required by React |
| `slate`, `slate-history`, `slate-react` | Remove - migrated to Tiptap |

### Packages (`packages/lib`)
| Package | Action |
|---------|--------|
| `pg-boss` | Remove if job queue moved elsewhere |
| `react-email` | Keep if emails are used |

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

## 6. Duplicate Exports (4 files)

These files export both named and default exports for the same value:

| File | Named Export | Default Export |
|------|--------------|----------------|
| `AgentSelector.tsx` | `AgentSelector` | `default` |
| `content-header/index.tsx` | `ViewHeader` | `default` |
| `ai-monitoring.ts` | `AIMonitoring` | `default` |
| `logger.ts` | `logger` | `default` |

**Recommendation:** Pick one export style (prefer named exports) and update imports.

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
