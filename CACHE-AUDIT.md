# PageSpace Cache Architecture Audit

**Audit Date:** December 3, 2025
**Auditor:** Claude Code
**Scope:** Redis, Zustand, SWR, localStorage, and all caching mechanisms

---

## Executive Summary

PageSpace employs a sophisticated multi-layer caching architecture spanning server-side Redis, client-side Zustand stores, SWR data fetching, and browser localStorage. This audit identified **4 confirmed issues** requiring attention and validated **6 suspected issues as false positives**.

### Quick Stats
| Layer | Count | Status |
|-------|-------|--------|
| Redis-backed caches | 4 | Generally well-implemented |
| Zustand stores | 11 | Good patterns, minor cleanup needed |
| SWR data hooks | 20+ | Inconsistent protection |
| localStorage keys | 4 | Properly managed |

### Priority Issues
| Issue | Severity | Status |
|-------|----------|--------|
| SWR editing protection inconsistency | Medium | Action Required |
| Permission cache staleness (60s) | Medium | Consider Enhancement |
| Page tree cache staleness (5min) | Medium | Consider Enhancement |
| useDirtyStore cleanup missing | Low-Medium | Action Required |

---

## 1. Redis Caching Layer

### 1.1 Shared Redis Connection

**File:** `packages/lib/src/services/shared-redis.ts`

**Configuration:**
- Client: `ioredis` v5.8.0
- Connection: Singleton pattern with lazy initialization
- Timeout: 5s connect, 3s command
- Retries: 3 per request

**Resilience Features (Well-Implemented):**
- Graceful fallback to memory-only when Redis unavailable
- Connection deduplication via promise caching
- Event handlers for connect/error/close/reconnecting
- Proper shutdown function for graceful termination

```typescript
// Connection resilience pattern (lines 67-84)
redis.on('error', () => {
  redisAvailable = false;
  loggers.api.warn('Redis unavailable, using memory-only cache');
});
```

**Verdict:** No issues. Resilience is well-implemented.

---

### 1.2 Permission Cache

**File:** `packages/lib/src/services/permission-cache.ts`

**Architecture:** Two-tier (L1: memory, L2: Redis)

| Setting | Value |
|---------|-------|
| Key prefix | `pagespace:perms:page:{userId}:{pageId}` |
| Default TTL | 60 seconds |
| Max memory entries | 1000 |
| Cleanup interval | 30 seconds |

**Cached Data:**
```typescript
{
  canView, canEdit, canShare, canDelete,
  userId, pageId, driveId, isOwner,
  cachedAt, ttl
}
```

**Features:**
- Batch operations (`getBatchPagePermissions`) to prevent N+1 queries
- Selective invalidation by user or drive
- Automatic memory cleanup

**Issue Identified:** No real-time invalidation on permission changes. Users may see stale permissions for up to 60 seconds after updates.

**Recommendation:** Add Socket.IO event listeners to invalidate cache when permissions change.

---

### 1.3 Rate Limit Cache

**File:** `packages/lib/src/services/rate-limit-cache.ts`

**Architecture:** Two-tier with atomic Redis operations

| Setting | Value |
|---------|-------|
| Key prefix | `pagespace:ratelimit:{userId}:{date}:{providerType}` |
| TTL | Dynamic (seconds until midnight UTC) |
| Reset | Daily at midnight UTC |

**Atomic Operations:**
- Uses Redis `INCR` for thread-safe increment
- Rollback on limit exceeded
- Proper UTC date handling

**Verified:** No edge case bypass at midnight. Implementation is correct.

---

### 1.4 Agent Awareness Cache

**File:** `packages/lib/src/services/agent-awareness-cache.ts`

**Architecture:** Two-tier (L1: memory, L2: Redis)

| Setting | Value |
|---------|-------|
| Key prefix | `pagespace:agents:drive:{driveId}` |
| Default TTL | 300 seconds (5 minutes) |
| Max memory entries | 500 |

