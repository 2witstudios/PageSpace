/**
 * GET /api/user/builtin-agents against a REAL Postgres — real session tokens
 * minted by the session service and sent as the browser's session cookie,
 * real Imago provisioning, no mocks of auth or the database.
 *
 * What only a real database can show: that the route answers with the pages
 * provisioning actually created, that two users' pointers never cross, that
 * an unprovisioned user gets nulls without the GET writing anything, and that
 * a revoked session is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { BUILTIN_AGENTS } from '@pagespace/lib/agents/builtin-agents';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { COOKIE_CONFIG } from '@/lib/auth/cookie-config';
import { ensureTestDb } from '@/test/ensure-test-db';
import { GET } from '../route';

const seededUserIds: string[] = [];

async function provisionedUser() {
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  const { agents } = await provisionImagoAgents(user.id);
  return { user, agents };
}

async function bareUser() {
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  return user;
}

async function sessionFor(userId: string) {
  return sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 });
}

function requestAs(token: string | null, query = '', headers: Record<string, string> = {}) {
  const cookie: Record<string, string> = token ? { cookie: `${COOKIE_CONFIG.session.name}=${token}` } : {};
  return new Request(`http://localhost/api/user/builtin-agents${query}`, { headers: { ...cookie, ...headers } });
}

async function agentsOf(response: Response) {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { agents: Array<{ key: string; pageId: string | null; title: string }> };
  return body.agents;
}

beforeAll(async () => {
  await ensureTestDb();
});

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

describe('GET /api/user/builtin-agents (integration)', () => {
  it("given a provisioned viewer, should return the pages provisioning created, titled from the registry", async () => {
    const { user, agents } = await provisionedUser();

    const result = await agentsOf(await GET(requestAs(await sessionFor(user.id))));

    expect(result).toEqual(
      BUILTIN_AGENTS.map((agent) => ({ key: agent.key, pageId: agents[agent.key], title: agent.title })),
    );
  });

  it("given another user's id anywhere in the request, should still return only the viewer's own pointers", async () => {
    const viewer = await provisionedUser();
    const other = await provisionedUser();
    const token = await sessionFor(viewer.user.id);

    const result = await agentsOf(
      await GET(requestAs(token, `?userId=${other.user.id}&id=${other.user.id}`, { 'x-user-id': other.user.id })),
    );

    const otherPageIds = Object.values(other.agents);
    expect(result.map((agent) => agent.pageId)).toEqual(BUILTIN_AGENTS.map((agent) => viewer.agents[agent.key]));
    expect(result.some((agent) => agent.pageId !== null && otherPageIds.includes(agent.pageId))).toBe(false);
  });

  it('given an unprovisioned viewer, should return nulls and write nothing', async () => {
    const user = await bareUser();

    const result = await agentsOf(await GET(requestAs(await sessionFor(user.id))));

    expect(result).toEqual(BUILTIN_AGENTS.map((agent) => ({ key: agent.key, pageId: null, title: agent.title })));
    expect(await db.select().from(userBuiltinAgents).where(eq(userBuiltinAgents.userId, user.id))).toEqual([]);
    expect(await db.select({ id: drives.id }).from(drives).where(eq(drives.ownerId, user.id))).toEqual([]);
  });

  it('given a trashed agent page, should report that key as not provisioned', async () => {
    const { user, agents } = await provisionedUser();
    await db.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(eq(pages.id, agents.imago));

    const result = await agentsOf(await GET(requestAs(await sessionFor(user.id))));

    expect(result).toEqual([{ key: 'imago', pageId: null, title: 'Imago' }]);
  });

  it('given no session cookie, should return 401', async () => {
    const response = await GET(requestAs(null));

    expect(response.status).toBe(401);
  });

  it('given a revoked session, should return 401', async () => {
    const { user } = await provisionedUser();
    const token = await sessionFor(user.id);
    await sessionService.revokeAllUserSessions(user.id, 'test');

    const response = await GET(requestAs(token));

    expect(response.status).toBe(401);
  });
});
