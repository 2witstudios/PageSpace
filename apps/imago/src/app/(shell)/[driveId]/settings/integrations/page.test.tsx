import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const spies = vi.hoisted(() => ({ isOnPrem: vi.fn(), getViewer: vi.fn() }));

vi.mock('@pagespace/lib/deployment-mode', () => ({ isOnPrem: spies.isOnPrem }));
vi.mock('@/lib/auth/get-viewer', () => ({ getViewer: spies.getViewer }));
vi.mock('@/retained/app/dashboard/[driveId]/settings/integrations/page', () => ({
  default: () => <p>integrations screen</p>,
}));

import Page from './page';

describe('settings/integrations route', () => {
  test('an on-prem build renders the not-found object instead of the integrations screen', async () => {
    spies.isOnPrem.mockReturnValue(true);
    spies.getViewer.mockResolvedValue({ userId: 'u1' });
    const markup = renderToStaticMarkup(await Page({}));
    assert({
      given: 'a build with isOnPrem() true',
      should: 'render the not-found object and not the integrations screen',
      actual: { notFound: markup.includes('data-not-found'), screen: markup.includes('integrations screen') },
      expected: { notFound: true, screen: false },
    });
  });

  test('a cloud or tenant build renders the integrations screen', async () => {
    spies.isOnPrem.mockReturnValue(false);
    spies.getViewer.mockResolvedValue({ userId: 'u1' });
    const markup = renderToStaticMarkup(await Page({}));
    assert({
      given: 'a build with isOnPrem() false',
      should: 'render the integrations screen',
      actual: markup,
      expected: '<p>integrations screen</p>',
    });
  });
});
