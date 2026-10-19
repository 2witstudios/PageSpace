/**
 * apple-products — the App Store catalog, and the ONLY place its product ids appear
 * (the counterpart of apps/web lib/stripe/price-config.ts). Pure.
 *
 * What iOS sells (owner decisions, iOS IAP discovery 2026-10-19):
 *   - personal Pro, auto-renewing monthly, in the subscription group "PageSpace Plans";
 *   - the three credit packs, as consumables.
 * Business is an organization's plan with seats and stays web-only under App Review
 * guideline 3.1.3(c); storage add-ons and custom top-ups are web-only too.
 *
 * The upcharge: iOS prices are higher so that, after Apple's Small Business Program
 * commission (15%), Apple pays us at least the web price — and the buyer gets exactly
 * what the web price buys. Grants are sized from `webEquivalentCents`, never from the
 * Apple price, so the ratio a Pro subscriber's included credits are sized by (MON-2) is
 * the same on both stores. `appleUsdPriceCents` documents the US price set in App Store
 * Connect; the device shows Apple's localized price, and nothing here charges by it.
 */

import type { SubscriptionTier } from '../subscription-tiers';
import { CREDIT_PACKS, centsFromCredits, creditPackPriceCents, tierListPriceCents } from '../money-model';

/** Apple's Small Business Program commission, in basis points (15%). */
export const APPLE_SMALL_BUSINESS_COMMISSION_BPS = 1500;

/** The App Store Connect subscription group every plan belongs to. */
export const APPLE_SUBSCRIPTION_GROUP = 'PageSpace Plans';

export interface AppleSubscriptionProduct {
  kind: 'subscription';
  productId: string;
  tier: Exclude<SubscriptionTier, 'free' | 'business'>;
  /** What the same plan costs on the web — the figure its monthly grant is sized from. */
  webEquivalentCents: number;
  /** The US App Store price this catalog was priced at. */
  appleUsdPriceCents: number;
}

export interface AppleConsumableProduct {
  kind: 'consumable';
  productId: string;
  /** The web credit pack this product mirrors (money-model CREDIT_PACKS). */
  packId: string;
  credits: number;
  /** Credit value added to the top-up bucket. */
  topupCents: number;
  webEquivalentCents: number;
  appleUsdPriceCents: number;
}

export type AppleProduct = AppleSubscriptionProduct | AppleConsumableProduct;

export const APPLE_PRO_MONTHLY: AppleSubscriptionProduct = {
  kind: 'subscription',
  productId: 'ai.pagespace.ios.pro.monthly',
  tier: 'pro',
  webEquivalentCents: tierListPriceCents('pro'),
  appleUsdPriceCents: 1799,
};

function creditPackProduct(credits: number, packId: string, appleUsdPriceCents: number): AppleConsumableProduct {
  const pack = CREDIT_PACKS[packId];
  return {
    kind: 'consumable',
    productId: `ai.pagespace.ios.credits.${credits}`,
    packId,
    credits: pack.credits,
    topupCents: centsFromCredits(pack.credits),
    webEquivalentCents: creditPackPriceCents(pack),
    appleUsdPriceCents,
  };
}

export const APPLE_PRODUCTS: readonly AppleProduct[] = Object.freeze([
  APPLE_PRO_MONTHLY,
  creditPackProduct(100, 'pack_10', 1199),
  creditPackProduct(250, 'pack_25', 2999),
  creditPackProduct(500, 'pack_50', 5899),
]);

const BY_ID = new Map(APPLE_PRODUCTS.map((p) => [p.productId, p]));

/** The catalog entry for an App Store product id, or undefined for anything we do not sell. */
export function appleProduct(productId: string): AppleProduct | undefined {
  return BY_ID.get(productId);
}

/** Every product id, in catalog order — what the device asks StoreKit to load. */
export function appleProductIds(): string[] {
  return APPLE_PRODUCTS.map((p) => p.productId);
}

/** What Apple pays out on a gross price after `commissionBps`, floored to whole cents. */
export function appleProceedsCents(grossCents: number, commissionBps: number): number {
  if (!Number.isFinite(grossCents) || grossCents <= 0) return 0;
  return Math.floor((grossCents * (10_000 - commissionBps)) / 10_000);
}
