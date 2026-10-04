/**
 * POST /api/orgs/[orgId]/suppressions/clear ([D-OW-27], SEC-1). The suppression store is faked; authorization is
 * NOT: the real requireOrgRole runs over a faked membership lookup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true })),
  DISTRIBUTED_RATE_LIMITS: { API: 'API' },
}));
vi.mock('@pagespace/lib/organizations/departure-suppression', () => ({ clearDepartureSuppression: vi.fn() }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { clearDepartureSuppression } from '@pagespace/lib/organizations/departure-suppression';
import { POST } from '../route';

const ORG_ID = 'org_northwind';
const EMAIL = 'dana@northwind.com';
const session = (userId: string): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0 });
const ctx = { params: Promise.resolve({ orgId: ORG_ID }) };
const req = (body: unknown) => new Request(`https://example.test/api/orgs/${ORG_ID}/suppressions/clear`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const as = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_priya'));
  vi.mocked(clearDepartureSuppression).mockResolvedValue(true);
});

describe('departure suppression clear route', () => {
  it('SEC-1 (partial) only an Owner or Admin of THIS org may clear; a member is refused and a non-member sees no org', async () => {
    as('MEMBER');
    expect((await POST(req({ email: EMAIL }), ctx)).status).toBe(403);
    as(null);
    expect((await POST(req({ email: EMAIL }), ctx)).status).toBe(404);
    expect(clearDepartureSuppression).not.toHaveBeenCalled();
  });

  it('SEC-1 (partial) an Admin clears for the org in the path; the answer and the audit row never carry the address', async () => {
    as('ADMIN');
    const res = await POST(req({ email: EMAIL }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ cleared: true });
    expect(clearDepartureSuppression).toHaveBeenCalledWith({ orgId: ORG_ID, email: EMAIL, actorId: 'user_priya' });
    expect(JSON.stringify(vi.mocked(auditRequest).mock.calls)).not.toContain('dana');
  });

  it('SEC-1 (partial) a malformed address is a 400 and clears nothing', async () => {
    as('OWNER');
    expect((await POST(req({ email: 'not-an-address' }), ctx)).status).toBe(400);
    expect(clearDepartureSuppression).not.toHaveBeenCalled();
  });
});
