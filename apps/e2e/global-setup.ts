import fs from 'fs/promises';
import path from 'path';
import 'dotenv/config';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '../../packages/lib/src/auth/session-service';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const E2E_DIR = path.join(process.cwd(), 'apps/e2e');

function assertNotProduction(url: string): void {
  const { hostname } = new URL(url);
  const safeHosts = ['localhost', '127.0.0.1', 'postgres', 'db', '::1'];
  if (!safeHosts.includes(hostname)) {
    throw new Error(
      `ABORT: seed scripts must not run against a non-local database (host: ${hostname})`
    );
  }
}

export default async function globalSetup() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');
  assertNotProduction(dbUrl);

  const user = await factories.createUser();
  const drive = await factories.createDrive(user.id);
  const token = await sessionService.createSession({
    userId: user.id,
    type: 'user',
    scopes: [],
    expiresInMs: SESSION_TTL_MS,
  });

  await fs.writeFile(
    path.join(E2E_DIR, '.seed-state.json'),
    JSON.stringify({ userId: user.id, driveId: drive.id })
  );

  const storageState = {
    cookies: [
      {
        name: 'session',
        value: token,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Strict' as const,
        expires: Math.floor((Date.now() + SESSION_TTL_MS) / 1000),
      },
    ],
    origins: [],
  };
  await fs.writeFile(
    path.join(E2E_DIR, 'storageState.json'),
    JSON.stringify(storageState, null, 2)
  );

  console.log(`[e2e setup] Seeded user=${user.id} drive=${drive.id}`);
}
