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

  it('never logs raw token, code, or user-code material inside an audit call\'s details', () => {
    // A crude but effective guard: the `details` object literal passed to
    // auditRequest must never reference the route's raw secret-holding
    // variables (only clientId/oauthEvent/outcome-shaped summaries).
    const FORBIDDEN_IN_AUDIT_DETAILS = [/token:\s*[a-zA-Z]/, /code:\s*[a-zA-Z]/, /userCode:\s*[a-zA-Z]/];
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
});
