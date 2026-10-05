import { afterAll, afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { RequestCookies } from 'next/dist/server/web/spec-extension/cookies';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { db, pool } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { PATHNAME_HEADER } from './sign-in-url';

// The request scope is Next's to provide; everything behind it is real: the
// session-service, its repository and Postgres. A redirect is Next's own
// redirect() error, read back the way the renderer reads it.
const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => new RequestCookies(request.headers),
  headers: async () => request.headers,
}));

const { getViewer } = await import('./get-viewer');

type Outcome =
  | { kind: 'viewer'; viewer: Awaited<ReturnType<typeof getViewer>> }
  | { kind: 'redirect'; location: URL }
  | { kind: 'error'; error: unknown };

const run = async ({
  session,
  pathname = '/drive-1/files',
}: {
  session?: string;
  pathname?: string;
}): Promise<Outcome> => {
  request.headers = new Headers({
    host: 'pagespace.ai',
    'x-forwarded-proto': 'https',
    [PATHNAME_HEADER]: pathname,
    ...(session === undefined ? {} : { cookie: `session=${session}` }),
  });
  try {
    return { kind: 'viewer', viewer: await getViewer() };
  } catch (error) {
    if (isRedirectError(error)) {
      return { kind: 'redirect', location: new URL(getURLFromRedirectError(error)) };
    }
    return { kind: 'error', error };
  }
};

const SIGN_IN = 'https://pagespace.ai/auth/signin';

const signInTarget = (outcome: Outcome): { url: string; next: string | null } | Outcome =>
  outcome.kind === 'redirect'
    ? {
        url: `${outcome.location.origin}${outcome.location.pathname}`,
        next: outcome.location.searchParams.get('next'),
      }
    : outcome;

describe('getViewer()', () => {
  let userId: string;

  const mint = (type: 'user' | 'socket' = 'user', expiresInMs = 60 * 60 * 1000) =>
    sessionService.createSession({ userId, type, scopes: ['*'], expiresInMs });

  beforeEach(async () => {
    userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      name: 'Imago Viewer',
      email: `imago-viewer-${userId}@example.com`,
      provider: 'email',
      role: 'user',
      tokenVersion: 1,
    });
  });

  afterEach(async () => {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  afterAll(async () => {
    await pool.end();
  });

  test('a valid browser session', async () => {
    const token = await mint();
    const outcome = await run({ session: token });
    const claims = await sessionService.validateSession(token, { expectedType: 'user' });

    assert({
      given: 'a live user session in the session cookie',
      should: 'return the viewer it belongs to',
      actual: outcome.kind === 'viewer' ? outcome.viewer : outcome,
      expected: { userId, role: 'user', sessionId: claims?.sessionId ?? 'no claims' },
    });
  });

  test('no session cookie', async () => {
    assert({
      given: 'no session cookie',
      should: 'redirect to sign-in and back to the requested imago path',
      actual: signInTarget(await run({})),
      expected: { url: SIGN_IN, next: '/imago/drive-1/files' },
    });
  });

  test('a revoked session', async () => {
    const token = await mint();
    await sessionService.revokeSession(token, 'test');

    assert({
      given: 'a session revoked in the database',
      should: 'redirect to sign-in',
      actual: signInTarget(await run({ session: token })),
      expected: { url: SIGN_IN, next: '/imago/drive-1/files' },
    });
  });

  test('every session of the user invalidated', async () => {
    const token = await mint();
    await db.update(users).set({ tokenVersion: 2 }).where(eq(users.id, userId));

    assert({
      given: "a session minted before the user's token version was bumped",
      should: 'redirect to sign-in',
      actual: signInTarget(await run({ session: token })),
      expected: { url: SIGN_IN, next: '/imago/drive-1/files' },
    });
  });

  test('an expired session', async () => {
    const token = await mint('user', -1000);

    assert({
      given: 'a session past its expiry',
      should: 'redirect to sign-in',
      actual: signInTarget(await run({ session: token })),
      expected: { url: SIGN_IN, next: '/imago/drive-1/files' },
    });
  });

  test('an unknown token', async () => {
    assert({
      given: 'a well-formed token the database never issued',
      should: 'redirect to sign-in',
      actual: signInTarget(await run({ session: `ps_sess_${'a'.repeat(43)}` })),
      expected: { url: SIGN_IN, next: '/imago/drive-1/files' },
    });
  });

  test('a non-browser session', async () => {
    const token = await mint('socket');

    assert({
      given: 'a live socket token replayed in the session cookie',
      should: 'reject it as not a browser session and redirect to sign-in',
      actual: signInTarget(await run({ session: token })),
      expected: { url: SIGN_IN, next: '/imago/drive-1/files' },
    });
  });

  test('a spoofed pathname header', async () => {
    assert({
      given: 'a protocol-relative look-alike in the pathname header',
      should: 'fall back to the bare /imago root',
      actual: signInTarget(await run({ pathname: '//evil.com' })),
      expected: { url: SIGN_IN, next: '/imago' },
    });
  });
});
