# Desktop OAuth Security Improvements

**Status:** Ready for Implementation
**Priority:** P0 (Security Fix Required Before Production)
**Created:** 2025-01-18
**Author:** Claude Code Review

---

## Executive Summary

This document outlines security improvements for the PageSpace desktop app OAuth implementation. The current implementation follows the correct architectural pattern established for mobile apps (passing tokens through URL redirect), but requires security hardening around state parameter validation and token handling.

**Key Finding:** The desktop OAuth flow is architecturally sound and matches industry patterns for native applications. The primary security gap is the lack of cryptographic signing on the OAuth state parameter, which could allow tampering with platform/deviceId values.

---

## Background & Context

### Desktop Authentication Architecture

PageSpace desktop app uses **Bearer token authentication** instead of cookies to avoid CSRF validation issues in native applications. This is documented in detail in `docs/3.0-guides-and-tools/desktop-bearer-token-auth-plan.md`.

**Why Bearer Tokens for Desktop:**
- Desktop apps are native applications, not web browsers
- CSRF protection is browser-specific (prevents cross-site attacks)
- Desktop apps don't have Same-Origin Policy
- Bearer tokens in `Authorization` header require explicit JavaScript code
- This follows OAuth2 RFC 6750 and industry standards (GitHub Desktop, Slack Desktop, etc.)

### Current OAuth Flow

**Desktop OAuth Login (Google):**
1. User clicks "Continue with Google" in desktop app
2. Desktop detects platform, gets deviceId from Electron
3. Calls `/api/auth/google/signin` with `{ platform: "desktop", deviceId: "machine-id" }`
4. Server generates OAuth URL with state parameter containing platform and deviceId (base64 encoded)
5. Desktop redirects to Google OAuth page
6. User authenticates with Google
7. Google redirects to `/api/auth/google/callback?code=...&state=...`
8. Server detects `platform === "desktop"` from state
9. Server generates device token, CSRF token, access token, refresh token
10. Server redirects to `/dashboard?desktop=true&tokens=<base64-encoded-json>`
11. Desktop intercepts redirect, extracts tokens from URL
12. Desktop stores tokens in Electron encrypted storage (`safeStorage`)
13. Desktop removes tokens from URL (browser history cleaned)
14. Desktop triggers auth state refresh

**Why Tokens in URL?**
- Matches existing mobile OAuth exchange pattern (`/api/auth/mobile/oauth/google/exchange`)
- Tokens are immediately removed from URL after extraction (5-second window)
- Similar to how OAuth2 passes authorization codes through URL
- HTTPS prevents man-in-the-middle attacks
- Acceptable for short-lived redirect flow

---

## Security Vulnerabilities Identified

### P0 - CRITICAL: OAuth State Parameter Not Signed

**Vulnerability:**
The OAuth state parameter is only base64-encoded, not cryptographically signed.

**Attack Scenario:**
1. Attacker intercepts OAuth flow during redirect
2. Attacker decodes state parameter: `{ platform: "desktop", deviceId: "abc123", returnUrl: "/dashboard" }`
3. Attacker modifies to: `{ platform: "web", deviceId: "malicious-id", returnUrl: "/malicious" }`
4. Attacker re-encodes state and completes OAuth flow
5. Server trusts tampered state, potentially creating session with wrong platform or deviceId

**Impact:**
- Platform confusion (desktop session treated as web or vice versa)
- Device tracking bypass (attacker can spoof deviceId)
- Redirect hijacking (attacker can control returnUrl)

**Current Code** (`apps/web/src/app/api/auth/google/signin/route.ts`, lines 43-49):
```typescript
const stateData = {
  returnUrl: returnUrl || '/dashboard',
  platform: platform || 'web',
  ...(deviceId && { deviceId }),
};
const stateParam = Buffer.from(JSON.stringify(stateData)).toString('base64');
```

**Fix Required:** Add HMAC-SHA256 signature to state parameter before encoding.

---

### P1 - HIGH: No Validation of Decoded OAuth Tokens

**Vulnerability:**
Desktop OAuth handler decodes tokens from URL without validating structure.

**Attack Scenario:**
1. Attacker crafts malicious URL: `/dashboard?desktop=true&tokens=<malformed-base64>`
2. Desktop decodes without validation
3. Application crashes or behaves unexpectedly

