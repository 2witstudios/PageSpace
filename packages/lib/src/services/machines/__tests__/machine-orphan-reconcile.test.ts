import { describe, it, expect, vi } from 'vitest';
import {
  reconcileOrphanSprites,
  type OrphanRow,
  type ReconcileOrphanSpritesDeps,
} from '../machine-orphan-reconcile';

function makeDeps(over: Partial<ReconcileOrphanSpritesDeps> = {}): {
  deps: ReconcileOrphanSpritesDeps;
  killed: string[];
  releasedSessions: string[];
  stampedBranches: string[];
  stampedProjects: string[];
  releasedReclaims: string[];
  notedFailures: string[];
} {
  const killed: string[] = [];
  const releasedSessions: string[] = [];
  const stampedBranches: string[] = [];
  const stampedProjects: string[] = [];
  const releasedReclaims: string[] = [];
  const notedFailures: string[] = [];
  const deps: ReconcileOrphanSpritesDeps = {
    listOrphanCandidates: async () => ({ rows: [], capped: false }),
    isStillTrashed: async () => true,
    killSprite: async ({ sandboxId }) => {
      killed.push(sandboxId);
      return { ok: true };
    },
    releaseSessionRow: async ({ sessionKey }) => {
      releasedSessions.push(sessionKey);
      return true;
    },
    markBranchTornDown: async ({ id }) => {
      stampedBranches.push(id);
      return true;
    },
    markProjectTornDown: async ({ id }) => {
      stampedProjects.push(id);
      return true;
    },
    releaseReclaim: async (sandboxId) => {
      releasedReclaims.push(sandboxId);
    },
    noteReclaimFailure: async ({ sandboxId }) => {
      notedFailures.push(sandboxId);
    },
    ...over,
  };
  return { deps, killed, releasedSessions, stampedBranches, stampedProjects, releasedReclaims, notedFailures };
}

const sessionRow: OrphanRow = {
  kind: 'session',
  pageId: 'machine-1',
  sessionKey: 'sk-1',
  sandboxId: 'pgs-sbx-1',
  spriteInstanceId: 'inst-1',
};
const branchRow: OrphanRow = {
  kind: 'branch',
  pageId: 'machine-2',
  id: 'branch-1',
  sandboxId: 'pgs-sbx-2',
  spriteInstanceId: 'inst-2',
};

const reclaimRow: OrphanRow = {
  kind: 'reclaim',
  sandboxId: 'pgs-sbx-orphaned',
  spriteInstanceId: 'inst-orphaned',
};

describe('reconcileOrphanSprites — the reclaim outbox (a pointer whose page is already gone)', () => {
  it('kills an outbox Sprite and drops its row, WITHOUT any trash check — there is no page left to restore', async () => {
    const isStillTrashed = vi.fn(async () => true);
    const { deps, killed, releasedReclaims } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [reclaimRow], capped: false }),
      isStillTrashed,
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, torndown: 1, skipped: 0, failed: 0 });
    expect(killed).toEqual(['pgs-sbx-orphaned']);
    expect(releasedReclaims).toEqual(['pgs-sbx-orphaned']);
    // The page was hard-deleted (purge / drive delete / account erasure) — asking
    // whether it is "still trashed" is meaningless, and the row must not be skipped.
    expect(isStillTrashed).not.toHaveBeenCalled();
  });

  it('counts a row ONCE when even the failure-bookkeeping write fails', async () => {
    // The kill failed AND the attempt-count write failed. The row must still be a
    // single failure — letting the bookkeeping error reach the outer catch would
    // count it twice and lose the kill error we actually needed to report. The
    // Sprite is retried next run regardless.
    const { deps, releasedReclaims } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [reclaimRow], capped: false }),
      killSprite: async () => ({ ok: false, error: new Error('sprite unreachable') }),
      noteReclaimFailure: async () => {
        throw new Error('db write failed');
      },
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, torndown: 0, skipped: 0, failed: 1 });
    expect(releasedReclaims).toEqual([]); // and the pointer survives
  });

  it('KEEPS the outbox row when the kill fails, recording the failure — it is the last pointer in existence', async () => {
    const { deps, releasedReclaims, notedFailures } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [reclaimRow], capped: false }),
      killSprite: async () => ({ ok: false, error: new Error('sprite unreachable') }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toMatchObject({ torndown: 0, failed: 1 });
    expect(releasedReclaims).toEqual([]); // dropping it would strand the Sprite forever
    expect(notedFailures).toEqual(['pgs-sbx-orphaned']); // surfaced, not silently retried
  });
});

