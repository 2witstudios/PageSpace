// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { renderPhoneFilesHeader } from './phone-files-header.render';

vi.mock('../rail/notification-count', () => ({ useNotificationCount: () => 3 }));
vi.mock('@/retained/components/layout/navbar/DriveSwitcherDialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? h('div', { role: 'dialog', 'aria-label': 'Switch drive' }) : null),
}));
vi.mock('@/retained/hooks/useMyOrganizations', () => ({ useMyOrganizations: () => ({ orgById: () => null }) }));
const opened = vi.hoisted(() => ({ palette: 0 }));
vi.mock('../../store/transactions', () => ({
  dispatch: () => {
    opened.palette += 1;
  },
  transactions: { openPalette: 'openPalette' },
}));

const { PhoneFilesHeader } = await import('./phone-files-header');

afterEach(unmountAll);

describe('PhoneFilesHeader', () => {
  test('the drive switcher, Search, Notifications and New page', () => {
    const view = mount(h(PhoneFilesHeader, { driveName: 'Studio', title: 'Files', newPage: h('button', { 'aria-label': 'New page' }) }));
    const labels = Array.from(view.querySelectorAll('[aria-label]')).map((entry) => entry.getAttribute('aria-label'));
    assert({
      given: 'the Studio drive and 3 unread notifications',
      should: 'carry the four controls by their board names',
      actual: labels,
      expected: ['Switch drive: Studio', 'Search', 'Notifications, 3 unread', 'New page'],
    });
    assert({
      given: 'the head',
      should: 'show the tile initial and name Files over the drive',
      actual: view.querySelector('header button')?.textContent,
      expected: 'SFilesStudio',
    });
    assert({
      given: 'the notifications link',
      should: 'go to /notifications',
      actual: view.querySelector('a')?.getAttribute('href'),
      expected: '/notifications',
    });
  });

  test('the drive tile opens the switcher and Search opens the palette', () => {
    const view = mount(h(PhoneFilesHeader, { driveName: 'Studio', title: 'Files', newPage: null }));
    const tile = view.querySelector<HTMLElement>('[aria-label="Switch drive: Studio"]');
    act(() => tile?.click());
    act(() => view.querySelector<HTMLElement>('[aria-label="Search"]')?.click());
    assert({
      given: 'the tile and Search pressed',
      should: 'open the dialog and the palette',
      actual: [view.querySelector('[role="dialog"]') !== null, opened.palette],
      expected: [true, 1],
    });
  });
});

describe('renderPhoneFilesHeader()', () => {
  test('an unlisted drive and no unread', () => {
    const view = mount(
      renderPhoneFilesHeader({ driveName: null, title: 'Files', unread: 0, notificationsHref: '/notifications', onSwitch: () => {}, open: false, onSearch: () => {}, newPage: null }),
    );
    assert({
      given: 'no drive name and no unread',
      should: 'name the controls plainly and show no count',
      actual: [view.querySelector('button')?.getAttribute('aria-label'), view.querySelector('a')?.getAttribute('aria-label'), view.querySelector('a span')],
      expected: ['Switch drive', 'Notifications', null],
    });
    const capped = mount(
      renderPhoneFilesHeader({ driveName: 'A', title: 'Files', unread: 120, notificationsHref: '/n', onSwitch: () => {}, open: false, onSearch: () => {}, newPage: null }),
    );
    assert({ given: '120 unread', should: 'cap the badge', actual: capped.querySelector('a span')?.textContent, expected: '99+' });
  });
});
