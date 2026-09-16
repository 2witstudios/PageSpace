/**
 * ToolApprovalCard tests — the human-in-the-loop gate's one interactive surface.
 *
 * Read-only without a provider (history views, other viewers), disabled when the
 * provider does not list the call as answerable, and each button hands the hook
 * the decision it stands for — the effective tool through execute_tool included.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ToolApprovalCard } from '../approvals/ToolApprovalCard';
import { ToolApprovalProvider } from '../approvals/ToolApprovalContext';

const pausedPart = (over: Record<string, unknown> = {}) => ({
  type: 'tool-trash_page',
  toolName: 'trash_page',
  toolCallId: 'tc1',
  state: 'approval-requested',
  input: { pageId: 'p1' },
  approval: { id: 'ap1' },
  ...over,
});

const renderWith = (part: ReturnType<typeof pausedPart>, approvable = true, respond = vi.fn()) => ({
  respond,
  ...render(
    <ToolApprovalProvider value={{ approvableToolCallIds: new Set(approvable ? [part.toolCallId as string] : []), respond }}>
      <ToolApprovalCard part={part} />
    </ToolApprovalProvider>,
  ),
});

describe('ToolApprovalCard', () => {
  it('names the tool and shows its parameters', () => {
    const { getByText, container } = renderWith(pausedPart());
    expect(getByText('Approval needed')).toBeTruthy();
    expect(container.textContent).toContain('Move to Trash');
    expect(container.querySelector('pre')?.textContent).toContain('"pageId": "p1"');
  });

  it('unwraps execute_tool to the dispatched tool for the label and preview', () => {
    const part = pausedPart({
      type: 'tool-execute_tool',
      toolName: 'execute_tool',
      input: { tool_name: 'create_task', parameters: { title: 'Ship it' } },
    });
    const { container } = renderWith(part);
    expect(container.textContent).toContain('Create Task');
    expect(container.textContent).toContain('Ship it');
    expect(container.textContent).not.toContain('tool_name');
  });

  it('without a provider (history / other viewers) renders read-only: buttons disabled, waiting note shown', () => {
    const { getByText } = render(<ToolApprovalCard part={pausedPart()} />);
    expect((getByText('Allow once').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(getByText('Waiting for a response…')).toBeTruthy();
  });

  it('with a provider that does not list the call as answerable, buttons stay disabled', () => {
    const { getByText, respond } = renderWith(pausedPart(), false);
    const allow = getByText('Allow once').closest('button') as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    fireEvent.click(allow);
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([
    ['Allow once', { approved: true, scope: 'once' }],
    ['Allow for this conversation', { approved: true, scope: 'conversation' }],
    ['Always allow Move to Trash', { approved: true, scope: 'always' }],
  ])('%s hands the hook the matching decision', (label, expected) => {
    const { getByText, respond } = renderWith(pausedPart());
    fireEvent.click(getByText(label).closest('button') as HTMLButtonElement);
    expect(respond).toHaveBeenCalledWith('tc1', { approvalId: 'ap1', ...expected });
  });

  it('Deny asks for an optional reason, then denies with it (trimmed, omitted when blank)', () => {
    const { getByText, getByPlaceholderText, respond } = renderWith(pausedPart());
    fireEvent.click(getByText('Deny').closest('button') as HTMLButtonElement);
    fireEvent.change(getByPlaceholderText(/Why not\?/), { target: { value: '  keep it  ' } });
    fireEvent.click(getByText('Deny').closest('button') as HTMLButtonElement);
    expect(respond).toHaveBeenCalledWith('tc1', { approvalId: 'ap1', approved: false, reason: 'keep it' });
  });

  it('renders an answered call as a status line, never buttons', () => {
    const approved = renderWith(pausedPart({ state: 'approval-responded', approval: { id: 'ap1', approved: true } }));
    expect(approved.container.textContent).toContain('Approved · running');
    expect(approved.queryByText('Allow once')).toBeNull();
    const denied = renderWith(pausedPart({ state: 'approval-responded', approval: { id: 'ap1', approved: false } }));
    expect(denied.container.textContent).toContain('Denied');
  });
});
