// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { inboxThreadsFrom } from '../message-model/from-api';
import type { InboxItem, MessageThread } from '../message-model/message';

const { inbox } = vi.hoisted(() => ({ inbox: { threads: [] as readonly MessageThread[] } }));
vi.mock('../use-messages/use-messages', () => ({ useInbox: () => ({ ...inbox, retry: () => {} }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
import { InboxPane } from './inbox-pane';

afterEach(cleanup);

test('Given overlapping inbox pages, should show each conversation once and replace rows when filtering', () => {
  const channel: InboxItem = {
    id: 'c1',
    type: 'channel',
    driveId: 'd1',
    name: 'Launch',
    avatarUrl: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    lastMessageSender: null,
    unreadCount: 0,
  };
  const dm: InboxItem = { ...channel, id: 'm1', type: 'dm', name: 'Dana' };
  inbox.threads = inboxThreadsFrom([channel, dm, channel, dm]);
  render(<InboxPane />);
  expect(screen.getAllByRole('link')).toHaveLength(2);
  for (const label of ['Direct', 'Channels', 'All', 'Direct', 'Channels']) {
    fireEvent.click(screen.getByRole('radio', { name: label }));
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(
      label === 'Direct' ? ['/dm/m1'] : label === 'Channels' ? ['/d1/messages/c1'] : ['/d1/messages/c1', '/dm/m1'],
    );
  }
});