**Current Code** (`apps/web/src/hooks/use-auth.ts`, line 304):
```typescript
const tokensData = JSON.parse(Buffer.from(tokensParam, 'base64').toString('utf-8'));
```

**Impact:**
- Application crashes
- Potential XSS if token fields used unsafely
- User denial of service

**Fix Required:** Add Zod schema validation before using token data.

---

### P1 - HIGH: Race Condition Between OAuth Storage and loadSession

**Vulnerability:**
Two useEffects run simultaneously on OAuth callback, potentially calling `loadSession()` before tokens are stored.

**Attack Scenario:**
1. User completes OAuth authentication
2. Desktop redirects to `/dashboard?desktop=true&tokens=...`
3. OAuth storage useEffect starts storing tokens asynchronously
4. Auth check useEffect runs simultaneously, calls `loadSession()`
5. `loadSession()` tries to fetch JWT from Electron before storage completes
6. Gets null JWT, makes API call without Bearer token
7. Server returns 401 Unauthorized

**Current Code** (`apps/web/src/hooks/use-auth.ts`, lines 290-344 and 347-360):
```typescript
// OAuth storage useEffect (line 290)
useEffect(() => {
  if (isDesktopOAuth && tokensParam) {
    (async () => {
      await window.electron.auth.storeSession({ ... });
      setIsOAuthSuccess(true); // Triggers other effect
    })();
  }
}, []);

// Auth check useEffect (line 347) - Runs independently!
useEffect(() => {
  if (!hasHydrated) return;
  if (shouldLoad || isOAuthSuccess) {
    authStoreHelpers.loadSession(isOAuthSuccess);
  }
}, [hasHydrated, isOAuthSuccess]);
```

**Impact:**
- OAuth login fails despite successful authentication
- User sees error immediately after Google authentication
- Poor user experience

**Fix Required:** Add coordination flag to ensure OAuth storage completes before loadSession is called.

---

## Implementation Plan

### Phase 1: Security Fixes (P0)

#### 1.1 Add HMAC Signing to OAuth State Parameter

**Files to Modify:**
1. `apps/web/src/app/api/auth/google/signin/route.ts`
2. `apps/web/src/app/api/auth/google/callback/route.ts`
3. `.env.example` (add documentation)

**New Environment Variable:**
```bash
# OAuth state parameter signing secret (required for production)
# Generate with: openssl rand -hex 32
OAUTH_STATE_SECRET=<64-character hex string>
```

**Implementation:**

**File: `apps/web/src/app/api/auth/google/signin/route.ts`**

Add import:
```typescript
import crypto from 'crypto';
```

Replace state encoding (lines 43-49):
```typescript
const stateData = {
  returnUrl: returnUrl || '/dashboard',
  platform: platform || 'web',
  ...(deviceId && { deviceId }),
};

// Sign state parameter with HMAC-SHA256
const statePayload = JSON.stringify(stateData);
const signature = crypto
  .createHmac('sha256', process.env.OAUTH_STATE_SECRET!)
  .update(statePayload)
  .digest('hex');

const stateWithSignature = JSON.stringify({
  data: stateData,
  sig: signature,
});

const stateParam = Buffer.from(stateWithSignature).toString('base64');
```

**File: `apps/web/src/app/api/auth/google/callback/route.ts`**

Add import:
```typescript
import crypto from 'crypto';
```

Update state parsing (lines 50-67):
```typescript
const { code: authCode, state: stateParam } = validation.data;

// Parse and verify state parameter signature
let platform: 'web' | 'desktop' = 'web';
let deviceId: string | undefined;
let returnUrl = '/dashboard';

if (stateParam) {
  try {
    const stateWithSignature = JSON.parse(
      Buffer.from(stateParam, 'base64').toString('utf-8')
    );

    // Verify HMAC signature
    const { data, sig } = stateWithSignature;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.OAUTH_STATE_SECRET!)
      .update(JSON.stringify(data))
      .digest('hex');

    if (sig !== expectedSignature) {
      loggers.auth.warn('OAuth state signature mismatch', { stateParam });
      const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || req.url;
      return NextResponse.redirect(new URL('/auth/signin?error=invalid_request', baseUrl));
    }

    // Signature valid, trust the data
    platform = data.platform || 'web';
    deviceId = data.deviceId;
    returnUrl = data.returnUrl || '/dashboard';
  } catch (error) {
    loggers.auth.warn('Failed to parse OAuth state parameter', { error, stateParam });
    // Legacy fallback: treat as simple returnUrl string
    returnUrl = stateParam;
  }
}
```

