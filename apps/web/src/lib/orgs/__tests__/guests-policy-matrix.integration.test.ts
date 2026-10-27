/**
 * The org's guests policy (Spec POL-2: "Guests from outside: off, admins approve, on. Enforced in the drive invite
 * route and share-link redemption.") as ONE matrix against a REAL Postgres, through the real route handlers.
 *
 * Nothing that decides is faked: every request carries a real session token (Bearer, created by the session
 * service), and the admission decision, the org row's share lock, the hold queue, the lapse check and every write are
 * the production code over this database. Only external IO is replaced: outgoing email is captured (to read the
 * invitation and magic links) and sends nothing.
 *
 * Rows: every way an outsider enters an org drive from a request —
 *   - drive invite route: an existing account (direct add) and an address with no account (invitation),
 *   - page share-invite route and the page permissions route (a direct page grant),
 *   - drive share link and page share link redemption,
 *   - acceptance, at sign-up, of a drive invitation and of a page invitation sent while guests were on.
 * Columns: off (refused, nothing granted, nothing queued), approve (202, nothing granted, one request queued for an
 * Owner or Admin), on (admitted). Then: approving each queued request admits through the same code, approving is
 * refused while guests are off, an org member is never a guest, and an org with NO subscription row is lapsed
 * ([D-OW-30]) and admits no outsider even with guests on ([D-OW-33]).
 *
 * The paths that put EXISTING access back into an org drive (drive and page moves, backup restore, rollback and redo,
 * a departed member's rows, MCP token scopes) are not request entry points; they are proven unmocked against real
 * Postgres in guest-policy-reentry.integration.test.ts (web) and the lib suites org-drive-policy, guest-reentry,
 * guest-holds and page-grant-admission.
 *
 * Every row a test creates is deleted, children before parents, users last.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
import { pendingInvites } from '@pagespace/db/schema/pending-invites';
import { pendingPageInvites } from '@pagespace/db/schema/pending-page-invites';

const mail = vi.hoisted(() => ({ inviteUrls: new Map<string, string>(), magicLinks: new Map<string, string>() }));
vi.mock('@pagespace/lib/services/notification-email-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/notification-email-service')>()),
  sendPendingDriveInvitationEmail: vi.fn(async (input: { recipientEmail: string; inviteUrl: string }) => {
    mail.inviteUrls.set(input.recipientEmail, input.inviteUrl);
  }),
  sendPendingPageShareInvitationEmail: vi.fn(async (input: { recipientEmail: string; inviteUrl: string }) => {
    mail.inviteUrls.set(input.recipientEmail, input.inviteUrl);
  }),
}));
vi.mock('@pagespace/lib/services/email-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/email-service')>()),
  sendEmail: vi.fn(async (input: { to: string; react: { props: { magicLinkUrl?: string } } }) => {
    if (input.react.props.magicLinkUrl) mail.magicLinks.set(input.to, input.react.props.magicLinkUrl);
  }),
}));

import { sessionService } from '@pagespace/lib/auth/session-service';
import { EnforcedAuthContext } from '@pagespace/lib/permissions/enforced-context';
import { createDriveShareLink, createPageShareLink } from '@pagespace/lib/permissions/share-link-service';
import { userEmailMatch } from '@pagespace/lib/auth/user-repository';
import { generateLoginCSRFToken } from '@/lib/auth/login-csrf-utils';
import { POST as inviteToDrive } from '@/app/api/drives/[driveId]/members/invite/route';
import { POST as shareInvitePage } from '@/app/api/pages/[pageId]/share-invite/route';
import { POST as grantOnPage } from '@/app/api/pages/[pageId]/permissions/route';
import { POST as redeemShareLink } from '@/app/api/share/[token]/accept/route';
import { POST as decideGuest } from '@/app/api/orgs/[orgId]/guest-approvals/[holdId]/route';
import { POST as sendMagicLink } from '@/app/api/auth/magic-link/send/route';
import { GET as verifyMagicLink } from '@/app/api/auth/magic-link/verify/route';

type Guests = 'off' | 'approve' | 'on';

interface World {
  orgId: string;
  owner: { id: string; token: string };
  member: { id: string; email: string };
  outsider: { id: string; email: string; token: string };
  driveId: string;
  pageId: string;
  driveLinkToken: string;
  pageLinkToken: string;
}

const created = { userIds: [] as string[], orgIds: [] as string[], driveIds: [] as string[] };
let dbAvailable = false;
let w: World;

beforeAll(async () => {
  try {
    await db.select({ id: organizations.id }).from(organizations).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('guests-policy-matrix.integration.test.ts', error);
  }
  vi.stubEnv('WEB_APP_URL', 'http://localhost');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

async function account(email = `p-${createId()}@outside.test`) {
  const user = await factories.createUser({ email, emailVerified: new Date() });
  created.userIds.push(user.id);
  return { id: user.id, email };
}

const sessionFor = (userId: string) =>
  sessionService.createSession({ authentication: null, userId, type: 'user', scopes: ['*'], expiresInMs: 3_600_000 });

beforeEach(async () => {
  if (!dbAvailable) return;
  const owner = await account(`owner-${createId()}@northwind.test`);
  const member = await account(`member-${createId()}@northwind.test`);
  const outsider = await account();
  const orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner.id, policies: { guests: 'on' } });
  await factories.createOrgSubscription(orgId, { status: 'active' });
  await db.insert(orgMembers).values([{ orgId, userId: owner.id, role: 'OWNER' }, { orgId, userId: member.id, role: 'MEMBER' }]);
  const drive = await factories.createDrive(owner.id, { orgId, orgVisibility: 'RESTRICTED' });
  created.driveIds.push(drive.id);
  const page = await factories.createPage(drive.id);
  // Links are made while guests are on (link creation is POL-3's, not this policy's), then the policy is set per row.
  const ownerToken = await sessionFor(owner.id);
  const ownerClaims = await sessionService.validateSession(ownerToken);
  if (!ownerClaims) throw new Error('owner session fixture failed');
  const ownerCtx = EnforcedAuthContext.fromSession(ownerClaims);
  const driveLink = await createDriveShareLink(ownerCtx, drive.id, { role: 'MEMBER' });
  const pageLink = await createPageShareLink(ownerCtx, page.id, { permissions: ['VIEW'] });
  if (!driveLink.ok || !pageLink.ok) throw new Error('share link fixture failed');
  w = {
    orgId,
    owner: { id: owner.id, token: ownerToken },
    member,
    outsider: { ...outsider, token: await sessionFor(outsider.id) },
    driveId: drive.id,
    pageId: page.id,
    driveLinkToken: driveLink.data.rawToken,
    pageLinkToken: pageLink.data.rawToken,
  };
});

afterEach(async () => {
  mail.inviteUrls.clear();
  mail.magicLinks.clear();
  if (!dbAvailable) return;
  // Accounts the sign-up route created are found by the addresses the tests used.
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) {
    await db.delete(orgGuestHolds).where(inArray(orgGuestHolds.orgId, created.orgIds));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgIds));
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) {
    await db.delete(drives).where(inArray(drives.ownerId, created.userIds));
    await db.delete(users).where(inArray(users.id, created.userIds));
  }
  created.userIds = [];
  created.orgIds = [];
  created.driveIds = [];
});

const setGuests = (guests: Guests) => db.update(organizations).set({ policies: { guests } }).where(eq(organizations.id, w.orgId));

const post = (url: string, token: string, body: unknown) =>
  new Request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const memberRow = async (userId: string) =>
  (await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, w.driveId), eq(driveMembers.userId, userId))))[0] ?? null;
const pageGrant = async (userId: string) =>
  (await db.select().from(pagePermissions).where(and(eq(pagePermissions.pageId, w.pageId), eq(pagePermissions.userId, userId))))[0] ?? null;
const pendingHolds = () =>
  db.select().from(orgGuestHolds).where(and(eq(orgGuestHolds.orgId, w.orgId), eq(orgGuestHolds.state, 'pending_approval')));

/** Sign up through the real magic-link routes; any invitation waiting for the address is accepted there. */
async function signUp(email: string): Promise<string> {
  const csrf = generateLoginCSRFToken();
  const sent = await sendMagicLink(new Request('http://localhost/api/auth/magic-link/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-login-csrf-token': csrf, cookie: `login_csrf=${csrf}`, 'x-forwarded-for': `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ email, tosAccepted: true }),
  }));
  expect(sent.status).toBe(200);
  const link = mail.magicLinks.get(email);
  if (!link) throw new Error(`no magic link was emailed to ${email}`);
  const verified = await verifyMagicLink(new Request(link));
  expect(verified.status).toBe(302);
  const [user] = await db.select({ id: users.id }).from(users).where(userEmailMatch(email));
  if (!user) throw new Error('sign-up created no account');
  created.userIds.push(user.id);
  return user.id;
}

interface Outcome {
  status: number;
  /** What the entry point would grant exists. */
  admitted: boolean;
}

/** Each request entry point, run by the drive's Owner (or the outsider, for a link), and what it grants. */
const ENTRY_POINTS: Record<string, () => Promise<Outcome>> = {
  'drive invite route, existing account (direct add)': async () => {
    const res = await inviteToDrive(
      post(`http://localhost/api/drives/${w.driveId}/members/invite`, w.owner.token, { userId: w.outsider.id, role: 'MEMBER' }),
      { params: Promise.resolve({ driveId: w.driveId }) },
    );
    return { status: res.status, admitted: (await memberRow(w.outsider.id)) !== null };
  },
  'drive invite route, address with no account (invitation)': async () => {
    const email = `new-${createId()}@outside.test`;
    const res = await inviteToDrive(
      post(`http://localhost/api/drives/${w.driveId}/members/invite`, w.owner.token, { email, role: 'MEMBER' }),
      { params: Promise.resolve({ driveId: w.driveId }) },
    );
    const invites = await db.select().from(pendingInvites).where(eq(pendingInvites.driveId, w.driveId));
    return { status: res.status, admitted: invites.length === 1 && mail.inviteUrls.has(email) };
  },
  'page share-invite route, existing account': async () => {
    const res = await shareInvitePage(
      post(`http://localhost/api/pages/${w.pageId}/share-invite`, w.owner.token, { email: w.outsider.email, permissions: ['VIEW'] }),
      { params: Promise.resolve({ pageId: w.pageId }) },
    );
    return { status: res.status, admitted: (await pageGrant(w.outsider.id)) !== null };
  },
  'page permissions route (direct page grant)': async () => {
    const res = await grantOnPage(
      post(`http://localhost/api/pages/${w.pageId}/permissions`, w.owner.token, { userId: w.outsider.id, canView: true, canEdit: false, canShare: false, canDelete: false }),
      { params: Promise.resolve({ pageId: w.pageId }) },
    );
    return { status: res.status, admitted: (await pageGrant(w.outsider.id)) !== null };
  },
  'drive share link redemption': async () => {
    const res = await redeemShareLink(post(`http://localhost/api/share/${w.driveLinkToken}/accept`, w.outsider.token, {}), { params: Promise.resolve({ token: w.driveLinkToken }) });
    return { status: res.status, admitted: (await memberRow(w.outsider.id)) !== null };
  },
  'page share link redemption': async () => {
    const res = await redeemShareLink(post(`http://localhost/api/share/${w.pageLinkToken}/accept`, w.outsider.token, {}), { params: Promise.resolve({ token: w.pageLinkToken }) });
    return { status: res.status, admitted: (await pageGrant(w.outsider.id)) !== null };
  },
};

