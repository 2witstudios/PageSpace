import { afterAll, afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { RequestCookies } from 'next/dist/server/web/spec-extension/cookies';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { db, pool } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { sessions } from '@pagespace/db/schema/sessions';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { PATHNAME_HEADER } from '@/lib/auth/sign-in-url';

// The request scope is Next's to provide; everything behind it is real:
// getViewer() and its session-service, getHomeDrive() and Postgres. The
// redirect is Next's own redirect() error, read back the way the renderer
// reads it (the renderer then adds the /imago basePath to a relative one).
const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => new RequestCookies(request.headers),
  headers: async () => request.headers,
}));

const { default: ImagoIndex } = await import('./page');

const destination = async (session?: string): Promise<string | { thrown: unknown }> => {
  request.headers = new Headers({
    host: 'pagespace.ai',
    'x-forwarded-proto': 'https',
    [PATHNAME_HEADER]: '/',
    ...(session === undefined ? {} : { cookie: `session=${session}` }),
  });
  try {
    await ImagoIndex();
  } catch (error) {
    return isRedirectError(error) ? getURLFromRedirectError(error) : { thrown: error };
  }
  return { thrown: 'rendered instead of redirecting' };
};

describe('/imago', () => {
  let userId: string;

  const insertDrive = async (kind: 'HOME' | 'STANDARD', ownerId = userId): Promise<string> => {
    const [drive] = await db
      .insert(drives)
      .values({ name: kind, slug: `${kind.toLowerCase()}-${crypto.randomUUID()}`, kind, ownerId, updatedAt: new Date() })
      .returning({ id: drives.id });
    return drive.id;
  };

  const insertUser = async (id: string): Promise<void> => {
    await db.insert(users).values({
      id,
      name: 'Imago Viewer',
      email: `imago-home-${id}@example.com`,
      provider: 'email',
      role: 'user',
      tokenVersion: 1,
    });
  };

  const signIn = () =>
    sessionService.createSession({ userId, type: 'user', scopes: ['*'], expiresInMs: 60 * 60 * 1000 });

  beforeEach(async () => {
    userId = crypto.randomUUID();
    await insertUser(userId);
  });

  afterEach(async () => {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(drives).where(eq(drives.ownerId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  afterAll(async () => {
    await pool.end();
  });

  test('a viewer with a Home drive', async () => {
    await insertDrive('STANDARD');
    const homeId = await insertDrive('HOME');

    assert({
      given: 'a signed-in viewer who owns a standard drive and a Home drive',
      should: 'send them to the Home drive’s chat',
      actual: await destination(await signIn()),
      expected: `/${homeId}`,
    });
  });

  test('someone else’s Home drive', async () => {
    const otherId = crypto.randomUUID();
    await insertUser(otherId);
    try {
      await insertDrive('HOME', otherId);

      assert({
        given: 'a viewer with no Home drive while another user has one',
        should: 'never send them to the other user’s Home drive',
        actual: await destination(await signIn()),
        expected: 'https://pagespace.ai/dashboard',
      });
    } finally {
      await db.delete(drives).where(eq(drives.ownerId, otherId));
      await db.delete(users).where(eq(users.id, otherId));
    }
  });

  test('no session', async () => {
    const outcome = await destination();
    const location = typeof outcome === 'string' ? new URL(outcome) : null;

    assert({
      given: 'no session cookie',
      should: 'send the viewer to sign-in and back to /imago',
      actual: location && [`${location.origin}${location.pathname}`, location.searchParams.get('next')],
      expected: ['https://pagespace.ai/auth/signin', '/imago'],
    });
  });
});
