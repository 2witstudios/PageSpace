/**
 * ORG-3: an org invitation link carried through sign-in or sign-up as `?invite=<token>` is
 * accepted by the one dispatcher every auth route calls (Google, Apple, magic link, passkey
 * sign-in and sign-up, One Tap, native), and the route lands the person on the org hub — or
 * back on the invite page, which says why, when the acceptance was refused.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }, api: { error: vi.fn() } },
}));
vi.mock('@pagespace/lib/auth/token-utils', () => ({ hashToken: vi.fn((token: string) => `hash:${token}`) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/org-change-events', () => ({ announceOrgChange: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@pagespace/lib/organizations/invitations', () => ({
  findInvitationByToken: vi.fn(),
  acceptInvitation: vi.fn(),
}));
vi.mock('@/lib/auth/invite-acceptance-adapters', () => ({ buildAcceptancePorts: vi.fn(() => ({})) }));
vi.mock('@/lib/auth/page-invite-acceptance-adapters', () => ({ buildPageAcceptancePorts: vi.fn(() => ({})) }));
vi.mock('@/lib/auth/connection-invite-acceptance-adapters', () => ({ buildConnectionAcceptancePorts: vi.fn(() => ({})) }));
vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: { findPendingInviteByTokenHash: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/lib/repositories/page-invite-repository', () => ({
  pageInviteRepository: { findPendingInviteByTokenHash: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/lib/repositories/connection-invite-repository', () => ({
  connectionInviteRepository: { findPendingInviteByTokenHash: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@pagespace/lib/services/invites', () => ({
  acceptInviteForNewUser: vi.fn(() => vi.fn()),
  acceptInviteForExistingUser: vi.fn(() => vi.fn()),
  acceptPageInviteForNewUser: vi.fn(() => vi.fn()),
  acceptPageInviteForExistingUser: vi.fn(() => vi.fn()),
  acceptConnectionInviteForNewUser: vi.fn(() => vi.fn()),
  acceptConnectionInviteForExistingUser: vi.fn(() => vi.fn()),
}));

import { consumeAnyInviteIfPresent } from '../native-invite-acceptance';
import { acceptInvitation, findInvitationByToken } from '@pagespace/lib/organizations/invitations';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { announceOrgChange } from '@pagespace/lib/organizations/org-change-events';

const request = new Request('http://localhost/api/auth/google/callback');
const TOKEN = 'ps_orginv_abc';
const orgInvite = {
  id: 'inv_1', orgId: 'org_nw', orgName: 'Northwind Labs', email: 'tomas@northwind.test', role: 'MEMBER' as const,
  invitedBy: 'u_jono', expiresAt: new Date('2099-01-01'), acceptedAt: null, createdAt: new Date(),
};

const consume = (isNewUser: boolean) =>
  consumeAnyInviteIfPresent({ request, inviteToken: TOKEN, user: { id: 'u_tomas', suspendedAt: null }, isNewUser, email: 'tomas@northwind.test' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findInvitationByToken).mockResolvedValue(orgInvite);
});

describe('ORG-3 (partial) the org invite token survives every auth method and is accepted as the session is created', () => {
  it('a brand-new account and an existing account each accept the org invitation for themselves and land on the org hub', async () => {
    vi.mocked(acceptInvitation).mockResolvedValue({ ok: true, orgId: 'org_nw', role: 'MEMBER', joined: true });
    for (const isNewUser of [true, false]) {
      expect(await consume(isNewUser)).toEqual({
        kind: 'org', invitedDriveId: null, invitedPageId: null, connectionId: null,
        invitedOrgId: 'org_nw', orgLandingPath: '/orgs/org_nw/settings',
      });
    }
    expect(acceptInvitation).toHaveBeenCalledWith({ token: TOKEN, userId: 'u_tomas', now: expect.any(Date) });
    expect(auditRequest).toHaveBeenCalledWith(request, expect.objectContaining({ eventType: 'authz.role.assigned', resourceId: 'org_nw' }));
    expect(announceOrgChange).toHaveBeenCalledWith('org_nw', 'membership');
  });

  it('a refused acceptance (wrong account, expired, used, lapsed) returns the person to the invite page with the error code; nothing is announced', async () => {
    const refusals = [
      [{ ok: false, status: 403, reason: 'email_mismatch' }, 'EMAIL_MISMATCH'],
      [{ ok: false, status: 410, reason: 'expired' }, 'TOKEN_EXPIRED'],
      [{ ok: false, status: 410, reason: 'already_accepted' }, 'TOKEN_CONSUMED'],
      [{ ok: false, status: 404, reason: 'not_found' }, 'TOKEN_NOT_FOUND'],
      [{ ok: false, status: 402, reason: 'org_lapsed' }, 'ORG_LAPSED'],
    ] as const;
    for (const [refusal, code] of refusals) {
      vi.mocked(acceptInvitation).mockResolvedValueOnce(refusal);
      expect(await consume(false)).toMatchObject({ kind: 'org', invitedOrgId: null, orgLandingPath: `/invite/${TOKEN}`, inviteError: code });
    }
    expect(announceOrgChange).not.toHaveBeenCalled();
  });

  it('a token that is not an org invitation goes on to the drive, page and connection invites untouched', async () => {
    vi.mocked(findInvitationByToken).mockResolvedValue(null);
    expect(await consume(false)).toMatchObject({ kind: null, orgLandingPath: null, inviteError: 'TOKEN_NOT_FOUND' });
    expect(acceptInvitation).not.toHaveBeenCalled();
  });
});
