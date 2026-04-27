import fs from 'fs/promises';
import path from 'path';
import 'dotenv/config';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { sessions } from '@pagespace/db/schema/sessions';

const E2E_DIR = path.join(process.cwd(), 'apps/e2e');
const STATE_FILE = path.join(E2E_DIR, '.seed-state.json');
const STORAGE_STATE_FILE = path.join(E2E_DIR, 'storageState.json');

export default async function globalTeardown() {
  let userId: string;
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    ({ userId } = JSON.parse(raw));
  } catch {
    console.warn('[e2e teardown] No .seed-state.json — nothing to clean up');
    return;
  }

  // Cascade: sessions, driveMembers, pages all cascade from users
  await db.delete(users).where(eq(users.id, userId));

  const [orphanedDrives, orphanedSessions] = await Promise.all([
    db.select({ id: drives.id }).from(drives).where(eq(drives.ownerId, userId)),
    db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId)),
  ]);

  if (orphanedDrives.length > 0 || orphanedSessions.length > 0) {
    throw new Error(
      `[e2e teardown] Orphaned rows after deleting user ${userId}: ` +
        `${orphanedDrives.length} drives, ${orphanedSessions.length} sessions`
    );
  }

  await Promise.all([
    fs.rm(STATE_FILE, { force: true }),
    fs.rm(STORAGE_STATE_FILE, { force: true }),
  ]);

  console.log(`[e2e teardown] Cleaned up user=${userId}`);
}
