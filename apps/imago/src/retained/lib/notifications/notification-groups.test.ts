import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  formatTypeLabel,
  groupForBell,
  groupForPage,
  isShownNotification,
  notificationHref,
  type StoredNotification,
} from './notification-groups';

const NOW = new Date(2026, 9, 12, 15, 0, 0);
const at = (daysAgo: number, hour = 12): Date => new Date(2026, 9, 12 - daysAgo, hour, 0, 0);

const note = (id: string, type: string, createdAt: Date, extra: Partial<StoredNotification> = {}): StoredNotification => ({
  id,
  userId: 'u1',
  type,
  title: id,
  message: '',
  isRead: false,
  createdAt,
  metadata: {},
  ...extra,
});

const labels = (groups: ReturnType<typeof groupForBell>) => groups.map(([label]) => label);
const ids = (groups: ReturnType<typeof groupForBell>) => groups.map(([, items]) => items.map((item) => item.id));

describe('groupForBell()', () => {
  test('Today, Yesterday and Older, with empty groups dropped', () => {
    const groups = groupForBell(
      [note('a', 'MENTION', at(0)), note('b', 'TASK_ASSIGNED', at(1)), note('c', 'PAGE_SHARED', at(6))],
      NOW,
    );
    assert({
      given: 'a notification from today, one from yesterday and one from last week',
      should: 'group them Today, Yesterday and Older',
      actual: [labels(groups), ids(groups)],
      expected: [
        ['Today', 'Yesterday', 'Older'],
        [['a'], ['b'], ['c']],
      ],
    });
  });

  test('no empty groups', () => {
    assert({
      given: 'only notifications from today',
      should: 'return only the Today group',
      actual: labels(groupForBell([note('a', 'MENTION', at(0))], NOW)),
      expected: ['Today'],
    });
  });
});

describe('groupForPage()', () => {
  test('Today through Older, by age', () => {
    const groups = groupForPage(
      [note('a', 'MENTION', at(0)), note('b', 'MENTION', at(1)), note('c', 'MENTION', at(4)), note('d', 'MENTION', at(15)), note('e', 'MENTION', at(90))],
      NOW,
    );
    assert({
      given: 'notifications from today, yesterday, four days ago, two weeks ago and three months ago',
      should: 'group them Today, Yesterday, This Week, This Month and Older',
      actual: labels(groups),
      expected: ['Today', 'Yesterday', 'This Week', 'This Month', 'Older'],
    });
  });
});

describe('isShownNotification()', () => {
  test('hides the wallet-cap and skipped-automation rows', () => {
    assert({
      given: 'a wallet cap alert, a skipped automation and a mention',
      should: 'show only the mention until PR #2871 lands',
      actual: ['WALLET_CAP_ALERT', 'AUTOMATION_SKIPPED', 'MENTION'].map((type) => isShownNotification(note('x', type, NOW))),
      expected: [false, false, true],
    });
  });
});

describe('formatTypeLabel()', () => {
  test('reads the type as the chips do', () => {
    assert({
      given: 'CONNECTION_REQUEST',
      should: 'read connection request in lower case',
      actual: formatTypeLabel('CONNECTION_REQUEST'),
      expected: 'connection request',
    });
  });
});

describe('notificationHref()', () => {
  test('opens each row in imago’s own routes', () => {
    assert({
      given: 'a direct message, a mention on a page, and a drive-only notification',
      should: 'open /dm, /p and the drive, never classic’s /dashboard',
      actual: [
        notificationHref(note('a', 'NEW_DIRECT_MESSAGE', NOW, { metadata: { conversationId: 'c1' } })),
        notificationHref(note('b', 'MENTION', NOW, { pageId: 'p1', driveId: 'd1' })),
        notificationHref(note('c', 'DRIVE_JOINED', NOW, { drive: { id: 'd2', slug: 's', name: 'Ops' } })),
        notificationHref(note('e', 'PAGE_SHARED', NOW)),
      ],
      expected: ['/dm/c1', '/p/p1', '/d2', null],
    });
  });
});
