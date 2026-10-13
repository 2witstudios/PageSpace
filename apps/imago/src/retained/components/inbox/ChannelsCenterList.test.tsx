// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import type { InboxItem, InboxResponse } from '@pagespace/lib/types';
import { mount, unmountAll, typeInto } from '@/ui/test-support/dom';
import ChannelsCenterList from './ChannelsCenterList';

const fixtures = vi.hoisted(() => ({
  swr: { data: undefined as unknown, error: undefined as unknown, isLoading: false },
  keys: [] as string[],
  fetchWithAuth: vi.fn(),
}));

vi.mock('swr', () => ({
  default: (key: string) => {
    fixtures.keys.push(key);
    return fixtures.swr;
  },
}));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (url: string) => fixtures.fetchWithAuth(url),
}));
vi.mock('@/retained/hooks/useInboxSocket', () => ({ useInboxSocket: () => {} }));
vi.mock('@/retained/components/inbox/ThreadUnreadBadge', () => ({ ThreadUnreadBadge: () => null }));
vi.mock('@/retained-adapters/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
    createElement('a', { href, ...rest }, children),
}));
vi.mock('@/retained/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement('div', { className }, children),
}));

const item = (overrides: Partial<InboxItem> & { id: string; name: string }): InboxItem => ({
  type: 'channel',
  avatarUrl: null,
  lastMessageAt: null,
  lastMessagePreview: null,
  lastMessageSender: null,
  unreadCount: 0,
  ...overrides,
});

const launch = item({
  id: 'c1', name: 'launch', driveId: 'd1', driveName: 'Studio', unreadCount: 3,
  lastMessageAt: new Date(Date.now() - 60_000).toISOString(), lastMessagePreview: 'ship it', lastMessageSender: 'Sam',
});
const ops = item({ id: 'c2', name: 'ops', driveId: 'd2', driveName: 'Infra' });
const random = item({ id: 'c3', name: 'random', driveId: 'd1', driveName: 'Studio' });

const setInbox = (response: InboxResponse | undefined, extra: Partial<typeof fixtures.swr> = {}) => {
  fixtures.swr = { data: response, error: undefined, isLoading: false, ...extra };
};

const page = (items: InboxItem[], hasMore = false, nextCursor: string | null = null): InboxResponse => ({
  items,
  pagination: { hasMore, nextCursor },
});

const rowNames = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('[role="row"]'))
    .slice(1)
    .map((row) => row.querySelector('[role="cell"] .text-sm.truncate')?.textContent?.trim() ?? '');