**Invalidation Triggers:**
- AI_CHAT page created/deleted
- Agent visibility toggle
- Agent definition/title changes

**Issue Identified:** 5-minute TTL means new agents may not be visible for up to 5 minutes without manual invalidation.

---

### 1.5 Page Tree Cache

**File:** `packages/lib/src/services/page-tree-cache.ts`

**Architecture:** Two-tier (L1: memory, L2: Redis)

| Setting | Value |
|---------|-------|
| Key prefix | `pagespace:tree:drive:{driveId}` |
| Default TTL | 300 seconds (5 minutes) |
| Max memory entries | 500 |

**Invalidation Triggers:**
- Page create/delete/trash/restore
- Page move (parentId change)
- Page reorder/rename
- NOT invalidated on content edits

**Issue Identified:** Tree structure updates delayed up to 5 minutes if invalidation not triggered.

---

## 2. Zustand State Management

### 2.1 Store Inventory

| Store | File | Persistence | Purpose |
|-------|------|-------------|---------|
| `useAuthStore` | `auth-store.ts` | localStorage | Auth & session |
| `useLayoutStore` | `useLayoutStore.ts` | localStorage | Navigation & panels |
| `useUIStore` | `useUIStore.ts` | localStorage | Sidebar & tree state |
| `useMCPStore` | `useMCPStore.ts` | localStorage (v2) | Per-chat MCP settings |
| `useDocumentStore` | `useDocumentStore.ts` | None | Active document |
| `useDocumentManagerStore` | `useDocumentManagerStore.ts` | None | Multi-document state |
| `useEditingStore` | `useEditingStore.ts` | None | Active sessions |
| `useSocketStore` | `socketStore.ts` | None | Socket.IO connection |
| `useNotificationStore` | `notificationStore.ts` | None | Notifications |
| `useDirtyStore` | `useDirtyStore.ts` | None | Document dirty flags |
| `useAssistantSettingsStore` | `useAssistantSettingsStore.ts` | Manual localStorage | AI settings |

---

### 2.2 Validated Implementations

#### useAuthStore (auth-store.ts)
**Claimed Issue:** Memory leak with `refreshTimeoutId`
**Verdict:** FALSE POSITIVE

Timeout is properly cleared in:
- `endSession()` (lines 136-138)
- `reset()` (lines 175-178)

```typescript
// Proper cleanup
if (state.refreshTimeoutId) {
  clearTimeout(state.refreshTimeoutId);
}
```

#### useDocumentStore (useDocumentStore.ts)
**Claimed Issue:** Module-level `saveTimeoutId` memory leak
**Verdict:** FALSE POSITIVE

Timeout is cleared before each new set (lines 27-28):
```typescript
if (saveTimeoutId) {
  clearTimeout(saveTimeoutId);
}
saveTimeoutId = setTimeout(...)
```

#### Set Serialization (useUIStore, useLayoutStore)
**Claimed Issue:** Set/Array serialization could fail
**Verdict:** FALSE POSITIVE

Proper handling with fallbacks:
```typescript
// Serialize
treeExpanded: Array.from(state.treeExpanded)

// Deserialize with fallback
treeExpanded: new Set(persistedState?.treeExpanded || [])
```

---

### 2.3 Confirmed Issues

#### useDirtyStore Cleanup Missing

**File:** `apps/web/src/stores/useDirtyStore.ts`

**Issue:** Old page IDs accumulate in `dirtyFlags` without cleanup.

```typescript
// Current implementation - no cleanup
dirtyFlags: Record<string, boolean>;
setDirty: (id, isDirty) => set((state) => ({
  dirtyFlags: { ...state.dirtyFlags, [id]: isDirty }
}));
```

**Impact:** Low-Medium. Memory grows with accumulated dirty flags.

