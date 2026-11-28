import { beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';

const getViewer = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/get-viewer', () => ({ getViewer }));
vi.mock('@/retained/components/notifications/notifications-page', () => ({ default: function NotificationsPage() { return null; } }));

const { default: Page } = await import('./page');

beforeEach(() => {
  getViewer.mockReset();
});

describe('notifications route', () => {
  test('asks for the viewer, then shows the notifications page', async () => {
    getViewer.mockResolvedValue({ userId: 'u1' });
    const element = await Page();
    assert({
      given: 'a signed-in viewer',
      should: 'check the session once and render the notifications page',
      actual: [getViewer.mock.calls.length, typeof element.type === 'function' ? element.type.name : null],
      expected: [1, 'NotificationsPage'],
    });
  });

  test('sends a signed-out viewer to sign in instead of rendering', async () => {
    const redirect = new Error('NEXT_REDIRECT');
    getViewer.mockRejectedValue(redirect);
    let thrown: unknown = null;
    try {
      await Page();
    } catch (error) {
      thrown = error;
    }
    assert({ given: 'getViewer redirecting', should: 'let the redirect propagate', actual: thrown, expected: redirect });
  });
});
