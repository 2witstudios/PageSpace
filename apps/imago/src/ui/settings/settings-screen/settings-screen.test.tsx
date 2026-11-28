// @vitest-environment jsdom
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { afterEach } from 'vitest';
import { SettingsGroup, SettingsRow, SettingsScreen, SettingsSection } from './settings-screen';

afterEach(unmountAll);

describe('SettingsScreen', () => {
  test('one h1 with its lede, flat sections and grouped rows', () => {
    const container = mount(
      <SettingsScreen title="General" lede="Name and home page.">
        <SettingsSection title="Drive name" description="Shown everywhere.">
          <SettingsGroup label="Drive">
            <SettingsRow label="Name" hint="Up to 64 characters">
              <button type="button">Rename</button>
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
      </SettingsScreen>,
    );
    assert({
      given: 'a screen with one section and one grouped row',
      should: 'render a single h1 and lede, the section as a named region with an h2, and the row in a named group',
      actual: {
        h1: [...container.querySelectorAll('h1')].map((node) => node.textContent),
        lede: container.querySelector('header p')?.textContent,
        section: container.querySelector('section[aria-label="Drive name"] h2')?.textContent,
        group: container.querySelector('[role="group"][aria-label="Drive"]')?.textContent?.includes('Up to 64 characters'),
      },
      expected: { h1: ['General'], lede: 'Name and home page.', section: 'Drive name', group: true },
    });
  });
});
