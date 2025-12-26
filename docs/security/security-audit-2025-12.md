# PageSpace Security Audit Report

**Date**: December 2025
**Auditor**: Claude Code Security Review
**Scope**: Full codebase security assessment
**Version**: 2.0 (Extended Audit)

---

## Executive Summary

PageSpace demonstrates a **strong security posture** overall with proper implementation of authentication, authorization, CSRF protection, and input validation. However, a deep security audit identified several issues ranging from **critical** to **low** severity that require attention.

### Summary of Findings

| Severity | Count | Description |
|----------|-------|-------------|
| Critical | 2 | Open redirect in OAuth, insecure fallback JWT secret |
| High | 2 | SSRF in Ollama/LMStudio endpoints, inconsistent password policy |
| Medium | 3 | CSP unsafe-eval, innerHTML usage, non-timing-safe cron comparison |
| Low | 3 | bcrypt inconsistency, legacy OAuth state handling, MCP child processes |

---

## Critical Findings

### 1. Open Redirect Vulnerability in Google OAuth Callback

**Severity**: CRITICAL
**Location**: `apps/web/src/app/api/auth/google/callback/route.ts:90-92`

**Issue**:
```typescript
} catch {
  // Legacy fallback: state might be just a return URL string
  returnUrl = stateParam;
}
```

Then on line 307:
```typescript
const redirectUrl = new URL(returnUrl, baseUrl);
```

**Attack Vector**: If an attacker crafts a malicious OAuth URL with a state parameter that:
1. Is not valid JSON (causing JSON.parse to throw)
2. Contains an absolute URL like `https://evil.com/phish`

The victim, after successful Google authentication, will be redirected to the attacker's site. The `new URL(returnUrl, baseUrl)` constructor ignores `baseUrl` when `returnUrl` is an absolute URL.

**Impact**:
- Phishing attacks with trusted domain OAuth flow
- Session token theft if attacker site mimics login page
- Reputation damage

**Recommendation**:
```typescript
// Validate returnUrl is a relative path, not absolute URL
if (returnUrl.startsWith('/') && !returnUrl.startsWith('//')) {
  // Safe relative URL
} else {
  returnUrl = '/dashboard'; // Fallback to safe default
}
```

### 2. Insecure Fallback JWT Secret in Notification Service

**Severity**: CRITICAL
**Location**: `packages/lib/src/services/notification-email-service.ts:41`

**Issue**:
```typescript
const secret = new TextEncoder().encode(process.env.JWT_SECRET || 'your_jwt_secret_here');
```

**Risk**: If `JWT_SECRET` is not set in the environment, the service falls back to a hardcoded, publicly known secret. This would allow attackers to forge valid unsubscribe tokens and potentially compromise user email preferences.

**Recommendation**:
- Remove the fallback default
- Throw an error if JWT_SECRET is not set
- Align with the pattern in `packages/lib/src/auth/auth-utils.ts` which properly validates the secret

---

## High Severity Findings

### 3. Server-Side Request Forgery (SSRF) in Ollama/LMStudio Endpoints

**Severity**: HIGH
**Locations**:
- `apps/web/src/app/api/ai/ollama/models/route.ts:29`
- `apps/web/src/lib/ai/core/ai-utils.ts:538-592` (createOllamaSettings)
- `apps/web/src/lib/ai/core/ai-utils.ts:638-693` (createLMStudioSettings)

**Issue**:
```typescript
const ollamaResponse = await fetch(`${ollamaSettings.baseUrl}/api/tags`, {...});
```

Users can configure `baseUrl` to **any URL** including:
- `http://127.0.0.1:8080` - Local services
- `http://169.254.169.254` - AWS/GCP/Azure metadata endpoints
- `http://internal-service:3000` - Internal Docker/K8s services
- `file:///etc/passwd` - Local file access (if fetch supports it)

**Impact**:
- Cloud credential theft via metadata endpoints
- Internal network scanning and service enumeration
- Access to internal-only APIs
- Potential data exfiltration