/** An invitation sent while guests were ON, accepted at sign-up AFTER the policy became `guests`. */
const ACCEPTANCES: Record<string, (guests: Guests) => Promise<Outcome>> = {
  'drive invitation accepted at sign-up': async (guests) => {
    const email = `drive-${createId()}@outside.test`;
    const sent = await inviteToDrive(
      post(`http://localhost/api/drives/${w.driveId}/members/invite`, w.owner.token, { email, role: 'MEMBER' }),
      { params: Promise.resolve({ driveId: w.driveId }) },
    );
    expect(sent.status).toBe(200);
    await setGuests(guests);
    const userId = await signUp(email);
    return { status: 200, admitted: (await memberRow(userId)) !== null };
  },
  'page invitation accepted at sign-up': async (guests) => {
    const email = `page-${createId()}@outside.test`;
    const sent = await shareInvitePage(
      post(`http://localhost/api/pages/${w.pageId}/share-invite`, w.owner.token, { email, permissions: ['VIEW'] }),
      { params: Promise.resolve({ pageId: w.pageId }) },
    );
    expect(sent.status).toBe(200);
    expect(await db.select().from(pendingPageInvites).where(eq(pendingPageInvites.pageId, w.pageId))).toHaveLength(1);
    await setGuests(guests);
    const userId = await signUp(email);
    return { status: 200, admitted: (await pageGrant(userId)) !== null };
  },
};

