/**
 * Integration tests for the bulk test factories (createUsers, createDriveMembers).
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   bun run --filter '@pagespace/db' test:integration -- src/__tests__/factories-bulk.integration.test.ts
 *
 * They exist so suites that need hundreds of rows seed them in a few multi-row
 * INSERTs instead of hundreds of round trips; a chunking bug would silently
 * seed fewer rows than asked, and the suite using them would then prove less
 * than it claims. 501 rows crosses the 500-row chunk boundary.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { factories } from '../test/factories';
import { db } from '../db';
import { eq, inArray, count } from 'drizzle-orm';
import { users } from '../schema/auth';
import { driveMembers } from '../schema/members';

const seededUserIds: string[] = [];

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

describe('bulk test factories', () => {
  it('creates every requested user and membership across chunk boundaries', async () => {
    const owner = await factories.createUser();
    seededUserIds.push(owner.id);
    const drive = await factories.createDrive(owner.id);

    const created = await factories.createUsers(501);
    seededUserIds.push(...created.map((u) => u.id));
    const members = await factories.createDriveMembers(drive.id, created.map((u) => u.id));

    expect(new Set(created.map((u) => u.id)).size).toBe(501);
    expect(members).toHaveLength(501);
    const [{ n }] = await db
      .select({ n: count() })
      .from(driveMembers)
      .where(eq(driveMembers.driveId, drive.id));
    expect(n).toBe(501);
    expect(members.every((m) => m.acceptedAt !== null && m.role === 'MEMBER')).toBe(true);
  });
});
