import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { PendingStream } from '@/stores/usePendingStreamsStore';

// ---------------------------------------------------------------------------
// Mocks: keep CompactMessageRenderer transparent so the test can read the
// rendered text directly. ConversationContent / VirtualizedMessageList /
// useConversationScrollRef are stubs that just render their children — we
// don't care about virtualization or scroll behavior at this layer.
// ---------------------------------------------------------------------------
vi.mock('@/components/ai/ui/conversation', () => ({
  ConversationContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useConversationScrollRef: () => ({ current: null }),
}));

vi.mock('@/components/ai/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    CompactMessageRenderer: ({
      message,
      isStreaming,
    }: {
      message: { id: string; role: string; parts: { type: string; text?: string }[] };
      isStreaming?: boolean;
    }) => {
      const text = message.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('');
      return (
        <div
          data-testid={`message-${message.id}`}
          data-role={message.role}
          data-streaming={isStreaming ? 'true' : 'false'}
        >
          {text}
        </div>
      );
    },
  };
});

const virtualizedMessageListSpy = vi.fn();

vi.mock('@/components/ai/shared/chat', () => ({
  VirtualizedMessageList: (props: {
    messages: UIMessage[];
    renderMessage: (m: UIMessage) => React.ReactNode;
    onScrollNearTop?: () => void;
    isLoadingOlder?: boolean;
  }) => {
    virtualizedMessageListSpy(props);
    return <div data-testid="virtualized-branch">{props.messages.map(props.renderMessage)}</div>;
  },
  UndoAiChangesDialog: () => null,
}));

import { SidebarMessagesContent } from '../SidebarChatTab';

const userMessage = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

const assistantMessage = (id: string, text: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
});

const stream = (overrides: Partial<PendingStream>): PendingStream => ({
  messageId: 'msg-stream',
  pageId: 'user:u1:global',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice' },
  parts: [],
  isOwn: false,
  ...overrides,
});

const noopHandlers = {
  handleEdit: vi.fn(),
  handleDelete: vi.fn(),
  handleRetry: vi.fn(),
  handleUndoFromHere: vi.fn(),
};

const baseProps = {
  ...noopHandlers,
  assistantName: 'Global Assistant',
  contextLabel: null,
  lastAssistantMessageId: undefined,
  lastUserMessageId: undefined,
  displayIsStreaming: false,
};

describe('SidebarMessagesContent — multiplayer remote stream rendering (Task 3)', () => {
  it('given a remote stream for the active conversation, the sidebar should render it as a streaming assistant bubble holding the stream text', () => {
    render(
      <SidebarMessagesContent
        {...baseProps}
        messages={[]}
        remoteStreams={[stream({ messageId: 'msg-remote', parts: [{ type: 'text', text: 'partial response' }] })]}
      />,
    );

    const node = screen.getByTestId('message-msg-remote');
    expect(node.textContent).toBe('partial response');
    expect(node.getAttribute('data-role')).toBe('assistant');
    expect(node.getAttribute('data-streaming')).toBe('true');
  });

  it('given a remote stream whose messageId is already in messages, the duplicate render should be suppressed', () => {
    render(
      <SidebarMessagesContent
        {...baseProps}
        messages={[assistantMessage('msg-shared', 'final landed')]}
        remoteStreams={[
          stream({ messageId: 'msg-shared', parts: [{ type: 'text', text: 'should not show as duplicate' }] }),
        ]}
      />,
    );

    // The persisted message renders; the duplicate stream entry does not.
    expect(screen.queryAllByTestId('message-msg-shared')).toHaveLength(1);
    expect(screen.getByTestId('message-msg-shared').textContent).toBe('final landed');
  });

  it('given streams and messages with no overlap, the streams render BELOW the messages', () => {
    const { container } = render(
      <SidebarMessagesContent
        {...baseProps}
        messages={[userMessage('msg-u', 'user question')]}
        remoteStreams={[stream({ messageId: 'msg-r', parts: [{ type: 'text', text: 'remote answer' }] })]}
      />,
    );

    const items = Array.from(container.querySelectorAll('[data-testid^="message-"]'));
    expect(items.map((el) => el.getAttribute('data-testid'))).toEqual([
      'message-msg-u',
      'message-msg-r',
    ]);
  });

  it('given empty messages and an empty stream list, the empty-state placeholder should render', () => {
    render(
      <SidebarMessagesContent
        {...baseProps}
        messages={[]}
        remoteStreams={[]}
      />,
    );

    expect(screen.getByText('Global Assistant')).toBeDefined();
    expect(screen.queryByTestId(/^message-/)).toBeNull();
  });

  it('given empty messages but a non-empty remote stream, the empty-state placeholder should NOT render (the stream is the visible content)', () => {
    render(
      <SidebarMessagesContent
        {...baseProps}
        messages={[]}
        remoteStreams={[stream({ messageId: 'msg-only', parts: [{ type: 'text', text: 'mid-stream content' }] })]}
      />,
    );

    expect(screen.queryByText('Global Assistant')).toBeNull();
    expect(screen.getByTestId('message-msg-only')).toBeDefined();
  });

  it('given multiple remote streams, all non-deduped streams should render in the order they arrived', () => {
    render(
      <SidebarMessagesContent
        {...baseProps}
        messages={[]}
        remoteStreams={[
          stream({ messageId: 'msg-a', parts: [{ type: 'text', text: 'first' }] }),
          stream({ messageId: 'msg-b', parts: [{ type: 'text', text: 'second' }] }),
          stream({ messageId: 'msg-c', parts: [{ type: 'text', text: 'third' }] }),
        ]}
      />,
    );

    expect(screen.getByTestId('message-msg-a').textContent).toBe('first');
    expect(screen.getByTestId('message-msg-b').textContent).toBe('second');
    expect(screen.getByTestId('message-msg-c').textContent).toBe('third');
  });
});

