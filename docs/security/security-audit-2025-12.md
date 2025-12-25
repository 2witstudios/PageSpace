# PageSpace Security Audit Report

**Date**: December 2025
**Auditor**: Claude Code Security Review
**Scope**: Full codebase security assessment

---

## Executive Summary

PageSpace demonstrates a **strong security posture** overall with proper implementation of authentication, authorization, CSRF protection, and input validation. However, several issues were identified ranging from **critical** to **low** severity.

### Summary of Findings

| Severity | Count | Description |
|----------|-------|-------------|
| Critical | 1 | Insecure fallback JWT secret |
| High | 1 | Inconsistent password requirements |
| Medium | 2 | CSP allows unsafe-eval, potential XSS vectors |
| Low | 2 | Minor configuration issues |

---

## Critical Findings

### 1. Insecure Fallback JWT Secret in Notification Service

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

### 2. Inconsistent Password Policy

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

### 3. Content Security Policy Allows unsafe-eval

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

### 4. innerHTML Usage Without Sanitization in Some Components

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

---

## Low Severity Findings

### 5. bcrypt Salt Rounds Inconsistency

**Severity**: LOW
**Locations**:
- Login route uses salt rounds 10 (via fake hash)
- Signup route uses salt rounds 12
- Password change uses salt rounds 10

**Recommendation**: Standardize on 12 rounds across all bcrypt operations for consistency.

### 6. MCP Desktop Spawns Child Processes

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
- Configurable limits via environment
- Redis + memory cache for rate limit state

### Security Headers
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Referrer-Policy: strict-origin-when-cross-origin
- Permissions-Policy restrictions
- HSTS in production

### Encryption
- AES-256-GCM for sensitive data
- Scrypt key derivation
- Unique salt and IV per operation

---

## Recommendations Summary

### Immediate (Critical/High)
1. Remove fallback JWT secret in notification-email-service.ts
2. Apply consistent password policy across signup and password change

### Short-term (Medium)
3. Review innerHTML usage in PaginationExtension.ts
4. Document CSP trade-offs for TipTap/Monaco

### Long-term (Low)
5. Standardize bcrypt salt rounds to 12
6. Consider adding MCP server trust verification

---

## Testing Recommendations

1. Add security-focused integration tests for:
   - Token forgery attempts
   - CSRF bypass attempts
   - Authorization boundary testing
   - File upload malicious content

2. Consider periodic dependency vulnerability scanning with `pnpm audit`

3. Implement security regression tests for fixed vulnerabilities

---

## Conclusion

PageSpace has a robust security architecture with proper defense-in-depth. The critical issue with the fallback JWT secret should be addressed immediately. The inconsistent password policy is a high-priority fix. The remaining findings are lower priority but should be addressed to maintain the overall security posture.
