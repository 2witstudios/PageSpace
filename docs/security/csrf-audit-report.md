# PageSpace CSRF Security Audit Report

**Date:** December 20, 2025
**Auditor:** Claude (Automated Security Audit)
**Scope:** Cross-Site Request Forgery (CSRF) Protection Analysis

---

## Executive Summary

PageSpace implements a **robust CSRF protection system** with enterprise-grade security mechanisms. The primary defense relies on:

1. **SameSite=strict cookies** (strongest browser-level protection)
2. **Cryptographic CSRF tokens** bound to user sessions
3. **HMAC-SHA256 signed tokens** with timing-safe comparison
4. **Automatic token rotation** and expiration (1-hour TTL)

**Overall Security Rating: STRONG with Minor Gaps**

While the core implementation is solid, this audit identified several areas requiring attention.

---

## 1. Architecture Overview

### 1.1 Authentication Mechanism

| Component | Method | CSRF Required |
|-----------|--------|---------------|
| Web Browser | Cookie-based JWT | Yes |
| Desktop App | Bearer token (Authorization header) | No (exempt) |
| MCP/External API | Bearer token (mcp_*) | No (exempt) |
| Mobile | Device tokens + Bearer | No (exempt) |

**Key Files:**
- `apps/web/src/lib/auth/index.ts` - Authentication framework
- `apps/web/src/lib/auth/csrf-validation.ts` - CSRF validation logic
- `packages/lib/src/auth/csrf-utils.ts` - Token generation utilities

### 1.2 Cookie Configuration

All authentication cookies are configured with strong security attributes:

```typescript
// apps/web/src/app/api/auth/login/route.ts:152-168
{
  httpOnly: true,           // Prevents XSS token theft
  secure: isProduction,     // HTTPS only in production
  sameSite: 'strict',       // Strongest CSRF protection
  path: '/',
  maxAge: 15 * 60,          // 15 minutes (access token)
  domain: process.env.COOKIE_DOMAIN  // Production only
}
```

### 1.3 CSRF Token Design

**Token Format:** `<randomValue>.<timestamp>.<hmacSignature>`

**Security Properties:**
- 32-byte cryptographically random value
- HMAC-SHA256 signature bound to session ID
- Session ID derived from: `userId + tokenVersion + iat`
- Timing-safe comparison prevents timing attacks
- 1-hour expiration with timestamp validation

---

## 2. Findings

### 2.1 CRITICAL: No Findings

No critical CSRF vulnerabilities were identified.

---

### 2.2 HIGH: Routes Using `authenticateHybridRequest` Without CSRF

**Issue:** Several routes accept cookie-based authentication via `authenticateHybridRequest` but don't enforce CSRF validation.

**Affected Endpoints:**

| Endpoint | Methods | Risk |
|----------|---------|------|
| `/api/ai/page-agents/[agentId]/conversations` | POST | Creates new conversations |
| `/api/ai/page-agents/[agentId]/conversations/[conversationId]` | PATCH, DELETE | Modifies/deletes conversations |
| `/api/ai/page-agents/[agentId]/conversations/route.ts` | POST | Creates conversations |

**Evidence:**
```typescript
// apps/web/src/app/api/ai/page-agents/[agentId]/conversations/route.ts:113
const auth = await authenticateHybridRequest(request);
// No CSRF validation - authenticateHybridRequest defaults to requireCSRF: false
```

**Mitigation:** SameSite=strict cookies prevent cross-site attacks, reducing severity. However, same-site attacks remain possible.

**Remediation:**
```typescript
// Replace:
const auth = await authenticateHybridRequest(request);

// With:
const auth = await authenticateRequestWithOptions(request, {
  allow: ['jwt', 'mcp'] as const,
  requireCSRF: true
});
```

**Severity:** HIGH (mitigated to MEDIUM by SameSite=strict)

---

### 2.3 MEDIUM: Login/Signup Without CSRF Protection

**Issue:** Login and signup endpoints lack CSRF protection, enabling "Login CSRF" attacks where an attacker forces a victim to authenticate as the attacker's account.

**Affected Endpoints:**
- `POST /api/auth/login`
- `POST /api/auth/signup`

