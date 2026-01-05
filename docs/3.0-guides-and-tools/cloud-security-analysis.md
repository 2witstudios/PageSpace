# PageSpace Cloud Security Analysis

> **Zero-Trust Enterprise Cloud Architecture Assessment**
>
> Date: 2026-01-04
> Scope: Full security review for cloud/multi-tenant deployment

## Executive Summary

This analysis identifies security vulnerabilities in PageSpace when deployed in a cloud environment with a zero-trust model. The current architecture was designed for local/single-instance deployment and requires significant hardening for enterprise cloud deployment.

### Severity Distribution

| Severity | Count | Immediate Action Required |
|----------|-------|---------------------------|
| Critical | 4 | Yes - within 1 week |
| High | 8 | Yes - within 2 weeks |
| Medium | 6 | Planned - within 4 weeks |
| Low | 4 | As capacity allows |

---

## Critical Severity Vulnerabilities

### 1. SERVICE_JWT_SECRET is a "God Key"

**File:** `packages/lib/src/services/service-auth.ts:48-62`

**Description:** A single shared secret (`SERVICE_JWT_SECRET`) is used by all services (web, processor, realtime) to sign and verify service-to-service tokens. If this secret leaks from any source (logs, error dumps, SSM misconfiguration, container compromise), an attacker can forge tokens for any user with any scope.

**Current Code:**
```typescript
function getServiceConfig(): ServiceJWTConfig {
  const rawSecret = process.env.SERVICE_JWT_SECRET;
  // Same secret used by web, processor, and realtime services
  return {
    secret: new TextEncoder().encode(rawSecret),
    issuer: process.env.JWT_ISSUER || 'pagespace',
    audience: 'pagespace-processor',
  };
}
```

**Attack Scenario:**
1. Attacker compromises one service or gains access to environment variables
2. Extracts `SERVICE_JWT_SECRET`
3. Forges service tokens with arbitrary `userId`, `scopes`, and `driveIds`
4. Accesses/modifies any file or resource across all tenants
5. No revocation mechanism exists - tokens valid until expiration

**Recommended Hardening:**

**Tier 1 (Quick Win):**
- Add JTI (JWT ID) to a Redis-based allowlist/denylist with 5-minute TTL
- Log all service token usage with full claims for audit

**Tier 2 (Recommended):**
- Use separate secrets per service pair:
  - `SERVICE_JWT_SECRET_WEB_TO_PROCESSOR`
  - `SERVICE_JWT_SECRET_WEB_TO_REALTIME`
- Add `tokenVersion` to service tokens and verify against database
- Validate that `userId` exists and isn't suspended before processing

**Tier 3 (Zero-Trust):**
- Replace symmetric JWT with asymmetric RS256 (private key signs, public key verifies)
- Implement mTLS between services with identity verification
- Use opaque tokens with shared auth lookup service

---

### 2. Processor Blindly Trusts userId Claim

**Files:**
- `apps/processor/src/middleware/auth.ts:97-110`
- `apps/processor/src/services/rbac.ts:12-38`

**Description:** The processor service extracts `userId` from service tokens and uses it directly without validating that the user exists, is active, or has the claimed permissions. In a multi-tenant cloud, a compromised web instance could fabricate tokens to access other tenants' files.

**Current Code:**
```typescript
function buildAuthContext(claims: ServiceTokenClaims): ProcessorServiceAuth {
  const userId = String(claims.sub); // Blindly trusted
  return {
    userId,
    service: claims.service,
    scopes,
    tenantId: claims.resource ?? userId, // Can be any value
  };
}
```

**Attack Scenario:**
1. Attacker gains access to web service or obtains a service token
2. Forges token with victim's `userId` and `driveIds`
3. Processor accepts token without user validation
4. Attacker downloads/modifies victim's files

**Recommended Hardening:**
```typescript
// Add user validation before processing
async function validateServiceUser(userId: string): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, tokenVersion: true, suspendedAt: true }
  });
  return user && !user.suspendedAt;
}
```

