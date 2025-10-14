# Fix Plan: Auth Store Cascade & Re-render Issues

**Date**: 2025-01-13
**Status**: Ready for Implementation
**Priority**: CRITICAL - Affects all user interactions

---

## 🔴 Problems Identified

### Problem 1: useAuth() Subscribes to Entire Store (CRITICAL)

**File**: `apps/web/src/hooks/use-auth.ts:34-46`

**Issue**:
```typescript
const {
  user,
  isLoading,
  isAuthenticated,
  isRefreshing,
  hasHydrated,
  setUser,
  setLoading,
  setHydrated,
  startSession,
  endSession,
  updateActivity,
} = useAuthStore();  // ⚠️ NO SELECTOR - subscribes to ALL state changes
```

**Impact**:
- ANY auth store change → ALL 16+ components using `useAuth()` re-render
- Token refresh every 12 minutes → all components re-render → visible flash
- Auth check every 5 minutes → all components re-render → visible flash
- Activity updates every 5 seconds → potential re-renders
- Affects: Layout, UserDropdown, all page views, settings, dashboard pages

**Why It Happens**:
- Zustand without selectors subscribes to entire store
- Every property change triggers update for all subscribers
- No granularity in subscriptions

---

### Problem 2: loadSession() Creates New User Objects (HIGH)

**File**: `apps/web/src/stores/auth-store.ts:235-241`

**Issue**:
```typescript
const userData = await response.json();  // NEW object from API
set({
  user: userData,  // Always new reference, even if data identical
  isAuthenticated: true,
  lastAuthCheck: Date.now(),
});
```

**Impact**:
- Even when user data hasn't changed, new object reference triggers updates
- Compounds with Problem 1: all subscribers re-render unnecessarily
- Happens every 5-12 minutes via timers

**Why It Happens**:
- No equality check before updating store
- JSON parsing creates new objects
- Zustand compares references, not values

---

### Problem 3: useSocket() in Message Renderers (HIGH)

**Files**:
- `apps/web/src/components/ai/ConversationMessageRenderer.tsx:48`
- `apps/web/src/components/ai/CompactConversationMessageRenderer.tsx:48`

**Issue**:
```typescript
// In EVERY message component (line 48 in both)
const socket = useSocket();
```

**Impact**:
- 20 messages = 20× `useSocket()` calls = 20× socket initialization attempts
- Navigation causes mass mount/unmount → 20× cleanup + 20× reinit
- Logs spam: "🔌 Initializing Socket.IO connection" × 20
- Unnecessary for presentational components

**Why It Happens**:
- Message renderers are presentational but manage socket connections
- Socket should be managed at parent level (AiChatView, AssistantChatTab)
- Architectural misalignment

---

### Problem 4: 5-Minute Auth Check Too Aggressive (MEDIUM)

**File**: `apps/web/src/stores/auth-store.ts:60`

**Issue**:
```typescript
const AUTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
```

**Impact**:
- Triggers `loadSession()` every 5 minutes
- Combined with Problems 1 & 2 → unnecessary cascading re-renders
- Token refresh already handles auth validation (every 12 min)

**Why It Happens**:
- Overly conservative interval
- Redundant with token refresh mechanism

---

### Problem 5: Zustand Selectors Not Used in useSocket (LOW)

**File**: `apps/web/src/hooks/useSocket.ts:7-9`

**Issue**:
```typescript
const connect = useSocketStore(state => state.connect);
const disconnect = useSocketStore(state => state.disconnect);
const getSocket = useSocketStore(state => state.getSocket);
```

**Impact**:
- Creates inline selector functions on every render
- While functional, not optimal for performance
- Minor contributor to re-render cascade

---

## ✅ Solutions

### Solution 1: Add Selectors to useAuth() (CRITICAL)

**File**: `apps/web/src/hooks/use-auth.ts:34-46`

**Change**:
```typescript
// Before:
const {
  user,
  isLoading,
  isAuthenticated,
  // ...
} = useAuthStore();

// After:
const user = useAuthStore(state => state.user);
const isLoading = useAuthStore(state => state.isLoading);
const isAuthenticated = useAuthStore(state => state.isAuthenticated);
const isRefreshing = useAuthStore(state => state.isRefreshing);
const hasHydrated = useAuthStore(state => state.hasHydrated);

// Functions can still be destructured (they don't change)
const { setUser, setLoading, setHydrated, startSession, endSession, updateActivity } = useAuthStore.getState();
```

