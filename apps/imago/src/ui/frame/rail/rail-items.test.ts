import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '../stage/stage';
import {
  activeRailItem,
  activeRailPlace,
  calendarUnread,
  messagesUnread,
  moreItems,
  secondaryItems,
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
      should: 'pin the drive’s own settings, named as the board names it',
      actual: [settingsItem('drive-1').label, settingsItem('drive-1').href],
      expected: ['Drive settings', '/drive-1/settings'],
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

describe('secondaryItems() (IMC-1.4)', () => {
  test('Calendar and Agents under the divider', () => {
    assert({
      given: 'the current drive',
      should: 'list Calendar and Agents at that drive',
      actual: secondaryItems('drive-1').map(({ id, label, href }) => [id, label, href]),
      expected: [
        ['calendar', 'Calendar', '/drive-1/calendar'],
        ['agents', 'Agents', '/drive-1/agents'],
      ],
    });
  });

  test('no drive', () => {
    assert({
      given: 'no current drive',
      should: 'leave the tools without a destination',
      actual: secondaryItems(null).map((entry) => entry.href),
      expected: [null, null],
    });
  });

});

describe('moreItems()', () => {
  test('the housekeeping tools behind More, in board order', () => {
    assert({
      given: 'the current drive',
      should: 'list Workflows, Activity, Members and Trash at that drive',
      actual: moreItems('drive-1').map(({ id, label, href }) => [id, label, href]),
      expected: [
        ['workflows', 'Workflows', '/drive-1/workflows'],
        ['activity', 'Activity', '/drive-1/activity'],
        ['members', 'Members', '/drive-1/members'],
        ['trash', 'Trash', '/drive-1/trash'],
      ],
    });
  });

  test('no drive', () => {
    assert({
      given: 'no current drive',
      should: 'leave the More tools without a destination',
      actual: moreItems(null).map((entry) => entry.href),
      expected: [null, null, null, null],
    });
  });
});

describe('activeRailItem for drive tools', () => {
  test('the active tool', () => {
    assert({
      given: 'a drive tool open',
      should: 'mark that tool, not Settings',
      actual: ['calendar', 'agents', 'workflows', 'activity', 'members', 'trash'].map((tool) =>
        activeRailItem(stageFor(`/drive-1/${tool}`)),
      ),
      expected: ['calendar', 'agents', 'workflows', 'activity', 'members', 'trash'],
    });
  });

  test('a member profile or the invite page', () => {
    assert({
      given: 'a page under Members',
      should: 'keep Members marked',
      actual: [activeRailItem(stageFor('/drive-1/members/user-1')), activeRailItem(stageFor('/drive-1/members/invite'))],
      expected: ['members', 'members'],
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

describe('calendarUnread()', () => {
  test('pending invites from the badges body', () => {
    assert({
      given: 'a /api/sidebar/badges body with four pending invites',
      should: 'show the calendar count and nothing else',
      actual: calendarUnread({ dms: 2, channels: 3, files: 7, tasks: 1, calendar: 4 }),
      expected: 4,
    });
  });

  test('nothing loaded, or a body that is not counts', () => {
    assert({
      given: 'no body yet, an error body and a malformed count',
      should: 'show no badge rather than a wrong number',
      actual: [calendarUnread(undefined), calendarUnread({ error: 'nope' }), calendarUnread({ calendar: '3' })],
      expected: [0, 0, 0],
    });
  });
});
