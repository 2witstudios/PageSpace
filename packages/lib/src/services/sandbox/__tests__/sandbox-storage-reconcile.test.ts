import { describe, it, expect, vi } from 'vitest';
import { assert } from './riteway';
import {
  reconcileSandboxStorage,
  computeElapsedGbMonths,
  pickBillableGB,
  bytesToGB,
  MS_PER_STORAGE_MONTH,
  STALE_MEASUREMENT_MS,
  MAX_BILLABLE_SPAN_MS,
  type ReconcileSandboxStorageDeps,
  type AgentSessionStorageRow,
  type DriveEnvStorageRow,
  type PublishedAppStorageRow,
} from '../sandbox-storage-reconcile';

describe('bytesToGB', () => {
  it('converts bytes to DECIMAL GB (÷1e9, matching the provider allocation + rate)', () => {
    assert({ given: '1e9 bytes', should: 'be 1 GB', actual: bytesToGB(1_000_000_000), expected: 1 });
    expect(bytesToGB(200_000_000)).toBeCloseTo(0.2, 10);
  });

  it('floors invalid / non-positive input at 0', () => {
    expect(bytesToGB(0)).toBe(0);
    expect(bytesToGB(-5)).toBe(0);
    expect(bytesToGB(Number.NaN)).toBe(0);
  });
});

describe('computeElapsedGbMonths', () => {
  it('prices a full storage-month at the full measuredGB', () => {
    assert({
      given: 'a full storage-month of a 2GB measured footprint',
      should: 'accrue 2 GB-months',
      actual: computeElapsedGbMonths({ measuredGB: 2, elapsedMs: MS_PER_STORAGE_MONTH }),
      expected: 2,
    });
  });

  it('prorates a half-month to half the GB-months', () => {
    expect(computeElapsedGbMonths({ measuredGB: 4, elapsedMs: MS_PER_STORAGE_MONTH / 2 })).toBeCloseTo(2, 10);
  });

  it('returns 0 for zero or negative elapsed time', () => {
    assert({
      given: 'zero elapsed time',
      should: 'accrue nothing',
      actual: computeElapsedGbMonths({ measuredGB: 5, elapsedMs: 0 }),
      expected: 0,
    });
    expect(computeElapsedGbMonths({ measuredGB: 5, elapsedMs: -1000 })).toBe(0);
  });

  it('returns 0 for a non-positive measuredGB (never-measured / zero-usage floor)', () => {
    assert({
      given: 'a zero measured footprint',
      should: 'accrue nothing regardless of elapsed time',
      actual: computeElapsedGbMonths({ measuredGB: 0, elapsedMs: MS_PER_STORAGE_MONTH }),
      expected: 0,
    });
  });
});

describe('pickBillableGB', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  it('bills a fresh measurement at its measured GB and reports not-stale', () => {
    assert({
      given: 'a measurement taken one minute ago',
      should: 'bill the measured GB and flag it fresh',
      actual: pickBillableGB({
        lastMeasuredGB: 0.2,
        lastMeasuredAt: new Date(now.getTime() - 60_000),
        awake: false,
        now,
      }),
      expected: { gb: 0.2, stale: false },
    });
  });

  it('reuses a stale measurement (older than the window) for billing but flags it stale', () => {
    assert({
      given: 'a paused sandbox whose last measurement is older than the stale window',
      should: 'still bill the last measured GB (never wake to re-measure) but flag stale',
      actual: pickBillableGB({
        lastMeasuredGB: 0.5,
        lastMeasuredAt: new Date(now.getTime() - STALE_MEASUREMENT_MS - 1),
        awake: false,
        now,
      }),
      expected: { gb: 0.5, stale: true },
    });
  });

  it('does not flag an awake sandbox stale even with an old timestamp (refresh is imminent)', () => {
    assert({
      given: 'an awake sandbox with an old measurement timestamp',
      should: 'bill the measured GB and NOT flag stale (opportunistic refresh will land)',
      actual: pickBillableGB({
        lastMeasuredGB: 0.5,
        lastMeasuredAt: new Date(now.getTime() - STALE_MEASUREMENT_MS - 1),
        awake: true,
        now,
      }),
      expected: { gb: 0.5, stale: false },
    });
  });

  it('falls back to a 0 floor (never the provisioned cap) when never measured', () => {
    assert({
      given: 'a sandbox that has never been measured',
      should: 'bill 0 (conservative floor), never the provisioned cap',
      actual: pickBillableGB({ lastMeasuredGB: null, lastMeasuredAt: null, awake: false, now }),
      expected: { gb: 0, stale: true },
    });
  });

  it('bills 0 for a sandbox measured at zero usage', () => {
    assert({
      given: 'a sandbox measured at exactly zero bytes',
      should: 'bill 0',
      actual: pickBillableGB({
        lastMeasuredGB: 0,
        lastMeasuredAt: new Date(now.getTime() - 60_000),
        awake: false,
        now,
      }),
      expected: { gb: 0, stale: false },
    });
  });
});

type ChargeCall = Parameters<ReconcileSandboxStorageDeps['chargeStorage']>[0];

function makeDeps(over: Partial<ReconcileSandboxStorageDeps> = {}): {
  deps: ReconcileSandboxStorageDeps;
  chargeCalls: ChargeCall[];
  agentSessionAdvanceCalls: Array<{ workspaceId: string; billedThrough: Date }>;
  driveEnvAdvanceCalls: Array<{ envId: string; billedThrough: Date }>;
  publishedAppAdvanceCalls: Array<{ publishedAppId: string; billedThrough: Date }>;
} {
  const chargeCalls: ChargeCall[] = [];
  const agentSessionAdvanceCalls: Array<{ workspaceId: string; billedThrough: Date }> = [];
  const driveEnvAdvanceCalls: Array<{ envId: string; billedThrough: Date }> = [];
  const publishedAppAdvanceCalls: Array<{ publishedAppId: string; billedThrough: Date }> = [];
  const deps: ReconcileSandboxStorageDeps = {
    listAgentSessionSprites: async () => [],
    listDriveEnvSprites: async () => [],
    listPublishedAppRootfs: async () => [],
    lookupDriveOwnerId: async () => 'owner-1',
    chargeStorage: async (input) => {
      chargeCalls.push(input);
    },
    // `'advanced'` = the row was written with the value we asked for. The real
    // writers are monotonic and answer `'superseded'` when a provision already
    // reset the watermark past this tick, or `'row_gone'` when the row was
    // deleted mid-tick — three outcomes, not a boolean.
    advanceAgentSessionWatermark: async (input) => {
      agentSessionAdvanceCalls.push(input);
      return 'advanced';
    },
    advanceDriveEnvWatermark: async (input) => {
      driveEnvAdvanceCalls.push(input);
      return 'advanced';
    },
    advancePublishedAppWatermark: async (input) => {
      publishedAppAdvanceCalls.push(input);
      return 'advanced';
    },
    now: () => new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  };
  return { deps, chargeCalls, agentSessionAdvanceCalls, driveEnvAdvanceCalls, publishedAppAdvanceCalls };
}

