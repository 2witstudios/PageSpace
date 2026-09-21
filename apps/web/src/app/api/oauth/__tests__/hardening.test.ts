/**
 * OAuth Hardening Sweep (Phase 1 task sff4q8l3hbgm15aiqz29dl0t)
 *
 * Structural enforcement: every route file under api/oauth must wire BOTH a
 * distributed rate limiter and audit logging. Unlike the app-wide security
 * audit coverage gate (`api/__tests__/security-audit-coverage.test.ts`),
 * this surface has no allowlist — the whole point of a hardening sweep is
 * that a future OAuth endpoint cannot ship unprotected, not even
 * provisionally. Enumeration is dynamic (readdirSync), so a newly added
 * route.ts file is covered automatically without editing this test.
 */

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const OAUTH_API_DIR = join(__dirname, '..');

const RATE_LIMIT_PATTERN = /checkDistributedRateLimit\(/;
const RATE_LIMIT_IMPORT_PATTERN = /from ['"]@pagespace\/lib\/security\/distributed-rate-limit['"]/;
const AUDIT_CALL_PATTERN = /auditRequest\(/;
const AUDIT_IMPORT_PATTERN = /from ['"]@pagespace\/lib\/audit\/audit-log['"]/;

function collectRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
    if (statSync(full).isDirectory()) {
      results.push(...collectRouteFiles(full));
    } else if (entry === 'route.ts') {
      results.push(full);
    }
  }
  return results;
}

function toLogicalPath(absolutePath: string): string {
  const relative = absolutePath.replace(OAUTH_API_DIR + '/', '');
  return relative.replace(/\/route\.ts$/, '');
}

describe('OAuth hardening sweep', () => {
  const routeFiles = collectRouteFiles(OAUTH_API_DIR);
  const routes = routeFiles.map((f) => ({ path: toLogicalPath(f), file: f, content: readFileSync(f, 'utf-8') }));

  it('discovers the full OAuth route surface (sanity check against a silently-empty glob)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(6);
  });

  it('every OAuth route wires a distributed rate limiter — no endpoint ships unprotected', () => {
    const violations = routes.filter(
      (r) => !RATE_LIMIT_PATTERN.test(r.content) || !RATE_LIMIT_IMPORT_PATTERN.test(r.content),
    );

    expect(violations.map((v) => v.path)).toEqual([]);
  });

  it('every OAuth route emits audit events for security-relevant outcomes', () => {
    const violations = routes.filter(
      (r) => !AUDIT_CALL_PATTERN.test(r.content) || !AUDIT_IMPORT_PATTERN.test(r.content),
    );

    expect(violations.map((v) => v.path)).toEqual([]);
  });

  it('every route that mints from a client_id enforces allowedGrantTypes through the shared clientAllowsGrant guard (ADR 0007: pagespace-agent must be refused at device_authorization)', () => {
    // The registry now holds a client (pagespace-agent) whose allowedGrantTypes
    // exclude the device-code grant. A door that resolves a client but never
    // consults its grant list mints codes that can only ever fail at /token —
    // and would mint a device code for the agent client. Every minting door
    // must call the ONE pure guard, not re-derive `includes` inline.
    const GUARD_CALL = /clientAllowsGrant\(/;
    const GUARD_IMPORT = /clientAllowsGrant[^;]*from ['"]@pagespace\/lib\/auth\/oauth\/clients['"]/s;
    const MINTING_DOORS = ['device_authorization', 'token'];

    const violations = routes
      .filter((r) => MINTING_DOORS.includes(r.path))
      .filter((r) => !GUARD_CALL.test(r.content) || !GUARD_IMPORT.test(r.content));

    expect(routes.filter((r) => MINTING_DOORS.includes(r.path)).length).toBe(MINTING_DOORS.length);
    expect(violations.map((v) => v.path)).toEqual([]);
  });

  it('never logs raw token, code, or user-code material inside an audit call\'s details', () => {
    // A crude but effective guard: the `details` object literal passed to
    // auditRequest must never reference the route's raw secret-holding
    // variables (only clientId/oauthEvent/outcome-shaped summaries).
    const FORBIDDEN_IN_AUDIT_DETAILS = [/token:\s*[a-zA-Z]/, /code:\s*[a-zA-Z]/, /userCode:\s*[a-zA-Z]/, /assertion:\s*[a-zA-Z]/, /secret:\s*[a-zA-Z]/];
    const violations: string[] = [];

    for (const route of routes) {
      const auditCalls = route.content.match(/auditRequest\([^;]*?\}\s*\)/gs) ?? [];
      for (const call of auditCalls) {
        for (const pattern of FORBIDDEN_IN_AUDIT_DETAILS) {
          if (pattern.test(call)) {
            violations.push(`${route.path}: ${call.slice(0, 80)}...`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  /**
   * Agent Signup Phase 2 — the jwt-bearer grant (ADR 0007 Decisions 5-6,
   * threat model T3/T4). An agent secret is full control of an agent account,
   * so the grant must never become an oracle: every credential or scope
   * failure is the one invalid_grant body, and the client/scope refusals run
   * before the secret is looked up at all.
   */
  describe('jwt-bearer (agent assertion) grant', () => {
    const token = routes.find((r) => r.path === 'token');
    const handlerBody = (() => {
      const src = token?.content ?? '';
      const start = src.indexOf('async function handleAgentAssertionGrant(');
      const end = src.indexOf('\n}\n', start);
      return start === -1 ? '' : src.slice(start, end);
    })();

    it('the token route dispatches the RFC 7523 URN to its own handler', () => {
      expect(handlerBody.length).toBeGreaterThan(0);
      expect(token?.content).toMatch(/grantType === AGENT_ASSERTION_GRANT_TYPE\)\s*\{\s*return handleAgentAssertionGrant\(/);
    });

    it('every response the handler builds is invalid_grant, invalid_request, unauthorized_client, unsupported_grant_type or the token success body — no per-reason oracle', () => {
      const bodies = [...handlerBody.matchAll(/noStoreJson\((.+?),\s*\d{3}\)/g)].map((m) => m[1].trim());
      expect(bodies.length).toBeGreaterThan(0);
      const allowed = new Set([
        'INVALID_GRANT',
        'INVALID_REQUEST',
        "{ error: 'unauthorized_client' }",
        "{ error: 'unsupported_grant_type' }",
        'tokenSuccessBody(result.tokens, result.scopes)',
      ]);
      expect(bodies.filter((b) => !allowed.has(b))).toEqual([]);
      // Both the scope refusal and the credential refusal collapse to invalid_grant.
      expect(bodies.filter((b) => b === 'INVALID_GRANT').length).toBeGreaterThanOrEqual(2);
    });

    it('refuses a client outside the grant, and a content or key-shaped scope, BEFORE the secret is looked up', () => {
      const exchangeAt = handlerBody.indexOf('exchangeAgentAssertion(');
      expect(exchangeAt).toBeGreaterThan(-1);
      const clientGuardAt = handlerBody.indexOf('clientAllowsGrant(registered, AGENT_ASSERTION_GRANT_TYPE)');
      const scopeAt = handlerBody.indexOf('resolveAgentAssertionScopes(');
      const rateLimitAt = handlerBody.indexOf('checkTokenExchangeRateLimit(');
      expect(clientGuardAt).toBeGreaterThan(-1);
      expect(scopeAt).toBeGreaterThan(-1);
      expect(rateLimitAt).toBeGreaterThan(-1);
      expect(clientGuardAt).toBeLessThan(exchangeAt);
      expect(scopeAt).toBeLessThan(exchangeAt);
      expect(rateLimitAt).toBeLessThan(exchangeAt);
    });

    it('the grant is registered to pagespace-agent only — pagespace-cli can never redeem an agent secret', async () => {
      const { getRegisteredClient, clientAllowsGrant } = await import('@pagespace/lib/auth/oauth/clients');
      const { AGENT_ASSERTION_GRANT_TYPE } = await import('@pagespace/lib/auth/oauth/metadata');
      const cli = getRegisteredClient('pagespace-cli');
      const agent = getRegisteredClient('pagespace-agent');
      expect(cli && clientAllowsGrant(cli, AGENT_ASSERTION_GRANT_TYPE)).toBe(false);
      expect(agent && clientAllowsGrant(agent, AGENT_ASSERTION_GRANT_TYPE)).toBe(true);
    });
  });
});
