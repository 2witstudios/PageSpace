/**
 * Tests for the starter-skills backfill runner.
 *
 * This was the one backfill on the branch with neither a test nor an
 * UPGRADE.md entry, while its three siblings have both. The properties under
 * test are the ones whose failure is SILENT — an operator runs the script, sees
 * a plausible summary, and never learns that some users were skipped:
 *
 *  - dry run writes nothing;
 *  - the walk is KEYSET-paginated, because the loop mutates the very predicate
 *    it filters on (`starterSkillsInstalledAt` goes non-null), so an
 *    offset-based walk would skip users as the result set shrank beneath it;
 *  - one failing user does not abort the batch, and is counted;
 *  - `unstampedRemaining` does not quietly absorb this run's failures, which
 *    would let an operator read real failures as "no Home drive yet".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { installStarterSkills } = vi.hoisted(() => ({ installStarterSkills: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({ getMigrationDb: () => dbStub }));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', starterSkillsInstalledAt: 'starterSkillsInstalledAt' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'id', ownerId: 'ownerId', kind: 'kind' },
}));
vi.mock('@pagespace/db/schema/commands', () => ({
  commands: { userId: 'userId', trigger: 'trigger' },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  isNull: (...a: unknown[]) => ({ isNull: a }),
  asc: (...a: unknown[]) => ({ asc: a }),
  gt: (...a: unknown[]) => ({ gt: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
  count: () => ({ count: true }),
}));
vi.mock('@pagespace/lib/commands/starter-skill-installer', () => ({ installStarterSkills }));
vi.mock('@pagespace/lib/commands/starter-skills', () => ({
  STARTER_SKILL_TRIGGERS: ['/plan', '/task'],
}));

interface Row { userId: string; driveId: string }

/** Successive keyset batches, plus the trailing `count()` read. */
let batches: Row[][];
let remainingCount: number;
/** Every `gt(users.id, cursor)` the walk issued — the pagination evidence. */
let cursors: unknown[];
/**
 * Commands the scanned users ALREADY own, as the dry run's per-batch collision
 * probe would find them. Live runs never issue that query — `installStarterSkills`
 * reports its own skips — so this stays empty for them.
 */
let existingCommands: Array<{ userId: string | null; trigger: string }>;

const dbStub = {
  select: vi.fn((projection?: Record<string, unknown>) => {
    // The tail read is `select({ total: count() })` — no join, no cursor.
    if (projection && 'total' in projection) {
      const stub: Record<string, unknown> = {};
      stub.from = () => stub;
      stub.where = () => Promise.resolve([{ total: remainingCount }]);
      return stub;
    }
    // The dry run's collision probe: `select({ userId, trigger })` over
    // `commands`, terminating at `.where()` with no cursor and no limit.
    if (projection && 'trigger' in projection) {
      const stub: Record<string, unknown> = {};
      stub.from = () => stub;
      stub.where = () => Promise.resolve(existingCommands);
      return stub;
    }
    const stub: Record<string, unknown> = {};
    stub.from = () => stub;
    stub.innerJoin = () => stub;
    stub.where = (predicate: { and?: unknown[] }) => {
      const gtClause = predicate?.and?.find((c) => c && typeof c === 'object' && 'gt' in (c as object));
      cursors.push((gtClause as { gt: unknown[] } | undefined)?.gt?.[1]);
      return stub;
    };
    stub.orderBy = () => stub;
    stub.limit = () => Promise.resolve(batches.shift() ?? []);
    return stub;
  }),
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
};

import { runBackfill } from '../backfill-starter-skills';

const ok = (installed: string[] = ['/plan', '/task'], skipped: string[] = []) =>
  ({ alreadyInstalled: false, installed, skipped });

beforeEach(() => {
  vi.clearAllMocks();
  batches = [];
  remainingCount = 0;
  cursors = [];
  existingCommands = [];
  installStarterSkills.mockResolvedValue(ok());
});

