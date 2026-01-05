# PageSpace Cloud Security - TDD Specification

> **Test-Driven Security Hardening for Zero-Trust Cloud Architecture**
>
> Date: 2026-01-04
> Status: Specification Phase

## Overview

This document provides comprehensive test specifications for implementing cloud security hardening in PageSpace. All security features MUST be implemented using TDD - tests are written first, then implementation follows.

### Testing Philosophy

1. **Security tests are integration tests** - They test the system as attackers see it
2. **Fail closed** - If a test can't verify security, it should fail
3. **Defense in depth** - Multiple overlapping tests for critical paths
4. **Regression prevention** - Every vulnerability fix gets a test
5. **Continuous verification** - Security tests run on every CI build

---

## Part 1: Security Invariants

These properties MUST hold at all times. Tests verify these invariants continuously.

### Authentication Invariants

```typescript
// packages/lib/src/__tests__/security-invariants.test.ts

describe('Security Invariants', () => {
  /**
   * INVARIANT: Every authenticated request MUST have a valid, unexpired token
   */
  describe('Token Validity Invariant', () => {
    it('expired tokens are always rejected', async () => {
      const expiredToken = await generateAccessToken(userId, tokenVersion, 'user');
      await advanceTime(16 * 60 * 1000); // 16 minutes (past 15min expiry)

      const response = await authenticatedRequest(expiredToken, '/api/pages');
      expect(response.status).toBe(401);
      expect(response.body.error).toContain('expired');
    });

    it('tokens with wrong signature are always rejected', async () => {
      const validToken = await generateAccessToken(userId, tokenVersion, 'user');
      const tamperedToken = validToken.slice(0, -10) + 'aaaaaaaaaa';

      const response = await authenticatedRequest(tamperedToken, '/api/pages');
      expect(response.status).toBe(401);
    });

    it('tokens with bumped tokenVersion are always rejected', async () => {
      const token = await generateAccessToken(userId, tokenVersion, 'user');
      await db.update(users).set({ tokenVersion: tokenVersion + 1 }).where(eq(users.id, userId));

      const response = await authenticatedRequest(token, '/api/pages');
      expect(response.status).toBe(401);
    });
  });

  /**
   * INVARIANT: Authorization checks MUST happen on every data access
   */
  describe('Authorization Invariant', () => {
    it('user cannot access pages they have no permission for', async () => {
      const { page, otherUser } = await setupCrossTenantScenario();

      const response = await authenticatedRequest(otherUser.token, `/api/pages/${page.id}`);
      expect(response.status).toBe(403);
    });

    it('user cannot modify pages with view-only access', async () => {
      const { page, viewerToken } = await setupViewerScenario();

      const response = await authenticatedRequest(viewerToken, `/api/pages/${page.id}`, {
        method: 'PATCH',
        body: { content: 'hacked' }
      });
      expect(response.status).toBe(403);
    });
  });

  /**
   * INVARIANT: Sensitive tokens MUST NOT be stored in plaintext
   */
  describe('Token Storage Invariant', () => {
    it('refresh tokens are stored as hashes', async () => {
      const { refreshToken } = await loginUser(testUser);

      const stored = await db.query.refreshTokens.findFirst({
        where: eq(refreshTokens.userId, testUser.id)
      });

      // Token in DB should be a hash, not the actual token
      expect(stored.tokenHash).not.toBe(refreshToken);
      expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hash
    });

    it('MCP tokens are stored as hashes', async () => {
      const { token } = await createMCPToken(testUser.id, 'Test Token');

      const stored = await db.query.mcpTokens.findFirst({
        where: eq(mcpTokens.userId, testUser.id)
      });

      expect(stored.tokenHash).not.toBe(token);
    });
  });

  /**
   * INVARIANT: Rate limits MUST be enforced across all instances
   */
  describe('Rate Limit Invariant', () => {
    it('rate limits persist across simulated instances', async () => {
      // Simulate requests hitting different instances by using Redis directly
      const rateLimitKey = `ratelimit:login:${testEmail}`;

      // Hit limit on "instance 1"
      for (let i = 0; i < 5; i++) {
        await attemptLogin(testEmail, 'wrong');
      }

      // Verify Redis has the count
      const count = await redis.get(rateLimitKey);
      expect(parseInt(count)).toBe(5);

      // "Instance 2" should see the same limit
      const response = await attemptLogin(testEmail, 'wrong');
      expect(response.status).toBe(429);
    });
  });

  /**
   * INVARIANT: Service tokens MUST be validated against user state
   */
  describe('Service Token User Validation Invariant', () => {
    it('service tokens for suspended users are rejected', async () => {
      const serviceToken = await createServiceToken('web', ['files:read'], {
        userId: testUser.id
      });

      // Suspend user
      await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, testUser.id));

      const response = await processorRequest(serviceToken, '/cache/abc123/original');
      expect(response.status).toBe(401);
      expect(response.body.error).toContain('suspended');
    });

    it('service tokens for deleted users are rejected', async () => {
      const serviceToken = await createServiceToken('web', ['files:read'], {
        userId: testUser.id
      });

      await db.delete(users).where(eq(users.id, testUser.id));

      const response = await processorRequest(serviceToken, '/cache/abc123/original');
      expect(response.status).toBe(401);
    });
  });
});
```

---

## Part 2: Race Condition Tests

Race conditions are among the most critical security issues in distributed systems.

> **Testing Limitations Note:**
>
> JavaScript's `Promise.all()` doesn't guarantee true parallelism - it schedules tasks concurrently but they execute on a single event loop. For rigorous race condition testing:
>
> 1. **Unit tests** (below): Good for catching obvious issues, but may miss subtle timing windows
> 2. **Integration tests**: Use `node:worker_threads` or separate processes for true parallelism
> 3. **Load testing**: Use tools like k6, Artillery, or Locust to generate genuine concurrent HTTP requests
> 4. **CI/CD**: Run race condition tests multiple times (e.g., `--repeat 10`) to catch intermittent failures
>
> Consider injecting artificial delays in test environments to widen race windows.