// PR 6 review (CodeRabbit): the regular (non-virtualized) branch had no scroll listener at
// all, so onScrollNearTop/isLoadingOlder were only ever reachable once a conversation
// crossed SIDEBAR_VIRTUALIZATION_THRESHOLD (30) messages — "load older" was completely
// unreachable below that, no matter how much older history existed server-side.
describe('SidebarMessagesContent — virtualization forced by hasMoreOlder (PR 6 review)', () => {
  it('given fewer messages than the virtualization threshold and hasMoreOlder=true, should still render via VirtualizedMessageList (which alone wires onScrollNearTop)', () => {
    virtualizedMessageListSpy.mockClear();
    const onScrollNearTop = vi.fn();

    render(
      <SidebarMessagesContent
        {...baseProps}
        messages={[userMessage('m1', 'hi'), assistantMessage('m2', 'hello')]}
        remoteStreams={[]}
        onScrollNearTop={onScrollNearTop}
        isLoadingOlder={false}
        hasMoreOlder={true}
      />,
    );

    expect(screen.getByTestId('virtualized-branch')).toBeDefined();
    expect(virtualizedMessageListSpy).toHaveBeenCalledTimes(1);
    expect(virtualizedMessageListSpy.mock.calls[0][0].onScrollNearTop).toBe(onScrollNearTop);
  });

  it('given fewer messages than the virtualization threshold and hasMoreOlder=false, should use the regular (non-virtualized) branch', () => {
    virtualizedMessageListSpy.mockClear();

    render(
      <SidebarMessagesContent
        {...baseProps}
        messages={[userMessage('m1', 'hi'), assistantMessage('m2', 'hello')]}
        remoteStreams={[]}
        onScrollNearTop={vi.fn()}
        isLoadingOlder={false}
        hasMoreOlder={false}
      />,
    );

    expect(screen.queryByTestId('virtualized-branch')).toBeNull();
    expect(virtualizedMessageListSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('message-m1')).toBeDefined();
    expect(screen.getByTestId('message-m2')).toBeDefined();
  });

  it('given hasMoreOlder is undefined (not yet loaded), should default to the regular branch', () => {
    virtualizedMessageListSpy.mockClear();

    render(
      <SidebarMessagesContent
        {...baseProps}
        messages={[userMessage('m1', 'hi')]}
        remoteStreams={[]}
      />,
    );

    expect(screen.queryByTestId('virtualized-branch')).toBeNull();
  });
});
