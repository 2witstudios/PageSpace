// @vitest-environment jsdom
import { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { useNotificationStore } from '@/retained/stores/useNotificationStore';
import type { StoredNotification } from '@/retained/lib/notifications/notification-groups';
import NotificationsPage from './notifications-page';

const fetchWithAuth = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock('@/retained/lib/auth/auth-fetch', () => ({ fetchWithAuth, patch, del }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

// A fixed midday clock so "22 minutes ago" and the Today/Yesterday groups do not depend on when the suite runs.
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2026-10-12T12:00:00'));
afterAll(() => vi.useRealTimers());

const NOW = Date.now();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000);

const note = (id: string, type: string, extra: Partial<StoredNotification> = {}): StoredNotification => ({
  id,
  userId: 'u1',
  type,
  title: `title ${id}`,
  message: `message ${id}`,
  isRead: false,
  createdAt: minutesAgo(22),
  triggeredByUser: { id: 'd1', name: 'Dana Whitfield', email: 'dana@example.com' },
  drive: { id: 'drive1', slug: 'studio', name: 'Studio' },
  pageId: 'p1',
  driveId: 'drive1',
  metadata: {},
  ...extra,
});

let served: StoredNotification[] = [];

const fixture = (): StoredNotification[] => [
  note('m1', 'MENTION'),
  note('r1', 'CONNECTION_REQUEST', { title: 'New Connection Request', metadata: { connectionId: 'c1', senderId: 's1' } }),
  note('w1', 'WALLET_CAP_ALERT', { title: 'A spending cap is at 80%' }),
  note('t1', 'TASK_ASSIGNED', { isRead: true, createdAt: minutesAgo(3) }),
];

const respondWith = (body: unknown) =>
  Response.json(body, { status: 200 });

const settle = (check: () => void): Promise<void> =>
  act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

/** The first element matching `selector` whose text starts with `text` (tabs carry their counts). */
const byText = (container: HTMLElement, selector: string, text: string): HTMLElement => {
  const found = [...container.querySelectorAll<HTMLElement>(selector)].find((element) =>
    (element.textContent ?? '').trim().startsWith(text),
  );
  if (!found) throw new Error(`no ${selector} reading "${text}"`);
  return found;
};

const press = (element: HTMLElement) => {
  act(() => {
    element.click();
  });
};

let container: HTMLElement;

const renderPage = async (notifications: StoredNotification[] = fixture()) => {
  served = notifications;
  container = mount(<NotificationsPage />);
  await settle(() => {
    if (!useNotificationStore.getState().hasHydrated) throw new Error('not loaded');
  });
};

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async () =>
    respondWith({ notifications: served, unreadCount: served.filter((n) => !n.isRead).length }),
  );
  patch.mockReset().mockResolvedValue({});
  del.mockReset().mockResolvedValue({});
  push.mockReset();
  useNotificationStore.setState({ notifications: [], unreadCount: 0, isLoading: false, hasHydrated: false });
});

afterEach(() => {
  unmountAll();
});

