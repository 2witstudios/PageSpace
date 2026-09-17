/**
 * Organizations & Wallets, Wave B3 — every /api/orgs route.
 *
 * Services are faked at the lib boundary; authorization is NOT: the real
 * requireOrgRole runs over a faked membership lookup, so a route that skipped it
 * or asked for the wrong minimum role fails the role matrix below.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/auth/verification-utils', () => ({ isEmailVerified: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: { DRIVE_INVITE: {}, DRIVE_INVITE_RESEND: {} },
}));

vi.mock('@pagespace/lib/organizations/repository', () => ({
  findMembershipRole: vi.fn(),
  findOrganizationById: vi.fn(),
  listOrganizationsForUser: vi.fn(),
  listOrgMembers: vi.fn(),
  createOrganization: vi.fn(),
  updateOrganization: vi.fn(),
}));
vi.mock('@pagespace/lib/organizations/membership', () => ({
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(),
  transferOwnership: vi.fn(),
}));
vi.mock('@pagespace/lib/organizations/invitations', () => ({
  INVITE_EXPIRY_DAYS: 7,
  createOrRotateInvitation: vi.fn(),
  listOpenInvitations: vi.fn(),
  resendInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
}));
vi.mock('@pagespace/lib/organizations/deletion', () => ({ deleteOrganization: vi.fn() }));
vi.mock('@/lib/orgs/org-invite-delivery', () => ({ deliverOrgInvite: vi.fn() }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import * as repository from '@pagespace/lib/organizations/repository';
import * as membership from '@pagespace/lib/organizations/membership';
import * as invitations from '@pagespace/lib/organizations/invitations';
import { deleteOrganization } from '@pagespace/lib/organizations/deletion';
import { deliverOrgInvite } from '@/lib/orgs/org-invite-delivery';

import * as orgsRoute from '../route';
import * as orgRoute from '../[orgId]/route';
import * as membersRoute from '../[orgId]/members/route';
import * as memberRoute from '../[orgId]/members/[userId]/route';
import * as transferRoute from '../[orgId]/transfer-ownership/route';
import * as invitationsRoute from '../[orgId]/invitations/route';
import * as invitationRoute from '../[orgId]/invitations/[invitationId]/route';
import * as resendRoute from '../[orgId]/invitations/[invitationId]/resend/route';
import * as acceptRoute from '../invitations/accept/route';

const ORG_ID = 'org_northwind';
const CALLER = 'user_caller';
const NOW = new Date('2026-09-17T12:00:00.000Z');

const session = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess',
  role: 'user',
  adminRoleVersion: 0,
});

const req = (method: string, body?: unknown) =>
  new Request(`https://example.test/api/orgs/${ORG_ID}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const organization = {
  id: ORG_ID,
  name: 'Northwind Labs',
  slug: 'northwind',
  avatarUrl: null,
  ownerId: 'user_jono',
  policies: {},
  stripeCustomerId: 'cus_secret',
  stripeSubscriptionId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const invitation = {
  id: 'inv_1',
  orgId: ORG_ID,
  email: 'marcus@northwind.test',
  role: 'MEMBER' as const,
  invitedBy: CALLER,
  expiresAt: NOW,
  acceptedAt: null,
  createdAt: NOW,
};

function setServiceDefaults() {
  vi.mocked(repository.findOrganizationById).mockResolvedValue(organization);
  vi.mocked(repository.listOrganizationsForUser).mockResolvedValue([]);
  vi.mocked(repository.listOrgMembers).mockResolvedValue([]);
  vi.mocked(repository.createOrganization).mockResolvedValue({ ok: true, organization });
  vi.mocked(repository.updateOrganization).mockResolvedValue({ ok: true, organization });
  vi.mocked(membership.changeMemberRole).mockResolvedValue({ ok: true });
  vi.mocked(membership.removeMember).mockResolvedValue({ ok: true });
  vi.mocked(membership.transferOwnership).mockResolvedValue({ ok: true });
  // The fakes call the route's delivery the way the service does, and report a failed
  // delivery the way the service does after undoing its write.
  vi.mocked(invitations.createOrRotateInvitation).mockImplementation(async ({ deliver }) => {
    try {
      await deliver(invitation, 'ps_orginv_t');
    } catch (cause) {
      return { ok: false, status: 502, reason: 'delivery_failed', cause };
    }
    return { ok: true, invitation, token: 'ps_orginv_t', rotated: false };
  });
  vi.mocked(invitations.listOpenInvitations).mockResolvedValue([invitation]);
  vi.mocked(invitations.resendInvitation).mockImplementation(async ({ deliver }) => {
    try {
      await deliver(invitation, 'ps_orginv_t2');
    } catch (cause) {
      return { ok: false, status: 502, reason: 'delivery_failed', cause };
    }
    return { ok: true, invitation, token: 'ps_orginv_t2' };
  });
  vi.mocked(invitations.revokeInvitation).mockResolvedValue(true);
  vi.mocked(invitations.acceptInvitation).mockResolvedValue({ ok: true, orgId: ORG_ID, role: 'MEMBER', joined: true });
  vi.mocked(deleteOrganization).mockResolvedValue({ ok: true, steps: [] });
  vi.mocked(deliverOrgInvite).mockResolvedValue(undefined);
  vi.mocked(isEmailVerified).mockResolvedValue(true);
  vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 2 });
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.orgsEnabled = true;
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(CALLER));
  vi.mocked(repository.findMembershipRole).mockResolvedValue(null);
  setServiceDefaults();
});

interface RouteCase {
  name: string;
  /** null: no org role required (the caller has no org yet, or is accepting). */
  minRole: OrgRole | null;
  call: () => Promise<Response>;
  successStatus: number;
  /** The service the route must not reach when authorization refuses. */
  service: () => unknown;
}

