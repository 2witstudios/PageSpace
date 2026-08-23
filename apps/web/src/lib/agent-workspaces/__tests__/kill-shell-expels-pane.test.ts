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
 *  - the PROCESS dies before any lock is taken, and a ROW that cannot be
 *    dropped unwinds the node write, because a pane removed for a shell the
 *    workspace still holds is the inverse defect;
 *  - the layout the write left behind rides home on the result, which is what
 *    gives an agent a reason to look (issue #2469).
 *
 * **The shell service is NOT mocked here.** `killShellProcess` and
 * `dropSessionShellRow` run for real against a stubbed store and Sprites host,
 * because the property under test is WHERE each of them runs relative to the
 * workspace lock — and a mocked service cannot be caught touching the network
 * in the wrong place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import type { MembershipResult } from '@pagespace/lib/agent-workspaces/workspace-membership';

const WORKSPACE = 'ws-1';
const SHELL = 'shell-1';
const ACTOR = 'user-1';

const { shellStore, membershipWrite, tree, host, killSession, order } = vi.hoisted(() => ({
  shellStore: { findById: vi.fn(), remove: vi.fn(), list: vi.fn(), create: vi.fn() },
  membershipWrite: vi.fn(),
  /** The workspace's nodes, as the funnel would read them under the lock. */
  tree: { nodes: [] as WorkspaceNode[] },
  /** The Sprites host. `attach` is the call with no timeout of its own — see the lock-order case. */
  host: { attach: vi.fn(), provision: vi.fn(), kill: vi.fn() },
  killSession: vi.fn(),
  /** What happened, in the order it happened — the only way to see WHERE a call was made. */
  order: [] as string[],
}));

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({ inArray: vi.fn() }));
vi.mock('@pagespace/db/schema/agent-workspaces', () => ({
  agentWorkspaceShells: { workspaceId: 'workspaceId', createdAt: 'createdAt' },
}));
vi.mock('@pagespace/lib/services/agent-workspaces/workspace-shells-store', () => ({
  createDbSessionShellStore: async () => shellStore,
}));
vi.mock('../agent-workspaces-runtime', () => ({
  getAgentSessionStore: async () => ({ findById: async () => ({ id: WORKSPACE, sandboxId: 'sbx-1' }) }),
  getSandboxHost: async () => host,
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
    order.push('lock');
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
  order.length = 0;
  seatShellPane();
  shellStore.findById.mockResolvedValue({ id: SHELL, workspaceId: WORKSPACE, spriteExecId: 'exec-1' });
  shellStore.remove.mockImplementation(async () => {
    order.push('remove');
  });
  killSession.mockImplementation(async () => {
    order.push('killSession');
  });
  host.attach.mockImplementation(async () => {
    order.push('attach');
    return { killSession };
  });
  membershipWrite.mockImplementation(fakeFunnel());
});

describe('killShellById', () => {
  it('EXPELS the pane bound to the shell, in the write that drops its row', async () => {
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

  it('kills the PROCESS before it takes the lock, and drops the ROW inside it', async () => {
    // The lock-order property (CodeRabbit Major, and this branch's own review
    // pass). `killSpriteSession` retries three times at 10s apiece with
    // backoff, and its own doc says the REST call may be what WAKES a
    // hibernating Sprite — so half a minute is a normal slow path. Inside
    // `pg_advisory_xact_lock` that is every layout write in the workspace
    // queued behind a sleepy VM, which is exactly what `destroyWorkspaceTree`
    // refuses to do. The database half stays inside, because the row and the
    // node agreeing is what the transaction is actually for.
    await killShellById({ shellId: SHELL, actingUserId: ACTOR });

    expect(order).toEqual(['attach', 'killSession', 'lock', 'remove']);
  });

  it('succeeds when the pane is already gone, because that is the state it wanted', async () => {
    // THE ORDINARY PATH, not an edge case: closing a terminal tab drops the
    // node from the client and THEN sends this DELETE, so `expel` answering
    // `not_a_member` is what a user clicking Close produces every time.
    tree.nodes = tree.nodes.filter((node) => node.id !== 'n-shell');

    const result = await killShellById({ shellId: SHELL, actingUserId: ACTOR });

    // `nodeId` is null because there was no pane left to close — not because
    // the kill failed to name the one it closed.
    expect(result).toEqual({ ok: true, killed: true, panes: { paneCount: 1, nodeId: null } });
    expect(order).toContain('remove');
  });

  it('writes NOTHING AT ALL when the process could not be killed', async () => {
    // We learned nothing about the process, so the row stays (a retry has to be
    // able to find it) and the pane stays with it. Under the old shape this
    // reached the transaction and unwound; it no longer gets that far.
    host.attach.mockRejectedValue(new Error('control plane unreachable'));

    const result = await killShellById({ shellId: SHELL, actingUserId: ACTOR });

    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(membershipWrite).not.toHaveBeenCalled();
    expect(shellStore.remove).not.toHaveBeenCalled();
    expect(tree.nodes.find((node) => node.id === 'n-shell')).toBeDefined();
  });

  it('UNWINDS the node write when the ROW could not be dropped', async () => {
    // The other half of the pair: the process is dead, but if its row survives
    // the write, taking the pane would leave the workspace holding a shell it
    // cannot show — the defect this function closes, mirrored.
    shellStore.remove.mockRejectedValue(new Error('write failed'));

    await expect(killShellById({ shellId: SHELL, actingUserId: ACTOR })).rejects.toThrow('write failed');
    expect(tree.nodes.find((node) => node.id === 'n-shell')).toBeDefined();
  });

  it('REFUSES to drop a row whose PTY started after the kill was decided', async () => {
    // `spriteExecId` is written lazily by the realtime bridge when the PTY first
    // starts, not at spawn — so a close clicked at the same moment an agent's
    // first `send_shell` opens the terminal decides "nothing to kill" against a
    // row that acquires a live exec before the transaction gets the lock.
    // Dropping it then would leave that exec running in the session's Sprite
    // with nothing addressing it, and the caller would be told it was killed.
    shellStore.findById
      // The pre-lock read: no PTY, so nothing is killed.
      .mockResolvedValueOnce({ id: SHELL, workspaceId: WORKSPACE, spriteExecId: null })
      // The read inside the transaction: one started in between.
      .mockResolvedValue({ id: SHELL, workspaceId: WORKSPACE, spriteExecId: 'exec-late' });

    await expect(killShellById({ shellId: SHELL, actingUserId: ACTOR })).resolves.toEqual({
      ok: false,
      reason: 'error',
    });

    // Nothing was dropped and nothing was expelled, so the retry finds a shell
    // it can kill properly — and the pane is still there to close.
    expect(shellStore.remove).not.toHaveBeenCalled();
    expect(tree.nodes.find((node) => node.id === 'n-shell')).toBeDefined();
  });

  it('still removes the row and the pane when the sandbox has VANISHED', async () => {
    // A null handle is not a failure: there is nothing left running, so the
    // shell goes exactly as it would after a successful kill.
    host.attach.mockResolvedValue(null);

    const result = await killShellById({ shellId: SHELL, actingUserId: ACTOR });

    expect(result).toMatchObject({ ok: true, killed: true });
    expect(tree.nodes.find((node) => node.id === 'n-shell')).toBeUndefined();
  });

  it('never reaches for the sandbox when no PTY was ever opened', async () => {
    shellStore.findById.mockResolvedValue({ id: SHELL, workspaceId: WORKSPACE, spriteExecId: null });

    const result = await killShellById({ shellId: SHELL, actingUserId: ACTOR });

    expect(result).toMatchObject({ ok: true, killed: true });
    expect(host.attach).not.toHaveBeenCalled();
    expect(tree.nodes.find((node) => node.id === 'n-shell')).toBeUndefined();
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
    expect(host.attach).not.toHaveBeenCalled();
  });

  it('reports the layout it left behind, so an agent has something to act on', async () => {
    // Issue #2469's other half: `list_panes` was always there, and the session
    // that filed it never called one — because nothing it read mentioned panes.
    tree.nodes.push({
      nodeType: 'pane',
      id: 'n-extra',
      parentId: WORKSPACE,
      position: 2,
      target: { kind: 'page', id: 'page-1' },
    });

    const result = await killShellById({ shellId: SHELL, actingUserId: ACTOR });

    expect(result).toMatchObject({ panes: { paneCount: 2, nodeId: 'n-shell' } });
  });
});
