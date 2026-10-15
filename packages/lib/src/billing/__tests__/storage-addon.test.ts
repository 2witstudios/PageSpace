import { describe, it, expect } from 'vitest';
import {
  EMPTY_STORAGE_ADDON,
  applyStorageAddonChange,
  entitledStorageBlocks,
  findStorageItem,
  isValidStorageBlockCount,
  planStorageAddonChange,
  storageAddonBytes,
  storageAddonIdempotencyKey,
  storageAddonMonthlyCents,
  type StoredStorageAddon,
} from '../storage-addon';
import { STORAGE_ADDON } from '../subscription-tiers';

const GB = 1024 ** 3;
const now = new Date('2026-10-15T00:00:00Z');
const periodEnd = new Date('2026-11-01T00:00:00Z');
const payer = { kind: 'user' as const, id: 'user_1' };
const stored = (over: Partial<StoredStorageAddon> = {}): StoredStorageAddon => ({
  itemId: 'si_1', blocks: 0, graceBlocks: 0, graceUntil: null, revision: 3, ...over,
});

describe('storage add-on core', () => {
  it('given the add-on table, should sell 50GB blocks at $5 with a ceiling', () => {
    expect(STORAGE_ADDON).toEqual({ blockBytes: 50 * GB, priceMonthlyUsd: 5, maxBlocks: 20 });
    expect(storageAddonBytes(3)).toBe(150 * GB);
    expect(storageAddonMonthlyCents(3)).toBe(1500);
    expect(storageAddonBytes(-1)).toBe(0);
  });

  it('given block counts, should accept only whole numbers within the ceiling', () => {
    expect(isValidStorageBlockCount(0)).toBe(true);
    expect(isValidStorageBlockCount(20)).toBe(true);
    expect(isValidStorageBlockCount(21)).toBe(false);
    expect(isValidStorageBlockCount(1.5)).toBe(false);
    expect(isValidStorageBlockCount(-1)).toBe(false);
    expect(isValidStorageBlockCount('2')).toBe(false);
  });

  describe('entitledStorageBlocks', () => {
    it('given no grace, should be the live quantity', () => {
      expect(entitledStorageBlocks(stored({ blocks: 2 }), now)).toBe(2);
    });
    it('given an unexpired grace above the live quantity, should honor the grace', () => {
      expect(entitledStorageBlocks(stored({ blocks: 1, graceBlocks: 3, graceUntil: periodEnd }), now)).toBe(3);
    });
    it('given an expired grace, should drop to the live quantity', () => {
      expect(entitledStorageBlocks(stored({ blocks: 1, graceBlocks: 3, graceUntil: periodEnd }), new Date('2026-11-02T00:00:00Z'))).toBe(1);
    });
    it('given nothing bought, should be zero', () => {
      expect(entitledStorageBlocks(EMPTY_STORAGE_ADDON, now)).toBe(0);
    });
  });

  describe('planStorageAddonChange', () => {
    it('given the same quantity, should do nothing', () => {
      expect(planStorageAddonChange({ payer, stored: stored({ blocks: 2 }), target: 2, periodEnd, now })).toEqual({ kind: 'noop' });
    });

    it('given a quantity over the ceiling, should refuse', () => {
      expect(planStorageAddonChange({ payer, stored: stored(), target: 21, periodEnd, now })).toEqual({ kind: 'invalid', reason: 'out_of_range' });
    });

    it('given a first purchase, should create the item with an immediate prorated charge', () => {
      const plan = planStorageAddonChange({ payer, stored: EMPTY_STORAGE_ADDON, target: 2, periodEnd, now });
      expect(plan).toMatchObject({
        kind: 'apply',
        charges: true,
        steps: [{ quantity: 2, prorationBehavior: 'always_invoice', createItem: true }],
        next: { blocks: 2, graceBlocks: 0, graceUntil: null, revision: 1 },
      });
    });

    it('given a decrease, should lower Stripe now without proration and keep the paid blocks until period end', () => {
      const plan = planStorageAddonChange({ payer, stored: stored({ blocks: 3 }), target: 1, periodEnd, now });
      expect(plan).toMatchObject({
        kind: 'apply',
        charges: false,
        steps: [{ quantity: 1, prorationBehavior: 'none', createItem: false }],
        next: { blocks: 1, graceBlocks: 3, graceUntil: periodEnd, revision: 4 },
      });
    });

    it('given a second decrease in the same period, should keep the larger paid quantity as grace', () => {
      const plan = planStorageAddonChange({ payer, stored: stored({ blocks: 2, graceBlocks: 4, graceUntil: periodEnd }), target: 0, periodEnd, now });
      expect(plan).toMatchObject({ kind: 'apply', next: { blocks: 0, graceBlocks: 4, graceUntil: periodEnd } });
    });

    it('given an increase within blocks already paid this period, should not charge and keep the grace', () => {
      const plan = planStorageAddonChange({ payer, stored: stored({ blocks: 1, graceBlocks: 3, graceUntil: periodEnd }), target: 3, periodEnd, now });
      expect(plan).toMatchObject({
        kind: 'apply',
        charges: false,
        steps: [{ quantity: 3, prorationBehavior: 'none' }],
        next: { blocks: 3, graceBlocks: 3, graceUntil: periodEnd },
      });
    });

    it('given an increase beyond the paid grace, should restore the paid quantity free then charge only the new blocks', () => {
      const plan = planStorageAddonChange({ payer, stored: stored({ blocks: 1, graceBlocks: 3, graceUntil: periodEnd }), target: 5, periodEnd, now });
      expect(plan).toMatchObject({
        kind: 'apply',
        charges: true,
        steps: [
          { quantity: 3, prorationBehavior: 'none' },
          { quantity: 5, prorationBehavior: 'always_invoice' },
        ],
        next: { blocks: 5, graceBlocks: 0, graceUntil: null },
      });
    });

    it('given an expired grace, should charge the whole increase', () => {
      const plan = planStorageAddonChange({
        payer, stored: stored({ blocks: 1, graceBlocks: 3, graceUntil: new Date('2026-10-01T00:00:00Z') }), target: 2, periodEnd, now,
      });
      expect(plan).toMatchObject({ kind: 'apply', charges: true, steps: [{ quantity: 2, prorationBehavior: 'always_invoice' }] });
    });

    it('given the same change replayed, should reuse the idempotency keys; a later change should not', () => {
      const a = planStorageAddonChange({ payer, stored: stored({ blocks: 1 }), target: 2, periodEnd, now });
      const b = planStorageAddonChange({ payer, stored: stored({ blocks: 1 }), target: 2, periodEnd, now });
      const later = planStorageAddonChange({ payer, stored: stored({ blocks: 1, revision: 4 }), target: 2, periodEnd, now });
      if (a.kind !== 'apply' || b.kind !== 'apply' || later.kind !== 'apply') throw new Error('expected apply');
      expect(a.steps[0].idempotencyKey).toBe(b.steps[0].idempotencyKey);
      expect(later.steps[0].idempotencyKey).not.toBe(a.steps[0].idempotencyKey);
    });
  });

  it('given a long payer id, should keep the idempotency key within Stripe limits', () => {
    expect(storageAddonIdempotencyKey({ kind: 'org', id: 'x'.repeat(400) }, { a: 1 }).length).toBeLessThanOrEqual(255);
  });

  it('given subscription items, should find the storage item only by an unambiguous configured price', () => {
    const items = [{ priceId: 'price_pro', id: 'a' }, { priceId: 'price_storage', id: 'b' }];
    expect(findStorageItem(items, 'price_storage')?.id).toBe('b');
    expect(findStorageItem(items, '')).toBeNull();
    expect(findStorageItem([...items, { priceId: 'price_storage', id: 'c' }], 'price_storage')).toBeNull();
  });
});