/**
 * A measured agent-session Sprite: 1GB written, measured just before `now`, in
 * `drive-1`, with its watermark exactly one MAX_BILLABLE_SPAN old — the largest
 * window a single tick may bill, so these tests exercise the ordinary path
 * rather than the clamp (which has its own tests).
 */
function agentSession(over: Partial<AgentSessionStorageRow> = {}): AgentSessionStorageRow {
  return {
    workspaceId: 'session-1',
    driveId: 'drive-1',
    ownerId: 'session-owner-1',
    storageLastBilledAt: new Date(new Date('2026-07-01T00:00:00.000Z').getTime() - MAX_BILLABLE_SPAN_MS),
    measuredBytes: 1_000_000_000, // 1 GB
    measuredAt: new Date('2026-06-30T23:00:00.000Z'),
    lastActiveAt: new Date('2026-06-30T23:59:00.000Z'),
    ...over,
  };
}

/** A measured drive-env Sprite, same shape and same one-span-old watermark as `agentSession`. */
function driveEnv(over: Partial<DriveEnvStorageRow> = {}): DriveEnvStorageRow {
  return {
    envId: 'env-1',
    driveId: 'drive-1',
    storageLastBilledAt: new Date(new Date('2026-07-01T00:00:00.000Z').getTime() - MAX_BILLABLE_SPAN_MS),
    measuredBytes: 1_000_000_000, // 1 GB
    measuredAt: new Date('2026-06-30T23:00:00.000Z'),
    lastActiveAt: new Date('2026-06-30T23:59:00.000Z'),
    ...over,
  };
}

/**
 * A published app's ROOTFS row, same one-span-old watermark as the two Sprite
 * sources. Its measurement is a BUILD-TIME registry size rather than a live `du`,
 * so it carries no `lastActiveAt` of its own.
 */
function publishedAppRootfs(over: Partial<PublishedAppStorageRow> = {}): PublishedAppStorageRow {
  return {
    publishedAppId: 'app-1',
    driveId: 'drive-1',
    storageLastBilledAt: new Date(new Date('2026-07-01T00:00:00.000Z').getTime() - MAX_BILLABLE_SPAN_MS),
    measuredBytes: 1_000_000_000, // 1 GB
    measuredAt: new Date('2026-06-30T23:00:00.000Z'),
    ...over,
  };
}

