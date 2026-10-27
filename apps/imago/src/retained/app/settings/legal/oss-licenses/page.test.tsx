// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import OssLicensesPage from './page';

afterEach(() => unmountAll());

describe('OssLicensesPage', () => {
  test('renders the licence sections natively, with one h1 and no classic back button', () => {
    const container = mount(<OssLicensesPage />);
    assert({
      given: 'the open-source licenses screen',
      should: 'render its h1 and the three sections, and no Back to Settings button',
      actual: {
        h1: [...container.querySelectorAll('h1')].map((h) => h.textContent),
        sections: [...container.querySelectorAll('h2')].map((h) => h.textContent),
        back: container.textContent?.includes('Back to Settings') ?? false,
      },
      expected: {
        h1: ['Open-source licenses'],
        sections: ['MPL-2.0 attribution', 'Other notable attributions', 'Full inventory'],
        back: false,
      },
    });
  });

  test('lists each attributed component with its licence and repository link', () => {
    const container = mount(<OssLicensesPage />);
    const mpl = container.querySelector('section[aria-label="MPL-2.0 attribution"]');
    assert({
      given: 'the MPL-2.0 attribution section',
      should: 'list the capacitor social login component with its repository link',
      actual: {
        name: mpl?.textContent?.includes('@capgo/capacitor-social-login') ?? false,
        link: mpl?.querySelector('a')?.getAttribute('href'),
      },
      expected: {
        name: true,
        link: 'https://github.com/Cap-go/capacitor-social-login',
      },
    });
  });
});
