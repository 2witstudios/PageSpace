import { describe, it, expect, vi } from 'vitest';
import {
  reconcileOrphanSprites,
  type SpriteOrphanRow,
  type ReconcileOrphanSpritesDeps,
} from '../sprite-orphan-reconcile';

/**
 * Carried from `services/machines/__tests__/machine-orphan-reconcile.test.ts`
 * and re-pointed: the outbox arm is unchanged, and the tracking-row arm now
 * enumerates `agent_workspaces` only. The guard that was "is the page still
 * trashed" is now "is the teardown still requested" — the same question (has the
 * thing that licensed an irreversible destroy been withdrawn since we listed it),
 * asked of the model that replaced pages-and-machines.
 */
function makeDeps(over: Partial<ReconcileOrphanSpritesDeps> = {}): {
  deps: ReconcileOrphanSpritesDeps;
  killed: string[];
  stampedSessions: string[];
  releasedReclaims: string[];
  notedFailures: string[];
  chasedInstances: Array<{ sandboxId: string; actualInstanceId: string }>;
} {
  const killed: string[] = [];
  const stampedSessions: string[] = [];
  const releasedReclaims: string[] = [];
  const notedFailures: string[] = [];
  const chasedInstances: Array<{ sandboxId: string; actualInstanceId: string }> = [];
  const deps: ReconcileOrphanSpritesDeps = {
    listOrphanCandidates: async () => ({ rows: [], capped: false }),
    isTeardownStillRequested: async () => true,
    killSprite: async ({ sandboxId }) => {
      killed.push(sandboxId);
      return { ok: true };
    },
    markSessionTornDown: async ({ workspaceId }) => {
      stampedSessions.push(workspaceId);
      return true;
    },
    releaseReclaim: async (sandboxId) => {
      releasedReclaims.push(sandboxId);
    },
    noteReclaimFailure: async ({ sandboxId }) => {
      notedFailures.push(sandboxId);
    },
    chaseReclaimInstance: async ({ sandboxId, actualInstanceId }) => {
      chasedInstances.push({ sandboxId, actualInstanceId });
    },
    ...over,
  };
  return { deps, killed, stampedSessions, releasedReclaims, notedFailures, chasedInstances };
}

const sessionRow: SpriteOrphanRow = {
  kind: 'agent-session',
  workspaceId: 'conv-1',
  sandboxId: 'pgs-ses-1',
  spriteInstanceId: 'inst-1',
};

const reclaimRow: SpriteOrphanRow = {
  kind: 'reclaim',
  sandboxId: 'pgs-ses-orphaned',
  spriteInstanceId: 'inst-orphaned',
};

describe('reconcileOrphanSprites — the reclaim outbox (a pointer whose row is already gone)', () => {
  it('kills an outbox Sprite and drops its pointer, WITHOUT any liveness re-check — there is no session left to revive', async () => {
    const isTeardownStillRequested = vi.fn(async () => true);
    const { deps, killed, releasedReclaims } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [reclaimRow], capped: false }),
      isTeardownStillRequested,
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, incomplete: false, torndown: 1, skipped: 0, failed: 0 });
    expect(killed).toEqual(['pgs-ses-orphaned']);
    expect(releasedReclaims).toEqual(['pgs-ses-orphaned']);
    // The row was hard-deleted (conversation deleted, page purged, drive deleted,
    // account erased) — asking whether its teardown is still requested is
    // meaningless, and the pointer must not be skipped.
    expect(isTeardownStillRequested).not.toHaveBeenCalled();
  });

  it('KEEPS the outbox row when the kill fails, recording the failure — it is the last pointer in existence', async () => {
    const { deps, releasedReclaims, notedFailures } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [reclaimRow], capped: false }),
      killSprite: async () => ({ ok: false, error: new Error('sprite unreachable') }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toMatchObject({ torndown: 0, failed: 1 });
    expect(releasedReclaims).toEqual([]); // dropping it would strand the Sprite forever
    expect(notedFailures).toEqual(['pgs-ses-orphaned']); // surfaced, not silently retried
  });

  it('counts a row ONCE when even the failure-bookkeeping write fails', async () => {
    const { deps, releasedReclaims } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [reclaimRow], capped: false }),
      killSprite: async () => ({ ok: false, error: new Error('sprite unreachable') }),
      noteReclaimFailure: async () => {
        throw new Error('db write failed');
      },
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, incomplete: false, torndown: 0, skipped: 0, failed: 1 });
    expect(releasedReclaims).toEqual([]); // and the pointer survives
  });

  it('#2254: given the name now holds a DIFFERENT VM, should CHASE the pointer rather than releasing it', async () => {
    // The outbox row is the LAST pointer to whatever VM exists under this name
    // — unlike an `agent-session` row, there is no live row's own CAS left to
    // protect a replacement. A stale outbox instance (e.g. from the 0234
    // rescue's `ON CONFLICT DO NOTHING`) must never read as "confirmed killed":
    // that would delete the only pointer to a Sprite that is still alive.
    const { deps, killed, releasedReclaims, chasedInstances } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [reclaimRow], capped: false }),
      killSprite: async () => ({ ok: 'replaced', actualInstanceId: 'inst-live-now' }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, incomplete: false, torndown: 0, skipped: 1, failed: 0 });
    expect(killed).toEqual([]); // killSprite itself is stubbed, but the point is nothing was RELEASED
    expect(releasedReclaims).toEqual([]);
    expect(chasedInstances).toEqual([{ sandboxId: 'pgs-ses-orphaned', actualInstanceId: 'inst-live-now' }]);
  });

  it('#2254: given the chase write itself fails, should still leave the pointer in place', async () => {
    const { deps, releasedReclaims } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [reclaimRow], capped: false }),
      killSprite: async () => ({ ok: 'replaced', actualInstanceId: 'inst-live-now' }),
      chaseReclaimInstance: async () => {
        throw new Error('db write failed');
      },
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toMatchObject({ torndown: 0, skipped: 1, failed: 0 });
    expect(releasedReclaims).toEqual([]);
  });
});