---

### 3. No Token Revocation Mechanism for Service Tokens

**File:** `packages/lib/src/services/service-auth.ts`

**Description:** Service tokens have no revocation mechanism. The JTI is generated but not tracked. If a breach is detected, there's no way to invalidate in-flight service tokens during their 5-minute validity window.

**Attack Scenario:**
1. Security team detects breach and rotates `SERVICE_JWT_SECRET`
2. All previously issued tokens with old secret are invalid - good
3. But tokens issued with new secret before rotation completes are still valid
4. Attacker with token has 5-minute window of continued access

**Recommended Hardening:**
```typescript
// Redis-based JTI tracking
async function recordServiceToken(jti: string, expiresIn: number): Promise<void> {
  await redis.setex(`service:jti:${jti}`, expiresIn, 'valid');
}

async function isTokenRevoked(jti: string): Promise<boolean> {
  const status = await redis.get(`service:jti:${jti}`);
  return status === 'revoked' || status === null;
}

async function revokeServiceToken(jti: string): Promise<void> {
  await redis.set(`service:jti:${jti}`, 'revoked', 'KEEPTTL');
}
```

---

### 4. Scope Escalation - No User Permission Validation

**Files:**
- `packages/lib/src/auth/auth-utils.ts:161-182`
- `apps/web/src/app/api/files/[id]/download/route.ts:62-68`

**Description:** When creating service tokens, the web service passes scopes like `files:read` or `files:write` without validating that the user actually has those permissions for the target resource. The scopes are claimed, not earned.

**Current Code:**
```typescript
// In download route - scopes are assumed valid
const serviceToken = await createServiceToken('web', ['files:read'], {
  userId: user.id,
  tenantId: page.id,
  driveIds: page.driveId ? [page.driveId] : undefined,
});
// No check: does user.id actually have 'files:read' for this page/drive?
```

**Recommended Hardening:**
```typescript
// Validate permissions before granting scopes
async function createValidatedServiceToken(
  userId: string,
  resourceId: string,
  requestedScopes: ServiceScope[]
): Promise<string> {
  const userPermissions = await getUserAccessLevel(userId, resourceId);

  const grantedScopes = requestedScopes.filter(scope => {
    if (scope === 'files:read') return userPermissions?.canView;
    if (scope === 'files:write') return userPermissions?.canEdit;
    if (scope === 'files:delete') return userPermissions?.canShare;
    return false;
  });

  if (grantedScopes.length === 0) {
    throw new Error('User lacks permissions for requested scopes');
  }

  return createServiceToken('web', grantedScopes, { userId, resource: resourceId });
}
```

---

## High-Severity Vulnerabilities

### 5. Rate Limiting is Instance-Local (Not Distributed)

**File:** `packages/lib/src/auth/rate-limit-utils.ts:1-30`

**Description:** Rate limiting uses an in-memory `Map` that is local to each Node.js process. In cloud deployments with multiple instances, attackers can bypass rate limits by distributing requests.

```typescript
// Current: In-memory, instance-local
const attempts = new Map<string, RateLimitAttempt>();
```

**Attack Scenario:**
- Deploy PageSpace with 3 instances
- Attacker attempts 5 logins on instance A (blocked)
- Attacker sends next 5 to instance B (allowed)
- Attacker sends next 5 to instance C (allowed)
- 15 attempts vs. intended 5-attempt limit

**Recommended Hardening:**
```typescript
// Redis-based distributed rate limiting using ioredis (PageSpace's Redis client)
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Sliding window rate limiter using Redis
 * @param key - Unique identifier (e.g., `login:${email}` or `refresh:${ip}`)
 * @param limit - Maximum attempts allowed
 * @param windowMs - Time window in milliseconds
 */
async function checkDistributedRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const redisKey = `ratelimit:${key}`;

  // Use Redis transaction for atomic operations
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(redisKey, 0, windowStart);  // Remove old entries
  pipeline.zadd(redisKey, now, `${now}-${Math.random()}`);  // Add current request
  pipeline.zcard(redisKey);  // Count requests in window
  pipeline.pexpire(redisKey, windowMs);  // Set expiry

  const results = await pipeline.exec();
  const count = results?.[2]?.[1] as number || 0;

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt: new Date(now + windowMs),
  };
}
```

