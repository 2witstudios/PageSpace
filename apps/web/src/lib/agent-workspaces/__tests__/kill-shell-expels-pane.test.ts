// @vitest-environment node
/**
 * KILLING A SHELL TAKES ITS PANE — the symmetry that was missing, held down
 * here against the funnel rather than against a database.
 *
 * Issue #2462 in one sentence: `spawnShell` wrapped the shell row and the node
 * that shows it in ONE membership write, and `killShellById` wrote to the tree
 * not at all. So a shell arrived on screen and left its rectangle behind, bound
 * to a terminal that no longer existed — with no broadcast, nothing in the
 * `kill_shell` response to suggest anything had been left, and no repair short
 * of a human closing the pane.
 *
 * The properties this pins — and most of them are about what happens when
 * something goes wrong:
 *
 *  - the kill EXPELS the shell's pane, addressed by target;
 *  - a pane a human already closed is `not_a_member`, which is the state the
 *    kill wanted — not a failure;
 *  - a kill that could not reach the process UNWINDS the node write, because a
 *    pane removed for a live PTY is the inverse defect;
 *  - the layout the write left behind rides home on the result, which is what
 *    gives an agent a reason to look (issue #2469).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import type { MembershipResult } from '@pagespace/lib/agent-workspaces/workspace-membership';

const WORKSPACE = 'ws-1';
const SHELL = 'shell-1';
const ACTOR = 'user-1';

const { shellStore, killSessionShellById, membershipWrite, tree } = vi.hoisted(() => ({
  shellStore: { findById: vi.fn(), remove: vi.fn(), list: vi.fn(), create: vi.fn() },
  killSessionShellById: vi.fn(),
  membershipWrite: vi.fn(),
  /** The workspace's nodes, as the funnel would read them under the lock. */
  tree: { nodes: [] as WorkspaceNode[] },
}));

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({ inArray: vi.fn() }));
vi.mock('@pagespace/db/schema/agent-workspaces', () => ({
  agentWorkspaceShells: { workspaceId: 'workspaceId', createdAt: 'createdAt' },
}));
vi.mock('@pagespace/lib/services/agent-workspaces/workspace-shells-store', () => ({
  createDbSessionShellStore: async () => shellStore,
}));
vi.mock('@pagespace/lib/services/agent-workspaces/workspace-shells', () => ({
  spawnSessionShell: vi.fn(),
  listSessionShells: vi.fn(),
  resolveSessionShellById: vi.fn(),
  toShellDTO: vi.fn(),
  killSessionShellById: (...args: unknown[]) => killSessionShellById(...args),
}));
vi.mock('../agent-workspaces-runtime', () => ({
  getAgentSessionStore: async () => ({ findById: async () => ({ id: WORKSPACE, sandboxId: 'sbx-1' }) }),
  getSandboxHost: async () => ({ attach: vi.fn() }),
  resolveSessionLiveSandboxId: () => 'sbx-1',
}));
vi.mock('../workspace-node-runtime', () => ({
  applyWorkspaceMembershipWrite: (...args: unknown[]) => membershipWrite(...args),
}));

const { killShellById } = await import('../workspace-shells-runtime');

/**
 * The funnel, standing in for `applyWorkspaceMembershipWrite`: it runs the
 * caller's decision against the tree and its `within` body on the same
 * "transaction", and a throw from either rolls the whole thing back — which is
 * the only way an unwind is distinguishable from a refusal.
 */
function fakeFunnel() {
  return async (input: {
    run: (nodes: readonly WorkspaceNode[]) => MembershipResult;
    within?: (tx: unknown) => Promise<void>;
  }) => {
    const decided = input.run(tree.nodes);
    if (!decided.ok) return { status: 'refused' as const, code: decided.code, detail: decided.detail };
    await input.within?.({});
    const dropped = new Set(decided.write.drop);
    const nodes = tree.nodes.filter((node) => !dropped.has(node.id));
    tree.nodes = nodes;
    return { status: 'ok' as const, snapshot: { rev: 2, nodes, targets: [] }, changed: true };
  };
}