describe('applyStorageAddonChange', () => {
  function fakePort(opts: { failOn?: (q: number) => boolean } = {}) {
    const calls: Array<{ op: string; quantity: number; prorationBehavior: string; itemId?: string }> = [];
    const port = {
      createItem: async (input: { quantity: number; prorationBehavior: 'always_invoice' | 'none'; idempotencyKey: string }) => {
        if (opts.failOn?.(input.quantity)) throw new Error('card_declined');
        calls.push({ op: 'create', quantity: input.quantity, prorationBehavior: input.prorationBehavior });
        return { id: 'si_new' };
      },
      updateItem: async (input: { itemId: string; quantity: number; prorationBehavior: 'always_invoice' | 'none'; idempotencyKey: string }) => {
        if (opts.failOn?.(input.quantity)) throw new Error('card_declined');
        calls.push({ op: 'update', quantity: input.quantity, prorationBehavior: input.prorationBehavior, itemId: input.itemId });
      },
    };
    return { port, calls };
  }

  it('given a first purchase, should create the item and store its id', async () => {
    const { port, calls } = fakePort();
    const result = await applyStorageAddonChange({ payer, stored: EMPTY_STORAGE_ADDON, target: 2, periodEnd, now, port });
    expect(calls).toEqual([{ op: 'create', quantity: 2, prorationBehavior: 'always_invoice' }]);
    expect(result).toMatchObject({ kind: 'applied', charged: true, stored: { itemId: 'si_new', blocks: 2, revision: 1 } });
  });

  it('given a declined card on the charging step of a two-step increase, should undo the free restore', async () => {
    const { port, calls } = fakePort({ failOn: (q) => q === 5 });
    const result = await applyStorageAddonChange({
      payer, stored: stored({ blocks: 1, graceBlocks: 3, graceUntil: periodEnd }), target: 5, periodEnd, now, port,
    });
    expect(result.kind).toBe('failed');
    expect(calls).toEqual([
      { op: 'update', quantity: 3, prorationBehavior: 'none', itemId: 'si_1' },
      { op: 'update', quantity: 1, prorationBehavior: 'none', itemId: 'si_1' },
    ]);
  });

  it('given a declined card on a single-step increase, should write nothing else', async () => {
    const { port, calls } = fakePort({ failOn: () => true });
    const result = await applyStorageAddonChange({ payer, stored: stored({ blocks: 1 }), target: 2, periodEnd, now, port });
    expect(result.kind).toBe('failed');
    expect(calls).toEqual([]);
  });
});
