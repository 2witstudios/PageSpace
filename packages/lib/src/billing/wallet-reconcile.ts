/**
 * wallet-reconcile — the balance-drift reconciliation, keyed on WALLET (Spec WAL-5): every wallet
 * (a personal root, an org pool, a drive wallet) is checked against its OWN ledger rows, every
 * money-moving entry type counted (grants, purchases, usage, debt, reconcile corrections,
 * donations, top-ups and allocation transfers). The rule is wallet-ledger-core's; this shell only
 * reads. One reader for the web and admin monitoring panels.
 */

import { db } from '@pagespace/db/db';
import { creditLedger } from '@pagespace/db/schema/credits';
import { wallets } from '@pagespace/db/schema/wallets';
import { eq, inArray, sql } from '@pagespace/db/operators';
import { computeWalletDrift, ledgerMovementCents } from './wallet-ledger-core';

/** Which wallet drifted: a person's root, an org's pool, or a drive's wallet. */
export type DriftWalletKind = 'personal_root' | 'org_pool' | 'drive_wallet';

export interface WalletDriftAlert {
  walletId: string;
  kind: DriftWalletKind;
  ownerType: 'user' | 'org';
  /** The person a personal root (or a personal drive's wallet) belongs to; null for an org's. */
  userId: string | null;
  orgId: string | null;
  /** 'drive' for a drive wallet; null for a root (personal root, org pool). */
  subjectType: string | null;
  subjectId: string | null;
  expectedNetCents: number;
  materializedNetCents: number;
  driftCents: number;
  debtCents: number;
}

/**
 * Wallets whose net (monthly + top-up − debt) diverges from what their own ledger rows moved by
 * more than `toleranceCents`, worst first. `walletIds` narrows the check (a test on a shared
 * database); omitted, every wallet is checked.
 */
export async function walletDriftAlerts(input: { toleranceCents: number; limit: number; walletIds?: readonly string[] }): Promise<WalletDriftAlert[]> {
  if (input.walletIds && input.walletIds.length === 0) return [];
  const scope = input.walletIds ? inArray(wallets.id, [...input.walletIds]) : undefined;
  const rows = await db
    .select({
      walletId: wallets.id,
      ownerType: wallets.ownerType,
      userId: wallets.userId,
      orgId: wallets.orgId,
      subjectType: wallets.subjectType,
      subjectId: wallets.subjectId,
      monthlyRemainingCents: wallets.monthlyRemainingCents,
      topupRemainingCents: wallets.topupRemainingCents,
      debtCents: wallets.debtCents,
    })
    .from(wallets)
    .where(scope);
  if (rows.length === 0) return [];

  const totals = await db
    .select({
      walletId: creditLedger.walletId,
      entryType: creditLedger.entryType,
      amountCents: sql<number>`coalesce(sum(${creditLedger.amountCents}), 0)::bigint`,
      appliedCents: sql<number>`coalesce(sum(${creditLedger.appliedCents}), 0)::bigint`,
      appliedOrAmountCents: sql<number>`coalesce(sum(coalesce(${creditLedger.appliedCents}, ${creditLedger.amountCents})), 0)::bigint`,
    })
    .from(creditLedger)
    .innerJoin(wallets, eq(wallets.id, creditLedger.walletId))
    .where(scope)
    .groupBy(creditLedger.walletId, creditLedger.entryType);

  const net = new Map<string, number>();
  for (const t of totals) {
    const moved = ledgerMovementCents({
      entryType: t.entryType,
      amountCents: Number(t.amountCents),
      appliedCents: Number(t.appliedCents),
      appliedOrAmountCents: Number(t.appliedOrAmountCents),
    });
    net.set(t.walletId, (net.get(t.walletId) ?? 0) + moved);
  }

  return rows
    .map((w): WalletDriftAlert | null => {
      const drift = computeWalletDrift({
        ledgerNetCents: net.get(w.walletId) ?? 0,
        monthlyRemainingCents: w.monthlyRemainingCents,
        topupRemainingCents: w.topupRemainingCents,
        debtCents: w.debtCents,
      }, input.toleranceCents);
      if (!drift.flagged) return null;
      return {
        walletId: w.walletId,
        kind: w.subjectType !== null ? 'drive_wallet' : w.ownerType === 'org' ? 'org_pool' : 'personal_root',
        ownerType: w.ownerType,
        userId: w.userId,
        orgId: w.orgId,
        subjectType: w.subjectType,
        subjectId: w.subjectId,
        expectedNetCents: drift.expectedNetCents,
        materializedNetCents: drift.materializedNetCents,
        driftCents: drift.driftCents,
        debtCents: w.debtCents,
      };
    })
    .filter((r): r is WalletDriftAlert => r !== null)
    .sort((a, b) => Math.abs(b.driftCents) - Math.abs(a.driftCents))
    .slice(0, input.limit);
}