**Why This Works**:
- Each component subscribes only to properties it uses
- `user` change only affects components that read `user`
- `isLoading` change only affects components that read `isLoading`
- Eliminates mass re-renders on every auth store update

**Expected Impact**:
- 90% reduction in unnecessary re-renders
- No more flashing during idle token refresh
- Smoother navigation

---

### Solution 2: Add Reference Equality Check in loadSession() (HIGH)

**File**: `apps/web/src/stores/auth-store.ts:233-241`

**Change**:
```typescript
if (response.ok) {
  const userData = await response.json();
  const currentUser = get().user;

  // Check if user data actually changed
  const hasChanged = !currentUser ||
    currentUser.id !== userData.id ||
    currentUser.name !== userData.name ||
    currentUser.email !== userData.email ||
    currentUser.image !== userData.image ||
    currentUser.emailVerified !== userData.emailVerified;

  if (hasChanged) {
    // Data changed - update everything
    set({
      user: userData,
      isAuthenticated: true,
      lastAuthCheck: Date.now(),
      failedAuthAttempts: 0,
      lastFailedAuthCheck: null,
    });
  } else {
    // Data identical - only update timestamp
    set({
      lastAuthCheck: Date.now(),
      failedAuthAttempts: 0,
      lastFailedAuthCheck: null,
    });
  }

  // Update activity for new session
  get().updateActivity();
}
```

**Why This Works**:
- Prevents new user object when data is identical
- Only triggers re-renders when data actually changes
- Maintains same reference when possible

**Expected Impact**:
- Eliminates unnecessary re-renders when auth data hasn't changed
- Preserves stable user object references across checks

---

### Solution 3: Remove useSocket() from Message Renderers (HIGH)

**Files**:
- `apps/web/src/components/ai/ConversationMessageRenderer.tsx:48`
- `apps/web/src/components/ai/CompactConversationMessageRenderer.tsx:48`

**Change**:
```typescript
// REMOVE this line:
const socket = useSocket();

// If socket is needed for functionality, pass it as prop from parent
```

**Parent Components to Handle Socket**:
- `apps/web/src/components/layout/middle-content/page-views/ai-page/AiChatView.tsx`
- `apps/web/src/components/layout/right-sidebar/ai-assistant/AssistantChatTab.tsx`

**Why This Works**:
- Message renderers are presentational components
- Socket connection management should be at parent level
- Reduces socket calls from O(N messages) to O(1)

**Expected Impact**:
- Eliminates 20+ socket initialization logs during navigation
- Cleaner component architecture
- Faster rendering

---

### Solution 4: Increase AUTH_CHECK_INTERVAL (MEDIUM)

**File**: `apps/web/src/stores/auth-store.ts:60`

**Change**:
```typescript
// Before:
const AUTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

// After:
const AUTH_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
```

**Why This Works**:
- Token refresh already validates auth every 12 minutes
- Session checks don't need to be more frequent
- Reduces unnecessary loadSession() calls

**Expected Impact**:
- Fewer unnecessary session reloads
- Reduced network requests
- Less frequent flashing opportunities

---

### Solution 5: Use getState() in useSocket (LOW)

**File**: `apps/web/src/hooks/useSocket.ts:7-9`

**Change**:
```typescript
// Before:
const connect = useSocketStore(state => state.connect);
const disconnect = useSocketStore(state => state.disconnect);
const getSocket = useSocketStore(state => state.getSocket);

// After:
useEffect(() => {
  // Get functions directly without subscribing
  const { connect, disconnect } = useSocketStore.getState();

  if (isAuthenticated && user) {
    console.log('🔌 Initializing Socket.IO connection for user:', user.id);
    connect();
    // ...
  }
}, [isAuthenticated, user?.id]);

// For return value, still use selector
return useSocketStore(state => state.socket);
```

**Why This Works**:
- Methods don't change, no need to subscribe
- Reduces unnecessary effect dependencies
- Cleaner pattern for accessing stable methods

