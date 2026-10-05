import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '../stage/stage';
import {
  activeRailItem,
  activeRailPlace,
  classicHref,
  messagesUnread,
  overflowItems,
  railItems,
  railDrive,
  settingsItem,
} from './rail-items';

describe('railItems()', () => {
  test('the rail vocabulary (DEC-6)', () => {
    assert({
      given: 'the current drive',
      should: 'list Chat, Files, Messages and Tasks, each at that drive’s section',
      actual: railItems('drive-1').map(({ id, label, href }) => [id, label, href]),
      expected: [
        ['chat', 'Chat', '/drive-1'],
        ['files', 'Files', '/drive-1/files'],
        ['messages', 'Messages', '/drive-1/messages'],
        ['tasks', 'Tasks', '/drive-1/tasks'],
      ],
    });
  });

  test('Settings', () => {
    assert({
      given: 'the current drive',
      should: 'pin the drive’s own settings, not the account',
      actual: [settingsItem('drive-1').label, settingsItem('drive-1').href],
      expected: ['Settings', '/drive-1/settings'],
    });
  });

  test('no drive to link to', () => {
    assert({
      given: 'no current drive',
      should: 'leave every item without a destination',
      actual: [...railItems(null), settingsItem(null)].map((entry) => entry.href),
      expected: [null, null, null, null, null],
    });
  });

  test('an id that needs escaping', () => {
    assert({
      given: 'a drive id with a URL delimiter in it',
      should: 'keep it one path segment',
      actual: railItems('a/b')[1]?.href,
      expected: '/a%2Fb/files',
    });
  });
});

describe('overflowItems()', () => {
  test('classic deep links for the current drive (D5, DEC-6)', () => {
    assert({
      given: 'the current drive',
      should: 'list Calendar, Agents, Connections, Activity and Trash at classic’s drive routes',
      actual: overflowItems('drive-1').map(({ id, label, href }) => [id, label, href]),
      expected: [
        ['calendar', 'Calendar', '/dashboard/drive-1/calendar'],
        ['agents', 'Agents', '/dashboard/drive-1/agents'],
        ['connections', 'Connections', '/dashboard/drive-1/settings/integrations'],
        ['activity', 'Activity', '/dashboard/drive-1/activity'],
        ['trash', 'Trash', '/dashboard/drive-1/trash'],
      ],
    });
  });

  test('same-origin paths only', () => {
    const hrefs = [...overflowItems('drive-1'), ...overflowItems('//evil.example')].map((entry) => entry.href);
    assert({
      given: 'any drive id, a protocol-relative one included',
      should: 'produce only root-relative paths under /dashboard/, never another origin',
      actual: hrefs.filter((href) => !href.startsWith('/dashboard/') || href.startsWith('//')),
      expected: [],
    });
  });

  test('classicHref()', () => {
    assert({
      given: 'a drive id with a URL delimiter in it',
      should: 'escape it into one segment of classic’s drive route',
      actual: classicHref('../x', 'trash'),
      expected: '/dashboard/..%2Fx/trash',
    });
  });
});

describe('railDrive()', () => {
  test('the drive the rail links into', () => {
    assert({
      given: 'a drive stage, then a user-level stage with and without a Home drive',
      should: 'use the URL’s drive, else the Home drive, else none',
      actual: [
        railDrive(stageFor('/drive-1/files'), 'home-1'),
        railDrive(stageFor('/dm'), 'home-1'),
        railDrive(stageFor('/account'), null),
      ],
      expected: ['drive-1', 'home-1', null],
    });
  });
});

describe('activeRailItem()', () => {
  test('the URL picks the active item', () => {
    const paths = [
      '/drive-1',
      '/drive-1/files',
      '/drive-1/files/page-1',
      '/drive-1/messages/channel-1',
      '/dm/conversation-1',
      '/drive-1/tasks',
      '/drive-1/settings',
      '/account',
    ];
    assert({
      given: 'every stage',
      should: 'mark its section, DMs under Messages, and nothing for the account',
      actual: paths.map((path) => activeRailItem(stageFor(path))),
      expected: ['chat', 'files', 'files', 'messages', 'messages', 'tasks', 'settings', null],
    });
  });
});

describe('activeRailPlace()', () => {
  test('the active item’s own URL, or a place inside its section', () => {
    const paths = [
      '/drive-1',
      '/drive-1/files',
      '/drive-1/files/page-1',
      '/drive-1/messages/channel-1',
      '/drive-1/settings',
      '/dm',
      '/dm/conversation-1',
    ];
    assert({
      given: 'section roots, pages inside sections, and the driveless DMs',
      should: 'call only the URL the item links to its page',
      actual: paths.map((path) => activeRailPlace(stageFor(path))),
      expected: ['page', 'page', 'section', 'section', 'page', 'section', 'section'],
    });
  });
});

describe('messagesUnread()', () => {
  test('channels and DMs', () => {
    assert({
      given: 'a /api/sidebar/badges body',
      should: 'count unread channel messages and DMs together, nothing else',
      actual: messagesUnread({ dms: 2, channels: 3, files: 7, tasks: 1, calendar: 4 }),
      expected: 5,
    });
  });

  test('nothing loaded, or a body that is not counts', () => {
    assert({
      given: 'no body yet, an error body and malformed counts',
      should: 'show no badge rather than a wrong number',
      actual: [
        messagesUnread(undefined),
        messagesUnread({ error: 'Failed to fetch sidebar badges' }),
        messagesUnread({ dms: '4', channels: -2 }),
        messagesUnread({ dms: Number.NaN, channels: 1.5 }),
        messagesUnread(null),
      ],
      expected: [0, 0, 0, 0, 0],
    });
  });
});