/** A workspace holding a chat pane and a pane bound to {@link SHELL}. */
function seatShellPane(): void {
  tree.nodes = [
    { nodeType: 'root', id: WORKSPACE, parentId: null, position: 0, axis: 'row' },
    { nodeType: 'pane', id: 'n-chat', parentId: WORKSPACE, position: 0, target: { kind: 'chat', id: 'conv-1' } },
    { nodeType: 'pane', id: 'n-shell', parentId: WORKSPACE, position: 1, target: { kind: 'terminal', id: SHELL } },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  seatShellPane();
  shellStore.findById.mockResolvedValue({ id: SHELL, workspaceId: WORKSPACE, spriteExecId: 'exec-1' });
  killSessionShellById.mockResolvedValue({ ok: true, killed: true });
  membershipWrite.mockImplementation(fakeFunnel());
});

describe('killShellById', () => {
  it('EXPELS the pane bound to the shell, in the write that kills the process', async () => {
    const result = await killShellById({ shellId: SHELL, actingUserId: ACTOR });

    expect(result).toEqual({ ok: true, killed: true, panes: { paneCount: 1, nodeId: 'n-shell' } });
    // Addressed by TARGET, not by node id — the caller knows which shell it
    // killed and never which rectangle was showing it.
    expect(tree.nodes.find((node) => node.id === 'n-shell')).toBeUndefined();
    // And the workspace it wrote to is the shell's own, read off the row rather
    // than taken from a caller that could name a different one.
    expect(membershipWrite).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE, actingUserId: ACTOR }),
    );
  });

  it('leaves every OTHER pane exactly where it was', async () => {
    await killShellById({ shellId: SHELL, actingUserId: ACTOR });
    expect(tree.nodes.map((node) => node.id)).toEqual([WORKSPACE, 'n-chat']);
  });

  it('succeeds when the pane is already gone, because that is the state it wanted', async () => {
    // THE ORDINARY PATH, not an edge case: closing a terminal tab drops the
    // node from the client and THEN sends this DELETE, so `expel` answering
    // `not_a_member` is what a user clicking Close produces every time.
    tree.nodes = tree.nodes.filter((node) => node.id !== 'n-shell');

    const result = await killShellById({ shellId: SHELL, actingUserId: ACTOR });

    // `nodeId` is null because there was no pane left to close — not because the
    // kill failed to name the one it closed.
    expect(result).toEqual({ ok: true, killed: true, panes: { paneCount: 1, nodeId: null } });
    expect(killSessionShellById).toHaveBeenCalled();
  });

  it('UNWINDS the node write when the process could not be killed', async () => {
    // The inverse defect, and the reason the kill throws from inside `within`
    // rather than returning: a pane removed for a PTY that is still running
    // leaves a live process with no surface, no pane and nothing to reattach.
    killSessionShellById.mockResolvedValue({ ok: false, reason: 'error' });

    const result = await killShellById({ shellId: SHELL, actingUserId: ACTOR });

    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(tree.nodes.find((node) => node.id === 'n-shell')).toBeDefined();
  });

  it('never SEEDS a root in order to remove something, because an ended session would get its tree back', async () => {
    // The browser kills the shell whose pane raised the end-session confirm
    // only AFTER the session DELETE succeeds — and that DELETE destroyed the
    // tree. A seeding removal would mint a root for the express purpose of
    // writing nothing into it, putting a tree row back on a session that had
    // just ended. `destroyWorkspaceTree` carries the same flag for the same
    // reason.
    await killShellById({ shellId: SHELL, actingUserId: ACTOR });
    expect(membershipWrite).toHaveBeenCalledWith(expect.objectContaining({ seed: false }));
  });

  it('answers success without touching the tree when the shell row is already gone', async () => {
    // `planKillTarget`'s rule: teardown callers retry, and a shell that is not
    // there has no workspace to address a membership write to.
    shellStore.findById.mockResolvedValue(null);

    const result = await killShellById({ shellId: SHELL, actingUserId: ACTOR });

    expect(result).toEqual({ ok: true, killed: false, panes: null });
    expect(membershipWrite).not.toHaveBeenCalled();
    expect(killSessionShellById).not.toHaveBeenCalled();
  });

  it('reports the layout it left behind, so an agent has something to act on', async () => {
    // Issue #2469's other half: `list_panes` was always there, and the session
    // that filed it never called one — because nothing it read mentioned panes.
    tree.nodes.push(
      { nodeType: 'pane', id: 'n-extra', parentId: WORKSPACE, position: 2, target: { kind: 'page', id: 'page-1' } },
    );

    const result = await killShellById({ shellId: SHELL, actingUserId: ACTOR });

    expect(result).toMatchObject({ panes: { paneCount: 2 } });
  });
});
