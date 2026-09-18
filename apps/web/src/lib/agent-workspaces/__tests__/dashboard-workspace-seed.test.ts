/**
 * Dashboard workspace SEED tree — the pure day-one layout.
 *
 * The dashboard workspace's whole premise is that its tree is an ORDINARY
 * workspace tree (one root, panes under it — the same model the Agents grid
 * renders), so the assertions here are about exactly that: the root is the
 * workspace, the first pane hangs under it, and the seed binding lands (or
 * deliberately doesn't) where the provisioning decision put it.
 */
import { describe, it, expect } from 'vitest';
import { dashboardSeedNodeRows } from '../dashboard-workspace-runtime';
import { rootOf, childrenOf, type WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import { nodesFromRows } from '@pagespace/lib/agent-workspaces/workspace-node-rows';

describe('dashboardSeedNodeRows', () => {
  it('seeds a root identified by the workspace id with one chat pane under it', () => {
    const rows = dashboardSeedNodeRows('ws-1', 'conv-1');
    expect(rows).toHaveLength(2);

    // The seed rows ARE node rows (same shape `agent_workspace_nodes` holds),
    // so the grid's own translation must read them — that identity is the
    // whole claim being tested.
    const nodes = nodesFromRows(rows as never, 'ws-1');
    const root = rootOf(nodes);
    expect(root?.id).toBe('ws-1');

    const children = childrenOf(nodes, 'ws-1');
    expect(children).toHaveLength(1);
    const pane = paneOrThrow(children[0]);
    expect(pane.target?.kind).toBe('chat');
    expect(pane.target?.id).toBe('conv-1');
  });

  it('seeds an unbound chat pane when no binding is offered', () => {
    const rows = dashboardSeedNodeRows('ws-2', null);
    const nodes = nodesFromRows(rows as never, 'ws-2');
    const pane = paneOrThrow(childrenOf(nodes, 'ws-2')[0]);
    expect(pane.target).toBeNull();
  });
});

function paneOrThrow(node: WorkspaceNode | undefined) {
  expect(node?.nodeType).toBe('pane');
  if (node?.nodeType !== 'pane') throw new Error('expected a pane node');
  return node;
}
