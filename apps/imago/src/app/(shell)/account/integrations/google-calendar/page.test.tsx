import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const spies = vi.hoisted(() => ({ isOnPrem: vi.fn(), getViewer: vi.fn() }));

vi.mock('@pagespace/lib/deployment-mode', () => ({ isOnPrem: spies.isOnPrem }));
vi.mock('@/lib/auth/get-viewer', () => ({ getViewer: spies.getViewer }));
vi.mock('@/retained/app/settings/integrations/google-calendar/page', () => ({
  default: () => <p>google calendar screen</p>,
}));

import Page from './page';

describe('account/integrations/google-calendar route', () => {
  test('an on-prem build renders the not-found object instead of the Google Calendar screen', async () => {
    spies.isOnPrem.mockReturnValue(true);
    spies.getViewer.mockResolvedValue({ userId: 'u1' });
    const markup = renderToStaticMarkup(await Page({}));
    assert({
      given: 'a build with isOnPrem() true',
      should: 'render the not-found object and not the Google Calendar screen',
      actual: { notFound: markup.includes('data-not-found'), screen: markup.includes('google calendar screen') },
      expected: { notFound: true, screen: false },
    });
  });

  test('a cloud or tenant build renders the Google Calendar screen', async () => {
    spies.isOnPrem.mockReturnValue(false);
    spies.getViewer.mockResolvedValue({ userId: 'u1' });
    const markup = renderToStaticMarkup(await Page({}));
    assert({
      given: 'a build with isOnPrem() false',
      should: 'render the Google Calendar screen',
      actual: markup,
      expected: '<p>google calendar screen</p>',
    });
  });
});
