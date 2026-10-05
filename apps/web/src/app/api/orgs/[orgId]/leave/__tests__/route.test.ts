/**
 * POST /api/orgs/[orgId]/leave (ORG-2, UI-11). leaveOrganization is faked; authorization is NOT: the real
 * requireOrgRole runs over a faked membership lookup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/organizations/org-change-events', () => ({ announceOrgChange: vi.fn(async () => undefined) }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true })),
  DISTRIBUTED_RATE_LIMITS: { API: 'API' },
}));
vi.mock('@pagespace/lib/organizations/leave', () => ({ leaveOrganization: vi.fn() }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { announceOrgChange } from '@pagespace/lib/organizations/org-change-events';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { leaveOrganization } from '@pagespace/lib/organizations/leave';
import { ORG_API_ERROR_CODES } from '@pagespace/lib/organizations/api-error-codes';
import { POST } from '../route';

const ORG_ID = 'org_northwind';
const session = (userId: string): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0 });
const ctx = { params: Promise.resolve({ orgId: ORG_ID }) };
const req = () => new Request(`https://example.test/api/orgs/${ORG_ID}/leave`, { method: 'POST' });
const as = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);
const left = {
  ok: true as const,
  revoked: { orgMembershipRows: 1, formerLeadOwnerRows: 0, driveMemberRows: 0, pageGrants: 0, tokens: 0 },
  reassigned: [],
  computeReattributed: [],
  heldAsGuest: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_marcus'));
  vi.mocked(leaveOrganization).mockResolvedValue(left as never);
});

describe('leave organization route', () => {
  it('UI-11 (partial): a plain Member leaves; only the caller is removed, and the others are told', async () => {
    as('MEMBER');
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ left: true });
    expect(leaveOrganization).toHaveBeenCalledWith('user_marcus', ORG_ID);
    expect(announceOrgChange).toHaveBeenCalledWith(ORG_ID, 'membership');
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 'user_marcus', resourceId: ORG_ID }));
  });

  it('an Admin may leave too', async () => {
    as('ADMIN');
    expect((await POST(req(), ctx)).status).toBe(200);
  });

  it('someone outside the org sees no org and leaves nothing', async () => {
    as(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('org_not_found');
    expect(leaveOrganization).not.toHaveBeenCalled();
  });

  it('the Owner is refused with a registered code until ownership is transferred', async () => {
    as('OWNER');
    vi.mocked(leaveOrganization).mockResolvedValue({ ok: false, reason: 'OWNER_MUST_TRANSFER' });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('owner_must_transfer');
    expect(ORG_API_ERROR_CODES).toContain(body.code);
    expect(announceOrgChange).not.toHaveBeenCalled();
  });

  it('a membership that vanished mid-flight answers not_member', async () => {
    as('MEMBER');
    vi.mocked(leaveOrganization).mockResolvedValue({ ok: false, reason: 'NOT_A_MEMBER' });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('not_member');
  });

  it('is rate limited per person and org', async () => {
    as('MEMBER');
    vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 30 } as never);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('rate_limited');
    expect(leaveOrganization).not.toHaveBeenCalled();
  });

  it('a failure is a coded 500', async () => {
    as('MEMBER');
    vi.mocked(leaveOrganization).mockRejectedValue(new Error('boom'));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('internal_error');
  });
});
