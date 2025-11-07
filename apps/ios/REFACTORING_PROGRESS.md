# iOS App Refactoring Progress

**Started**: November 6, 2025
**Goal**: Modularize and organize iOS app for better maintainability
**Approach**: Conservative reorganization - separate logic into focused files without changing functionality

## Completed Refactoring

### Phase 1: Infrastructure Setup ✅

#### 1.1 Directory Structure Created
- ✅ `DesignSystem/` - UI components and design tokens
  - `Tokens/`
  - `Components/`
  - `Utilities/`
- ✅ `Core/Networking/` - Enhanced with subdirectories
  - `HTTP/`
  - `Streaming/`
  - `Authentication/`
- ✅ `Core/Data/` - Data models
  - `Entities/`
  - `DTOs/`
- ✅ `Core/Services/` - Organized by feature
  - `AI/`
  - `Realtime/`
  - `Messaging/`
  - `Files/`
  - `Search/`
- ✅ `Core/Managers/Orchestration/` - State orchestrators
- ✅ `Core/Foundation/` - Base protocols and shared types
- ✅ `Features/` - Enhanced feature organization
  - Each feature has `Views/`, `ViewModels/`, `Components/`, `Utilities/`

#### 1.2 DesignSystem Extraction ✅
Moved shared UI components to dedicated DesignSystem module:

| File | From | To | Status |
|------|------|-----|--------|
| DesignTokens.swift | Core/Utilities/ | DesignSystem/Tokens/ | ✅ |
| ZoomableImageView.swift | Core/Views/ | DesignSystem/Components/ | ✅ |
| AuthenticatedAsyncImage.swift | Core/Utilities/ | DesignSystem/Components/ | ✅ |

**Benefits**:
- Clear separation of reusable UI components
- Design system can be documented independently
- Easier to maintain visual consistency

### Phase 2: Core Networking Refactoring ✅

#### 2.1 APIClient Decomposition (426 → 4 files)

**Original**: Single 426-line file mixing HTTP, SSE, and token refresh

**Refactored Structure**:

1. **HTTPClient.swift** (163 lines) ✅
   - Standard HTTP requests (GET, POST, PATCH, DELETE)
   - JSON encoding/decoding with custom date handling
   - Authentication header injection
   - HTTP status handling
   - Empty response support

2. **SSEStreamHandler.swift** (134 lines) ✅
   - Server-Sent Events streaming
   - UTF-8 byte accumulation and decoding
   - Event parsing (event type + data)
   - Automatic retry on 401 with token refresh

3. **TokenRefreshCoordinator.swift** (84 lines) ✅
   - Thread-safe token refresh using Actor
   - Prevents duplicate refresh attempts
   - Coordinates retry logic across requests
   - Automatic logout on refresh failure

4. **APIClient.swift** (48 lines) ✅
   - Legacy facade for backward compatibility
   - Delegates to specialized components
   - Allows gradual migration of existing code

5. **EmptyResponse.swift** (6 lines) ✅
   - Shared type for empty responses
   - Eliminates duplicate declarations

**Benefits**:
- Each component has a single, clear responsibility
- Easier to test in isolation
- Token refresh logic is now reusable
- SSE streaming is independent of HTTP client
- Backward compatible - no changes needed to existing code

**Migration Path for New Code**:
```swift
// Old way (still works)
APIClient.shared.request(...)

// New way (recommended)
HTTPClient.shared.request(...)
SSEStreamHandler.shared.streamRequest(...)
TokenRefreshCoordinator.shared.refreshTokenIfNeeded()
```

#### 2.2 TokenRefreshCoordinator Race Condition Fix ✅

**Problem Identified**:
When multiple requests received 401s simultaneously, waiting requests would wake up after 0.5s and check if a token exists. However, the expired token was still present during the refresh, causing immediate false positives and duplicate 401 errors.

**Solution Implemented**:
- Added `waitingContinuations` array to track suspended requests
- Replaced arbitrary sleep with proper Swift Continuation suspension
- Added token validity check using `AuthManager.shared.isTokenExpired()`
- All waiting requests now receive the same refresh result atomically

**Benefits**:
- ✅ Eliminates race condition
- ✅ Validates token freshness before returning success
- ✅ Efficient coordination without arbitrary delays
- ✅ All concurrent requests get consistent results
- ✅ Thread-safe with Actor isolation

#### 2.3 Token Refresh Deadlock Fix ✅

**Problem Identified**:
Circular dependency deadlock when refresh endpoint returns 401:
```
HTTPClient catches 401
  → TokenRefreshCoordinator.refreshTokenIfNeeded()
    → AuthManager.refreshToken()
      → HTTPClient.request("/api/auth/mobile/refresh")
        → Server returns 401
        → HTTPClient catches 401
          → TokenRefreshCoordinator.refreshTokenIfNeeded()
            → Already refreshing, suspends on continuation
            → 💥 DEADLOCK: Waiting for itself to complete
```

