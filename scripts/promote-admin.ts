#!/usr/bin/env bun
import { getMigrationDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { eq } from '@pagespace/db/operators';
import { userEmailMatch } from '@pagespace/lib/auth/user-repository';

// One-shot ops script — runs on the unthrottled migration pool, not the
// app-throttled `db` (see getMigrationDb()'s doc comment in packages/db).
const db = getMigrationDb();

const email = process.argv[2];

if (!email) {
  console.error('Usage: bun run promote-admin <email>');
  process.exit(1);
}

async function promoteToAdmin() {
  try {
    const user = await db.query.users.findFirst({
      where: userEmailMatch(email),
    });

    if (!user) {
      console.error(`User with email ${email} not found`);
      process.exit(1);
    }

    if (user.role === 'admin') {
      console.log(`User ${email} is already an admin`);
      return;
    }

    await db.update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, user.id));

    console.log(`Successfully promoted ${email} to admin`);
  } catch (error) {
    console.error('Error promoting user to admin:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

promoteToAdmin();