describe('reconcileOrphanSprites', () => {
  it('kills a never-torn-down Machine Sprite and releases its machine_sessions row', async () => {
    const { deps, killed, releasedSessions, stampedBranches } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow], capped: false }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, torndown: 1, skipped: 0, failed: 0 });
    expect(killed).toEqual(['pgs-sbx-1']);
    expect(releasedSessions).toEqual(['sk-1']);
    expect(stampedBranches).toEqual([]);
  });

  it('kills an orphaned branch Sprite and STAMPS its row rather than deleting it', async () => {
    // The branch row is re-creatable config, and its branch-scoped
    // machine_agent_terminals FK-cascade off it — deleting it would destroy the
    // user's branch terminals on a reversible soft-delete.
    const { deps, killed, stampedBranches, releasedSessions } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [branchRow], capped: false }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, torndown: 1, skipped: 0, failed: 0 });
    expect(killed).toEqual(['pgs-sbx-2']);
    expect(stampedBranches).toEqual(['branch-1']);
    expect(releasedSessions).toEqual([]);
  });

  it('kills an orphaned PROMOTED-PROJECT Sprite and STAMPS its row rather than deleting it', async () => {
    // Same shape as the branch case: a promoted project's row is re-creatable
    // config (name + repoUrl + sessionKey re-provision and re-clone), so the
    // reconciler stamps spriteTornDownAt, never deletes.
    const projectRow: OrphanRow = {
      kind: 'project',
      pageId: 'machine-3',
      id: 'project-1',
      sandboxId: 'pgs-sbx-3',
      spriteInstanceId: 'inst-3',
    };
    const { deps, killed, stampedProjects, stampedBranches } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [projectRow], capped: false }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, torndown: 1, skipped: 0, failed: 0 });
    expect(killed).toEqual(['pgs-sbx-3']);
    expect(stampedProjects).toEqual(['project-1']);
    expect(stampedBranches).toEqual([]);
  });

  it('counts a project CAS lost to a concurrent re-promotion as skipped, not torn down', async () => {
    const projectRow: OrphanRow = {
      kind: 'project',
      pageId: 'machine-3',
      id: 'project-1',
      sandboxId: 'pgs-sbx-3',
      spriteInstanceId: 'inst-3',
    };
    const { deps } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [projectRow], capped: false }),
      markProjectTornDown: async () => false,
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, torndown: 0, skipped: 1, failed: 0 });
  });

  it('releases the row for a Sprite that is ALREADY gone — the idempotent kill reports ok', async () => {
    // MachineHost.kill maps a not-found Sprite to a successful kill, so an
    // already-destroyed Sprite must RELEASE its row rather than being retried
    // forever (it would otherwise be a permanent phantom candidate).
    const { deps, releasedSessions } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow], capped: false }),
      killSprite: async () => ({ ok: true }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toMatchObject({ torndown: 1, failed: 0 });
    expect(releasedSessions).toEqual(['sk-1']);
  });

  it('NEVER kills the Sprite of a page restored since the candidate list was read', async () => {
    // The one irreversible mistake this cron could make: destroying a live,
    // restored Machine's filesystem.
    const killSprite = vi.fn(async () => ({ ok: true }) as const);
    const { deps, releasedSessions, stampedBranches } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow, branchRow], capped: false }),
      isStillTrashed: async (pageId) => pageId !== 'machine-1', // machine-1 was restored mid-run
      killSprite,
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 2, capped: false, torndown: 1, skipped: 1, failed: 0 });
    expect(killSprite).toHaveBeenCalledTimes(1);
    expect(killSprite).toHaveBeenCalledWith({ sandboxId: 'pgs-sbx-2', spriteInstanceId: 'inst-2' }); // only the still-trashed one
    expect(releasedSessions).toEqual([]);
    expect(stampedBranches).toEqual(['branch-1']);
  });

  it('counts a CAS that loses to a concurrent restore/re-provision as skipped, not torn down', async () => {
    // The release write is conditional on (page still trashed, sandboxId
    // unchanged). Losing it means a LIVE Sprite now owns that row — it must not
    // be recorded as dead, or it would be invisible to this cron AND to the
    // hard-purge guard.
    const { deps } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [branchRow], capped: false }),
      markBranchTornDown: async () => false,
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, torndown: 0, skipped: 1, failed: 0 });
  });

  it('LEAVES the row untouched when the kill fails — it is the only pointer to the Sprite', async () => {
    const { deps, releasedSessions, stampedBranches } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow, branchRow], capped: false }),
      killSprite: async ({ sandboxId }) =>
        sandboxId === 'pgs-sbx-1' ? { ok: false, error: new Error('sprite unreachable') } : { ok: true },
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 2, capped: false, torndown: 1, skipped: 0, failed: 1 });
    // The failed row keeps its sandboxId on record so the next run retries it.
    expect(releasedSessions).toEqual([]);
    expect(stampedBranches).toEqual(['branch-1']);
  });

  it('isolates a failing row — one bad Sprite never aborts the rest of the batch', async () => {
    const killSprite = vi.fn(async ({ sandboxId }: { sandboxId: string; spriteInstanceId: string | null }) => {
      if (sandboxId === 'boom') throw new Error('host exploded');
      return { ok: true } as const;
    });
    const { deps, releasedSessions } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [
        { kind: 'session', pageId: 'p-a', sessionKey: 'sk-a', sandboxId: 'ok-a', spriteInstanceId: null },
        { kind: 'session', pageId: 'p-boom', sessionKey: 'sk-boom', sandboxId: 'boom', spriteInstanceId: null },
        { kind: 'session', pageId: 'p-b', sessionKey: 'sk-b', sandboxId: 'ok-b', spriteInstanceId: null },
      ], capped: false }),
      killSprite,
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 3, capped: false, torndown: 2, skipped: 0, failed: 1 });
    expect(killSprite).toHaveBeenCalledTimes(3);
    expect(releasedSessions).toEqual(['sk-a', 'sk-b']);
  });

  it('counts a post-kill release failure as failed, leaving the row for the next (idempotent) run', async () => {
    const { deps, killed } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow], capped: false }),
      releaseSessionRow: async () => {
        throw new Error('db write failed');
      },
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, torndown: 0, skipped: 0, failed: 1 });
    // The Sprite IS dead; the next run's kill is idempotent, so it simply releases the row then.
    expect(killed).toEqual(['pgs-sbx-1']);
  });

  it('releases a page\'s session row even when one of its OWN branch kills fails', async () => {
    // A Machine has a session row and several branch rows. A failure on one
    // branch must not hold back the rest of that same page — an early `continue`
    // that bailed per-page (rather than per-row) would silently leave the
    // Machine's own Sprite billing.
    const { deps, releasedSessions, stampedBranches } = makeDeps({
      listOrphanCandidates: async () => ({
        rows: [
          { kind: 'branch', pageId: 'm-1', id: 'b-bad', sandboxId: 'sbx-bad', spriteInstanceId: null },
          { kind: 'branch', pageId: 'm-1', id: 'b-good', sandboxId: 'sbx-good', spriteInstanceId: null },
          { kind: 'session', pageId: 'm-1', sessionKey: 'sk-1', sandboxId: 'sbx-own', spriteInstanceId: null },
        ],
        capped: false,
      }),
      killSprite: async ({ sandboxId }) =>
        sandboxId === 'sbx-bad' ? { ok: false, error: new Error('unreachable') } : { ok: true },
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 3, capped: false, torndown: 2, skipped: 0, failed: 1 });
    expect(stampedBranches).toEqual(['b-good']); // the failed branch keeps its pointer
    expect(releasedSessions).toEqual(['sk-1']); // and the Machine's own Sprite is still reclaimed
  });

  it('reports a CAPPED run so a partial sweep never reads as a clean one', async () => {
    // Silent truncation is the danger: "processed 200, failed 0" looks like the
    // backlog is clear while un-attempted Sprites keep billing.
    const { deps } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow], capped: true }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toMatchObject({ capped: true, torndown: 1 });
  });

  it('passes the Sprite INSTANCE to the kill, not just the reused name', async () => {
    // `sandboxId` is our derived session key, and it is REUSED across re-creates —
    // so "kill whatever holds this name" would destroy a replacement VM that
    // legitimately took the name after our target was already gone. The instance id
    // is what lets the host tell the two apart.
    const killSprite = vi.fn(async () => ({ ok: true }) as const);
    const { deps } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [reclaimRow], capped: false }),
      killSprite,
    });

    await reconcileOrphanSprites(deps);

    expect(killSprite).toHaveBeenCalledWith({
      sandboxId: 'pgs-sbx-orphaned',
      spriteInstanceId: 'inst-orphaned',
    });
  });

  it('is a clean no-op when nothing is orphaned — no kills, no writes', async () => {
    const { deps, killed, releasedSessions, stampedBranches } = makeDeps();

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 0, capped: false, torndown: 0, skipped: 0, failed: 0 });
    expect(killed).toEqual([]);
    expect(releasedSessions).toEqual([]);
    expect(stampedBranches).toEqual([]);
  });
});
