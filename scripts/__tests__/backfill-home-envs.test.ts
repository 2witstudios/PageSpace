/**
 * The Home-env backfill runner, against injected fakes — no database.
 *
 * Lazy creation (the first auto-session) already makes every user's Home env
 * correct; this backfill only makes Home VISIBLE in the env list up front. So
 * the properties pinned here are the operator's, the ones whose failure is
 * silent:
 *
 *  - a dry run writes nothing, and says which drives WOULD get a Home env;
 *  - the walk is keyset-paginated and bounded per batch, and visits every
 *    HOME drive exactly once;
 *  - a re-run is a no-op (drives that already have Home are counted, not
 *    re-ensured);
 *  - an org policy refusal and a thrown error are both counted, never fatal,
 *    and only a thrown error fails the exit code;
 *  - an adopted env (a hand-made "Home" flagged by the ensure) is reported as
 *    adopted, not as created.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  exitCodeFor,
  parseArgs,
  runBackfillHomeEnvs,
  type BackfillHomeEnvsDeps,
  type HomeDriveRow,
} from '../backfill-home-envs';

const START = new Date('2026-11-26T12:00:00.000Z');
const EARLIER = new Date('2026-01-01T00:00:00.000Z');

interface FakeWorld {
  drives: HomeDriveRow[];
  /** driveId → Home env createdAt; present = the drive has a Home env. */
  homes: Map<string, Date>;
  /** Unflagged envs named "Home" the ensure would adopt (driveId → createdAt). */
  namedHome: Map<string, Date>;
  /** Drives whose org turns persistent environments off. */
  orgOff: Set<string>;
  /** Drives whose ensure throws. */
  broken: Set<string>;
}

function makeWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    drives: [],
    homes: new Map(),
    namedHome: new Map(),
    orgOff: new Set(),
    broken: new Set(),
    ...over,
  };
}

function makeDeps(world: FakeWorld) {
  const listCalls: Array<{ afterId: string; limit: number }> = [];
  const ensure = vi.fn<BackfillHomeEnvsDeps['ensureHome']>(async ({ homeDriveId }) => {
    if (world.broken.has(homeDriveId)) throw new Error('connection reset');
    if (world.orgOff.has(homeDriveId)) return { ok: false, reason: 'org_policy', message: 'off' };
    const existing = world.homes.get(homeDriveId);
    if (existing) return { ok: true, env: { id: `home-${homeDriveId}`, createdAt: existing } };
    const adopted = world.namedHome.get(homeDriveId);
    const createdAt = adopted ?? START;
    world.homes.set(homeDriveId, createdAt);
    world.namedHome.delete(homeDriveId);
    return { ok: true, env: { id: `home-${homeDriveId}`, createdAt } };
  });
  const deps: BackfillHomeEnvsDeps = {
    listHomeDrives: async ({ afterId, limit }) => {
      listCalls.push({ afterId, limit });
      return world.drives
        .filter((drive) => drive.driveId > afterId)
        .sort((a, b) => a.driveId.localeCompare(b.driveId))
        .slice(0, limit);
    },
    drivesWithHomeEnv: async (driveIds) => new Set(driveIds.filter((id) => world.homes.has(id))),
    ensureHome: ensure,
    now: () => START,
    log: () => {},
  };
  return { deps, ensure, listCalls };
}

const drive = (n: number): HomeDriveRow => ({ driveId: `d${String(n).padStart(2, '0')}`, ownerId: `u${n}` });