### Token Refresh Race Conditions

```typescript
// apps/web/src/app/api/auth/__tests__/refresh-race-condition.test.ts

describe('Token Refresh Race Conditions', () => {
  /**
   * Scenario: Two concurrent refresh requests with the same token
   * Expected: Exactly one succeeds, the other gets 401
   */
  it('concurrent refresh requests - only one succeeds', async () => {
    const { refreshToken } = await loginUser(testUser);

    // Fire two refresh requests simultaneously
    const [response1, response2] = await Promise.all([
      fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { Cookie: `refreshToken=${refreshToken}` }
      }),
      fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { Cookie: `refreshToken=${refreshToken}` }
      })
    ]);

    const statuses = [response1.status, response2.status].sort();

    // Exactly one should succeed (200), one should fail (401)
    expect(statuses).toEqual([200, 401]);
  });

  /**
   * Scenario: Token reuse from concurrent request triggers security response
   */
  it('token reuse from failed concurrent request triggers session invalidation', async () => {
    const { refreshToken, accessToken } = await loginUser(testUser);

    // Simulate the race condition scenario
    await Promise.all([
      fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { Cookie: `refreshToken=${refreshToken}` }
      }),
      fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { Cookie: `refreshToken=${refreshToken}` }
      })
    ]);

    // Original access token should now be invalidated (tokenVersion bumped)
    const response = await authenticatedRequest(accessToken, '/api/pages');
    expect(response.status).toBe(401);
    expect(response.body.error).toContain('session invalidated');
  });

  /**
   * Scenario: Rapid sequential refresh requests
   */
  it('rapid sequential refresh attempts are blocked after first success', async () => {
    const { refreshToken } = await loginUser(testUser);

    // First refresh succeeds
    const response1 = await refreshRequest(refreshToken);
    expect(response1.status).toBe(200);

    // Immediate second attempt with original token fails
    const response2 = await refreshRequest(refreshToken);
    expect(response2.status).toBe(401);
    expect(response2.body.tokenReuse).toBe(true);
  });

  /**
   * Database transaction isolation test
   */
  it('database transaction prevents double-spend of refresh token', async () => {
    const { refreshToken, userId } = await loginUser(testUser);

    // Count tokens before
    const tokensBefore = await db.select().from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));

    // Fire 10 concurrent refresh requests
    const responses = await Promise.all(
      Array(10).fill(null).map(() => refreshRequest(refreshToken))
    );

    // Count tokens after
    const tokensAfter = await db.select().from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));

    // Should have exactly 1 more token (or same if all failed)
    const successCount = responses.filter(r => r.status === 200).length;
    expect(successCount).toBeLessThanOrEqual(1);
    expect(tokensAfter.length).toBeLessThanOrEqual(tokensBefore.length + 1);
  });
});
```

### Service Token JTI Race Conditions

```typescript
// packages/lib/src/__tests__/service-token-jti-race.test.ts

describe('Service Token JTI Race Conditions', () => {
  /**
   * Scenario: Same service token used for multiple parallel requests
   * Expected: All requests within validity window succeed (JTI not single-use)
   */
  it('service token can be used for multiple concurrent requests', async () => {
    const token = await createServiceToken('web', ['files:read'], { userId: testUser.id });

    const responses = await Promise.all(
      Array(5).fill(null).map(() =>
        processorRequest(token, '/cache/abc123/original')
      )
    );

    // All should succeed (service tokens aren't single-use)
    expect(responses.every(r => r.status === 200 || r.status === 404)).toBe(true);
  });

  /**
   * Scenario: Revoked JTI should immediately block all uses
   */
  it('revoked JTI blocks concurrent in-flight requests', async () => {
    const token = await createServiceToken('web', ['files:read'], { userId: testUser.id });
    const jti = extractJTI(token);

    // Start a slow request
    const slowRequest = processorRequest(token, '/cache/abc123/original', { delay: 1000 });

    // Revoke the JTI
    await revokeServiceTokenJTI(jti);

    // The in-flight request should fail
    const response = await slowRequest;
    expect(response.status).toBe(401);
    expect(response.body.error).toContain('revoked');
  });
});
```

---

## Part 3: SSRF Prevention Tests

