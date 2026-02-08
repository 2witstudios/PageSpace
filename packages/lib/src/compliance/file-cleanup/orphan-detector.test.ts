import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, users, files, filePages } from '@pagespace/db';
import { channelMessages } from '@pagespace/db';
import { drives, pages } from '@pagespace/db';
import { eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import {
  findOrphanedFileRecords,
  isFileOrphaned,
  deleteFileRecords,
} from './orphan-detector';

let testUserId: string;
let testDriveId: string;

beforeEach(async () => {
  const [user] = await db.insert(users).values({
    id: createId(),
    name: 'Orphan Test User',
    email: `orphan-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'hashed_password',
    provider: 'email',
    role: 'user',
    tokenVersion: 1,
  }).returning();
  testUserId = user.id;

  const [drive] = await db.insert(drives).values({
    id: createId(),
    name: 'Orphan Test Drive',
    slug: `orphan-test-${Date.now()}`,
    ownerId: testUserId,
    updatedAt: new Date(),
  }).returning();
  testDriveId = drive.id;
});

afterEach(async () => {
  await db.delete(drives).where(eq(drives.id, testDriveId));
  await db.delete(users).where(eq(users.id, testUserId));
});

describe('findOrphanedFileRecords', () => {
  it('identifies a file with zero references as orphaned', async () => {
    const fileId = createId();
    await db.insert(files).values({
      id: fileId,
      driveId: testDriveId,
      sizeBytes: 1024,
      mimeType: 'text/plain',
      storagePath: `/storage/${fileId}/original`,
      createdBy: testUserId,
    });

    const orphans = await findOrphanedFileRecords(db as Parameters<typeof findOrphanedFileRecords>[0]);
    const found = orphans.find(o => o.id === fileId);

    expect(found).toBeTruthy();
    expect(found!.id).toBe(fileId);

    // cleanup
    await db.delete(files).where(eq(files.id, fileId));
  });

  it('does not identify a file referenced by filePages as orphaned', async () => {
    const fileId = createId();
    await db.insert(files).values({
      id: fileId,
      driveId: testDriveId,
      sizeBytes: 1024,
      mimeType: 'text/plain',
      storagePath: `/storage/${fileId}/original`,
      createdBy: testUserId,
    });

    const [page] = await db.insert(pages).values({
      id: createId(),
      title: 'Test Page',
      type: 'DOCUMENT',
      driveId: testDriveId,
      position: 0,
      updatedAt: new Date(),
    }).returning();

    await db.insert(filePages).values({
      fileId,
      pageId: page.id,
      linkedBy: testUserId,
    });

    const orphans = await findOrphanedFileRecords(db as Parameters<typeof findOrphanedFileRecords>[0]);
    const found = orphans.find(o => o.id === fileId);

    expect(found).toBeUndefined();

    // cleanup
    await db.delete(filePages).where(eq(filePages.fileId, fileId));
    await db.delete(pages).where(eq(pages.id, page.id));
    await db.delete(files).where(eq(files.id, fileId));
  });

  it('does not identify a file referenced by channelMessages as orphaned', async () => {
    const fileId = createId();
    await db.insert(files).values({
      id: fileId,
      driveId: testDriveId,
      sizeBytes: 1024,
      mimeType: 'text/plain',
      storagePath: `/storage/${fileId}/original`,
      createdBy: testUserId,
    });

    const [channel] = await db.insert(pages).values({
      id: createId(),
      title: 'Test Channel',
      type: 'CHANNEL',
      driveId: testDriveId,
      position: 0,
      updatedAt: new Date(),
    }).returning();

    await db.insert(channelMessages).values({
      id: createId(),
      content: 'Test message',
      pageId: channel.id,
      userId: testUserId,
      fileId,
    });

    const orphans = await findOrphanedFileRecords(db as Parameters<typeof findOrphanedFileRecords>[0]);
    const found = orphans.find(o => o.id === fileId);

    expect(found).toBeUndefined();

    // cleanup
    await db.delete(channelMessages).where(eq(channelMessages.fileId, fileId));
    await db.delete(pages).where(eq(pages.id, channel.id));
    await db.delete(files).where(eq(files.id, fileId));
  });
});

describe('isFileOrphaned', () => {
  it('returns true for an unreferenced file', async () => {
    const fileId = createId();
    await db.insert(files).values({
      id: fileId,
      driveId: testDriveId,
      sizeBytes: 512,
      mimeType: 'text/plain',
      storagePath: `/storage/${fileId}/original`,
      createdBy: testUserId,
    });

    const orphaned = await isFileOrphaned(db as Parameters<typeof isFileOrphaned>[0], fileId);

    expect(orphaned).toBe(true);

    // cleanup
    await db.delete(files).where(eq(files.id, fileId));
  });

  it('returns false for a referenced file', async () => {
    const fileId = createId();
    await db.insert(files).values({
      id: fileId,
      driveId: testDriveId,
      sizeBytes: 512,
      mimeType: 'text/plain',
      storagePath: `/storage/${fileId}/original`,
      createdBy: testUserId,
    });

    const [page] = await db.insert(pages).values({
      id: createId(),
      title: 'Referenced Page',
      type: 'DOCUMENT',
      driveId: testDriveId,
      position: 0,
      updatedAt: new Date(),
    }).returning();

    await db.insert(filePages).values({
      fileId,
      pageId: page.id,
      linkedBy: testUserId,
    });

    const orphaned = await isFileOrphaned(db as Parameters<typeof isFileOrphaned>[0], fileId);

    expect(orphaned).toBe(false);

    // cleanup
    await db.delete(filePages).where(eq(filePages.fileId, fileId));
    await db.delete(pages).where(eq(pages.id, page.id));
    await db.delete(files).where(eq(files.id, fileId));
  });
});

describe('deleteFileRecords', () => {
  it('deletes specified file records and returns count', async () => {
    const fileId1 = createId();
    const fileId2 = createId();

    await db.insert(files).values([
      { id: fileId1, driveId: testDriveId, sizeBytes: 100, createdBy: testUserId },
      { id: fileId2, driveId: testDriveId, sizeBytes: 200, createdBy: testUserId },
    ]);

    const deleted = await deleteFileRecords(
      db as Parameters<typeof deleteFileRecords>[0],
      [fileId1, fileId2]
    );

    expect(deleted).toBe(2);
  });

  it('returns 0 for empty array', async () => {
    const deleted = await deleteFileRecords(
      db as Parameters<typeof deleteFileRecords>[0],
      []
    );

    expect(deleted).toBe(0);
  });
});
