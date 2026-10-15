/**
 * The storage add-on core (pure): how many extra-storage blocks a payer is
 * entitled to right now, and how to move the Stripe item to a new quantity.
 *
 * One rule for a person's Pro subscription and an org's Business subscription.
 * The block size, price and ceiling live in STORAGE_ADDON (subscription-tiers).
 *
 * Removal takes effect at period end with no refund, without a cron: a decrease
 * lowers Stripe's quantity at once with `proration_behavior: 'none'` (the next
 * renewal bills the new quantity) and records the quantity already paid for as
 * a grace entitlement until the period ends. A later increase in the same period
 * never re-bills blocks covered by that grace.
 */

import { createHash } from 'crypto';
import { STORAGE_ADDON } from './subscription-tiers';
import { centsFromDollars } from './money-model';

/** The add-on state PageSpace mirrors from the payer's subscription. */
export interface StoredStorageAddon {
  /** The Stripe subscription item carrying the storage price; null before the first purchase. */
  itemId: string | null;
  /** The quantity Stripe was last set to. */
  blocks: number;
  /** Blocks already paid for this period after a decrease; honored until graceUntil. */
  graceBlocks: number;
  graceUntil: Date | null;
  /** Bumped on every applied quantity change; part of the idempotency key. */
  revision: number;
}

export const EMPTY_STORAGE_ADDON: StoredStorageAddon = {
  itemId: null,
  blocks: 0,
  graceBlocks: 0,
  graceUntil: null,
  revision: 0,
};

function wholeBlocks(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;
}

/** Grace blocks still in force at `now` (0 once the period they were paid for has ended). */
export function unexpiredGraceBlocks(stored: Pick<StoredStorageAddon, 'graceBlocks' | 'graceUntil'>, now: Date): number {
  if (!stored.graceUntil || stored.graceUntil.getTime() <= now.getTime()) return 0;
  return wholeBlocks(stored.graceBlocks);
}

/** Blocks the payer holds right now: the current quantity, or more while a paid-for decrease runs out. */
export function entitledStorageBlocks(stored: Pick<StoredStorageAddon, 'blocks' | 'graceBlocks' | 'graceUntil'>, now: Date): number {
  return Math.max(wholeBlocks(stored.blocks), unexpiredGraceBlocks(stored, now));
}

/** Bytes `blocks` add to a quota. */
export function storageAddonBytes(blocks: number): number {
  return wholeBlocks(blocks) * STORAGE_ADDON.blockBytes;
}

/** Monthly list price of `blocks`, whole cents. Display only. */
export function storageAddonMonthlyCents(blocks: number): number {
  return centsFromDollars(wholeBlocks(blocks) * STORAGE_ADDON.priceMonthlyUsd);
}

/** Whether `blocks` is a quantity a payer may choose. */
export function isValidStorageBlockCount(blocks: unknown): blocks is number {
  return typeof blocks === 'number' && Number.isSafeInteger(blocks) && blocks >= 0 && blocks <= STORAGE_ADDON.maxBlocks;
}

export type StorageProrationBehavior = 'always_invoice' | 'none';

export interface StorageAddonStep {
  quantity: number;
  prorationBehavior: StorageProrationBehavior;
  /** True for the step that creates the storage item (the payer's first purchase). */
  createItem: boolean;
  idempotencyKey: string;
}

export interface StorageAddonPayer {
  kind: 'user' | 'org';
  id: string;
}

export type StorageAddonChangePlan =
  | { kind: 'noop' }
  | { kind: 'invalid'; reason: 'out_of_range' }
  | {
      kind: 'apply';
      /** Stripe writes, in order. Each is idempotent on its own key. */
      steps: StorageAddonStep[];
      /** The mirror to store once every step has succeeded (itemId filled in by the caller on create). */
      next: Omit<StoredStorageAddon, 'itemId'>;
      /** Whether this change charges now (a prorated invoice), so the caller can confirm payment. */
      charges: boolean;
    };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stripe idempotency key for one storage write; ≤ 255 chars whatever the payer id. */
export function storageAddonIdempotencyKey(payer: StorageAddonPayer, params: unknown): string {
  const digest = createHash('sha256').update(stableJson(params)).digest('hex').slice(0, 32);
  const id = payer.id.length > 150 ? createHash('sha256').update(payer.id).digest('hex') : payer.id;
  return `pagespace-${payer.kind}:${id}:storage-quantity:${digest}`;
}

/**
 * Plan moving the payer's storage item to `target` blocks.
 *
 * - Decrease: one write at the new quantity with no proration; the old quantity
 *   (or a larger unexpired grace) stays entitled until `periodEnd`.
 * - Increase within what is already paid this period (an unexpired grace): no
 *   proration, the grace stays.
 * - Increase beyond it: first restore the paid quantity without proration (if
 *   the grace exceeds the live quantity), then raise to `target` with an
 *   immediate prorated invoice, so the charge covers only the new blocks.
 */
