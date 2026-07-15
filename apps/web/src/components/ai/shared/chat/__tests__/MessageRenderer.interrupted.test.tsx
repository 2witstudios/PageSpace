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

  // The regression this guards against: an empty-content interrupted message never renders a
  // TextBlock, so TextBlock's own footer (the only place the retry BUTTON usually lives) never
  // appears either — the hint text alone is not an actionable control.
  it('given an interrupted message with zero content and a retry handler, still exposes an actual retry button', () => {
    render(
      <MessageRenderer
        message={assistantMessage({ status: 'interrupted', parts: [{ type: 'text', text: '' }] })}
        onRetry={() => {}}
        isLastAssistantMessage
      />,
    );

    expect(screen.getByTitle('Retry this message')).toBeInTheDocument();
  });

  // The badge must not be coupled to any one part shape: a stream can die mid-tool-call, before
  // any trailing text ever arrives, leaving `parts` entirely tool-only (no text-group at all).
  // Nesting the badge inside the text block's own render would make it vanish for exactly this
  // message — the affordance must render at the message level, independent of which groups exist.
  it('given an interrupted message with ONLY a tool part (no text ever arrived), still shows the badge', () => {
    render(
      <MessageRenderer
        message={assistantMessage({
          status: 'interrupted',
          parts: [
            {
              type: 'tool-search',
              toolCallId: 'tc-1',
              toolName: 'search',
              input: { q: 'hello' },
              state: 'input-available',
            } as unknown as UIMessage['parts'][number],
          ],
        })}
      />,
    );

    expect(screen.getByText('Interrupted')).toBeInTheDocument();
  });

  it('given an interrupted message with ONLY a tool part and a retry handler, still exposes an actual retry button', () => {
    render(
      <MessageRenderer
        message={assistantMessage({
          status: 'interrupted',
          parts: [
            {
              type: 'tool-search',
              toolCallId: 'tc-1',
              toolName: 'search',
              input: { q: 'hello' },
              state: 'input-available',
            } as unknown as UIMessage['parts'][number],
          ],
        })}
        onRetry={() => {}}
        isLastAssistantMessage
      />,
    );

    expect(screen.getByTitle('Retry this message')).toBeInTheDocument();
  });

  // The other half of the fix: a message that DID stream real text before dying already gets a
  // retry button from TextBlock's own footer — the message-level button must not duplicate it.
  // TextBlock's footer (MessageActionButtons) only renders at all when BOTH onEdit and onDelete
  // are supplied (not onRetry alone), matching how the real chat surfaces always wire all three
  // together — so this test must supply them too, or TextBlock's footer never appears and the
  // "exactly one" assertion would trivially pass on zero.
  it('given an interrupted message WITH real text content and a retry handler, shows exactly ONE retry button', () => {
    render(
      <MessageRenderer
        message={assistantMessage({ status: 'interrupted' })}
        onEdit={async () => {}}
        onDelete={async () => {}}
        onRetry={() => {}}
        isLastAssistantMessage
      />,
    );

    expect(screen.getAllByTitle('Retry this message')).toHaveLength(1);
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
