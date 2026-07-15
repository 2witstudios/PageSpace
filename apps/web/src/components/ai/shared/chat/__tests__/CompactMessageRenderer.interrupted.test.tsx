import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { CompactMessageRenderer } from '../CompactMessageRenderer';
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

// Parity coverage for the sidebar/compact surface — this is the actual renderer behind
// SidebarChatTab (global-assistant conversations, the exact channel type
// materializeInterruptedStream's page-vs-global routing exists for). Mirrors
// MessageRenderer.interrupted.test.tsx so the two surfaces can't silently drift.
describe('CompactMessageRenderer — interrupted affordance', () => {
  it('given an assistant message with status "interrupted", shows the Interrupted badge', () => {
    render(<CompactMessageRenderer message={assistantMessage({ status: 'interrupted' })} />);

    expect(screen.getByText('Interrupted')).toBeInTheDocument();
  });

  it('given an assistant message with status "complete", shows no badge', () => {
    render(<CompactMessageRenderer message={assistantMessage({ status: 'complete' })} />);

    expect(screen.queryByText('Interrupted')).not.toBeInTheDocument();
  });

  it('given an interrupted message with a retry handler, shows the retry hint text', () => {
    render(
      <CompactMessageRenderer
        message={assistantMessage({ status: 'interrupted' })}
        onRetry={() => {}}
        isLastAssistantMessage
      />,
    );

    expect(screen.getByText(/retry to continue/i)).toBeInTheDocument();
  });

  it('given an interrupted message with no retry handler available, shows the badge without a retry hint', () => {
    render(<CompactMessageRenderer message={assistantMessage({ status: 'interrupted' })} />);

    expect(screen.getByText('Interrupted')).toBeInTheDocument();
    expect(screen.queryByText(/retry to continue/i)).not.toBeInTheDocument();
  });

  // The bug this test guards against: CompactTextBlock's own `!content.trim()` guard hides an
  // empty text block entirely. Without a message-level badge independent of that guard, a
  // global-assistant stream that died before any text arrived would render as nothing at all in
  // the sidebar — reproducing the exact silent-loss bug this feature exists to fix.
  it('given an interrupted message with zero content (died before any part arrived), still renders the badge', () => {
    render(
      <CompactMessageRenderer
        message={assistantMessage({ status: 'interrupted', parts: [{ type: 'text', text: '' }] })}
      />,
    );

    expect(screen.getByText('Interrupted')).toBeInTheDocument();
  });

  it('given an interrupted message with ONLY a tool part (no text ever arrived), still shows the badge', () => {
    render(
      <CompactMessageRenderer
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

  it('given a USER message with status "interrupted" (should never happen, but must never mislabel), shows no badge', () => {
    render(
      <CompactMessageRenderer
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
