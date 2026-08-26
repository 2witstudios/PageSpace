import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from '../../sandbox/__tests__/riteway';

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id', subscriptionTier: 'users.subscriptionTier' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));

const mockCanConsumeAI = vi.hoisted(() => vi.fn());
vi.mock('../../../billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));

const mockReleaseHold = vi.hoisted(() => vi.fn());
vi.mock('../../../billing/credit-consume', () => ({ releaseHold: mockReleaseHold }));

const mockTrackUsage = vi.hoisted(() => vi.fn());
vi.mock('../../../monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: mockTrackUsage } }));

import { defaultAppBillingDeps } from '../app-billing';
import {
  MACHINE_MARKUP_BPS,
  PUBLISHED_APP_DAILY_CAP_CEILING_CENTS,
  PUBLISHED_APP_MAX_INFLIGHT,
  PUBLISHED_APP_WAKE_HOLD_ESTIMATE_CENTS,
} from '../../../billing/credit-pricing';
import { PUBLISHED_APP_AWAKE_MODEL } from '../../../monitoring/usage-source';
import {
  calculateMachineCostDollars,
  PUBLISHED_APP_GUEST_SHAPE,
  SANDBOX_GUEST_SHAPE,
} from '../../../monitoring/machine-pricing';

beforeEach(() => {
  mockDb.select.mockReset();
  mockCanConsumeAI.mockReset();
  mockReleaseHold.mockReset();
  mockTrackUsage.mockReset();
});

function mockSingleRow(row: Record<string, unknown> | undefined) {
  mockDb.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }),
  });
}

describe('defaultAppBillingDeps.resolvePayerId', () => {
  it('bills the DRIVE OWNER — the payer for anything hanging off an environment', async () => {
    mockSingleRow({ ownerId: 'drive-owner-1' });

    assert({
      given: 'a published app whose drive resolves',
      should: 'pay from the drive owner',
      actual: await defaultAppBillingDeps.resolvePayerId({ driveId: 'drive-1' }),
      expected: 'drive-owner-1',
    });
  });

  it('given an unresolvable drive, should yield NO payer rather than substituting one', async () => {
    // There is deliberately no fallback to `published_apps.ownerId`: that column
    // is a denormalized cascade handle, and a money movement to the wrong person
    // cannot be taken back while a skipped cycle self-corrects.
    mockSingleRow(undefined);

    assert({
      given: 'a stale read of a drive mid-delete',
      should: 'resolve to null',
      actual: await defaultAppBillingDeps.resolvePayerId({ driveId: 'gone' }),
      expected: null,
    });
  });
});

describe('defaultAppBillingDeps.gate', () => {
  it('gates on the PAYER’s own tier, read from the resolved payer rather than an acting user', async () => {
    // Nobody is necessarily "acting" when a published app wakes — the trigger is
    // an inbound request from a stranger — so the tier has to come from the payer.
    mockSingleRow({ subscriptionTier: 'pro' });
    mockCanConsumeAI.mockResolvedValue({ allowed: true, holdId: 'hold-1' });

    await defaultAppBillingDeps.gate({ payerId: 'payer-1' });

    expect(mockCanConsumeAI).toHaveBeenCalledWith('payer-1', 'pro', expect.anything());
  });

  it('ALWAYS passes a daily-cap ceiling — the "unlimited but not unbounded" rule for tenant/onprem', async () => {
    // `canConsumeAI` short-circuits to the query-free unlimited path when billing
    // is disabled AND no ceiling is supplied. Supplying one keeps a per-payer
    // daily bound in force there, metered from `ai_usage_logs`.
    mockSingleRow({ subscriptionTier: 'free' });
    mockCanConsumeAI.mockResolvedValue({ allowed: true, holdId: 'hold-1' });

    await defaultAppBillingDeps.gate({ payerId: 'payer-1' });

    expect(mockCanConsumeAI).toHaveBeenCalledWith('payer-1', 'free', {
      estCostCents: PUBLISHED_APP_WAKE_HOLD_ESTIMATE_CENTS,
      maxInFlight: PUBLISHED_APP_MAX_INFLIGHT,
      dailyCapCeilingCents: PUBLISHED_APP_DAILY_CAP_CEILING_CENTS,
    });
    expect(PUBLISHED_APP_DAILY_CAP_CEILING_CENTS).toBeGreaterThan(0);
  });

  it('passes the hold through on an allowed gate, and the reason on a refusal', async () => {
    mockSingleRow({ subscriptionTier: 'pro' });
    mockCanConsumeAI.mockResolvedValue({ allowed: true, holdId: 'hold-9' });
    expect(await defaultAppBillingDeps.gate({ payerId: 'p' })).toEqual({
      allowed: true,
      holdId: 'hold-9',
      reason: undefined,
    });

    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'insufficient_credits' });
    expect(await defaultAppBillingDeps.gate({ payerId: 'p' })).toEqual({
      allowed: false,
      holdId: undefined,
      reason: 'insufficient_credits',
    });
  });
});