**Attack Scenario:**
1. Attacker creates malicious page with form posting to PageSpace login
2. Victim visits attacker's page
3. Victim is silently logged into attacker's account
4. Victim uploads sensitive data thinking it's their account
5. Attacker accesses the data

**Evidence:**
```typescript
// apps/web/src/app/api/auth/login/route.ts
export async function POST(req: Request) {
  // No CSRF validation
  const body = await req.json();
  // ...
}
```

**Remediation:**
1. Generate CSRF token in login page load
2. Validate token on login/signup submission
3. Or use a "pre-login CSRF" cookie pattern

**Severity:** MEDIUM

---

### 2.4 MEDIUM: No Origin/Referer Header Validation

**Issue:** No additional Origin or Referer header validation as defense-in-depth.

**Evidence:** Grep search for `request.headers.get('origin')` returned no matches in the web app.

**Recommendation:** Add Origin validation as supplementary protection:

```typescript
// Suggested addition to csrf-validation.ts
function validateOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const allowedOrigins = [process.env.WEB_APP_URL];

  // Allow requests without Origin (same-origin, non-browser)
  if (!origin) return true;

  return allowedOrigins.some(allowed => origin === allowed);
}
```

**Severity:** MEDIUM (defense-in-depth, not primary vulnerability)

---

### 2.5 LOW: Token Refresh Route Without CSRF

**Issue:** `/api/auth/refresh` accepts POST without CSRF validation. This is intentional since the user may need to refresh before obtaining a CSRF token, but it's worth noting.

**Evidence:**
```typescript
// apps/web/src/app/api/auth/refresh/route.ts
export async function POST(req: Request) {
  // Validates refresh token from cookie, not CSRF
}
```

**Mitigation:**
- Refresh tokens are single-use
- Token reuse triggers session invalidation
- SameSite=strict prevents cross-site attacks

**Severity:** LOW (mitigated by design)

---

### 2.6 LOW: WebSocket Handshake Relies on CORS Only

**Issue:** The realtime service validates WebSocket connections via CORS and JWT, but doesn't explicitly check the Origin header in application code.

**Evidence:**
```typescript
// apps/realtime/src/index.ts:77-82
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || process.env.WEB_APP_URL,
    credentials: true,
  },
});
```

**Mitigation:** Socket.IO's CORS handles Origin validation at the library level. JWT validation occurs in middleware.

**Recommendation:** Add explicit Origin logging for security monitoring:

```typescript
io.use(async (socket, next) => {
  const origin = socket.handshake.headers.origin;
  const allowedOrigin = process.env.WEB_APP_URL;

  if (origin && origin !== allowedOrigin) {
    loggers.realtime.warn('WebSocket connection from unexpected origin', { origin });
  }
  // Continue with JWT validation...
});
```

**Severity:** LOW

---

## 3. Positive Security Findings

### 3.1 Strong CSRF Implementation

- HMAC-SHA256 tokens tied to session
- Timing-safe comparison (`timingSafeEqual`)
- Token expiration with timestamps
- Automatic CSRF refresh in client (`auth-fetch.ts`)

### 3.2 Excellent Cookie Security

- `SameSite=strict` on all auth cookies
- `HttpOnly` prevents XSS token theft
- `Secure` flag in production
- Short-lived access tokens (15 min)

### 3.3 Session Management

- Token version invalidation on password change
- Single-use refresh tokens
- Token reuse detection triggers full session invalidation
- Device token revocation support

### 3.4 OAuth Security

- HMAC-signed state parameter prevents CSRF
- Signature verification on callback
- Rate limiting on OAuth endpoints

### 3.5 Security Headers

The middleware adds comprehensive security headers:
- Content-Security-Policy with frame-ancestors 'none'
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Strict-Transport-Security (production)
- Referrer-Policy: strict-origin-when-cross-origin

### 3.6 Stripe Webhook Security

Webhooks use Stripe signature verification instead of CSRF:
```typescript
// apps/web/src/app/api/stripe/webhook/route.ts:25-29
event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
```

---

