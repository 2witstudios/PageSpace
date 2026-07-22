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
  /securityAudit\.|logAuditEvent\(|logAuthEvent\(|logSecurityEvent\(|withAdminAuth[<(]|audit\(|auditRequest\(/;

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
  ['version', 'ADR 0001 D2 public handshake endpoint, no auth or user data, constant response'],
  ['compiled-css', 'Static CSS compilation, no user context'],
  ['contact', 'Public contact form, no authenticated user'],
  ['avatar/[userId]/[filename]', 'Public asset serving, no auth required'],
  ['track', 'Analytics fire-and-forget, no data read/write'],
  ['public/forms/[token]/submit', 'Public Canvas-form submission, no authenticated user — every accepted row-append is audit-logged via applyPageMutation activity logging inside appendFormSubmission (changeGroupType: automation), not SecurityAuditService directly'],

  // --- Internal system endpoints ---
  ['internal/*', 'Internal service-to-service endpoints'],
  ['cron/scheduled-backups', 'HMAC-signed internal cron job — no user session, authenticated by shared secret, executes pre-authorized backup schedules'],
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

  // --- Stateless token endpoints (no user data accessed) ---
  ['auth/csrf', 'Stateless CSRF token generation, no user data'],
  ['auth/login-csrf', 'Stateless login CSRF token, no user data'],

  // --- External webhooks (no user session, verified by external party) ---
  ['stripe/webhook', 'Stripe-initiated webhook, verified by Stripe signature'],
  ['integrations/google-calendar/webhook', 'Google-initiated webhook, no user session'],
  ['integrations/zoom/webhook', 'Zoom-initiated webhook, no user session, verified by HMAC signature'],
  ['webhooks/[token]', 'Signature-verified inbound page-webhook intake — no user session, authenticated by per-webhook HMAC secret; minting/managing the webhook is audited in the /api/pages/[pageId]/webhooks routes'],

  // --- Draft persistence (personal, ephemeral, own-user-only) ---
  ['drafts', 'User draft CRUD — ephemeral own-user data, 7-day TTL, no shared resource access'],

  // --- Direct-to-S3 attachment uploads (thin routes; audit lives in the shared
  //     orchestrator) — presign/complete emit data.write via attachment-direct.ts
  //     (auditRequest) and the resolvers emit authz.access.denied on permission /
  //     email-verification denials via attachment-route-helpers.ts; cancel is a
  //     low-risk slot release with no data write. ---
  ['channels/[pageId]/upload/presign', 'Audit emitted by attachment-direct orchestrator + channel resolver denial audit'],
  ['channels/[pageId]/upload/complete', 'Audit emitted by attachment-direct orchestrator + channel resolver denial audit'],
  ['channels/[pageId]/upload/cancel', 'Low-risk slot release, no data write; resolver still authorizes'],
  ['messages/[conversationId]/upload/presign', 'Audit emitted by attachment-direct orchestrator + DM resolver denial audit'],
  ['messages/[conversationId]/upload/complete', 'Audit emitted by attachment-direct orchestrator + DM resolver denial audit'],
  ['messages/[conversationId]/upload/cancel', 'Low-risk slot release, no data write; resolver still authorizes'],

  // --- Read receipts (low-risk, high-frequency) ---
  ['channels/[pageId]/read', 'Channel read receipt, low-risk fire-and-forget'],
  ['notifications/[id]/read', 'Notification read receipt, low-risk'],
  ['notifications/read-all', 'Bulk notification read receipt, low-risk'],
  ['credits/concurrency', 'Polled every 5s by ConcurrencyCard for as long as the usage page stays open — auditing every poll would write ~720 rows/hour per open tab into the audit table for a non-sensitive advisory count (own in-flight credit-hold count + configured tier ceiling, no spend/balance detail)'],

  // --- Model discovery (no user data, no external calls) ---
  ['ai/models', 'Public model-catalog discovery, unauthenticated, no user data or resource access'],
  ['ai/image-models', 'Public image-model discovery, unauthenticated, no user data or resource access'],
  ['ai/ollama/models', 'Local Ollama model discovery, no user data'],
  ['ai/lmstudio/models', 'Local LMStudio model discovery, no user data'],

  // --- OAuth discovery (RFC 8414, public by spec) ---
  ['well-known/oauth-authorization-server', 'RFC 8414 authorization server metadata — public by spec, unauthenticated, no user data or resource access; destination of the /.well-known/oauth-authorization-server rewrite'],

  // --- Share link management routes ---
  // TODO: Add audit coverage in follow-up PR
  ['drives/[driveId]/share-links', 'Share link CRUD — invite link management, follow-up'],
  ['drives/[driveId]/share-links/[linkId]', 'Share link revoke — covered by parent drive auth, follow-up'],
  ['pages/[pageId]/share-links', 'Page share link CRUD — covered by page canShare check, follow-up'],
  ['pages/[pageId]/share-links/[linkId]', 'Page share link revoke — covered by parent page auth, follow-up'],
  ['share/[token]', 'Token info read — session-auth required; reads only publicly-shareable link metadata, no user data written, low-risk read'],

  // --- Drive backup sub-routes ---
  ['drives/[driveId]/backups/schedule', 'Backup schedule GET/PATCH — owner/admin-gated settings, tier enforcement audited via isDriveOwnerOrAdmin; no sensitive data written beyond schedule config'],
  ['drives/[driveId]/backups/[backupId]', 'Read-only backup detail (pages/members/roles/files) — no data written, covered by isDriveOwnerOrAdmin check'],
  ['drives/[driveId]/backups/[backupId]/diff', 'Read-only diff preview — no data written, covered by parent backup auth'],
  ['drives/[driveId]/backups/[backupId]/download', 'Read-only JSON download — no data written, covered by getDriveBackupDetail authz'],
  ['drives/[driveId]/backups/[backupId]/export', 'Read-only ZIP download — no data written, covered by streamBackupExport authz'],
  ['drives/[driveId]/backups/[backupId]/pages', 'Read-only snapshot page tree — no data written, covered by isDriveOwnerOrAdmin check'],
  ['backups/[backupId]/pages', 'Read-only snapshot page tree (global route, settings context) — no data written, covered by isDriveOwnerOrAdmin check on backup.driveId'],

  // --- Drive sub-routes (read-only data fetches, covered by parent drive audit) ---
  // TODO: Add audit coverage in follow-up PR
  ['drives/[driveId]/access', 'Read-only access check — follow-up'],
  ['drives/[driveId]/agents', 'Agent list for drive — follow-up'],
  ['drives/[driveId]/agents/members', 'Agent member list — read-only, covered by parent drive audit, follow-up'],
  ['drives/[driveId]/apps/members', 'MCP token (app) member list — read-only, covered by parent drive audit, follow-up'],
  ['drives/[driveId]/assignees', 'Assignee list for drive — follow-up'],
  ['drives/[driveId]/history', 'Drive history view — follow-up'],
  ['drives/[driveId]/integrations', 'Integration list for drive — follow-up'],
  ['drives/[driveId]/integrations/audit', 'Integration audit log — follow-up'],
  ['drives/[driveId]/members', 'Read-only after Epic 4 retired the legacy POST; writes now go through members/invite which is audited'],
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
  ['pages/[pageId]/reprocess', 'Reprocess trigger — follow-up'],
  ['pages/[pageId]/tasks/[taskId]', 'Individual task CRUD — follow-up'],
  ['pages/[pageId]/tasks/reorder', 'Task reorder — follow-up'],
  ['pages/[pageId]/tasks/statuses', 'Task status list — follow-up'],
  ['pages/[pageId]/view', 'Page view endpoint — follow-up'],
  ['pages/tree', 'Page tree navigation — follow-up'],

  // --- Account sub-routes (status checks) ---
  // TODO: Add audit coverage in follow-up PR
  ['account/drives-status', 'Drive status check — follow-up'],
  ['account/verification-status', 'Email verification status — follow-up'],

  // --- Monitoring with admin auth (already audited via withAdminAuth wrapper) ---
  ['monitoring/[metric]', 'Uses withAdminAuth which includes audit — verify after merge'],

  // --- Machine sandbox routes (audited via the shared writeCodeExecutionAudit
  // pipeline deep in the machines orchestration layer, not directly in route.ts) ---
  ['machines/branches', 'Audited via writeCodeExecutionAudit in machine-branches.ts (git clone/checkout on the branch Sprite)'],
  ['machines/projects', 'Audited via writeCodeExecutionAudit in machine-projects.ts (git clone on the owning Machine)'],
  ['machines/projects/promote', 'Audited via writeCodeExecutionAudit inside promoteProject (machine-project-promotion.ts — provision/clone/credential propagation onto the project Sprite), the same deep audit path as machines/branches; the route is a thin operator surface over the same service the first project-scoped spawn calls'],
  ['machines/agent-terminals', 'Reserves/kills a named PTY session tracking row; the PTY itself is audited via writeCodeExecutionAudit when opened (see apps/realtime/src/index.ts)'],
  ['machines/files', 'Read-only working-tree browse (fixed `ls` + single file read on an already-provisioned branch Sprite) — no data write, no code execution/provisioning, no git; GET-only, view-gated by canViewMachine and path-confined to the branch checkout root, consistent with the other read-only machines/* and drive/page read sub-routes'],
  ['machines/git-blob', 'Audited via writeCodeExecutionAudit inside runGitInSandbox (machine-git-blob.ts\'s `git show <ref>:<path>` on the branch Sprite) — same deep audit path as machines/branches and machines/projects, not a direct route.ts call'],
  ['machines/diff', 'Audited via writeCodeExecutionAudit inside runGitInSandbox (machine-diff.ts\'s status/diff/merge-base/`git show` calls on the branch Sprite — same deep audit path as machines/git-blob); its only non-git read is the same read-only, path-confined working-tree file read machines/files documents'],

  // --- Integration-tool UI routes (audited via the shared executeToolSaga
  // audit path deep in the integrations engine, not directly in route.ts) ---
  ['integrations/github/repos', 'Audited via logAuditEntry inside the shared executeToolSaga (packages/lib/src/integrations/saga/execute-tool.ts) — the same integration-tool-call audit path AI-agent tool-calling routes use for this saga'],
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

  /**
   * AI routes are the highest abuse surface in the app: prompt injection,
   * model abuse, and data exfiltration through agents all probe through
   * these endpoints before landing. Emitting `authz.access.denied` on the
   * auth/permission-denial paths is what lets SIEM detect the probing.
   * Success-only audit coverage is not enough for the AI subset.
   */
  const AI_ROUTES_REQUIRING_DENIAL_AUDIT: string[] = [
    // Chat subset
    'ai/abort',
    'ai/chat',
    'ai/chat/messages',
    'ai/chat/messages/[messageId]',
    'ai/chat/messages/[messageId]/undo',
    // Settings
    'ai/settings',
    // Global assistant
    'ai/global',
    'ai/global/active',
    'ai/global/[id]',
    'ai/global/[id]/messages',
    'ai/global/[id]/messages/[messageId]',
    'ai/global/[id]/usage',
    // Page agents
    'ai/page-agents/consult',
    'ai/page-agents/create',
    'ai/page-agents/multi-drive',
    'ai/page-agents/[agentId]/config',
    'ai/page-agents/[agentId]/conversations',
    'ai/page-agents/[agentId]/conversations/[conversationId]',
    'ai/page-agents/[agentId]/conversations/[conversationId]/messages',
    'ai/page-agents/[agentId]/conversations/[conversationId]/messages/[messageId]',
  ];

  it('AI routes should audit authz.access.denied on auth/permission-failure paths', () => {
    const routeByPath = new Map(routes.map((r) => [r.path, r.file]));
    const violations: string[] = [];

    for (const routePath of AI_ROUTES_REQUIRING_DENIAL_AUDIT) {
      const file = routeByPath.get(routePath);
      if (!file) {
        violations.push(`${routePath} (route file not found)`);
        continue;
      }
      const content = readFileSync(file, 'utf-8');
      if (!/authz\.access\.denied/.test(content)) {
        violations.push(routePath);
      }
    }

    expect(violations).toEqual([]);
    if (violations.length > 0) {
      console.error(
        `\nAI routes missing authz.access.denied audit for ${violations.length} route(s):\n` +
          violations.map((v) => `  - ${v}`).join('\n') +
          '\n\nFix: On each early-return path representing an auth/permission' +
          '\nfailure, call auditRequest(request, { eventType: "authz.access.denied", ... })' +
          '\nbefore returning the error response so SIEM can detect probing.\n'
      );
    }
  });
});