const ROUTES: RouteCase[] = [
  { name: 'GET /api/orgs', minRole: null, successStatus: 200, service: () => repository.listOrganizationsForUser,
    call: () => orgsRoute.GET(req('GET')) },
  { name: 'POST /api/orgs', minRole: null, successStatus: 201, service: () => repository.createOrganization,
    call: () => orgsRoute.POST(req('POST', { name: 'Northwind Labs', slug: 'northwind' })) },
  { name: 'GET /api/orgs/[orgId]', minRole: 'MEMBER', successStatus: 200, service: () => repository.findOrganizationById,
    call: () => orgRoute.GET(req('GET'), params({ orgId: ORG_ID })) },
  { name: 'PATCH /api/orgs/[orgId]', minRole: 'ADMIN', successStatus: 200, service: () => repository.updateOrganization,
    call: () => orgRoute.PATCH(req('PATCH', { name: 'Northwind' }), params({ orgId: ORG_ID })) },
  { name: 'DELETE /api/orgs/[orgId]', minRole: 'OWNER', successStatus: 200, service: () => deleteOrganization,
    call: () => orgRoute.DELETE(req('DELETE', { drives: [] }), params({ orgId: ORG_ID })) },
  { name: 'GET /api/orgs/[orgId]/members', minRole: 'MEMBER', successStatus: 200, service: () => repository.listOrgMembers,
    call: () => membersRoute.GET(req('GET'), params({ orgId: ORG_ID })) },
  { name: 'PATCH /api/orgs/[orgId]/members/[userId]', minRole: 'ADMIN', successStatus: 200, service: () => membership.changeMemberRole,
    call: () => memberRoute.PATCH(req('PATCH', { role: 'ADMIN' }), params({ orgId: ORG_ID, userId: 'user_marcus' })) },
  { name: 'DELETE /api/orgs/[orgId]/members/[userId]', minRole: 'ADMIN', successStatus: 200, service: () => membership.removeMember,
    call: () => memberRoute.DELETE(req('DELETE'), params({ orgId: ORG_ID, userId: 'user_marcus' })) },
  { name: 'POST /api/orgs/[orgId]/transfer-ownership', minRole: 'OWNER', successStatus: 200, service: () => membership.transferOwnership,
    call: () => transferRoute.POST(req('POST', { toUserId: 'user_priya' }), params({ orgId: ORG_ID })) },
  { name: 'GET /api/orgs/[orgId]/invitations', minRole: 'ADMIN', successStatus: 200, service: () => invitations.listOpenInvitations,
    call: () => invitationsRoute.GET(req('GET'), params({ orgId: ORG_ID })) },
  { name: 'POST /api/orgs/[orgId]/invitations', minRole: 'ADMIN', successStatus: 201, service: () => invitations.createOrRotateInvitation,
    call: () => invitationsRoute.POST(req('POST', { email: 'marcus@northwind.test' }), params({ orgId: ORG_ID })) },
  { name: 'DELETE /api/orgs/[orgId]/invitations/[invitationId]', minRole: 'ADMIN', successStatus: 200, service: () => invitations.revokeInvitation,
    call: () => invitationRoute.DELETE(req('DELETE'), params({ orgId: ORG_ID, invitationId: 'inv_1' })) },
  { name: 'POST /api/orgs/[orgId]/invitations/[invitationId]/resend', minRole: 'ADMIN', successStatus: 200, service: () => invitations.resendInvitation,
    call: () => resendRoute.POST(req('POST'), params({ orgId: ORG_ID, invitationId: 'inv_1' })) },
  { name: 'POST /api/orgs/invitations/accept', minRole: null, successStatus: 200, service: () => invitations.acceptInvitation,
    call: () => acceptRoute.POST(req('POST', { token: 'ps_orginv_t' })) },
];

