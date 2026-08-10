import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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

/**
 * Flush pending effects and microtasks deterministically.
 *
 * The "no extra fetch happened" assertions below are negative, so they need a
 * point at which any fetch that WAS going to fire already has. A fixed sleep
 * gets that wrong in both directions — it can pass before a slightly-late
 * request lands, and it can flake on a loaded CI worker. `act` drains React's
 * effect queue and the microtask queue instead, which is exactly the boundary
 * these assertions care about, with no wall-clock dependency.
 */
const flushEffects = () => act(async () => {});

/**
 * How a plan tool actually reaches the model on the Global Assistant: set_plan
 * is not a CORE tool and that route always splits its toolset, so the agent can
 * only call it wrapped in execute_tool.
 */
const wrappedToolPart = (toolName: string, state = 'output-available') => ({
  type: 'tool-execute_tool',
  toolName: 'execute_tool',
  state,
  input: { tool_name: toolName, parameters: {} },
});

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
    await flushEffects();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated completed tool calls', async () => {
    respondWith(UNBOUND);
    const { rerender } = render(<PlanChip conversationId="conv-7" messages={[]} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    rerender(<PlanChip conversationId="conv-7" messages={messagesWith(toolPart('create_page'))} />);
    await flushEffects();
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
    await flushEffects();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch when messages change without a new plan-tool completion', async () => {
    respondWith(BOUND);
    const { rerender } = render(<PlanChip conversationId="conv-9" messages={[]} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    rerender(<PlanChip conversationId="conv-9" messages={messagesWith(toolPart('read_page'))} />);
    await flushEffects();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });
});

describe('PlanChip sees plan tools wrapped in execute_tool', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    delMock.mockReset();
  });

  it('re-fetches when set_plan completes via execute_tool', async () => {
    // Without unwrapping, this component's revalidation is dead code on the
    // Global Assistant — the one surface where the chip is most visible.
    respondWith(UNBOUND);
    const { rerender } = render(<PlanChip conversationId="conv-10" messages={[]} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    respondWith(BOUND);
    rerender(<PlanChip conversationId="conv-10" messages={messagesWith(wrappedToolPart('set_plan'))} />);

    expect(await screen.findByTitle('Active plan')).toBeTruthy();
  });

  it('ignores execute_tool wrapping an unrelated tool', async () => {
    respondWith(UNBOUND);
    const { rerender } = render(<PlanChip conversationId="conv-11" messages={[]} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    rerender(<PlanChip conversationId="conv-11" messages={messagesWith(wrappedToolPart('create_page'))} />);
    await flushEffects();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });
});
