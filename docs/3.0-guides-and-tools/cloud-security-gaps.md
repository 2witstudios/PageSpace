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
import { promises as dns } from 'dns';
import { isIP } from 'net';

// Use ipaddr.js for robust IP parsing (handles IPv4, IPv6, mapped addresses)
import { parse as parseIP, IPv4, IPv6 } from 'ipaddr.js';

/**
 * Cloud metadata endpoints that must be blocked
 */
const METADATA_IPS = [
  '169.254.169.254',    // AWS, Azure, DigitalOcean
  '100.100.100.200',    // Alibaba Cloud
  'fd00:ec2::254',      // AWS IPv6 metadata
];

const METADATA_HOSTNAMES = [
  'metadata.google.internal',
  'metadata.goog',
  'kubernetes.default.svc',
];

/**
 * Check if an IP address is private, loopback, or link-local
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 addresses
 */
function isBlockedIP(ipStr: string): boolean {
  try {
    const addr = parseIP(ipStr);

    // Handle IPv4-mapped IPv6 (::ffff:127.0.0.1)
    if (addr.kind() === 'ipv6') {
      const v6 = addr as IPv6;
      if (v6.isIPv4MappedAddress()) {
        const v4 = v6.toIPv4Address();
        return isBlockedIPv4(v4);
      }
      // IPv6 link-local (fe80::/10)
      if (v6.range() === 'linkLocal') return true;
      // IPv6 loopback (::1)
      if (v6.range() === 'loopback') return true;
      // IPv6 private (fc00::/7)
      if (v6.range() === 'uniqueLocal') return true;
    } else {
      return isBlockedIPv4(addr as IPv4);
    }

    // Check against metadata IPs
    if (METADATA_IPS.includes(ipStr)) return true;

    return false;
  } catch {
    // Invalid IP format - block by default
    return true;
  }
}

function isBlockedIPv4(addr: IPv4): boolean {
  const range = addr.range();
  return [
    'loopback',      // 127.0.0.0/8
    'private',       // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
    'linkLocal',     // 169.254.0.0/16
    'broadcast',     // 255.255.255.255
    'unspecified',   // 0.0.0.0
  ].includes(range);
}

/**
 * Validate a URL for SSRF safety
 * Returns validated URL info or throws on blocked URL
 */
export async function validateExternalURL(url: string): Promise<{
  url: URL;
  resolvedIPs: string[];
}> {
  const parsed = new URL(url);

  // 1. Protocol allowlist (strict)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }

  // 2. Block known metadata hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (METADATA_HOSTNAMES.some(h => hostname === h || hostname.endsWith('.' + h))) {
    throw new Error(`Blocked metadata hostname: ${hostname}`);
  }

  // 3. If hostname is already an IP, validate it directly
  if (isIP(hostname)) {
    if (isBlockedIP(hostname)) {
      throw new Error(`Blocked IP address: ${hostname}`);
    }
    return { url: parsed, resolvedIPs: [hostname] };
  }

  // 4. Resolve DNS and validate ALL returned IPs (both A and AAAA)
  const [ipv4Results, ipv6Results] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const resolvedIPs: string[] = [];
  if (ipv4Results.status === 'fulfilled') resolvedIPs.push(...ipv4Results.value);
  if (ipv6Results.status === 'fulfilled') resolvedIPs.push(...ipv6Results.value);

  if (resolvedIPs.length === 0) {
    throw new Error(`DNS resolution failed: ${hostname}`);
  }

  // 5. ALL resolved IPs must be safe (prevents DNS rebinding partial bypass)
  for (const ip of resolvedIPs) {
    if (isBlockedIP(ip)) {
      throw new Error(`Blocked IP in DNS response: ${ip} for ${hostname}`);
    }
  }

  return { url: parsed, resolvedIPs };
}

/**
 * Fetch with SSRF protection
 * Re-validates IP at connection time to prevent DNS rebinding TOCTOU
 */
