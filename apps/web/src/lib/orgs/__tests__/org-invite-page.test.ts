/**
 * ORG-3 privacy (review of #2869): a link that can no longer be used must not put the invitee's
 * address, the org's name or id, the inviter's name or the role into the page's props (and so its
 * HTML). Only the screen state travels; an actionable screen gets only what it shows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  invite: null as null | Record<string, unknown>,
  viewer: null as null | { name: string; email: string },
  memberRole: null as null | string,
  session: null as null | { userId: string },
}));

vi.mock('@pagespace/lib/organizations/invitations', () => ({ findInvitationByToken: vi.fn(async () => mocks.invite) }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn(async () => mocks.memberRole) }));
vi.mock('@pagespace/lib/auth/session-service', () => ({ sessionService: { validateSession: vi.fn(async () => mocks.session) } }));
vi.mock('@/lib/auth/cookie-config', () => ({ getSessionFromCookies: vi.fn(() => (mocks.session ? 'ps_sess' : null)) }));
vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findInviterDisplay: vi.fn(async (id: string) => (id === 'u_jono' ? { name: 'Jono Woodall', email: 'jono@northwind.test' } : mocks.viewer)),
    loadUserAccountByEmail: vi.fn(async () => null),
  },
}));
vi.mock('@/lib/auth/invite-resolver', () => ({ resolveInviteContext: vi.fn(async () => ({ ok: false, error: 'NOT_FOUND' })) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ toString: () => '' }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ actions: { logout: vi.fn() } }) }));

import { loadOrgInvitePage } from '../org-invite-page';
import InvitePage from '@/app/invite/[token]/page';

const SECRETS = ['tomas@northwind.test', 'Northwind Labs', 'org_nw1', 'Jono Woodall', 'ADMIN'];
const DAY = 86_400_000;
const invite = (over: Record<string, unknown> = {}) => ({
  id: 'inv_1', orgId: 'org_nw1', orgName: 'Northwind Labs', email: 'tomas@northwind.test', role: 'ADMIN',
  invitedBy: 'u_jono', acceptedAt: null, expiresAt: new Date(Date.now() + DAY), createdAt: new Date(), ...over,
});
const load = () => loadOrgInvitePage({ token: 'ps_orginv_t', cookieHeader: '', now: new Date() });
const pageHtml = async () => renderToStaticMarkup(await InvitePage({ params: Promise.resolve({ token: 'ps_orginv_t' }) }));

beforeEach(() => {
  mocks.invite = null;
  mocks.viewer = null;
  mocks.memberRole = null;
  mocks.session = null;
});

describe('ORG-3 (partial) a spent org invitation link reveals nothing about the invitation', () => {
  it.each([
    ['expired', { expiresAt: new Date(Date.now() - DAY) }],
    ['already used', { acceptedAt: new Date(Date.now() - DAY) }],
  ])('%s: the props carry only the screen state and the page HTML names no address, org, inviter or role', async (_label, over) => {
    mocks.invite = invite(over);
    const model = await load();
    expect(Object.keys(model ?? {})).toEqual(['view']);
    const html = await pageHtml();
    for (const secret of SECRETS) expect(html).not.toContain(secret);
    // Signed in as someone else, too.
    mocks.session = { userId: 'u_marcus' };
    mocks.viewer = { name: 'Marcus', email: 'marcus@northwind.test' };
    expect(Object.keys((await load()) ?? {})).toEqual(['view']);
  });

  it('revoked (no row holds the token): no org model at all, and the page HTML names nothing', async () => {
    expect(await load()).toBeNull();
    const html = await pageHtml();
    for (const secret of SECRETS) expect(html).not.toContain(secret);
  });

  it('the wrong signed-in account gets only the two addresses it is shown, not the org, inviter or role', async () => {
    mocks.invite = invite();
    mocks.session = { userId: 'u_marcus' };
    mocks.viewer = { name: 'Marcus', email: 'marcus@northwind.test' };
    expect(await load()).toEqual({ view: 'wrong_account', invitedEmail: 'tomas@northwind.test', viewerEmail: 'marcus@northwind.test' });
  });

  it('an actionable link carries only what its screen shows (no org id); an existing member gets the org they belong to', async () => {
    mocks.invite = invite();
    expect(await load()).toEqual({ view: 'sign_up', orgName: 'Northwind Labs', inviterName: 'Jono Woodall', role: 'ADMIN', invitedEmail: 'tomas@northwind.test' });
    mocks.invite = invite({ acceptedAt: new Date() });
    mocks.session = { userId: 'u_tomas' };
    mocks.viewer = { name: 'Tomas', email: 'tomas@northwind.test' };
    mocks.memberRole = 'MEMBER';
    expect(await load()).toEqual({ view: 'already_member', orgId: 'org_nw1', orgName: 'Northwind Labs' });
  });
});
