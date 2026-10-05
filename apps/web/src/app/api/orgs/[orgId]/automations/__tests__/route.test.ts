/**
 * The owner-left automation routes ([D-OW-36]): list, reassign, delete. The lib services are faked;
 * the org gate is NOT: the real requireOrgRole runs over a faked membership lookup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/organizations/automation-ownership', () => ({
  listOwnerLeftAutomations: vi.fn(),
  reassignOwnerLeftAutomation: vi.fn(),
  deleteOwnerLeftAutomation: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import {
  deleteOwnerLeftAutomation,
  listOwnerLeftAutomations,
  reassignOwnerLeftAutomation,
} from '@pagespace/lib/organizations/automation-ownership';
import { GET } from '../route';
import { DELETE } from '../[kind]/[automationId]/route';
import { POST } from '../[kind]/[automationId]/reassign/route';

const ORG_ID = 'org_northwind';
const session = (userId: string): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0 });
const listCtx = { params: Promise.resolve({ orgId: ORG_ID }) };
const itemCtx = (kind = 'workflow', automationId = 'wf_hourly') => ({ params: Promise.resolve({ orgId: ORG_ID, kind, automationId }) });
const req = (method: string, body?: unknown) => new Request(`https://example.test/api/orgs/${ORG_ID}/automations`, {
  method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const as = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_ana'));
  vi.mocked(listOwnerLeftAutomations).mockResolvedValue([]);
  vi.mocked(reassignOwnerLeftAutomation).mockResolvedValue({ ok: true });
  vi.mocked(deleteOwnerLeftAutomation).mockResolvedValue({ ok: true });
});

describe('owner-left automation routes', () => {
  it('SPEND-6 (partial) only an Owner or Admin of THIS org lists, reassigns or deletes; a member is refused and a non-member sees no org', async () => {
    for (const [role, status] of [['MEMBER', 403], [null, 404]] as const) {
      as(role);
      expect((await GET(req('GET'), listCtx)).status).toBe(status);
      expect((await POST(req('POST', { newOwnerId: 'user_lena' }), itemCtx())).status).toBe(status);
      expect((await DELETE(req('DELETE'), itemCtx())).status).toBe(status);
    }
    expect(listOwnerLeftAutomations).not.toHaveBeenCalled();
    expect(reassignOwnerLeftAutomation).not.toHaveBeenCalled();
    expect(deleteOwnerLeftAutomation).not.toHaveBeenCalled();
  });

  it('SPEND-6 (partial) an Admin reassigns to the named member, as themselves, for the org in the path; a scheduled workflow is rescheduled', async () => {
    as('ADMIN');
    const res = await POST(req('POST', { newOwnerId: 'user_lena' }), itemCtx('workflow', 'wf_hourly'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reassigned: true, newOwnerId: 'user_lena' });
    const call = vi.mocked(reassignOwnerLeftAutomation).mock.calls[0][0];
    expect(call).toMatchObject({ orgId: ORG_ID, actorId: 'user_ana', kind: 'workflow', id: 'wf_hourly', newOwnerId: 'user_lena' });
    expect(call.nextRunAt?.('0 * * * *', 'UTC')).toBeInstanceOf(Date);
    expect(call.nextRunAt?.('not a cron', 'UTC')).toBeNull();
  });

  it('SPEND-6 (partial) a refusal from the service keeps its status and names its reason', async () => {
    as('OWNER');
    vi.mocked(reassignOwnerLeftAutomation).mockResolvedValue({ ok: false, status: 400, reason: 'new_owner_not_member' });
    const res = await POST(req('POST', { newOwnerId: 'user_guest' }), itemCtx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'new_owner_not_member' });
    vi.mocked(deleteOwnerLeftAutomation).mockResolvedValue({ ok: false, status: 409, reason: 'owner_present' });
    const del = await DELETE(req('DELETE'), itemCtx('page_webhook', 'pw_ci'));
    expect(del.status).toBe(409);
    expect(await del.json()).toMatchObject({ code: 'owner_present' });
  });

  it('an unknown automation kind or a body without a new owner is refused before the service runs', async () => {
    as('ADMIN');
    expect((await POST(req('POST', { newOwnerId: 'user_lena' }), itemCtx('zoom_connection'))).status).toBe(404);
    expect((await DELETE(req('DELETE'), itemCtx('zoom_connection'))).status).toBe(404);
    expect((await POST(req('POST', {}), itemCtx())).status).toBe(400);
    expect(reassignOwnerLeftAutomation).not.toHaveBeenCalled();
    expect(deleteOwnerLeftAutomation).not.toHaveBeenCalled();
  });

  it('SPEND-6 (partial) an Admin deletes and lists for the org in the path', async () => {
    as('ADMIN');
    expect((await DELETE(req('DELETE'), itemCtx('page_webhook', 'pw_ci'))).status).toBe(200);
    expect(deleteOwnerLeftAutomation).toHaveBeenCalledWith({ orgId: ORG_ID, actorId: 'user_ana', kind: 'page_webhook', id: 'pw_ci' });
    vi.mocked(listOwnerLeftAutomations).mockResolvedValue([{ kind: 'workflow', id: 'wf_hourly', driveId: 'drive_product', name: 'Hourly digest', ownerLeftAt: new Date('2026-10-05T10:00:00Z') }]);
    const res = await GET(req('GET'), listCtx);
    expect(res.status).toBe(200);
    expect(listOwnerLeftAutomations).toHaveBeenCalledWith(ORG_ID);
    expect((await res.json()).automations).toHaveLength(1);
  });
});