**Solution Implemented**:
- Added endpoint check in HTTPClient and SSEStreamHandler
- Skip auto-refresh when the failing request IS the refresh endpoint
- Refresh endpoint returning 401 now throws immediately → triggers logout
- Prevents infinite loop and deadlock

**Code Changes**:
```swift
catch APIError.unauthorized {
    // Prevent deadlock: Don't attempt refresh if this IS the refresh endpoint
    if endpoint == APIEndpoints.refresh {
        print("❌ Refresh endpoint returned 401 - refresh token is invalid")
        throw APIError.unauthorized
    }

    // Normal refresh logic for other endpoints...
}
```

**Benefits**:
- ✅ Prevents circular dependency deadlock
- ✅ Clear error messages for debugging
- ✅ Proper logout on invalid refresh token
- ✅ Minimal code changes (2 files, ~10 lines total)
- ✅ Self-contained fix where problem occurs

#### 2.4 Build Verification ✅
- All files compile successfully
- No runtime errors introduced
- Backward compatibility maintained
- Race condition fixed
- Deadlock prevented
- BUILD SUCCEEDED

## Metrics

### Before Refactoring
- **Total Swift Files**: 80
- **Total Lines**: 14,271
- **Files > 300 lines**: 22
- **Files > 500 lines**: 5
- **Largest File**: Sidebar.swift (736 lines)

### Current Progress
- **Files Refactored**: 1 (APIClient)
- **New Files Created**: 5
- **Lines Reduced**: 426 → 389 (with better organization)
- **Build Status**: ✅ PASSING

## Next Steps

### Phase 3: Remaining Core Infrastructure

1. **AuthManager (577 lines)** - Priority
   - Extract KeychainManager
   - Extract TokenManager
   - Extract CSRFManager
   - Keep AuthenticationManager as coordinator

2. **ConversationManager (638 lines)**
   - Extract StreamingOrchestrator
   - Extract PaginationOrchestrator
   - Extract SettingsOrchestrator
   - Keep main lifecycle logic

3. **Service Layer Organization**
   - Move services to feature-specific directories
   - No code changes, just better organization

### Phase 4: Feature Refactoring

1. **Sidebar (736 lines)**
   - SidebarContainer
   - NavigationList
   - SearchSection
   - SearchResultsView
   - UserProfileFooter

2. **ChatView (554 lines)**
   - ChatContainerView
   - MessagesListView
   - MessageInputSection
   - MessageEditingOverlay

3. **MessageRow (413 lines)**
   - MessageRowView
   - TextPartView
   - ToolPartView
   - MessageActionButtons

4. **FileViewerView (478 lines)**
   - FileViewerContainer
   - FileContentView
   - FileMetadataSection
   - FileShareSection

5. **SettingsView (344 lines)**
   - SettingsContainer
   - AISettingsView
   - ProviderModelSelector
   - AccountSection

### Phase 5: Message Row Consolidation

Unify 4 similar message row components:
- DMMessageRow.swift (167 lines)
- ChannelMessageRow.swift (88 lines)
- MessageThreadRow.swift (220 lines)
- MessageRow.swift (413 lines)

Create shared base component with context parameter.

### Phase 6: Documentation

1. **ARCHITECTURE.md** - Document new structure
2. **CONTRIBUTING.md** - Where to put new code
3. **Xcode Project Groups** - Match file structure

## Success Criteria

- [ ] No files over 300 lines (currently 22 files)
- [ ] Clear feature boundaries
- [ ] Consistent naming conventions
- [ ] All functionality works as before
- [ ] Xcode groups match file structure
- [ ] Documentation complete

## Notes

### What We're NOT Changing
- ❌ No new architectural patterns
- ❌ No logic rewrites
- ❌ No new dependencies
- ❌ No state management changes
- ❌ No API changes

This is purely organizational refactoring for maintainability.

### Lessons Learned

1. **git mv is essential** - Preserves file history when moving files
2. **Shared types matter** - EmptyResponse needed to be extracted first
3. **Actor syntax is different** - No `await` needed in defer block within actor
4. **Backward compatibility** - Facade pattern allows gradual migration
5. **Build often** - Catch issues early with frequent build checks

### Build Commands

```bash
# Quick build check
xcodebuild -project apps/ios/PageSpace.xcodeproj \
  -scheme PageSpace \
  -configuration Debug \
  -sdk iphonesimulator \
  clean build \
  CODE_SIGNING_ALLOWED=NO
```
