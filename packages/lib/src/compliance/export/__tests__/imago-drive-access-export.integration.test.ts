/**
 * ART 15 for `imago_drive_access`, against a REAL Postgres.
 *
 * The per-drive Imago access choice is a setting the subject made, so it is
 * carried in the `settings` category: every row of theirs, and none of anyone
 * else's.
 *
 * Requires a live `DATABASE_URL` with migrations applied. It does NOT skip when
 * one is missing, following `agent-workspace-export.integration.test.ts`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { imagoDriveAccess } from '@pagespace/db/schema/imago-drive-access';
import { factories } from '@pagespace/db/test/factories';
import { collectUserSettings } from '../gdpr-export';

type DB = Parameters<typeof collectUserSettings>[0];
const database = db as unknown as DB;

const createdUsers: string[] = [];

afterAll(async () => {
  if (createdUsers.length > 0) await db.delete(users).where(inArray(users.id, createdUsers));
});

describe('collectUserSettings → imagoDriveAccess', () => {
  it("given the subject's stored choices and another user's, should export exactly the subject's", async () => {
    const subject = await factories.createUser();
    const other = await factories.createUser();
    createdUsers.push(subject.id, other.id);
    const off = await factories.createDrive(subject.id, { name: 'Off' });
    const on = await factories.createDrive(other.id, { name: 'Team' });
    await db.insert(imagoDriveAccess).values([
      { userId: subject.id, driveId: off.id, enabled: false },
      { userId: subject.id, driveId: on.id, enabled: true },
      { userId: other.id, driveId: on.id, enabled: false },
    ]);

    const settings = await collectUserSettings(database, subject.id);

    expect(settings.imagoDriveAccess.map(({ driveId, enabled }) => ({ driveId, enabled }))
      .sort((a, b) => a.driveId.localeCompare(b.driveId)))
      .toEqual([{ driveId: off.id, enabled: false }, { driveId: on.id, enabled: true }]
        .sort((a, b) => a.driveId.localeCompare(b.driveId)));
    expect(settings.imagoDriveAccess.every((row) => row.updatedAt instanceof Date)).toBe(true);
  });
});
