# Cloud Security - Gap Analysis & Improvements

> Areas not covered in initial analysis that need attention for enterprise zero-trust deployment

## Gaps Identified in Original Analysis

### 1. Race Condition Vulnerabilities (CRITICAL)

**Not Covered:** The initial analysis missed race conditions entirely.

**Key Gaps:**
- **Token refresh race condition**: Concurrent refresh requests could both succeed, creating multiple valid tokens or triggering false token reuse detection
- **Database transaction isolation**: No verification that critical operations (token refresh, session creation) use proper transaction isolation levels
- **File deduplication race**: Simultaneous uploads of same file could corrupt content-addressed storage

**Required Tests:**
```typescript
// Race condition invariant tests
it('concurrent refresh requests result in exactly one success');
it('token reuse detection handles false positives from concurrent requests');
it('database operations use SERIALIZABLE isolation for auth');
```

---

### 2. SSRF (Server-Side Request Forgery) Protection (CRITICAL)

**Not Covered:** Processor service URL handling wasn't analyzed for SSRF.

**Key Gaps:**
- No URL validation before fetching external content
- No protection against DNS rebinding attacks
- No blocklist for cloud metadata endpoints (169.254.169.254)
- No protection against protocol smuggling (gopher://, file://)

**Required Implementation:**
```typescript
// packages/lib/src/security/url-validator.ts
export function validateExternalURL(url: string): boolean {
  const parsed = new URL(url);

  // 1. Protocol check
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;

  // 2. Resolve DNS and check against blocklist
  const ip = await dns.resolve(parsed.hostname);
  if (isPrivateIP(ip) || isCloudMetadata(ip)) return false;

  // 3. No localhost variants
  if (isLocalhost(parsed.hostname)) return false;

  return true;
}
```

---

### 3. Session Fixation Prevention (HIGH)

**Not Covered:** Session lifecycle security wasn't analyzed.

**Key Gaps:**
- No verification that session ID changes on authentication
- No verification that CSRF token regenerates after login
- No verification that old session tokens are invalidated

**Required Tests:**
```typescript
it('session ID changes on successful login');
it('CSRF token regenerates after authentication');
it('pre-auth session cannot be used post-auth');
```

---

### 4. Cookie Security Attributes (HIGH)

**Not Covered:** Cookie configuration wasn't thoroughly verified.

**Key Gaps:**
- No tests for `Secure` flag in production
- No tests for `SameSite=Strict` consistency
- No tests for proper `Path` scoping
- No tests for `__Host-` prefix usage (strongest cookie protection)

**Required Configuration:**
```typescript
// Recommended cookie configuration
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  // Consider __Host- prefix for strongest protection
  name: process.env.NODE_ENV === 'production' ? '__Host-accessToken' : 'accessToken',
};
```

---

### 5. Content Security Policy (HIGH)

**Not Covered:** CSP headers weren't analyzed.

**Key Gaps:**
- No CSP tests for API responses
- No CSP tests for file serving
- No verification of script-src restrictions
- No frame-ancestors validation

**Required Headers:**
```typescript
// For API routes
'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"

// For file serving
'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'"

// For HTML pages
'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
```

---

### 6. SQL Injection Edge Cases (MEDIUM)

**Not Covered:** While Drizzle ORM prevents most SQLi, edge cases exist.

**Key Gaps:**
- JSONB operations with user input
- Raw SQL in dynamic queries
- LIKE/ILIKE pattern injection
- ORDER BY injection

**Required Review:**
```typescript
// Search for patterns that need parameterization
grep -r "sql\`" packages/db/
grep -r "rawQuery" packages/
grep -r "LIKE.*\$\{" packages/
```

---

### 7. Advanced Path Traversal (MEDIUM)

**Not Covered:** Only basic traversal was tested.

**Key Gaps:**
- Unicode normalization attacks
- Double URL encoding
- Null byte injection
- Symlink following
- Case sensitivity issues (Windows)

**Required Tests:**
```typescript
const advancedPayloads = [
  '%2e%2e%2f',           // URL encoded
  '%252e%252e%252f',     // Double encoded
  '..%00',               // Null byte
  '..%c0%af',            // Overlong UTF-8
  'foo/../../../etc/passwd',
];
```

---

### 8. Timing Attack Verification (MEDIUM)

**Not Covered:** Only CSRF comparison was verified.

**Key Gaps:**
- Password comparison timing (bcrypt handles this, but verify)
- Token comparison timing
- Secret comparison in cron endpoints
- MONITORING_INGEST_KEY comparison

**Required Audit:**
```typescript
// All secret comparisons should use timingSafeEqual
grep -r "=== .*Secret\|=== .*Token\|=== .*Key" packages/
```

---

### 9. Email/Password Reset Security (MEDIUM)

**Not Covered:** Password reset flow wasn't analyzed.

**Key Gaps:**
- Token expiration (should be 15-30 minutes)
- Single-use token enforcement
- Session invalidation on password change
- Rate limiting on reset requests
- Email enumeration prevention

**Required Tests:**
```typescript
it('password reset token expires after 30 minutes');
it('password reset token is single-use');
it('password change invalidates all sessions');
it('password reset rate limited to 3/hour');
it('same response for existing/non-existing emails');
```

---

### 10. Device Token Security (MEDIUM)

**Not Covered:** Device token lifecycle wasn't analyzed.

**Key Gaps:**
- Immediate revocation effectiveness
- Device enumeration prevention
- Trust score validation
- Suspicious activity detection triggers

---

### 11. WebSocket Message Replay (MEDIUM)

**Not Covered:** Real-time message integrity wasn't fully analyzed.

**Key Gaps:**
- No timestamp validation on broadcast signatures
- No message deduplication
- No replay attack prevention
- No cross-room message injection tests

**Required Implementation:**
```typescript
// Add timestamp to broadcast signatures
function createBroadcastSignature(body: string): string {
  const timestamp = Date.now();
  const payload = `${timestamp}:${body}`;
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return `${timestamp}.${signature}`;
}

function verifyBroadcastSignature(signature: string, body: string): boolean {
  const [timestamp, sig] = signature.split('.');
  const age = Date.now() - parseInt(timestamp);

  // Reject if older than 5 minutes
  if (age > 5 * 60 * 1000) return false;

  // Verify signature
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}:${body}`)
    .digest('hex');

  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```

---

### 12. Infrastructure Security (MEDIUM)

**Not Covered:** Container and deployment security.

**Key Gaps:**
- Non-root container user
- Read-only filesystem where possible
- Resource limits (CPU, memory)
- Network policies between services
- Secrets manager integration
- Health check security

**Required Dockerfile Changes:**
```dockerfile
# Add non-root user
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app
USER app

