import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { stampColumns, revivedAgentSessionColumns } from '../agent-workspaces-store';
import { MAX_ACTIVE_WORKSPACES_PER_OWNER } from '../../../agent-workspaces/session-contract';
import { NOW, OWNER_ID, makeAgentSessionStore, makeSessionRecord } from './fakes';

/**
 * The two pure halves of the store: how a lifecycle verdict's stamps become
 * columns, and what recording a live Sprite writes. Both exist so that no call
 * site re-derives "which columns does this verdict touch" — the mistake that
 * lets a row end up carrying a new identity with the previous generation's
 * teardown marks still on it.
 */
describe('stampColumns', () => {
  it('given no stamps, should write nothing — an empty verdict must not clobber columns', () => {
    expect(stampColumns({})).toEqual({});
  });

  it('given an explicit null, should CLEAR the column', () => {
    expect(stampColumns({ endedAt: null })).toEqual({ endedAt: null });
  });

  it('should distinguish "clear it" from "leave it alone"', () => {
    // The whole encoding: absent ≠ null. Spreading the stamps object wholesale is
    // what would collapse these two into one.
    const cleared = stampColumns({ teardownRequestedAt: null });
    expect(cleared).toHaveProperty('teardownRequestedAt');
    expect(cleared).not.toHaveProperty('spriteTornDownAt');
  });

  it('given a full revive verdict, should carry every column it names', () => {
    expect(
      stampColumns({
        lastActiveAt: NOW,
        endedAt: null,
        teardownRequestedAt: null,
        spriteTornDownAt: null,
        storageMeasuredBytes: null,
        storageMeasuredAt: null,
      }),
    ).toEqual({
      lastActiveAt: NOW,
      endedAt: null,
      teardownRequestedAt: null,
      spriteTornDownAt: null,
      storageMeasuredBytes: null,
      storageMeasuredAt: null,
    });
  });

  it('given a teardown verdict, should carry its three stamps and nothing else', () => {
    expect(stampColumns({ teardownRequestedAt: NOW, spriteTornDownAt: NOW, endedAt: NOW })).toEqual({
      teardownRequestedAt: NOW,
      spriteTornDownAt: NOW,
      endedAt: NOW,
    });
  });
});

describe('revivedAgentSessionColumns', () => {
  const base = {
    spriteKey: 'pgs-ses-new',
    sandboxId: 'pgs-ses-new',
    spriteInstanceId: 'inst-new',
    egressPolicyToken: 'tok',
    now: NOW,
    // An SQL EXPRESSION, because the parameter's type refuses a bare `Date` —
    // that refusal is what stops a caller silently dropping the monotonic
    // `GREATEST(...)` the real stores build. The shape here is irrelevant; that
    // the helper carries it through unchanged is the point.
    storageLastBilledAt: sql`GREATEST("storageLastBilledAt", ${NOW})`,
  };

  it('should record the new Sprite identity', () => {
    const columns = revivedAgentSessionColumns({ ...base, stamps: {} });
    expect(columns.spriteKey).toBe('pgs-ses-new');
    expect(columns.sandboxId).toBe('pgs-ses-new');
    expect(columns.spriteInstanceId).toBe('inst-new');
    expect(columns.egressPolicyToken).toBe('tok');
    expect(columns.updatedAt).toEqual(NOW);
  });

  it('should RESTART the storage accounting period — a new VM is a new, empty disk', () => {
    // Not a lifecycle stamp, which is why it lives here: billing the elapsed
    // window against the dead generation's measured size would charge for a
    // filesystem that no longer exists.
    //
    // The VALUE is the caller's, not `now`'s: the store passes a monotonic
    // `GREATEST(...)` expression, because `now` is captured before the provider
    // IO and can be stale enough to drag the watermark back over a window a
    // reconcile tick already billed. What this helper owes is to carry that
    // value through — the direction is proven against real SQL in
    // `sandbox-storage-billing.integration.test.ts`.
    const restartedAt = sql`GREATEST("storageLastBilledAt", ${new Date('2026-07-02T00:00:00.000Z')})`;
    const columns = revivedAgentSessionColumns({ ...base, storageLastBilledAt: restartedAt, stamps: {} });
    expect(columns.storageLastBilledAt).toBe(restartedAt);
  });

  it('should apply the verdict\'s stamps alongside the identity, in ONE write', () => {
    const columns = revivedAgentSessionColumns({
      ...base,
      stamps: { lastActiveAt: NOW, endedAt: null, teardownRequestedAt: null, spriteTornDownAt: null },
    });
    expect(columns).toMatchObject({
      sandboxId: 'pgs-ses-new',
      lastActiveAt: NOW,
      endedAt: null,
      teardownRequestedAt: null,
      spriteTornDownAt: null,
    });
  });

  it('should carry a null spriteInstanceId through (the driver could not report one)', () => {
    expect(revivedAgentSessionColumns({ ...base, spriteInstanceId: null, stamps: {} }).spriteInstanceId).toBeNull();
  });
});

/**
 * The in-memory fake claims to mirror the real store's `list`/`applyStamps`/
 * `stampSpriteTornDown` behavior — pinned here so drift between the two shows
 * up as a failing test rather than a fake that quietly answers a query shape
 * the real store never allows (review #2266).
 */
describe("fake store — mirrors the real store's pinned behaviors", () => {
  it('given more active sessions than MAX_ACTIVE_WORKSPACES_PER_OWNER, list should cap at the limit', async () => {
    const seed = Array.from({ length: MAX_ACTIVE_WORKSPACES_PER_OWNER + 5 }, (_, index) =>
      makeSessionRecord({ id: `ses-cap-${index}`, lastActiveAt: new Date(NOW.getTime() - index) }),
    );
    const store = makeAgentSessionStore(seed);

    const listed = await store.store.list({ ownerId: OWNER_ID });

    expect(listed).toHaveLength(MAX_ACTIVE_WORKSPACES_PER_OWNER);
    // Newest activity first: the kept slice is the first MAX_ACTIVE_WORKSPACES_PER_OWNER rows.
    expect(listed[0].id).toBe('ses-cap-0');
    expect(listed[listed.length - 1].id).toBe(`ses-cap-${MAX_ACTIVE_WORKSPACES_PER_OWNER - 1}`);
  });

  it("applyStamps should bump updatedAt, mirroring the real store's own bookkeeping touch", async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const row = makeSessionRecord();
    const store = makeAgentSessionStore([row], () => later);

    await store.store.applyStamps({ workspaceId: row.id, stamps: { lastActiveAt: later } });

    expect(store.rows.get(row.id)!.updatedAt).toEqual(later);
  });

  it('applyStamps with nothing to write should leave updatedAt untouched — an empty verdict is a real no-op', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const row = makeSessionRecord();
    const store = makeAgentSessionStore([row], () => later);

    await store.store.applyStamps({ workspaceId: row.id, stamps: {} });

    expect(store.rows.get(row.id)!.updatedAt).toEqual(NOW);
  });

  it('stampSpriteTornDown should bump updatedAt on a successful CAS', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const provisioned = makeSessionRecord({ sandboxId: 'sbx-1', spriteInstanceId: 'inst-1' });
    const store = makeAgentSessionStore([provisioned], () => later);

    const ok = await store.store.stampSpriteTornDown({
      workspaceId: provisioned.id,
      sandboxId: 'sbx-1',
      spriteInstanceId: 'inst-1',
      stamps: { spriteTornDownAt: later },
    });

    expect(ok).toBe(true);
    expect(store.rows.get(provisioned.id)!.updatedAt).toEqual(later);
  });
});
