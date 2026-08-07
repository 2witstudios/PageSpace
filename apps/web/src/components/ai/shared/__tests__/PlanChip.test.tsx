import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { UIMessage } from 'ai';

const fetchWithAuthMock = vi.fn();
const delMock = vi.fn();

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
  del: (...args: unknown[]) => delMock(...args),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { PlanChip } from '../PlanChip';

const BOUND = { plan: { pageId: 'pg_plan', title: 'Migrate billing', driveId: 'drv_1' } };
const UNBOUND = { plan: null };

const respondWith = (body: unknown) =>
  fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => body });

/** A completed tool call part, as the AI SDK shapes it in the message stream. */
const toolPart = (toolName: string, state = 'output-available') => ({
  type: `tool-${toolName}`,
  toolName,
  state,
});

const messagesWith = (...parts: unknown[]): UIMessage[] =>
  [{ id: 'm1', role: 'assistant', parts }] as unknown as UIMessage[];

describe('PlanChip', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    delMock.mockReset();
  });

  it('renders nothing when the conversation has no plan', async () => {
    respondWith(UNBOUND);
    const { container } = render(<PlanChip conversationId="conv-1" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing, and fetches nothing, without a conversation id', () => {
    const { container } = render(<PlanChip conversationId={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders the chip once a plan is bound', async () => {
    respondWith(BOUND);
    render(<PlanChip conversationId="conv-2" />);
    expect(await screen.findByTitle('Active plan')).toBeTruthy();
  });

  it('reads the persisted binding rather than deriving it from messages', async () => {
    // The distinguishing property vs TasksDropdown: with an EMPTY message list —
    // the state after a reload, or after the binding tool call was summarized
    // away — the chip must still show the plan.
    respondWith(BOUND);
    render(<PlanChip conversationId="conv-3" messages={[]} />);
    expect(await screen.findByTitle('Active plan')).toBeTruthy();
  });

  it('re-fetches the binding when set_plan completes mid-conversation', async () => {
    respondWith(UNBOUND);
    const { rerender } = render(<PlanChip conversationId="conv-4" messages={[]} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    // The agent binds a plan mid-stream. Without this revalidation the chip
    // would keep showing nothing until SWR happened to refetch.
    respondWith(BOUND);
    rerender(<PlanChip conversationId="conv-4" messages={messagesWith(toolPart('set_plan'))} />);

    expect(await screen.findByTitle('Active plan')).toBeTruthy();
  });

  it('re-fetches when clear_plan completes', async () => {
    respondWith(BOUND);
    const { rerender } = render(<PlanChip conversationId="conv-5" messages={[]} />);
    await screen.findByTitle('Active plan');

    respondWith(UNBOUND);
    rerender(<PlanChip conversationId="conv-5" messages={messagesWith(toolPart('clear_plan'))} />);

    await waitFor(() => expect(screen.queryByTitle('Active plan')).toBeNull());
  });

  it('ignores a plan tool call that has not finished yet', async () => {
    respondWith(UNBOUND);
    const { rerender } = render(<PlanChip conversationId="conv-6" messages={[]} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    // Revalidating on an in-flight call would fetch a binding the server has not
    // written yet, and would fire again on every streaming delta.
    rerender(
      <PlanChip conversationId="conv-6" messages={messagesWith(toolPart('set_plan', 'input-streaming'))} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated completed tool calls', async () => {
    respondWith(UNBOUND);
    const { rerender } = render(<PlanChip conversationId="conv-7" messages={[]} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    rerender(<PlanChip conversationId="conv-7" messages={messagesWith(toolPart('create_page'))} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });
});

describe('PlanChip revalidation is not wasteful', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    delMock.mockReset();
  });

  it('does not double-fetch on mount when history already contains a completed set_plan', async () => {
    // Opening a conversation whose history includes an earlier bind: SWR's own
    // initial fetch already covers it, so reacting to the pre-existing call
    // would fetch the same key twice on every mount.
    respondWith(BOUND);
    render(<PlanChip conversationId="conv-8" messages={messagesWith(toolPart('set_plan'))} />);
    await screen.findByTitle('Active plan');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch when messages change without a new plan-tool completion', async () => {
    respondWith(BOUND);
    const { rerender } = render(<PlanChip conversationId="conv-9" messages={[]} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    rerender(<PlanChip conversationId="conv-9" messages={messagesWith(toolPart('read_page'))} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });
});
