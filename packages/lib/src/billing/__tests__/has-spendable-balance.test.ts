/**
 * hasSpendableBalance — the read-only twin of the credit gate.
 *
 * It exists for one caller shape: the published-app routing edge, which asks
 * "could this payer spend?" once per HTTP REQUEST (the metered tier has no
 * replay cache, by design). The whole reason it is not `canConsumeAI` is that
 * `canConsumeAI` inserts a hold — right for one bounded AI call, catastrophic on
 * a path that runs for every image and stylesheet a published page loads, where
 * each hold would reserve spend against a run that has no settle to release it.
 *
 * So the two properties under test are: it reaches the same VERDICT the gate
 * would (same floor, same comparison), and it WRITES NOTHING.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
const mockReadSpendableCents = vi.hoisted(() => vi.fn());
const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));
vi.mock('../credit-balance', () => ({ readSpendableCents: mockReadSpendableCents }));
vi.mock('@pagespace/db/schema/credits', () => ({
  creditBalances: { userId: 'cb.userId' },
  creditHolds: { id: 'ch.id', userId: 'ch.userId', estCents: 'ch.est', expiresAt: 'ch.exp' },
  creditLedger: {
    userId: 'cl.userId',
    stripeRef: 'cl.stripeRef',
    entryType: 'cl.entryType',
    bucket: 'cl.bucket',
    amountCents: 'cl.amount',
    chargeMillicents: 'cl.charge',
    consumeStatus: 'cl.consumeStatus',
    createdAt: 'cl.createdAt',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...a) => ({ op: 'and', a })),
  gt: vi.fn((a, b) => ({ op: 'gt', a, b })),
  lt: vi.fn((a, b) => ({ op: 'lt', a, b })),
  gte: vi.fn((a, b) => ({ op: 'gte', a, b })),
  lte: vi.fn((a, b) => ({ op: 'lte', a, b })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: [strings, values] })),
    { raw: vi.fn((s: string) => ({ raw: s })) },
  ),
}));

import { hasSpendableBalance } from '../credit-gate';
import { RESERVE_FLOOR_CENTS } from '../credit-pricing';

/** The lean read returns the spendable figure itself. */
function balance(spendable: number) {
  return spendable;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBillingEnabled.mockReturnValue(true);
});

describe('hasSpendableBalance — the same floor the gate applies', () => {
  it('given a balance comfortably above the floor, should allow', async () => {
    mockReadSpendableCents.mockResolvedValue(balance(RESERVE_FLOOR_CENTS + 500));
    expect(await hasSpendableBalance('user_1', 'pro')).toBe(true);
  });

  it('given a balance exactly AT the floor, should refuse — the gate compares strictly greater', async () => {
    mockReadSpendableCents.mockResolvedValue(balance(RESERVE_FLOOR_CENTS));
    expect(await hasSpendableBalance('user_1', 'pro')).toBe(false);
  });

  it('given a balance one cent above the floor, should allow', async () => {
    mockReadSpendableCents.mockResolvedValue(balance(RESERVE_FLOOR_CENTS + 1));
    expect(await hasSpendableBalance('user_1', 'pro')).toBe(true);
  });

  it('given an exhausted balance, should refuse — this is the parked-page path', async () => {
    mockReadSpendableCents.mockResolvedValue(balance(0));
    expect(await hasSpendableBalance('user_1', 'pro')).toBe(false);
  });

  it('given a balance pulled negative by debt, should refuse', async () => {
    mockReadSpendableCents.mockResolvedValue(balance(-1200));
    expect(await hasSpendableBalance('user_1', 'pro')).toBe(false);
  });
});

describe('hasSpendableBalance — deployments without billing are unlimited', () => {
  it('given billing is disabled, should allow without reading the ledger at all', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    expect(await hasSpendableBalance('user_1', 'pro')).toBe(true);
    expect(mockReadSpendableCents).not.toHaveBeenCalled();
  });
});

describe('hasSpendableBalance — reads only, on a per-request path', () => {
  it('given any call, should never write: no hold, no insert, no update, no transaction', async () => {
    mockReadSpendableCents.mockResolvedValue(balance(5000));

    await hasSpendableBalance('user_1', 'pro');

    // A hold per request would reserve spend against a run with no settle.
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('given a call, should not read credit_holds — the gate discards that figure anyway', async () => {
    // The whole reason this does not go through getCreditBalance: that read also
    // runs a SUM over active holds, which this gate throws away, on a path that
    // executes once per image and per stylesheet of a published page.
    mockReadSpendableCents.mockResolvedValue(balance(5000));

    await hasSpendableBalance('user_1', 'pro');

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockReadSpendableCents).toHaveBeenCalledTimes(1);
  });

  it("given a tier, should judge the balance against that tier's allowance", async () => {
    mockReadSpendableCents.mockResolvedValue(balance(5000));
    await hasSpendableBalance('user_1', 'pro');
    expect(mockReadSpendableCents).toHaveBeenCalledWith('user_1', 'pro');
  });

  it('given no tier, should default to free rather than assume an allowance', async () => {
    mockReadSpendableCents.mockResolvedValue(balance(5000));
    await hasSpendableBalance('user_1');
    expect(mockReadSpendableCents).toHaveBeenCalledWith('user_1', 'free');
  });
});