> **Note:** For serverless environments (e.g., Vercel Edge), consider `@upstash/ratelimit` with `@upstash/redis` as an alternative that doesn't require persistent connections.

---

### 6. PROCESSOR_AUTH_REQUIRED Can Be Disabled

**File:** `apps/processor/src/middleware/auth.ts:24`

**Description:** Setting `PROCESSOR_AUTH_REQUIRED=false` completely disables authentication for the processor service. This should never be possible in production.

```typescript
export const AUTH_REQUIRED = process.env.PROCESSOR_AUTH_REQUIRED !== 'false';
```

**Recommended Hardening:**
```typescript
// Fail if auth is disabled in production
export const AUTH_REQUIRED = (() => {
  const disabled = process.env.PROCESSOR_AUTH_REQUIRED === 'false';
  if (disabled && process.env.NODE_ENV === 'production') {
    throw new Error('PROCESSOR_AUTH_REQUIRED cannot be disabled in production');
  }
  return !disabled;
})();
```

---

### 7. Internal Service URLs Exposed in Logs

**Files:**
- `apps/web/src/app/api/files/[id]/download/route.ts:55-59`
- Various other files with console.log statements

**Description:** Internal service URLs (processor, realtime) are logged in plaintext, exposing internal network topology.

```typescript
console.log('[Download] Fetching file from processor:', {
  processorUrl: `${PROCESSOR_URL}/cache/${contentHash}/original`,
});
```

**Recommended Hardening:**
- Use structured logging with sensitive field redaction
- Never log full URLs in production
- Use service mesh for DNS abstraction

---

### 8. Refresh Tokens Stored in Plaintext

**File:** `packages/db/src/schema/auth.ts:35-51`

**Description:** Refresh tokens are stored as plaintext in the database. If the database is compromised, all user sessions are exposed.

```typescript
export const refreshTokens = pgTable('refresh_tokens', {
  token: text('token').unique().notNull(), // Plaintext!
});
```

**Recommended Hardening:**
```typescript
// Store hashed tokens
import { createHash } from 'crypto';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Store: db.insert(refreshTokens).values({ tokenHash: hashToken(token) })
// Verify: db.query.where(eq(refreshTokens.tokenHash, hashToken(providedToken)))
```

---

### 9. MCP Tokens Stored in Plaintext

**File:** `packages/db/src/schema/auth.ts:95-108`

**Description:** MCP tokens are stored as plaintext. These are long-lived API tokens that provide full access to a user's resources.

```typescript
export const mcpTokens = pgTable('mcp_tokens', {
  token: text('token').unique().notNull(), // Plaintext!
});
```

**Recommended Hardening:** Same as refresh tokens - store hashed.

---

### 10. CRON_SECRET and MONITORING_INGEST_KEY Use Plain String Comparison

**Files:**
- `apps/web/src/app/api/cron/cleanup-tokens/route.ts:30-48`
- `apps/web/src/app/api/internal/monitoring/ingest/route.ts:40-50`

**Description:** Static secrets are compared using plain string equality, which is vulnerable to timing attacks. No rate limiting on these endpoints.

```typescript
if (authHeader !== `Bearer ${expectedAuth}`) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```

**Recommended Hardening:**
```typescript
import { timingSafeEqual } from 'crypto';

function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
```

---

### 11. WebSocket Origin Validation is Log-Only

**File:** `apps/realtime/src/index.ts:122-159`

**Description:** The WebSocket origin validation function only logs warnings - it doesn't block connections with invalid origins. Socket.IO CORS is the actual enforcement, but if misconfigured, the origin validation provides no protection.