```typescript
// apps/processor/tests/ssrf-prevention.test.ts

import { parse as parseIP, IPv4, IPv6 } from 'ipaddr.js';

describe('SSRF Prevention', () => {
  /**
   * SSRF payload categories with expected blocked reasons
   * Each payload includes the URL and the expected extracted hostname for verification
   */
  const ssrfPayloads = [
    // Localhost variants
    { url: 'http://localhost/', expectedHost: 'localhost', reason: 'loopback' },
    { url: 'http://localhost:3000/', expectedHost: 'localhost', reason: 'loopback' },
    { url: 'http://127.0.0.1/', expectedHost: '127.0.0.1', reason: 'loopback' },
    { url: 'http://127.0.0.1:5432/', expectedHost: '127.0.0.1', reason: 'loopback' },
    { url: 'http://[::1]/', expectedHost: '::1', reason: 'loopback' },
    { url: 'http://0.0.0.0/', expectedHost: '0.0.0.0', reason: 'unspecified' },

    // Private IP ranges
    { url: 'http://10.0.0.1/', expectedHost: '10.0.0.1', reason: 'private' },
    { url: 'http://10.255.255.255/', expectedHost: '10.255.255.255', reason: 'private' },
    { url: 'http://172.16.0.1/', expectedHost: '172.16.0.1', reason: 'private' },
    { url: 'http://172.31.255.255/', expectedHost: '172.31.255.255', reason: 'private' },
    { url: 'http://192.168.0.1/', expectedHost: '192.168.0.1', reason: 'private' },
    { url: 'http://192.168.255.255/', expectedHost: '192.168.255.255', reason: 'private' },

    // IPv6 link-local (fe80::/10)
    { url: 'http://[fe80::1]/', expectedHost: 'fe80::1', reason: 'linkLocal' },

    // Cloud metadata endpoints
    { url: 'http://169.254.169.254/', expectedHost: '169.254.169.254', reason: 'metadata' },
    { url: 'http://169.254.169.254/latest/meta-data/', expectedHost: '169.254.169.254', reason: 'metadata' },
    { url: 'http://metadata.google.internal/', expectedHost: 'metadata.google.internal', reason: 'metadata' },
    { url: 'http://100.100.100.200/', expectedHost: '100.100.100.200', reason: 'metadata' },

    // Protocol smuggling (blocked protocols)
    { url: 'file:///etc/passwd', expectedHost: '', reason: 'protocol' },
    { url: 'gopher://127.0.0.1:25/', expectedHost: '127.0.0.1', reason: 'protocol' },
    { url: 'dict://127.0.0.1:11211/', expectedHost: '127.0.0.1', reason: 'protocol' },
  ];

  describe('URL validation in file processor', () => {
    ssrfPayloads.forEach(({ url: payload, expectedHost, reason }) => {
      it(`blocks SSRF payload (${reason}): ${payload}`, async () => {
        // First, verify we're parsing the URL correctly
        try {
          const parsed = new URL(payload);
          expect(parsed.hostname).toBe(expectedHost);
        } catch {
          // file:// URLs may not parse the same way - that's ok
        }

        const response = await processorIngest({
          url: payload,
          userId: testUser.id
        });

        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/blocked|invalid|forbidden/i);
        // Verify the error indicates the correct blocking reason
        expect(response.body.reason || response.body.error).toMatch(
          new RegExp(reason, 'i')
        );
      });
    });
  });

  /**
   * Auth component bypass tests
   * URL auth syntax: http://user:pass@host/ - the "host" after @ is the real target
   */
  describe('Auth component bypass prevention', () => {
    it('correctly identifies target host in auth@host URLs', () => {
      // http://127.0.0.1%00@attacker.com/ - null byte is invalid, parsed as attacker.com
      const url1 = new URL('http://127.0.0.1%00@attacker.com/');
      expect(url1.hostname).toBe('attacker.com');
      // This should be ALLOWED (attacker.com is external)

      // http://attacker.com@127.0.0.1/ - auth syntax, target is 127.0.0.1
      const url2 = new URL('http://attacker.com@127.0.0.1/');
      expect(url2.hostname).toBe('127.0.0.1');
      // This should be BLOCKED (127.0.0.1 is loopback)
    });

    it('blocks auth component attacks targeting internal IPs', async () => {
      // The @ makes "attacker.com" the username, "127.0.0.1" the actual host
      const response = await processorIngest({
        url: 'http://attacker.com@127.0.0.1/',
        userId: testUser.id
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/blocked|loopback/i);
    });

    it('allows auth component URLs targeting external hosts', async () => {
      // The null byte makes this invalid, resulting in attacker.com as host
      // Depending on implementation, this might be blocked or allowed
      // Document the expected behavior clearly
      const response = await processorIngest({
        url: 'http://127.0.0.1%00@attacker.com/',
        userId: testUser.id
      });

      // This URL's actual hostname is "attacker.com" which is external
      // Implementation should either:
      // 1. Block for having suspicious auth component, OR
      // 2. Allow after verifying attacker.com resolves to public IP
      expect([200, 400]).toContain(response.status);
    });
  });

  /**
   * Scenario: DNS resolution returns private IP
   */
  it('blocks DNS resolution to private IPs', async () => {
    // This requires a test domain that resolves to 127.0.0.1
    const response = await processorIngest({
      url: 'http://test-ssrf-127.example.com/',
      userId: testUser.id
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('private IP');
  });

  /**
   * Scenario: Redirect to internal URL
   */
  it('blocks redirect chains to internal URLs', async () => {
    // External URL that 302s to http://169.254.169.254/
    mockExternalRedirect('http://attacker.com/redirect', 'http://169.254.169.254/');

    const response = await processorIngest({
      url: 'http://attacker.com/redirect',
      userId: testUser.id
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('redirect');
  });

  /**
   * IPv6-mapped IPv4 address bypass
   */
  it('blocks IPv6-mapped IPv4 addresses', async () => {
    // ::ffff:127.0.0.1 is IPv4-mapped IPv6 for 127.0.0.1
    const response = await processorIngest({
      url: 'http://[::ffff:127.0.0.1]/',
      userId: testUser.id
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/blocked|loopback/i);
  });
});
```

---

## Part 4: Session Security Tests

