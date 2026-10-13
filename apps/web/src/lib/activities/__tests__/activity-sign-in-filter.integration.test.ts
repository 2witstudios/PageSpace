// @vitest-environment node
/**
 * SEC-2/3 (D-OW-45, D-OW-62) for the activity feed and its CSV export, against PostgreSQL: a row on an org drive whose
 * sign-in policy refuses the credential, or on a memory page whose contributing org withholds it, is left out — with
 * its content snapshot — of GET /api/activities (user and drive context) and /api/activities/export, and the count
 * matches what is returned. A credential that satisfies the policy reads every row. Real sessions, real routes.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { provisionMemoryPages } from '@pagespace/lib/memory/memory-pages';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';

import { GET as listActivities } from '@/app/api/activities/route';
import { GET as exportActivities } from '@/app/api/activities/export/route';
import { recordMemoryOrgIds } from '@/lib/memory/candidate-service';

const MINUTE = 60_000;
const created = { users: [] as string[], orgs: [] as string[] };

const session = (userId: string, assurance: VerifiedAuthentication['assurance']) =>
  sessionService.createSession({
    userId, type: 'user', scopes: ['*'], expiresInMs: 60 * MINUTE, authentication: { authenticatedAtMs: Date.now() - 1000, assurance },
  });

/**
 * A person with an org drive under requireStrongSignIn, a Home drive whose memory restates that org, and one activity
 * row each on an org page, a memory page and an ordinary personal page.
 */
async function world() {
  const user = await factories.createUser();
  created.users.push(user.id);
  const [org] = await db.insert(organizations).values({
    name: 'Northwind', slug: `nw-${createId()}`, ownerId: user.id, policies: { requireStrongSignIn: true },
  }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: 'OWNER' });
  const orgDrive = await factories.createDrive(user.id, { orgId: org.id, orgVisibility: 'OPEN' });
  const orgPage = await factories.createPage(orgDrive.id, { title: 'Board plan' });

  const home = await factories.createDrive(user.id);
  const memory = await db.transaction((tx) => provisionMemoryPages(user.id, home.id, tx));
  await recordMemoryOrgIds(user.id, [org.id]);
  const notes = await factories.createPage(home.id, { title: 'Grocery list' });

  const row = (driveId: string, pageId: string, title: string, snapshot: string) => ({
    userId: user.id, actorEmail: user.email ?? 'x@example.com', operation: 'update', resourceType: 'page' as const,
    resourceId: pageId, resourceTitle: title, driveId, pageId, contentSnapshot: snapshot,
  });
  await db.insert(activityLogs).values([
    row(orgDrive.id, orgPage.id, 'ORG-TITLE', 'ORG-SNAPSHOT'),
    row(home.id, memory.rulesPageId, 'MEMORY-TITLE', 'MEMORY-SNAPSHOT'),
    row(home.id, notes.id, 'PERSONAL-TITLE', 'PERSONAL-SNAPSHOT'),
  ]);
  return { user, home };
}

type Listed = { activities: Array<{ contentSnapshot: string | null }>; pagination: { total: number } };

async function list(token: string, query: string): Promise<Listed> {
  const res = await listActivities(new Request(`https://app.test/api/activities?${query}`, { headers: { authorization: `Bearer ${token}` } }));
  expect(res.status).toBe(200);
  return await res.json() as Listed;
}

async function exportCsv(token: string, query: string): Promise<string> {
  const res = await exportActivities(new Request(`https://app.test/api/activities/export?${query}`, { headers: { authorization: `Bearer ${token}` } }));
  expect(res.status).toBe(200);
  return await res.text();
}

const snapshots = (listed: Listed) => listed.activities.map((a) => a.contentSnapshot).sort();

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration suite');
});

afterEach(async () => {
  if (created.users.length) await db.delete(activityLogs).where(inArray(activityLogs.userId, created.users));
  if (created.orgs.length) await db.delete(drives).where(inArray(drives.orgId, created.orgs));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs.splice(0)));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users.splice(0)));
});

describe('the activity feed and export under org sign-in policy', () => {
  it('SEC-2 (partial) a single-factor session sees neither the org drive\'s rows nor the memory page\'s, in user or Home-drive context or the export; counts match', async () => {
    const { user, home } = await world();
    const weak = await session(user.id, 'single_factor');

    const mine = await list(weak, 'context=user');
    expect(snapshots(mine)).toEqual(['PERSONAL-SNAPSHOT']);
    expect(mine.pagination.total).toBe(1);

    const homeDrive = await list(weak, `context=drive&driveId=${home.id}`);
    expect(snapshots(homeDrive)).toEqual(['PERSONAL-SNAPSHOT']);
    expect(homeDrive.pagination.total).toBe(1);

    const csv = await exportCsv(weak, 'context=user');
    expect(csv).toContain('PERSONAL-TITLE');
    expect(csv).not.toContain('ORG-TITLE');
    expect(csv).not.toContain('MEMORY-TITLE');
  });

  it('SEC-2 (partial) a passkey session reads every row', async () => {
    const { user, home } = await world();
    const strong = await session(user.id, 'user_verified_passkey');

    expect(snapshots(await list(strong, 'context=user'))).toEqual(['MEMORY-SNAPSHOT', 'ORG-SNAPSHOT', 'PERSONAL-SNAPSHOT']);
    expect(snapshots(await list(strong, `context=drive&driveId=${home.id}`))).toEqual(['MEMORY-SNAPSHOT', 'PERSONAL-SNAPSHOT']);
    const csv = await exportCsv(strong, 'context=user');
    for (const title of ['ORG-TITLE', 'MEMORY-TITLE', 'PERSONAL-TITLE']) expect(csv).toContain(title);
  });
});