# Read-only filesystem
# (configure at runtime with docker-compose)
```

---

### 13. Dependency Vulnerabilities (LOW)

**Not Covered:** Supply chain security.

**Key Gaps:**
- No pnpm audit in CI/CD
- No Dependabot/Snyk integration
- No lockfile verification
- No SBOM generation

**Required package.json:**
```json
{
  "scripts": {
    "audit": "pnpm audit --audit-level=moderate",
    "audit:fix": "pnpm audit --fix",
    "security:check": "pnpm audit && npm-check-updates --reject typescript"
  }
}
```

---

### 14. Secret Scanning (LOW)

**Not Covered:** Secrets in git history.

**Required Checks:**
```bash
# Check for leaked secrets
git log -p | grep -iE 'password|secret|key|token' | head -50

# Use trufflehog for comprehensive scan
trufflehog git file://. --only-verified
```

---

### 15. Incident Response Procedures (NOT COVERED)

**Required Documentation:**
- Emergency secret rotation procedure
- Session invalidation procedure
- Service isolation procedure
- Forensics and evidence collection
- Communication templates

---

### 16. Key Rotation Procedures (NOT COVERED)

**Required Procedures:**
```
JWT_SECRET Rotation:
1. Generate new secret
2. Set JWT_SECRET_NEW alongside JWT_SECRET
3. Deploy: accept both, sign with new
4. Wait for old tokens to expire (15 min)
5. Remove JWT_SECRET, rename JWT_SECRET_NEW

