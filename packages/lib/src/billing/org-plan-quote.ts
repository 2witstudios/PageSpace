/**
 * The org plan's price for a seat count, and the credits it includes (Spec SEAT-2, MON-3, A-8, A-11).
 * Pure and client-safe (no node: imports), so the create-organization dialog and the Plan & seats page
 * quote from the same function the billing path sizes Stripe items and gifted pools with.
 *
 * Read model "price and pool split" (D-OW-38): one source for every price and included-credit figure
 * the org UI shows. Every number comes from the tier table and the money-model module.
 */
import { TIER_PLAN_LIMITS } from './subscription-tiers';
import { MONEY_MODEL_V2_ACTIVE, allowanceCentsForPaidCents, centsFromDollars, tierListPriceCents } from './money-model';

const ORG_TIER = 'business' as const;

/**
 * A-8: the extra-seat item's quantity for `seats` seats — max(0, seats − included),
 * with the included count from the tier table (5 for Business). A seat count that is
 * not a non-negative integer is refused: billing never rounds a guess.
 */
export function orgExtraSeatQuantity(seats: number): number {
  if (!Number.isInteger(seats) || seats < 0) {
    throw new RangeError(`seat count must be a non-negative integer, got ${seats}`);
  }
  return Math.max(0, seats - TIER_PLAN_LIMITS[ORG_TIER].includedSeats);
}

/** The Business list price for the base plus `extraSeats` extra seats, in whole cents. */
export function orgListPriceCents(extraSeats: number): number {
  const seats = Number.isInteger(extraSeats) && extraSeats > 0 ? extraSeats : 0;
  return tierListPriceCents(ORG_TIER) + centsFromDollars(TIER_PLAN_LIMITS[ORG_TIER].extraSeatUsd) * seats;
}

export interface OrgPlanQuote {
  seats: number;
  includedSeats: number;
  extraSeats: number;
  basePriceCents: number;
  extraSeatPriceCents: number;
  extraSeatsCents: number;
  /** What the org pays each month at list price. Real money: format with formatDollars. */
  totalCents: number;
  /** Credit value that price funds the pool with each month. Credits: format with formatCreditCount. */
  includedCreditCents: number;
}

/** The monthly list price and included credits for `seats` seats on the org plan. */
export function orgPlanQuote(seats: number, active: boolean = MONEY_MODEL_V2_ACTIVE): OrgPlanQuote {
  const extraSeats = orgExtraSeatQuantity(seats);
  const totalCents = orgListPriceCents(extraSeats);
  const extraSeatPriceCents = centsFromDollars(TIER_PLAN_LIMITS[ORG_TIER].extraSeatUsd);
  return {
    seats,
    includedSeats: TIER_PLAN_LIMITS[ORG_TIER].includedSeats,
    extraSeats,
    basePriceCents: tierListPriceCents(ORG_TIER),
    extraSeatPriceCents,
    extraSeatsCents: extraSeatPriceCents * extraSeats,
    totalCents,
    includedCreditCents: allowanceCentsForPaidCents(totalCents, ORG_TIER, active),
  };
}