**File: `.env.example`**

Add documentation:
```bash
# OAuth Configuration
# ===================

# OAuth state parameter signing secret
# Generate a secure random value with: openssl rand -hex 32
# This prevents tampering with OAuth state during the redirect flow
# REQUIRED for production deployment
OAUTH_STATE_SECRET=your-secret-key-here-min-64-chars
```

**Testing:**
```bash
# Generate secret for local development
openssl rand -hex 32

# Add to .env.local
echo "OAUTH_STATE_SECRET=$(openssl rand -hex 32)" >> .env.local

# Test OAuth flow
1. Click "Continue with Google" in desktop app
2. Authenticate with Google
3. Verify successful login and token storage
4. Check logs for signature verification

# Test invalid signature (should fail)
1. Intercept OAuth redirect
2. Modify state parameter manually
3. Should redirect to /auth/signin?error=invalid_request
```

---

### Phase 2: Stability Fixes (P1)

#### 2.1 Add Token Validation with Zod

**Files to Modify:**
1. `apps/web/src/hooks/use-auth.ts`

**Implementation:**

Add import at top of file:
```typescript
import { z } from 'zod/v4';
```

Add schema definition before component:
```typescript
const desktopOAuthTokensSchema = z.object({
  token: z.string().min(1, "Access token is required"),
  refreshToken: z.string().min(1, "Refresh token is required"),
  csrfToken: z.string(),
  deviceToken: z.string(),
});
```

Update token decoding (line 304):
```typescript
try {
  // Decode tokens from URL
  const decodedData = JSON.parse(
    Buffer.from(tokensParam, 'base64').toString('utf-8')
  );

  // Validate token structure
  const tokensData = desktopOAuthTokensSchema.parse(decodedData);

  // Store in Electron encrypted storage
  await window.electron.auth.storeSession({
    accessToken: tokensData.token,
    refreshToken: tokensData.refreshToken,
    csrfToken: tokensData.csrfToken,
    deviceToken: tokensData.deviceToken,
  });

  // ... rest of storage logic
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('[AUTH_HOOK] Invalid OAuth token structure:', error.errors);
  } else {
    console.error('[AUTH_HOOK] Failed to decode OAuth tokens:', error);
  }

  // Redirect to signin with error
  window.location.href = '/auth/signin?error=oauth_error';
  return;
}
```

**Testing:**
```bash
# Test valid tokens (should succeed)
1. Complete Google OAuth flow
2. Verify tokens stored successfully

# Test invalid tokens (should fail gracefully)
1. Manually craft invalid token URL: /dashboard?desktop=true&tokens=aW52YWxpZA==
2. Should redirect to /auth/signin?error=oauth_error
3. Check console for Zod validation errors
```

---

#### 2.2 Fix Race Condition Between OAuth Storage and loadSession

**Files to Modify:**
1. `apps/web/src/hooks/use-auth.ts`

**Implementation:**

Add state variable (after other useState declarations, around line 267):
```typescript
const [isOAuthSuccess, setIsOAuthSuccess] = useState(() => {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('auth') === 'success';
});

// NEW: Track OAuth token storage in progress
const [isStoringOAuthTokens, setIsStoringOAuthTokens] = useState(false);
```

Update OAuth storage useEffect (line 298):
```typescript
if (isDesktopOAuth && tokensParam) {
  console.log('[AUTH_HOOK] Desktop OAuth tokens detected, storing in Electron...');

  // Mark storage in progress
  setIsStoringOAuthTokens(true);

  (async () => {
    try {
      // ... existing token decoding and storage logic ...

      console.log('[AUTH_HOOK] Desktop OAuth tokens stored successfully');

      // Trigger auth state refresh
      setIsOAuthSuccess(true);
    } catch (error) {
      console.error('[AUTH_HOOK] Failed to store desktop OAuth tokens:', error);
    } finally {
      // Mark storage complete (success or failure)
      setIsStoringOAuthTokens(false);
    }
  })();
}
```