describe('reconcileSandboxStorage', () => {
  it('bills an agent-session Sprite to its drive for its MEASURED storage window and advances its watermark', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'session-1', driveId: 'drive-1' })],
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an agent-session Sprite with a backing drive and a measured 1GB footprint',
      should: 'charge its drive — the key the usage breakdown groups on',
      actual: { charged: result.charged, driveId: chargeCalls[0]?.driveId, subjectKind: chargeCalls[0]?.subjectKind },
      expected: { charged: 1, driveId: 'drive-1', subjectKind: 'session' },
    });
    // One full billable span of 1GB — a day's share of a 30-day storage month.
    expect(chargeCalls[0].gbMonths).toBeCloseTo(MAX_BILLABLE_SPAN_MS / MS_PER_STORAGE_MONTH, 8);
    expect(chargeCalls[0].costDollars).toBeGreaterThan(0);
    expect(agentSessionAdvanceCalls).toEqual([{ workspaceId: 'session-1', billedThrough: new Date('2026-07-01T00:00:00.000Z') }]);
  });

  it('resolves the payer via lookupDriveOwnerId when driveId is set', async () => {
    const lookup = vi.fn(async (driveId: string) => `owner-of-${driveId}`);
    const { deps, chargeCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ driveId: 'drive-9', ownerId: 'session-owner-9' })],
      lookupDriveOwnerId: lookup,
    });

    await reconcileSandboxStorage(deps);

    expect(lookup).toHaveBeenCalledWith('drive-9');
    expect(chargeCalls[0]).toMatchObject({ payerId: 'owner-of-drive-9', driveId: 'drive-9' });
  });

  it('bills a global-assistant session (null driveId) straight to its ownerId, with no drive lookup and no driveId on the charge', async () => {
    const lookup = vi.fn(async () => 'should-not-be-called');
    const { deps, chargeCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ driveId: null, ownerId: 'global-owner-1' })],
      lookupDriveOwnerId: lookup,
    });

    const result = await reconcileSandboxStorage(deps);

    expect(lookup).not.toHaveBeenCalled();
    assert({
      given: 'a global-assistant agent-session Sprite (no backing drive)',
      should: 'charge the session ownerId directly, with driveId omitted from the charge',
      actual: { charged: result.charged, payerId: chargeCalls[0]?.payerId, driveId: chargeCalls[0]?.driveId },
      expected: { charged: 1, payerId: 'global-owner-1', driveId: undefined },
    });
  });

  it('bills the never-measured 0 floor for a just-provisioned session and still advances its own watermark', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ measuredBytes: null, measuredAt: null })],
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an agent-session whose Sprite has never been measured',
      should: 'charge nothing (the 0 floor, never a provisioned cap) but still advance its watermark',
      actual: { charged: result.charged, charges: chargeCalls.length, advanced: agentSessionAdvanceCalls.length },
      expected: { charged: 0, charges: 0, advanced: 1 },
    });
  });

  it('skips (and does not advance the watermark for) a page-backed session whose page owner cannot be resolved', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ driveId: 'orphaned-page' })],
      lookupDriveOwnerId: async () => null,
    });

    const result = await reconcileSandboxStorage(deps);

    expect(result).toMatchObject({ processed: 1, charged: 0, skipped: 1 });
    expect(chargeCalls).toEqual([]);
    expect(agentSessionAdvanceCalls).toEqual([]);
  });

  it('given chargeStorage succeeds but the FOLLOWING watermark advance throws, counts the money as charged (never under-reported) and flags the row distinguishably', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'boom' }), agentSession({ workspaceId: 'fine' })],
      advanceAgentSessionWatermark: async (input) => {
        if (input.workspaceId === 'boom') throw new Error('watermark write failed');
        agentSessionAdvanceCalls.push(input);
        return 'advanced';
      },
    });

    const result = await reconcileSandboxStorage(deps);

    // Both rows' money actually moved (chargeStorage succeeded for both) — so
    // BOTH count toward `charged`/`totalCostDollars`, regardless of the
    // watermark outcome. 'boom's failed advance is its own distinct signal
    // (`chargedButUnadvanced`), not folded into `failed` (which would imply
    // nothing was billed).
    expect(result).toMatchObject({ processed: 2, charged: 2, failed: 0, chargedButUnadvanced: 1 });
    expect(result.totalCostDollars).toBeGreaterThan(0);
    expect(chargeCalls).toHaveLength(2);
    // Only 'fine' successfully advanced — 'boom' will be billed again next run.
    expect(agentSessionAdvanceCalls.map((c) => c.workspaceId)).toEqual(['fine']);
  });

  it('given chargeStorage ITSELF throws, bills nothing for that row (no double-count) and never attempts its watermark advance', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'boom' }), agentSession({ workspaceId: 'fine' })],
      chargeStorage: async (input) => {
        if (input.subjectId === 'boom') throw new Error('credit ledger unreachable');
        chargeCalls.push(input);
      },
    });

    const result = await reconcileSandboxStorage(deps);

    expect(result).toMatchObject({ processed: 2, charged: 1, failed: 1, chargedButUnadvanced: 0 });
    expect(chargeCalls).toHaveLength(1);
    expect(chargeCalls[0].subjectId).toBe('fine');
    expect(agentSessionAdvanceCalls.map((c) => c.workspaceId)).toEqual(['fine']);
  });

  it('given a stale measurement on an idle session, still bills the last measured value and flags it stale', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    const { deps } = makeDeps({
      listAgentSessionSprites: async () => [
        agentSession({
          measuredAt: new Date(now.getTime() - STALE_MEASUREMENT_MS - 1),
          lastActiveAt: new Date(now.getTime() - 60 * 60 * 1000),
        }),
      ],
      now: () => now,
    });

    const result = await reconcileSandboxStorage(deps);

    expect(result).toMatchObject({ charged: 1, staleMeasurements: 1 });
  });

  // -------------------------------------------------------------------------
  // Drive ENVIRONMENTS — the second row source on the SAME meter. An env is the
  // billed persistence unit; its payer is the DRIVE OWNER, with no fallback.
  // -------------------------------------------------------------------------

  it('bills a drive env to its DRIVE OWNER for its measured storage window and advances the ENV watermark', async () => {
    const lookup = vi.fn(async (driveId: string) => `owner-of-${driveId}`);
    const { deps, chargeCalls, driveEnvAdvanceCalls, agentSessionAdvanceCalls } = makeDeps({
      listDriveEnvSprites: async () => [driveEnv({ envId: 'env-7', driveId: 'drive-7' })],
      lookupDriveOwnerId: lookup,
    });

    const result = await reconcileSandboxStorage(deps);

    expect(lookup).toHaveBeenCalledWith('drive-7');
    assert({
      given: 'a live drive env with a measured 1GB footprint',
      should: "charge the DRIVE OWNER, attributed to the env's drive and named as an env subject",
      actual: {
        charged: result.charged,
        payerId: chargeCalls[0]?.payerId,
        driveId: chargeCalls[0]?.driveId,
        subjectKind: chargeCalls[0]?.subjectKind,
        subjectId: chargeCalls[0]?.subjectId,
      },
      expected: {
        charged: 1,
        payerId: 'owner-of-drive-7',
        driveId: 'drive-7',
        subjectKind: 'env',
        subjectId: 'env-7',
      },
    });
    expect(chargeCalls[0].gbMonths).toBeCloseTo(MAX_BILLABLE_SPAN_MS / MS_PER_STORAGE_MONTH, 8);
    // The env's OWN watermark advanced — and the SESSION watermark writer was
    // never touched, which is what keeps the two row sources' billing windows
    // independent.
    expect(driveEnvAdvanceCalls).toEqual([{ envId: 'env-7', billedThrough: new Date('2026-07-01T00:00:00.000Z') }]);
    expect(agentSessionAdvanceCalls).toEqual([]);
  });

  it('SKIPS an env whose drive owner cannot be resolved — no charge, no watermark advance, no fallback payer', async () => {
    const { deps, chargeCalls, driveEnvAdvanceCalls } = makeDeps({
      listDriveEnvSprites: async () => [driveEnv({ envId: 'env-orphan', driveId: 'drive-mid-delete' })],
      lookupDriveOwnerId: async () => null,
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an env whose drive is mid-delete (owner unresolvable)',
      should: 'skip the cycle entirely rather than bill anybody else — the accrual survives for the next run',
      actual: { result: { processed: result.processed, charged: result.charged, skipped: result.skipped }, charges: chargeCalls.length, advanced: driveEnvAdvanceCalls.length },
      expected: { result: { processed: 1, charged: 0, skipped: 1 }, charges: 0, advanced: 0 },
    });
  });

  it('bills the never-measured 0 floor for a just-provisioned env and still advances its own watermark', async () => {
    const { deps, chargeCalls, driveEnvAdvanceCalls } = makeDeps({
      listDriveEnvSprites: async () => [driveEnv({ measuredBytes: null, measuredAt: null })],
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an env whose Sprite has never been measured',
      should: 'charge nothing (the 0 floor, never a provisioned cap) but still advance its watermark',
      actual: { charged: result.charged, charges: chargeCalls.length, advanced: driveEnvAdvanceCalls.length },
      expected: { charged: 0, charges: 0, advanced: 1 },
    });
  });

  // -------------------------------------------------------------------------
  // Published-app ROOTFS — the THIRD row source on the same meter. The only cost
  // a stopped published app still incurs, and for a fleet of mostly-idle apps the
  // entire per-app floor.
  // -------------------------------------------------------------------------

  it("bills a published app's rootfs to its DRIVE OWNER and advances the APP's own watermark", async () => {
    const lookup = vi.fn(async (driveId: string) => `owner-of-${driveId}`);
    const { deps, chargeCalls, publishedAppAdvanceCalls, driveEnvAdvanceCalls, agentSessionAdvanceCalls } = makeDeps({
      listPublishedAppRootfs: async () => [publishedAppRootfs({ publishedAppId: 'app-9', driveId: 'drive-9' })],
      lookupDriveOwnerId: lookup,
    });

    const result = await reconcileSandboxStorage(deps);

    expect(lookup).toHaveBeenCalledWith('drive-9');
    assert({
      given: 'a published app holding a measured 1GB image',
      should: "charge the DRIVE OWNER, attributed to the app's drive and named as a hosting subject",
      actual: {
        charged: result.charged,
        payerId: chargeCalls[0]?.payerId,
        driveId: chargeCalls[0]?.driveId,
        subjectKind: chargeCalls[0]?.subjectKind,
        subjectId: chargeCalls[0]?.subjectId,
      },
      expected: {
        charged: 1,
        payerId: 'owner-of-drive-9',
        driveId: 'drive-9',
        subjectKind: 'hosting',
        subjectId: 'app-9',
      },
    });
    expect(chargeCalls[0].gbMonths).toBeCloseTo(MAX_BILLABLE_SPAN_MS / MS_PER_STORAGE_MONTH, 8);
    // Its OWN watermark moved, and neither of the other two writers was touched.
    expect(publishedAppAdvanceCalls).toEqual([
      { publishedAppId: 'app-9', billedThrough: new Date('2026-07-01T00:00:00.000Z') },
    ]);
    expect(driveEnvAdvanceCalls).toEqual([]);
    expect(agentSessionAdvanceCalls).toEqual([]);
  });

  it('SKIPS a published app whose drive owner cannot be resolved — never a fallback to its `ownerId` column', async () => {
    // `published_apps.ownerId` is a denormalized cascade handle, not an answer to
    // "who pays". Billing it would be a money movement that cannot be taken back.
    const { deps, chargeCalls, publishedAppAdvanceCalls } = makeDeps({
      listPublishedAppRootfs: async () => [publishedAppRootfs({ driveId: 'drive-mid-delete' })],
      lookupDriveOwnerId: async () => null,
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'a published app whose drive is mid-delete',
      should: 'skip the cycle rather than bill anybody else',
      actual: { charged: result.charged, skipped: result.skipped, charges: chargeCalls.length, advanced: publishedAppAdvanceCalls.length },
      expected: { charged: 0, skipped: 1, charges: 0, advanced: 0 },
    });
  });

  it('bills the never-measured 0 floor for an app with no build yet, and still advances its watermark', async () => {
    // `imageSizeMeasuredAt` is NOT NULL exactly when `imageSizeBytes` is, so this
    // branch means precisely "no build has landed" — an app holding no rootfs.
    const { deps, chargeCalls, publishedAppAdvanceCalls } = makeDeps({
      listPublishedAppRootfs: async () => [publishedAppRootfs({ measuredBytes: null, measuredAt: null })],
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'a published app whose image has never been measured',
      should: 'charge nothing but still advance its watermark',
      actual: { charged: result.charged, charges: chargeCalls.length, advanced: publishedAppAdvanceCalls.length },
      expected: { charged: 0, charges: 0, advanced: 1 },
    });
  });

  it('reports an unreadable published-app source as a failed SOURCE without stopping the other two', async () => {
    // A dark row source must never stop the live one's money.
    const { deps, chargeCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession()],
      listPublishedAppRootfs: async () => {
        throw new Error('published_apps unreadable');
      },
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'the published-app row source throwing mid-tick',
      should: 'name it in failedSources and still bill the session',
      actual: { failedSources: result.failedSources, charged: result.charged, charges: chargeCalls.length },
      expected: { failedSources: ['hosting'], charged: 1, charges: 1 },
    });
  });

  it('meters ALL THREE row sources in one run, each to its own payer and its own watermark', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls, driveEnvAdvanceCalls, publishedAppAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'session-a', driveId: null, ownerId: 'global-owner' })],
      listDriveEnvSprites: async () => [driveEnv({ envId: 'env-b', driveId: 'drive-b' })],
      listPublishedAppRootfs: async () => [publishedAppRootfs({ publishedAppId: 'app-c', driveId: 'drive-c' })],
      lookupDriveOwnerId: async (driveId) => `owner-of-${driveId}`,
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'one session, one env and one published app in the same tick',
      should: 'charge each subject once, under its own kind',
      actual: {
        processed: result.processed,
        charged: result.charged,
        kinds: chargeCalls.map((c) => c.subjectKind).sort(),
      },
      expected: { processed: 3, charged: 3, kinds: ['env', 'hosting', 'session'] },
    });
    expect(agentSessionAdvanceCalls).toHaveLength(1);
    expect(driveEnvAdvanceCalls).toHaveLength(1);
    expect(publishedAppAdvanceCalls).toHaveLength(1);
  });

  it('meters BOTH row sources in one run, attributing each to its own payer and its own watermark', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls, driveEnvAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'session-a', driveId: null, ownerId: 'global-owner' })],
      listDriveEnvSprites: async () => [driveEnv({ envId: 'env-b', driveId: 'drive-b' })],
      lookupDriveOwnerId: async (driveId) => `owner-of-${driveId}`,
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'one global-assistant session and one drive env in the same run',
      should: 'process both on the one meter, each billed to its own payer',
      actual: {
        processed: result.processed,
        charged: result.charged,
        payers: chargeCalls.map((call) => [call.subjectKind, call.subjectId, call.payerId]),
      },
      expected: {
        processed: 2,
        charged: 2,
        payers: [
          ['session', 'session-a', 'global-owner'],
          ['env', 'env-b', 'owner-of-drive-b'],
        ],
      },
    });
    expect(agentSessionAdvanceCalls.map((call) => call.workspaceId)).toEqual(['session-a']);
    expect(driveEnvAdvanceCalls.map((call) => call.envId)).toEqual(['env-b']);
  });

  it('given an env charge that throws, isolates it to that env and still bills the session source', async () => {
    const { deps, chargeCalls, driveEnvAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'session-fine' })],
      listDriveEnvSprites: async () => [driveEnv({ envId: 'env-boom' })],
      chargeStorage: async (input) => {
        if (input.subjectId === 'env-boom') throw new Error('credit ledger unreachable');
        chargeCalls.push(input);
      },
    });

    const result = await reconcileSandboxStorage(deps);

    expect(result).toMatchObject({ processed: 2, charged: 1, failed: 1 });
    expect(chargeCalls.map((call) => call.subjectId)).toEqual(['session-fine']);
    expect(driveEnvAdvanceCalls).toEqual([]);
  });

  it('given an ENV watermark write that throws after a successful charge, counts it as chargedButUnadvanced and leaves its neighbours alone', async () => {
    const { deps, chargeCalls, driveEnvAdvanceCalls } = makeDeps({
      listDriveEnvSprites: async () => [driveEnv({ envId: 'env-wm' }), driveEnv({ envId: 'env-fine' })],
      advanceDriveEnvWatermark: async (input) => {
        if (input.envId === 'env-wm') throw new Error('watermark write failed');
        driveEnvAdvanceCalls.push(input);
        return 'advanced';
      },
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: "an env whose charge committed but whose own watermark write then failed",
      should:
        'count the money as charged (it moved) and flag the row distinguishably from a charge failure — its window WILL be re-billed next run',
      actual: {
        charged: result.charged,
        failed: result.failed,
        chargedButUnadvanced: result.chargedButUnadvanced,
        billed: chargeCalls.map((call) => call.subjectId),
      },
      expected: {
        charged: 2,
        failed: 0,
        chargedButUnadvanced: 1,
        billed: ['env-wm', 'env-fine'],
      },
    });
    // The env-specific writer is per-row like the session one: one env's failed
    // advance must not strand its neighbour's.
    expect(driveEnvAdvanceCalls.map((call) => call.envId)).toEqual(['env-fine']);
  });

  it('given a stale measurement on an idle env, still bills the last measured value and flags it stale', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    const { deps } = makeDeps({
      listDriveEnvSprites: async () => [
        driveEnv({
          measuredAt: new Date(now.getTime() - STALE_MEASUREMENT_MS - 1),
          lastActiveAt: new Date(now.getTime() - 60 * 60 * 1000),
        }),
      ],
      now: () => now,
    });

    const result = await reconcileSandboxStorage(deps);

    expect(result).toMatchObject({ charged: 1, staleMeasurements: 1 });
  });

  // -------------------------------------------------------------------------
  // Health signals and source isolation — the two ways this meter can go quiet
  // without anybody noticing.
  // -------------------------------------------------------------------------

  it('NEVER THROWS, whatever any dep does — the property the advisory-lock wrapper depends on', async () => {
    // Every dep that can fail, failing at once. `reconcileSandboxStorageSerialized`
    // distinguishes "the lock connection broke" from "the work failed" by relying
    // on this function not throwing, so a leak here would be misread as a lock
    // error and swallowed by the cron's catch.
    const { deps } = makeDeps({
      listAgentSessionSprites: async () => {
        throw new Error('sessions down');
      },
      listDriveEnvSprites: async () => {
        throw new Error('envs down');
      },
      lookupDriveOwnerId: async () => {
        throw new Error('lookup down');
      },
      chargeStorage: async () => {
        throw new Error('ledger down');
      },
      advanceAgentSessionWatermark: async () => {
        throw new Error('write down');
      },
      advanceDriveEnvWatermark: async () => {
        throw new Error('write down');
      },
    });

    await expect(reconcileSandboxStorage(deps)).resolves.toMatchObject({ processed: 0, charged: 0 });
  });

  it('NEVER THROWS when a row-level dep fails either — the failure is reported, not raised', async () => {
    const { deps } = makeDeps({
      listAgentSessionSprites: async () => [agentSession()],
      listDriveEnvSprites: async () => [driveEnv()],
      lookupDriveOwnerId: async () => {
        throw new Error('lookup down');
      },
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'a payer lookup that throws for every row',
      should: 'report both rows as failed rather than raising out of the reconcile',
      actual: { processed: result.processed, failed: result.failed, charged: result.charged },
      expected: { processed: 2, failed: 2, charged: 0 },
    });
  });

  it('CAPS a frozen window rather than billing it retroactively, and counts the clamp', async () => {
    // The skipped-row shape: a payer that could not be resolved for weeks keeps
    // this row's watermark frozen while its footprint grows. Uncapped, the tick
    // where the lookup finally resolves prices the whole frozen span at TODAY's
    // footprint — the retroactive over-bill the `$0` branch refuses, reached by a
    // different door.
    const now = new Date('2026-07-01T00:00:00.000Z');
    const { deps, chargeCalls } = makeDeps({
      listDriveEnvSprites: async () => [
        driveEnv({ storageLastBilledAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000) }),
      ],
      now: () => now,
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'a row whose watermark has been frozen for forty days',
      should: 'bill one capped span and report the clamp — the excess is forgiven, never billed',
      actual: {
        charged: result.charged,
        spanClamped: result.spanClamped,
        gbMonths: Number(chargeCalls[0]?.gbMonths.toFixed(8)),
      },
      expected: {
        charged: 1,
        spanClamped: 1,
        gbMonths: Number((MAX_BILLABLE_SPAN_MS / MS_PER_STORAGE_MONTH).toFixed(8)),
      },
    });
  });

  it('does NOT clamp a SESSION — forgiving revenue on the live meter is not this PR\'s call', async () => {
    // The cap is a revenue-forgiveness policy, not a bug fix: a reconcile outage
    // longer than the cap bills less than the storage actually held. Sessions are
    // a live billing feature, so that trade wants its own sign-off rather than
    // arriving on a dark feature's coattails. Envs bill nothing today, so capping
    // them changes no invoice.
    const now = new Date('2026-07-01T00:00:00.000Z');
    const fortyDays = 40 * 24 * 60 * 60 * 1000;
    const { deps, chargeCalls } = makeDeps({
      listAgentSessionSprites: async () => [
        agentSession({ storageLastBilledAt: new Date(now.getTime() - fortyDays) }),
      ],
      now: () => now,
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'a SESSION whose watermark has been frozen for forty days',
      should: 'bill the whole span exactly as it does on master — unclamped, uncounted',
      actual: {
        spanClamped: result.spanClamped,
        gbMonths: Number(chargeCalls[0]?.gbMonths.toFixed(6)),
      },
      expected: {
        spanClamped: 0,
        gbMonths: Number((fortyDays / MS_PER_STORAGE_MONTH).toFixed(6)),
      },
    });
  });

  it('does NOT count a clamp on a row it then SKIPS — that row keeps its whole window', async () => {
    // `skipped` already reports the row. Counting the clamp here too would make
    // `spanClamped` permanently non-zero for one unresolvable drive and blunt it
    // as the alarm its doc says it is.
    const now = new Date('2026-07-01T00:00:00.000Z');
    const { deps } = makeDeps({
      listDriveEnvSprites: async () => [
        driveEnv({ storageLastBilledAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000) }),
      ],
      lookupDriveOwnerId: async () => null,
      now: () => now,
    });

    const result = await reconcileSandboxStorage(deps);

    expect({ skipped: result.skipped, spanClamped: result.spanClamped }).toEqual({
      skipped: 1,
      spanClamped: 0,
    });
  });

  it('does NOT count a clamp when the CHARGE throws — nothing was forgiven', async () => {
    // The window is only actually closed once the charge landed AND the
    // watermark moved. Counting the clamp before that would make `spanClamped`
    // permanently non-zero for one persistently failing row, blunting the alarm.
    const now = new Date('2026-07-01T00:00:00.000Z');
    const { deps } = makeDeps({
      listDriveEnvSprites: async () => [
        driveEnv({ storageLastBilledAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000) }),
      ],
      chargeStorage: async () => {
        throw new Error('ledger down');
      },
      now: () => now,
    });

    const result = await reconcileSandboxStorage(deps);

    expect({ failed: result.failed, spanClamped: result.spanClamped }).toEqual({ failed: 1, spanClamped: 0 });
  });

  it('does NOT count a clamp when the WATERMARK write throws — the window stays open', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    const { deps } = makeDeps({
      listDriveEnvSprites: async () => [
        driveEnv({ storageLastBilledAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000) }),
      ],
      advanceDriveEnvWatermark: async () => {
        throw new Error('watermark write failed');
      },
      now: () => now,
    });

    const result = await reconcileSandboxStorage(deps);

    expect({
      charged: result.charged,
      chargedButUnadvanced: result.chargedButUnadvanced,
      spanClamped: result.spanClamped,
    }).toEqual({ charged: 1, chargedButUnadvanced: 1, spanClamped: 0 });
  });

  it('does NOT count a clamp on a row that priced to $0 — nothing was forgiven', async () => {
    // The common shape today: envs meter ~$0, so a long-frozen env that gets
    // rebuilt arrives never-measured with a huge raw span. Capped or uncapped it
    // owes nothing, so reporting a forgiven window would send an operator
    // investigating revenue loss after money that never existed.
    const now = new Date('2026-07-01T00:00:00.000Z');
    const { deps, driveEnvAdvanceCalls } = makeDeps({
      listDriveEnvSprites: async () => [
        driveEnv({
          storageLastBilledAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000),
          measuredBytes: null,
          measuredAt: null,
        }),
      ],
      now: () => now,
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'a never-measured env whose window has been frozen for forty days',
      should: 'advance its watermark but report NO clamp — a $0 row loses nothing by being capped',
      actual: { charged: result.charged, spanClamped: result.spanClamped, advanced: driveEnvAdvanceCalls.length },
      expected: { charged: 0, spanClamped: 0, advanced: 1 },
    });
  });

  it('does not clamp a window exactly AT the cap — the boundary bills in full', async () => {
    const { deps, chargeCalls } = makeDeps({ listDriveEnvSprites: async () => [driveEnv()] });

    const result = await reconcileSandboxStorage(deps);

    expect({ spanClamped: result.spanClamped, gbMonths: chargeCalls[0]?.gbMonths }).toEqual({
      spanClamped: 0,
      gbMonths: MAX_BILLABLE_SPAN_MS / MS_PER_STORAGE_MONTH,
    });
  });

  it('counts a live row with NO measurement as neverMeasured, distinctly from a stale one', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    const { deps } = makeDeps({
      listDriveEnvSprites: async () => [
        driveEnv({ envId: 'env-never', measuredBytes: null, measuredAt: null }),
        driveEnv({
          envId: 'env-stale',
          measuredAt: new Date(now.getTime() - STALE_MEASUREMENT_MS - 1),
          lastActiveAt: new Date(now.getTime() - 60 * 60 * 1000),
        }),
      ],
      now: () => now,
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'one env that has never been measured and one billing on an ageing measurement',
      should: 'count them SEPARATELY — a row with no reading cannot have an ageing one, and it is the worse signal',
      actual: { neverMeasured: result.neverMeasured, staleMeasurements: result.staleMeasurements },
      expected: { neverMeasured: 1, staleMeasurements: 1 },
    });
  });

  it('splits the measurement health per persistence unit, so an env baseline cannot drown a session outage', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    const ageing = {
      measuredAt: new Date(now.getTime() - STALE_MEASUREMENT_MS - 1),
      lastActiveAt: new Date(now.getTime() - 60 * 60 * 1000),
    };
    const { deps } = makeDeps({
      // The state EVERY env sits in 24h after provisioning today: measured once
      // at create, `lastActiveAt` never written since, so permanently "stale".
      listDriveEnvSprites: async () => [driveEnv({ envId: 'env-1', ...ageing }), driveEnv({ envId: 'env-2', ...ageing })],
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'session-fresh' })],
      now: () => now,
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'two envs billing on ageing baselines beside one freshly-measured session',
      should:
        "attribute the staleness to ENVS alone, so the session column still reads zero and an operator can see a session-side outage when one happens",
      actual: result.measurementHealth,
      expected: {
        session: { live: 1, neverMeasured: 0, stale: 0 },
        env: { live: 2, neverMeasured: 0, stale: 2 },
        hosting: { live: 0, neverMeasured: 0, stale: 0 },
      },
    });
    // The flat totals still hold — the split is additive detail, not a redefinition.
    expect(result).toMatchObject({ staleMeasurements: 2, neverMeasured: 0 });
  });

  it('counts a never-measured row under its own unit too', async () => {
    const { deps } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ measuredBytes: null, measuredAt: null })],
      listDriveEnvSprites: async () => [driveEnv({ measuredBytes: null, measuredAt: null })],
    });

    const result = await reconcileSandboxStorage(deps);

    expect(result.measurementHealth).toEqual({
      session: { live: 1, neverMeasured: 1, stale: 0 },
      env: { live: 1, neverMeasured: 1, stale: 0 },
      hosting: { live: 0, neverMeasured: 0, stale: 0 },
    });
  });

  it("resolves an env's payer through a deps lookup that reads `this`", async () => {
    // A deps implementation is free to be a real object (or a class) whose
    // methods read `this`, not just the object literal we happen to ship. So the
    // lookup here is a SHORTHAND METHOD that reaches for `this.now` — modules are
    // strict, so if the reconcile hands this function to `resolveEnvPayerId` as a
    // bare unbound reference, `this` is undefined and it throws. An arrow
    // function closing over an outer object would NOT catch that, which is the
    // trap this test exists to avoid.
    // BOTH arms are routed through it: the drive-scoped session arm and the env
    // arm each reach the lookup by a different route, so each needs its own proof.
    const { deps, chargeCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'session-this', driveId: 'drive-s' })],
      listDriveEnvSprites: async () => [driveEnv({ envId: 'env-this', driveId: 'drive-e' })],
      lookupDriveOwnerId(this: ReconcileSandboxStorageDeps, driveId: string): Promise<string | null> {
        return Promise.resolve(`owner-of-${driveId}-at-${this.now().toISOString()}`);
      },
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'a deps lookup that is a method reading `this`',
      should:
        'resolve BOTH payers — an unbound reference on either arm would throw for every row that arm owns',
      actual: {
        charged: result.charged,
        failed: result.failed,
        payers: chargeCalls.map((call) => [call.subjectId, call.payerId]),
      },
      expected: {
        charged: 2,
        failed: 0,
        payers: [
          ['session-this', 'owner-of-drive-s-at-2026-07-01T00:00:00.000Z'],
          ['env-this', 'owner-of-drive-e-at-2026-07-01T00:00:00.000Z'],
        ],
      },
    });
  });

  it('counts a REFUSED watermark advance as superseded, not as a failure', async () => {
    // The monotonic guard declining: a provision reset this row's watermark past
    // the tick's `now` while the tick was running. Not a failure and not money in
    // the dangerous direction — the row is already billed further ahead — but a
    // guard that declines invisibly is exactly the blind spot this meter exists
    // to remove.
    const { deps, chargeCalls } = makeDeps({
      listDriveEnvSprites: async () => [driveEnv({ envId: 'env-superseded' })],
      advanceDriveEnvWatermark: async () => 'superseded',
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an env whose watermark was reset forward by a provision mid-tick',
      should: 'count it as superseded — distinct from a failed charge and from an unadvanced one',
      actual: {
        charged: result.charged,
        failed: result.failed,
        chargedButUnadvanced: result.chargedButUnadvanced,
        watermarkSuperseded: result.watermarkSuperseded,
      },
      expected: { charged: 1, failed: 0, chargedButUnadvanced: 0, watermarkSuperseded: 1 },
    });
    expect(chargeCalls).toHaveLength(1);
  });

  it('counts a superseded watermark on the ZERO-COST path too, where no charge is involved', async () => {
    const { deps, chargeCalls } = makeDeps({
      // Never measured, so it prices to $0 and takes the early-advance branch.
      listDriveEnvSprites: async () => [driveEnv({ measuredBytes: null, measuredAt: null })],
      advanceDriveEnvWatermark: async () => 'superseded',
    });

    const result = await reconcileSandboxStorage(deps);

    expect({ charged: result.charged, charges: chargeCalls.length, superseded: result.watermarkSuperseded })
      .toEqual({ charged: 0, charges: 0, superseded: 1 });
  });

  it('does NOT count a row DELETED mid-tick as superseded — that would name a cause that never happened', async () => {
    // `row_gone` and `superseded` both mean "the write found nothing to move",
    // and collapsing them would be actively misleading: envs meter ~$0 today, so
    // a delete (a drive delete cascades its envs) is by far the likelier of the
    // two, and the operator would be told a generation boundary cut a billing
    // window when nothing of the sort happened.
    const { deps } = makeDeps({
      listDriveEnvSprites: async () => [driveEnv({ envId: 'env-deleted' })],
      advanceDriveEnvWatermark: async () => 'row_gone',
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an env row deleted between the listing and its watermark write',
      should: 'still count the charge, and report NO superseded watermark',
      actual: { charged: result.charged, failed: result.failed, watermarkSuperseded: result.watermarkSuperseded },
      expected: { charged: 1, failed: 0, watermarkSuperseded: 0 },
    });
  });

  it('looks a drive owner up ONCE PER DRIVE per tick, not once per row', async () => {
    const lookup = vi.fn(async (driveId: string) => `owner-of-${driveId}`);
    const { deps, chargeCalls } = makeDeps({
      listAgentSessionSprites: async () => [
        agentSession({ workspaceId: 's1', driveId: 'drive-a' }),
        agentSession({ workspaceId: 's2', driveId: 'drive-a' }),
      ],
      listDriveEnvSprites: async () => [
        driveEnv({ envId: 'e1', driveId: 'drive-a' }),
        driveEnv({ envId: 'e2', driveId: 'drive-b' }),
      ],
      lookupDriveOwnerId: lookup,
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'four rows across two drives, three of them sharing one drive',
      should: 'issue one owner lookup per DRIVE — the row loop is serial, so each one sits on the critical path',
      actual: { calls: lookup.mock.calls.map((call) => call[0]).sort(), charged: result.charged },
      expected: { calls: ['drive-a', 'drive-b'], charged: 4 },
    });
    // Every row still gets the right payer despite the sharing.
    expect(chargeCalls.map((call) => [call.subjectId, call.payerId])).toEqual([
      ['s1', 'owner-of-drive-a'],
      ['s2', 'owner-of-drive-a'],
      ['e1', 'owner-of-drive-a'],
      ['e2', 'owner-of-drive-b'],
    ]);
  });

  it('caches an UNRESOLVABLE drive too — re-asking per row would not rescue it', async () => {
    const lookup = vi.fn(async () => null);
    const { deps } = makeDeps({
      listDriveEnvSprites: async () => [
        driveEnv({ envId: 'e1', driveId: 'gone' }),
        driveEnv({ envId: 'e2', driveId: 'gone' }),
      ],
      lookupDriveOwnerId: lookup,
    });

    const result = await reconcileSandboxStorage(deps);

    expect({ calls: lookup.mock.calls.length, skipped: result.skipped }).toEqual({ calls: 1, skipped: 2 });
  });

  it('attributes billable rows and charges to the RIGHT unit', async () => {
    // The per-kind counters the cron's wipeout alert reads. A cross-kind total
    // cannot answer "did a LIVE unit bill nothing though it had work" — an env
    // charging satisfies it while every session fails.
    const { deps } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 's1' }), agentSession({ workspaceId: 's2' })],
      // A DIFFERENT drive from the sessions', so the lookup below can answer for
      // one and not the other.
      listDriveEnvSprites: async () => [driveEnv({ envId: 'e1', driveId: 'drive-env' })],
      // The sessions' drive cannot resolve a payer; the env's can.
      lookupDriveOwnerId: async (driveId) => (driveId === 'drive-1' ? null : `owner-of-${driveId}`),
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'two sessions whose payer is unresolvable beside one env that charges',
      should: 'attribute each unit its own billable and charged counts, not a shared total',
      actual: result.billingByKind,
      expected: {
        session: { billable: 2, charged: 0, skipped: 2, failed: 0 },
        env: { billable: 1, charged: 1, skipped: 0, failed: 0 },
        hosting: { billable: 0, charged: 0, skipped: 0, failed: 0 },
      },
    });
    // The flat totals still add up — the split is detail, not a redefinition.
    expect({ billableRows: result.billableRows, charged: result.charged }).toEqual({
      billableRows: 3,
      charged: 1,
    });
  });

  it('does NOT count a clamp when the watermark was SUPERSEDED or the row is GONE', async () => {
    // `spanClamped` promises the cap forgave revenue on a row whose window
    // actually closed. A superseded write means a provision already carried the
    // row past this tick — its window was never ours to shorten — and `row_gone`
    // means the row no longer exists. Counting either sends an operator after a
    // forgiveness that did not happen.
    const now = new Date('2026-07-01T00:00:00.000Z');
    const frozen = { storageLastBilledAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000) };

    for (const [outcome, label] of [
      ['superseded', 'a provision that already moved it past this tick'],
      ['row_gone', 'a row deleted mid-tick'],
    ] as const) {
      const { deps } = makeDeps({
        listDriveEnvSprites: async () => [driveEnv(frozen)],
        advanceDriveEnvWatermark: async () => outcome,
        now: () => now,
      });

      const result = await reconcileSandboxStorage(deps);

      assert({
        given: `a clamped window whose watermark write reported ${label}`,
        should: 'charge the row but report NO clamp — its window did not close here',
        actual: { charged: result.charged, spanClamped: result.spanClamped },
        expected: { charged: 1, spanClamped: 0 },
      });
    }
  });

  it('keeps a $0 row\'s watermark failure OUT of the billing record — it was never billable', async () => {
    // The invariant `billingByKind` asserts: every row counted `billable` ends as
    // exactly one of charged / skipped / failed. A never-measured row owes
    // nothing, so its watermark advance failing must not read as "a billable row
    // failed to charge" — the alert picks its CAUSE LABEL from exactly that
    // comparison, and would file a payer-lookup fault in the charge-path bucket.
    const { deps } = makeDeps({
      listAgentSessionSprites: async () => [
        // Two billable sessions whose payer cannot be resolved.
        agentSession({ workspaceId: 's1' }),
        agentSession({ workspaceId: 's2' }),
        // Three never-measured rows whose watermark write then throws.
        agentSession({ workspaceId: 'z1', measuredBytes: null, measuredAt: null }),
        agentSession({ workspaceId: 'z2', measuredBytes: null, measuredAt: null }),
        agentSession({ workspaceId: 'z3', measuredBytes: null, measuredAt: null }),
      ],
      lookupDriveOwnerId: async () => null,
      advanceAgentSessionWatermark: async () => {
        throw new Error('transient db error');
      },
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'two billable rows skipped beside three $0 rows whose watermark write failed',
      should:
        'record only the billable rows in billingByKind, so the wipeout reads as SKIPPED rather than FAILED',
      actual: {
        billing: result.billingByKind.session,
        failedTotal: result.failed,
        skippedTotal: result.skipped,
      },
      expected: {
        billing: { billable: 2, charged: 0, skipped: 2, failed: 0 },
        // The three $0 failures still count in the FLAT total — nothing was
        // billed for them either — they just are not billing-record failures.
        failedTotal: 3,
        skippedTotal: 2,
      },
    });
  });

  it('reports no health noise when every row carries a fresh measurement', async () => {
    const { deps } = makeDeps({
      listAgentSessionSprites: async () => [agentSession()],
      listDriveEnvSprites: async () => [driveEnv()],
    });

    const result = await reconcileSandboxStorage(deps);

    expect(result).toMatchObject({ neverMeasured: 0, staleMeasurements: 0, failedSources: [] });
    expect(result.measurementHealth).toEqual({
      session: { live: 1, neverMeasured: 0, stale: 0 },
      env: { live: 1, neverMeasured: 0, stale: 0 },
      hosting: { live: 0, neverMeasured: 0, stale: 0 },
    });
  });

  it('given the ENV source throws, still bills every SESSION and names the unread source', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => [agentSession({ workspaceId: 'session-a' })],
      listDriveEnvSprites: async () => {
        throw new Error('drive_envs unreadable');
      },
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'a drive_envs read that fails while the session source is healthy',
      should: 'bill the sessions anyway — folding envs in must never be able to stop the existing meter',
      actual: {
        charged: result.charged,
        processed: result.processed,
        failedSources: result.failedSources,
        billed: chargeCalls.map((call) => call.subjectId),
      },
      expected: { charged: 1, processed: 1, failedSources: ['env'], billed: ['session-a'] },
    });
    expect(agentSessionAdvanceCalls.map((call) => call.workspaceId)).toEqual(['session-a']);
  });

  it('given the SESSION source throws, still bills every ENV — the isolation runs both ways', async () => {
    const { deps, chargeCalls, driveEnvAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => {
        throw new Error('agent_workspaces unreadable');
      },
      listDriveEnvSprites: async () => [driveEnv({ envId: 'env-a' })],
    });

    const result = await reconcileSandboxStorage(deps);

    expect(result).toMatchObject({ charged: 1, processed: 1, failedSources: ['session'] });
    expect(chargeCalls.map((call) => call.subjectId)).toEqual(['env-a']);
    expect(driveEnvAdvanceCalls.map((call) => call.envId)).toEqual(['env-a']);
  });

  it('given BOTH sources throw, is a clean no-op that names both — nothing billed, nothing advanced', async () => {
    const { deps, chargeCalls, agentSessionAdvanceCalls, driveEnvAdvanceCalls } = makeDeps({
      listAgentSessionSprites: async () => {
        throw new Error('down');
      },
      listDriveEnvSprites: async () => {
        throw new Error('down');
      },
    });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'both row sources failing to list',
      should: 'move no money and leave every watermark untouched, so the whole tick is caught up next run',
      actual: {
        result: { processed: result.processed, charged: result.charged, failedSources: result.failedSources },
        writes: chargeCalls.length + agentSessionAdvanceCalls.length + driveEnvAdvanceCalls.length,
      },
      expected: {
        result: { processed: 0, charged: 0, failedSources: ['session', 'env'] },
        writes: 0,
      },
    });
  });
});
