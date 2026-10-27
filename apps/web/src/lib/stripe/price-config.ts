import { stripeConfig } from '../stripe-config';
import { tierFromConfiguredPrice, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

/** The price identity carried by a Stripe invoice line. */
export type InvoiceLinePricing = {
  amount?: number;
  parent?: { subscription_item_details?: { subscription_item?: string | null } | null } | null;
  pricing?: {
    price_details?: { price?: string | { id: string } | null } | null;
  } | null;
};

function linePriceId(line: InvoiceLinePricing): string | null {
  const price = line.pricing?.price_details?.price;
  return (typeof price === 'string' ? price : price?.id) || null;
}

/** Whether `priceId` is the configured storage add-on price (never true when unconfigured). */
export function isStorageAddonPrice(priceId: string | null | undefined): boolean {
  return !!priceId && !!stripeConfig.storageAddonPriceId && priceId === stripeConfig.storageAddonPriceId;
}

/** Whether the storage add-on can be sold in this Stripe mode. */
export function isStorageAddonConfigured(): boolean {
  return stripeConfig.storageAddonPriceId !== '';
}

/**
 * Resolve charged subscription identities; credits cannot establish a paid plan.
 * Storage add-on lines ride along on a plan and are neither a plan nor a stranger.
 */
export function tierFromInvoiceLines(lines: readonly InvoiceLinePricing[]): Exclude<SubscriptionTier, 'business'> {
  const tiers = new Set<SubscriptionTier>();
  for (const line of lines) {
    if (!line.parent?.subscription_item_details || (line.amount !== undefined && line.amount < 0)) continue;
    const priceId = linePriceId(line);
    if (isStorageAddonPrice(priceId)) continue;
    const tier = priceId ? getTierFromPrice(priceId) : 'free';
    tiers.add(tier);
  }
  return tiers.size === 1 && tiers.has('pro') ? 'pro' : 'free';
}

/**
 * The part of `amountPaidCents` that bought the plan when the invoice also carries
 * storage add-on lines: amount_paid scaled by the non-storage share of the line
 * total (tax and discounts apply proportionally). Undefined when no storage line is
 * present, so an ordinary plan invoice is sized exactly as before.
 */
export function planPaidCentsFromInvoiceLines(
  lines: readonly InvoiceLinePricing[],
  amountPaidCents: number | null | undefined,
): number | undefined {
  let storage = 0;
  let total = 0;
  let hasStorage = false;
  for (const line of lines) {
    const amount = typeof line.amount === 'number' && Number.isFinite(line.amount) ? line.amount : 0;
    total += amount;
    if (isStorageAddonPrice(linePriceId(line))) {
      hasStorage = true;
      storage += amount;
    }
  }
  if (!hasStorage) return undefined;
  const paid = Math.max(0, Math.round(amountPaidCents ?? 0));
  const plan = total - storage;
  if (total <= 0 || plan <= 0) return 0;
  return Math.min(paid, Math.round((paid * plan) / total));
}

/** Unknown, retired and unconfigured prices have no paid entitlement. */
export function getTierFromPrice(priceId: string): SubscriptionTier {
  return tierFromConfiguredPrice(priceId, {
    pro: stripeConfig.priceIds.pro,
    business: stripeConfig.orgPriceIds.businessBase,
  });
}

/** Personal billing cannot grant organization Business entitlements. */
export function getPersonalTierFromPrice(priceId: string): Exclude<SubscriptionTier, 'business'> {
  return getTierFromPrice(priceId) === 'pro' ? 'pro' : 'free';
}

/** A subscription item as the personal item-shape check reads it. */
export interface PersonalSubscriptionItem {
  id: string;
  priceId: string;
  quantity: number;
}

export interface PersonalSubscriptionItems<I extends PersonalSubscriptionItem = PersonalSubscriptionItem> {
  /** The one item carrying the personal plan price. */
  planItem: I;
  /** The storage add-on item, when one exists. */
  storageItem: I | null;
}

/**
 * The verified item shape of a personal subscription: exactly one plan item
 * (quantity 1) plus, optionally, one storage add-on item, every item on one page.
 * Anything else (a stranger price, a second plan item, a truncated list) is null,
 * and the subscription mirrors with no plan identity (fails closed).
 */
export function personalSubscriptionItems<I extends PersonalSubscriptionItem>(
  items: readonly I[],
  hasMore: boolean,
): PersonalSubscriptionItems<I> | null {
  if (hasMore) return null;
  const storage = items.filter((item) => isStorageAddonPrice(item.priceId));
  const plans = items.filter((item) => !isStorageAddonPrice(item.priceId));
  if (plans.length !== 1 || storage.length > 1) return null;
  const [planItem] = plans;
  if (planItem.quantity !== 1) return null;
  const storageItem = storage[0] ?? null;
  if (storageItem && (!Number.isSafeInteger(storageItem.quantity) || storageItem.quantity < 0)) return null;
  return { planItem, storageItem };
}

/** Read Stripe subscription items into the shape check's structural form. */
export function toPersonalSubscriptionItems(items: ReadonlyArray<{ id: string; price: { id: string } | string; quantity?: number | null }>): PersonalSubscriptionItem[] {
  return items.map((item) => ({
    id: item.id,
    priceId: typeof item.price === 'string' ? item.price : item.price.id,
    quantity: item.quantity ?? 1,
  }));
}

/**
 * The plan item of a personal Stripe subscription, and its storage item if any;
 * null when the item collection is not a verified personal shape.
 */
export function personalPlanItems<T extends { id: string; price: { id: string } | string; quantity?: number | null }>(
  items: { data: T[]; has_more: boolean },
): { planItem: T; storageItem: T | null } | null {
  const shape = personalSubscriptionItems(toPersonalSubscriptionItems(items.data), items.has_more);
  if (!shape) return null;
  const planItem = items.data.find((item) => item.id === shape.planItem.id);
  if (!planItem) return null;
  const storageItem = shape.storageItem ? items.data.find((item) => item.id === shape.storageItem?.id) ?? null : null;
  return { planItem, storageItem };
}
