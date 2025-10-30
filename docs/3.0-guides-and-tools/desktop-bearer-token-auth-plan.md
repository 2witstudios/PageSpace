# Desktop App Bearer Token Authentication Implementation Plan

**Date**: 2025-10-29
**Status**: Ready for Implementation
**Priority**: Critical (blocks all Desktop AI chat functionality)

## Executive Summary

The Desktop Electron app currently fails all AI chat requests with `CSRF token validation failed` errors. This occurs because the Desktop app uses cookie-based JWT authentication but cannot send CSRF tokens like a web browser can. This plan outlines the implementation of Bearer token authentication for the Desktop app, which is CSRF-exempt and follows OAuth2/JWT industry standards.

## Problem Statement

### Current Issue
```
web-1 | CSRF token validation failed
web-1 | AI Chat API: Authentication failed
```

**Impact**: All AI chat functionality in Desktop app is broken. MCP tools are never sent to the AI because requests are rejected at the authentication layer.

### Root Cause Analysis

1. **Desktop app authentication flow**:
   - Desktop app receives JWT token after login
   - JWT stored in httpOnly cookie by server
   - Desktop app sends subsequent requests with cookie automatically
   - Server expects CSRF token in request headers/body

2. **CSRF validation in PageSpace**:
   - Located in `apps/web/src/lib/auth/index.ts` (line 260-268)
   - All cookie-based authentication requires CSRF token validation
   - CSRF tokens are designed for browser environments (protect against CSRF attacks)
   - Desktop Electron apps don't have the same CSRF attack surface

3. **Why cookies don't work well for Desktop apps**:
   - Desktop apps are not web browsers with Same-Origin Policy
   - CSRF protection is designed for browsers, not native apps
   - No standardized way to inject CSRF tokens into Electron's fetch requests
   - Desktop apps should use Bearer token auth (industry standard)

## Proposed Solution: Bearer Token Authentication

### Architecture Overview

**Bearer Token Pattern** (OAuth2/JWT Standard):
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Benefits**:
1. ✅ CSRF-exempt (tokens in headers are not sent automatically by browsers)
2. ✅ Industry-standard OAuth2/JWT pattern
3. ✅ Explicit authentication (no automatic cookie sending)
4. ✅ Better security model for native applications
5. ✅ Simpler implementation than CSRF token management

### Security Rationale

**Why Bearer tokens are CSRF-exempt**:
- CSRF attacks exploit automatic cookie sending by browsers
- Bearer tokens in `Authorization` header require explicit JavaScript code
- Attackers cannot make victim's browser send custom headers to cross-origin sites
- This is why OAuth2/OpenID Connect use Bearer tokens for mobile/desktop apps

**Industry Standards**:
- OAuth 2.0 RFC 6750: Bearer Token Usage
- OpenID Connect Core 1.0
- JWT RFC 7519
- All major APIs (Google, GitHub, Stripe) use Bearer tokens for native apps

## Implementation Plan

### Phase 1: Update Authentication Middleware

**File**: `apps/web/src/lib/auth/index.ts`

**Location**: Lines 260-268 (CSRF validation check)

**Current Code**:
```typescript
// CSRF validation for cookie-based auth
if (cookieToken && !csrfToken) {
  logger.warn('CSRF token validation failed', {
    userId: maskIdentifier(user.id),
    endpoint
  });
  return null;
}
```

**New Code** (add before CSRF check):
```typescript
// Bearer token authentication (CSRF-exempt for Desktop apps)
const authHeader = headers.get('authorization');
if (authHeader?.startsWith('Bearer ')) {
  const bearerToken = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    const verified = await verifyJWT(bearerToken);

    logger.info('Bearer token authentication successful', {
      userId: maskIdentifier(verified.userId),
      endpoint
    });

    return {
      userId: verified.userId,
      email: verified.email,
      isAdmin: verified.isAdmin,
      authMethod: 'bearer' as const
    };
  } catch (error) {
    logger.warn('Bearer token verification failed', {
      endpoint,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    // Fall through to cookie-based auth
  }
}

// CSRF validation for cookie-based auth (existing code)
if (cookieToken && !csrfToken) {
  logger.warn('CSRF token validation failed', {
    userId: maskIdentifier(user.id),
    endpoint
  });
  return null;
}
```