```typescript
// apps/web/src/app/api/auth/__tests__/session-security.test.ts

describe('Session Security', () => {
  /**
   * Session Fixation Prevention
   */
  describe('Session Fixation', () => {
    it('session identifier changes on login', async () => {
      // Create a pre-auth session (e.g., CSRF token)
      const preAuthSession = await getPreAuthSession();

      // Login
      const { sessionId } = await loginUser(testUser);

      // Session ID should be different
      expect(sessionId).not.toBe(preAuthSession.id);
    });

    it('CSRF token is regenerated on login', async () => {
      const preAuthCSRF = await getLoginCSRFToken();
      const { csrfToken: postAuthCSRF } = await loginUser(testUser);

      expect(postAuthCSRF).not.toBe(preAuthCSRF);
    });

    it('pre-auth CSRF token invalid after login', async () => {
      const preAuthCSRF = await getLoginCSRFToken();
      const { accessToken } = await loginUser(testUser);

      const response = await authenticatedRequest(accessToken, '/api/pages', {
        method: 'POST',
        headers: { 'X-CSRF-Token': preAuthCSRF }
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('CSRF');
    });
  });

  /**
   * Cookie Security Attributes
   */
  describe('Cookie Security', () => {
    // Properly isolate environment changes to prevent test pollution
    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('access token cookie has httpOnly flag', async () => {
      const response = await loginRequest(testUser);
      const setCookie = response.headers.get('set-cookie');

      expect(setCookie).toContain('accessToken=');
      expect(setCookie).toContain('HttpOnly');
    });

    it('refresh token cookie has httpOnly flag', async () => {
      const response = await loginRequest(testUser);
      const setCookie = response.headers.get('set-cookie');

      expect(setCookie).toContain('refreshToken=');
      expect(setCookie).toContain('HttpOnly');
    });

    it('cookies have SameSite=Strict in production', async () => {
      process.env.NODE_ENV = 'production';
      const response = await loginRequest(testUser);
      const setCookie = response.headers.get('set-cookie');

      expect(setCookie).toContain('SameSite=Strict');
    });

    it('cookies have safe SameSite default in development', async () => {
      // Even in non-production, SameSite should default to Lax or Strict
      // Never 'None' without Secure flag (browser will reject)
      process.env.NODE_ENV = 'development';
      const response = await loginRequest(testUser);
      const setCookie = response.headers.get('set-cookie');

      // Should be either Strict or Lax (both are safe defaults)
      expect(setCookie).toMatch(/SameSite=(Strict|Lax)/);
      // Must NOT be 'None' without Secure
      expect(setCookie).not.toMatch(/SameSite=None(?!.*Secure)/);
    });

    it('cookies have Secure flag in production', async () => {
      process.env.NODE_ENV = 'production';
      const response = await loginRequest(testUser);
      const setCookie = response.headers.get('set-cookie');

      expect(setCookie).toContain('Secure');
    });

    it('cookie paths are properly scoped', async () => {
      const response = await loginRequest(testUser);
      const setCookie = response.headers.get('set-cookie');

      // Refresh token should be scoped to refresh endpoint only
      expect(setCookie).toMatch(/refreshToken=.*Path=\/api\/auth\/refresh/);
    });
  });
});
```

---

## Part 5: Multi-Tenant Isolation Tests

```typescript
// apps/web/src/app/api/__tests__/multi-tenant-isolation.test.ts

describe('Multi-Tenant Isolation', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeEach(async () => {
    tenantA = await createTestTenant('Tenant A');
    tenantB = await createTestTenant('Tenant B');
  });

  /**
   * Cross-tenant data access prevention
   */
  describe('Data Isolation', () => {
    it('user cannot read pages from another tenant drive', async () => {
      const pageB = await createPage(tenantB.user, tenantB.drive, { title: 'Secret' });

      const response = await authenticatedRequest(
        tenantA.token,
        `/api/pages/${pageB.id}`
      );

      expect(response.status).toBe(403);
    });

    it('user cannot search across tenant boundaries', async () => {
      await createPage(tenantB.user, tenantB.drive, {
        title: 'Secret',
        content: 'confidential-keyword-xyz'
      });

      const response = await authenticatedRequest(
        tenantA.token,
        '/api/search?q=confidential-keyword-xyz'
      );

      expect(response.body.results).toHaveLength(0);
    });

    it('user cannot access files via content hash from another tenant', async () => {
      const file = await uploadFile(tenantB.user, tenantB.drive, 'secret.pdf');

      const response = await authenticatedRequest(
        tenantA.token,
        `/api/files/${file.id}/download`
      );

      expect(response.status).toBe(403);
    });

    it('content-addressed storage does not leak across tenants', async () => {
      // Same file uploaded by both tenants
      const content = 'identical content';
      const fileA = await uploadContent(tenantA.user, tenantA.drive, content);
      const fileB = await uploadContent(tenantB.user, tenantB.drive, content);

      // Both should have same content hash
      expect(fileA.contentHash).toBe(fileB.contentHash);

      // But access should still be isolated
      const responseA = await authenticatedRequest(tenantA.token, `/api/files/${fileB.id}/download`);
      expect(responseA.status).toBe(403);
    });
  });

  /**
   * Service token cross-tenant prevention
   */
  describe('Service Token Isolation', () => {
    it('service token for tenant A cannot access tenant B files', async () => {
      const fileB = await uploadFile(tenantB.user, tenantB.drive, 'secret.pdf');

      const serviceToken = await createServiceToken('web', ['files:read'], {
        userId: tenantA.user.id,
        driveIds: [tenantA.drive.id]
      });

      const response = await processorRequest(
        serviceToken,
        `/cache/${fileB.contentHash}/original`
      );

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('tenant');
    });

    it('forged driveId in service token is rejected', async () => {
      // Attacker knows victim's driveId
      const serviceToken = await createServiceToken('web', ['files:read'], {
        userId: tenantA.user.id,
        driveIds: [tenantB.drive.id]  // Attacker puts victim's driveId
      });

      // Processor should validate userId actually has access to driveId
      const fileB = await uploadFile(tenantB.user, tenantB.drive, 'secret.pdf');
      const response = await processorRequest(
        serviceToken,
        `/cache/${fileB.contentHash}/original`
      );

      expect(response.status).toBe(403);
    });
  });

  /**
   * WebSocket room isolation
   */
  describe('Real-time Isolation', () => {
    it('user cannot join WebSocket room for another tenant page', async () => {
      const pageB = await createPage(tenantB.user, tenantB.drive, { title: 'Secret' });

      const socket = await createAuthenticatedSocket(tenantA.token);
      const joinResult = await socket.emitWithAck('join_channel', pageB.id);

      expect(joinResult.error).toContain('access denied');
      expect(socket.rooms).not.toContain(pageB.id);
    });

    it('broadcast messages do not leak across tenant rooms', async () => {
      const pageB = await createPage(tenantB.user, tenantB.drive, { title: 'Secret' });

      const socketA = await createAuthenticatedSocket(tenantA.token);
      const receivedMessages: any[] = [];
      socketA.on('page-update', (msg) => receivedMessages.push(msg));

      // Broadcast to tenant B's page
      await broadcastPageEvent({
        channelId: pageB.id,
        event: 'page-update',
        payload: { secret: 'data' }
      });

      await wait(100);
      expect(receivedMessages).toHaveLength(0);
    });
  });
});
```

