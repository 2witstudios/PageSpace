// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  client: { apiFetch: vi.fn(), apiStream: vi.fn() },
  path: '/',
  conversations: undefined as unknown,
  streams: undefined as unknown,
  revalidate: vi.fn(async () => undefined),
  deleteConversation: vi.fn(async () => undefined),
  dispatch: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => state.path }));
vi.mock('@/api/swr-provider', () => ({ useApiClient: () => state.client }));
vi.mock('swr', () => ({ default: () => ({ data: state.streams }) }));
vi.mock('@/retained-adapters/retained-provider', () => ({ RetainedSurface: ({ children }: { children: unknown }) => children }));
vi.mock('@/retained/components/layout/right-sidebar/ai-assistant/SidebarActivityTab', () => ({
  default: ({ pageId }: { pageId: string }) => <div data-testid="activity">{pageId}</div>,
}));
vi.mock('../chat-api/chat-api', () => ({
  chatPaths: { activeStreams: '/streams' },
  deleteConversation: state.deleteConversation,
}));
vi.mock('../use-chat-data/use-chat-data', () => ({
  useAgentConversations: () => ({ conversations: state.conversations, revalidate: state.revalidate }),
}));
vi.mock('../../store/transactions', () => ({ dispatch: state.dispatch, transactions: { openConversation: 'openConversation' } }));

import { ImagoHistory } from './imago-history';

const convo = (id: string, title: string) => ({
  id,
  title,
  preview: '',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  messageCount: 1,
  isShared: false,
});

afterEach(() => {
  cleanup();
  state.path = '/';
  state.conversations = undefined;
  state.streams = undefined;
  vi.clearAllMocks();
});

describe('ImagoHistory', () => {
  it('shows the empty state when there are no conversations, and a no-match state when a search finds none', () => {
    state.conversations = [];
    render(<ImagoHistory agentId="a1" activeId={null} />);
    expect(screen.getByText('No conversations yet.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'zzz' } });
    expect(screen.getByText('No conversations match.')).toBeTruthy();
  });

  it('filters the list and says nothing matches', () => {
    state.conversations = [convo('c1', 'Launch plan'), convo('c2', 'Budget')];
    render(<ImagoHistory agentId="a1" activeId="c2" />);
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'budget' } });
    expect(screen.queryByText('Launch plan')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'nope' } });
    expect(screen.getByText('No conversations match.')).toBeTruthy();
  });

  it('opens a conversation and marks one still generating', () => {
    state.conversations = [convo('c1', 'Launch plan')];
    state.streams = { streams: [{ conversationId: 'c1' }] };
    render(<ImagoHistory agentId="a1" activeId={null} />);
    expect(screen.getByText('Generating…')).toBeTruthy();
    fireEvent.click(screen.getByText('Launch plan'));
    expect(state.dispatch).toHaveBeenCalledWith('openConversation', 'c1');
  });

  it('treats a missing conversation list as empty', () => {
    render(<ImagoHistory agentId="a1" activeId={null} />);
    expect(screen.getByText('No conversations yet.')).toBeTruthy();
  });

  it('confirms before deleting, can cancel, then deletes and revalidates', async () => {
    state.conversations = [convo('c1', 'Launch plan')];
    render(<ImagoHistory agentId="a1" activeId={null} />);
    fireEvent.click(screen.getByLabelText('Delete Launch plan'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Delete?')).toBeNull();
    fireEvent.click(screen.getByLabelText('Delete Launch plan'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(state.revalidate).toHaveBeenCalled());
    expect(state.deleteConversation).toHaveBeenCalledWith(state.client, 'a1', 'c1');
  });

  it('offers no delete when there is no agent', () => {
    state.conversations = [convo('c1', 'Launch plan')];
    render(<ImagoHistory agentId={null} activeId={null} />);
    expect(screen.queryByLabelText('Delete Launch plan')).toBeNull();
  });

  it('switches to Activity: a prompt with no page open, the page activity when one is', () => {
    render(<ImagoHistory agentId="a1" activeId={null} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByText('Open a page to see its changes here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByText('No conversations yet.')).toBeTruthy();
  });

  it('shows the open page activity', () => {
    state.path = '/p/pageidabc123';
    render(<ImagoHistory agentId="a1" activeId={null} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByTestId('activity').textContent).toBe('pageidabc123');
  });
});
