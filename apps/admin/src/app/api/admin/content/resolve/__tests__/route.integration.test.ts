/**
 * The resolve route against REAL Postgres, with the real target resolver and
 * case store: nothing between the URL the admin pastes and the JSON they get
 * back is mocked except who is signed in and where the audit event goes.
 *
 * The unit test beside this one mocks `resolveTakedownTarget`, so it can only
 * show that the route does not ADD the URL. This shows the URL never comes
 * back at all: it resolves to a page or drive ID, and neither the response nor
 * the audit event carries the host, the path or any URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { contentCases } from '@pagespace/db/schema/content-safety';
import { drives } from '@pagespace/db/schema/core';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: (handler: (admin: { id: string }, req: Request) => Promise<Response>) =>
    (req: Request) => handler({ id: 'admin-1' }, req),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { GET } from '../route';

const HASH = createHash('sha256').update(randomUUID()).digest('hex');
const tag = createId().slice(0, 6).toLowerCase();
const SITE = `rs-${tag}`;
const DOMAIN = `photos-${tag}.example.test`;
const PATH_SEGMENT = `holiday-${tag}`;

let userId: string;
let driveId: string;
let pageId: string;
let caseId: string;

const resolve = async (q: string) => {
  vi.mocked(auditRequest).mockClear();
  const res = await GET(new Request(`http://localhost/api/admin/content/resolve?q=${encodeURIComponent(q)}`));
  return { res, body: await res.json(), audit: vi.mocked(auditRequest).mock.calls[0]?.[1] };
};

/** Anything that would lead back to the site, the page or the file. */
const leaks = (value: unknown) =>
  JSON.stringify(value).match(new RegExp(`https?:|${SITE}|${DOMAIN.replace(/\./g, '\\.')}|${PATH_SEGMENT}|pagespace\\.site|example\\.test`, 'i'));

describe('GET /api/admin/content/resolve — real resolver, real Postgres', () => {
  beforeAll(async () => {
    try {
      userId = (await factories.createUser()).id;
    } catch (error) {
      requireDb('resolve route.integration.test.ts', error);
      throw error;
    }
    driveId = (await factories.createDrive(userId)).id;
    await db.update(drives).set({ publishSubdomain: SITE }).where(eq(drives.id, driveId));
    await db.insert(customDomains).values({ driveId, hostname: DOMAIN, status: 'active' });
    pageId = (await factories.createPage(driveId, { type: 'FILE', filePath: HASH, contentHash: HASH, mimeType: 'image/jpeg', createdBy: userId })).id;
    await db.insert(publishedPages).values({
      driveId,
      pageId,
      path: `album/${PATH_SEGMENT}`,
      artifactKey: `published/${SITE}/album/${PATH_SEGMENT}/index.html`,
      updatedAt: new Date(),
    });
    const [row] = await db
      .insert(contentCases)
      .values({ targetType: 'page', targetId: pageId, category: 'policy', reason: 'reported', status: 'open', snapshot: {}, steps: [] })
      .returning({ id: contentCases.id });
    caseId = row.id;
  });

  afterAll(async () => {
    if (caseId) await db.delete(contentCases).where(inArray(contentCases.id, [caseId]));
    if (driveId) await db.delete(drives).where(eq(drives.id, driveId));
    if (userId) await db.delete(users).where(eq(users.id, userId));
    await pool.end();
  });

  it.each([
    ['its subdomain', () => `https://${SITE}.pagespace.site/Album/${PATH_SEGMENT}/`],
    ['a custom domain', () => `https://${DOMAIN}/album/${PATH_SEGMENT}`],
  ])('resolves a published page URL on %s to the page ID, and returns no part of the URL', async (_label, url) => {
    const { res, body, audit } = await resolve(url());

    expect(res.status).toBe(200);
    expect(body.target).toMatchObject({ targetType: 'page', targetId: pageId, contentHash: HASH, page: { id: pageId }, drive: { id: driveId } });
    expect(body.cases.map((c: { id: string }) => c.id)).toEqual([caseId]);
    expect(leaks(body)).toBeNull();
    expect(audit).toMatchObject({ resourceType: 'page', resourceId: pageId });
    expect(leaks(audit)).toBeNull();
  });

  it('resolves a published URL with no matching page to the drive ID, and returns no part of the URL', async () => {
    const { res, body, audit } = await resolve(`https://${SITE}.pagespace.site/not/${PATH_SEGMENT}`);

    expect(res.status).toBe(200);
    expect(body.target).toMatchObject({ targetType: 'drive', targetId: driveId, page: null });
    expect(leaks(body)).toBeNull();
    expect(audit).toMatchObject({ resourceType: 'drive', resourceId: driveId });
    expect(leaks(audit)).toBeNull();
  });

  it('answers 404 for a URL on a host nobody publishes to, and audits no part of it', async () => {
    const { res, body, audit } = await resolve(`https://nobody-${tag}.example.test/${PATH_SEGMENT}`);

    expect(res.status).toBe(404);
    expect(leaks(body)).toBeNull();
    expect(audit).toMatchObject({ resourceId: 'not_found' });
    expect(leaks(audit)).toBeNull();
  });
});