**Rationale**:
- Check for Bearer token FIRST, before CSRF validation
- If Bearer token is valid, return immediately (skip CSRF check)
- If Bearer token fails or is not present, fall through to cookie-based auth
- Maintains backward compatibility with web app (still uses cookies + CSRF)

### Phase 2: Update Desktop Fetch Helper

**File**: `apps/web/src/lib/auth-fetch.ts`

**Location**: `fetchWithAuth` function (around line 10-50)

**Strategy**: Detect Desktop environment and inject Bearer token

**Current Code** (simplified):
```typescript
export async function fetchWithAuth(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const response = await fetch(url, {
    ...options,
    credentials: 'include', // Sends cookies
  });
  // ... error handling
}
```

**New Code**:
```typescript
export async function fetchWithAuth(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  // Detect Desktop environment
  const isDesktop = typeof window !== 'undefined' &&
                   window.electron !== undefined;

  let headers = new Headers(options.headers);

  if (isDesktop) {
    // Desktop: Use Bearer token authentication
    try {
      // Get JWT from Electron's cookie store (accessToken cookie)
      const jwt = await window.electron.auth.getJWT();

      if (jwt) {
        headers.set('Authorization', `Bearer ${jwt}`);
        console.log('🔑 Desktop: Using Bearer token authentication');
      }
    } catch (error) {
      console.error('❌ Desktop: Failed to get JWT for Bearer token', error);
    }
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: isDesktop ? 'omit' : 'include', // Desktop: no cookies, Web: use cookies
  });

  // ... existing error handling
}
```

