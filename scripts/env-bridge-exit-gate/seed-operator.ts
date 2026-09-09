/**
 * Seeds the one thing the gate cannot mint for itself: an authenticated operator.
 *
 * Onprem has no password route under `/api/auth`, so a script cannot log in.
 * This mints a user, a drive they own, and a `type:'user'` session, and prints
 * the cookie plus the ids the runbook's steps need. Same shape as
 * `apps/e2e/global-setup.ts`. It lives INSIDE the repo because bun will not
 * resolve `@pagespace/db` from outside it.
 *
 *   DATABASE_URL=… TZ=UTC bun scripts/env-bridge-exit-gate/seed-operator.ts
 *
 * `TZ=UTC` matters on BOTH this process and the Postgres cluster: `sessions`
 * timestamps are UTC wall-clock while `now()` resolves through the session
 * timezone, so a non-UTC cluster mints a session that is already expired and
 * every later request 401s with "Invalid or expired session". `ALTER DATABASE
 * <db> SET timezone='UTC'` is enough; a second cluster is not needed.
 */
import { factories } from '@pagespace/db/test/factories';
import { sessionService } from '../../packages/lib/src/auth/session-service';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const user = await factories.createUser();
  const drive = await factories.createDrive(user.id);
  const token = await sessionService.createSession({ userId: user.id, type: 'user', scopes: [], expiresInMs: SESSION_TTL_MS });
  console.log(JSON.stringify({ userId: user.id, email: user.email, driveId: drive.id, sessionCookie: token }, null, 2));
  process.exit(0); // the pg pool holds the process open otherwise
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
