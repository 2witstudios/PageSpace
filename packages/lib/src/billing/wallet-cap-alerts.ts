/**
 * wallet-cap-alerts — the imperative shell that tells a wallet leg's FUNDER that a consumer
 * reached 80% or 100% of their per-consumer cap on it (Spec WAL-7, D20.6), in-app.
 *
 * Exactly once per threshold, cap window and period: the alert's row in wallet_cap_alerts (its
 * primary key is that tuple) is inserted ON CONFLICT DO NOTHING, and the notifications are
 * written in the same transaction only when the insert landed — so two settles racing past a
 * threshold send it once, and a threshold already sent this period is never sent again.
 *
 * Legs with a cap: a drive wallet (the consumer's wallet_consumer_caps row; UTC day and UTC
 * month) and a seat on the org pool (the seat allowance as its monthly cap over the pool
 * period, D-OW-12, and the consumer's daily cap if set). A personal root has no consumer but
 * its owner: no alert. Who funds a leg comes from the permissions module (walletFunderUserIds):
 * the org's Owner and Admins for an org-owned wallet, the person for their own.
 *
 * Runs AFTER the settle committed, never inside it. Never throws.
 */
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { notifications } from '@pagespace/db/schema/notifications';
import { organizations } from '@pagespace/db/schema/organizations';
import { walletCapAlerts, wallets } from '@pagespace/db/schema/wallets';
import { loggers } from '../logging/logger-config';
import { walletFunderUserIds } from '../permissions/wallet-funders';
import { readOrgSpendPolicy } from '../organizations/policy-reader';
import { capAlertCopy, capAlertsDue, type CapWindowSpend } from './cap-alerts-core';
import { consumerSettledCents, readConsumerCaps } from './consumer-caps';
import { loadSeatCapFacts } from './seat-allowance';
import { seatPeriodStartMs, seatSpentCents, userConsumerKey, utcDayStartMs, utcMonthStartMs, type CapWindow } from './wallet-core';

const ALERT_WALLET = {
  id: wallets.id,
  ownerType: wallets.ownerType,
  userId: wallets.userId,
  orgId: wallets.orgId,
  subjectType: wallets.subjectType,
  subjectId: wallets.subjectId,
  parentWalletId: wallets.parentWalletId,
  monthlyPeriodStart: wallets.monthlyPeriodStart,
} as const;

interface LegWindows {
  windows: (CapWindowSpend & { periodStart: Date })[];
  placeName: string;
  driveId: string | null;
}

async function driveLegWindows(wallet: { id: string; subjectId: string | null }, userId: string, now: Date): Promise<LegWindows | null> {
  const caps = await readConsumerCaps(db, wallet.id, userId);
  if (!caps) return null;
  const dayStart = new Date(utcDayStartMs(now.getTime()));
  const monthStart = new Date(utcMonthStartMs(now.getTime()));
  const spent = await consumerSettledCents(db, { walletId: wallet.id, userId, dayStart, monthStart });
  const [drive] = wallet.subjectId
    ? await db.select({ name: drives.name }).from(drives).where(eq(drives.id, wallet.subjectId))
    : [];
  return {
    windows: [
      { window: 'daily', capCents: caps.dailyCents, spentCents: spent.dailyCents, periodStart: dayStart },
      { window: 'monthly', capCents: caps.monthlyCents, spentCents: spent.monthlyCents, periodStart: monthStart },
    ],
    placeName: drive?.name ?? 'a drive',
    driveId: wallet.subjectId,
  };
}

