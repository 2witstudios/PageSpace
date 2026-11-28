import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';

// getViewer() and getHomeDrive() are proven against Postgres in
// page.integration.test.ts; here they are the page's seams.
const getViewer = vi.hoisted(() => vi.fn());
const getHomeDrive = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('@/lib/auth/get-viewer', () => ({ getViewer }));
vi.mock('@pagespace/lib/services/drive-service', () => ({ getHomeDrive }));
vi.mock('next/headers', () => ({ headers: async () => request.headers }));

const { default: ImagoIndex } = await import('./page');

const destination = async (): Promise<string | { thrown: unknown }> => {
  try {
    await ImagoIndex();
  } catch (error) {
    return isRedirectError(error) ? getURLFromRedirectError(error) : { thrown: error };
  }
  return { thrown: 'rendered instead of redirecting' };
};

describe('imago index page', () => {
  beforeEach(() => {
    getViewer.mockReset();
    getHomeDrive.mockReset();
    request.headers = new Headers({ host: 'pagespace.ai', 'x-forwarded-proto': 'https' });
    getViewer.mockResolvedValue({ userId: 'user-1', role: 'user', sessionId: 'session-1' });
    vi.stubEnv('WEB_APP_URL', 'https://pagespace.ai');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('a spoofed Host header', async () => {
    getHomeDrive.mockResolvedValue(null);
    request.headers = new Headers({ host: 'evil.example', 'x-forwarded-proto': 'http' });

    assert({
      given: 'a viewer with no Home drive on a request whose Host names another site',
      should: 'send them to classic on the configured origin',
      actual: await destination(),
      expected: 'https://pagespace.ai/dashboard',
    });
  });

  test('a viewer with a Home drive', async () => {
    getHomeDrive.mockResolvedValue({ id: 'home-1', kind: 'HOME', ownerId: 'user-1' });

    assert({
      given: 'a signed-in viewer who owns a Home drive',
      should: 'send them to that drive’s chat (Next adds the /imago basePath)',
      actual: [await destination(), getHomeDrive.mock.calls],
      expected: ['/home-1', [['user-1']]],
    });
  });

  test('a viewer with no Home drive yet', async () => {
    getHomeDrive.mockResolvedValue(null);

    assert({
      given: 'a signed-in viewer the Home backfill has not reached',
      should: 'send them to classic, which works without a Home drive',
      actual: await destination(),
      expected: 'https://pagespace.ai/dashboard',
    });
  });

  test('no valid session', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;https://pagespace.ai/auth/signin?next=%2Fimago;307;',
    });
    getViewer.mockRejectedValue(redirect);
    let thrown: unknown;
    try {
      await ImagoIndex();
    } catch (error) {
      thrown = error;
    }

    assert({
      given: 'getViewer() redirecting to sign-in',
      should: 'let the redirect through without looking up a drive',
      actual: [thrown, getHomeDrive.mock.calls.length],
      expected: [redirect, 0],
    });
  });
});
