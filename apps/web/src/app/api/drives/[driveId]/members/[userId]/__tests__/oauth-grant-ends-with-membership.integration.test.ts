/**
 * An OAuth drive grant ends with the membership it was consented under — real
 * Postgres (point-guard ruling on Phase 2 review finding; ADR 0002 Decision 2:
 * grant-time authority is not resolution-time authority).
 *
 * A token's scope rows are frozen at consent; there is no `mcp_token_drives`
 * row to delete when the user leaves. Two mechanisms, each proven alone:
 *
 *   (a) RESOLUTION TIME — the scope resolvers grant an explicit-role row only
 *       while the user is still a member or owner, so a membership that ends by
 *       ANY path (here: the row simply disappears) ends the token's access in
 *       that drive on the very next request.
 *   (b) REVOCATION — removing a member through the members route revokes that
 *       user's live OAuth families naming the drive, so the app cannot even
 *       refresh.
 *
 * Stubbed only: the signed-in owner's browser session for the removal request
 * (bearer requests authenticate for real), realtime/notification side effects,
 * the audit sink and the rate limiter. FAILS LOUDLY without DATABASE_URL.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { driveMembers } from '@pagespace/db/schema/members';
import { oauthAccessTokens, oauthClients, oauthRefreshTokens } from '@pagespace/db/schema/oauth';
import { factories } from '@pagespace/db/test/factories';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { ensureTestDb } from '@/test/ensure-test-db';

const session = vi.hoisted(() => ({ userId: '' }));

vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...real,
    authenticateRequestWithOptions: vi.fn(async (req: Request, options: Parameters<typeof real.authenticateRequestWithOptions>[1]) => {
      if (req.headers.get('authorization')) return real.authenticateRequestWithOptions(req, options);
      return { tokenType: 'session' as const, userId: session.userId, role: 'user' as const, tokenVersion: 0, adminRoleVersion: 0, sessionId: 'owner-session' };
    }),
  };
});
vi.mock('@/lib/websocket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/websocket')>()),
  broadcastDriveMemberEvent: vi.fn(async () => undefined),
  broadcastDriveMemberEventToRecipients: vi.fn(async () => undefined),
}));
vi.mock('@pagespace/lib/permissions/revocation-kick', () => ({ kickForDriveMembershipRevocation: vi.fn(async () => undefined) }));
vi.mock('@pagespace/lib/notifications/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/notifications/notifications')>()),
  createDriveNotification: vi.fn(async () => undefined),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/security/distributed-rate-limit')>()),
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true, attemptsRemaining: 99 })),
}));

import { DELETE as removeMember } from '../route';
import { GET as pageGET } from '../../../../../pages/[pageId]/route';
import { POST as tokenPOST } from '../../../../../oauth/token/route';

interface Grant {
  clientId: string;
  access: string;
  refresh: string;
}

async function grantFor(userId: string, scopes: string[]): Promise<Grant> {
  const clientId = `app_${createId()}`;
  const [client] = await db
    .insert(oauthClients)
    .values({
      clientId,
      name: 'Removal App',
      clientType: 'public',
      redirectUris: ['https://removal.example/callback'],
      allowedGrantTypes: ['authorization_code', 'refresh_token'],
      allowedScopes: ['drive:admin', 'drive:member', 'offline_access'],
      ownerUserId: userId,
      verified: false,
    })
    .returning();
  const familyId = createId();
  const refresh = generateToken('ps_rt');
  const access = generateToken('ps_at');
  const later = (ms: number) => new Date(Date.now() + ms);
  await db.insert(oauthRefreshTokens).values({
    tokenHash: refresh.hash, tokenPrefix: refresh.tokenPrefix, familyId, clientId: client.id, userId, scopes,
    tokenVersion: 0, expiresAt: later(30 * 24 * 3600 * 1000), familyExpiresAt: later(90 * 24 * 3600 * 1000),
  });
  await db.insert(oauthAccessTokens).values({
    tokenHash: access.hash, tokenPrefix: access.tokenPrefix, familyId, clientId: client.id, userId, scopes,
    tokenVersion: 0, expiresAt: later(15 * 60 * 1000),
  });
  return { clientId, access: access.token, refresh: refresh.token };
}

const readPage = (pageId: string, token: string) =>
  pageGET(new Request(`http://localhost/api/pages/${pageId}`, { headers: { authorization: `Bearer ${token}` } }), {
    params: Promise.resolve({ pageId }),
  });

const refresh = (grant: Grant) =>
  tokenPOST(
    new Request('http://localhost/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refresh, client_id: grant.clientId }).toString(),
    }) as never,
  );

describe('an OAuth drive grant ends with the membership it was consented under (real database)', () => {
  let ownerId: string;
  let memberId: string;
  let driveId: string;
  let pageId: string;
  let grant: Grant;

  beforeAll(async () => {
    await ensureTestDb();
  });

  beforeEach(async () => {
    ownerId = (await factories.createUser()).id;
    memberId = (await factories.createUser()).id;
    driveId = (await factories.createDrive(ownerId)).id;
    pageId = (await factories.createPage(driveId, { title: 'Shared page' })).id;
    await db.insert(driveMembers).values({ driveId, userId: memberId, role: 'ADMIN', invitedBy: ownerId, acceptedAt: new Date() });
    grant = await grantFor(memberId, [`drive:${driveId}:admin`, 'offline_access']);
    session.userId = ownerId;

    // Control: while a member, the grant works.
    expect((await readPage(pageId, grant.access)).status).toBe(200);
  });

  it('(a) the access token loses the drive on the next request, whatever ended the membership', async () => {
    await db.delete(driveMembers).where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, memberId)));

    const res = await readPage(pageId, grant.access);
    expect(res.status).toBe(403);
  });

  it('(b) removal through the members route revokes the family — no refresh, and the access token is dead', async () => {
    const removed = await removeMember(
      new Request(`http://localhost/api/drives/${driveId}/members/${memberId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ driveId, userId: memberId }) },
    );
    expect(removed.status).toBe(200);

    const refreshed = await refresh(grant);
    expect(refreshed.status, await refreshed.clone().text()).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' });

    expect((await readPage(pageId, grant.access)).status).toBe(401);
  });

  it("(b) leaves the removed user's grants for OTHER drives alone", async () => {
    const otherDrive = (await factories.createDrive(memberId)).id;
    const otherPage = (await factories.createPage(otherDrive, { title: 'Own page' })).id;
    const other = await grantFor(memberId, [`drive:${otherDrive}:admin`, 'offline_access']);

    const removed = await removeMember(
      new Request(`http://localhost/api/drives/${driveId}/members/${memberId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ driveId, userId: memberId }) },
    );
    expect(removed.status).toBe(200);

    expect((await readPage(otherPage, other.access)).status).toBe(200);
    expect((await refresh(other)).status).toBe(200);
  });
});