**Recommendation**:
```typescript
function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Block dangerous protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    // Block private IP ranges
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true; // Allow localhost for local dev

    // Block cloud metadata endpoints
    if (hostname === '169.254.169.254') return false;
    if (hostname.endsWith('.internal')) return false;

    // Block private ranges (10.x, 172.16-31.x, 192.168.x)
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
    }

    return true;
  } catch {
    return false;
  }
}
```

### 4. Inconsistent Password Policy

**Severity**: HIGH
**Locations**:
- Signup: `apps/web/src/app/api/auth/signup/route.ts:22-26`
- Password Change: `apps/web/src/app/api/account/password/route.ts:27-29`

**Issue**:
- **Signup requires**: 12+ characters, uppercase, lowercase, and numbers
- **Password change requires**: Only 8 characters minimum, no complexity requirements

**Risk**: Users can downgrade password strength when changing passwords, potentially using weaker passwords.

**Recommendation**:
- Apply the same validation rules to password changes
- Use a shared password validation schema

---

## Medium Severity Findings

### 5. Content Security Policy Allows unsafe-eval

**Severity**: MEDIUM
**Location**: `apps/web/middleware.ts:148-154`

**Issue**:
```typescript
"script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
```

**Context**: This is required for TipTap and Monaco editors to function. However, `unsafe-eval` increases XSS attack surface.

**Recommendation**:
- Document this as a known trade-off
- Consider stricter CSP for non-editor pages
- Evaluate alternatives if TipTap/Monaco can work without eval

### 6. innerHTML Usage Without Sanitization in Some Components

**Severity**: MEDIUM
**Locations**:
- `apps/web/src/lib/editor/pagination/PaginationExtension.ts:482-558` - Uses innerHTML for header/footer content
- `apps/web/src/components/ai/ui/code-block.tsx:128-133` - Uses dangerouslySetInnerHTML with Shiki output

**Mitigations Present**:
- `ShadowCanvas.tsx` properly uses DOMPurify for sanitization
- Code-block.tsx uses Shiki which escapes HTML in code

**Recommendation**:
- Review PaginationExtension.ts for potential XSS if headerLeft/headerRight contain user content
- Consider adding sanitization for edge cases

### 7. Non-Timing-Safe Secret Comparison in Cron Endpoint

**Severity**: MEDIUM
**Location**: `apps/web/src/app/api/cron/cleanup-tokens/route.ts:42`

**Issue**:
```typescript
if (authHeader !== `Bearer ${expectedAuth}`) {
```

Uses regular string comparison (`!==`) instead of timing-safe comparison. While the cron secret is typically long and random, this could theoretically allow timing-based attacks to guess the secret character by character.

**Recommendation**:
```typescript
import { timingSafeEqual } from 'crypto';

const expectedHeader = `Bearer ${expectedAuth}`;
if (authHeader.length !== expectedHeader.length ||
    !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expectedHeader))) {
  // Unauthorized
}
```

---

## Low Severity Findings

### 8. bcrypt Salt Rounds Inconsistency

**Severity**: LOW
**Locations**:
- Login route uses salt rounds 10 (via fake hash)
- Signup route uses salt rounds 12
- Password change uses salt rounds 10

**Recommendation**: Standardize on 12 rounds across all bcrypt operations for consistency.

### 9. Legacy OAuth State Format Still Supported

**Severity**: LOW
**Location**: `apps/web/src/app/api/auth/google/callback/route.ts:84-88`

**Issue**: The OAuth callback still accepts unsigned state parameters for backward compatibility:
```typescript
} else {
  // Legacy format: unsigned state (backward compatibility)
  platform = stateWithSignature.platform || 'web';
  deviceId = stateWithSignature.deviceId;
  returnUrl = stateWithSignature.returnUrl || '/dashboard';
}
```

**Recommendation**: Set a deprecation timeline and remove legacy support after migration.

### 10. MCP Desktop Spawns Child Processes

**Severity**: LOW (Expected behavior for desktop app)
**Location**: `apps/desktop/src/main/mcp-manager.ts:298`