Update auth check useEffect (line 347):
```typescript
useEffect(() => {
  // Wait for hydration
  if (!hasHydrated) return;

  // NEW: Wait for OAuth token storage to complete
  if (isStoringOAuthTokens) {
    console.log('[AUTH_HOOK] Waiting for OAuth token storage to complete...');
    return;
  }

  // Use store helper to determine if session load is needed
  const shouldLoad = authStoreHelpers.shouldLoadSession() || isOAuthSuccess;

  if (shouldLoad) {
    console.log(`[AUTH_HOOK] Loading session - hasHydrated: ${hasHydrated}, isOAuthSuccess: ${isOAuthSuccess}`);
    authStoreHelpers.loadSession(isOAuthSuccess);
  }
}, [hasHydrated, isOAuthSuccess, isStoringOAuthTokens]); // Add isStoringOAuthTokens to deps
```

**Testing:**
```bash
# Test race condition fix
1. Add console.log timing to verify execution order:
   - "OAuth storage started"
   - "OAuth storage complete"
   - "loadSession called"

2. Complete Google OAuth flow
3. Verify logs show correct order (storage completes before loadSession)
4. Verify no 401 errors immediately after OAuth login
5. Test with slow network (Chrome DevTools throttling) to ensure race condition is fixed
```

---

### Phase 3: Code Quality Improvements (P2)

#### 3.1 Replace Buffer with Browser-Native APIs

**Files to Modify:**
1. `apps/web/src/hooks/use-auth.ts`

**Why:** `Buffer` is Node.js API, not browser-native. Use `atob`/`btoa` for client-side code.

**Implementation:**

Replace base64 decoding (line 304):
```typescript
// BEFORE
const tokensData = JSON.parse(Buffer.from(tokensParam, 'base64').toString('utf-8'));

// AFTER
const tokensData = JSON.parse(atob(tokensParam));
```

**Note:** Server-side files (`google/signin/route.ts`, `google/callback/route.ts`) should KEEP using `Buffer` (Node.js native).

---

#### 3.2 Add Consistent Logging

**Files to Create:**
1. `apps/web/src/lib/client-logger.ts`

**Files to Modify:**
1. `apps/web/src/hooks/use-auth.ts`
2. `apps/web/src/components/shared/UserDropdown.tsx`
3. `apps/web/src/app/auth/signin/page.tsx`

**Implementation:**

**Create: `apps/web/src/lib/client-logger.ts`**
```typescript
/**
 * Client-side structured logger
 * Provides consistent logging format for browser console
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogMetadata {
  [key: string]: unknown;
}

class ClientLogger {
  private formatMessage(level: LogLevel, message: string, meta?: LogMetadata): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? JSON.stringify(meta) : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message} ${metaStr}`;
  }

  info(message: string, meta?: LogMetadata): void {
    console.log(this.formatMessage('info', message, meta));
  }

  warn(message: string, meta?: LogMetadata): void {
    console.warn(this.formatMessage('warn', message, meta));
  }

  error(message: string, meta?: LogMetadata): void {
    console.error(this.formatMessage('error', message, meta));
  }

  debug(message: string, meta?: LogMetadata): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(this.formatMessage('debug', message, meta));
    }
  }
}

export const logger = new ClientLogger();
```

**Update files to use logger:**

Replace `console.log/error` with `logger.info/error`:
- `use-auth.ts`: Replace all console calls
- `UserDropdown.tsx`: Replace console.error in handleSignOut
- `signin/page.tsx`: Replace console.error in handleGoogleSignIn

**Example:**
```typescript
// BEFORE
console.log('[AUTH_HOOK] Desktop OAuth tokens detected');
console.error('[Desktop Login] Token storage verification failed');

// AFTER
import { logger } from '@/lib/client-logger';

logger.info('Desktop OAuth tokens detected', { component: 'use-auth' });
logger.error('Token storage verification failed', { component: 'use-auth', context: 'desktop-login' });
```

---

#### 3.3 Extract Magic Numbers

**Files to Modify:**
1. `apps/web/src/lib/auth-fetch.ts`

**Implementation:**

Add class constant (around line 23, with other constants):
```typescript
private readonly JWT_CACHE_TTL = 5000; // 5 seconds
private readonly JWT_RETRY_DELAY_MS = 100; // 100ms retry delay
```

Update retry logic (line 537):
```typescript
// BEFORE
await new Promise(resolve => setTimeout(resolve, 100));