describe('NotificationsPage', () => {
  test('the list, grouped by day, without the rows the board hides', async () => {
    await renderPage();
    assert({
      given: 'a mention, a connection request, a wallet cap alert and an older task, one of them read',
      should: 'group the shown rows under Today and leave the wallet cap row out',
      actual: [
        [...container.querySelectorAll('section')].map((section) => section.getAttribute('aria-label')),
        container.textContent?.includes('A spending cap'),
      ],
      expected: [['Today'], false],
    });
  });

  test('the tabs count every shown row, and Unread the unread ones', async () => {
    await renderPage();
    const tabs = [...container.querySelectorAll('[role=tab]')].map((tab) => tab.textContent);
    assert({
      given: 'three shown rows, two of them unread',
      should: 'count All as 3 and Unread as 2',
      actual: tabs,
      expected: ['All3', 'Unread2'],
    });
  });

  test('the Mark all as read button', async () => {
    await renderPage();
    press(byText(container, 'button', 'Mark all as read'));
    await settle(() => {
      if (!patch.mock.calls.some(([url]) => url === '/api/notifications/read-all')) throw new Error('not patched');
    });
    assert({
      given: 'Mark all as read pressed',
      should: 'PATCH /api/notifications/read-all, then clear the dots and hide the button',
      actual: [
        patch.mock.calls.map(([url]) => url).includes('/api/notifications/read-all'),
        container.querySelectorAll('[aria-label="Unread"]').length,
        [...container.querySelectorAll('button')].some((button) => button.textContent === 'Mark all as read'),
      ],
      expected: [true, 0, false],
    });
  });

  test('Accept and Decline on a connection request', async () => {
    await renderPage();
    press(byText(container, 'button', 'Accept'));
    await settle(() => {
      if (!container.textContent?.includes('Accepted')) throw new Error('not accepted');
    });
    assert({
      given: 'Accept pressed on a connection request',
      should: 'PATCH /api/connections/[id] with accept and read Accepted in its place',
      actual: [patch.mock.calls[0]?.[0], patch.mock.calls[0]?.[1], container.textContent?.includes('Accepted')],
      expected: ['/api/connections/c1', { action: 'accept' }, true],
    });
  });

  test('Decline sends reject and reads Declined', async () => {
    await renderPage();
    press(byText(container, 'button', 'Decline'));
    await settle(() => {
      if (!container.textContent?.includes('Declined')) throw new Error('not declined');
    });
    assert({
      given: 'Decline pressed on a connection request',
      should: 'PATCH the connection with reject and read Declined in its place',
      actual: [patch.mock.calls[0]?.[1], container.textContent?.includes('Declined')],
      expected: [{ action: 'reject' }, true],
    });
  });

  test('Dismiss deletes the row', async () => {
    await renderPage();
    press(container.querySelector<HTMLElement>('[aria-label="Dismiss notification"]') as HTMLElement);
    await settle(() => {
      if (del.mock.calls.length === 0) throw new Error('not deleted');
    });
    assert({
      given: 'the first row dismissed',
      should: 'DELETE /api/notifications/[id]',
      actual: del.mock.calls[0]?.[0],
      expected: '/api/notifications/m1',
    });
  });

  test('the Unread tab, empty of unread rows', async () => {
    await renderPage([note('t1', 'TASK_ASSIGNED', { isRead: true })]);
    press(byText(container, '[role=tab]', 'Unread'));
    assert({
      given: 'the Unread tab with every row read',
      should: 'say the viewer is all caught up',
      actual: container.textContent?.includes('You’re all caught up! No unread notifications.'),
      expected: true,
    });
  });

  test('a type filter whose rows are all gone', async () => {
    await renderPage([note('m1', 'MENTION'), note('t1', 'TASK_ASSIGNED', { isRead: true })]);
    press(byText(container, 'button', 'mention'));
    press(container.querySelector<HTMLElement>('[aria-label="Dismiss notification"]') as HTMLElement);
    await settle(() => {
      if (!container.textContent?.includes('No mention notifications.')) throw new Error('still listed');
    });
    assert({
      given: 'the mention filter chosen and its only row dismissed',
      should: 'name the type in the empty copy',
      actual: container.textContent?.includes('No mention notifications.'),
      expected: true,
    });
  });

  test('no notifications at all', async () => {
    await renderPage([]);
    assert({
      given: 'no notifications',
      should: 'say no notifications yet',
      actual: container.textContent?.includes('No notifications yet.'),
      expected: true,
    });
  });

  test('a row opens its destination and marks itself read', async () => {
    await renderPage([note('m1', 'MENTION')]);
    press(byText(container, 'button', 'title m1'));
    await settle(() => {
      if (push.mock.calls.length === 0) throw new Error('not opened');
    });
    assert({
      given: 'an unread mention pressed',
      should: 'mark it read and open its page in imago',
      actual: [patch.mock.calls[0]?.[0], push.mock.calls[0]?.[0]],
      expected: ['/api/notifications/m1/read', '/p/p1'],
    });
  });
});
