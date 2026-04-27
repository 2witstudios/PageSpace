#!/usr/bin/env tsx
import fs from 'fs/promises';
import path from 'path';
import 'dotenv/config';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '../../../packages/lib/src/auth/session-service';

const AUTH_FILE = path.join(process.cwd(), '.k6-auth.json');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function assertNotProduction(url: string): void {
  const { hostname } = new URL(url);
  const safeHosts = ['localhost', '127.0.0.1', 'postgres', 'db', '::1'];
  if (!safeHosts.includes(hostname)) {
    throw new Error(
      `ABORT: seed scripts must not run against a non-local database (host: ${hostname})`
    );
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');
  assertNotProduction(dbUrl);

  const user = await factories.createUser();
  const drive = await factories.createDrive(user.id);
  const sessionToken = await sessionService.createSession({
    userId: user.id,
    type: 'user',
    scopes: [],
    expiresInMs: SESSION_TTL_MS,
  });

  await fs.writeFile(AUTH_FILE, JSON.stringify({ sessionToken, userId: user.id, driveId: drive.id }, null, 2));
  console.log(`[k6 seed] user=${user.id} drive=${drive.id} → .k6-auth.json`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
