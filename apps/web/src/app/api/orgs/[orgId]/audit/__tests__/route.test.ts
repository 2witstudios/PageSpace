/**
 * /api/orgs/[orgId]/audit and /audit/export (Spec AUD-3, X-6). The audit store is faked; authorization and
 * filter validation are NOT: the real requireOrgRole runs over a faked membership lookup and the real
 * parseOrgAuditFilter validates the query string.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: { EMAIL_RESEND: 'EMAIL_RESEND', API: 'API' },
}));
vi.mock('@pagespace/lib/audit/org-audit-query', () => ({ queryOrgAuditEvents: vi.fn(), exportOrgAuditCsv: vi.fn() }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { exportOrgAuditCsv, queryOrgAuditEvents } from '@pagespace/lib/audit/org-audit-query';
import { GET } from '../route';
import { GET as EXPORT } from '../export/route';

const ORG_ID = 'org_northwind';
const session = (userId: string): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0 });
const ctx = { params: Promise.resolve({ orgId: ORG_ID }) };
const req = (path: string) => new Request(`https://example.test/api/orgs/${ORG_ID}/audit${path}`);
const as = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);

async function* csv(...chunks: string[]) {
  for (const chunk of chunks) yield chunk;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.orgsEnabled = true;
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_priya'));
  vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
  vi.mocked(queryOrgAuditEvents).mockResolvedValue({ entries: [], nextCursor: null });
  vi.mocked(exportOrgAuditCsv).mockImplementation(() => csv('timestamp,category\r\n', 'a,b\r\n'));
});

describe('org audit routes', () => {
  it('AUD-3 (partial) X-6 (partial) only Owner and Admins read or export the log; a member is refused and a non-member sees no org', async () => {
    as('MEMBER');
    expect((await GET(req(''), ctx)).status).toBe(403);
    expect((await EXPORT(req('/export'), ctx)).status).toBe(403);
    as(null);
    expect((await GET(req(''), ctx)).status).toBe(404);
    expect((await EXPORT(req('/export'), ctx)).status).toBe(404);
    expect(queryOrgAuditEvents).not.toHaveBeenCalled();
    expect(exportOrgAuditCsv).not.toHaveBeenCalled();
  });

  it('AUD-3 (partial) dark while ORGS_ENABLED is off', async () => {
    flags.orgsEnabled = false;
    as('OWNER');
    expect((await GET(req(''), ctx)).status).toBe(404);
    expect((await EXPORT(req('/export'), ctx)).status).toBe(404);
  });

  it('AUD-3 (partial) passes type, drive, time and cursor through, always for the org in the path', async () => {
    as('ADMIN');
    const res = await GET(req('?type=org.drive.visibility_changed&driveId=drive_finance&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z&limit=25&before=77'), ctx);
    expect(res.status).toBe(200);
    expect(queryOrgAuditEvents).toHaveBeenCalledWith(ORG_ID, {
      eventTypes: ['org.drive.visibility_changed'],
      driveId: 'drive_finance',
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-02T00:00:00Z'),
      limit: 25,
      before: 77,
    });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.read', resourceType: 'organization_audit_log', resourceId: ORG_ID }));
  });

  it('AUD-3 (partial) a type outside the org catalog or a bad window is a 400, never a wider query', async () => {
    as('OWNER');
    for (const q of ['?type=auth.login.success', '?category=all', '?from=nope', '?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z']) {
      expect((await GET(req(q), ctx)).status).toBe(400);
      expect((await EXPORT(req(`/export${q}`), ctx)).status).toBe(400);
    }
    expect((await GET(req('?limit=9999'), ctx)).status).toBe(400);
    expect(queryOrgAuditEvents).not.toHaveBeenCalled();
    expect(exportOrgAuditCsv).not.toHaveBeenCalled();
  });

  it('AUD-3 (partial) the export streams CSV as a download, uncached, with the filter but no paging, and is itself audited', async () => {
    as('ADMIN');
    const res = await EXPORT(req('/export?category=visibility&driveId=drive_finance'), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="org-audit-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('timestamp,category\r\na,b\r\n');
    const [orgId, exportFilter] = vi.mocked(exportOrgAuditCsv).mock.calls[0];
    expect(orgId).toBe(ORG_ID);
    expect(exportFilter).not.toHaveProperty('limit');
    expect(exportFilter).not.toHaveProperty('before');
    expect(exportFilter).toMatchObject({ driveId: 'drive_finance' });
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.export', resourceType: 'organization_audit_log' }));
  });

  it('AUD-3 (partial) reads of the log are rate limited per admin per org too', async () => {
    as('ADMIN');
    vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 30 });
    expect((await GET(req(''), ctx)).status).toBe(429);
    expect(checkDistributedRateLimit).toHaveBeenCalledWith(`org_audit_read:${ORG_ID}:user_priya`, 'API');
    expect(queryOrgAuditEvents).not.toHaveBeenCalled();
  });

  it('AUD-3 (partial) exports are rate limited per admin per org', async () => {
    as('OWNER');
    vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 120 });
    const res = await EXPORT(req('/export'), ctx);
    expect(res.status).toBe(429);
    expect(checkDistributedRateLimit).toHaveBeenCalledWith(`org_audit_export:${ORG_ID}:user_priya`, 'EMAIL_RESEND');
    expect(exportOrgAuditCsv).not.toHaveBeenCalled();
  });
});
