import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { CompactMessageRenderer } from '../CompactMessageRenderer';
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

// Parity coverage for the sidebar/compact surface, mirroring
// MessageRenderer.toolCallGrouping.test.tsx so the two surfaces can't
// silently drift on the same closed-by-default, no-auto-expand behavior.
describe('CompactMessageRenderer tool-call grouping — closed by default, no auto-expand from running/error status', () => {
  it('keeps a manually-expanded solo tool call expanded once it becomes the head of a run', async () => {
    const user = userEvent.setup();

    const solo = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
    ]);

    const { rerender } = render(<CompactMessageRenderer message={solo} />);

    const trigger = screen.getByTitle('List Pages');
    expect(trigger.closest('button')).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger.closest('button')).toHaveAttribute('aria-expanded', 'true');

    const grouped = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
      toolPart({ toolCallId: 'call-2', toolName: 'read_page', state: 'input-available' }),
    ]);
    rerender(<CompactMessageRenderer message={grouped} />);

    const groupTrigger = screen.getByText(/Ran 2 commands/);
    expect(groupTrigger.closest('button')).toHaveAttribute('aria-expanded', 'true');

    const nestedTrigger = screen.getByTitle('List Pages');
    expect(nestedTrigger.closest('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('leaves an untouched run closed by default through solo -> group growth, even while running', () => {
    const solo = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
    ]);

    const { rerender } = render(<CompactMessageRenderer message={solo} />);

    const grouped = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
      toolPart({ toolCallId: 'call-2', toolName: 'read_page', state: 'input-available' }),
    ]);
    rerender(<CompactMessageRenderer message={grouped} />);

    const groupTrigger = screen.getByText(/Ran 2 commands/);
    expect(groupTrigger.closest('button')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTitle('List Pages')).not.toBeInTheDocument();
  });

  it('leaves a run with an errored call closed by default (error shown via icon only, never a forced expand)', () => {
    const grouped = messageWithParts([
      toolPart({ toolCallId: 'call-1', toolName: 'list_pages', state: 'output-available' }),
      toolPart({ toolCallId: 'call-2', toolName: 'read_page', state: 'output-error' }),
    ]);

    render(<CompactMessageRenderer message={grouped} />);

    const groupTrigger = screen.getByText(/Ran 2 commands/);
    expect(groupTrigger.closest('button')).toHaveAttribute('aria-expanded', 'false');
  });
});
