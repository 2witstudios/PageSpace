/**
 * Who can invite (Spec POL-5) against REAL Postgres: the org's policy is read inside the invitation transaction, for
 * a new invitation and for a resend, and it is judged on the actor's org role. Only an Owner or Admin may hand out
 * the Admin role, whatever the policy.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgInvitations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('../../audit/org-audit', () => ({ recordOrgAuditEvent: vi.fn(async () => {}) }));

import { createOrRotateInvitation, resendInvitation } from '../invitations';

const created = { userIds: [] as string[], orgId: '' };
let w: { orgId: string; owner: string; admin: string; member: string };
const deliver = async () => {};

async function cleanup() {
  if (created.orgId) {
    await db.delete(orgInvitations).where(eq(orgInvitations.orgId, created.orgId));
    await db.delete(orgMembers).where(eq(orgMembers.orgId, created.orgId));
    await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, created.orgId));
    await db.delete(organizations).where(eq(organizations.id, created.orgId));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.orgId = '';
}

beforeEach(async () => {
  const people = await factories.createUsers(3, { subscriptionTier: 'free' });
  created.userIds.push(...people.map((p) => p.id));
  const [owner, admin, member] = people.map((p) => p.id);
  const orgId = createId();
  created.orgId = orgId;
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner, stripeCustomerId: `cus_${createId()}` });
  await db.insert(orgMembers).values([{ orgId, userId: owner, role: 'OWNER' }, { orgId, userId: admin, role: 'ADMIN' }, { orgId, userId: member, role: 'MEMBER' }]);
  await db.insert(orgSubscriptions).values({
    orgId, stripeSubscriptionId: `sub_${createId()}`, stripeBasePriceId: 'pb', stripeBaseItemId: 'ib', stripeSeatPriceId: 'ps', stripeSeatItemId: 'is',
    extraSeatQuantity: 0, status: 'active', currentPeriodStart: new Date(Date.now() - 86_400_000), currentPeriodEnd: new Date(Date.now() + 29 * 86_400_000),
  });
  w = { orgId, owner, admin, member };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const setWho = (whoCanInvite: string | undefined) => db.update(organizations).set({ policies: whoCanInvite === undefined ? {} : { whoCanInvite } }).where(eq(organizations.id, w.orgId));
const invite = (actorRole: 'OWNER' | 'ADMIN' | 'MEMBER', invitedBy: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER') =>
  createOrRotateInvitation({ orgId: w.orgId, email: `p-${createId()}@northwind.test`, role, invitedBy, actorRole, now: new Date(), deliver });
const invitations = () => db.select().from(orgInvitations).where(eq(orgInvitations.orgId, w.orgId));

describe('who can invite', () => {
  it('POL-5 with no policy stored only Owners and Admins invite; a Member is refused, naming the policy, and nothing is stored', async () => {
    expect((await invite('OWNER', w.owner)).ok).toBe(true);
    expect((await invite('ADMIN', w.admin)).ok).toBe(true);

    const refused = await invite('MEMBER', w.member);

    expect(refused).toMatchObject({ ok: false, status: 403, code: 'org_policy', policy: 'whoCanInvite' });
    expect(await invitations()).toHaveLength(2);
  });

  it('POL-5 with members allowed, a plain Member invites; turning it back to admins refuses them at the next call, no restart', async () => {
    await setWho('members');
    expect((await invite('MEMBER', w.member)).ok).toBe(true);
    await setWho('admins');
    expect(await invite('MEMBER', w.member)).toMatchObject({ ok: false, code: 'org_policy' });
  });

  it('POL-5 (partial) a Member may never invite someone as an Admin, even where members may invite', async () => {
    await setWho('members');
    expect(await invite('MEMBER', w.member, 'ADMIN')).toMatchObject({ ok: false, status: 403, policy: 'whoCanInvite', message: expect.stringContaining('Admin') });
    expect((await invite('ADMIN', w.admin, 'ADMIN')).ok).toBe(true);
    expect(await invitations()).toHaveLength(1);
  });

  it('POL-5 (partial) a damaged stored value fails closed to admins only', async () => {
    await setWho('banana');
    expect(await invite('MEMBER', w.member)).toMatchObject({ ok: false, code: 'org_policy' });
    expect((await invite('OWNER', w.owner)).ok).toBe(true);
  });

  it('POL-5 (partial) a RESEND is judged the same way, on the actor and the role the invitation carries', async () => {
    const issued = await invite('ADMIN', w.admin, 'ADMIN');
    if (!issued.ok) throw new Error('setup');
    await setWho('members');

    const asMember = await resendInvitation({ orgId: w.orgId, invitationId: issued.invitation.id, actorRole: 'MEMBER', now: new Date(), deliver });
    expect(asMember).toMatchObject({ ok: false, status: 403, code: 'org_policy' });
    await setWho('admins');
    const asAdmin = await resendInvitation({ orgId: w.orgId, invitationId: issued.invitation.id, actorRole: 'ADMIN', now: new Date(), deliver });
    expect(asAdmin.ok).toBe(true);
    const plain = await invite('OWNER', w.owner);
    if (!plain.ok) throw new Error('setup');
    await setWho('admins');
    expect(await resendInvitation({ orgId: w.orgId, invitationId: plain.invitation.id, actorRole: 'MEMBER', now: new Date(), deliver })).toMatchObject({ ok: false, code: 'org_policy' });
  });
});
