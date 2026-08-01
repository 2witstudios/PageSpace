import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { useOpenPagePane } from '../useOpenPagePane';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import { panesOf } from '@/stores/agent-workspace/pane-reducer';

const store = () => useAgentWorkspaceStore.getState();
const grid = (id = 'ses-1') => store().workspaces[id];

const toolPart = (toolCallId: string, state: string, output?: unknown) => ({
  type: 'tool-open_page_pane',
  toolCallId,
  state,
  input: { pageId: 'page-1' },
  ...(output !== undefined ? { output } : {}),
});

const msg = (id: string, role: UIMessage['role'], parts: unknown[] = []): UIMessage =>
  ({ id, role, parts }) as UIMessage;

beforeEach(() => {
  useAgentWorkspaceStore.setState({ workspaces: {} });
});

describe('useOpenPagePane', () => {
  it('opens a page pane for a NEWLY streamed completed call', () => {
    store().ensureWorkspace('ses-1', { kind: 'chat', name: 'Thread', targetId: 'conv-1', agentPageId: 'agent-1' });
    // Split first so the lone chat pane isn't the only replaceable candidate —
    // isolates "does it act on a new call" from the invoker-exclusion behavior
    // covered separately below.
    store().splitRight('ses-1', panesOf(grid())[0].id);

    const { rerender } = renderHook(
      ({ messages }: { messages: UIMessage[] }) =>
        useOpenPagePane({ sessionId: 'ses-1', conversationId: 'conv-1', messages }),
      { initialProps: { messages: [msg('a1', 'assistant', [])] } },
    );

    rerender({
      messages: [
        msg('a1', 'assistant', [
          toolPart('tc1', 'output-available', { opened: true, pageId: 'page-1', title: 'My Doc' }),
        ]),
      ],
    });

    const panes = panesOf(grid());
    const pagePane = panes.find((p) => p.scope?.kind === 'page');
    expect(pagePane?.scope?.targetId).toBe('page-1');
    expect(pagePane?.scope?.name).toBe('My Doc');
  });

  it('does NOT act on a completed call already present on the FIRST render (history replay guard)', () => {
    store().ensureWorkspace('ses-1', { kind: 'chat', name: 'Thread', targetId: 'conv-1', agentPageId: 'agent-1' });
    store().splitRight('ses-1', panesOf(grid())[0].id);
    const before = panesOf(grid()).map((p) => p.scope);

    renderHook(() =>
      useOpenPagePane({
        sessionId: 'ses-1',
        conversationId: 'conv-1',
        messages: [
          msg('a1', 'assistant', [
            toolPart('tc1', 'output-available', { opened: true, pageId: 'page-1', title: 'My Doc' }),
          ]),
        ],
      }),
    );

    // A reopened/remounted conversation's own loaded history must not
    // re-trigger the pane it already opened last time.
    expect(panesOf(grid()).map((p) => p.scope)).toEqual(before);
  });

  it('never double-fires the same toolCallId across rerenders', () => {
    store().ensureWorkspace('ses-1', { kind: 'chat', name: 'Thread', targetId: 'conv-1', agentPageId: 'agent-1' });
    store().splitRight('ses-1', panesOf(grid())[0].id);

    const { rerender } = renderHook(
      ({ messages }: { messages: UIMessage[] }) =>
        useOpenPagePane({ sessionId: 'ses-1', conversationId: 'conv-1', messages }),
      { initialProps: { messages: [msg('a1', 'assistant', [])] } },
    );
    const completed = [
      msg('a1', 'assistant', [
        toolPart('tc1', 'output-available', { opened: true, pageId: 'page-1', title: 'My Doc' }),
      ]),
    ];
    rerender({ messages: completed });
    // Manually re-target the pane the tool call opened, then rerender with the
    // SAME messages again — a naive re-scan would reopen/refocus page-1 and
    // undo the user's own subsequent action.
    const pagePane = panesOf(grid()).find((p) => p.scope?.kind === 'page')!;
    store().assignPane('ses-1', pagePane.id, { kind: 'page', name: 'Other', targetId: 'page-2', agentPageId: null });
    rerender({ messages: completed });

    expect(panesOf(grid()).find((p) => p.id === pagePane.id)?.scope?.targetId).toBe('page-2');
  });

  it('never evicts the invoking chat pane — splits beside it instead (excludeTargetId)', () => {
    store().ensureWorkspace('ses-1', { kind: 'chat', name: 'Thread', targetId: 'conv-1', agentPageId: 'agent-1' });
    const chatPane = panesOf(grid())[0];

    const { rerender } = renderHook(
      ({ messages }: { messages: UIMessage[] }) =>
        useOpenPagePane({ sessionId: 'ses-1', conversationId: 'conv-1', messages }),
      { initialProps: { messages: [msg('a1', 'assistant', [])] } },
    );
    rerender({
      messages: [
        msg('a1', 'assistant', [
          toolPart('tc1', 'output-available', { opened: true, pageId: 'page-1', title: 'My Doc' }),
        ]),
      ],
    });

    const panes = panesOf(grid());
    expect(panes).toHaveLength(2);
    expect(panes.find((p) => p.id === chatPane.id)?.scope?.targetId).toBe('conv-1');
    expect(panes.find((p) => p.scope?.targetId === 'page-1')).toBeDefined();
  });

  it('ignores tool parts that are not yet output-available', () => {
    store().ensureWorkspace('ses-1', { kind: 'chat', name: 'Thread', targetId: 'conv-1', agentPageId: 'agent-1' });
    const before = panesOf(grid()).map((p) => p.scope);

    const { rerender } = renderHook(
      ({ messages }: { messages: UIMessage[] }) =>
        useOpenPagePane({ sessionId: 'ses-1', conversationId: 'conv-1', messages }),
      { initialProps: { messages: [msg('a1', 'assistant', [])] } },
    );
    rerender({ messages: [msg('a1', 'assistant', [toolPart('tc1', 'input-available')])] });

    expect(panesOf(grid()).map((p) => p.scope)).toEqual(before);
  });

  it('no-ops when sessionId is null (a plain, session-less conversation)', () => {
    const { rerender } = renderHook(
      ({ messages }: { messages: UIMessage[] }) =>
        useOpenPagePane({ sessionId: null, conversationId: 'conv-1', messages }),
      { initialProps: { messages: [msg('a1', 'assistant', [])] } },
    );
    rerender({
      messages: [
        msg('a1', 'assistant', [
          toolPart('tc1', 'output-available', { opened: true, pageId: 'page-1', title: 'My Doc' }),
        ]),
      ],
    });

    expect(useAgentWorkspaceStore.getState().workspaces).toEqual({});
  });
});
