// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { stageFor } from '../stage/stage';
import { phoneBarItems } from './phone-bar-model';

vi.mock('@/ui/messages/use-messages/use-messages', () => ({ useUnreadBadges: () => ({ badges: { dms: 3, channels: 5 } }) }));
vi.mock('../rail/notification-count', () => ({ useNotificationCount: () => 3 }));
vi.mock('../avatar-menu/avatar-menu', () => ({
  AvatarMenu: ({ more }: { more?: { notifications: number } }) => h('button', { 'aria-label': `More, ${more?.notifications} notifications` }),
}));

const { PhoneBottomBar } = await import('./phone-bar');
const { renderPhoneBar } = await import('./phone-bar.render');

afterEach(unmountAll);

describe('PhoneBottomBar', () => {
  test('a "Sections" nav with the unread count in Messages and More with the notifications', () => {
    const view = mount(h(PhoneBottomBar, { stage: stageFor('/d1/files'), driveId: 'd1' }));
    assert({
      given: '8 unread messages and 3 notifications',
      should: 'name the bar Sections, mark Files current and name More',
      actual: [
        view.querySelector('nav')?.getAttribute('aria-label'),
        Array.from(view.querySelectorAll('a')).map((a) => a.getAttribute('aria-label')),
        view.querySelector('[aria-current="page"]')?.getAttribute('aria-label'),
        view.querySelector('button')?.getAttribute('aria-label'),
      ],
      expected: ['Sections', ['Home', 'Pages', 'Messages, 8 unread', 'Tasks'], 'Pages', 'More, 3 notifications'],
    });
  });
});

describe('renderPhoneBar()', () => {
  test('an item with no drive is disabled, not a link', () => {
    const view = mount(renderPhoneBar({ items: phoneBarItems(stageFor('/'), null, 0), more: null }));
    assert({
      given: 'no drive',
      should: 'render no links',
      actual: [view.querySelectorAll('a').length, view.querySelectorAll('[aria-disabled="true"]').length],
      expected: [0, 4],
    });
  });
});
