import { beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// getViewer() itself is proven against Postgres in
// lib/auth/get-viewer.integration.test.ts; here it is the page's seam.
const getViewer = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/get-viewer', () => ({ getViewer }));

const { default: Home } = await import('./page');

describe('imago index page', () => {
  beforeEach(() => {
    getViewer.mockReset();
  });

  test('a signed-in viewer', async () => {
    getViewer.mockResolvedValue({ userId: 'user-1', role: 'user', sessionId: 'session-1' });
    const markup = renderToStaticMarkup(await Home());

    assert({
      given: 'a viewer with a valid session',
      should: 'offer sign-out',
      actual: markup.includes('<button type="button">Sign out</button>'),
      expected: true,
    });

    assert({
      given: 'a render',
      should: 'resolve the viewer first',
      actual: getViewer.mock.calls.length,
      expected: 1,
    });
  });

  test('no valid session', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;https://pagespace.ai/auth/signin?next=%2Fimago;307;',
    });
    getViewer.mockRejectedValue(redirect);

    let thrown: unknown;
    try {
      await Home();
    } catch (error) {
      thrown = error;
    }

    assert({
      given: 'getViewer() redirecting to sign-in',
      should: 'render nothing and let the redirect through',
      actual: thrown,
      expected: redirect,
    });
  });
});