## 4. Remediation Priority

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| **P1** | Add CSRF to `authenticateHybridRequest` routes | Low | High |
| **P2** | Add Login CSRF protection | Medium | Medium |
| **P3** | Add Origin header validation | Low | Low |
| **P4** | Add WebSocket Origin logging | Low | Low |

---

## 5. Recommended Code Changes

### 5.1 Fix `authenticateHybridRequest` Routes

**File:** `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/route.ts`

```diff
- const auth = await authenticateHybridRequest(request);
+ const auth = await authenticateRequestWithOptions(request, {
+   allow: ['jwt', 'mcp'] as const,
+   requireCSRF: true
+ });
```

Apply to all affected routes:
- `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/route.ts`
- `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/[conversationId]/route.ts`

### 5.2 Alternative: Update `authenticateHybridRequest` Function

**File:** `apps/web/src/lib/auth/index.ts`

```diff
export async function authenticateHybridRequest(request: Request): Promise<AuthenticationResult> {
-   return authenticateRequestWithOptions(request, { allow: ['mcp', 'jwt'] });
+   return authenticateRequestWithOptions(request, { allow: ['mcp', 'jwt'], requireCSRF: true });
}
```

**Note:** This changes behavior for all routes using `authenticateHybridRequest`. Verify all consumers first.

### 5.3 Add Login CSRF Token

**New endpoint:** `GET /api/auth/login-csrf`

```typescript
export async function GET(request: Request) {
  // Generate a short-lived CSRF token for login form
  const token = generateLoginCSRFToken();

  const response = NextResponse.json({ csrfToken: token });
  response.cookies.set('login_csrf', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 300, // 5 minutes
    path: '/api/auth'
  });

  return response;
}
```

---

## 6. Testing Recommendations

### 6.1 Manual Testing

1. **Verify CSRF token requirement:**
   - Remove X-CSRF-Token header from state-changing requests
   - Confirm 403 response with code `CSRF_TOKEN_MISSING`

2. **Test token expiration:**
   - Wait >1 hour and retry with old token
   - Confirm 403 response with code `CSRF_TOKEN_INVALID`

3. **Test SameSite protection:**
   - Create cross-origin page that submits form to PageSpace
   - Confirm cookies are not sent

### 6.2 Automated Testing

Existing tests cover CSRF validation:
- `apps/web/src/app/api/auth/__tests__/csrf.test.ts`
- `apps/web/src/app/api/auth/__tests__/logout.test.ts`

Recommend adding tests for:
- Routes using `authenticateHybridRequest` with mutation methods
- Login CSRF scenarios
- Token rotation on privilege changes

---

## 7. Conclusion

PageSpace demonstrates a mature security posture with enterprise-grade CSRF protection. The primary defense (SameSite=strict cookies) is complemented by cryptographic CSRF tokens with session binding.

**Key Recommendations:**

1. **Immediate:** Add `requireCSRF: true` to routes using `authenticateHybridRequest` that perform mutations
2. **Short-term:** Implement Login CSRF protection
3. **Long-term:** Add Origin header validation as defense-in-depth

The identified gaps are mitigated by the strong SameSite cookie policy, reducing overall risk to **LOW** for most attack scenarios.

---

## Appendix: Files Reviewed

- `apps/web/src/lib/auth/index.ts`
- `apps/web/src/lib/auth/csrf-validation.ts`
- `packages/lib/src/auth/csrf-utils.ts`
- `apps/web/src/lib/auth/auth-fetch.ts`
- `apps/web/src/app/api/auth/login/route.ts`
- `apps/web/src/app/api/auth/signup/route.ts`
- `apps/web/src/app/api/auth/refresh/route.ts`
- `apps/web/src/app/api/auth/logout/route.ts`
- `apps/web/src/app/api/auth/google/callback/route.ts`
- `apps/web/src/app/api/auth/google/signin/route.ts`
- `apps/web/src/app/api/stripe/webhook/route.ts`
- `apps/web/src/app/api/mcp/documents/route.ts`
- `apps/web/src/app/api/ai/page-agents/*/route.ts`
- `apps/realtime/src/index.ts`
- `apps/web/middleware.ts`
- 87 additional route files via grep analysis