const RANK: Record<OrgRole, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };
const CALLERS: Array<{ label: string; role: OrgRole | null }> = [
  { label: 'a non-member', role: null },
  { label: 'a Member', role: 'MEMBER' },
  { label: 'an Admin', role: 'ADMIN' },
  { label: 'the Owner', role: 'OWNER' },
];

const expectedStatus = (route: RouteCase, role: OrgRole | null): number => {
  if (route.minRole === null) return route.successStatus;
  if (role === null) return 404;
  return RANK[role] >= RANK[route.minRole] ? route.successStatus : 403;
};

describe('org route role matrix', () => {
  for (const route of ROUTES) {
    describe(route.name, () => {
      for (const caller of CALLERS) {
        const status = expectedStatus(route, caller.role);
        it(`ORG-5 (partial) ${route.name} as ${caller.label} answers ${status}`, async () => {
          vi.mocked(repository.findMembershipRole).mockResolvedValue(caller.role);
          const res = await route.call();
          expect(res.status).toBe(status);
          if (status === route.successStatus) {
            expect(route.service()).toHaveBeenCalled();
          } else {
            expect(route.service()).not.toHaveBeenCalled();
            expect(repository.findMembershipRole).toHaveBeenCalledWith(ORG_ID, CALLER);
            expect(auditRequest).toHaveBeenCalledWith(
              expect.any(Request),
              expect.objectContaining({ eventType: 'authz.access.denied', resourceId: ORG_ID }),
            );
          }
        });
      }

      it(`ORG-5 (partial) ${route.name} is dark with 404 while ORGS_ENABLED is false`, async () => {
        flags.orgsEnabled = false;
        vi.mocked(repository.findMembershipRole).mockResolvedValue('OWNER');
        const res = await route.call();
        expect(res.status).toBe(404);
        expect(authenticateRequestWithOptions).not.toHaveBeenCalled();
        expect(route.service()).not.toHaveBeenCalled();
      });

      it(`${route.name} requires a session`, async () => {
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
          error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
        } satisfies AuthError);
        const res = await route.call();
        expect(res.status).toBe(401);
        expect(route.service()).not.toHaveBeenCalled();
      });
    });
  }
});

