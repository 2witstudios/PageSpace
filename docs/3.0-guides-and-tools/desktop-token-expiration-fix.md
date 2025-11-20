# Desktop Token Expiration Fix (Version 1.0.6)

## Problem Summary

The desktop app's "Remember this device for 90 days" feature was not working as intended. Users were being logged out after a few hours instead of staying logged in for 90 days.

## Root Cause

The desktop app had an **architectural priority inversion** in its token refresh mechanism:

1. **Token Hierarchy**:
   - Access Token: 15 minutes (JWT)
   - Refresh Token: 7-30 days (JWT, rotates on every use)
   - Device Token: 90 days (JWT, long-lived)

2. **The Problem**:
   - Desktop refresh logic prioritized **refresh tokens (7-30 days)** over **device tokens (90 days)**
   - Refresh tokens rotated every 12 minutes when the scheduled refresh ran
   - Device tokens were only used as a fallback when refresh tokens failed
   - After 7-30 days of refresh token rotations, the chain would eventually expire

3. **Why It Failed**:
   - Each refresh token use created a new token and deleted the old one
   - Device token was rarely used because refresh token kept working
   - Eventually the refresh token chain expired, causing logout
   - The 90-day device token existed but was underutilized

## Solution

### 1. Invert Token Priority (`auth-fetch.ts:372-430`)

**Before**: Try refresh token first, device token as fallback
```typescript
if (refreshToken) {
  // Try refresh token
}
if (!response || response.status === 401) {
  // Fall back to device token
}
```

**After**: Try device token first, refresh token as fallback
```typescript
if (deviceToken) {
  // Try device token FIRST (90-day validity)
}
if (!response || response.status === 401) {
  // Fall back to refresh token
}
```

**Impact**: Desktop sessions now use the long-lived device token (90 days) instead of constantly rotating short-lived refresh tokens.

### 2. Increase Device Token Rotation Window (`device/refresh/route.ts:103-109`)

**Before**: Rotate when within 30 days of expiration
```typescript
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
if (deviceRecord.expiresAt && deviceRecord.expiresAt.getTime() - Date.now() < thirtyDaysMs) {
  // Rotate device token
}
```

**After**: Rotate when within 60 days of expiration
```typescript
const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
if (deviceRecord.expiresAt && deviceRecord.expiresAt.getTime() - Date.now() < sixtyDaysMs) {
  // Rotate device token
}
```

**Impact**: Device tokens rotate more proactively with 60-day overlap, ensuring reliability without waiting until the last 30 days.

### 3. Extend Desktop JWT Cache TTL (`auth-fetch.ts:30`)

**Before**: 5-second cache
```typescript
private readonly JWT_CACHE_TTL = 5000; // 5 seconds
```

**After**: 60-second cache
```typescript
private readonly JWT_CACHE_TTL = 60000; // 60 seconds - reduced Electron IPC overhead
```

**Impact**: Reduces Electron IPC overhead without compromising security (access tokens expire in 15 minutes anyway).

### 4. Add Token Validation on Session Load (`auth-store.ts:276-292`)

**Before**: 401 error immediately logs out user
```typescript
} else if (response.status === 401) {
  // Unauthorized - clear user and record failure
  set({ user: null, isAuthenticated: false });
}
```

**After**: 401 error attempts refresh before logout
```typescript
} else if (response.status === 401) {
  // For desktop: token might have expired during load, trigger refresh before logging out
  if (isDesktop && window.electron) {
    const refreshResult = await authFetch.refreshAuthSession();
    if (refreshResult.success) {
      // Retry loading session after successful refresh
      return get().loadSession(true);
    }
  }
  // Unauthorized - clear user and record failure
  set({ user: null, isAuthenticated: false });
}
```

**Impact**: Prevents race condition where token expires during initial session load, causing immediate logout.

## Testing Verification

To verify the fix works correctly:

1. **Initial Login**:
   - Log in to desktop app with "Remember this device" checked
   - Verify device token is created and stored in Electron secure storage

2. **Token Refresh Verification**:
   - Open DevTools → Network tab
   - Watch for `/api/auth/device/refresh` calls (should see these instead of `/api/auth/mobile/refresh`)
   - Verify refresh happens every ~12 minutes using device token

3. **Long-term Persistence**:
   - Leave desktop app running for 24+ hours
   - Close and reopen the app multiple times
   - Verify user remains logged in without re-authentication

4. **Device Token Rotation**:
   - For devices within 60 days of expiration, verify device token rotates
   - Check database `device_tokens` table for updated `expires_at` values

## Security Considerations

All changes maintain the existing security model:

- **A01 - Broken Access Control**: ✅ Device tokens properly validated against database
- **A02 - Cryptographic Failures**: ✅ Tokens encrypted in Electron secure storage
- **A07 - Authentication Failures**: ✅ FIXED - Token rotation no longer causes premature expiration
- **A09 - Logging Failures**: ✅ Enhanced logging for device token refresh events

## Backward Compatibility

All changes are backward compatible:

- Existing sessions continue to work
- Users with old device tokens will automatically migrate to new refresh priority
- No database migrations required
- No breaking changes to API contracts

## Related Files

**Modified Files**:
- `apps/web/src/lib/auth-fetch.ts` - Token refresh priority inversion
- `apps/web/src/app/api/auth/device/refresh/route.ts` - Device token rotation window
- `apps/web/src/stores/auth-store.ts` - Session load token validation

**API Endpoints**:
- `POST /api/auth/device/refresh` - Device token refresh (now primary for desktop)
- `POST /api/auth/mobile/refresh` - Refresh token refresh (now fallback for desktop)
- `GET /api/auth/me` - Session validation (now with retry logic)

## Deployment Notes

1. No database migrations required
2. No environment variable changes
3. Users should log in again after update to generate new device token with optimized refresh flow
4. Existing device tokens continue to work but won't benefit from priority inversion until next refresh
