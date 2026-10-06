/**
 * GET/PUT /api/drives/[driveId]/imago-access against a REAL Postgres — real
 * session tokens minted by the session service and sent as the browser's
 * session cookie, real CSRF tokens bound to that session, a real Origin check,
 * real Imago provisioning and real `imago_drive_access` rows. No mocks of
 * auth, permissions or the database.
 *
 * IMG-10.10: the setting is the viewer's own exclusion — on by default, off
 * keeps their Imago out of the drive. What only a real database can show: that
 * any user who can access the drive reads and sets only their own choice, that
 * a stranger is refused with nothing changed, that a forged or foreign-origin
 * PUT changes nothing, that no drive grant is ever made, and that a drive
 * switched off stays off across re-provisioning.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { imagoDriveAccess } from '@pagespace/db/schema/imago-drive-access';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { provisionHomeDriveIfNeeded } from '@pagespace/lib/onboarding/home-drive';
import { COOKIE_CONFIG } from '@/lib/auth/cookie-config';
import { ensureTestDb } from '@/test/ensure-test-db';
import { GET, PUT } from '../route';

const APP_ORIGIN = 'http://localhost:3000';
const seededUserIds: string[] = [];
let previousWebAppUrl: string | undefined;

async function provisionedUser() {
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  return { user, home };
}

async function agentIdsOf(userId: string) {
  return Object.values((await provisionImagoAgents(userId)).agents);
}

async function browserSession(userId: string) {
  const token = await sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 });
  const claims = await sessionService.validateSession(token);
  if (!claims) throw new Error('session did not validate');
  return { token, csrf: generateCSRFToken(claims.sessionId) };
}

type Session = Awaited<ReturnType<typeof browserSession>>;

const url = (driveId: string) => `http://localhost/api/drives/${driveId}/imago-access`;
const context = (driveId: string) => ({ params: Promise.resolve({ driveId }) });

function getAs(session: Session, driveId: string) {
  return GET(
    new Request(url(driveId), { headers: { cookie: `${COOKIE_CONFIG.session.name}=${session.token}` } }),
    context(driveId),
  );
}

function putAs(session: Session, driveId: string, enabled: boolean, overrides: { csrf?: string | null; origin?: string } = {}) {
  const headers: Record<string, string> = {
    cookie: `${COOKIE_CONFIG.session.name}=${session.token}`,
    'content-type': 'application/json',
    origin: overrides.origin ?? APP_ORIGIN,
  };
  const csrf = overrides.csrf === undefined ? session.csrf : overrides.csrf;
  if (csrf !== null) headers['x-csrf-token'] = csrf;
  return PUT(new Request(url(driveId), { method: 'PUT', headers, body: JSON.stringify({ enabled }) }), context(driveId));
}

async function membersIn(driveId: string, agentIds: string[]) {
  const rows = await db
    .select({ agentPageId: driveAgentMembers.agentPageId })
    .from(driveAgentMembers)
    .where(and(eq(driveAgentMembers.driveId, driveId), inArray(driveAgentMembers.agentPageId, agentIds)));
  return rows.map((row) => row.agentPageId).sort();
}

async function storedChoice(userId: string, driveId: string) {
  const [row] = await db
    .select({ enabled: imagoDriveAccess.enabled })
    .from(imagoDriveAccess)
    .where(and(eq(imagoDriveAccess.userId, userId), eq(imagoDriveAccess.driveId, driveId)));
  return row?.enabled ?? null;
}

beforeAll(async () => {
  await ensureTestDb();
  previousWebAppUrl = process.env.WEB_APP_URL;
  process.env.WEB_APP_URL = APP_ORIGIN;
});

afterAll(async () => {
  if (previousWebAppUrl === undefined) delete process.env.WEB_APP_URL;
  else process.env.WEB_APP_URL = previousWebAppUrl;
  if (seededUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

describe('GET/PUT /api/drives/[driveId]/imago-access (integration)', () => {
  it('given the drive owner, should read on by default and store their own exclusion, never a drive grant', async () => {
    const { user } = await provisionedUser();
    const drive = await factories.createDrive(user.id, { name: 'Owned' });
    const ids = await agentIdsOf(user.id);
    const session = await browserSession(user.id);

    const read = await getAs(session, drive.id);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ driveId: drive.id, enabled: true });

    const off = await putAs(session, drive.id, false);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ driveId: drive.id, enabled: false });
    expect(await storedChoice(user.id, drive.id)).toBe(false);
    expect(await (await getAs(session, drive.id)).json()).toMatchObject({ enabled: false });

    const on = await putAs(session, drive.id, true);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ driveId: drive.id, enabled: true });
    expect(await membersIn(drive.id, ids)).toEqual([]);
  });

  it('given a member, a guest with a shared page, an admin, should each set only their own choice', async () => {
    const { user: owner } = await provisionedUser();
    const drive = await factories.createDrive(owner.id, { name: 'Team' });
    const shared = await factories.createPage(drive.id, { title: 'Shared', type: 'DOCUMENT' });
    await agentIdsOf(owner.id);

    for (const role of ['ADMIN', 'MEMBER', 'GUEST'] as const) {
      const { user: viewer } = await provisionedUser();
      const viewerIds = await agentIdsOf(viewer.id);
      await factories.createDriveMember(drive.id, viewer.id, { role, acceptedAt: new Date() });
      if (role === 'GUEST') await factories.createPagePermission(shared.id, viewer.id);
      const session = await browserSession(viewer.id);

      expect(await (await getAs(session, drive.id)).json()).toEqual({ driveId: drive.id, enabled: true });
      expect((await putAs(session, drive.id, false)).status).toBe(200);
      expect(await storedChoice(viewer.id, drive.id)).toBe(false);
      expect(await membersIn(drive.id, viewerIds)).toEqual([]);
    }
    expect(await storedChoice(owner.id, drive.id)).toBeNull();
  });

  it('given a stranger, should return 403 on read and write and store nothing', async () => {
    const { user: owner } = await provisionedUser();
    const drive = await factories.createDrive(owner.id, { name: 'Guarded' });
    const { user: stranger } = await provisionedUser();
    await agentIdsOf(stranger.id);
    const session = await browserSession(stranger.id);

    expect((await getAs(session, drive.id)).status).toBe(403);
    expect((await putAs(session, drive.id, true)).status).toBe(403);
    expect((await putAs(session, drive.id, false)).status).toBe(403);
    expect(await storedChoice(stranger.id, drive.id)).toBeNull();
  });

  it('given a PUT without a CSRF token or with a forged one, should return 403 and change nothing', async () => {
    const { user } = await provisionedUser();
    const drive = await factories.createDrive(user.id, { name: 'Owned' });
    await agentIdsOf(user.id);
    const session = await browserSession(user.id);
    const other = await browserSession(user.id);

    expect((await putAs(session, drive.id, false, { csrf: null })).status).toBe(403);
    expect((await putAs(session, drive.id, false, { csrf: 'forged.token.value' })).status).toBe(403);
    // A real token bound to another session of the same user is still refused.
    expect((await putAs(session, drive.id, false, { csrf: other.csrf })).status).toBe(403);

    expect(await storedChoice(user.id, drive.id)).toBeNull();
  });

  it('given a PUT from a foreign origin with a valid CSRF token, should return 403 and change nothing', async () => {
    const { user } = await provisionedUser();
    const drive = await factories.createDrive(user.id, { name: 'Owned' });
    await agentIdsOf(user.id);
    const session = await browserSession(user.id);

    const response = await putAs(session, drive.id, false, { origin: 'https://evil.example' });

    expect(response.status).toBe(403);
    expect(await storedChoice(user.id, drive.id)).toBeNull();
  });

  it('given no session cookie, should return 401', async () => {
    const { user } = await provisionedUser();
    const drive = await factories.createDrive(user.id, { name: 'Owned' });

    const response = await GET(new Request(url(drive.id)), context(drive.id));

    expect(response.status).toBe(401);
  });

  it("given the viewer's own Home drive, should refuse: Imago lives there", async () => {
    const { user, home } = await provisionedUser();
    const ids = await agentIdsOf(user.id);
    const session = await browserSession(user.id);

    expect((await putAs(session, home.id, false)).status).toBe(403);
    expect(await storedChoice(user.id, home.id)).toBeNull();
    expect(await membersIn(home.id, ids)).toEqual(ids);
  });

  it('given a drive switched off, should keep it off when a deleted Imago is recreated at sign-in', async () => {
    const { user } = await provisionedUser();
    const off = await factories.createDrive(user.id, { name: 'Off' });
    const first = await provisionImagoAgents(user.id);
    const session = await browserSession(user.id);
    expect((await putAs(session, off.id, false)).status).toBe(200);

    await db.delete(pages).where(eq(pages.id, first.agents.imago));
    await provisionHomeDriveIfNeeded(user.id);
    const recreated = (await provisionImagoAgents(user.id)).agents.imago;

    expect(recreated).not.toBe(first.agents.imago);
    expect(await membersIn(off.id, [recreated])).toEqual([]);
    expect(await (await getAs(session, off.id)).json()).toMatchObject({ enabled: false });
  });
});