describe('POL-2 guests from outside: off refuses, approve queues for an admin, on admits — at every entry point, unmocked', () => {
  describe.each(Object.keys(ENTRY_POINTS))('%s', (name) => {
    it('off: refused, nothing granted, nothing queued', async () => {
      if (!dbAvailable) return;
      await setGuests('off');
      const outcome = await ENTRY_POINTS[name]();
      expect([403, 404]).toContain(outcome.status);
      expect(outcome.admitted).toBe(false);
      expect(await pendingHolds()).toHaveLength(0);
    });

    it('approve: 202, nothing granted, one request queued for an Owner or Admin', async () => {
      if (!dbAvailable) return;
      await setGuests('approve');
      const outcome = await ENTRY_POINTS[name]();
      expect(outcome.status).toBe(202);
      expect(outcome.admitted).toBe(false);
      expect(await pendingHolds()).toHaveLength(1);
    });

    it('on: admitted', async () => {
      if (!dbAvailable) return;
      await setGuests('on');
      const outcome = await ENTRY_POINTS[name]();
      expect([200, 201]).toContain(outcome.status);
      expect(outcome.admitted).toBe(true);
      expect(await pendingHolds()).toHaveLength(0);
    });

    it('[D-OW-30] an org with no subscription row is lapsed: refused even with guests on, nothing queued', async () => {
      if (!dbAvailable) return;
      await setGuests('on');
      await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
      const outcome = await ENTRY_POINTS[name]();
      // 402 org_lapsed where the route names the lapse; a link answers 404 as for any link it will not honour.
      expect([402, 404]).toContain(outcome.status);
      expect(outcome.admitted).toBe(false);
      expect(await pendingHolds()).toHaveLength(0);
    });
  });

  describe.each(Object.keys(ACCEPTANCES))('%s', (name) => {
    it('off: the invitation admits nobody', async () => {
      if (!dbAvailable) return;
      expect((await ACCEPTANCES[name]('off')).admitted).toBe(false);
      expect(await pendingHolds()).toHaveLength(0);
    });

    it('approve: an invitation no admin approved is queued instead of admitting', async () => {
      if (!dbAvailable) return;
      expect((await ACCEPTANCES[name]('approve')).admitted).toBe(false);
      expect(await pendingHolds()).toHaveLength(1);
    });

    it('on: the invitation admits', async () => {
      if (!dbAvailable) return;
      expect((await ACCEPTANCES[name]('on')).admitted).toBe(true);
    });
  });

  const approve = (holdId: string, token = w.owner.token) =>
    decideGuest(post(`http://localhost/api/orgs/${w.orgId}/guest-approvals/${holdId}`, token, { decision: 'approve' }), {
      params: Promise.resolve({ orgId: w.orgId, holdId }),
    });

  describe.each(Object.keys(ENTRY_POINTS))('approving the request queued by: %s', (name) => {
    it('admits through the same code the entry point runs, and is refused while guests are off', async () => {
      if (!dbAvailable) return;
      await setGuests('approve');
      await ENTRY_POINTS[name]();
      const [hold] = await pendingHolds();

      await setGuests('off');
      expect((await approve(hold.id)).status).toBe(403);
      expect(await pendingHolds()).toHaveLength(1);

      await setGuests('approve');
      const res = await approve(hold.id);
      expect(res.status).toBe(200);
      expect(await pendingHolds()).toHaveLength(0);
      if (hold.userId) {
        const admitted = (await memberRow(hold.userId)) !== null || (await pageGrant(hold.userId)) !== null;
        expect(admitted).toBe(true);
      } else {
        // An address with no account: approval sends the invitation, and it admits at sign-up under approve.
        const email = hold.email ?? '';
        expect(mail.inviteUrls.has(email)).toBe(true);
        const userId = await signUp(email);
        expect(await memberRow(userId)).not.toBeNull();
      }
    });
  });

  it('an org member is never a guest: the drive invite route adds them with guests off', async () => {
    if (!dbAvailable) return;
    await setGuests('off');
    const res = await inviteToDrive(
      post(`http://localhost/api/drives/${w.driveId}/members/invite`, w.owner.token, { userId: w.member.id, role: 'MEMBER' }),
      { params: Promise.resolve({ driveId: w.driveId }) },
    );
    expect(res.status).toBe(200);
    expect(await memberRow(w.member.id)).not.toBeNull();
  });
});
