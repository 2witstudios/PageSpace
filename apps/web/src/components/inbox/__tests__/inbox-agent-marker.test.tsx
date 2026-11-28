/**
 * Agent Signup Phase 2c — the inbox lists (center lists and left sidebars)
 * mark an agent DM partner and an agent last-message sender from accountType,
 * never from the self-chosen name. Human names render unchanged and unmarked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { InboxItem, InboxResponse } from '@pagespace/lib/types';

const { swrState } = vi.hoisted(() => ({ swrState: { data: undefined as InboxResponse | undefined } }));

vi.mock('swr', () => ({
  default: () => ({ data: swrState.data, error: undefined, isLoading: false }),
}));
// Radix ScrollArea loops on resize measurement under jsdom (see useInboxSocket.test.ts).
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/hooks/useInboxSocket', () => ({
  useInboxSocket: () => ({ hasLoadedRef: { current: true } }),
}));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/inbox/ThreadUnreadBadge', () => ({ ThreadUnreadBadge: () => null }));
vi.mock('@/components/shared/FocusTrigger', () => ({ FocusTrigger: () => null }));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('@/components/layout/left-sidebar/SidebarShell', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => false }));
vi.mock('@/lib/dashboard/focus', () => ({ focusDriveId: () => undefined, useFocus: () => ({}) }));

import DMCenterList from '../DMCenterList';
import ChannelsCenterList from '../ChannelsCenterList';
import DMSidebar from '@/components/layout/left-sidebar/DMSidebar';
import ChannelsSidebar from '@/components/layout/left-sidebar/ChannelsSidebar';

const dm = (name: string, accountType?: string | null): InboxItem => ({
  id: `dm-${name}`, type: 'dm', name, accountType, avatarUrl: null,
  lastMessageAt: null, lastMessagePreview: 'hello', lastMessageSender: null, unreadCount: 0,
});

const channel = (sender: string, lastMessageSenderAccountType?: string | null): InboxItem => ({
  id: `ch-${sender}`, type: 'channel', name: 'general', avatarUrl: null,
  lastMessageAt: null, lastMessagePreview: 'hello', lastMessageSender: sender,
  lastMessageSenderAccountType, unreadCount: 0, driveId: 'd1', driveName: 'Drive',
});

const withItems = (items: InboxItem[]) => {
  swrState.data = { items, pagination: { hasMore: false, nextCursor: null } };
};

beforeEach(() => { swrState.data = undefined; });

describe.each([
  ['DMCenterList', () => <DMCenterList />],
  ['DMSidebar', () => <DMSidebar />],
])('%s — agent marker', (_label, renderList) => {
  it('given an agent DM partner, should mark it beside its unchanged name', () => {
    withItems([dm('PageSpace Support', 'agent')]);
    render(renderList());
    expect(screen.getByText('PageSpace Support').textContent).toBe('PageSpace Support');
    expect(screen.getByLabelText('AI agent account')).toBeInTheDocument();
  });

  it('given a human (or untyped) DM partner, should render the name unmarked', () => {
    withItems([dm('Ada', 'human'), dm('Bob')]);
    render(renderList());
    expect(screen.getByText('Ada').textContent).toBe('Ada');
    expect(screen.getByText('Bob').textContent).toBe('Bob');
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });
});

describe.each([
  ['ChannelsCenterList', () => <ChannelsCenterList />],
  ['ChannelsSidebar', () => <ChannelsSidebar />],
])('%s — agent marker', (_label, renderList) => {
  it('given an agent last sender, should mark it in the preview prefix', () => {
    withItems([channel('Helper', 'agent')]);
    render(renderList());
    expect(screen.getByLabelText('AI agent account')).toBeInTheDocument();
    expect(screen.getByText(/hello/).textContent).toBe('HelperAgent: hello');
  });

  it('given a human (or AI page) last sender, should render the prefix byte-identical and unmarked', () => {
    withItems([channel('Ada', 'human'), channel('Triage Agent', null)]);
    render(renderList());
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
    const previews = screen.getAllByText(/hello/).map((el) => el.textContent);
    expect(previews).toEqual(['Ada: hello', 'Triage Agent: hello']);
  });
});