---

## Part 6: Token Revocation Tests

```typescript
// packages/lib/src/__tests__/token-revocation.test.ts

describe('Token Revocation', () => {
  /**
   * Immediate revocation effectiveness
   */
  describe('User Token Revocation', () => {
    it('tokenVersion bump invalidates all active access tokens', async () => {
      const { accessToken } = await loginUser(testUser);

      // Verify token works
      let response = await authenticatedRequest(accessToken, '/api/pages');
      expect(response.status).toBe(200);

      // Bump token version (simulates password change, security event, etc.)
      await db.update(users)
        .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, testUser.id));

      // Token should now be invalid
      response = await authenticatedRequest(accessToken, '/api/pages');
      expect(response.status).toBe(401);
    });

    it('tokenVersion bump invalidates all refresh tokens', async () => {
      const { refreshToken } = await loginUser(testUser);

      await db.update(users)
        .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, testUser.id));

      const response = await refreshRequest(refreshToken);
      expect(response.status).toBe(401);
    });
  });

  /**
   * Service token revocation via JTI
   */
  describe('Service Token JTI Revocation', () => {
    it('revoked JTI immediately blocks token use', async () => {
      const token = await createServiceToken('web', ['files:read'], { userId: testUser.id });
      const jti = extractJTI(token);

      // Token works before revocation
      let response = await processorRequest(token, '/cache/abc/original');
      expect([200, 404].includes(response.status)).toBe(true);

      // Revoke
      await redis.set(`service:jti:${jti}`, 'revoked', 'EX', 300);

      // Token blocked
      response = await processorRequest(token, '/cache/abc/original');
      expect(response.status).toBe(401);
    });

    /**
     * NOTE: This test assumes Redis has persistence enabled (RDB or AOF).
     * In production, configure redis.conf with:
     *   save 900 1    # Save after 900 sec if at least 1 key changed
     *   appendonly yes # Enable AOF for durability
     *
     * Without persistence, JTI denylist data would be lost on Redis restart,
     * allowing revoked tokens to be used again.
     */
    it('JTI denylist survives Redis restart', async () => {
      const token = await createServiceToken('web', ['files:read'], { userId: testUser.id });
      const jti = extractJTI(token);

      await redis.set(`service:jti:${jti}`, 'revoked', 'EX', 300);

      // Simulate Redis restart (reconnect)
      await redis.disconnect();
      await redis.connect();

      const response = await processorRequest(token, '/cache/abc/original');
      expect(response.status).toBe(401);
    });

    it('emergency revocation revokes all JTIs for a user', async () => {
      const tokens = await Promise.all([
        createServiceToken('web', ['files:read'], { userId: testUser.id }),
        createServiceToken('web', ['files:write'], { userId: testUser.id }),
        createServiceToken('realtime', ['broadcast'], { userId: testUser.id }),
      ]);

      // Emergency revoke all tokens for user
      await emergencyRevokeAllServiceTokens(testUser.id);

      // All tokens should be blocked
      for (const token of tokens) {
        const response = await processorRequest(token, '/cache/abc/original');
        expect(response.status).toBe(401);
      }
    });
  });

  /**
   * MCP token revocation
   */
  describe('MCP Token Revocation', () => {
    it('revoked MCP token is immediately rejected', async () => {
      const { token, tokenId } = await createMCPToken(testUser.id, 'Test');

      // Works before revocation
      let response = await mcpRequest(token, '/api/mcp/documents');
      expect(response.status).toBe(200);

      // Revoke
      await db.update(mcpTokens)
        .set({ revokedAt: new Date() })
        .where(eq(mcpTokens.id, tokenId));

      // Rejected
      response = await mcpRequest(token, '/api/mcp/documents');
      expect(response.status).toBe(401);
    });
  });
});
```

---

## Part 7: Path Traversal & Input Validation Tests

```typescript
// apps/processor/tests/path-traversal-comprehensive.test.ts

describe('Path Traversal Prevention', () => {
  const traversalPayloads = [
    // Basic traversal
    '../etc/passwd',
    '../../etc/passwd',
    '../../../etc/passwd',
    '....//....//etc/passwd',

    // URL encoding
    '%2e%2e%2f',
    '%2e%2e/',
    '..%2f',
    '%2e%2e%5c',  // backslash

    // Double encoding
    '%252e%252e%252f',
    '..%252f',

    // Unicode variants
    '..%c0%af',  // overlong encoding
    '..%c1%9c',
    '\u002e\u002e/',

    // Null byte injection
    '../etc/passwd%00.jpg',
    '../etc/passwd\x00.jpg',

    // Backslash (Windows)
    '..\\etc\\passwd',
    '..\\..\\etc\\passwd',

    // Mixed slashes
    '..\\../etc/passwd',
    '../..\\etc/passwd',

    // Absolute paths
    '/etc/passwd',
    'C:\\Windows\\System32\\config\\SAM',
  ];

  traversalPayloads.forEach(payload => {
    it(`blocks traversal: ${JSON.stringify(payload)}`, async () => {
      const result = resolvePathWithin('/data/uploads', payload);

      // Should either return null or stay within base
      if (result !== null) {
        expect(result.startsWith('/data/uploads/')).toBe(true);
        expect(result).not.toContain('..');
      }
    });
  });

  /**
   * Symlink traversal
   */
  it('blocks symlink traversal attempts', async () => {
    // This requires filesystem setup
    const symlinkPath = '/data/uploads/symlink';
    await fs.symlink('/etc/passwd', symlinkPath);

    try {
      const result = await resolveAndVerifyPath('/data/uploads', 'symlink');
      expect(result).toBeNull();
    } finally {
      await fs.unlink(symlinkPath);
    }
  });

  /**
   * Filename sanitization
   */
  describe('Filename Sanitization', () => {
    const maliciousFilenames = [
      '<script>alert("xss")</script>.txt',
      'file"; rm -rf /',
      'file\r\nContent-Type: text/html',
      'file\x00.txt',
      '....',
      '. . . .',
    ];

    maliciousFilenames.forEach(filename => {
      it(`sanitizes malicious filename: ${JSON.stringify(filename)}`, () => {
        const sanitized = sanitizeFilename(filename);

        expect(sanitized).not.toContain('<');
        expect(sanitized).not.toContain('>');
        expect(sanitized).not.toContain('"');
        expect(sanitized).not.toContain('\r');
        expect(sanitized).not.toContain('\n');
        expect(sanitized).not.toContain('\x00');
      });
    });
  });
});
```

