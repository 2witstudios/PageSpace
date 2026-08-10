/**
 * THE ROOT SEED — a workspace's birth, folded into the first write that needs
 * one.
 *
 * It replaces the `ensure` verb a BROWSER used to post on mount: the
 * create-then-attach shape the flat model exists to delete, and the reason
 * production holds workspaces that exist with zero panes. What makes it safe to
 * run in two places at once (this client, that agent tool, the server's own
 * funnel) is that the id is derived rather than minted, so concurrent seeds are
 * the same write and converge on the upsert instead of producing two roots.
 */
import { describe, expect, it } from 'vitest';
import { openConversation, openShell, rootSeedFor, seedRoot } from '../workspace-node-commands';
import { validateTree } from '../workspace-node-validate';
import { applyNodeWrite } from '../workspace-node-algebra';
import type { WorkspaceNode } from '../workspace-node';

const WS = 'ws-1';

describe('rootSeedFor', () => {
  it('should derive the root id from the workspace, so two seeds are one write', () => {
    expect(rootSeedFor(WS)).toEqual({ nodeType: 'root', id: WS, parentId: null, position: 0, axis: 'row' });
    expect(rootSeedFor(WS)).toEqual(rootSeedFor(WS));
  });
});

describe('seedRoot', () => {
  it('should mint a root into an empty workspace', () => {
    const { nodes, seed } = seedRoot([], WS);
    expect(seed).not.toBeNull();
    expect(nodes).toEqual([rootSeedFor(WS)]);
    expect(validateTree(nodes).ok).toBe(true);
  });

  it('should be a no-op when a root is already there', () => {
    const existing: WorkspaceNode[] = [rootSeedFor(WS)];
    const { nodes, seed } = seedRoot(existing, WS);
    expect(seed).toBeNull();
    expect(nodes).toBe(existing);
  });

  /**
   * A backfilled workspace's root carries whatever id the backfill gave it, not
   * the derived one. Minting a second would be `multiple_roots` — a workspace
   * that becomes unwritable — so the TYPE, not the id, is what decides.
   */
  it('should be a no-op when the existing root has a different id', () => {
    const legacy: WorkspaceNode[] = [
      { nodeType: 'root', id: 'legacy-root', parentId: null, position: 0, axis: 'column' },
    ];
    expect(seedRoot(legacy, WS).seed).toBeNull();
  });

  /**
   * The derived id could, in principle, already be taken by a client-minted
   * node. Upserting a root over a live pane would destroy it; refusing leaves
   * the workspace where it was and lets the caller's command answer `no_root`,
   * which is true and says so.
   */
  it('should refuse to mint over an id that is already taken by something else', () => {
    const collision: WorkspaceNode[] = [
      { nodeType: 'pane', id: WS, parentId: 'somewhere', position: 0, target: null },
    ];
    const { nodes, seed } = seedRoot(collision, WS);
    expect(seed).toBeNull();
    expect(nodes).toBe(collision);
  });

  it('should be idempotent — seeding a seeded tree changes nothing', () => {
    const once = seedRoot([], WS);
    const twice = seedRoot(once.nodes, WS);
    expect(twice.seed).toBeNull();
    expect(twice.nodes).toBe(once.nodes);
  });

  it('should let the first placement succeed on a workspace that had no nodes at all', () => {
    const { nodes, seed } = seedRoot([], WS);
    const result = openConversation(nodes, {
      target: { kind: 'chat', id: 'c1' },
      newNodeId: 'n1',
      newSplitId: 's1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The write a caller sends is the seed plus the command's own nodes, and
    // the applied result is a valid tree — which is what makes the seed part of
    // the write rather than a separate transition nobody validated.
    const write = { put: [seed!, ...result.write.put], drop: result.write.drop };
    const applied = applyNodeWrite([], write);
    expect(validateTree(applied).ok).toBe(true);
    expect(applied.filter((node) => node.nodeType === 'pane')).toHaveLength(1);
  });
});

describe('openShell', () => {
  const root = rootSeedFor(WS);

  it('should place a shell into an empty grid', () => {
    const result = openShell([root], { target: { kind: 'terminal', id: 'shell-1' }, newNodeId: 'n1', newSplitId: 's1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.write.put.some((node) => node.nodeType === 'pane' && node.target?.id === 'shell-1')).toBe(true);
  });

  it('should fill an unbound pane rather than split', () => {
    const nodes: WorkspaceNode[] = [root, { nodeType: 'pane', id: 'empty', parentId: WS, position: 0, target: null }];
    const result = openShell(nodes, {
      target: { kind: 'terminal', id: 'shell-1' },
      newNodeId: 'n1',
      newSplitId: 's1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.write.put.map((node) => node.id)).toEqual(['empty']);
  });

  /**
   * A shell is never EVICTED (its PTY loses its only surface), but a shell can
   * perfectly well be what displaces something else. Two different questions
   * about the same kind, and only the first is a refusal.
   */
  it('should displace a replaceable chat pane, even though a shell is never displaced itself', () => {
    const nodes: WorkspaceNode[] = [
      root,
      { nodeType: 'pane', id: 'chat', parentId: WS, position: 0, target: { kind: 'chat', id: 'c1' } },
    ];
    const result = openShell(nodes, {
      target: { kind: 'terminal', id: 'shell-1' },
      newNodeId: 'n1',
      newSplitId: 's1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyNodeWrite(nodes, result.write);
    // The displaced pane is DESTROYED rather than parked. It used to survive
    // with a null parent — still a member, off the screen — which is the state
    // that made a closed pane and a broken one the same row.
    expect(applied.find((node) => node.id === 'chat')).toBeUndefined();
    expect(applied.find((node) => node.id === 'n1')?.parentId).toBe(WS);
  });

  it('should split rather than take a running shell away', () => {
    const nodes: WorkspaceNode[] = [
      root,
      { nodeType: 'pane', id: 'other-shell', parentId: WS, position: 0, target: { kind: 'terminal', id: 'shell-0' } },
    ];
    const result = openShell(nodes, {
      target: { kind: 'terminal', id: 'shell-1' },
      newNodeId: 'n1',
      newSplitId: 's1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyNodeWrite(nodes, result.write);
    expect(applied.find((node) => node.id === 'other-shell')?.parentId).toBe('s1');
    expect(applied.find((node) => node.id === 'n1')?.parentId).toBe('s1');
  });

  it('should leave a shell already on the grid exactly where it is, writing nothing', () => {
    const nodes: WorkspaceNode[] = [
      root,
      { nodeType: 'pane', id: 'here', parentId: WS, position: 0, target: { kind: 'terminal', id: 'shell-1' } },
    ];
    const result = openShell(nodes, {
      target: { kind: 'terminal', id: 'shell-1' },
      newNodeId: 'n1',
      newSplitId: 's1',
    });
    expect(result).toEqual({ ok: true, write: { put: [], drop: [] } });
  });
});
