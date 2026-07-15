import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { MessageRenderer } from '../MessageRenderer';
import type { ConversationMessage } from '../message-types';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Test User' } }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => null,
}));

function assistantMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Partial reply before the process died' }],
    ...overrides,
  } as unknown as ConversationMessage & UIMessage;
}

describe('MessageRenderer — interrupted affordance', () => {
  it('given an assistant message with status "interrupted", shows the Interrupted badge', () => {
    render(<MessageRenderer message={assistantMessage({ status: 'interrupted' })} />);

    expect(screen.getByText('Interrupted')).toBeInTheDocument();
  });

  it('given an assistant message with status "complete", shows no badge', () => {
    render(<MessageRenderer message={assistantMessage({ status: 'complete' })} />);

    expect(screen.queryByText('Interrupted')).not.toBeInTheDocument();
  });

  it('given no status at all (a pre-column row), shows no badge', () => {
    render(<MessageRenderer message={assistantMessage()} />);

    expect(screen.queryByText('Interrupted')).not.toBeInTheDocument();
  });

  it('given an interrupted message with a retry handler, shows the retry hint text', () => {
    render(
      <MessageRenderer
        message={assistantMessage({ status: 'interrupted' })}
        onRetry={() => {}}
        isLastAssistantMessage
      />,
    );

    expect(screen.getByText(/retry to continue/i)).toBeInTheDocument();
  });

  it('given an interrupted message with no retry handler available, shows the badge without a retry hint', () => {
    render(<MessageRenderer message={assistantMessage({ status: 'interrupted' })} />);

    expect(screen.getByText('Interrupted')).toBeInTheDocument();
    expect(screen.queryByText(/retry to continue/i)).not.toBeInTheDocument();
  });

  it('given an interrupted message with zero content (died before any part arrived), still renders the badge', () => {
    render(
      <MessageRenderer
        message={assistantMessage({ status: 'interrupted', parts: [{ type: 'text', text: '' }] })}
      />,
    );

    expect(screen.getByText('Interrupted')).toBeInTheDocument();
  });

  it('given a USER message with status "interrupted" (should never happen, but must never mislabel), shows no badge', () => {
    render(
      <MessageRenderer
        message={{
          id: 'msg-user',
          role: 'user',
          parts: [{ type: 'text', text: 'hi' }],
          status: 'interrupted',
        } as unknown as ConversationMessage & UIMessage}
      />,
    );

    expect(screen.queryByText('Interrupted')).not.toBeInTheDocument();
  });
});