**Context**: The desktop app spawns child processes for MCP servers. This is expected functionality but requires secure handling.

**Current Mitigations**:
- Tool name validation present
- Server configurations are user-provided

**Recommendation**: Ensure MCP server configurations are from trusted sources only.

---

## Security Strengths

The following security measures are well-implemented:

### Authentication
- JWT with HS256 and proper secret length validation (32+ chars)
- Timing-safe bcrypt comparison for password verification
- Token version tracking for logout invalidation
- Device token management with rotation
- Login CSRF protection with double-submit cookies

### Authorization
- Centralized permission system in `@pagespace/lib/permissions`
- Drive ownership and admin role inheritance
- Page-level permission checks (canView, canEdit, canShare, canDelete)
- Permission cache invalidation
- WebSocket connections verify permissions before joining rooms

### CSRF Protection
- HMAC-SHA256 signed CSRF tokens
- Timing-safe comparison
- 1-hour token expiry
- Session-bound tokens
- Proper `requireCSRF: true` on all state-changing endpoints

### Input Validation
- Zod schema validation on API inputs
- Drizzle ORM with parameterized queries (SQL injection protection)
- File upload MIME type validation
- Filename sanitization for headers

### File Security
- Path traversal prevention via `resolvePathWithin()`
- Dangerous MIME type detection
- Content-Disposition: attachment for downloads
- Strict CSP on served files

### Rate Limiting
- Login/signup rate limiting per IP and email
- Google OAuth rate limiting
- Configurable limits via environment
- Redis + memory cache for rate limit state

### Security Headers
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Referrer-Policy: strict-origin-when-cross-origin
- Permissions-Policy restrictions
- HSTS in production

### Realtime Security
- Socket.IO authentication middleware validates JWT
- Token version validation prevents use of revoked tokens
- Room access checks permissions before joining
- Broadcast endpoint uses HMAC signature verification with timing-safe comparison

### Encryption
- AES-256-GCM for sensitive data
- Scrypt key derivation
- Unique salt and IV per operation

### Webhook Security
- Stripe webhooks use signature verification
- Idempotency via event ID tracking

---

## Recommendations Summary

### Immediate (Critical)
1. **Fix Open Redirect in OAuth** - Validate returnUrl is relative path only
2. **Remove fallback JWT secret** in notification-email-service.ts

### Urgent (High)
3. **Add SSRF protection** to Ollama/LMStudio URL configuration
4. **Apply consistent password policy** across signup and password change

### Short-term (Medium)
5. **Use timing-safe comparison** for cron endpoint secrets
6. Review innerHTML usage in PaginationExtension.ts
7. Document CSP trade-offs for TipTap/Monaco

### Long-term (Low)
8. Standardize bcrypt salt rounds to 12
9. Remove legacy unsigned OAuth state support
10. Consider adding MCP server trust verification

---

## Testing Recommendations

1. Add security-focused integration tests for:
   - Open redirect attempts in OAuth flow
   - SSRF attempts via Ollama/LMStudio URLs
   - Token forgery attempts
   - CSRF bypass attempts
   - Authorization boundary testing
   - File upload malicious content

2. Consider periodic dependency vulnerability scanning with `pnpm audit`

3. Implement security regression tests for fixed vulnerabilities

4. Add URL validation test cases for:
   - Private IP ranges
   - Cloud metadata endpoints
   - File:// protocol
   - Protocol-relative URLs (//)

---

## Conclusion

PageSpace has a robust security architecture with proper defense-in-depth. The **open redirect vulnerability in OAuth** and **SSRF in local LLM endpoints** should be addressed immediately as they present the highest risk. The inconsistent password policy and fallback JWT secret are also high priorities.

The codebase demonstrates good security practices overall including:
- Proper CSRF protection
- Timing-safe comparisons where it matters most
- Comprehensive permission checks
- Strong authentication mechanisms

The remaining findings are lower priority but should be addressed to maintain the overall security posture.
