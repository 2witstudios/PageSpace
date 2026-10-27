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

describe('MessageRenderer tool-call grouping — closed by default, no auto-expand from running/error status', () => {
  it('keeps a manually-expanded solo tool call expanded once it becomes the head of a run', async () => {
    const user = userEvent.setup();

    const solo = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
    ]);

    const { rerender } = render(<MessageRenderer message={solo} />);

    // Solo call renders through the same persistent run component, closed by
    // default; expand it.
    const trigger = screen.getByTitle('Pages');
    expect(trigger.closest('button')).toHaveAttribute('data-state', 'closed');
    await user.click(trigger);
    expect(trigger.closest('button')).toHaveAttribute('data-state', 'open');

    // A second consecutive non-diff call streams in, still running — since
    // both share the same runKey (derived from call-1's toolCallId, which
    // never changes as the run grows), this is the *same* component
    // instance, not a remount, so the manual toggle survives.
    const grouped = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
      toolPart({ toolCallId: 'call-2', toolName: 'read_page', state: 'input-available' }),
    ]);
    rerender(<MessageRenderer message={grouped} />);

    // The group summary header appears, still open (no remount, no reset).
    const groupTrigger = screen.getByText(/Ran 2 commands/);
    expect(groupTrigger.closest('button')).toHaveAttribute('data-state', 'open');

    // ...and the first call's row, now nested inside the group, is also
    // expanded — the solo toggle seeded the row's own key too.
    const nestedTrigger = screen.getByTitle('Pages');
    expect(nestedTrigger.closest('button')).toHaveAttribute('data-state', 'open');
  });

  it('leaves an untouched run closed by default through solo -> group growth, even while running', async () => {
    const solo = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
    ]);

    const { rerender } = render(<MessageRenderer message={solo} />);
    // Deliberately do not click anything — the run stays at its default state.

    const grouped = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
      // Still running — with the old auto-expand behavior this would pop
      // open on its own; it must not.
      toolPart({ toolCallId: 'call-2', toolName: 'read_page', state: 'input-available' }),
    ]);
    rerender(<MessageRenderer message={grouped} />);

    const groupTrigger = screen.getByText(/Ran 2 commands/);
    expect(groupTrigger.closest('button')).toHaveAttribute('data-state', 'closed');
    // Closed means Radix doesn't mount the nested rows at all.
    expect(screen.queryByTitle('Pages')).not.toBeInTheDocument();
  });

  it('leaves a run with an errored call closed by default (error shown via icon only, never a forced expand)', () => {
    const grouped = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
      toolPart({ toolCallId: 'call-2', toolName: 'read_page', state: 'output-error' }),
    ]);

    render(<MessageRenderer message={grouped} />);

    const groupTrigger = screen.getByText(/Ran 2 commands/);
    expect(groupTrigger.closest('button')).toHaveAttribute('data-state', 'closed');
  });
});
