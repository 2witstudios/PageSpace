/**
 * The /api/storage/info breakdown's rows — REAL Postgres (Spec WAL-9 (partial), #2719 review P2-1).
 *
 * A file uploaded into an org drive bills the org (its usage is derived from its drives), so it
 * is not on the uploader's personal quota. The breakdown must list exactly the files the
 * personal quota counts, or the user sees bytes that are not the ones that block their upload
 * (storage-info-core.ts). This runs the actual SQL and holds it to the charge basis,
 * calculateActualStorageUsage.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied. FAILS LOUDLY when no DB is
 * reachable; local runs without one opt out explicitly with ALLOW_SKIP_DB_TESTS=1.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { files } from '@pagespace/db/schema/storage';
import { organizations } from '@pagespace/db/schema/organizations';
import { requireDb } from '@pagespace/db/test/require-db';
import { calculateActualStorageUsage } from '@pagespace/lib/services/storage-limits';
import { findUserFileRows } from '../storage-info-repository';

const run = createId().slice(0, 8);
const lena = createId();
const northwind = createId();

let dbAvailable = false;

async function seedDrive(orgId: string | null) {
  const id = createId();
  await db.insert(drives).values({
    id,
    name: orgId ? 'Northwind Product' : 'Lena personal',
    slug: `drive-${run}-${id.slice(0, 6)}`,
    ownerId: lena,
    orgId,
    publishSubdomain: `drive-${id}`,
    updatedAt: new Date(),
  });
  return id;
}

async function seedFile(driveId: string | null, sizeBytes: number) {
  const id = createId();
  await db.insert(files).values({ id, driveId, createdBy: lena, sizeBytes, storagePath: id });
  return id;
}

/** Deletes only the rows this file creates, children first. */
async function cleanup() {
  await db.delete(files).where(eq(files.createdBy, lena));
  const owned = await db.select({ id: drives.id }).from(drives).where(eq(drives.ownerId, lena));
  if (owned.length > 0) await db.delete(drives).where(inArray(drives.id, owned.map((d) => d.id)));
  await db.delete(organizations).where(eq(organizations.id, northwind));
  await db.delete(users).where(eq(users.id, lena));
}

describe('WAL-9 (partial) the storage-info breakdown lists only personally attributed files', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: users.id }).from(users).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('storage-info-repository.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    await cleanup();
    await db.insert(users).values({ id: lena, email: `lena-${run}@northwind.test`, name: 'Lena Schulz', updatedAt: new Date() });
    await db.insert(organizations).values({ id: northwind, name: 'Northwind Labs', slug: `northwind-${run}`, ownerId: lena });
  });

  afterAll(async () => {
    if (dbAvailable) await cleanup();
  });

  it('leaves an org-drive file out of the personal breakdown, and keeps personal-drive and drive-less files', async () => {
    if (!dbAvailable) return;
    const personalDrive = await seedDrive(null);
    const orgDrive = await seedDrive(northwind);
    const personalFile = await seedFile(personalDrive, 1_000);
    const orgFile = await seedFile(orgDrive, 700_000);
    const dmFile = await seedFile(null, 30);

    const rows = await findUserFileRows(lena);
    const ids = rows.map((r) => r.fileId);

    expect(ids).not.toContain(orgFile);
    expect(ids.sort()).toEqual([personalFile, dmFile].sort());
  });

  it('sums to exactly the bytes the personal quota is charged for', async () => {
    if (!dbAvailable) return;
    const personalDrive = await seedDrive(null);
    const orgDrive = await seedDrive(northwind);
    await seedFile(personalDrive, 1_000);
    await seedFile(orgDrive, 700_000);
    await seedFile(null, 30);

    const rows = await findUserFileRows(lena);
    const breakdownBytes = rows.reduce((sum, r) => sum + r.sizeBytes, 0);

    expect(breakdownBytes).toBe(1_030);
    expect(breakdownBytes).toBe(await calculateActualStorageUsage(lena));
  });
});