const change = (el: HTMLSelectElement, value: string) => {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const click = (el: HTMLElement) => {
  act(() => {
    el.click();
  });
};

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

afterEach(() => {
  unmountAll();
  fixtures.keys = [];
  fixtures.fetchWithAuth.mockReset();
  fixtures.swr = { data: undefined, error: undefined, isLoading: false };
});

describe('ChannelsCenterList on Account › Messages', () => {
  test('requests every readable channel with no driveId', () => {
    setInbox(page([launch]));
    mount(createElement(ChannelsCenterList));
    assert({
      given: 'the account messages page mounts without a drive',
      should: 'fetch channels from the inbox with no driveId',
      actual: fixtures.keys[0],
      expected: '/api/inbox?type=channel&limit=20',
    });
  });

  test('renders the Channels heading, the description and the table columns', () => {
    setInbox(page([launch]));
    const container = mount(createElement(ChannelsCenterList));
    const headings = Array.from(container.querySelectorAll('h1')).map((h) => h.textContent);
    const headers = Array.from(container.querySelectorAll('[role="columnheader"]')).map((h) => h.textContent);
    assert({
      given: 'loaded channels',
      should: 'render the h1 "Channels"',
      actual: headings,
      expected: ['Channels'],
    });
    assert({
      given: 'loaded channels',
      should: 'render the description line',
      actual: container.textContent?.includes('Every channel you can read, across all your drives, newest first.'),
      expected: true,
    });
    assert({
      given: 'loaded channels',
      should: 'render a Channel | Drive | Last message table',
      actual: headers,
      expected: ['Channel', 'Drive', 'Last message'],
    });
  });

  test('shows each channel with its drive and last message time', () => {
    setInbox(page([launch]));
    const container = mount(createElement(ChannelsCenterList));
    const row = container.querySelectorAll('[role="row"]')[1];
    assert({
      given: 'a channel in drive Studio with a recent message',
      should: 'show the drive name in the Drive column',
      actual: row?.querySelectorAll('[role="cell"]')[1]?.textContent?.includes('Studio'),
      expected: true,
    });
    assert({
      given: 'a channel with a last message time',
      should: 'show the relative time in the Last message column',
      actual: row?.querySelectorAll('[role="cell"]')[2]?.textContent?.includes('minute'),
      expected: true,
    });
  });

  test('search filters the loaded rows by channel name', () => {
    setInbox(page([launch, ops, random]));
    const container = mount(createElement(ChannelsCenterList));
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search channels"]');
    if (!search) throw new Error('search input missing');
    typeInto(search, 'RAN');
    assert({
      given: 'the search "RAN"',
      should: 'keep only channels whose name matches, case-insensitively',
      actual: rowNames(container),
      expected: ['random'],
    });
  });

  test('the drive select lists the drives in the loaded rows and filters by drive', () => {
    setInbox(page([launch, ops, random]));
    const container = mount(createElement(ChannelsCenterList));
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Drive"]');
    if (!select) throw new Error('drive select missing');
    const options = Array.from(select.options).map((o) => o.textContent);
    assert({
      given: 'channels from two drives',
      should: 'offer All drives plus each drive that has rows',
      actual: options,
      expected: ['All drives', 'Studio', 'Infra'],
    });
    change(select, 'd2');
    assert({
      given: 'the drive filter set to Infra',
      should: 'show only the channels in that drive',
      actual: rowNames(container),
      expected: ['ops'],
    });
  });

  test('the Unread toggle keeps only rows with unread messages', () => {
    setInbox(page([launch, ops, random]));
    const container = mount(createElement(ChannelsCenterList));
    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Unread');
    if (!toggle) throw new Error('Unread toggle missing');
    click(toggle);
    assert({
      given: 'the Unread toggle is on',
      should: 'mark the toggle pressed and show only channels with unread messages',
      actual: [toggle.getAttribute('aria-pressed'), rowNames(container)],
      expected: ['true', ['launch']],
    });
  });

  test('Load older follows the inbox cursor and appends the next page', async () => {
    setInbox(page([launch], true, 'cursor-1'));
    fixtures.fetchWithAuth.mockResolvedValue(
      Response.json(page([ops], false, null)),
    );
    const container = mount(createElement(ChannelsCenterList));
    const older = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Load older');
    if (!older) throw new Error('Load older missing');
    click(older);
    await flush();
    assert({
      given: 'a next page exists',
      should: 'request the page at the inbox cursor with no driveId',
      actual: fixtures.fetchWithAuth.mock.calls[0]?.[0],
      expected: '/api/inbox?type=channel&limit=20&cursor=cursor-1',
    });
    assert({
      given: 'the next page loaded',
      should: 'append its channels to the rows already shown',
      actual: rowNames(container),
      expected: ['launch', 'ops'],
    });
  });

  test('shows the empty state when the account has no channels', () => {
    setInbox(page([]));
    const container = mount(createElement(ChannelsCenterList));
    assert({
      given: 'no channels in any drive',
      should: 'say "No messages yet"',
      actual: container.textContent?.includes('No messages yet'),
      expected: true,
    });
  });

  test('shows a filtered-empty message when no loaded row matches the filters', () => {
    setInbox(page([launch]));
    const container = mount(createElement(ChannelsCenterList));
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search channels"]');
    if (!search) throw new Error('search input missing');
    typeInto(search, 'nothing-matches');
    assert({
      given: 'a search that matches no loaded channel',
      should: 'explain that no channels match, instead of the first-run empty state',
      actual: [
        container.textContent?.includes('No channels match these filters'),
        container.textContent?.includes('No messages yet'),
      ],
      expected: [true, false],
    });
  });
});