---

## Part 8: Secret Management Tests

```typescript
// packages/lib/src/__tests__/secret-management.test.ts

describe('Secret Management', () => {
  /**
   * Timing-safe comparisons
   *
   * NOTE: Empirical timing tests (measuring variance) are unreliable for detecting
   * timing attacks because:
   * 1. bcrypt is designed to be slow AND timing-safe, so variance is natural
   * 2. System noise (GC, I/O, scheduling) can mask timing leaks
   * 3. Statistically significant results require thousands of samples
   *
   * Instead, we use static code analysis to verify timingSafeEqual is used
   * for all secret comparisons.
   */
  describe('Timing-Safe Operations', () => {
    it('password comparison uses bcrypt (inherently timing-safe)', async () => {
      // bcrypt.compare is designed to be timing-safe
      // Verify the auth code uses bcrypt, not plain comparison
      const authCode = await fs.readFile(
        'apps/web/src/lib/auth/auth-utils.ts',
        'utf-8'
      );

      expect(authCode).toContain('bcrypt.compare');
      expect(authCode).not.toMatch(/password\s*===\s*|password\s*!==\s*/);
    });

    it('CSRF token comparison uses timingSafeEqual', async () => {
      const csrfUtilsCode = await fs.readFile(
        'apps/web/src/lib/auth/csrf-utils.ts',
        'utf-8'
      );

      expect(csrfUtilsCode).toContain('timingSafeEqual');
      // Verify no plain equality for token comparison
      expect(csrfUtilsCode).not.toMatch(/token\s*===\s*|token\s*!==\s*/);
    });

    it('cron secret comparison uses timingSafeEqual', async () => {
      const cronCode = await fs.readFile(
        'apps/web/src/app/api/cron/cleanup-tokens/route.ts',
        'utf-8'
      );

      expect(cronCode).toContain('timingSafeEqual');
    });

    it('monitoring ingest key comparison uses timingSafeEqual', async () => {
      const ingestCode = await fs.readFile(
        'apps/web/src/app/api/internal/monitoring/ingest/route.ts',
        'utf-8'
      );

      expect(ingestCode).toContain('timingSafeEqual');
    });
  });

  /**
   * Secret length validation
   */
  describe('Secret Validation', () => {
    it('JWT_SECRET must be at least 32 characters', () => {
      const originalSecret = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'short';

      expect(() => getJWTConfig()).toThrow('32 characters');

      process.env.JWT_SECRET = originalSecret;
    });

    it('SERVICE_JWT_SECRET must be at least 32 characters', () => {
      const originalSecret = process.env.SERVICE_JWT_SECRET;
      process.env.SERVICE_JWT_SECRET = 'short';

      expect(() => getServiceConfig()).toThrow('32 characters');

      process.env.SERVICE_JWT_SECRET = originalSecret;
    });
  });

  /**
   * Encryption key management
   */
  describe('Encryption', () => {
    it('API keys are encrypted with AES-256-GCM', async () => {
      const apiKey = 'sk-test-1234567890abcdef';
      const encrypted = await encrypt(apiKey);

      // Should be salt:iv:authTag:ciphertext format
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(4);

      // Salt and IV should be different each time
      const encrypted2 = await encrypt(apiKey);
      expect(encrypted).not.toBe(encrypted2);
    });

    it('decryption with wrong key fails', async () => {
      const originalKey = process.env.ENCRYPTION_KEY;

      process.env.ENCRYPTION_KEY = 'a'.repeat(32);
      const encrypted = await encrypt('secret');

      process.env.ENCRYPTION_KEY = 'b'.repeat(32);
      await expect(decrypt(encrypted)).rejects.toThrow();

      process.env.ENCRYPTION_KEY = originalKey;
    });
  });
});
```

---

## Part 9: Distributed Rate Limiting Tests

```typescript
// packages/lib/src/__tests__/distributed-rate-limit.test.ts

describe('Distributed Rate Limiting', () => {
  /**
   * Redis-based rate limiting
   */
  describe('Redis Rate Limiter', () => {
    it('rate limit persists across simulated instances', async () => {
      const email = 'test@example.com';

      // Hit limit
      for (let i = 0; i < 5; i++) {
        await attemptLogin(email, 'wrong');
      }

      // Different "instance" should see the limit
      const rateLimit = await getRateLimitStatus(email, 'login');
      expect(rateLimit.remaining).toBe(0);
      expect(rateLimit.blocked).toBe(true);
    });

    it('sliding window algorithm works correctly', async () => {
      const email = 'test@example.com';

      // 3 attempts now
      for (let i = 0; i < 3; i++) {
        await attemptLogin(email, 'wrong');
      }

      // Advance 10 minutes (within 15-minute window)
      await advanceTime(10 * 60 * 1000);

      // 2 more attempts
      for (let i = 0; i < 2; i++) {
        await attemptLogin(email, 'wrong');
      }

      // Should now be blocked (5 in 15 minutes)
      const response = await attemptLogin(email, 'wrong');
      expect(response.status).toBe(429);

      // Advance 6 more minutes (first 3 fall off)
      await advanceTime(6 * 60 * 1000);

      // Should be able to attempt again
      const status = await getRateLimitStatus(email, 'login');
      expect(status.remaining).toBe(3);
    });

    it('rate limiting is mandatory in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalRedis = process.env.REDIS_URL;

      process.env.NODE_ENV = 'production';
      delete process.env.REDIS_URL;

      // Should throw on startup without Redis
      await expect(initializeRateLimiter()).rejects.toThrow('Redis required');

      process.env.NODE_ENV = originalEnv;
      process.env.REDIS_URL = originalRedis;
    });
  });

  /**
   * Rate limit bypass prevention
   */
  describe('Bypass Prevention', () => {
    it('X-Forwarded-For cannot bypass IP rate limiting', async () => {
      // Block the IP
      for (let i = 0; i < 5; i++) {
        await attemptLogin('test@example.com', 'wrong', {
          headers: { 'X-Forwarded-For': '1.2.3.4' }
        });
      }

      // Try with different X-Forwarded-For
      const response = await attemptLogin('test@example.com', 'wrong', {
        headers: { 'X-Forwarded-For': '5.6.7.8' }
      });

      // Should still be blocked (email-based limit)
      expect(response.status).toBe(429);
    });
  });
});
```