export function planStorageAddonChange(input: {
  payer: StorageAddonPayer;
  stored: StoredStorageAddon;
  target: number;
  /** End of the subscription's current billing period. */
  periodEnd: Date;
  now: Date;
}): StorageAddonChangePlan {
  const { payer, stored, target, periodEnd, now } = input;
  if (!isValidStorageBlockCount(target)) return { kind: 'invalid', reason: 'out_of_range' };
  const current = wholeBlocks(stored.blocks);
  if (target === current) return { kind: 'noop' };

  const grace = unexpiredGraceBlocks(stored, now);
  const paid = Math.max(current, grace);
  const revision = stored.revision + 1;
  let createNext = stored.itemId === null;
  const step = (quantity: number, prorationBehavior: StorageProrationBehavior, index: number): StorageAddonStep => {
    const createItem = createNext;
    createNext = false;
    return {
      quantity,
      prorationBehavior,
      createItem,
      idempotencyKey: storageAddonIdempotencyKey(payer, {
        itemId: stored.itemId ?? 'new',
        revision: stored.revision,
        step: index,
        quantity,
        prorationBehavior,
      }),
    };
  };

  if (target < current) {
    return {
      kind: 'apply',
      steps: [step(target, 'none', 0)],
      next: { blocks: target, graceBlocks: paid, graceUntil: periodEnd, revision },
      charges: false,
    };
  }

  if (target <= paid) {
    return {
      kind: 'apply',
      steps: [step(target, 'none', 0)],
      next: { blocks: target, graceBlocks: grace, graceUntil: grace > 0 ? stored.graceUntil : null, revision },
      charges: false,
    };
  }

  const steps = paid > current
    ? [step(paid, 'none', 0), step(target, 'always_invoice', 1)]
    : [step(target, 'always_invoice', 0)];
  return {
    kind: 'apply',
    steps,
    next: { blocks: target, graceBlocks: 0, graceUntil: null, revision },
    charges: true,
  };
}

/** The storage item among a subscription's items, matched by configured price only. */
export function findStorageItem<I extends { priceId: string }>(items: readonly I[], storagePriceId: string): I | null {
  if (!storagePriceId) return null;
  const matches = items.filter((item) => item.priceId === storagePriceId);
  return matches.length === 1 ? matches[0] : null;
}

/** The Stripe writes a storage change needs; implemented over the Stripe client by each payer's shell. */
export interface StorageAddonPort {
  createItem(input: { quantity: number; prorationBehavior: StorageProrationBehavior; idempotencyKey: string }): Promise<{ id: string }>;
  updateItem(input: { itemId: string; quantity: number; prorationBehavior: StorageProrationBehavior; idempotencyKey: string }): Promise<void>;
}

export type StorageAddonApplyResult =
  | { kind: 'noop'; stored: StoredStorageAddon }
  | { kind: 'invalid'; reason: 'out_of_range' }
  | { kind: 'applied'; stored: StoredStorageAddon; charged: boolean }
  /** A write was refused (a declined card on the charging step). Stripe is back where it started. */
  | { kind: 'failed'; error: unknown };

/**
 * Run a planned storage change against Stripe. `stored.blocks` must be Stripe's live
 * quantity. If the charging step of a two-step increase fails, the free restore step
 * before it is undone, so a declined card never leaves the payer billed next period
 * for blocks they had removed.
 */
export async function applyStorageAddonChange(input: {
  payer: StorageAddonPayer;
  stored: StoredStorageAddon;
  target: number;
  periodEnd: Date;
  now: Date;
  port: StorageAddonPort;
}): Promise<StorageAddonApplyResult> {
  const plan = planStorageAddonChange(input);
  if (plan.kind === 'noop') return { kind: 'noop', stored: input.stored };
  if (plan.kind === 'invalid') return plan;

  let itemId = input.stored.itemId;
  let lastApplied: number | null = null;
  for (const step of plan.steps) {
    try {
      if (step.createItem || itemId === null) {
        itemId = (await input.port.createItem(step)).id;
      } else {
        await input.port.updateItem({ ...step, itemId });
      }
      lastApplied = step.quantity;
    } catch (error) {
      if (lastApplied !== null && itemId !== null && lastApplied !== input.stored.blocks) {
        await input.port.updateItem({
          itemId,
          quantity: input.stored.blocks,
          prorationBehavior: 'none',
          idempotencyKey: storageAddonIdempotencyKey(input.payer, {
            itemId,
            revision: input.stored.revision,
            rollback: true,
            quantity: input.stored.blocks,
          }),
        });
      }
      return { kind: 'failed', error };
    }
  }
  return { kind: 'applied', stored: { itemId, ...plan.next }, charged: plan.charges };
}
