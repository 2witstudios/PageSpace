import { describe, it, expect, vi } from 'vitest';
import {
  reconcileOrphanSprites,
  type OrphanRow,
  type ReconcileOrphanSpritesDeps,
} from '../machine-orphan-reconcile';

function makeDeps(over: Partial<ReconcileOrphanSpritesDeps> = {}): {
  deps: ReconcileOrphanSpritesDeps;
  killed: string[];
  removedSessions: string[];
  removedBranches: string[];
} {
  const killed: string[] = [];
  const removedSessions: string[] = [];
  const removedBranches: string[] = [];
  const deps: ReconcileOrphanSpritesDeps = {
    listOrphanCandidates: async () => [],
    killSprite: async (sandboxId) => {
      killed.push(sandboxId);
      return { ok: true };
    },
    removeSessionRow: async (sessionKey) => {
      removedSessions.push(sessionKey);
    },
    removeBranchRow: async (id) => {
      removedBranches.push(id);
    },
    ...over,
  };
  return { deps, killed, removedSessions, removedBranches };
}

const sessionRow: OrphanRow = { kind: 'session', sessionKey: 'sk-1', sandboxId: 'pgs-sbx-1' };
const branchRow: OrphanRow = { kind: 'branch', id: 'branch-1', sandboxId: 'pgs-sbx-2' };

describe('reconcileOrphanSprites', () => {
  it('kills a never-torn-down Machine Sprite and removes its machine_sessions row', async () => {
    const { deps, killed, removedSessions, removedBranches } = makeDeps({
      listOrphanCandidates: async () => [sessionRow],
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, torndown: 1, failed: 0 });
    expect(killed).toEqual(['pgs-sbx-1']);
    expect(removedSessions).toEqual(['sk-1']);
    expect(removedBranches).toEqual([]);
  });

  it('kills an orphaned branch Sprite and removes its machine_branches row by id', async () => {
    const { deps, killed, removedSessions, removedBranches } = makeDeps({
      listOrphanCandidates: async () => [branchRow],
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, torndown: 1, failed: 0 });
    expect(killed).toEqual(['pgs-sbx-2']);
    expect(removedBranches).toEqual(['branch-1']);
    expect(removedSessions).toEqual([]);
  });

  it('removes the row for a Sprite that is ALREADY gone — the idempotent kill reports ok', async () => {
    // MachineHost.kill maps a not-found Sprite to a successful kill, so an
    // already-destroyed Sprite must CLEAR its tracking row rather than being
    // retried forever (the row is otherwise a permanent phantom candidate).
    const { deps, removedSessions } = makeDeps({
      listOrphanCandidates: async () => [sessionRow],
      killSprite: async () => ({ ok: true }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toMatchObject({ torndown: 1, failed: 0 });
    expect(removedSessions).toEqual(['sk-1']);
  });

  it('LEAVES the tracking row in place when the kill fails — it is the only pointer to the Sprite', async () => {
    const { deps, removedSessions, removedBranches } = makeDeps({
      listOrphanCandidates: async () => [sessionRow, branchRow],
      killSprite: async (sandboxId) =>
        sandboxId === 'pgs-sbx-1' ? { ok: false, error: new Error('sprite unreachable') } : { ok: true },
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 2, torndown: 1, failed: 1 });
    // The failed row keeps its sandboxId on record so the next run retries it.
    expect(removedSessions).toEqual([]);
    expect(removedBranches).toEqual(['branch-1']);
  });

  it('isolates a failing row — one bad Sprite never aborts the rest of the batch', async () => {
    const killSprite = vi.fn(async (sandboxId: string) => {
      if (sandboxId === 'boom') throw new Error('host exploded');
      return { ok: true } as const;
    });
    const { deps, removedSessions } = makeDeps({
      listOrphanCandidates: async () => [
        { kind: 'session', sessionKey: 'sk-a', sandboxId: 'ok-a' },
        { kind: 'session', sessionKey: 'sk-boom', sandboxId: 'boom' },
        { kind: 'session', sessionKey: 'sk-b', sandboxId: 'ok-b' },
      ],
      killSprite,
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 3, torndown: 2, failed: 1 });
    expect(killSprite).toHaveBeenCalledTimes(3);
    expect(removedSessions).toEqual(['sk-a', 'sk-b']);
  });

  it('counts a post-kill row-removal failure as failed, leaving the row for the next (idempotent) run', async () => {
    const { deps, killed } = makeDeps({
      listOrphanCandidates: async () => [sessionRow],
      removeSessionRow: async () => {
        throw new Error('db write failed');
      },
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, torndown: 0, failed: 1 });
    // The Sprite IS dead; the next run's kill is idempotent, so it simply drops the row then.
    expect(killed).toEqual(['pgs-sbx-1']);
  });

  it('is a clean no-op when nothing is orphaned — no kills, no row removals', async () => {
    const { deps, killed, removedSessions, removedBranches } = makeDeps();

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 0, torndown: 0, failed: 0 });
    expect(killed).toEqual([]);
    expect(removedSessions).toEqual([]);
    expect(removedBranches).toEqual([]);
  });
});