---

## Part 10: Integration & E2E Security Tests

```typescript
// apps/web/e2e/security.spec.ts (Playwright)

import { test, expect } from '@playwright/test';

test.describe('Security E2E Tests', () => {
  test('complete authentication flow maintains security invariants', async ({ page, context }) => {
    // 1. Navigate to login
    await page.goto('/login');

    // 2. Verify CSRF token is present
    const csrfToken = await page.evaluate(() => {
      return document.querySelector('input[name="csrfToken"]')?.value;
    });
    expect(csrfToken).toBeTruthy();

    // 3. Login
    await page.fill('input[name="email"]', 'test@example.com');
    await page.fill('input[name="password"]', 'password123');
    await page.click('button[type="submit"]');

    // 4. Verify cookies are set correctly
    const cookies = await context.cookies();
    const accessToken = cookies.find(c => c.name === 'accessToken');
    const refreshToken = cookies.find(c => c.name === 'refreshToken');

    expect(accessToken?.httpOnly).toBe(true);
    expect(accessToken?.sameSite).toBe('Strict');

    expect(refreshToken?.httpOnly).toBe(true);
    expect(refreshToken?.sameSite).toBe('Strict');
    expect(refreshToken?.path).toBe('/api/auth/refresh');

    // 5. Verify CSRF token changed after login
    await page.goto('/settings');
    const newCsrfToken = await page.evaluate(() => {
      return document.querySelector('meta[name="csrf-token"]')?.content;
    });
    expect(newCsrfToken).not.toBe(csrfToken);
  });

  test('XSS protection in user content', async ({ page }) => {
    await loginAsTestUser(page);

    // Create page with XSS payload
    await page.goto('/new');
    await page.fill('[data-testid="title-input"]', '<script>alert("xss")</script>');
    await page.fill('[data-testid="content-editor"]', '<img src=x onerror=alert("xss")>');
    await page.click('[data-testid="save-button"]');

    // Navigate to the page
    await page.goto('/pages/new-page');

    // Verify no alert was triggered
    // Playwright will throw if dialog appears
    const content = await page.content();
    expect(content).not.toContain('<script>alert');
    expect(content).not.toContain('onerror=alert');
  });

  /**
   * CSRF Protection Test
   *
   * This test simulates a cross-site request forgery attack scenario:
   *
   * Attack Model:
   * 1. Victim is logged into PageSpace (has valid session cookies)
   * 2. Attacker hosts a malicious site that submits forms to PageSpace
   * 3. If victim visits attacker's site, the browser sends cookies automatically
   * 4. Without CSRF protection, attacker could perform actions as victim
   *
   * Why this test works:
   * - We copy victim's cookies to attacker context (simulating cross-site request)
   * - Attacker CANNOT access the CSRF token (it's in a same-site cookie or DOM)
   * - SameSite=Strict cookies prevent cross-site cookie sending in real attacks
   * - This test verifies the server rejects requests without valid CSRF tokens
   *
   * Defense layers:
   * 1. SameSite=Strict cookies (primary defense)
   * 2. CSRF token validation (defense in depth)
   * 3. Origin header validation (additional layer)
   */
  test('CSRF protection prevents cross-site POST', async ({ page, context }) => {
    await loginAsTestUser(page);

    // Get the auth cookies (in real attack, browser sends these automatically)
    const cookies = await context.cookies();

    // Create a new browser context (simulating attacker's site at evil.com)
    const attackerContext = await page.context().browser()!.newContext();
    const attackerPage = await attackerContext.newPage();

    // Copy victim's cookies to attacker context
    // This simulates what would happen if SameSite wasn't set (legacy browsers)
    await attackerContext.addCookies(cookies);

    // Attacker tries to POST without CSRF token (they can't access it cross-site)
    const response = await attackerPage.request.post('/api/pages', {
      data: { title: 'Hacked!' }
    });

    // Server MUST reject the request - CSRF token is missing/invalid
    expect(response.status()).toBe(403);
    expect(await response.json()).toHaveProperty('error', expect.stringContaining('CSRF'));

    await attackerContext.close();
  });
});
```

---

## Part 11: Test Utilities & Helpers

