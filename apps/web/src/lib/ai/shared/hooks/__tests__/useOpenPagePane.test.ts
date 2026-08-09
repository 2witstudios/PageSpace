import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { useOpenPagePane } from '../useOpenPagePane';
import {
  useAgentWorkspaceStore,
  __resetWorkspaceQueuesForTests,
} from '@/stores/agent-workspace/useAgentWorkspaceStore';
import type { PaneNode, WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import { paneNodesOf } from '@/stores/agent-workspace/workspace-tree-view';

const WS = 'ses-1';
const store = () => useAgentWorkspaceStore.getState();
const grid = (id = WS) => store().workspaces[id];
/** Every pane in the workspace — attached or parked. */
const panesOf = (tree = grid()): PaneNode[] => paneNodesOf(tree?.nodes ?? []);

const rootNode: WorkspaceNode = { nodeType: 'root', id: WS, parentId: null, position: 0, axis: 'row' };
const chatNode = (id: string, position: number, conversationId: string): WorkspaceNode => ({
  nodeType: 'pane',
  id,
  parentId: WS,
  position,
  target: { kind: 'chat', id: conversationId },
});

/**
 * Seat a workspace's tree directly. There is no client-side grid seed any more
 * — a root is minted server-side by whatever write first needs one — so a
 * fixture states the tree it wants instead of driving a reducer to it.
 */
const seat = (nodes: WorkspaceNode[]) =>
  store().hydrateFromServer(WS, { rev: 1, nodes, targets: [] });

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
  __resetWorkspaceQueuesForTests();
});

describe('useOpenPagePane', () => {
  it('opens a page pane for a NEWLY streamed completed call', () => {
    // Two panes, so the invoking conversation's own pane isn't the only
    // replaceable candidate — isolates "does it act on a new call" from the
    // invoker-exclusion behaviour covered separately below.
    seat([rootNode, chatNode('n1', 0, 'conv-1'), chatNode('n2', 1, 'conv-9')]);

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

    const panes = panesOf();
    const pagePane = panes.find((p) => p.target?.kind === 'page');
    expect(pagePane?.target?.id).toBe('page-1');
  });

  it('does NOT act on a completed call already present on the FIRST render (history replay guard)', () => {
    seat([rootNode, chatNode('n1', 0, 'conv-1'), chatNode('n2', 1, 'conv-9')]);
    const before = panesOf().map((p) => p.target);

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
    expect(panesOf().map((p) => p.target)).toEqual(before);
  });

  it('does NOT replay a DIFFERENT conversation\'s already-completed call when the same pane switches to it (no remount)', () => {
    // The pane-bar agent switcher rebinds a pane's conversationId IN PLACE —
    // SessionChat/AssistantSessionChat are never keyed by conversationId, so
    // this hook's refs must not treat conv-2's own history as "new" just
    // because they were already seeded (by conv-1) before the switch.
    seat([rootNode, chatNode('n1', 0, 'conv-1'), chatNode('n2', 1, 'conv-9')]);

    const { rerender } = renderHook(
      ({ conversationId, messages }: { conversationId: string; messages: UIMessage[] }) =>
        useOpenPagePane({ sessionId: 'ses-1', conversationId, messages }),
      { initialProps: { conversationId: 'conv-1', messages: [msg('a1', 'assistant', [])] } },
    );
    // Seed conv-1 as already-history (matches the "history replay guard" test above).
    rerender({
      conversationId: 'conv-1',
      messages: [
        msg('a1', 'assistant', [
          toolPart('tc1', 'output-available', { opened: true, pageId: 'page-1', title: 'Conv 1 Doc' }),
        ]),
      ],
    });
    const before = panesOf().map((p) => p.target);

    // Switch the SAME pane to conv-2, whose own last message already ends in
    // a completed call — must be seeded as conv-2's history, not fired.
    rerender({
      conversationId: 'conv-2',
      messages: [
        msg('a2', 'assistant', [
          toolPart('tc2', 'output-available', { opened: true, pageId: 'page-2', title: 'Conv 2 Doc' }),
        ]),
      ],
    });

    expect(panesOf().map((p) => p.target)).toEqual(before);
  });

  it('still fires a genuinely NEW call after switching to a different conversation', () => {
    seat([rootNode, chatNode('n1', 0, 'conv-1'), chatNode('n2', 1, 'conv-9')]);

    const { rerender } = renderHook(
      ({ conversationId, messages }: { conversationId: string; messages: UIMessage[] }) =>
        useOpenPagePane({ sessionId: 'ses-1', conversationId, messages }),
      { initialProps: { conversationId: 'conv-1', messages: [msg('a1', 'assistant', [])] } },
    );
    // Switch to conv-2 with no completed call yet...
    rerender({ conversationId: 'conv-2', messages: [msg('a2', 'assistant', [])] });
    // ...then a NEW call streams in live for conv-2.
    rerender({
      conversationId: 'conv-2',
      messages: [
        msg('a2', 'assistant', [
          toolPart('tc2', 'output-available', { opened: true, pageId: 'page-2', title: 'Conv 2 Doc' }),
        ]),
      ],
    });

    const pagePane = panesOf().find((p) => p.target?.kind === 'page');
    expect(pagePane?.target?.id).toBe('page-2');
  });

  it('never double-fires the same toolCallId across rerenders', () => {
    seat([rootNode, chatNode('n1', 0, 'conv-1'), chatNode('n2', 1, 'conv-9')]);

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
    // The user moves on: they close the pane the tool call opened, then the
    // SAME messages rerender. A naive re-scan would reopen page-1 and undo it.
    // A binding is for life, so "the user retargeted this pane" is spelled as
    // closing the node rather than as a rebind of it — and closing DESTROYS it,
    // so the pane must simply stay gone.
    const pagePane = panesOf().find((p) => p.target?.kind === 'page')!;
    store().closePane('ses-1', pagePane.id);
    rerender({ messages: completed });

    expect(panesOf().find((p) => p.id === pagePane.id)).toBeUndefined();
    expect(panesOf().some((p) => p.target?.kind === 'page')).toBe(false);
  });

  it('never evicts the invoking chat pane — splits beside it instead (excludeTargetId)', () => {
    seat([rootNode, chatNode('n1', 0, 'conv-1')]);
    const chatPane = panesOf()[0];

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

    const panes = panesOf();
    expect(panes).toHaveLength(2);
    expect(panes.find((p) => p.id === chatPane.id)?.target?.id).toBe('conv-1');
    expect(panes.find((p) => p.target?.id === 'page-1')).toBeDefined();
  });

  it('ignores tool parts that are not yet output-available', () => {
    seat([rootNode, chatNode('n1', 0, 'conv-1')]);
    const before = panesOf().map((p) => p.target);

    const { rerender } = renderHook(
      ({ messages }: { messages: UIMessage[] }) =>
        useOpenPagePane({ sessionId: 'ses-1', conversationId: 'conv-1', messages }),
      { initialProps: { messages: [msg('a1', 'assistant', [])] } },
    );
    rerender({ messages: [msg('a1', 'assistant', [toolPart('tc1', 'input-available')])] });

    expect(panesOf().map((p) => p.target)).toEqual(before);
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