**Recommendation:**
```typescript
// Add cleanup after successful save
clearDirty: (id: string) => set((state) => {
  const { [id]: _, ...rest } = state.dirtyFlags;
  return { dirtyFlags: rest };
});

// Or implement LRU with max size
```

---

### 2.4 useEditingStore Integration

**File:** `apps/web/src/stores/useEditingStore.ts`

This store is critical for preventing UI interruptions during editing/streaming.

**Session Types:**
- `document` - Document editing
- `ai-streaming` - AI response streaming
- `form` - Form editing
- `other` - General editing

**Key Functions:**
```typescript
isAnyEditing(): boolean    // Check document editing
isAnyStreaming(): boolean  // Check AI streaming
isAnyActive(): boolean     // Check any active session
```

**Integration Pattern:**
```typescript
// SWR protection
useSWR(key, fetcher, {
  isPaused: () => useEditingStore.getState().isAnyActive()
});
```

---

## 3. SWR Data Fetching

### 3.1 Hook Inventory

| Hook | File | Refresh | Editing Protection |
|------|------|---------|-------------------|
| `usePageTree` | `usePageTree.ts` | On demand | Yes (manual) |
| `useConversations` | `useConversations.ts` | 5s dedupe | No |
| `useAiUsage` | `useAiUsage.ts` | 15s | Yes (`isPaused`) |
| `usePageAiUsage` | `useAiUsage.ts` | 15s | Yes (`isPaused`) |
| `useBreadcrumbs` | `useBreadcrumbs.ts` | Default | No |
| `usePermissions` | `use-permissions.ts` | 60s dedupe | **No** |
| `useDevices` | `useDevices.ts` | 60s | **No** |
| `usePageAgents` | `usePageAgents.ts` | 60s | No |

### 3.2 Confirmed Issue: Inconsistent Editing Protection

**Severity:** Medium

**Hooks WITH protection:**
- `useAiUsage.ts` - Uses `isPaused: () => isAnyActive`
- `usePageTree.ts` - Manual check before invalidation

**Hooks WITHOUT protection:**
- `use-permissions.ts` - No `isPaused` guard
- `useDevices.ts` - No `isPaused` guard

**Impact:** SWR may revalidate during document editing or AI streaming, potentially causing UI disruptions.

**Recommendation:** Standardize protection across all hooks:

```typescript
// Apply to all SWR hooks with auto-revalidation
const isAnyActive = useEditingStore((state) => state.isAnyActive());

useSWR(key, fetcher, {
  isPaused: () => isAnyActive,
  revalidateOnFocus: false,
  // ... other config
});
```

---

### 3.3 SWR Configuration Patterns

**Recommended Pattern:**
```typescript
{
  isPaused: () => useEditingStore.getState().isAnyActive(),
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  dedupingInterval: 5000,
}
```

**Cache Invalidation:**
```typescript
const { cache, mutate } = useSWRConfig();

// Hard invalidation
cache.delete(swrKey);
mutate(swrKey);

// Soft invalidation (optimistic)
mutate(swrKey, newData, false);
```

---

## 4. localStorage Persistence

### 4.1 Storage Keys

| Key | Store | Data |
|-----|-------|------|
| `auth-storage` | useAuthStore | User session, activity timestamps |
| `layout-storage` | useLayoutStore | Sidebar state, tree expansion |
| `ui-store` | useUIStore | Panel visibility |
| `mcp-settings` | useMCPStore | Per-chat MCP toggles (v2) |
| `favorites-storage` | useFavorites | Favorited page IDs |
| `drive-storage` | useDriveStore | Drive list with 5-min cache |
| `pagespace:assistant:showPageTree` | useAssistantSettingsStore | Boolean flag |

### 4.2 Persistence Patterns

**Zustand Persist Middleware:**
```typescript
persist(
  storeCreator,
  {
    name: 'storage-key',
    storage: createJSONStorage(() => localStorage),
    partialize: (state) => ({ /* subset */ }),
    onRehydrateStorage: () => (state) => { /* hydration */ },
  }
)
```

