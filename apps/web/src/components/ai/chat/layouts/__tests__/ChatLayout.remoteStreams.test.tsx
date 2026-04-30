import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be before any imports that trigger the modules
// ---------------------------------------------------------------------------
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => false,
}));

const chatMessagesAreaSpy = vi.fn();
vi.mock('@/components/ai/shared/chat/ChatMessagesArea', () => ({
  ChatMessagesArea: (props: unknown) => {
    chatMessagesAreaSpy(props);
    return <div data-testid="chat-messages-area" />;
  },
}));

vi.mock('@/components/ui/floating-input/InputPositioner', () => ({
  InputPositioner: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/floating-input/InputCard', () => ({
  InputCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/hooks/useEnterToSend', () => ({
  useEnterToSend: () => true,
}));

vi.mock('../WelcomeContent', () => ({
  WelcomeContent: () => <div data-testid="welcome-content" />,
}));

import React from 'react';
import { ChatLayout } from '../ChatLayout';
import type { PendingStream } from '@/stores/usePendingStreamsStore';

const BASE_PROPS = {
  messages: [{ id: '1', role: 'user' as const, content: 'hello', parts: [{ type: 'text' as const, text: 'hello' }] }],
  input: '',
  onInputChange: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  isStreaming: false,
  isLoading: false,
};

const makeStream = (overrides: Partial<PendingStream>): PendingStream => ({
  messageId: 'msg-1',
  pageId: 'page-1',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'u-1', displayName: 'Alice' },
  text: '',
  isOwn: false,
  ...overrides,
});

const lastMessagesAreaProps = () => {
  const calls = chatMessagesAreaSpy.mock.calls;
  return calls[calls.length - 1]?.[0] as { remoteStreams?: PendingStream[] } | undefined;
};

describe('ChatLayout — remoteStreams plumbing', () => {
  beforeEach(() => {
    chatMessagesAreaSpy.mockClear();
  });

  it('given no remoteStreams, passes undefined or empty array down to ChatMessagesArea', () => {
    render(<ChatLayout {...BASE_PROPS} />);
    const props = lastMessagesAreaProps();
    expect(props?.remoteStreams ?? []).toEqual([]);
  });

  it('given a remote pending stream, forwards it to ChatMessagesArea', () => {
    const remoteStreams = [makeStream({ messageId: 'msg-1' })];
    render(<ChatLayout {...BASE_PROPS} remoteStreams={remoteStreams} />);
    expect(lastMessagesAreaProps()?.remoteStreams).toEqual(remoteStreams);
  });

  it('given multiple concurrent remote streams, forwards all of them in order', () => {
    const remoteStreams = [
      makeStream({ messageId: 'msg-1', triggeredBy: { userId: 'u-1', displayName: 'Alice' } }),
      makeStream({ messageId: 'msg-2', triggeredBy: { userId: 'u-2', displayName: 'Bob' } }),
    ];
    render(<ChatLayout {...BASE_PROPS} remoteStreams={remoteStreams} />);
    expect(lastMessagesAreaProps()?.remoteStreams).toEqual(remoteStreams);
  });

  it('given remoteStreams with no local messages, still mounts the messages area', () => {
    const noMessages = { ...BASE_PROPS, messages: [] };
    const remoteStreams = [makeStream({ messageId: 'msg-1' })];
    const { getByTestId } = render(<ChatLayout {...noMessages} remoteStreams={remoteStreams} />);
    expect(getByTestId('chat-messages-area')).toBeTruthy();
    expect(lastMessagesAreaProps()?.remoteStreams).toEqual(remoteStreams);
  });
});