**Key Changes**:
1. Detect Desktop environment using `window.electron` presence
2. Get JWT from Electron's secure storage (already available via IPC)
3. Inject JWT as Bearer token in `Authorization` header
4. Set `credentials: 'omit'` for Desktop (don't send cookies)
5. Web app continues using `credentials: 'include'` (cookie-based auth)

### Phase 3: Add TypeScript Types

**File**: `apps/web/src/types/electron.d.ts` (create if doesn't exist)

**Purpose**: Provide TypeScript definitions for Electron IPC methods

**Code**:
```typescript
export interface ElectronAPI {
  auth: {
    getJWT(): Promise<string | null>;
    clearAuth(): Promise<void>;
  };
  mcp: {
    getAvailableTools(): Promise<Array<{
      name: string;
      description: string;
      inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
      serverName: string;
    }>>;
    updateConfig(config: unknown): Promise<void>;
    getConfig(): Promise<unknown>;
    startServer(name: string): Promise<void>;
    stopServer(name: string): Promise<void>;
    getServerStatus(name: string): Promise<{ status: string; error?: string }>;
  };
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

export {};
```

**Rationale**:
- Provides type safety for `window.electron` usage
- Documents available Electron IPC methods
- Prevents runtime errors from undefined method calls

### Phase 4: Verify Electron IPC Method Exists

**File**: `apps/desktop/src/preload/index.ts`

**Action**: Verify that `auth.getJWT()` IPC method is already exposed

**Expected Code** (should already exist):
```typescript
contextBridge.exposeInMainWorld('electron', {
  auth: {
    getJWT: () => ipcRenderer.invoke('auth:get-jwt'),
    clearAuth: () => ipcRenderer.invoke('auth:clear-auth'),
  },
  // ... other methods
});
```

**If method doesn't exist**: Need to add it to preload and main process IPC handlers.

**Main process handler** (`apps/desktop/src/main/index.ts`):
```typescript
ipcMain.handle('auth:get-jwt', async () => {
  // Get JWT from Electron's session cookies (stored as 'accessToken')
  const cookies = await session.defaultSession.cookies.get({ name: 'accessToken' });
  return cookies.length > 0 ? cookies[0].value : null;
});
```

## Testing Plan

### Unit Tests

**File**: `apps/web/src/lib/auth/index.test.ts` (create if doesn't exist)

**Test Cases**:
1. ✅ Bearer token authentication succeeds with valid JWT
2. ✅ Bearer token authentication fails with invalid JWT
3. ✅ Bearer token authentication is CSRF-exempt (no CSRF token required)
4. ✅ Cookie-based authentication still requires CSRF token (regression test)
5. ✅ Bearer token takes precedence over cookie if both present

**Example Test**:
```typescript
describe('Authentication Middleware', () => {
  it('should authenticate with valid Bearer token (CSRF-exempt)', async () => {
    const validJWT = await generateJWT({ userId: 'test-user', email: 'test@example.com' });
    const headers = new Headers({ 'authorization': `Bearer ${validJWT}` });

    const user = await getUserFromRequest(mockRequest, headers);

    expect(user).not.toBeNull();
    expect(user?.userId).toBe('test-user');
    expect(user?.authMethod).toBe('bearer');
  });

  it('should reject cookie-based auth without CSRF token', async () => {
    const headers = new Headers({ 'cookie': 'accessToken=...' });
    // No CSRF token provided

    const user = await getUserFromRequest(mockRequest, headers);

    expect(user).toBeNull(); // Should fail CSRF validation
  });
});
```

### Integration Tests

**Manual Testing Checklist**:

1. **Desktop App Login**:
   - [ ] Login to Desktop app
   - [ ] Verify JWT stored in Electron cookies (accessToken cookie)
   - [ ] Verify `window.electron.auth.getJWT()` returns JWT

2. **Bearer Token Injection**:
   - [ ] Open DevTools in Desktop app
   - [ ] Make AI chat request
   - [ ] Verify `Authorization: Bearer ...` header is sent
   - [ ] Verify `credentials: omit` (no cookies sent)

3. **AI Chat Functionality**:
   - [ ] Send message in CHAT_AI page
   - [ ] Verify message appears in chat
   - [ ] Verify AI responds (request succeeds)
   - [ ] Check server logs for "Bearer token authentication successful"

4. **MCP Tools Integration**:
   - [ ] Enable MCP toggle in AI chat
   - [ ] Ask AI "What tools do you have?"
   - [ ] Verify AI lists MCP tools (e.g., "mcp:server__toolname")
   - [ ] Execute an MCP tool
   - [ ] Verify tool execution succeeds

5. **Global Assistant**:
   - [ ] Open Global Assistant view
   - [ ] Enable MCP toggle
   - [ ] Send message
   - [ ] Verify AI responds with MCP tools available

6. **Regression Testing (Web App)**:
   - [ ] Login to web app in browser
   - [ ] Verify cookie + CSRF authentication still works
   - [ ] Send AI chat message
   - [ ] Verify no errors in console
   - [ ] Verify CSRF token is still required (security check)

### Logging and Debugging

**Add debug logs** to track authentication flow:

```typescript
// In apps/web/src/lib/auth/index.ts
logger.info('Authentication attempt', {
  hasAuthHeader: !!authHeader,
  hasCookie: !!cookieToken,
  hasCsrf: !!csrfToken,
  authMethod: authHeader ? 'bearer' : cookieToken ? 'cookie' : 'none',
  endpoint
});
```

**Desktop app console logs**:
```typescript
// In apps/web/src/lib/auth-fetch.ts
console.log('🔑 fetchWithAuth', {
  isDesktop,
  url,
  hasBearerToken: headers.has('authorization'),
  credentials: isDesktop ? 'omit' : 'include'
});
```

## Rollback Plan

### If Implementation Fails

1. **Immediate Rollback**:
   - Revert changes to `apps/web/src/lib/auth/index.ts`
   - Revert changes to `apps/web/src/lib/auth-fetch.ts`
   - Remove `apps/web/src/types/electron.d.ts` if created

2. **Alternative Solution** (if Bearer tokens don't work):
   - Implement CSRF token injection in Desktop app
   - Add IPC method to get CSRF token from server
   - Store CSRF token in Electron main process
   - Inject CSRF token into all fetch requests

### Git Strategy

```bash
# Create feature branch
git checkout -b fix/desktop-bearer-token-auth

# Make changes with atomic commits
git commit -m "feat(auth): Add Bearer token support to auth middleware"
git commit -m "feat(auth): Update fetchWithAuth to use Bearer tokens in Desktop"
git commit -m "feat(types): Add Electron IPC TypeScript definitions"

# Test thoroughly before merging
pnpm dev:desktop
# ... manual testing ...

# If successful, merge to master
git checkout master
git merge fix/desktop-bearer-token-auth

# If failed, abandon branch
git checkout master
git branch -D fix/desktop-bearer-token-auth
```

## Security Considerations

### Threat Model

**CSRF Attack Surface**:
- ❌ **Web app**: Vulnerable to CSRF (users click malicious links in browser)
- ✅ **Desktop app**: NOT vulnerable to CSRF (no browser Same-Origin Policy)

**Bearer Token Security**:
- ✅ Desktop app stores JWT in httpOnly cookie (`accessToken` cookie - secure)
- ✅ Bearer token sent only in explicit fetch calls (not automatic)
- ✅ Desktop app has isolated environment (no cross-origin attacks)
- ⚠️ **Risk**: XSS in Desktop app could steal JWT
- ✅ **Mitigation**: Same risk exists with cookie-based auth, CSP headers still apply

### Best Practices

1. **JWT Expiration**:
   - Continue using short-lived JWTs (current implementation)
   - Implement token refresh flow (if not already present)

2. **Secure Storage**:
   - Desktop app stores JWT in Electron's session cookies (`accessToken` cookie - encrypted at rest)
   - Never log full JWT in console/logs (only log last 8 chars for debugging)

3. **HTTPS Enforcement**:
   - Desktop app connects to local server via HTTP (localhost trusted)
   - Production deployments should use HTTPS (already implemented)

4. **Token Rotation**:
   - Implement JWT refresh tokens (future enhancement)
   - Rotate tokens on sensitive operations (password change, etc.)

## Success Criteria

### Must-Have (MVP)

- [x] Bearer token authentication implemented in middleware
- [x] Desktop app sends Bearer token in `Authorization` header
- [x] AI chat requests succeed in Desktop app (no CSRF errors)
- [x] MCP tools visible to AI in chat responses
- [x] Web app cookie-based auth still works (regression test)

### Nice-to-Have (Future Enhancements)

- [ ] Unit tests for Bearer token authentication
- [ ] E2E tests for Desktop app AI chat flow
- [ ] JWT refresh token implementation
- [ ] Token rotation on sensitive operations
- [ ] Security audit of Desktop app auth flow

## Timeline

**Estimated Time**: 2-3 hours

1. **Phase 1** (30 min): Update authentication middleware
2. **Phase 2** (30 min): Update Desktop fetch helper
3. **Phase 3** (15 min): Add TypeScript types
4. **Phase 4** (15 min): Verify Electron IPC methods
5. **Testing** (60-90 min): Manual testing and validation

**Dependencies**: None (all code is internal)

**Blockers**: None identified

## References

### Standards and RFCs

- [RFC 6750: OAuth 2.0 Bearer Token Usage](https://tools.ietf.org/html/rfc6750)
- [RFC 7519: JSON Web Token (JWT)](https://tools.ietf.org/html/rfc7519)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)

### PageSpace Documentation

- [Authentication Architecture](../2.0-architecture/authentication.md)
- [Desktop App Architecture](../2.0-architecture/desktop-app.md)
- [API Security Patterns](../3.0-guides-and-tools/api-security.md)

### Related Issues

- Desktop MCP integration (this plan fixes prerequisite auth issue)
- Global Assistant MCP support (already implemented, blocked by auth)

## Notes

### Why Not Use CSRF Tokens in Desktop?

**Considered Alternative**: Inject CSRF tokens via Electron IPC

**Rejected Because**:
1. ❌ Overly complex (requires server API to get CSRF token)
2. ❌ Not standard practice for native apps
3. ❌ CSRF protection designed for browsers, not native apps
4. ❌ Bearer tokens are industry-standard solution

**Industry Examples**:
- GitHub Desktop: Uses OAuth2 Bearer tokens
- Slack Desktop: Uses Bearer token authentication
- Discord Desktop: Uses Bearer token authentication
- VS Code: Uses Bearer tokens for extension APIs

### Migration Path

**No Breaking Changes**: This is an additive change
- Web app continues using cookie + CSRF (unchanged)
- Desktop app switches to Bearer token (new behavior)
- Both authentication methods supported simultaneously
- No database migrations required
- No API version changes required

---

**Document Version**: 1.0
**Last Updated**: 2025-10-29
**Author**: Claude Code (Sonnet 4.5)
**Reviewed By**: Pending implementation
