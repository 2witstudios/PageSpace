import fs from 'fs/promises';
import path from 'path';
import 'dotenv/config';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { sessions } from '@pagespace/db/schema/sessions';
import { collectSeedUserIds } from './support/teardown-plan';
import type { SeedState } from './fixtures/seed-state';

// Location-relative, matching global-setup.ts — see the note there. A cwd-based path made
// teardown silently skip cleanup ("No .seed-state.json — nothing to clean up") whenever the
// runner was invoked from anywhere but the repo root, leaking the seeded user and its drive.
const E2E_DIR = __dirname;
const STATE_FILE = path.join(E2E_DIR, '.seed-state.json');
const STORAGE_STATE_FILE = path.join(E2E_DIR, 'storageState.json');

export default async function globalTeardown() {
  let state: SeedState;
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    state = JSON.parse(raw);
  } catch {
    console.warn('[e2e teardown] No .seed-state.json — nothing to clean up');
    return;
  }

  // Includes every Northwind Labs user (eight, when global-setup seeded the fixture) alongside
  // the top-level seed user — see support/teardown-plan.ts. Every Northwind drive cascades from
  // one of these users (drives.ownerId is onDelete: 'cascade'), same as the top-level drive.
  const userIds = collectSeedUserIds(state);

  // Cascade: sessions, driveMembers, pages all cascade from users
  await db.delete(users).where(inArray(users.id, userIds));

  const [orphanedDrives, orphanedSessions] = await Promise.all([
    db.select({ id: drives.id }).from(drives).where(inArray(drives.ownerId, userIds)),
    db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.userId, userIds)),
  ]);

  if (orphanedDrives.length > 0 || orphanedSessions.length > 0) {
    throw new Error(
      `[e2e teardown] Orphaned rows after deleting users ${userIds.join(', ')}: ` +
        `${orphanedDrives.length} drives, ${orphanedSessions.length} sessions`
    );
  }

  await Promise.all([
    fs.rm(STATE_FILE, { force: true }),
    fs.rm(STORAGE_STATE_FILE, { force: true }),
  ]);

  console.log(`[e2e teardown] Cleaned up ${userIds.length} user(s): ${userIds.join(', ')}`);
}