describe('org route behaviour', () => {
  const asRole = (role: OrgRole | null) => vi.mocked(repository.findMembershipRole).mockResolvedValue(role);

  it('ORG-1 (partial) POST /api/orgs makes the caller the Owner and never returns billing ids', async () => {
    const res = await orgsRoute.POST(req('POST', { name: 'Northwind Labs', slug: 'Northwind', avatarUrl: 'https://example.test/n.png' }));
    expect(res.status).toBe(201);
    expect(repository.createOrganization).toHaveBeenCalledWith({
      name: 'Northwind Labs',
      slug: 'northwind',
      avatarUrl: 'https://example.test/n.png',
      ownerId: CALLER,
    });
    const body = await res.json();
    expect(body.organization).not.toHaveProperty('stripeCustomerId');
    expect(body.organization).not.toHaveProperty('policies');
  });

  it('ORG-1 (partial) POST /api/orgs refuses a malformed slug and reports a taken one', async () => {
    expect((await orgsRoute.POST(req('POST', { name: 'N', slug: 'no spaces!' }))).status).toBe(400);
    vi.mocked(repository.createOrganization).mockResolvedValue({ ok: false, reason: 'slug_taken' });
    expect((await orgsRoute.POST(req('POST', { name: 'N', slug: 'northwind' }))).status).toBe(409);
  });

  it('ORG-1 (partial) an org avatar must be an https URL, never a script or data URI', async () => {
    for (const avatarUrl of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://example.test/n.png']) {
      expect((await orgsRoute.POST(req('POST', { name: 'N', slug: 'northwind', avatarUrl }))).status).toBe(400);
    }
    asRole('ADMIN');
    expect((await orgRoute.PATCH(req('PATCH', { avatarUrl: 'javascript:alert(1)' }), params({ orgId: ORG_ID }))).status).toBe(400);
    expect(repository.createOrganization).not.toHaveBeenCalled();
    expect(repository.updateOrganization).not.toHaveBeenCalled();
  });

  it('ORG-1 (partial) the Owner role cannot be granted through a role change', async () => {
    asRole('OWNER');
    const res = await memberRoute.PATCH(req('PATCH', { role: 'OWNER' }), params({ orgId: ORG_ID, userId: 'user_marcus' }));
    expect(res.status).toBe(400);
    expect(membership.changeMemberRole).not.toHaveBeenCalled();
  });

  it('ORG-2 (partial) a refused role change or removal carries the service status and reason', async () => {
    asRole('ADMIN');
    vi.mocked(membership.removeMember).mockResolvedValue({ ok: false, status: 400, reason: 'use_ownership_transfer' });
    const res = await memberRoute.DELETE(req('DELETE'), params({ orgId: ORG_ID, userId: 'user_jono' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('use_ownership_transfer');
    expect(membership.removeMember).toHaveBeenCalledWith({ orgId: ORG_ID, actorId: CALLER, targetId: 'user_jono' });
  });

  it('ORG-1 (partial) transfer-ownership passes the caller as actor and maps refusals', async () => {
    asRole('OWNER');
    vi.mocked(membership.transferOwnership).mockResolvedValue({ ok: false, status: 400, reason: 'target_not_member' });
    const res = await transferRoute.POST(req('POST', { toUserId: 'user_chris' }), params({ orgId: ORG_ID }));
    expect(res.status).toBe(400);
    expect(membership.transferOwnership).toHaveBeenCalledWith({ orgId: ORG_ID, actorId: CALLER, targetId: 'user_chris' });
  });

  it('ORG-6 (partial) DELETE /api/orgs/[orgId] writes one audit event per drive naming its destination', async () => {
    asRole('OWNER');
    const steps = [
      { driveId: 'd_product', driveName: 'Product', destination: 'transfer' as const, ownerId: 'user_priya', trashed: false },
      { driveId: 'd_old', driveName: 'Old Site', destination: 'owner_trash' as const, ownerId: 'user_jono', trashed: true },
    ];
    vi.mocked(deleteOrganization).mockResolvedValue({ ok: true, steps });
    const res = await orgRoute.DELETE(
      req('DELETE', { drives: [{ driveId: 'd_product', action: 'transfer', toUserId: 'user_priya' }] }),
      params({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).drives).toEqual(steps);
    expect(deleteOrganization).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      choices: [{ driveId: 'd_product', action: 'transfer', toUserId: 'user_priya' }],
    }));
    for (const step of steps) {
      expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({
        resourceType: 'drive',
        resourceId: step.driveId,
        details: expect.objectContaining({ destination: step.destination, newOwnerId: step.ownerId }),
      }));
    }
  });

  it('ORG-6 (partial) DELETE /api/orgs/[orgId] passes the caller so the service can re-check ownership, and maps its refusal', async () => {
    asRole('OWNER');
    vi.mocked(deleteOrganization).mockResolvedValue({ ok: false, status: 403, reason: 'not_owner' });
    const res = await orgRoute.DELETE(req('DELETE', { drives: [] }), params({ orgId: ORG_ID }));
    expect(res.status).toBe(403);
    expect(deleteOrganization).toHaveBeenCalledWith(expect.objectContaining({ actorId: CALLER, orgId: ORG_ID }));
  });

  it('ORG-6 (partial) DELETE /api/orgs/[orgId] reports the drives that block the delete', async () => {
    asRole('OWNER');
    vi.mocked(deleteOrganization).mockResolvedValue({ ok: false, status: 400, reason: 'transfer_target_not_member', driveIds: ['d_product'] });
    const res = await orgRoute.DELETE(
      req('DELETE', { drives: [{ driveId: 'd_product', action: 'transfer', toUserId: 'user_chris' }] }),
      params({ orgId: ORG_ID }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: 'transfer_target_not_member', driveIds: ['d_product'] });
  });

  it('ORG-3 (partial) inviting sends the email with the new token and never returns the token', async () => {
    asRole('ADMIN');
    const res = await invitationsRoute.POST(req('POST', { email: ' Marcus@Northwind.test ', role: 'ADMIN' }), params({ orgId: ORG_ID }));
    expect(res.status).toBe(201);
    expect(invitations.createOrRotateInvitation).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, email: 'marcus@northwind.test', role: 'ADMIN', invitedBy: CALLER,
    }));
    expect(deliverOrgInvite).toHaveBeenCalledWith({
      orgId: ORG_ID, inviterId: CALLER, email: 'marcus@northwind.test', role: 'ADMIN', token: 'ps_orginv_t',
    });
    expect(JSON.stringify(await res.json())).not.toContain('ps_orginv_t');
  });

  it('ORG-3 (partial) an invite or resend that could not be emailed answers 502 and the service undoes it', async () => {
    asRole('ADMIN');
    vi.mocked(deliverOrgInvite).mockRejectedValue(new Error('smtp down'));
    expect((await invitationsRoute.POST(req('POST', { email: 'marcus@northwind.test' }), params({ orgId: ORG_ID }))).status).toBe(502);
    expect((await resendRoute.POST(req('POST'), params({ orgId: ORG_ID, invitationId: 'inv_1' }))).status).toBe(502);
    // Compensation lives in the service (proven against Postgres), never a second route write.
    expect(invitations.revokeInvitation).not.toHaveBeenCalled();
  });

  it('ORG-3 (partial) inviting refuses an existing member, an unverified inviter, and an OWNER role', async () => {
    asRole('ADMIN');
    vi.mocked(invitations.createOrRotateInvitation).mockResolvedValue({ ok: false, status: 409, reason: 'already_member' });
    expect((await invitationsRoute.POST(req('POST', { email: 'dana@northwind.test' }), params({ orgId: ORG_ID }))).status).toBe(409);
    expect((await invitationsRoute.POST(req('POST', { email: 'dana@northwind.test', role: 'OWNER' }), params({ orgId: ORG_ID }))).status).toBe(400);
    vi.mocked(isEmailVerified).mockResolvedValue(false);
    expect((await invitationsRoute.POST(req('POST', { email: 'dana@northwind.test' }), params({ orgId: ORG_ID }))).status).toBe(403);
  });

  it('ORG-3 (partial) re-inviting after expiry rotates the open invite (route answers 200 and emails the new link)', async () => {
    asRole('ADMIN');
    vi.mocked(invitations.createOrRotateInvitation).mockImplementation(async ({ deliver }) => {
      await deliver(invitation, 'ps_orginv_rotated');
      return { ok: true, invitation, token: 'ps_orginv_rotated', rotated: true };
    });
    const res = await invitationsRoute.POST(req('POST', { email: 'marcus@northwind.test' }), params({ orgId: ORG_ID }));
    expect(res.status).toBe(200);
    expect(deliverOrgInvite).toHaveBeenCalledWith(expect.objectContaining({ token: 'ps_orginv_rotated' }));
  });

  it('ORG-3 (partial) resend emails the rotated link; an unknown invitation is 404', async () => {
    asRole('ADMIN');
    const res = await resendRoute.POST(req('POST'), params({ orgId: ORG_ID, invitationId: 'inv_1' }));
    expect(res.status).toBe(200);
    expect(deliverOrgInvite).toHaveBeenCalledWith(expect.objectContaining({ email: invitation.email, token: 'ps_orginv_t2' }));
    vi.mocked(invitations.resendInvitation).mockResolvedValue({ ok: false, status: 404, reason: 'not_found' });
    expect((await resendRoute.POST(req('POST'), params({ orgId: ORG_ID, invitationId: 'inv_x' }))).status).toBe(404);
    vi.mocked(invitations.revokeInvitation).mockResolvedValue(false);
    expect((await invitationRoute.DELETE(req('DELETE'), params({ orgId: ORG_ID, invitationId: 'inv_x' }))).status).toBe(404);
  });

  it('ORG-3 (partial) accept binds the token to the signed-in caller and maps refusals', async () => {
    const ok = await acceptRoute.POST(req('POST', { token: 'ps_orginv_t' }));
    expect(ok.status).toBe(200);
    expect(invitations.acceptInvitation).toHaveBeenCalledWith(expect.objectContaining({ token: 'ps_orginv_t', userId: CALLER }));
    expect(await ok.json()).toEqual({ orgId: ORG_ID, role: 'MEMBER', joined: true });

    vi.mocked(invitations.acceptInvitation).mockResolvedValue({ ok: false, status: 403, reason: 'email_mismatch' });
    expect((await acceptRoute.POST(req('POST', { token: 'ps_orginv_t' }))).status).toBe(403);
    vi.mocked(invitations.acceptInvitation).mockResolvedValue({ ok: false, status: 410, reason: 'expired' });
    expect((await acceptRoute.POST(req('POST', { token: 'ps_orginv_t' }))).status).toBe(410);
  });
});