describe('runBackfillHomeEnvs', () => {
  it('given HOME drives without a Home env, should ensure one for each and count them created', async () => {
    const world = makeWorld({ drives: [drive(1), drive(2), drive(3)] });
    const { deps, ensure } = makeDeps(world);

    const summary = await runBackfillHomeEnvs({ deps, dryRun: false, batchSize: 10 });

    expect(ensure).toHaveBeenCalledTimes(3);
    expect(ensure).toHaveBeenCalledWith({ homeDriveId: 'd01', ownerId: 'u1' });
    expect(summary).toMatchObject({ scanned: 3, created: 3, alreadyHadHome: 0, adopted: 0, orgPolicyRefused: 0, failed: 0 });
    expect(world.homes.size).toBe(3);
  });

  it('given a dry run, should write nothing and report which drives would get a Home env', async () => {
    const world = makeWorld({ drives: [drive(1), drive(2)], homes: new Map([['d02', EARLIER]]) });
    const { deps, ensure } = makeDeps(world);

    const summary = await runBackfillHomeEnvs({ deps, dryRun: true, batchSize: 10 });

    expect(ensure).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ dryRun: true, scanned: 2, wouldEnsure: 1, alreadyHadHome: 1, created: 0 });
    expect(world.homes.size).toBe(1);
  });

  it('should walk keyset-paginated in bounded batches and visit every drive exactly once', async () => {
    const world = makeWorld({ drives: Array.from({ length: 7 }, (_, i) => drive(i + 1)) });
    const { deps, ensure, listCalls } = makeDeps(world);

    const summary = await runBackfillHomeEnvs({ deps, dryRun: false, batchSize: 3 });

    expect(listCalls.map((call) => call.afterId)).toEqual(['', 'd03', 'd06', 'd07']);
    expect(listCalls.every((call) => call.limit === 3)).toBe(true);
    expect(new Set(ensure.mock.calls.map(([input]) => input.homeDriveId)).size).toBe(7);
    expect(summary.scanned).toBe(7);
  });

  it('given a re-run, should ensure nothing and count every drive as already having Home', async () => {
    const world = makeWorld({ drives: [drive(1), drive(2)] });
    const { deps, ensure } = makeDeps(world);
    await runBackfillHomeEnvs({ deps, dryRun: false, batchSize: 10 });
    ensure.mockClear();

    const again = await runBackfillHomeEnvs({ deps, dryRun: false, batchSize: 10 });

    expect(ensure).not.toHaveBeenCalled();
    expect(again).toMatchObject({ scanned: 2, alreadyHadHome: 2, created: 0 });
  });

  it('given an unflagged env already named "Home", should report it adopted rather than created', async () => {
    const world = makeWorld({ drives: [drive(1)], namedHome: new Map([['d01', EARLIER]]) });
    const { deps } = makeDeps(world);

    const summary = await runBackfillHomeEnvs({ deps, dryRun: false, batchSize: 10 });

    expect(summary).toMatchObject({ created: 0, adopted: 1 });
  });

  it('given an org policy refusal and a throwing drive, should count both, keep going, and fail the exit code only for the throw', async () => {
    const world = makeWorld({
      drives: [drive(1), drive(2), drive(3)],
      orgOff: new Set(['d01']),
      broken: new Set(['d02']),
    });
    const { deps } = makeDeps(world);

    const summary = await runBackfillHomeEnvs({ deps, dryRun: false, batchSize: 10 });

    expect(summary).toMatchObject({ scanned: 3, orgPolicyRefused: 1, failed: 1, created: 1, failedDriveIds: ['d02'] });
    expect(exitCodeFor(summary)).toBe(1);
    expect(exitCodeFor({ ...summary, failed: 0 })).toBe(0);
  });

  it('given a limit, should stop after that many drives', async () => {
    const world = makeWorld({ drives: Array.from({ length: 5 }, (_, i) => drive(i + 1)) });
    const { deps, ensure } = makeDeps(world);

    const summary = await runBackfillHomeEnvs({ deps, dryRun: false, batchSize: 2, limit: 3 });

    expect(summary.scanned).toBe(3);
    expect(ensure).toHaveBeenCalledTimes(3);
  });

  it('should print drive and owner ids only — a thrown error is described by class, never its message', async () => {
    const world = makeWorld({ drives: [drive(1)], broken: new Set(['d01']) });
    const { deps } = makeDeps(world);
    const lines: string[] = [];

    await runBackfillHomeEnvs({ deps: { ...deps, log: (line) => lines.push(line) }, dryRun: false, batchSize: 10 });

    const output = lines.join('\n');
    expect(output).toContain('d01');
    expect(output).not.toContain('connection reset');
  });
});

describe('parseArgs', () => {
  it('should read --dry-run, --batch-size and --limit, in both spellings', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, batchSize: 100, limit: undefined });
    expect(parseArgs(['--dry-run', '--batch-size', '50', '--limit=7'])).toEqual({ dryRun: true, batchSize: 50, limit: 7 });
  });

  it('should refuse an unknown flag or a non-positive number', () => {
    expect(() => parseArgs(['--force'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--batch-size', '0'])).toThrow(/positive integer/);
  });
});