```typescript
// Missing origin is allowed
if (!origin) {
  return { isValid: true, reason: 'no_origin' };
}
// No config means allow all
if (allowedOrigins.length === 0) {
  return { isValid: true, reason: 'no_config' };
}
```

**Recommended Hardening:**
- Make origin validation mandatory in production
- Fail closed (reject) when configuration is missing
- Add explicit allowlist requirement

---

### 12. Admin Role Validation Happens After Token Issuance

**File:** `apps/web/src/app/api/admin/users/[userId]/gift-subscription/route.ts:30-35`

**Description:** Admin role is checked at request time against the JWT claim, but the token could have been issued when user was admin and then revoked. There's a window where demoted admins retain access.

```typescript
if (auth.role !== 'admin') {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
```

**Recommended Hardening:**
- Add `adminRoleVersion` to user table
- Include in admin JWT tokens
- Verify at request time: `user.adminRoleVersion === token.adminRoleVersion`
- Bump version on any role change

---

## Medium-Severity Vulnerabilities

### 13. Service Token Resource Scoping Not Enforced

**Description:** Service tokens include `driveIds` and `tenantId` claims, but the processor doesn't validate that requested files belong to those resources.

### 14. Broadcast Signature Lacks Rate Limiting

**Description:** The realtime broadcast endpoint verifies signatures but has no rate limiting, enabling message flood attacks.

### 15. CSRF Token Fallback to JWT_SECRET

**File:** `apps/web/src/lib/auth/login-csrf-utils.ts:9-14`

**Description:** CSRF secret falls back to JWT_SECRET if not configured, coupling their security.

### 16. Device Token Revocation Failures Are Silent

**Description:** If device token revocation fails on logout, the error is logged but the logout completes, leaving tokens valid.

### 17. Content Hash Collision Risk in Multi-Tenant

**Description:** Content-addressed storage means two users uploading the same file share storage. This creates information leakage risks in multi-tenant scenarios.

### 18. No Audit Log for Service Token Operations

**Description:** Service token creation and usage isn't logged to the audit system, making forensics difficult.

---

## Low-Severity Vulnerabilities

### 19. Console.log Statements in Production Paths

**Description:** Multiple files use console.log/error which may expose sensitive information in cloud logging systems.

### 20. Generic Error Messages Leak Internal State

**Description:** Some error handlers return stack traces or internal paths in development mode.

### 21. Missing Request ID Correlation

**Description:** No request ID is generated and propagated across service boundaries for distributed tracing.

### 22. Inconsistent Token Expiration Times

**Description:** Different token types have different expiration logic, making security reasoning difficult.

---

## Recommended Hardening Roadmap

### Pre-Phase 0: Infrastructure Readiness

Before implementing security hardening, ensure infrastructure is prepared:

1. **Redis Cluster Capacity**
   - Provision Redis cluster with sufficient memory for JTI tracking
   - Configure persistence (RDB/AOF) for rate limit and revocation data
   - Set up Redis monitoring and alerting

2. **Database Migration Strategy**
   - Plan token hashing migration: add column → compute hashes → verify → drop plaintext
   - Test migration on staging with production-like data volume
   - Prepare rollback scripts for each migration step

3. **Load Testing Baseline**
   - Benchmark current authentication latency
   - Profile database queries in token validation paths
   - Identify bottlenecks before adding validation checks

4. **Monitoring & Alerting**
   - Set up dashboards for rate limit hits, token revocations, JTI lookups
   - Configure alerts for Redis latency spikes
   - Establish security incident response procedures

### Phase 1: Critical Fixes

1. **Implement Service Token JTI Tracking**
   - Add Redis-based JTI allowlist/denylist
   - Enable token revocation within 5-minute window
   - Log all service token usage

2. **Add User Validation in Processor**
   - Validate userId exists before processing
   - Check user isn't suspended
   - Verify tokenVersion matches

3. **Hash Sensitive Tokens at Rest**
   - Migrate refresh tokens to hashed storage
   - Migrate MCP tokens to hashed storage
   - Add migration script for existing tokens