SERVICE_JWT_SECRET Rotation:
1. Generate per-service secrets
2. Deploy processor with new secret
3. Deploy web with new secret
4. Wait for old tokens to expire (5 min)
5. Remove old secret
```

---

### 17. Migration Strategy for Token Hashing (NOT COVERED)

**Required Migration:**
```typescript
// Migration: Hash existing tokens
async function migrateToHashedTokens() {
  // 1. Add tokenHash column
  await db.execute(sql`
    ALTER TABLE refresh_tokens ADD COLUMN token_hash TEXT;
    ALTER TABLE mcp_tokens ADD COLUMN token_hash TEXT;
  `);

  // 2. Compute hashes for existing tokens
  const refreshTokens = await db.select().from(refreshTokens);
  for (const token of refreshTokens) {
    const hash = createHash('sha256').update(token.token).digest('hex');
    await db.update(refreshTokens)
      .set({ tokenHash: hash })
      .where(eq(refreshTokens.id, token.id));
  }

  // 3. After migration, drop token column
  // (do this in separate migration after code is updated)
}
```

---

## Priority Matrix

| Gap | Severity | Effort | Priority Score |
|-----|----------|--------|----------------|
| Race Conditions | Critical | Medium | 1 |
| SSRF Prevention | Critical | Low | 2 |
| Distributed Rate Limit | Critical | Medium | 3 |
| Session Fixation | High | Low | 4 |
| Cookie Security | High | Low | 5 |
| CSP Headers | High | Low | 6 |
| Token Hashing Migration | High | Medium | 7 |
| Path Traversal Advanced | Medium | Low | 8 |
| Timing Attacks | Medium | Low | 9 |
| Password Reset | Medium | Medium | 10 |
| WebSocket Replay | Medium | Medium | 11 |
| SQL Injection Edge | Medium | Low | 12 |
| Infrastructure | Medium | Medium | 13 |
| Dependency Audit | Low | Low | 14 |
| Secret Scanning | Low | Low | 15 |

---

## Test File Structure

```
packages/lib/src/__tests__/
├── security-invariants.test.ts       # Core security invariants
├── race-conditions.test.ts           # Concurrency tests
├── token-revocation.test.ts          # Revocation tests
├── distributed-rate-limit.test.ts    # Redis rate limiting
├── timing-attacks.test.ts            # Timing-safe operations
├── secret-management.test.ts         # Encryption & secrets
└── security-test-utils.ts            # Test helpers

apps/web/src/app/api/auth/__tests__/
├── refresh-race-condition.test.ts    # Token refresh races
├── session-fixation.test.ts          # Session security
├── cookie-attributes.test.ts         # Cookie configuration
├── password-reset-security.test.ts   # Reset flow
└── device-token-security.test.ts     # Device management

apps/processor/tests/
├── ssrf-prevention.test.ts           # SSRF attacks
├── path-traversal-advanced.test.ts   # Advanced traversal
└── file-security.test.ts             # File operations

apps/web/src/app/api/__tests__/
├── multi-tenant-isolation.test.ts    # Tenant isolation
├── csp-headers.test.ts               # Content Security Policy
└── sql-injection-edge.test.ts        # SQLi edge cases

apps/realtime/src/__tests__/
├── broadcast-security.test.ts        # Message integrity
└── websocket-isolation.test.ts       # Room isolation

apps/web/e2e/
└── security.spec.ts                  # E2E security tests
```
