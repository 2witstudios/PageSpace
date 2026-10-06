import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { RequestCookies } from 'next/dist/server/web/spec-extension/cookies';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { PATHNAME_HEADER } from './sign-in-url';

// Unit-level: what getViewer() asks the session-service and what it does with
// the answer. The real session-service against Postgres (revoked, expired,
// replayed tokens) is get-viewer.integration.test.ts.
const seams = vi.hoisted(() => ({
  headers: new Headers(),
  validateSession: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => new RequestCookies(seams.headers),
  headers: async () => seams.headers,
}));
vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: { validateSession: seams.validateSession },
}));

const { getViewer } = await import('./get-viewer');

const requestWith = (cookie?: string) => {
  seams.headers = new Headers({
    host: 'pagespace.ai',
    'x-forwarded-proto': 'https',
    [PATHNAME_HEADER]: '/drive-1/tasks',
    ...(cookie ? { cookie } : {}),
  });
};

const redirectTarget = async (): Promise<string | null> => {
  try {
    await getViewer();
    return null;
  } catch (error) {
    return isRedirectError(error) ? getURLFromRedirectError(error) : `threw: ${String(error)}`;
  }
};

describe('getViewer() (unit)', () => {
  beforeEach(() => {
    seams.validateSession.mockReset();
    // The origin imago's redirects are built on: configuration, never the request.
    vi.stubEnv('WEB_APP_URL', 'https://pagespace.ai');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('validation request', async () => {
    requestWith('ps_logged_in=1; session=ps_sess_abc');
    seams.validateSession.mockResolvedValue({
      sessionId: 'session-1',
      userId: 'user-1',
      userRole: 'admin',
      type: 'user',
    });
    const viewer = await getViewer();

    assert({
      given: 'a session cookie among others',
      should: 'validate that cookie as a browser (user) session',
      actual: seams.validateSession.mock.calls,
      expected: [['ps_sess_abc', { expectedType: 'user' }]],
    });

    assert({
      given: 'valid claims',
      should: 'return the viewer they name',
      actual: viewer,
      expected: { userId: 'user-1', role: 'admin', sessionId: 'session-1' },
    });
  });

  test('rejected session', async () => {
    requestWith('session=ps_sess_revoked');
    seams.validateSession.mockResolvedValue(null);

    assert({
      given: 'a session the service rejects',
      should: 'redirect to the absolute sign-in URL with next= the imago path',
      actual: await redirectTarget(),
      expected: 'https://pagespace.ai/auth/signin?next=%2Fimago%2Fdrive-1%2Ftasks',
    });
  });

  test('no cookie', async () => {
    requestWith();

    assert({
      given: 'no session cookie',
      should: 'redirect without asking the session-service',
      actual: {
        target: await redirectTarget(),
        calls: seams.validateSession.mock.calls.length,
      },
      expected: {
        target: 'https://pagespace.ai/auth/signin?next=%2Fimago%2Fdrive-1%2Ftasks',
        calls: 0,
      },
    });
  });

  test('a spoofed Host header', async () => {
    seams.headers = new Headers({
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
      [PATHNAME_HEADER]: '/drive-1/tasks',
      cookie: 'session=ps_sess_revoked',
    });
    seams.validateSession.mockResolvedValue(null);

    assert({
      given: 'a rejected session on a request whose Host and forwarded headers name another site',
      should: 'still redirect to sign-in on the configured origin',
      actual: await redirectTarget(),
      expected: 'https://pagespace.ai/auth/signin?next=%2Fimago%2Fdrive-1%2Ftasks',
    });
  });

  test('next dev', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_WEB_APP_URL', 'http://localhost:3000');
    requestWith('session=ps_sess_revoked');
    seams.validateSession.mockResolvedValue(null);

    assert({
      given: 'a rejected session under next dev',
      should: "redirect to apps/web's origin, which serves the sign-in page",
      actual: await redirectTarget(),
      expected: 'http://localhost:3000/auth/signin?next=%2Fimago%2Fdrive-1%2Ftasks',
    });
  });
});