// AFTER
await new Promise(resolve => setTimeout(resolve, this.JWT_RETRY_DELAY_MS));
```

---

## Testing Checklist

### Security Testing

- [ ] **State Signature Validation**
  - [ ] Valid signature: OAuth completes successfully
  - [ ] Invalid signature: Redirects to /auth/signin?error=invalid_request
  - [ ] Missing signature: Handles gracefully
  - [ ] Tampered state: Detected and rejected

- [ ] **Token Validation**
  - [ ] Valid tokens: Stored successfully
  - [ ] Missing required field: Validation error, redirect to signin
  - [ ] Malformed base64: Handled gracefully
  - [ ] Invalid JSON: Handled gracefully

### Functional Testing

- [ ] **Desktop Email/Password Login**
  - [ ] Login succeeds
  - [ ] Tokens stored in Electron
  - [ ] JWT retrievable immediately after login
  - [ ] No 401 errors on first API call

- [ ] **Desktop Google OAuth Login**
  - [ ] OAuth flow completes
  - [ ] Tokens extracted from URL
  - [ ] Tokens stored in Electron
  - [ ] URL cleaned (no tokens in browser history)
  - [ ] Auth state refreshes
  - [ ] No race condition errors

- [ ] **Desktop Logout**
  - [ ] Tokens cleared from Electron storage
  - [ ] JWT cache cleared
  - [ ] Device token cleared from localStorage
  - [ ] Redirects to /auth/signin

- [ ] **Web OAuth (No Regression)**
  - [ ] Web Google OAuth still works
  - [ ] Cookies set correctly
  - [ ] No desktop-specific code affects web flow

### Performance Testing

- [ ] **JWT Caching**
  - [ ] First IPC call retrieves token
  - [ ] Subsequent calls use cache (within 5 seconds)
  - [ ] Cache cleared after token refresh

- [ ] **OAuth Flow Timing**
  - [ ] Token storage completes before loadSession
  - [ ] No race condition under slow network
  - [ ] Acceptable latency (< 1 second from redirect to auth)

---

## Rollback Plan

If issues are discovered after deployment:

1. **Revert State Signing** (if breaking OAuth flow)
   ```bash
   git revert <commit-hash>
   ```
   Remove `OAUTH_STATE_SECRET` validation, fall back to unsigned state

2. **Disable Desktop OAuth** (emergency only)
   - Hide "Continue with Google" button on desktop
   - Show email/password form only
   - Desktop users can still use regular login

3. **Monitor Logs**
   - Check for state signature validation failures
   - Monitor OAuth error rates
   - Track 401 errors after OAuth login

---

## Future Enhancements

### Consider Deep Link Protocol (Future)

**Current:** Tokens passed through URL redirect
**Alternative:** Use deep link protocol (`pagespace://oauth/callback?code=...`)

**Benefits:**
- No tokens in URL (even temporarily)
- More native app experience
- Matches mobile app patterns (iOS Universal Links, Android App Links)

**Implementation Complexity:**
- Requires custom protocol registration with OS
- More complex OAuth redirect URI configuration
- Additional testing on macOS/Windows/Linux

**Recommendation:** Consider for future release if URL token passing proves problematic in production.

### Add OAuth Provider Abstraction

**Current:** Google OAuth only
**Future:** Support multiple providers (GitHub, Microsoft, etc.)

**Pattern:**
```typescript
interface OAuthProvider {
  name: string;
  signin(platform: 'web' | 'desktop', deviceId?: string): Promise<string>;
  callback(code: string, state: string): Promise<OAuthTokens>;
}
```

---

## References

### Related Documentation
- `docs/3.0-guides-and-tools/desktop-bearer-token-auth-plan.md` - Desktop auth architecture
- `docs/2.0-architecture/authentication.md` - Authentication system overview
- `packages/lib/src/device-auth-utils.ts` - Device token implementation

### Standards & RFCs
- [OAuth 2.0 (RFC 6749)](https://datatracker.ietf.org/doc/html/rfc6749) - Authorization framework
- [OAuth 2.0 Bearer Token Usage (RFC 6750)](https://datatracker.ietf.org/doc/html/rfc6750) - Bearer token spec
- [JWT (RFC 7519)](https://datatracker.ietf.org/doc/html/rfc7519) - JSON Web Token standard
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) - Identity layer on OAuth 2.0

### Security Resources
- [OWASP OAuth2 Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Security_Cheat_Sheet.html)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)

---

## Changelog

**2025-01-18** - Initial document created
- Identified security vulnerabilities in desktop OAuth
- Defined implementation plan for fixes
- Prioritized changes (P0: Security, P1: Stability, P2: Code Quality)