describe('runBackfill — dry run', () => {
  it('writes nothing and never opens a transaction', async () => {
    batches = [[{ userId: 'u1', driveId: 'd1' }], []];

    const summary = await runBackfill({ dryRun: true });

    expect(installStarterSkills).not.toHaveBeenCalled();
    expect(dbStub.transaction).not.toHaveBeenCalled();
    expect(summary.scanned).toBe(1);
    // Reports what it WOULD install: one per trigger.
    expect(summary.installed).toBe(2);
  });

  it('does not report unstampedRemaining, which on a dry run would be everyone', async () => {
    batches = [[{ userId: 'u1', driveId: 'd1' }], []];
    remainingCount = 999;

    expect((await runBackfill({ dryRun: true })).unstampedRemaining).toBe(0);
  });

  // The whole point of a dry run is to size the rollout. Counting every trigger
  // as an install ignores the ones the real run will skip because the user
  // already owns that trigger — so the operator is told "6 installs" and gets 5,
  // which reads as a partial failure of the real run rather than as the dry run
  // having been wrong.
  it('predicts the real run: a trigger the user already owns counts as skipped, not installed', async () => {
    batches = [[{ userId: 'u1', driveId: 'd1' }], []];
    existingCommands = [{ userId: 'u1', trigger: '/task' }];

    const summary = await runBackfill({ dryRun: true });

    expect(summary).toMatchObject({ scanned: 1, installed: 1, skippedCollision: 1 });
    expect(dbStub.transaction).not.toHaveBeenCalled();
  });

  // A command row with a null userId is a drive-scoped command, not a personal
  // one. It cannot collide with a personal starter trigger, so folding it into
  // the collision set would under-predict the installs.
  it('ignores a driveless command row when predicting collisions', async () => {
    batches = [[{ userId: 'u1', driveId: 'd1' }], []];
    existingCommands = [{ userId: null, trigger: '/task' }];

    expect(await runBackfill({ dryRun: true })).toMatchObject({ installed: 2, skippedCollision: 0 });
  });

  it('does not probe for collisions on a live run — the installer reports its own skips', async () => {
    batches = [[{ userId: 'u1', driveId: 'd1' }], []];

    await runBackfill();

    expect(dbStub.select.mock.calls.some(([p]) => p && 'trigger' in p)).toBe(false);
  });
});

describe('runBackfill — live', () => {
  it('installs for each user in its own transaction', async () => {
    batches = [[{ userId: 'u1', driveId: 'd1' }, { userId: 'u2', driveId: 'd2' }], []];

    const summary = await runBackfill();

    expect(dbStub.transaction).toHaveBeenCalledTimes(2);
    expect(installStarterSkills).toHaveBeenCalledWith('u1', 'd1', expect.anything());
    expect(installStarterSkills).toHaveBeenCalledWith('u2', 'd2', expect.anything());
    expect(summary).toMatchObject({ scanned: 2, installed: 4, failed: 0 });
  });

  // The loop mutates the predicate it filters on, so the cursor is not a
  // stylistic choice: an OFFSET walk would step over users as the unstamped
  // set shrank beneath it, and the run would report success having silently
  // skipped them.
  it('paginates by KEYSET — each batch resumes after the previous batch\'s last id', async () => {
    batches = [
      [{ userId: 'u1', driveId: 'd1' }, { userId: 'u2', driveId: 'd2' }],
      [{ userId: 'u3', driveId: 'd3' }],
      [],
    ];

    const summary = await runBackfill();

    expect(cursors).toEqual(['', 'u2', 'u3']);
    expect(summary.scanned).toBe(3);
  });

  it('terminates on the first empty batch', async () => {
    batches = [[]];
    await expect(runBackfill()).resolves.toMatchObject({ scanned: 0 });
  });

  it('counts an already-stamped user without double-counting installs', async () => {
    batches = [[{ userId: 'u1', driveId: 'd1' }], []];
    installStarterSkills.mockResolvedValue({ alreadyInstalled: true, installed: [], skipped: [] });

    expect(await runBackfill()).toMatchObject({ alreadyStamped: 1, installed: 0 });
  });

  it('counts a trigger collision as skipped, not installed — an existing command is never overwritten', async () => {
    batches = [[{ userId: 'u1', driveId: 'd1' }], []];
    installStarterSkills.mockResolvedValue(ok(['/plan'], ['/task']));

    expect(await runBackfill()).toMatchObject({ installed: 1, skippedCollision: 1 });
  });

  it('isolates a failing user: the rest of the batch still installs, and the failure is counted', async () => {
    batches = [[{ userId: 'u1', driveId: 'd1' }, { userId: 'u2', driveId: 'd2' }], []];
    installStarterSkills
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok());

    const summary = await runBackfill();

    expect(summary).toMatchObject({ scanned: 2, failed: 1, installed: 2 });
  });

  // A failed transaction rolls its stamp back, so those users are still
  // unstamped. Folding them into `unstampedRemaining` — which the summary
  // describes as "no Home drive yet, or created mid-run" — would let an
  // operator read real failures as benign.
  it('subtracts this run\'s failures from unstampedRemaining rather than absorbing them', async () => {
    batches = [[{ userId: 'u1', driveId: 'd1' }], []];
    installStarterSkills.mockRejectedValue(new Error('boom'));
    remainingCount = 5;

    const summary = await runBackfill();

    expect(summary.failed).toBe(1);
    expect(summary.unstampedRemaining).toBe(4);
  });

  it('never reports a negative unstampedRemaining', async () => {
    batches = [[{ userId: 'u1', driveId: 'd1' }], []];
    installStarterSkills.mockRejectedValue(new Error('boom'));
    remainingCount = 0;

    expect((await runBackfill()).unstampedRemaining).toBe(0);
  });
});
