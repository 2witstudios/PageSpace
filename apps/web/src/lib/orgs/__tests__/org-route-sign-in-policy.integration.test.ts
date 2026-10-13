// @vitest-environment node
/**
 * Review #2866 B1 (D-OW-45, SEC-2/3): the org admin routes ask the org's sign-in policy of every session and key AFTER
 * the role check. A stolen stale or single-factor Admin (or Owner) session cannot invite, change a member, add a domain
 * or hand over ownership; a freshly signed-in passkey Admin passes the gate; a non-member is refused exactly as before,
 * learning nothing of the policy. Real Postgres, real session tokens, real routes; only ORGS_ENABLED is switched on.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/security/distributed-rate-limit')>()),
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true })),
}));

import { POST as invite } from '@/app/api/orgs/[orgId]/invitations/route';
import { PATCH as changeMember } from '@/app/api/orgs/[orgId]/members/[userId]/route';
import { POST as addDomain } from '@/app/api/orgs/[orgId]/domains/route';
import { POST as transferOwnership } from '@/app/api/orgs/[orgId]/transfer-ownership/route';
import { POST as leave } from '@/app/api/orgs/[orgId]/leave/route';

const MINUTE = 60_000;
const created = { users: [] as string[], orgs: [] as string[] };
const evidence = (assurance: VerifiedAuthentication['assurance'], ageMs = 0): VerifiedAuthentication =>
  ({ authenticatedAtMs: Date.now() - ageMs, assurance });

const session = (userId: string, authentication: VerifiedAuthentication) =>
  sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 60 * MINUTE, authentication });

const post = (url: string, token: string, body: unknown, method = 'POST') =>
  new Request(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function acme(policies: Record<string, unknown>) {
  const [owner, admin, member, outsider] = await Promise.all([1, 2, 3, 4].map(() => factories.createUser()));
  created.users.push(owner.id, admin.id, member.id, outsider.id);
  const [org] = await db.insert(organizations).values({ name: 'Acme', slug: `acme-${createId()}`, ownerId: owner.id, policies }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: owner.id, role: 'OWNER' },
    { orgId: org.id, userId: admin.id, role: 'ADMIN' },
    { orgId: org.id, userId: member.id, role: 'MEMBER' },
  ]);
  return { org, owner, admin, member, outsider };
}

/** Every admin action the review named, as the given credential. */
function adminActions(f: Awaited<ReturnType<typeof acme>>, adminToken: string, ownerToken: string) {
  const orgId = f.org.id;
  return {
    invite: () => invite(post(`https://app.test/api/orgs/${orgId}/invitations`, adminToken, { email: `x-${createId()}@example.com`, role: 'ADMIN' }), { params: Promise.resolve({ orgId }) }),
    changeMember: () => changeMember(post(`https://app.test/api/orgs/${orgId}/members/${f.member.id}`, adminToken, { role: 'ADMIN' }, 'PATCH'), { params: Promise.resolve({ orgId, userId: f.member.id }) }),
    addDomain: () => addDomain(post(`https://app.test/api/orgs/${orgId}/domains`, adminToken, { domain: `acme-${createId()}.example.com` }), { params: Promise.resolve({ orgId }) }),
    transferOwnership: () => transferOwnership(post(`https://app.test/api/orgs/${orgId}/transfer-ownership`, ownerToken, { toUserId: f.admin.id }), { params: Promise.resolve({ orgId }) }),
  };
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

describe('SEC-2 (partial) SEC-3 (partial) the org admin routes ask the org sign-in policy of the credential, after the role check', () => {
  it('SEC-2 (partial) a single-factor Admin or Owner session is refused every admin action with the strong-sign-in code', async () => {
    const f = await acme({ requireStrongSignIn: true });
    const actions = adminActions(f, await session(f.admin.id, evidence('single_factor')), await session(f.owner.id, evidence('single_factor')));
    for (const [name, act] of Object.entries(actions)) {
      const res = await act();
      expect(res.status, name).toBe(403);
      expect(await res.json(), name).toMatchObject({ code: 'org_strong_sign_in_required' });
    }
  });

  it('SEC-3 (partial) a stale Admin or Owner session is refused every admin action with the reauthentication code', async () => {
    const f = await acme({ maximumSessionAgeMinutes: 60 });
    const actions = adminActions(f, await session(f.admin.id, evidence('user_verified_passkey', 2 * 60 * MINUTE)), await session(f.owner.id, evidence('user_verified_passkey', 2 * 60 * MINUTE)));
    for (const [name, act] of Object.entries(actions)) {
      const res = await act();
      expect(res.status, name).toBe(403);
      expect(await res.json(), name).toMatchObject({ code: 'org_reauthentication_required' });
    }
  });

  it('SEC-2 (partial) a freshly signed-in passkey Admin and Owner pass the gate', async () => {
    const f = await acme({ requireStrongSignIn: true, maximumSessionAgeMinutes: 60 });
    const actions = adminActions(f, await session(f.admin.id, evidence('user_verified_passkey')), await session(f.owner.id, evidence('user_verified_passkey')));
    for (const [name, act] of Object.entries(actions)) {
      const body = await (await act()).json();
      expect(body?.code, name).not.toBe('org_strong_sign_in_required');
      expect(body?.code, name).not.toBe('org_reauthentication_required');
    }
  });

  it('SEC-2 (partial) a non-member is refused as before and never told the org policy', async () => {
    const f = await acme({ requireStrongSignIn: true });
    const stranger = await session(f.outsider.id, evidence('single_factor'));
    const res = await adminActions(f, stranger, stranger).invite();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'org_not_found' });
  });

  it('SEC-3 (partial) a damaged stored maximum age stays repairable: a fresh Admin reaches the settings', async () => {
    const f = await acme({ maximumSessionAgeMinutes: 3 });
    const res = await adminActions(f, await session(f.admin.id, evidence('single_factor')), await session(f.owner.id, evidence('single_factor'))).addDomain();
    expect((await res.json())?.code).not.toBe('org_reauthentication_required');
  });
});

describe('leaving an org only restricts, so it never asks for a qualifying sign-in (D-OW-33 spirit, review #2866 B)', () => {
  it('SEC-2 (partial) SEC-3 (partial) a member on a single-factor or stale session leaves a passkey-only, short-age org', async () => {
    const f = await acme({ requireStrongSignIn: true, maximumSessionAgeMinutes: 15 });
    const token = await session(f.member.id, evidence('single_factor', 30 * MINUTE));
    const res = await leave(post(`https://app.test/api/orgs/${f.org.id}/leave`, token, {}), { params: Promise.resolve({ orgId: f.org.id }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ left: true });
    expect(await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, f.org.id), eq(orgMembers.userId, f.member.id)))).toEqual([]);
  });

  it('a non-member still cannot "leave" (role check unchanged)', async () => {
    const f = await acme({ requireStrongSignIn: true });
    const token = await session(f.outsider.id, evidence('user_verified_passkey'));
    const res = await leave(post(`https://app.test/api/orgs/${f.org.id}/leave`, token, {}), { params: Promise.resolve({ orgId: f.org.id }) });
    expect(res.status).toBe(404);
  });
});
