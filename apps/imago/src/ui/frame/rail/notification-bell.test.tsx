// @vitest-environment jsdom
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { useNotificationStore } from '@/retained/stores/useNotificationStore';
import type { StoredNotification } from '@/retained/lib/notifications/notification-groups';
import { NotificationBell } from './notification-bell';

const fetchWithAuth = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock('@/retained/lib/auth/auth-fetch', () => ({ fetchWithAuth, patch, del }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const note = (id: string, type: string, extra: Partial<StoredNotification> = {}): StoredNotification => ({
  id,
  userId: 'u1',
  type,
  title: `title ${id}`,
  message: `message ${id}`,
  isRead: false,
  createdAt: new Date(),
  metadata: {},
  ...extra,
});

let served: StoredNotification[] = [];

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

const badgeOf = (html: string): string | null => /aria-hidden="true"[^>]*>(\d+|99\+)<\/span>/.exec(html)?.[1] ?? null;

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  served = [];
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async () =>
    Response.json({ notifications: served, unreadCount: served.filter((n) => !n.isRead).length }),
  );
  patch.mockReset().mockResolvedValue({});
  del.mockReset().mockResolvedValue({});
  push.mockReset();
  useNotificationStore.setState({ notifications: [], unreadCount: 0, isLoading: false, hasHydrated: false });
});

afterEach(() => {
  unmountAll();
});

describe('NotificationBell', () => {
  test('the tile’s name and badge follow the unread count', () => {
    const quiet = renderToStaticMarkup(<NotificationBell count={0} current={false} />);
    const loud = renderToStaticMarkup(<NotificationBell count={3} current={false} />);
    const many = renderToStaticMarkup(<NotificationBell count={150} current={false} />);
    assert({
      given: 'no unread notifications, then three, then 150',
      should: 'name the bell plainly, then with the count, and cap the badge at 99+',
      actual: [
        quiet.includes('aria-label="Notifications"'),
        badgeOf(quiet),
        loud.includes('aria-label="Notifications, 3 unread"'),
        badgeOf(loud),
        badgeOf(many),
      ],
      expected: [true, null, true, '3', '99+'],
    });
  });

  test('the notifications page open', () => {
    const html = renderToStaticMarkup(<NotificationBell count={0} current />);
    assert({
      given: 'the notifications page is the current stage',
      should: 'mark the bell as the current page',
      actual: html.includes('aria-current="page"'),
      expected: true,
    });
  });

  test('pressing the bell opens the popover, grouped and with Mark all as read', async () => {
    served = [note('m1', 'MENTION'), note('t1', 'TASK_ASSIGNED', { createdAt: new Date(Date.now() - 3 * 86_400_000) })];
    const container = mount(<NotificationBell count={2} current={false} />);
    act(() => {
      (container.querySelector('[aria-label="Notifications, 2 unread"]') as HTMLElement).click();
    });
    await settle(() => {
      if (!document.querySelector('[role=dialog][aria-label=Notifications] [aria-label="Today"]')) throw new Error('not open');
    });
    const dialog = document.querySelector('[role=dialog][aria-label=Notifications]') as HTMLElement;
    assert({
      given: 'the bell pressed with two unread notifications',
      should: 'open the Notifications popover grouped Today and Older, with Mark all as read and View all notifications',
      actual: [
        [...dialog.querySelectorAll('section')].map((section) => section.getAttribute('aria-label')),
        [...dialog.querySelectorAll('button')].some((button) => button.textContent === 'Mark all as read'),
        dialog.querySelector('a[href="/notifications"]')?.textContent,
        dialog.querySelector('a[href="/account/notifications"]')?.getAttribute('aria-label'),
      ],
      expected: [['Today', 'Older'], true, 'View all notifications', 'Notification settings'],
    });
  });

  test('Mark all as read clears the dots and the button', async () => {
    served = [note('m1', 'MENTION')];
    const container = mount(<NotificationBell count={1} current={false} />);
    act(() => {
      (container.querySelector('[aria-label="Notifications, 1 unread"]') as HTMLElement).click();
    });
    await settle(() => {
      if (!document.querySelector('[role=dialog] [aria-label="Unread"]')) throw new Error('not open');
    });
    const dialog = document.querySelector('[role=dialog][aria-label=Notifications]') as HTMLElement;
    act(() => {
      ([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Mark all as read') as HTMLElement).click();
    });
    await settle(() => {
      if (patch.mock.calls.length === 0) throw new Error('not patched');
    });
    assert({
      given: 'Mark all as read pressed in the popover',
      should: 'PATCH read-all, then clear the unread dot and hide the button',
      actual: [
        patch.mock.calls[0]?.[0],
        dialog.querySelectorAll('[aria-label="Unread"]').length,
        [...dialog.querySelectorAll('button')].some((button) => button.textContent === 'Mark all as read'),
      ],
      expected: ['/api/notifications/read-all', 0, false],
    });
  });

  test('hides the wallet-cap and skipped-automation rows', async () => {
    served = [note('w1', 'WALLET_CAP_ALERT', { title: 'A spending cap is at 80%' }), note('m1', 'MENTION')];
    const container = mount(<NotificationBell count={2} current={false} />);
    act(() => {
      (container.querySelector('[aria-label="Notifications, 2 unread"]') as HTMLElement).click();
    });
    await settle(() => {
      if (!document.querySelector('[role=dialog] [aria-label="Today"]')) throw new Error('not open');
    });
    assert({
      given: 'a wallet cap alert and a mention',
      should: 'list only the mention until PR #2871 lands',
      actual: document.querySelector('[role=dialog]')?.textContent?.includes('A spending cap'),
      expected: false,
    });
  });
});