async function seatLegWindows(pool: { id: string; orgId: string; monthlyPeriodStart: Date | null }, userId: string, now: Date): Promise<LegWindows> {
  const policy = await readOrgSpendPolicy(db, pool.orgId);
  const seat = await loadSeatCapFacts(db, { poolId: pool.id, poolPeriodStart: pool.monthlyPeriodStart, userId, policySeatAllowanceCents: policy.seatAllowanceCents, now });
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, pool.orgId));
  return {
    windows: [
      { window: 'daily', capCents: seat.dailyCapCents, spentCents: seatSpentCents(seat.windows.day.grossMillicents), periodStart: new Date(utcDayStartMs(now.getTime())) },
      {
        window: 'monthly',
        capCents: seat.capCents,
        spentCents: seatSpentCents(seat.windows.period.grossMillicents),
        periodStart: new Date(seatPeriodStartMs({ poolPeriodStartMs: pool.monthlyPeriodStart?.getTime() ?? null, nowMs: now.getTime() })),
      },
    ],
    placeName: org?.name ?? 'your organization',
    driveId: null,
  };
}

/** Send every due, not-yet-sent cap alert for `userId`'s spend on `walletId`. Returns how many were sent. */
export async function notifyCapAlerts(input: { walletId: string; userId: string; now?: Date }): Promise<number> {
  const now = input.now ?? new Date();
  try {
    const [wallet] = await db.select(ALERT_WALLET).from(wallets).where(eq(wallets.id, input.walletId));
    if (!wallet) return 0;
    const isPool = wallet.ownerType === 'org' && wallet.parentWalletId === null && wallet.subjectType === null && wallet.orgId !== null;
    const leg = wallet.parentWalletId !== null
      ? await driveLegWindows(wallet, input.userId, now)
      : isPool
        ? await seatLegWindows({ id: wallet.id, orgId: wallet.orgId as string, monthlyPeriodStart: wallet.monthlyPeriodStart }, input.userId, now)
        : null;
    if (!leg) return 0;
    const due = capAlertsDue(leg.windows);
    if (due.length === 0) return 0;

    const recipients = await walletFunderUserIds(db, wallet);
    if (recipients.length === 0) return 0;
    const [consumerRow] = await db.select({ name: users.name }).from(users).where(eq(users.id, input.userId));
    // Loaded on use, never at module load: this module sits in credit-consume's static import graph,
    // which a client hook reaches through monitoring/ai-monitoring, and the field-crypto it brings
    // (promisify(scrypt)) throws when evaluated in a browser bundle (#2763 E2E).
    const { decryptUserRow } = await import('../auth/user-repository');
    const consumer = consumerRow ? await decryptUserRow(consumerRow) : undefined;
    const byWindow = new Map<CapWindow, CapWindowSpend & { periodStart: Date }>(leg.windows.map((w) => [w.window, w]));

    let sent = 0;
    for (const alert of due) {
      const window = byWindow.get(alert.window);
      if (!window || window.capCents === null) continue;
      const wrote = await db.transaction(async (tx) => {
        const claimed = await tx
          .insert(walletCapAlerts)
          .values({ walletId: wallet.id, consumerKey: userConsumerKey(input.userId), capWindow: alert.window, periodStart: window.periodStart, threshold: alert.threshold })
          .onConflictDoNothing()
          .returning({ walletId: walletCapAlerts.walletId });
        if (claimed.length === 0) return false;
        const copy = capAlertCopy({
          threshold: alert.threshold,
          window: alert.window,
          consumerName: consumer?.name ?? 'Someone',
          placeName: leg.placeName,
          spentCents: window.spentCents,
          capCents: window.capCents as number,
        });
        await tx.insert(notifications).values(recipients.map((userId) => ({
          userId,
          type: 'WALLET_CAP_ALERT' as const,
          title: copy.title,
          message: copy.message,
          driveId: leg.driveId,
          metadata: { walletId: wallet.id, consumerId: input.userId, window: alert.window, threshold: alert.threshold },
        })));
        return true;
      });
      if (wrote) sent += 1;
    }
    return sent;
  } catch (error) {
    loggers.ai.error('wallet cap alert failed', error instanceof Error ? error : undefined, { walletId: input.walletId, userId: input.userId });
    return 0;
  }
}