4. **Make Distributed Rate Limiting Mandatory**
   - Require Redis for rate limiting in production
   - Fail startup if Redis unavailable

### Phase 2: High Priority (Weeks 2-3)

5. **Separate Service Secrets**
   - Create per-service-pair secrets
   - Update token verification to check issuer/audience
   - Document key rotation procedure

6. **Encrypt All Secrets in Transit and at Rest**
   - Ensure all API keys use `encryptedApiKey` column
   - Add encryption for any plaintext secrets

7. **Remove Auth Disable Flag**
   - Make PROCESSOR_AUTH_REQUIRED=false fail in production
   - Add startup validation

8. **Implement Timing-Safe Comparisons**
   - Update all secret comparisons to use crypto.timingSafeEqual
   - Add rate limiting to cron/internal endpoints

### Phase 3: Defense in Depth (Weeks 3-4)

9. **Add Request ID Correlation**
   - Generate unique request ID at ingress
   - Propagate through all service calls
   - Include in all log entries

10. **Implement Audit Logging for Service Tokens**
    - Log creation, usage, and revocation
    - Include full claims for forensics
    - Integrate with SIEM adapter

11. **Strengthen WebSocket Security**
    - Make origin validation blocking
    - Require explicit allowlist configuration
    - Add connection rate limiting

12. **Add Admin Role Versioning**
    - Add adminRoleVersion column
    - Include in tokens
    - Validate at request time

### Phase 4: Zero-Trust Architecture (Ongoing)

13. **Implement mTLS Between Services**
    - Generate per-service certificates
    - Configure mutual authentication
    - Remove shared secrets

14. **Add RBAC at Data Access Layer**
    - Move permission checks to repository layer
    - Implement row-level security where possible
    - Add tenant isolation middleware

15. **Implement Secrets Manager Integration**
    - Migrate from environment variables
    - Add automatic secret rotation
    - Implement secret versioning

---

## Testing Recommendations

### Security Testing Checklist

- [ ] Service token forgery test (with known secret)
- [ ] Cross-tenant file access attempt
- [ ] Rate limit bypass across instances
- [ ] Token revocation timing test
- [ ] Admin role demotion persistence test
- [ ] Origin spoofing on WebSocket
- [ ] Timing attack on secret comparison
- [ ] Audit log completeness verification

### Penetration Testing Scope

1. Authentication/Authorization bypass
2. Token manipulation and forgery
3. Multi-tenant isolation
4. Service-to-service trust exploitation
5. Rate limiting effectiveness
6. Session management weaknesses

### Positive Security Tests (Happy Path + Security)

Verify that security measures don't break normal operations:

- [ ] Successful login with rate limiting active (below threshold)
- [ ] File download with valid service token and proper tenant isolation
- [ ] Token refresh during high-concurrency periods
- [ ] Cross-tenant operations with audit logging enabled
- [ ] Multi-device login with device token management
- [ ] Admin operations after role validation implementation

### Load Testing Security Features

Test security measures under production-like load:

- [ ] Rate limiting Redis operations at 10K+ requests/second
- [ ] JTI lookup latency under peak authentication load
- [ ] Token validation with user suspension checks at scale
- [ ] Distributed rate limit consistency across 10+ instances
- [ ] Token hashing performance during bulk token refresh

---

## Appendix: Affected Files Summary

| File | Vulnerabilities |
|------|-----------------|
| `packages/lib/src/services/service-auth.ts` | #1, #3, #4 |
| `apps/processor/src/middleware/auth.ts` | #2, #6 |
| `packages/lib/src/auth/rate-limit-utils.ts` | #5 |
| `packages/db/src/schema/auth.ts` | #8, #9 |
| `apps/web/src/app/api/cron/cleanup-tokens/route.ts` | #10 |
| `apps/realtime/src/index.ts` | #11 |
| `apps/web/src/app/api/admin/*/route.ts` | #12 |
