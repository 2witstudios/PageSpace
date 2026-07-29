/**
 * The store's own job: identity, idempotence, and not blowing up on a
 * transition aimed at a grid that is gone. The layout rules themselves are the
 * reducer's, and are tested there.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';
import { useAgentWorkspaceStore } from '../useAgentWorkspaceStore';
import { panesOf } from '../pane-reducer';

const scope = (name = 'Planning'): PaneScope => ({
  kind: 'chat',
  name,
  targetId: 'conv-1',
  agentPageId: 'agent-1',
});

const store = () => useAgentWorkspaceStore.getState();
const grid = (id = 'conv-1') => store().workspaces[id];

beforeEach(() => {
  useAgentWorkspaceStore.setState({ workspaces: {} });
});

describe('ensureWorkspace', () => {
  it('should open a conversation on one pane bound to itself', () => {
    store().ensureWorkspace('conv-1', scope());
    expect(panesOf(grid())).toHaveLength(1);
    expect(panesOf(grid())[0].scope).toEqual(scope());
  });

  it('should be idempotent — re-opening a conversation must not discard its layout', () => {
    store().ensureWorkspace('conv-1', scope());
    store().splitRight('conv-1', grid().activePaneId);
    expect(panesOf(grid())).toHaveLength(2);

    store().ensureWorkspace('conv-1', scope());

    expect(panesOf(grid())).toHaveLength(2);
  });

  it('should keep conversations independent', () => {
    store().ensureWorkspace('conv-1', scope());
    store().ensureWorkspace('conv-2', { ...scope('Other'), targetId: 'conv-2' });
    store().splitRight('conv-1', grid('conv-1').activePaneId);

    expect(panesOf(grid('conv-1'))).toHaveLength(2);
    expect(panesOf(grid('conv-2'))).toHaveLength(1);
  });
});

describe('pane ids', () => {
  it('should mint distinct ids for every pane', () => {
    store().ensureWorkspace('conv-1', scope());
    store().splitRight('conv-1', grid().activePaneId);
    store().splitDown('conv-1', grid().activePaneId);

    const ids = panesOf(grid()).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should mint distinct column ids across split-rights', () => {
    store().ensureWorkspace('conv-1', scope());
    store().splitRight('conv-1', grid().activePaneId);
    store().splitRight('conv-1', grid().activePaneId);

    const columnIds = grid().columns.map((c) => c.id);
    expect(new Set(columnIds).size).toBe(columnIds.length);
  });
});

describe('transitions', () => {
  beforeEach(() => {
    store().ensureWorkspace('conv-1', scope());
  });

  it('should bind a pane through assignPane', () => {
    store().splitRight('conv-1', grid().activePaneId);
    const target = grid().activePaneId;
    const shell: PaneScope = { kind: 'terminal', name: 'shell-1', targetId: 'shell-9', agentPageId: null };

    store().assignPane('conv-1', target, shell);

    expect(panesOf(grid()).find((p) => p.id === target)?.scope).toEqual(shell);
  });

  it('should close a pane and keep the grid non-empty', () => {
    store().splitRight('conv-1', grid().activePaneId);
    store().closePane('conv-1', grid().activePaneId);
    expect(panesOf(grid())).toHaveLength(1);
  });

  it('should refuse to close the last pane — a grid is never empty', () => {
    store().closePane('conv-1', grid().activePaneId);
    expect(panesOf(grid())).toHaveLength(1);
  });

  it('should clear a delivered prompt so a remount cannot re-send it', () => {
    const paneId = grid().activePaneId;
    useAgentWorkspaceStore.setState((s) => ({
      workspaces: {
        ...s.workspaces,
        'conv-1': {
          ...s.workspaces['conv-1'],
          columns: [{ ...s.workspaces['conv-1'].columns[0], panes: [{ id: paneId, scope: scope(), pendingPrompt: 'go' }] }],
        },
      },
    }));

    store().clearPanePrompt('conv-1', paneId);

    expect(panesOf(grid())[0].pendingPrompt).toBeUndefined();
  });
});

describe('a transition aimed at a grid that is gone', () => {
  it('should no-op rather than throw or fabricate one', () => {
    // A close can land after the conversation was deleted and its grid
    // forgotten. There is nothing meaningful to build from a split of something
    // absent, so the store declines rather than inventing a workspace.
    expect(() => store().splitRight('never-existed', 'pane-x')).not.toThrow();
    expect(store().workspaces['never-existed']).toBeUndefined();

    store().ensureWorkspace('conv-1', scope());
    store().forgetWorkspace('conv-1');
    expect(() => store().closePane('conv-1', 'pane-1')).not.toThrow();
    expect(store().workspaces['conv-1']).toBeUndefined();
  });

  it('forgetWorkspace should be safe to call twice', () => {
    store().ensureWorkspace('conv-1', scope());
    store().forgetWorkspace('conv-1');
    expect(() => store().forgetWorkspace('conv-1')).not.toThrow();
  });
});