```typescript
// packages/lib/src/__tests__/security-test-utils.ts

import { createHash, randomBytes } from 'crypto';

/**
 * Generate malicious inputs for fuzzing
 */
export function getMaliciousInputs(): Record<string, string[]> {
  return {
    sqlInjection: [
      "' OR '1'='1",
      "'; DROP TABLE users--",
      "1; SELECT * FROM users",
      "' UNION SELECT * FROM users--",
    ],
    xss: [
      '<script>alert("xss")</script>',
      '"><script>alert("xss")</script>',
      "javascript:alert('xss')",
      '<img src=x onerror=alert("xss")>',
      '<svg onload=alert("xss")>',
    ],
    pathTraversal: [
      '../../../etc/passwd',
      '..\\..\\..\\etc\\passwd',
      '%2e%2e%2f%2e%2e%2f',
      '....//....//etc/passwd',
    ],
    commandInjection: [
      '; ls -la',
      '| cat /etc/passwd',
      '$(whoami)',
      '`id`',
    ],
    ssrf: [
      'http://localhost:3000',
      'http://127.0.0.1:5432',
      'http://169.254.169.254',
      'file:///etc/passwd',
    ],
  };
}

/**
 * Simulate concurrent requests for race condition testing
 */
export async function racingRequests<T>(
  fn: () => Promise<T>,
  count: number = 10
): Promise<T[]> {
  const barrier = new Promise<void>(resolve => setImmediate(resolve));

  const promises = Array(count).fill(null).map(async () => {
    await barrier;  // Wait for all to be ready
    return fn();
  });

  return Promise.all(promises);
}

/**
 * Extract claims from JWT without verification (for testing)
 */
export function extractJWTClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
}

/**
 * Generate test service token with custom claims
 */
export async function generateTestServiceToken(
  claims: Partial<ServiceTokenClaims>
): Promise<string> {
  return createServiceToken('test', claims.scopes || ['*'], {
    userId: claims.sub as string,
    tenantId: claims.resource,
    driveIds: claims.driveIds,
  });
}

/**
 * Mock Redis for distributed testing
 */
export class MockRedisCluster {
  private stores: Map<string, Map<string, string>> = new Map();

  constructor(nodeCount: number) {
    for (let i = 0; i < nodeCount; i++) {
      this.stores.set(`node-${i}`, new Map());
    }
  }

  async set(key: string, value: string): Promise<void> {
    // Simulate cluster - write to all nodes
    for (const store of this.stores.values()) {
      store.set(key, value);
    }
  }

  async get(key: string, nodeHint?: string): Promise<string | null> {
    // Simulate reading from specific node
    const node = nodeHint || Array.from(this.stores.keys())[0];
    return this.stores.get(node)?.get(key) ?? null;
  }
}
```

---

## Part 12: CI/CD Security Pipeline

```yaml
# .github/workflows/security.yml

name: Security Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  security-tests:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:7
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v2
        with:
          version: 8

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run security unit tests
        run: pnpm test:security
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/test
          REDIS_URL: redis://localhost:6379
          JWT_SECRET: ${{ secrets.TEST_JWT_SECRET }}
          SERVICE_JWT_SECRET: ${{ secrets.TEST_SERVICE_JWT_SECRET }}
          ENCRYPTION_KEY: ${{ secrets.TEST_ENCRYPTION_KEY }}

      - name: Run dependency audit
        run: pnpm audit --audit-level=high

      - name: Run SAST scan
        uses: github/codeql-action/analyze@v2
        with:
          languages: typescript

      - name: Run secret scanning
        uses: trufflesecurity/trufflehog@main
        with:
          path: ./
          base: ${{ github.event.pull_request.base.sha }}
          head: HEAD

  e2e-security:
    runs-on: ubuntu-latest
    needs: security-tests

    steps:
      - uses: actions/checkout@v4

      - name: Start services
        run: docker-compose -f docker-compose.test.yml up -d

      - name: Run Playwright security tests
        run: pnpm test:e2e:security

      - name: OWASP ZAP scan
        uses: zaproxy/action-full-scan@v0.7.0
        with:
          target: 'http://localhost:3000'
          rules_file_name: '.zap/rules.tsv'
```

---

## Part 13: Monitoring & Alerting Tests

```typescript
// packages/lib/src/__tests__/security-monitoring.test.ts

describe('Security Event Monitoring', () => {
  /**
   * Authentication failure tracking
   */
  it('logs authentication failures with context', async () => {
    const logSpy = vi.spyOn(securityLogger, 'warn');

    await attemptLogin('test@example.com', 'wrong-password');

    expect(logSpy).toHaveBeenCalledWith(
      'Authentication failed',
      expect.objectContaining({
        email: 'test@example.com',
        reason: 'invalid_password',
        ip: expect.any(String),
        userAgent: expect.any(String),
        attemptNumber: expect.any(Number),
      })
    );
  });

  /**
   * Token reuse detection alert
   */
  it('alerts on token reuse attack', async () => {
    const alertSpy = vi.spyOn(securityAlerter, 'critical');

    const { refreshToken } = await loginUser(testUser);
    await refreshRequest(refreshToken);
    await refreshRequest(refreshToken);  // Reuse

    expect(alertSpy).toHaveBeenCalledWith(
      'Token reuse detected',
      expect.objectContaining({
        userId: testUser.id,
        tokenId: expect.any(String),
        severity: 'critical',
      })
    );
  });

  /**
   * Brute force detection
   */
  it('triggers alert after rate limit threshold', async () => {
    const alertSpy = vi.spyOn(securityAlerter, 'warn');

    for (let i = 0; i < 6; i++) {
      await attemptLogin('test@example.com', 'wrong');
    }

    expect(alertSpy).toHaveBeenCalledWith(
      'Rate limit triggered',
      expect.objectContaining({
        identifier: 'test@example.com',
        limitType: 'login',
        attempts: 6,
      })
    );
  });
});
```

---

## Summary: Test Coverage Matrix

| Category | Existing | New Tests Required | Priority |
|----------|----------|-------------------|----------|
| JWT/Auth | 90% | Token version, admin role version | HIGH |
| CSRF | 95% | Post-login regeneration | MEDIUM |
| Rate Limit | 85% | Distributed, bypass prevention | CRITICAL |
| Race Conditions | 0% | Full coverage needed | CRITICAL |
| SSRF | 0% | Full coverage needed | CRITICAL |
| Session Security | 40% | Fixation, cookie attrs | HIGH |
| Multi-Tenant | 20% | Full isolation tests | CRITICAL |
| Token Revocation | 30% | JTI tracking, emergency revoke | CRITICAL |
| Path Traversal | 60% | Unicode, symlink, double-encode | HIGH |
| Secrets | 50% | Timing-safe, encryption | HIGH |
| Distributed | 0% | Redis rate limit, cluster | CRITICAL |

**Total New Test Files Required: ~15**
**Estimated Test Cases: ~200+**
