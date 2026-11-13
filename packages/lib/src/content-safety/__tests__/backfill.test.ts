import { describe, expect, it, vi } from 'vitest';
import {
  countItem,
  emptyBackfillCounts,
  parseBackfillKey,
  resolveBackfillConfig,
  runBackfillDryRun,
  runBackfillTick,
  verdictSkipsScan,
  type BackfillConfig,
  type BackfillCursor,
  type BackfillDeps,
  type BackfillItemOutcome,
  type BackfillTarget,
  type BackfillWalkPhase,
  type ListedObject,
} from '../backfill';
import type { StoredVerdict } from '../publish-gate';

const h = (n: number) => n.toString(16).padStart(64, '0');
const NOW = new Date('2026-11-13T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** An in-memory bucket pair and cursor row, listing like S3 (key order, StartAfter, MaxKeys). */
function world(options: { assets?: string[]; avatars?: string[]; cursor?: Partial<BackfillCursor>; leased?: boolean; failOn?: string } = {}) {
  const buckets: Record<BackfillWalkPhase, string[]> = {
    assets: [...(options.assets ?? [])].sort(),
    avatars: [...(options.avatars ?? [])].sort(),
  };
  let row: BackfillCursor | null = options.cursor
    ? { phase: 'assets', startAfter: null, pass: 1, counts: emptyBackfillCounts(), lastPassCounts: null, passStartedAt: NOW, lastCompletedAt: null, ...options.cursor }
    : null;
  let leased = options.leased ?? false;
  const processed: string[] = [];
  const listCalls: Array<{ phase: BackfillWalkPhase; startAfter: string | null; maxKeys: number }> = [];
  const deps: BackfillDeps = {
    claim: vi.fn(async () => {
      if (leased) return null;
      leased = true;
      row ??= { phase: 'assets', startAfter: null, pass: 1, counts: emptyBackfillCounts(), lastPassCounts: null, passStartedAt: NOW, lastCompletedAt: null };
      return row;
    }),
    save: vi.fn(async (cursor: BackfillCursor, { release }: { release: boolean }) => {
      row = cursor;
      if (release) leased = false;
    }),
    list: vi.fn(async (phase: BackfillWalkPhase, startAfter: string | null, maxKeys: number) => {
      listCalls.push({ phase, startAfter, maxKeys });
      const after = buckets[phase].filter((key) => startAfter === null || key > startAfter);
      const objects: ListedObject[] = after.slice(0, maxKeys).map((key) => ({ key, size: 100 }));
      return { objects, truncated: after.length > maxKeys };
    }),
    process: vi.fn(async (target: BackfillTarget): Promise<BackfillItemOutcome> => {
      if (target.key === options.failOn) throw new Error('blocklist unreachable');
      processed.push(target.key);
      return { finding: 'clean', scanned: true, removed: false };
    }),
    now: () => NOW,
  };
  return { deps, processed, listCalls, get row() { return row; }, get leased() { return leased; } };
}

const config = (itemsPerTick: number, repassAfterMs = DAY): BackfillConfig => ({ itemsPerTick, repassAfterMs, leaseMs: 60_000 });

describe('parseBackfillKey', () => {
  it('knows public assets, their derived copies and avatars, and nothing else', () => {
    expect(parseBackfillKey('assets', `assets/${h(1)}`)).toEqual({ kind: 'asset', key: `assets/${h(1)}`, contentHash: h(1), derived: false });
    expect(parseBackfillKey('assets', `assets/cache/${h(2)}/thumbnail.webp`)).toMatchObject({ contentHash: h(2), derived: true });
    expect(parseBackfillKey('assets', 'assets/not-a-hash')).toBeNull();
    expect(parseBackfillKey('assets', `published/site/index.html`)).toBeNull();
    expect(parseBackfillKey('avatars', 'avatars/user_1/avatar.PNG')).toEqual({ kind: 'avatar', key: 'avatars/user_1/avatar.PNG', userId: 'user_1', extension: 'png' });
    expect(parseBackfillKey('avatars', 'avatars/user_1/other.png')).toBeNull();
    expect(parseBackfillKey('avatars', 'avatars/../x/avatar.png')).toBeNull();
  });
});

describe('resolveBackfillConfig', () => {
  it('has bounded defaults and ignores junk', () => {
    expect(resolveBackfillConfig({})).toMatchObject({ itemsPerTick: 25, repassAfterMs: DAY });
    expect(resolveBackfillConfig({ CONTENT_SCAN_BACKFILL_ITEMS_PER_TICK: '5', CONTENT_SCAN_BACKFILL_REPASS_HOURS: '48' })).toMatchObject({ itemsPerTick: 5, repassAfterMs: 2 * DAY });
    expect(resolveBackfillConfig({ CONTENT_SCAN_BACKFILL_ITEMS_PER_TICK: '100000' }).itemsPerTick).toBe(500);
    expect(resolveBackfillConfig({ CONTENT_SCAN_BACKFILL_ITEMS_PER_TICK: '-1' }).itemsPerTick).toBe(25);
  });
});

describe('runBackfillTick', () => {
  const assets = [1, 2, 3, 4, 5].map((n) => `assets/${h(n)}`);
  const avatars = ['avatars/u1/avatar.png', 'avatars/u2/avatar.jpg'];

  it('respects the per-tick limit and resumes from its persisted cursor', async () => {
    const w = world({ assets, avatars });
    const first = await runBackfillTick(w.deps, config(2));
    expect(first).toMatchObject({ state: 'walked', processed: 2, completed: false, phase: 'assets' });
    expect(w.processed).toEqual(assets.slice(0, 2));
    expect(w.row?.startAfter).toBe(assets[1]);
    expect(w.leased).toBe(false);

    await runBackfillTick(w.deps, config(2));
    expect(w.processed).toEqual(assets.slice(0, 4));
    expect(w.listCalls[w.listCalls.length - 1]).toEqual({ phase: 'assets', startAfter: assets[1], maxKeys: 2 });
  });

  it('walks assets then avatars, and marks the pass complete with its counts', async () => {
    const w = world({ assets, avatars });
    const ticks = [];
    for (let i = 0; i < 4; i++) ticks.push(await runBackfillTick(w.deps, config(2)));
    expect(w.processed).toEqual([...assets, ...avatars]);
    expect(ticks.map((t) => t.state === 'walked' && t.completed)).toEqual([false, false, false, true]);
    expect(w.row).toMatchObject({ phase: 'done', lastCompletedAt: NOW, startAfter: null });
    expect(w.row?.lastPassCounts).toMatchObject({ listed: 7, scanned: 7, clean: 7 });
  });

  it('moves into the next phase in the same tick when budget remains', async () => {
    const w = world({ assets: assets.slice(0, 1), avatars });
    await expect(runBackfillTick(w.deps, config(10))).resolves.toMatchObject({ processed: 3, completed: true });
  });

  it('an object that cannot be checked stops the walk before it; the next tick retries it', async () => {
    const w = world({ assets, failOn: assets[2] });
    await expect(runBackfillTick(w.deps, config(5))).resolves.toMatchObject({ processed: 2, failedKey: assets[2] });
    expect(w.row?.startAfter).toBe(assets[1]);
    expect(w.leased).toBe(false);

    vi.mocked(w.deps.process).mockImplementation(async (target) => {
      w.processed.push(target.key);
      return { finding: 'clean', scanned: false, removed: false };
    });
    await runBackfillTick(w.deps, config(5));
    expect(w.processed).toEqual([...assets.slice(0, 2), ...assets.slice(2)]);
  });

  it('does nothing while another run holds the lease', async () => {
    const w = world({ assets, leased: true });
    await expect(runBackfillTick(w.deps, config(5))).resolves.toEqual({ state: 'busy' });
    expect(w.deps.list).not.toHaveBeenCalled();
  });

  it('a finished pass waits for the repass interval, then starts a new pass from the top', async () => {
    const recent = world({ assets, cursor: { phase: 'done', lastCompletedAt: new Date(NOW.getTime() - DAY / 2), pass: 1 } });
    await expect(runBackfillTick(recent.deps, config(5))).resolves.toMatchObject({ state: 'idle', pass: 1 });
    expect(recent.deps.list).not.toHaveBeenCalled();
    expect(recent.leased).toBe(false);

    const due = world({ assets, cursor: { phase: 'done', lastCompletedAt: new Date(NOW.getTime() - 2 * DAY), pass: 1, counts: { ...emptyBackfillCounts(), listed: 9 } } });
    await expect(runBackfillTick(due.deps, config(2))).resolves.toMatchObject({ state: 'walked', pass: 2, processed: 2 });
    expect(due.processed).toEqual(assets.slice(0, 2));
    expect(due.row?.counts.listed).toBe(2);
  });

  it('stops inside half its lease, mid-page, without finishing the phase', async () => {
    const w = world({ assets });
    let clock = NOW.getTime();
    w.deps.now = () => new Date(clock);
    vi.mocked(w.deps.process).mockImplementation(async (target) => {
      w.processed.push(target.key);
      clock += 20_000; // each object takes 20 s against a 60 s lease
      return { finding: 'clean', scanned: true, removed: false };
    });
    await expect(runBackfillTick(w.deps, config(10))).resolves.toMatchObject({ processed: 2, completed: false });
    expect(w.row).toMatchObject({ phase: 'assets', startAfter: assets[1] });
  });

  it('a truncated listing that returns nothing ends the tick instead of looping', async () => {
    const w = world({ assets });
    vi.mocked(w.deps.list).mockResolvedValue({ objects: [], truncated: true });
    await expect(runBackfillTick(w.deps, config(5))).resolves.toMatchObject({ processed: 0, completed: false });
    expect(w.deps.list).toHaveBeenCalledTimes(1);
  });

  it('keys it does not know are counted and left alone', async () => {
    const w = world({ assets: ['assets/readme.txt', assets[0]] });
    await runBackfillTick(w.deps, config(5));
    expect(w.processed).toEqual([assets[0]]);
    expect(w.row?.lastPassCounts).toMatchObject({ listed: 2, ignored: 1 });
  });

  it('a failing save still releases the lease attempt and surfaces the error', async () => {
    const w = world({ assets });
    vi.mocked(w.deps.save).mockRejectedValueOnce(new Error('db down'));
    await expect(runBackfillTick(w.deps, config(1))).rejects.toThrow('db down');
    expect(w.deps.save).toHaveBeenCalledTimes(2);
  });
});

describe('countItem', () => {
  it('counts a fresh verdict as skipped, a scan as scanned, and removals', () => {
    let counts = emptyBackfillCounts();
    counts = countItem(counts, { finding: 'clean', scanned: false, removed: false });
    counts = countItem(counts, { finding: 'flagged', scanned: true, removed: true });
    counts = countItem(counts, { finding: 'blocked', scanned: false, removed: true });
    counts = countItem(counts, null);
    expect(counts).toMatchObject({ listed: 4, skippedFresh: 1, scanned: 1, clean: 1, flagged: 1, blocked: 1, removed: 2, ignored: 1 });
  });
});

describe('runBackfillDryRun', () => {
  const fresh: StoredVerdict = { verdict: 'clean', outcome: 'clean', scannedAt: new Date(NOW.getTime() - DAY) };
  const expired: StoredVerdict = { verdict: 'clean', outcome: 'clean', scannedAt: new Date(NOW.getTime() - 60 * DAY) };

  function dryWorld(assets: string[], avatars: string[], verdicts: Record<string, StoredVerdict>) {
    const w = world({ assets, avatars });
    const findVerdicts = vi.fn(async (hashes: string[]) => new Map(hashes.flatMap((hash) => (verdicts[hash] ? [[hash, verdicts[hash]] as const] : []))));
    return { list: w.deps.list, findVerdicts, now: () => NOW, process: w.deps.process, claim: w.deps.claim };
  }

  it('counts objects and estimates vendor calls with no scan, no byte read and no cursor', async () => {
    const deps = dryWorld(
      [`assets/${h(1)}`, `assets/cache/${h(1)}/thumbnail.webp`, `assets/${h(2)}`, `assets/${h(3)}`, 'assets/x'],
      ['avatars/u1/avatar.png', 'avatars/u2/avatar.gif'],
      { [h(1)]: fresh, [h(2)]: expired },
    );
    const result = await runBackfillDryRun(deps, { verdictTtlMs: 30 * DAY, maxPages: 10 });
    expect(result).toEqual({
      counts: {
        assets: { objects: 4, hashes: 3, fresh: 1, needScan: 2, bytesToRead: 200, ignored: 1 },
        avatars: { objects: 2, bytesToRead: 200, ignored: 0 },
      },
      estimatedVendorCalls: 4,
      next: null,
    });
    expect(deps.process).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it('stops after maxPages and says where to continue', async () => {
    const deps = dryWorld([`assets/${h(1)}`], ['avatars/u1/avatar.png'], {});
    const result = await runBackfillDryRun(deps, { verdictTtlMs: 30 * DAY, maxPages: 1 });
    expect(result.next).toEqual({ phase: 'avatars', startAfter: '' });
    const rest = await runBackfillDryRun(deps, { verdictTtlMs: 30 * DAY, maxPages: 1, from: { phase: 'avatars', startAfter: null } });
    expect(rest).toMatchObject({ counts: { avatars: { objects: 1 } }, next: null });
  });

  it('a fresh verdict skips the scan exactly as the gate does', () => {
    expect(verdictSkipsScan(fresh, 30 * DAY, NOW)).toBe(true);
    expect(verdictSkipsScan(expired, 30 * DAY, NOW)).toBe(false);
    expect(verdictSkipsScan(undefined, 30 * DAY, NOW)).toBe(false);
    expect(verdictSkipsScan({ ...fresh, verdict: 'error', outcome: 'error' }, 30 * DAY, NOW)).toBe(false);
    expect(verdictSkipsScan({ ...fresh, verdict: 'flagged', outcome: 'hash_match' }, 30 * DAY, NOW)).toBe(false);
    expect(verdictSkipsScan({ ...fresh, verdict: 'flagged', outcome: 'classifier_flag' }, 30 * DAY, NOW)).toBe(true);
  });
});
