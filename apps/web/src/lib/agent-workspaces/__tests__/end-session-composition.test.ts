/**
 * ENDING A SESSION = the row's lifecycle, THEN `destroy(rootId)`.
 *
 * The tree operation is the ONE removal — the same verb that closes a pane,
 * pointed at the root — and what `endSession` adds is the lifecycle consequence
 * a pane destroy does not have: a session owns a sandbox, an `endedAt`, and a
 * billing history, none of which is a fact about a node.
 *
 * **The two are NOT one transaction, deliberately.** A Sprite is outside the
 * database, so "transactional with the node write" would be a distributed
 * transaction wearing a local disguise — and buying it would mean threading an
 * executor through the teardown path, putting a network call to the sandbox
 * provider inside the workspace's advisory lock. It is also unnecessary: a
 * Sprite is keyed off the workspace id, `endAgentSession` stamps
 * `teardownRequestedAt` BEFORE it kills, and `sprite-orphan-reconcile.ts` reaps
 * anything carrying that stamp without a confirmed kill.
 *
 * So what is left to hold down is an ORDER, and this suite is what holds it:
 *
 *  - **Lifecycle first.** From `endAgentSession`'s first durable write onward,
 *    the reconciler owns the VM. A crash before the tree write leaves an ended
 *    row and a stale tree — visible, harmless, and cleared by re-issuing.
 *  - **Tree second, and best-effort.** The session is ended once the row says
 *    so; reporting a teardown failure because some layout rows outlived it would
 *    tell the caller the compute is still running when it is not.
 *
 * The reverse order is the one that costs money: tree gone, row un-stamped, and
 * a live Sprite with NO teardown request against it — which the reconciler will
 * not touch, because an explicit recorded intent is what licenses it to destroy
 * anything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];

/**
 * What the composition REPORTED. The refusal arms are indistinguishable by
 * return value — `endSession` answers the lifecycle result whatever the tree
 * write says — so the log line is the only observable difference between "the
 * tree outlived the end" (an operator's problem) and "someone reopened the
 * session" (nobody's).
 */
const logged = { error: [] as string[], info: [] as string[] };

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      error: (message: string) => logged.error.push(message),
      info: (message: string) => logged.info.push(message),
      warn: (message: string) => logged.info.push(message),
    },
  },
}));

const endAgentSession = vi.fn(async () => {
  calls.push('endAgentSession');
  return { ok: true as const, spriteTornDown: true };
});
const destroyWorkspaceTree = vi.fn(async () => {
  calls.push('destroyWorkspaceTree');
  return { status: 'ok' as const, snapshot: { rev: 2, nodes: [], targets: [] }, changed: true };
});

/**
 * The store is mocked at ITS OWN module, not by spying on the runtime's
 * `getAgentSessionStore` export: `endSession` calls that function through its
 * module-local binding, so a spy on the exported name would never be reached.
 */
vi.mock('@pagespace/lib/services/agent-workspaces/agent-workspaces-store', () => ({
  createDbAgentSessionStore: async () => ({
    findById: async (id: string) => (id === 'ws-missing' ? null : { id, ownerId: 'user-1' }),
  }),
}));

vi.mock('@/lib/sandbox/sprites-client', () => ({
  createProductionSandboxHost: () => ({ kill: async () => undefined }),
}));

vi.mock('@pagespace/lib/services/agent-workspaces/agent-workspaces', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@pagespace/lib/services/agent-workspaces/agent-workspaces',
  );
  return { ...actual, endAgentSession: (...args: unknown[]) => endAgentSession(...(args as [])) };
});

vi.mock('../workspace-node-runtime', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../workspace-node-runtime');
  return { ...actual, destroyWorkspaceTree: (...args: unknown[]) => destroyWorkspaceTree(...(args as [])) };
});

const runtime = await import('../agent-workspaces-runtime');

beforeEach(() => {
  calls.length = 0;
  logged.error.length = 0;
  logged.info.length = 0;
  endAgentSession.mockClear();
  destroyWorkspaceTree.mockClear();
});

describe('endSession', () => {
  it('settles the ROW first, then destroys the tree', async () => {
    await runtime.endSession('ws-1');
    expect(calls).toEqual(['endAgentSession', 'destroyWorkspaceTree']);
  });

  it('destroys the tree with the workspace OWNER as the acting user', async () => {
    // Nothing is bound by this write, so the gate has nothing to judge — but the
    // funnel takes an actor, and the row itself carries the identity rather than
    // this call having to be told one.
    await runtime.endSession('ws-1');
    expect(destroyWorkspaceTree).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      actingUserId: 'user-1',
      requireEnded: true,
    });
  });

  it('asks the destroy to REQUIRE the end still being in force', async () => {
    // The other half of "lifecycle first, tree second". The stamp above lands
    // outside the workspace lock, so an admission can take the lock in between,
    // write its node and clear `endedAt` (new work reopens an ended session's
    // listing). Without this flag the destroy that follows wipes that tree and
    // leaves a LIVE workspace holding nothing — the zero-pane session this epic
    // exists to delete, produced by its own end path.
    await runtime.endSession('ws-1');
    const [call] = destroyWorkspaceTree.mock.calls as unknown as [{ requireEnded?: boolean }][];
    expect(call[0].requireEnded).toBe(true);
  });

  it('treats a REOPENED session as a non-failure — INFO, never the error every other refusal logs', async () => {
    // The assertion is the LOG, not the return value: `endSession` answers the
    // lifecycle result whatever the destroy says, so asserting `ok` here would
    // pass with the whole `session_reopened` arm deleted — it would be a copy of
    // the `no_root` test below.
    //
    // What the arm actually changes is the report. An admission winning this
    // race is a session someone deliberately put work back into, so it is not a
    // "session ended but its tree was not destroyed" fault for an operator to
    // chase; every other refusal is.
    destroyWorkspaceTree.mockResolvedValueOnce({
      status: 'refused',
      code: 'session_reopened',
      detail: 'reopened',
    } as never);
    const result = await runtime.endSession('ws-1');

    expect(result.ok).toBe(true);
    expect(logged.error).toEqual([]);
    expect(logged.info).toHaveLength(1);
    expect(logged.info[0]).toContain('reopened');
  });

  it('does NOT destroy the tree when the lifecycle end failed', async () => {
    // The teardown did not happen, so the session is still live. Removing its
    // layout would leave a working session with nothing on screen.
    endAgentSession.mockResolvedValueOnce({ ok: false, reason: 'teardown_failed' } as never);
    const result = await runtime.endSession('ws-1');
    expect(result.ok).toBe(false);
    expect(destroyWorkspaceTree).not.toHaveBeenCalled();
  });

  it('reports the lifecycle result even when the tree write is refused', async () => {
    // Best-effort by design: the compute is released, and saying otherwise would
    // send the caller chasing a sandbox that is already gone.
    destroyWorkspaceTree.mockResolvedValueOnce({
      status: 'refused',
      code: 'no_root',
      detail: 'nope',
    } as never);
    const result = await runtime.endSession('ws-1');
    expect(result).toEqual({ ok: true, spriteTornDown: true });
  });

  it('answers not_found for a workspace with no row, without touching the tree', async () => {
    endAgentSession.mockResolvedValueOnce({ ok: false, reason: 'not_found' } as never);
    const result = await runtime.endSession('ws-missing');
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(destroyWorkspaceTree).not.toHaveBeenCalled();
  });
});
