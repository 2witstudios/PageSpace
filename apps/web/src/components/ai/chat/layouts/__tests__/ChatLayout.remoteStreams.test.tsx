import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

vi.mock('@/components/ai/shared/chat', () => ({
  ChatMessagesArea: () => <div data-testid="chat-messages-area" />,
}));

vi.mock('@/components/ui/floating-input', () => ({
  InputPositioner: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

// Minimal required props to get the component to render messages area
const BASE_PROPS = {
  messages: [{ id: '1', role: 'user' as const, content: 'hello', parts: [{ type: 'text' as const, text: 'hello' }] }],
  input: '',
  onInputChange: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  isStreaming: false,
  isLoading: false,
};

describe('ChatLayout — remoteStreams', () => {
  it('given no remoteStreams, should render no stream indicators', () => {
    render(<ChatLayout {...BASE_PROPS} />);
    expect(screen.queryByText(/is waiting for AI response/)).toBeNull();
  });

  it('given a remote pending stream, should render StreamingIndicator with display name', () => {
    const remoteStreams = [
      { messageId: 'msg-1', triggeredBy: { displayName: 'Alice' }, text: '' },
    ];
    render(<ChatLayout {...BASE_PROPS} remoteStreams={remoteStreams} />);
    expect(screen.getByText('Alice is waiting for AI response…')).toBeTruthy();
  });

  it('given accumulated ghost text, should render it below the indicator', () => {
    const remoteStreams = [
      { messageId: 'msg-1', triggeredBy: { displayName: 'Alice' }, text: 'Here is my partial response' },
    ];
    render(<ChatLayout {...BASE_PROPS} remoteStreams={remoteStreams} />);
    expect(screen.getByText('Here is my partial response')).toBeTruthy();
  });

  it('given empty ghost text, should not render the ghost text paragraph', () => {
    const remoteStreams = [
      { messageId: 'msg-1', triggeredBy: { displayName: 'Alice' }, text: '' },
    ];
    const { container } = render(<ChatLayout {...BASE_PROPS} remoteStreams={remoteStreams} />);
    // The muted text paragraph should not be present when text is empty
    const paras = container.querySelectorAll('p.text-muted-foreground');
    expect(paras).toHaveLength(0);
  });

  it('given multiple concurrent remote streams, should render one indicator per stream', () => {
    const remoteStreams = [
      { messageId: 'msg-1', triggeredBy: { displayName: 'Alice' }, text: '' },
      { messageId: 'msg-2', triggeredBy: { displayName: 'Bob' }, text: '' },
    ];
    render(<ChatLayout {...BASE_PROPS} remoteStreams={remoteStreams} />);
    expect(screen.getByText('Alice is waiting for AI response…')).toBeTruthy();
    expect(screen.getByText('Bob is waiting for AI response…')).toBeTruthy();
  });

  it('given remoteStreams with no local messages, should still show the messages area', () => {
    const noMessages = { ...BASE_PROPS, messages: [] };
    const remoteStreams = [
      { messageId: 'msg-1', triggeredBy: { displayName: 'Alice' }, text: '' },
    ];
    render(<ChatLayout {...noMessages} remoteStreams={remoteStreams} />);
    expect(screen.getByTestId('chat-messages-area')).toBeTruthy();
    expect(screen.getByText('Alice is waiting for AI response…')).toBeTruthy();
  });
});
