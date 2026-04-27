#!/usr/bin/env tsx
import fs from 'fs/promises';
import path from 'path';
import 'dotenv/config';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';

const AUTH_FILE = path.join(process.cwd(), '.k6-auth.json');

async function main() {
  let userId: string;
  try {
    const raw = await fs.readFile(AUTH_FILE, 'utf-8');
    ({ userId } = JSON.parse(raw));
  } catch {
    console.warn('[k6 cleanup] No .k6-auth.json — nothing to clean up');
    return;
  }

  // Cascade: sessions, drives, pages all cascade from users
  await db.delete(users).where(eq(users.id, userId));
  await fs.rm(AUTH_FILE, { force: true });
  console.log(`[k6 cleanup] Deleted user=${userId}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
