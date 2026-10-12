/**
 * X-4: the org writes that change what members see in the picker, the crumb and the org pages announce
 * org:changed — a rename, a delete (told to the people who were members), and an invitation sent or
 * revoked. The services and the org gate are faked; what is asserted is the announcement.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@/lib/orgs/org-route-auth', () => ({
  authorizeOrgRequest: vi.fn(async () => ({ ok: true, userId: 'user_owner', role: 'OWNER', allowedDriveIds: [] })),
  refuseDriveScopedToken: vi.fn(() => null),
  ORG_READ_AUTH: {},
  ORG_TOKEN_READ_AUTH: {},
  ORG_WRITE_AUTH: {},
}));
vi.mock('@pagespace/lib/organizations/org-change-events', () => ({
  announceOrgChange: vi.fn(async () => undefined),
  announceOrgChangeTo: vi.fn(async () => undefined),
  orgChangeAudience: vi.fn(async () => ['user_owner', 'user_member']),
}));
vi.mock('@pagespace/lib/organizations/repository', () => ({
  findOrganizationById: vi.fn(async () => ({ id: 'org_1', name: 'Northwind', slug: 'northwind', avatarUrl: null, ownerId: 'user_owner', createdAt: new Date(0) })),
  updateOrganization: vi.fn(),
}));
vi.mock('@pagespace/lib/organizations/deletion', () => ({ deleteOrganization: vi.fn() }));
vi.mock('@pagespace/lib/organizations/status', () => ({ getOrgBillingNotice: vi.fn(async () => null) }));
vi.mock('@/lib/orgs/org-avatar-storage', () => ({ callOrgAvatarStorage: vi.fn(), mintOrgAvatarToken: vi.fn() }));
vi.mock('@/lib/org-billing/org-subscription', () => ({ endOrgSubscriptionPort: vi.fn(() => ({})) }));
vi.mock('@pagespace/lib/organizations/invitations', () => ({
  createOrRotateInvitation: vi.fn(),
  listOpenInvitations: vi.fn(),
  revokeInvitation: vi.fn(),
}));
vi.mock('@pagespace/lib/auth/verification-utils', () => ({ isEmailVerified: vi.fn(async () => true) }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true })),
  DISTRIBUTED_RATE_LIMITS: { DRIVE_INVITE: 'DRIVE_INVITE' },
}));
vi.mock('@/lib/orgs/org-invite-delivery', () => ({ deliverOrgInvite: vi.fn() }));
vi.mock('@/lib/org-billing/seat-billing', () => ({ defaultSeatBilling: vi.fn(() => ({})) }));

import { announceOrgChange, announceOrgChangeTo, orgChangeAudience } from '@pagespace/lib/organizations/org-change-events';
import { updateOrganization } from '@pagespace/lib/organizations/repository';
import { deleteOrganization } from '@pagespace/lib/organizations/deletion';
import { createOrRotateInvitation, revokeInvitation } from '@pagespace/lib/organizations/invitations';
import { PATCH, DELETE } from '../route';
import { POST as INVITE } from '../invitations/route';
import { DELETE as REVOKE } from '../invitations/[invitationId]/route';

const ORG_ID = 'org_1';
const ctx = { params: Promise.resolve({ orgId: ORG_ID }) };
const json = (method: string, body: unknown) =>
  new Request(`https://example.test/api/orgs/${ORG_ID}`, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const organization = { id: ORG_ID, name: 'Contoso', slug: 'contoso', avatarUrl: null, ownerId: 'user_owner', createdAt: new Date(0) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('X-4 org writes announce org:changed', () => {
  it('X-4 (partial) renaming an org announces a profile change to its members', async () => {
    vi.mocked(updateOrganization).mockResolvedValue({ ok: true, organization } as never);
    const res = await PATCH(json('PATCH', { name: 'Contoso' }), ctx);
    expect(res.status).toBe(200);
    expect(announceOrgChange).toHaveBeenCalledWith(ORG_ID, 'profile');
  });

  it('a refused rename announces nothing', async () => {
    vi.mocked(updateOrganization).mockResolvedValue({ ok: false, reason: 'slug_taken' } as never);
    expect((await PATCH(json('PATCH', { slug: 'taken' }), ctx)).status).toBe(409);
    expect(announceOrgChange).not.toHaveBeenCalled();
  });

  it('X-4 (partial) deleting an org tells the people who were its members, read before the delete', async () => {
    const order: string[] = [];
    vi.mocked(orgChangeAudience).mockImplementation(async () => { order.push('audience'); return ['user_owner', 'user_member']; });
    vi.mocked(deleteOrganization).mockImplementation(async () => { order.push('delete'); return { ok: true, steps: [] } as never; });
    const res = await DELETE(json('DELETE', { drives: [] }), ctx);
    expect(res.status).toBe(200);
    expect(order).toEqual(['audience', 'delete']);
    expect(announceOrgChangeTo).toHaveBeenCalledWith(ORG_ID, 'deleted', ['user_owner', 'user_member']);
  });

  it('a refused delete announces nothing', async () => {
    vi.mocked(deleteOrganization).mockResolvedValue({ ok: false, status: 403 } as never);
    expect((await DELETE(json('DELETE', { drives: [] }), ctx)).status).toBe(403);
    expect(announceOrgChangeTo).not.toHaveBeenCalled();
  });

  it('X-4 (partial) sending an invitation announces an invitations change', async () => {
    vi.mocked(createOrRotateInvitation).mockResolvedValue({ ok: true, rotated: false, invitation: { id: 'inv_1' } } as never);
    const res = await INVITE(json('POST', { email: 'new@example.com' }), ctx);
    expect(res.status).toBe(201);
    expect(announceOrgChange).toHaveBeenCalledWith(ORG_ID, 'invitations');
  });

  it('X-4 (partial) revoking an invitation announces an invitations change; a missing one announces nothing', async () => {
    const revokeCtx = { params: Promise.resolve({ orgId: ORG_ID, invitationId: 'inv_1' }) };
    vi.mocked(revokeInvitation).mockResolvedValue(true);
    expect((await REVOKE(json('DELETE', {}), revokeCtx)).status).toBe(200);
    expect(announceOrgChange).toHaveBeenCalledWith(ORG_ID, 'invitations');

    vi.clearAllMocks();
    vi.mocked(revokeInvitation).mockResolvedValue(false);
    expect((await REVOKE(json('DELETE', {}), revokeCtx)).status).toBe(404);
    expect(announceOrgChange).not.toHaveBeenCalled();
  });
});
