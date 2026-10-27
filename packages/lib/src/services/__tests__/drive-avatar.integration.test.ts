/**
 * Drive avatars and colors against a real Postgres: the row lock setDriveAvatar takes and the
 * CHECK constraints (drives_avatar_url_chk, drives_color_chk) a pure test cannot see.
 *
 * Locally:
 *   DATABASE_URL=... bunx vitest run --config vitest.integration.config.ts src/services/__tests__/drive-avatar.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { avatarPath, MARK_COLORS } from '../../avatars/avatar-core';
import { setDriveAvatar } from '../drive-service';

const created = { users: [] as string[], drives: [] as string[] };

beforeAll(async () => {
  try {
    await db.select({ id: drives.id }).from(drives).limit(1);
  } catch (error) {
    requireDb('drive-avatar.integration.test.ts', error);
  }
});

afterEach(async () => {
  const driveIds = created.drives.splice(0);
  const userIds = created.users.splice(0);
  if (driveIds.length) await db.delete(drives).where(inArray(drives.id, driveIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
});

async function seedDrive() {
  const owner = await factories.createUser({ email: `drive-avatar-${createId()}@example.test` });
  created.users.push(owner.id);
  const drive = await factories.createDrive(owner.id);
  created.drives.push(drive.id);
  return drive;
}

const storedAvatar = async (driveId: string) =>
  (await db.select({ avatarUrl: drives.avatarUrl }).from(drives).where(eq(drives.id, driveId)))[0]?.avatarUrl;

describe('setDriveAvatar (real Postgres)', () => {
  it('given this drive\'s own avatar path, should store it and answer the path it replaced; anything else is refused by the service and by the database', async () => {
    const drive = await seedDrive();
    const first = avatarPath('drive', drive.id, 'avatar-first1.png');
    expect(await setDriveAvatar(drive.id, first)).toMatchObject({ ok: true, drive: { avatarUrl: first }, previousAvatarUrl: null });

    for (const outside of ['https://tracker.example.com/pixel.png', avatarPath('drive', 'drive_someone_else', 'avatar-first1.png')]) {
      expect(await setDriveAvatar(drive.id, outside)).toEqual({ ok: false, reason: 'invalid_avatar' });
      await expect(db.update(drives).set({ avatarUrl: outside }).where(eq(drives.id, drive.id))).rejects.toThrow();
    }
    expect(await storedAvatar(drive.id)).toBe(first);

    expect(await setDriveAvatar(drive.id, null)).toMatchObject({ ok: true, drive: { avatarUrl: null }, previousAvatarUrl: first });
  });

  it('given a drive that does not exist, should answer not_found', async () => {
    const id = createId();
    expect(await setDriveAvatar(id, avatarPath('drive', id, 'avatar-x1.png'))).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given concurrent switches, should have each replace a distinct path, so every replaced file is deleted exactly once and the stored one never is', async () => {
    const drive = await seedDrive();
    const initial = avatarPath('drive', drive.id, 'avatar-initial.png');
    await setDriveAvatar(drive.id, initial);
    const uploads = ['a', 'b', 'c', 'd'].map((n) => avatarPath('drive', drive.id, `avatar-${n}${createId().slice(0, 6)}.png`));

    const results = await Promise.all(uploads.map((path) => setDriveAvatar(drive.id, path)));

    const replaced = results.map((r) => (r.ok ? r.previousAvatarUrl : 'refused'));
    const stored = await storedAvatar(drive.id);
    expect([...replaced, stored].sort()).toEqual([initial, ...uploads].sort());
    expect(replaced).not.toContain(stored);
  });
});

describe('drives.color (real Postgres)', () => {
  it('given a palette key or null, should store it; anything else is refused by the database', async () => {
    const drive = await seedDrive();
    for (const color of [...MARK_COLORS, null]) {
      await db.update(drives).set({ color }).where(eq(drives.id, drive.id));
    }
    for (const color of ['#ff0000', 'Teal', '']) {
      await expect(db.update(drives).set({ color }).where(eq(drives.id, drive.id))).rejects.toThrow();
    }
  });
});