describe('defaultAppBillingDeps.trackUsage', () => {
  const settle = () =>
    defaultAppBillingDeps.trackUsage({
      payerId: 'payer-1',
      holdId: 'hold-1',
      activeSeconds: 600,
      driveId: 'drive-1',
      publishedAppId: 'app-1',
    });

  it('RETURNS the credit seam’s persistence outcome verbatim — the callers gate their awake window on it', async () => {
    // The whole point of the seam: a resolved settle is not a settled one. If this
    // binding dropped the outcome (an `async` wrapper that awaits and returns
    // nothing, which is what it used to be), every hosting caller would be back to
    // closing windows over lost charges with no way to tell.
    mockTrackUsage.mockResolvedValueOnce({ persisted: false, creditsSettled: false });
    expect(await settle()).toEqual({ persisted: false, creditsSettled: false });

    mockTrackUsage.mockResolvedValueOnce({ persisted: true, creditsSettled: true });
    expect(await settle()).toEqual({ persisted: true, creditsSettled: true });
  });

  it('attributes the charge to the payer, the drive, and the published app', async () => {
    await settle();

    const call = mockTrackUsage.mock.calls[0][0];
    assert({
      given: 'a settled awake window',
      should: 'carry the payer, the drive and the app id',
      actual: { userId: call.userId, driveId: call.driveId, sessionId: call.sessionId },
      // `sessionId` is the shared analytics column; `model` below is what says
      // which table this id addresses.
      expected: { userId: 'payer-1', driveId: 'drive-1', sessionId: 'app-1' },
    });
  });

  it('labels the row with the published-app AWAKE model — the only thing separating it from a terminal row', async () => {
    // A hosting runtime row carries `source: 'terminal'` and no `pageId`, exactly
    // like a sandbox terminal row, so the model label is the whole discriminator.
    await settle();

    const call = mockTrackUsage.mock.calls[0][0];
    assert({
      given: 'a published-app runtime charge',
      should: 'be labelled published-app-awake, sourced to terminal, with no pageId',
      actual: { model: call.model, source: call.source, pageId: call.pageId, provider: call.provider },
      expected: {
        model: PUBLISHED_APP_AWAKE_MODEL,
        source: 'terminal',
        pageId: undefined,
        provider: 'fly',
      },
    });
  });

  it('prices at the KNOWN published-app guest, not the assumed sandbox shape', async () => {
    // `published_apps.guestPreset` is pinned to shared-cpu-1x-512 by a CHECK, so
    // pricing at the sandbox default would under-bill every awake second by half
    // the memory component, silently.
    await settle();

    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.providerCostDollars).toBe(
      calculateMachineCostDollars({ activeSeconds: 600, shape: PUBLISHED_APP_GUEST_SHAPE }),
    );
    expect(PUBLISHED_APP_GUEST_SHAPE.memoryGB).not.toBe(SANDBOX_GUEST_SHAPE.memoryGB);
    expect(call.providerCostDollars).not.toBe(
      calculateMachineCostDollars({ activeSeconds: 600, shape: SANDBOX_GUEST_SHAPE }),
    );
  });

  it('settles against the wake’s hold at the substrate markup, as a deterministic list price', async () => {
    // Fly has no billing API, so the figure is always ours (awake seconds x the
    // published rate) and never a provider-returned one.
    await settle();

    const call = mockTrackUsage.mock.calls[0][0];
    assert({
      given: 'a settle carrying the wake’s hold',
      should: 'consume that hold at the machine markup as a list price',
      actual: {
        holdId: call.holdId,
        markupBpsOverride: call.markupBpsOverride,
        costSource: call.costSource,
        success: call.success,
      },
      expected: {
        holdId: 'hold-1',
        markupBpsOverride: MACHINE_MARKUP_BPS,
        costSource: 'list_price',
        success: true,
      },
    });
  });

  it('records the billed span in both the duration and the metadata', async () => {
    await settle();

    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.duration).toBe(600_000);
    expect(call.metadata).toEqual({ type: 'published_app_awake', activeSeconds: 600 });
  });

  it('given no hold (a billing-disabled wake that took the unlimited path), should still settle', async () => {
    await defaultAppBillingDeps.trackUsage({
      payerId: 'payer-1',
      holdId: undefined,
      activeSeconds: 30,
      driveId: 'drive-1',
      publishedAppId: 'app-1',
    });

    expect(mockTrackUsage.mock.calls[0][0].holdId).toBeUndefined();
  });
});

describe('defaultAppBillingDeps.releaseHold', () => {
  it('returns the reservation through the shared credit pipeline', async () => {
    await defaultAppBillingDeps.releaseHold('hold-3');
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-3');
  });
});
