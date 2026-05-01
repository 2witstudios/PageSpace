import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { PendingStream } from '@/stores/usePendingStreamsStore';

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede the import of the component under test
// ---------------------------------------------------------------------------
const messageRendererSpy = vi.fn();
vi.mock('../MessageRenderer', () => ({
  MessageRenderer: (props: unknown) => {
    messageRendererSpy(props);
    return <div data-testid="message-renderer" />;
  },
}));

vi.mock('../StreamingIndicator', () => ({
  StreamingIndicator: () => <div data-testid="streaming-indicator" />,
}));

vi.mock('../UndoAiChangesDialog', () => ({
  UndoAiChangesDialog: () => null,
}));

vi.mock('../VirtualizedMessageList', () => ({
  VirtualizedMessageList: ({ messages, renderMessage }: {
    messages: UIMessage[];
    renderMessage: (m: UIMessage, idx: number) => React.ReactNode;
  }) => <div>{messages.map((m, i) => renderMessage(m, i))}</div>,
}));

vi.mock('@/components/ai/ui/conversation', () => ({
  Conversation: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConversationContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConversationScrollButton: () => null,
  useConversationScrollRef: () => ({ current: null }),
}));

vi.mock('use-stick-to-bottom', () => ({
  useStickToBottomContext: () => ({ scrollToBottom: vi.fn() }),
}));

vi.mock('@/hooks/useChatPullToRefresh', () => ({
  useChatPullToRefresh: () => ({
    pullDistance: 0,
    isRefreshing: false,
    hasReachedThreshold: false,
    touchHandlers: {
      onTouchStart: vi.fn(),
      onTouchMove: vi.fn(),
      onTouchEnd: vi.fn(),
      onTouchCancel: vi.fn(),
    },
  }),
}));

import React from 'react';
import { ChatMessagesArea } from '../ChatMessagesArea';

const makeStream = (overrides: Partial<PendingStream>): PendingStream => ({
  messageId: 'remote-1',
  pageId: 'page-1',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'u-1', displayName: 'Alice' },
  parts: [],
  isOwn: false,
  ...overrides,
});

const textPart = (text: string) => ({ type: 'text' as const, text });

const makeMessage = (id: string, role: UIMessage['role'] = 'user', text = ''): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
});

const remoteRendererCalls = () =>
  messageRendererSpy.mock.calls
    .map((args) => args[0] as {
      message: { id: string; role: string; parts: Array<{ type: string; text: string }>; messageType?: string };
      isStreaming?: boolean;
      onEdit?: unknown;
      onDelete?: unknown;
      onRetry?: unknown;
    })
    .filter((p) => p.isStreaming === true);

describe('ChatMessagesArea — remoteStreams rendering', () => {
  beforeEach(() => {
    messageRendererSpy.mockClear();
  });

  it('given a non-empty remoteStreams, renders one MessageRenderer per stream with synthesized assistant message and isStreaming=true', () => {
    const remoteStreams = [
      makeStream({ messageId: 'remote-a', parts: [textPart('partial response')] }),
      makeStream({ messageId: 'remote-b', parts: [] }),
    ];

    render(
      <ChatMessagesArea
        messages={[]}
        isLoading={false}
        isStreaming={false}
        remoteStreams={remoteStreams}
      />
    );

    const synthesizedCalls = remoteRendererCalls();
    expect(synthesizedCalls).toHaveLength(2);

    expect(synthesizedCalls[0].message).toEqual({
      id: 'remote-a',
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial response' }],
      messageType: 'standard',
    });
    expect(synthesizedCalls[0].isStreaming).toBe(true);
    expect(synthesizedCalls[0].onEdit).toBeUndefined();
    expect(synthesizedCalls[0].onDelete).toBeUndefined();
    expect(synthesizedCalls[0].onRetry).toBeUndefined();

    expect(synthesizedCalls[1].message.id).toBe('remote-b');
    expect(synthesizedCalls[1].message.parts).toEqual([]);
  });

  it('given a remote stream whose parts include a tool part, forwards the full tool shape to MessageRenderer (no flattening to text)', () => {
    const toolPart = {
      type: 'tool-list_pages',
      toolCallId: 'tc1',
      toolName: 'list_pages',
      state: 'output-available',
      input: { driveId: 'd1' },
      output: { pages: [{ id: 'p1' }] },
    };
    const remoteStreams = [
      makeStream({
        messageId: 'remote-tool',
        parts: [textPart('let me check'), toolPart as never],
      }),
    ];

    render(
      <ChatMessagesArea
        messages={[]}
        isLoading={false}
        isStreaming={false}
        remoteStreams={remoteStreams}
      />
    );

    const [call] = remoteRendererCalls();
    expect(call.message.parts).toEqual([{ type: 'text', text: 'let me check' }, toolPart]);
  });

  it('given a remote stream whose messageId is already present in messages, does NOT render the duplicate', () => {
    const remoteStreams = [
      makeStream({ messageId: 'msg-already-landed', parts: [textPart('finalised text')] }),
      makeStream({ messageId: 'msg-still-streaming', parts: [textPart('in progress')] }),
    ];

    render(
      <ChatMessagesArea
        messages={[makeMessage('msg-already-landed', 'assistant', 'finalised text')]}
        isLoading={false}
        isStreaming={false}
        remoteStreams={remoteStreams}
      />
    );

    const synthesizedIds = remoteRendererCalls().map((c) => c.message.id);
    expect(synthesizedIds).toEqual(['msg-still-streaming']);
  });

  it('given an empty remoteStreams, renders no synthesized streaming MessageRenderer beyond the messages', () => {
    render(
      <ChatMessagesArea
        messages={[makeMessage('m-1', 'user', 'hi')]}
        isLoading={false}
        isStreaming={false}
        remoteStreams={[]}
      />
    );

    expect(remoteRendererCalls()).toHaveLength(0);
  });

  it('given remoteStreams is omitted entirely, renders without crashing and produces no synthesized streams', () => {
    expect(() =>
      render(
        <ChatMessagesArea
          messages={[makeMessage('m-1', 'user', 'hi')]}
          isLoading={false}
          isStreaming={false}
        />
      )
    ).not.toThrow();
    expect(remoteRendererCalls()).toHaveLength(0);
  });

  it('given remoteStreams but isLoading=true, suppresses synthesized renders (loading skeleton owns the area)', () => {
    render(
      <ChatMessagesArea
        messages={[]}
        isLoading={true}
        isStreaming={false}
        remoteStreams={[makeStream({ messageId: 'remote-x', parts: [textPart('partial')] })]}
      />
    );

    expect(remoteRendererCalls()).toHaveLength(0);
  });
});
