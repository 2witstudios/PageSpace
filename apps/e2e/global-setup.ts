import fs from 'fs/promises';
import path from 'path';
import 'dotenv/config';
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '../../packages/lib/src/auth/session-service';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Resolved from THIS file's location, not the cwd. The cwd-based form
// (`path.join(process.cwd(), 'apps/e2e')`) only agreed with the reader
// (`fixtures/seed-state.ts`, which is already `__dirname`-relative) when the runner happened
// to be invoked from the repo root — so the documented command,
// `bun run --filter '@pagespace/e2e' test:e2e`, ran with cwd=apps/e2e, wrote to
// apps/e2e/apps/e2e/, and died on ENOENT before a single test. Location-relative works from
// any cwd and matches the reader by construction.
const E2E_DIR = __dirname;
const DEFAULT_BASE_URL = 'http://localhost:3000';

function assertNotProduction(url: string): void {
  const { hostname } = new URL(url);
  const safeHosts = ['localhost', '127.0.0.1', 'postgres', 'db', '::1'];
  if (!safeHosts.includes(hostname)) {
    throw new Error(
      `ABORT: seed scripts must not run against a non-local database (host: ${hostname})`
    );
  }
}

function getBaseUrl(): URL {
  return new URL(
    process.env.E2E_BASE_URL ??
      process.env.PLAYWRIGHT_BASE_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      process.env.WEB_APP_URL ??
      DEFAULT_BASE_URL
  );
}

export default async function globalSetup() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');
  assertNotProduction(dbUrl);
  const baseUrl = getBaseUrl();

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
        domain: baseUrl.hostname,
        path: '/',
        httpOnly: true,
        secure: baseUrl.protocol === 'https:',
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