describe('reconcileOrphanSprites — agent-session rows whose teardown never confirmed', () => {
  it('kills the Sprite and STAMPS the session row rather than deleting it', async () => {
    // The row is re-provisionable identity: it re-acquires a sandbox under the
    // same sessionKey, and deleting it would sever the conversation's only link
    // to the sandbox it owned.
    const { deps, killed, stampedSessions } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow], capped: false }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, incomplete: false, torndown: 1, skipped: 0, failed: 0 });
    expect(killed).toEqual(['pgs-ses-1']);
    expect(stampedSessions).toEqual(['conv-1']);
  });

  it('NEVER kills the Sprite of a session REVIVED since the candidate list was read', async () => {
    // The one irreversible mistake this cron could make: destroying a live
    // session's filesystem. A concurrent ensure clears the teardown request as
    // part of recording the new identity, and this re-read is what sees that.
    const killSprite = vi.fn(async () => ({ ok: true }) as const);
    const revived: SpriteOrphanRow = { ...sessionRow, workspaceId: 'conv-revived', sandboxId: 'pgs-ses-revived' };
    const { deps, stampedSessions } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [revived, sessionRow], capped: false }),
      isTeardownStillRequested: async (workspaceId) => workspaceId !== 'conv-revived',
      killSprite,
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 2, capped: false, incomplete: false, torndown: 1, skipped: 1, failed: 0 });
    expect(killSprite).toHaveBeenCalledTimes(1);
    expect(killSprite).toHaveBeenCalledWith({ sandboxId: 'pgs-ses-1', spriteInstanceId: 'inst-1' });
    expect(stampedSessions).toEqual(['conv-1']);
  });

  it('#2254: given the name now holds a DIFFERENT VM, should still treat it as confirmed-gone — the row\'s own CAS protects a live replacement', async () => {
    // Unlike a `reclaim` row, an `agent-session` row is not the last pointer:
    // `markSessionTornDown`'s own instance CAS already refuses to mark a live
    // replacement dead, so a replaced-instance kill can be handled exactly like
    // a confirmed one here.
    const { deps, stampedSessions, chasedInstances } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow], capped: false }),
      killSprite: async () => ({ ok: 'replaced', actualInstanceId: 'inst-new' }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, incomplete: false, torndown: 1, skipped: 0, failed: 0 });
    expect(stampedSessions).toEqual(['conv-1']);
    expect(chasedInstances).toEqual([]); // chasing is only meaningful for a reclaim row
  });

  it('counts a CAS lost to a concurrent re-provision as skipped, not torn down', async () => {
    // The stamp is conditional on the row still pointing at the INSTANCE we
    // killed. Losing it means a LIVE Sprite now owns that row — recording it as
    // dead would make it invisible to this cron forever.
    const { deps } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow], capped: false }),
      markSessionTornDown: async () => false,
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, incomplete: false, torndown: 0, skipped: 1, failed: 0 });
  });

  it('stamps the row for a Sprite that is ALREADY gone — the idempotent kill reports ok', async () => {
    const { deps, stampedSessions } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow], capped: false }),
      killSprite: async () => ({ ok: true }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toMatchObject({ torndown: 1, failed: 0 });
    expect(stampedSessions).toEqual(['conv-1']);
  });

  it('LEAVES the row untouched when the kill fails — it is the only pointer to the Sprite', async () => {
    const other: SpriteOrphanRow = { ...sessionRow, workspaceId: 'conv-2', sandboxId: 'pgs-ses-2' };
    const { deps, stampedSessions } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow, other], capped: false }),
      killSprite: async ({ sandboxId }) =>
        sandboxId === 'pgs-ses-1' ? { ok: false, error: new Error('sprite unreachable') } : { ok: true },
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 2, capped: false, incomplete: false, torndown: 1, skipped: 0, failed: 1 });
    expect(stampedSessions).toEqual(['conv-2']); // the failed row keeps its pointer for the next run
  });

  it('isolates a failing row — one bad Sprite never aborts the rest of the batch', async () => {
    const killSprite = vi.fn(async ({ sandboxId }: { sandboxId: string; spriteInstanceId: string | null }) => {
      if (sandboxId === 'boom') throw new Error('host exploded');
      return { ok: true } as const;
    });
    const { deps, stampedSessions } = makeDeps({
      listOrphanCandidates: async () => ({
        rows: [
          { kind: 'agent-session', workspaceId: 'conv-a', sandboxId: 'ok-a', spriteInstanceId: null },
          { kind: 'agent-session', workspaceId: 'conv-boom', sandboxId: 'boom', spriteInstanceId: null },
          { kind: 'agent-session', workspaceId: 'conv-b', sandboxId: 'ok-b', spriteInstanceId: null },
        ],
        capped: false,
      }),
      killSprite,
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 3, capped: false, incomplete: false, torndown: 2, skipped: 0, failed: 1 });
    expect(killSprite).toHaveBeenCalledTimes(3);
    expect(stampedSessions).toEqual(['conv-a', 'conv-b']);
  });

  it('counts a post-kill stamp failure as failed, leaving the row for the next (idempotent) run', async () => {
    const { deps, killed } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow], capped: false }),
      markSessionTornDown: async () => {
        throw new Error('db write failed');
      },
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 1, capped: false, incomplete: false, torndown: 0, skipped: 0, failed: 1 });
    // The Sprite IS dead; the next run's kill is idempotent, so it simply stamps then.
    expect(killed).toEqual(['pgs-ses-1']);
  });

  it('drains a mixed batch — outbox pointers and session rows in one run', async () => {
    const { deps, killed, stampedSessions, releasedReclaims } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [reclaimRow, sessionRow], capped: false }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 2, capped: false, incomplete: false, torndown: 2, skipped: 0, failed: 0 });
    expect(killed).toEqual(['pgs-ses-orphaned', 'pgs-ses-1']);
    expect(releasedReclaims).toEqual(['pgs-ses-orphaned']);
    expect(stampedSessions).toEqual(['conv-1']);
  });

  it('reports a CAPPED run so a partial sweep never reads as a clean one', async () => {
    const { deps } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [sessionRow], capped: true }),
    });

    const result = await reconcileOrphanSprites(deps);

    expect(result).toMatchObject({ capped: true, torndown: 1 });
  });

  it('passes the Sprite INSTANCE to the kill, not just the reused name', async () => {
    // `sandboxId` is the derived session key, REUSED across re-creates — so "kill
    // whatever holds this name" would destroy a replacement VM that legitimately
    // took the name after our target was already gone.
    const killSprite = vi.fn(async () => ({ ok: true }) as const);
    const { deps } = makeDeps({
      listOrphanCandidates: async () => ({ rows: [reclaimRow], capped: false }),
      killSprite,
    });

    await reconcileOrphanSprites(deps);

    expect(killSprite).toHaveBeenCalledWith({
      sandboxId: 'pgs-ses-orphaned',
      spriteInstanceId: 'inst-orphaned',
    });
  });

  it('is a clean no-op when nothing is orphaned — no kills, no writes', async () => {
    const { deps, killed, stampedSessions, releasedReclaims } = makeDeps();

    const result = await reconcileOrphanSprites(deps);

    expect(result).toEqual({ processed: 0, capped: false, incomplete: false, torndown: 0, skipped: 0, failed: 0 });
    expect(killed).toEqual([]);
    expect(stampedSessions).toEqual([]);
    expect(releasedReclaims).toEqual([]);
  });
});
