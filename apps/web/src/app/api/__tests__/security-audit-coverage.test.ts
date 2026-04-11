/**
 * Security Audit Route Coverage Gate
 *
 * Ensures every API route has SecurityAuditService coverage or is
 * explicitly listed in the allowlist with a justification.
 *
 * This test prevents regressions: new routes must either add audit
 * logging or be added to AUDIT_EXEMPT_ROUTES with a reason.
 */

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const API_DIR = join(__dirname, '..');

/**
 * Regex matching any form of security audit call used across the codebase.
 * Covers: direct securityAudit.* calls, logAuditEvent helper, logAuthEvent
 * adapter, logSecurityEvent adapter, and withAdminAuth wrapper.
 */
const AUDIT_CALL_PATTERN =
  /securityAudit\.|logAuditEvent\(|logAuthEvent\(|logSecurityEvent\(|withAdminAuth[<(]/;

/**
 * Routes explicitly exempt from audit coverage.
 * Each entry: route path -> justification.
 *
 * Supports exact match and prefix wildcards (e.g., "debug/*").
 * To add a new exempt route, add it here with a clear reason.
 */
const AUDIT_EXEMPT_ROUTES = new Map<string, string>([
  // --- Public/unauthenticated endpoints (no user context to audit) ---
  ['health', 'Infrastructure health probe, no auth or user data'],
  ['compiled-css', 'Static CSS compilation, no user context'],
  ['contact', 'Public contact form, no authenticated user'],
  ['avatar/[userId]/[filename]', 'Public asset serving, no auth required'],
  ['track', 'Analytics fire-and-forget, no data read/write'],

  // --- Internal system endpoints ---
  ['internal/*', 'Internal service-to-service endpoints'],
  ['memory/cron', 'Internal memory cron job'],
  ['desktop-bridge/status', 'Desktop app connection status check'],
  ['provisioning-status/[slug]', 'Tenant provisioning status polling'],

  // --- Dev/debug endpoints ---
  ['debug/*', 'Development-only debug endpoints'],

  // --- Monitoring (read-only system metrics) ---
  ['pulse', 'Internal engagement monitoring'],
  ['pulse/cron', 'Internal pulse cron job'],
  ['pulse/generate', 'Internal pulse generation'],

  // --- OAuth initiation redirects (no user authenticated, just builds redirect URL) ---
  ['auth/apple/signin', 'OAuth initiation redirect, no user session or data access'],
  ['auth/google/signin', 'OAuth initiation redirect, no user session or data access'],

  // --- Deprecated endpoints ---
  ['admin/users/[userId]/subscription', 'Deprecated (410 Gone), replaced by gift-subscription'],

  // --- Stateless token endpoints (no user data accessed) ---
  ['auth/csrf', 'Stateless CSRF token generation, no user data'],
  ['auth/login-csrf', 'Stateless login CSRF token, no user data'],

  // --- External webhooks (no user session, verified by external party) ---
  ['stripe/webhook', 'Stripe-initiated webhook, verified by Stripe signature'],
  ['integrations/google-calendar/webhook', 'Google-initiated webhook, no user session'],

  // --- Read receipts (low-risk, high-frequency) ---
  ['channels/[pageId]/read', 'Channel read receipt, low-risk fire-and-forget'],
  ['notifications/[id]/read', 'Notification read receipt, low-risk'],
  ['notifications/read-all', 'Bulk notification read receipt, low-risk'],

  // --- Local model discovery (no user data, no external calls) ---
  ['ai/ollama/models', 'Local Ollama model discovery, no user data'],
  ['ai/lmstudio/models', 'Local LMStudio model discovery, no user data'],

  // --- Drive sub-routes (read-only data fetches, covered by parent drive audit) ---
  // TODO: Add audit coverage in follow-up PR
  ['drives/[driveId]/access', 'Read-only access check — follow-up'],
  ['drives/[driveId]/agents', 'Agent list for drive — follow-up'],
  ['drives/[driveId]/assignees', 'Assignee list for drive — follow-up'],
  ['drives/[driveId]/history', 'Drive history view — follow-up'],
  ['drives/[driveId]/integrations', 'Integration list for drive — follow-up'],
  ['drives/[driveId]/integrations/audit', 'Integration audit log — follow-up'],
  ['drives/[driveId]/pages', 'Page list for drive — follow-up'],
  ['drives/[driveId]/permissions-tree', 'Permissions tree view — follow-up'],
  ['drives/[driveId]/search/glob', 'Glob search within drive — follow-up'],
  ['drives/[driveId]/search/regex', 'Regex search within drive — follow-up'],
  ['drives/[driveId]/trash', 'Trash list for drive — follow-up'],

  // --- Page sub-routes (read-only data fetches, covered by parent page audit) ---
  // TODO: Add audit coverage in follow-up PR
  ['pages/[pageId]/agent-config', 'Page agent config — follow-up'],
  ['pages/[pageId]/ai-usage', 'AI usage stats — follow-up'],
  ['pages/[pageId]/breadcrumbs', 'Breadcrumb navigation — follow-up'],
  ['pages/[pageId]/children', 'Child page list — follow-up'],
  ['pages/[pageId]/history', 'Page history view — follow-up'],
  ['pages/[pageId]/permissions/check', 'Permission check — follow-up'],
  ['pages/[pageId]/processing-status', 'Processing status poll — follow-up'],

  // --- Account sub-routes (status checks) ---
  // TODO: Add audit coverage in follow-up PR
  ['account/drives-status', 'Drive status check — follow-up'],
  ['account/verification-status', 'Email verification status — follow-up'],

  // --- Monitoring with admin auth (already audited via withAdminAuth wrapper) ---
  ['monitoring/[metric]', 'Uses withAdminAuth which includes audit — verify after merge'],
]);

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
  const relative = absolutePath.replace(API_DIR + '/', '');
  return relative.replace(/\/route\.ts$/, '');
}

function isExempt(routePath: string): boolean {
  if (AUDIT_EXEMPT_ROUTES.has(routePath)) return true;

  for (const [pattern] of AUDIT_EXEMPT_ROUTES) {
    if (pattern.endsWith('/*') && routePath.startsWith(pattern.slice(0, -1))) {
      return true;
    }
  }
  return false;
}

describe('Security Audit Route Coverage', () => {
  const routeFiles = collectRouteFiles(API_DIR);
  const routes = routeFiles.map((f) => ({
    path: toLogicalPath(f),
    file: f,
  }));

  it('every API route should have security audit coverage or be explicitly exempt', () => {
    const violations: string[] = [];

    for (const route of routes) {
      if (isExempt(route.path)) continue;

      const content = readFileSync(route.file, 'utf-8');
      if (!AUDIT_CALL_PATTERN.test(content)) {
        violations.push(route.path);
      }
    }

    expect(violations).toEqual([]);
    if (violations.length > 0) {
      console.error(
        `\nSecurity audit coverage missing for ${violations.length} route(s):\n` +
          violations.map((v) => `  - ${v}`).join('\n') +
          '\n\nFix: Add securityAudit calls to the route handler,' +
          '\n     OR add it to AUDIT_EXEMPT_ROUTES with a justification.\n'
      );
    }
  });

  it('allowlist should not contain stale entries for routes that no longer exist', () => {
    const routePaths = new Set(routes.map((r) => r.path));
    const stale: string[] = [];

    for (const [pattern] of AUDIT_EXEMPT_ROUTES) {
      if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -1);
        const hasMatch = routes.some((r) => r.path.startsWith(prefix));
        if (!hasMatch) stale.push(pattern);
      } else {
        if (!routePaths.has(pattern)) stale.push(pattern);
      }
    }

    expect(stale).toEqual([]);
    if (stale.length > 0) {
      console.error(
        `\nStale AUDIT_EXEMPT_ROUTES entries (routes no longer exist):\n` +
          stale.map((s) => `  - ${s}`).join('\n') +
          '\n\nRemove these entries from the allowlist.\n'
      );
    }
  });

  it('should discover a reasonable number of routes (sanity check)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(240);
  });
});
