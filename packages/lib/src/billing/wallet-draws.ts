/**
 * wallet-draws — the per-call record of what a charge on a DRIVE (child) wallet drew, and
 * the pure plan for reversing it (D-OW-13). Pure: no I/O.
 *
 * A charge on a child wallet draws, in order: its allocation from the parent, then its
 * funding legs FIFO, then (uncovered) lands as debt where the funder chose (D20.2: the
 * parent). The settle stores exactly that in `ai_usage_logs.metadata.walletDraws`, so a
 * cost-reconcile refund can return the cents to where they came from, in the inverse
 * order — landed debt first, then the legs newest-drawn first (each at most what THIS call
 * took from it), then the allocation. That is what keeps a donor's leg from being credited
 * with money it never gave, and wallets.topupRemainingCents equal to SUM(legs).
 *
 * The record lives in a jsonb column, so it is UNTRUSTED input: {@link parseWalletDraws}
 * accepts it only when every field has the right type, it names this wallet, and its parts
 * add up to its total. Anything else is `null`, and the caller takes the legacy path (the
 * whole refund to the parent, debt first, legs untouched) — never a guessed leg.
 */

export interface WalletDraws {
  walletId: string;
  /** Whole cents the call(s) charged to this wallet: allocation + legs + debt. */
  totalCents: number;
  /** Drawn from the parent as allocation (the wallet's spentCents rose by this). */
  allocationCents: number;
  /** Drawn from each funding leg, in draw order (oldest leg first). */
  legs: { legId: string; cents: number }[];
  /** Uncovered, landed as debt on `debtWalletId`. */
  debtCents: number;
  debtWalletId: string | null;
}

export type WalletDrawsParse =
  | { ok: true; draws: WalletDraws }
  | { ok: false; reason: 'absent' | 'malformed' | 'other_wallet' | 'sums_disagree' };

const isWholeNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Validate the stored record for `walletId`. Never throws. */
export function parseWalletDraws(metadata: unknown, walletId: string): WalletDrawsParse {
  if (typeof metadata !== 'object' || metadata === null) return { ok: false, reason: 'absent' };
  const raw = (metadata as Record<string, unknown>).walletDraws;
  if (raw === undefined || raw === null) return { ok: false, reason: 'absent' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'malformed' };
  const r = raw as Record<string, unknown>;
  if (typeof r.walletId !== 'string') return { ok: false, reason: 'malformed' };
  if (r.walletId !== walletId) return { ok: false, reason: 'other_wallet' };
  if (!isWholeNonNegative(r.totalCents) || !isWholeNonNegative(r.allocationCents) || !isWholeNonNegative(r.debtCents)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!(r.debtWalletId === null || typeof r.debtWalletId === 'string')) return { ok: false, reason: 'malformed' };
  if (r.debtCents > 0 && typeof r.debtWalletId !== 'string') return { ok: false, reason: 'malformed' };
  if (!Array.isArray(r.legs)) return { ok: false, reason: 'malformed' };
  const legs: { legId: string; cents: number }[] = [];
  for (const leg of r.legs) {
    if (typeof leg !== 'object' || leg === null) return { ok: false, reason: 'malformed' };
    const l = leg as Record<string, unknown>;
    if (typeof l.legId !== 'string' || l.legId.length === 0 || !isWholeNonNegative(l.cents)) return { ok: false, reason: 'malformed' };
    legs.push({ legId: l.legId, cents: l.cents });
  }
  const legsTotal = legs.reduce((sum, l) => sum + l.cents, 0);
  if (r.allocationCents + legsTotal + r.debtCents !== r.totalCents) return { ok: false, reason: 'sums_disagree' };
  return {
    ok: true,
    draws: {
      walletId,
      totalCents: r.totalCents,
      allocationCents: r.allocationCents,
      legs,
      debtCents: r.debtCents,
      debtWalletId: r.debtWalletId as string | null,
    },
  };
}

/** Add one charge's draws to a wallet's record (a settle, then an undercharge correction). */
export function addWalletDraws(prior: WalletDraws | null, add: Omit<WalletDraws, 'totalCents'>): WalletDraws {
  const base: WalletDraws = prior ?? { walletId: add.walletId, totalCents: 0, allocationCents: 0, legs: [], debtCents: 0, debtWalletId: null };
  const legs = base.legs.map((l) => ({ ...l }));
  for (const draw of add.legs) {
    if (draw.cents <= 0) continue;
    const same = legs.find((l) => l.legId === draw.legId);
    if (same) same.cents += draw.cents;
    else legs.push({ legId: draw.legId, cents: draw.cents });
  }
  const allocationCents = base.allocationCents + add.allocationCents;
  const debtCents = base.debtCents + add.debtCents;
  return {
    walletId: base.walletId,
    allocationCents,
    legs,
    debtCents,
    debtWalletId: add.debtCents > 0 ? add.debtWalletId : base.debtWalletId,
    totalCents: allocationCents + debtCents + legs.reduce((sum, l) => sum + l.cents, 0),
  };
}

export interface WalletRefundPlan {
  /** Back onto the landed debt (`debtWalletId`), first. */
  debtCents: number;
  debtWalletId: string | null;
  /** Back to each leg, newest-drawn first; each at most what the record says it gave. */
  legCredits: { legId: string; cents: number }[];
  /** Back to the parent as allocation: the wallet's spentCents falls by this. */
  allocationCents: number;
  /** The record after the refund, so a later correction cannot return the same cents again. */
  remaining: WalletDraws;
}

/**
 * Reverse `refundCents` of a recorded charge, in the inverse order of the draw. `null`
 * when the refund is more than the record says was charged (the record and the correction
 * disagree): the caller then takes the legacy path rather than guess.
 */
export function planWalletRefund(draws: WalletDraws, refundCents: number): WalletRefundPlan | null {
  if (!Number.isInteger(refundCents) || refundCents < 0 || refundCents > draws.totalCents) return null;
  let rest = refundCents;

  const debtCents = Math.min(rest, draws.debtCents);
  rest -= debtCents;

  const legCredits: { legId: string; cents: number }[] = [];
  for (const leg of [...draws.legs].reverse()) {
    if (rest === 0) break;
    const cents = Math.min(rest, leg.cents);
    if (cents > 0) legCredits.push({ legId: leg.legId, cents });
    rest -= cents;
  }

  const allocationCents = Math.min(rest, draws.allocationCents);
  rest -= allocationCents;

  const legs = draws.legs.map((l) => ({ ...l, cents: l.cents - (legCredits.find((c) => c.legId === l.legId)?.cents ?? 0) }));
  return {
    debtCents,
    debtWalletId: draws.debtWalletId,
    legCredits,
    allocationCents,
    remaining: {
      ...draws,
      totalCents: draws.totalCents - refundCents,
      debtCents: draws.debtCents - debtCents,
      allocationCents: draws.allocationCents - allocationCents,
      legs,
    },
  };
}
