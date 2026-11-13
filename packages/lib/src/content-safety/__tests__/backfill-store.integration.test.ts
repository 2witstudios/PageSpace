/**
 * The backfill cursor and the readiness counts against REAL Postgres: the lease
 * keeps two ticks apart, the cursor persists what a tick saved, and a whole
 * tick resumes from it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { contentScanBackfill, contentScans } from '@pagespace/db/schema/content-safety';
import { emptyBackfillCounts, runBackfillTick, type BackfillDeps, type BackfillTarget } from '../backfill';
import { BackfillLeaseLostError, claimBackfillCursor, readBackfillCursor, saveBackfillCursor } from '../backfill-store';
import { countShadowOutcomesSince, findScanVerdicts, recordScanVerdict } from '../scan-store';

const ids: string[] = [];
const hashes: string[] = [];
const newId = () => {
  const id = `test-${randomUUID()}`;
  ids.push(id);
  return id;
};
const newHash = () => {
  const hash = createHash('sha256').update(randomUUID()).digest('hex');
  hashes.push(hash);
  return hash;
};

afterAll(async () => {
  if (ids.length > 0) await db.delete(contentScanBackfill).where(inArray(contentScanBackfill.id, ids));
  if (hashes.length > 0) await db.delete(contentScans).where(inArray(contentScans.contentHash, hashes));
});

describe('backfill store', () => {
  it('creates the cursor on first claim, and a held lease refuses a second claim until released or expired', async () => {
    const id = newId();
    const now = new Date('2026-11-13T00:00:00Z');
    const first = await claimBackfillCursor(now, 60_000, id);
    expect(first).toMatchObject({ phase: 'assets', startAfter: null, pass: 1, counts: emptyBackfillCounts() });
    expect(await claimBackfillCursor(new Date(now.getTime() + 1000), 60_000, id)).toBeNull();

    await saveBackfillCursor({ ...first!, startAfter: 'assets/abc', counts: { ...emptyBackfillCounts(), listed: 3 } }, { release: true }, id);
    expect(await claimBackfillCursor(new Date(now.getTime() + 2000), 60_000, id)).toMatchObject({ startAfter: 'assets/abc', counts: { listed: 3 } });

    // Not released: a crashed tick's lease expires.
    expect(await claimBackfillCursor(new Date(now.getTime() + 3000), 60_000, id)).toBeNull();
    expect(await claimBackfillCursor(new Date(now.getTime() + 120_000), 60_000, id)).not.toBeNull();
  });

  it('a run whose lease expired and was taken over cannot save over the new holder', async () => {
    const id = newId();
    const now = new Date('2026-11-13T00:00:00Z');
    const stale = await claimBackfillCursor(now, 60_000, id);
    const fresh = await claimBackfillCursor(new Date(now.getTime() + 120_000), 60_000, id);
    expect(fresh).not.toBeNull();
    await expect(saveBackfillCursor({ ...stale!, startAfter: 'assets/stale' }, { release: true }, id)).rejects.toBeInstanceOf(BackfillLeaseLostError);
    await saveBackfillCursor({ ...fresh!, startAfter: 'assets/fresh' }, { release: false }, id);
    expect(await readBackfillCursor(id)).toMatchObject({ startAfter: 'assets/fresh', leased: false });
  });

  it('a tick against the real cursor resumes where the previous one stopped and respects the limit', async () => {
    const id = newId();
    const keys = ['avatars/u1/avatar.png', 'avatars/u2/avatar.png', 'avatars/u3/avatar.png'];
    const processed: string[] = [];
    const deps: BackfillDeps = {
      claim: (now, leaseMs) => claimBackfillCursor(now, leaseMs, id),
      save: (cursor, options) => saveBackfillCursor(cursor, options, id),
      async list(phase, startAfter, maxKeys) {
        const all = phase === 'avatars' ? keys : [];
        const after = all.filter((key) => startAfter === null || key > startAfter);
        return { objects: after.slice(0, maxKeys).map((key) => ({ key, size: 1 })), truncated: after.length > maxKeys };
      },
      async process(target: BackfillTarget) {
        processed.push(target.key);
        return { finding: 'clean', scanned: true, removed: false };
      },
      now: () => new Date(),
    };
    const config = { itemsPerTick: 2, repassAfterMs: 24 * 60 * 60 * 1000, leaseMs: 60_000 };
    await runBackfillTick(deps, config);
    expect(processed).toEqual(keys.slice(0, 2));
    expect(await readBackfillCursor(id)).toMatchObject({ phase: 'avatars', startAfter: keys[1], leased: false });

    await expect(runBackfillTick(deps, config)).resolves.toMatchObject({ completed: true });
    expect(processed).toEqual(keys);
    const done = await readBackfillCursor(id);
    expect(done).toMatchObject({ phase: 'done', lastPassCounts: { listed: 3, scanned: 3 } });
    expect(done?.lastCompletedAt).toBeInstanceOf(Date);
  });

  it('finds many verdicts at once and counts shadow outcomes since a date', async () => {
    const [a, b, c] = [newHash(), newHash(), newHash()];
    await recordScanVerdict({ contentHash: a, verdict: 'flagged', outcome: 'classifier_flag', provider: 'hive', mode: 'shadow', scores: {} }, new Date('2026-11-10T00:00:00Z'));
    await recordScanVerdict({ contentHash: b, verdict: 'unverified', outcome: 'unverified', provider: 'hive', mode: 'shadow', scores: {} }, new Date('2026-11-10T00:00:00Z'));
    await recordScanVerdict({ contentHash: c, verdict: 'clean', outcome: 'clean', provider: 'hive', mode: 'enforce', scores: {} }, new Date('2026-11-10T00:00:00Z'));

    const found = await findScanVerdicts([a, b, c, newHash()]);
    expect([...found.keys()].sort()).toEqual([a, b, c].sort());
    expect(found.get(b)).toMatchObject({ verdict: 'unverified' });

    const counts = await countShadowOutcomesSince(new Date('2026-11-09T00:00:00Z'));
    expect(counts.find((row) => row.outcome === 'classifier_flag')?.count).toBeGreaterThanOrEqual(1);
    expect(counts.find((row) => row.outcome === 'unverified')?.count).toBeGreaterThanOrEqual(1);
    await db.delete(contentScans).where(eq(contentScans.contentHash, a));
  });
});
