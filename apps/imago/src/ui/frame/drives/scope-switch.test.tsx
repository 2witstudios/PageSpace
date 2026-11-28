// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, press, unmountAll } from '../../test-support/dom';
import { HomeDriveProvider } from './home-drive-context';
import { ScopeSwitch } from './scope-switch';
import { setSectionScope } from './use-section-scope';

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  unmountAll();
  setSectionScope('tasks', 'drive');
});

const pick = (trigger: HTMLElement, label: string) => {
  press(trigger, 'Enter');
  act(() => {
    [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent === label)?.click();
  });
};

describe('ScopeSwitch', () => {
  test('choosing All drives, then the drive', () => {
    const container = mount(
      <HomeDriveProvider value="home">
        <ScopeSwitch section="tasks" driveId="d1" />
      </HomeDriveProvider>,
    );
    const trigger = container.querySelector('button') as HTMLButtonElement;
    const before = trigger.getAttribute('aria-label');
    pick(trigger, 'All drives');
    const all = trigger.getAttribute('aria-label');
    pick(trigger, 'This drive');
    assert({
      given: 'Tasks on a drive that is not Home, switched to All drives and back',
      should: 'name the scope it reads each time',
      actual: [before, all, trigger.getAttribute('aria-label')],
      expected: ['Showing This drive', 'Showing all drives', 'Showing This drive'],
    });
  });
});
