/**
 * Changing an org's sign-in policy — REAL Postgres (D-OW-45; SEC-2/SEC-3 partial, POL-1 partial).
 *
 * Loosening (strong sign-in off, a longer or no maximum age) is judged under the org row's lock against the stored
 * policy and needs the acting credential to satisfy it; nothing is stored when it does not. Tightening always applies,
 * even for a lapsed org ([D-OW-33]), and the org.policy.blocked audit row says how many members and live credentials
 * and guests and live credentials the new policy refuses (counts, no identities).
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/organizations/__tests__/sign-in-policy-change.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { drives } from '@pagespace/db/schema/core';
import { sessionService } from '../../auth/session-service';
import type { VerifiedAuthentication } from '../../auth/authentication-evidence';

const audit = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
  }),
  recordOrgAuditEventAfterCommit: vi.fn(async () => true),
}));

import { updateOrgPolicies } from '../policies';
import { getOrgPolicies } from '../policy-reader';

const created = { userIds: [] as string[], orgIds: [] as string[], driveIds: [] as string[] };
let orgId: string;
let owner: string;
let members: string[];

const now = () => Date.now();
const passkey = (): VerifiedAuthentication => ({ authenticatedAtMs: now() - 1000, assurance: 'user_verified_passkey' });
const emailLink = (ageMinutes = 0): VerifiedAuthentication => ({ authenticatedAtMs: now() - ageMinutes * 60_000 - 1000, assurance: 'single_factor' });

async function session(userId: string, authentication: VerifiedAuthentication | null) {
  await sessionService.createSession({ userId, authentication, type: 'user', scopes: ['*'], expiresInMs: 86_400_000 });
}

async function cleanup() {
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  created.driveIds = [];
  if (created.orgIds.length) {
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgIds));
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.orgIds = [];
}

async function setup({ paying }: { paying: boolean }) {
  audit.events.length = 0;
  const mk = async () => {
    const u = await factories.createUser();
    created.userIds.push(u.id);
    return u.id;
  };
  owner = await mk();
  members = [await mk(), await mk(), await mk()];
  orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner });
  if (paying) await factories.createOrgSubscription(orgId);
  await db.insert(orgMembers).values([
    { orgId, userId: owner, role: 'OWNER' },
    ...members.map((userId) => ({ orgId, userId, role: 'MEMBER' as const })),
  ]);
  // Owner: a passkey session. Member 0: a passkey and an emailed-link session. Member 1: an emailed link, 2 hours old.
  // Member 2: a credential minted before evidence existed. A non-member's session is never counted.
  await session(owner, passkey());
  await session(members[0], passkey());
  await session(members[0], emailLink());
  await session(members[1], emailLink(120));
  await session(members[2], null);
  const outsider = await mk();
  await session(outsider, null);
}

const change = (actorAuthentication: VerifiedAuthentication | null, patch: Parameters<typeof updateOrgPolicies>[0]['patch']) =>
  updateOrgPolicies({ orgId, actorId: owner, actorAuthentication, patch });
const blockedEvent = () => audit.events.find((e) => e.eventType === 'org.policy.blocked');

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

describe('changing an org sign-in policy (D-OW-45)', () => {
  beforeEach(() => setup({ paying: true }));

  it('SEC-2 (partial) POL-1 (partial) requiring strong sign-in applies from a passkey credential and audits who it now refuses, by count', async () => {
    const result = await change(passkey(), { requireStrongSignIn: true });

    // Refused: member 0's emailed-link session, member 1's, member 2's legacy one. Members left with none: 1 and 2.
    expect(result).toMatchObject({ ok: true, signInBlocked: { members: 2, credentials: 3 } });
    expect(blockedEvent()).toMatchObject({ eventType: 'org.policy.blocked', details: { signIn: { members: 2, credentials: 3 } } });
    expect(JSON.stringify(blockedEvent())).not.toContain(members[1]);
  });

  it('SEC-2 (partial) POL-1 (partial) the count includes the org\'s guests, apart from its members (review #2866 B4)', async () => {
    const mk = async () => {
      const u = await factories.createUser();
      created.userIds.push(u.id);
      return u.id;
    };
    const drive = await factories.createDrive(owner, { orgId });
    created.driveIds.push(drive.id);
    const [guest, admittedGuest] = [await mk(), await mk()];
    await factories.createDriveMember(drive.id, guest);
    await factories.createDriveMember(drive.id, admittedGuest);
    await factories.createDriveMember(drive.id, members[1]);
    await session(guest, emailLink());
    await session(admittedGuest, passkey());

    const result = await change(passkey(), { requireStrongSignIn: true });

    // Members as before (a member on a drive is still a member, not a guest); one guest left with no admitted credential.
    expect(result).toMatchObject({ ok: true, signInBlocked: { members: 2, guests: 1, credentials: 4 } });
    expect(blockedEvent()).toMatchObject({ details: { signIn: { members: 2, guests: 1, credentials: 4 } } });
    expect(JSON.stringify(blockedEvent())).not.toContain(guest);
  });

  it('SEC-3 (partial) POL-1 (partial) a maximum age audits the stale and evidence-less credentials it refuses', async () => {
    const result = await change(passkey(), { maximumSessionAgeMinutes: 60 });
    expect(result).toMatchObject({ ok: true, signInBlocked: { members: 2, credentials: 2 } });
  });

  it('SEC-2 (partial) turning strong sign-in off is refused from an emailed-link credential and stores nothing', async () => {
    await change(passkey(), { requireStrongSignIn: true });

    expect(await change(emailLink(), { requireStrongSignIn: false })).toEqual({ ok: false, reason: 'org_strong_sign_in_required' });
    expect(await change(null, { requireStrongSignIn: false })).toEqual({ ok: false, reason: 'org_strong_sign_in_required' });
    expect((await getOrgPolicies(orgId)).requireStrongSignIn).toBe(true);

    expect(await change(passkey(), { requireStrongSignIn: false })).toMatchObject({ ok: true, signInBlocked: null });
    expect((await getOrgPolicies(orgId)).requireStrongSignIn).toBe(false);
  });

  it('SEC-3 (partial) raising or removing the maximum age needs a credential fresher than the age in force', async () => {
    await change(passkey(), { maximumSessionAgeMinutes: 60 });

    expect(await change(emailLink(61), { maximumSessionAgeMinutes: null })).toEqual({ ok: false, reason: 'org_reauthentication_required' });
    expect((await getOrgPolicies(orgId)).maximumSessionAgeMinutes).toBe(60);
    expect(await change(emailLink(), { maximumSessionAgeMinutes: 120 })).toMatchObject({ ok: true });
    expect((await getOrgPolicies(orgId)).maximumSessionAgeMinutes).toBe(120);
  });

  it('SEC-2 (partial) enabling strong sign-in from an emailed-link credential is refused so the Admin cannot lock themselves out (D-OW-47)', async () => {
    expect(await change(emailLink(), { requireStrongSignIn: true }))
      .toEqual({ ok: false, reason: 'org_policy_would_lock_out_actor', requires: 'org_strong_sign_in_required' });
    expect((await getOrgPolicies(orgId)).requireStrongSignIn).toBe(false);
    expect(audit.events).toEqual([]);
  });

  it('SEC-3 (partial) a maximum age shorter than the Admin\'s own sign-in age is refused until they sign in again (D-OW-47)', async () => {
    expect(await change(emailLink(30), { maximumSessionAgeMinutes: 15 }))
      .toEqual({ ok: false, reason: 'org_policy_would_lock_out_actor', requires: 'org_reauthentication_required' });
    expect((await getOrgPolicies(orgId)).maximumSessionAgeMinutes).toBeNull();
    expect(await change(emailLink(), { maximumSessionAgeMinutes: 15 })).toMatchObject({ ok: true });
  });

  it('a change that does not touch the sign-in keys is not judged by the actor credential', async () => {
    await change(passkey(), { requireStrongSignIn: true });
    expect(await change(null, { publicShareLinks: false })).toMatchObject({ ok: true, signInBlocked: null });
  });
});

describe('a lapsed org (D-OW-33)', () => {
  beforeEach(() => setup({ paying: false }));

  it('SEC-2 (partial) may still tighten its sign-in policy', async () => {
    expect(await change(passkey(), { requireStrongSignIn: true, maximumSessionAgeMinutes: 15 })).toMatchObject({ ok: true });
    const stored = await db.select({ policies: organizations.policies }).from(organizations).where(eq(organizations.id, orgId));
    expect(stored[0].policies).toMatchObject({ requireStrongSignIn: true, maximumSessionAgeMinutes: 15 });
  });
});