export async function safeFetch(url: string, options?: RequestInit): Promise<Response> {
  const validated = await validateExternalURL(url);

  // Use custom DNS resolver to prevent rebinding between validation and fetch
  // This requires using a library like undici with custom resolver, or
  // connecting directly to the validated IPs with Host header
  // Implementation depends on your HTTP client

  // Example with node's http/https modules:
  // 1. Use validated.resolvedIPs[0] as the socket address
  // 2. Set Host header to validated.url.hostname
  // 3. Validate the connection IP matches validated.resolvedIPs

  return fetch(validated.url.toString(), options);
}
```

> **Note:** For production use, consider using `undici` with a custom DNS resolver that pins resolved IPs, or implement connection-time IP validation to fully prevent DNS rebinding TOCTOU attacks.

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
```text
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

  // 2. Compute hashes for existing tokens (batch for performance)
  const BATCH_SIZE = 1000;
  let offset = 0;
  while (true) {
    const tokens = await db.select().from(refreshTokens).limit(BATCH_SIZE).offset(offset);
    if (tokens.length === 0) break;

    for (const token of tokens) {
      const hash = createHash('sha256').update(token.token).digest('hex');
      await db.update(refreshTokens)
        .set({ tokenHash: hash })
        .where(eq(refreshTokens.id, token.id));
    }
    offset += BATCH_SIZE;
  }

  // 3. Verify all tokens are hashed before proceeding
  await validateHashedTokensMigration();
}

// Verification step - MUST pass before dropping plaintext column
async function validateHashedTokensMigration(): Promise<void> {
  const unhashed = await db.select({ count: sql<number>`count(*)` })
    .from(refreshTokens)
    .where(isNull(refreshTokens.tokenHash));

  if (unhashed[0].count > 0) {
    throw new Error(`Migration incomplete: ${unhashed[0].count} tokens still unhashed`);
  }

  console.log('✓ All tokens hashed successfully');
}

// 4. After code is updated to use tokenHash, drop plaintext in separate migration
// Rollback: If new code fails, revert deployment - plaintext column still exists
```

**Deployment Strategy:**
1. Deploy migration (adds `tokenHash` column, computes hashes)
2. **Verify immediately after migration completes** (before any new deployments):
   - Run `validateHashedTokensMigration()` to confirm all tokens hashed
   - Log metrics: tokens processed, time elapsed, any errors
   - If verification fails, investigate before proceeding
3. Deploy new code using `tokenHash` for lookups (feature flag optional)
4. Monitor for 24-48 hours:
   - Track token lookup latency (hashed vs previous)
   - Monitor error rates on refresh endpoints
   - Alert on any "token not found" errors
5. Deploy column drop migration (only after step 4 passes)
6. **Rollback**: If step 3 fails, revert deployment - plaintext still available

**Migration Progress Tracking:**
```typescript
// Add logging to track migration progress
async function migrateWithMetrics() {
  const startTime = Date.now();
  let processed = 0;

  // ... batch processing loop ...
  processed += tokens.length;
  console.log(`Progress: ${processed} tokens hashed (${Date.now() - startTime}ms)`);

  console.log(`Migration complete: ${processed} tokens in ${Date.now() - startTime}ms`);
}
```

---

## Priority Matrix

| Gap | Severity | Effort | Priority | Implementation Notes |
|-----|----------|--------|----------|---------------------|
| Race Conditions | Critical | Medium | 1 | Requires DB transaction isolation testing |
| SSRF Prevention | Critical | Low | 2 | Single-service change (processor) |
| Distributed Rate Limit | Critical | Medium → High | 3 | Cross-service: web, processor, realtime; Redis coordination |
| Session Fixation | High | Low | 4 | Web service only |
| Cookie Security | High | Low | 5 | Configuration changes |
| CSP Headers | High | Low | 6 | Middleware addition |
| Token Hashing Migration | High | Medium | 7 | Affects refresh_tokens + mcp_tokens; audit schema first |
| Path Traversal Advanced | Medium | Low | 8 | Processor service only |
| Timing Attacks | Medium | Low | 9 | Multiple endpoints; consider shared utility |
| Password Reset | Medium | Medium | 10 | Requires email service integration |
| WebSocket Replay | Medium | Medium | 11 | Realtime service + broadcast protocol change |
| SQL Injection Edge | Medium | Low | 12 | Code review task |
| Infrastructure | Medium | Medium → High | 13 | Docker/K8s config; may require deployment changes |
| Dependency Audit | Low | Low | 14 | CI/CD integration |
| Secret Scanning | Low | Low | 15 | One-time setup + CI hook |

---

## Test File Structure

```text
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