**Manual Persistence:**
```typescript
// useAssistantSettingsStore pattern
localStorage.setItem('pagespace:assistant:showPageTree', String(show));
```

---

## 5. Recommendations Summary

### High Priority

#### 1. Standardize SWR Editing Protection
**Files to update:**
- `apps/web/src/hooks/use-permissions.ts`
- `apps/web/src/hooks/useDevices.ts`

**Change:**
```typescript
const isAnyActive = useEditingStore((state) => state.isAnyActive());

useSWR(key, fetcher, {
  isPaused: () => isAnyActive,
  // ... existing config
});
```

#### 2. Add useDirtyStore Cleanup
**File:** `apps/web/src/stores/useDirtyStore.ts`

**Add method:**
```typescript
clearDirty: (id: string) => set((state) => {
  const { [id]: _, ...rest } = state.dirtyFlags;
  return { dirtyFlags: rest };
}),
```

### Medium Priority

#### 3. Real-Time Permission Cache Invalidation
**File:** `packages/lib/src/services/permission-cache.ts`

Consider adding Socket.IO event listener for permission changes to clear cache immediately rather than waiting for TTL.

#### 4. Event-Driven Tree Cache Invalidation
Ensure `pageTreeCache.invalidateDriveTree()` is called on all tree-modifying operations:
- Page create/delete
- Page move/reorder
- Page rename

---

## 6. Architecture Diagrams

### Cache Flow
```
                    ┌─────────────────┐
                    │   Client App    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        ┌─────────┐    ┌─────────┐    ┌─────────┐
        │ Zustand │    │   SWR   │    │ Storage │
        │ Stores  │    │  Cache  │    │  Local  │
        └────┬────┘    └────┬────┘    └─────────┘
             │              │
             └──────┬───────┘
                    │
                    ▼
            ┌───────────────┐
            │   API Layer   │
            └───────┬───────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
        ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Memory  │ │  Redis  │ │Postgres │
   │  (L1)   │ │  (L2)   │ │  (DB)   │
   └─────────┘ └─────────┘ └─────────┘
```

### Two-Tier Cache Pattern
```
┌─────────────────────────────────────────────────┐
│                  Cache Read                      │
│                                                  │
│  1. Check L1 (Memory)                           │
│     ├── Hit → Return cached value               │
│     └── Miss → Continue to L2                   │
│                                                  │
│  2. Check L2 (Redis)                            │
│     ├── Hit → Update L1, Return value           │
│     └── Miss → Query DB, Update L1+L2           │
│                                                  │
└─────────────────────────────────────────────────┘
```

---

## 7. Testing Recommendations

### Cache Testing Checklist
- [ ] Test Redis connection failure fallback
- [ ] Verify TTL expiration behavior
- [ ] Test cache invalidation triggers
- [ ] Validate atomic rate limit operations
- [ ] Test SWR isPaused during editing
- [ ] Verify localStorage hydration
- [ ] Test Set serialization edge cases

### Test Files
- `packages/lib/src/__tests__/permission-cache.test.ts`
- `packages/lib/src/services/__tests__/rate-limit-cache.test.ts`
- `packages/lib/src/__tests__/agent-awareness-cache.test.ts`

---

## 8. Conclusion

PageSpace's caching architecture is well-designed with proper separation of concerns. The two-tier Redis/memory pattern provides excellent resilience, and Zustand stores follow good practices.

**Strengths:**
- Graceful Redis fallback to memory-only
- Proper timeout management (no memory leaks)
- Correct Set serialization/deserialization
- Atomic rate limiting operations

**Areas for Improvement:**
- Inconsistent SWR editing protection
- Missing useDirtyStore cleanup
- Consider reducing cache TTLs or adding real-time invalidation

The identified issues are all manageable with targeted fixes and do not represent architectural problems.