**Expected Impact**:
- Minor performance improvement
- Clearer intent in code

---

## 📊 Expected Results

### Before Fixes:
```
Idle for 5 minutes:
  ✗ Auth check fires
  ✗ All 16+ components re-render
  ✗ Visible flash/jank
  ✗ Console spam

Idle for 12 minutes:
  ✗ Token refresh fires
  ✗ All 16+ components re-render
  ✗ Visible flash/jank
  ✗ Console spam

Navigation with 20 messages:
  ✗ 20+ socket cleanup logs
  ✗ 20+ socket init logs
  ✗ Multiple page tree rebuilds
  ✗ State loss during transitions
```

### After Fixes:
```
Idle for 15 minutes:
  ✓ Auth check fires (reduced frequency)
  ✓ Only components using changed data re-render (~2-3 instead of 16+)
  ✓ No visible flash
  ✓ Clean console logs

Idle for 12 minutes:
  ✓ Token refresh fires
  ✓ Only components using user data re-render (~5 instead of 16+)
  ✓ No visible flash (or minimal)
  ✓ Clean console logs

Navigation with 20 messages:
  ✓ 1 socket log (from parent)
  ✓ Smooth transitions
  ✓ No state loss
  ✓ Fast rendering
```

---

## 🎯 Implementation Order

### Phase 1: Critical Fixes (Immediate Impact)
1. **Solution 1**: Add selectors to useAuth()
   - Impact: 90% reduction in re-renders
   - Risk: Low (Zustand selectors are stable pattern)

2. **Solution 2**: Add reference equality check in loadSession()
   - Impact: Eliminates unnecessary user object updates
   - Risk: Low (defensive equality checking)

3. **Solution 3**: Remove useSocket() from message renderers
   - Impact: Eliminates socket spam
   - Risk: Low (presentational components shouldn't manage sockets)

### Phase 2: Optimization (Reduce Frequency)
4. **Solution 4**: Increase AUTH_CHECK_INTERVAL to 15 minutes
   - Impact: Fewer checks, less churn
   - Risk: Very low (token refresh covers validation)

5. **Solution 5**: Use getState() in useSocket
   - Impact: Minor performance improvement
   - Risk: Low (cleaner pattern)

---

## 🧪 Testing Plan

### Test 1: Idle Flashing
1. Open browser console
2. Sit completely idle for 15 minutes
3. Watch for flashing every 12 minutes (token refresh)
4. **Expected**: No visible flash or minimal flash

### Test 2: Navigation
1. Navigate between pages with AI conversations
2. Check console for socket logs
3. **Expected**:
   - Single "Initializing Socket.IO" per page (not 20+)
   - No "useSocket cleanup" spam

### Test 3: Message Sending (Stale State)
1. Wait >5 minutes on a page
2. Send an AI message
3. **Expected**:
   - Message sends successfully
   - No page refresh
   - Response visible immediately

### Test 4: Console Log Cleanliness
1. Navigate around the app
2. Check console logs
3. **Expected**:
   - Clean, minimal logs
   - No spam or repeated messages
   - Only meaningful events logged

---

## 🔄 Rollback Plan

If issues arise:

1. **useAuth() selectors causing issues?**
   - Revert to destructuring entire store
   - File: `apps/web/src/hooks/use-auth.ts`

2. **loadSession() equality check causing auth issues?**
   - Remove equality check, always update
   - File: `apps/web/src/stores/auth-store.ts`

3. **Message renderers need socket after all?**
   - Restore `useSocket()` calls
   - Files: `ConversationMessageRenderer.tsx`, `CompactConversationMessageRenderer.tsx`

All changes are isolated and can be reverted independently.

---

## 📝 Notes

- All fixes maintain existing functionality
- No breaking changes to public APIs
- TypeScript types remain unchanged
- Existing tests should pass without modification
- Performance improvements are side effects of architectural corrections

---

## ✅ Sign-off

**Reviewed by**: AI Architecture Analysis
**Approved for implementation**: Pending user confirmation
**Estimated implementation time**: 30-45 minutes
**Risk level**: Low (all changes are defensive and follow Zustand best practices)
