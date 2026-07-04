import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { MessageRenderer } from '../MessageRenderer';
import type { ConversationMessage } from '../message-types';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Test User' } }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => null,
}));

function toolPart(overrides: { toolCallId: string; toolName: string; state: string }) {
  return {
    type: `tool-${overrides.toolName}`,
    toolCallId: overrides.toolCallId,
    toolName: overrides.toolName,
    input: {},
    output: { success: true },
    state: overrides.state,
  };
}

function messageWithParts(parts: unknown[]): ConversationMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    parts,
  } as unknown as ConversationMessage & UIMessage;
}

describe('MessageRenderer tool-call grouping — manual expand survives the solo -> group transition', () => {
  it('keeps a manually-expanded solo tool call expanded once it becomes the head of a run', async () => {
    const user = userEvent.setup();

    const solo = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
    ]);

    const { rerender } = render(<MessageRenderer message={solo} />);

    // Solo call renders standalone; expand it.
    const trigger = screen.getByTitle('Pages');
    await user.click(trigger);
    expect(trigger.closest('button')).toHaveAttribute('data-state', 'open');

    // A second consecutive non-diff call streams in — useGroupedParts now
    // folds both into one ToolRunGroupPart at the same array index.
    const grouped = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
      // Still running: the group's status is 'running', so it auto-expands
      // on mount without requiring an extra click — matching the real
      // scenario where a second call joins while it's still in flight.
      toolPart({ toolCallId: 'call-2', toolName: 'read_page', state: 'input-available' }),
    ]);
    rerender(<MessageRenderer message={grouped} />);

    // The group summary header appears...
    expect(screen.getByText(/Ran 2 commands/)).toBeInTheDocument();

    // ...and the first call's row, now nested inside the group, is still expanded.
    const stillOpenTrigger = screen.getByTitle('Pages');
    expect(stillOpenTrigger.closest('button')).toHaveAttribute('data-state', 'open');
  });

  it('leaves an untouched call at its normal default-collapsed state through the same transition', async () => {
    const user = userEvent.setup();

    const solo = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
    ]);

    const { rerender } = render(<MessageRenderer message={solo} />);
    // Deliberately do not click anything — call-1 stays at its default state.
    void user;

    const grouped = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
      // Still running: the group's status is 'running', so it auto-expands
      // on mount without requiring an extra click — matching the real
      // scenario where a second call joins while it's still in flight.
      toolPart({ toolCallId: 'call-2', toolName: 'read_page', state: 'input-available' }),
    ]);
    rerender(<MessageRenderer message={grouped} />);

    const untouchedTrigger = screen.getByTitle('Pages');
    expect(untouchedTrigger.closest('button')).toHaveAttribute('data-state', 'closed');
  });
});
