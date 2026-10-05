'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { DriveWalletView, LeadWalletView, OrgAdminWalletView } from '@pagespace/lib/billing/wallet-views';
import { fundedByCopy, spendMeterPercent, walletPeriodCopy, walletStatusCopy, type DriveWalletPanels } from '@pagespace/lib/billing/wallet-surface';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { patch, post } from '@/lib/auth/auth-fetch';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { CreditAmountField } from './CreditAmountField';
import { WalletStatusBadge } from './WalletStatusBadge';

interface WalletBalanceCardProps {
  driveId: string;
  driveName: string;
  orgName: string | null;
  wallet: DriveWalletView;
  panels: DriveWalletPanels;
  onChanged: () => Promise<unknown>;
}

const isFunderView = (w: DriveWalletView): w is LeadWalletView | OrgAdminWalletView => 'allocationCents' in w;

/**
 * The wallet card of Drive Settings › Wallet (Spec UI-9, WAL-3, WAL-7; canvas v9 DriveWallet):
 * remaining amount and status for everyone; allocation, period, top-up and the pause switch for
 * whoever runs it; the org pool for org admins. A member sees only what their projection carries.
 */
export function WalletBalanceCard({ driveId, driveName, orgName, wallet, panels, onChanged }: WalletBalanceCardProps) {
  const [pausing, setPausing] = useState(false);
  const status = walletStatusCopy(wallet.status);
  const funder = isFunderView(wallet) ? wallet : null;
  const period = funder ? walletPeriodCopy(funder.periodStart, funder.periodEnd) : { range: null, resets: null };
  const funded = fundedByCopy({ orgName, viewerIsFunder: wallet.viewer === 'lead' && orgName === null });

  const write = async (run: () => Promise<unknown>, failure: string, success?: string) => {
    try {
      await run();
      if (success) toast.success(success);
      await onChanged();
    } catch (error) {
      toast.error(orgErrorMessage(error, failure));
      throw error;
    }
  };

  const setPaused = async (paused: boolean) => {
    setPausing(true);
    try {
      await write(() => patch(`/api/drives/${driveId}/wallet`, { paused }), 'The wallet could not be changed. Try again.', paused ? 'Spending from this wallet is paused' : 'Spending from this wallet resumed');
    } catch {
      // The toast already said why.
    } finally {
      setPausing(false);
    }
  };

  const descParts = [funded, funder ? `${funder.allocationCredits} credits allocated each month` : null, period.resets].filter(Boolean);

  return (
    <Card data-testid="wallet-balance-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{driveName} wallet</CardTitle>
          <WalletStatusBadge status={wallet.status} />
        </div>
        <CardDescription>{descParts.join(' · ')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {funder ? (
          <>
            <Progress value={spendMeterPercent(funder.spentCents, funder.allocationCents)} aria-label="Allocation spent" />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
              <span>
                {funder.spentCredits} credits spent · {wallet.remainingCredits} credits left
                {funder.debtCents > 0 && ` · over by ${funder.debtCredits} credits`}
              </span>
              {period.range && <span>{period.range}</span>}
            </div>
          </>
        ) : (
          <p className="text-sm">
            <span className="text-2xl font-semibold tabular-nums">{wallet.remainingCredits}</span>{' '}
            <span className="text-muted-foreground">credits left in this wallet</span>
          </p>
        )}

        {panels.myCap && <MyCapLine wallet={wallet} />}

        {panels.pool && wallet.viewer === 'org_admin' && wallet.pool && (
          <p className="text-xs text-muted-foreground tabular-nums" data-testid="wallet-pool-line">
            Org pool: {wallet.pool.availableCredits} credits available · {wallet.pool.unallocatedCredits} not yet allocated
          </p>
        )}

        {funder && (
          <div className="grid gap-4 sm:grid-cols-2">
            {panels.editAllocation ? (
              <CreditAmountField
                editingId={`drive-wallet-allocation-${driveId}`}
                label="Monthly allocation"
                hint={orgName ? 'Set by the org Owner or an Admin from the org pool.' : 'Drawn from your credits each month.'}
                initialCredits={funder.allocationCredits}
                actionLabel="Save"
                onSubmit={(cents) => write(() => patch(`/api/drives/${driveId}/wallet`, { allocationCents: cents }), 'The allocation could not be saved.', 'Allocation saved')}
              />
            ) : (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Monthly allocation</span>
                <span className="text-sm tabular-nums">{funder.allocationCredits} credits</span>
                <span className="text-xs text-muted-foreground">Set by the {orgName ?? 'organization'} Owner or an Admin from the org pool.</span>
              </div>
            )}
            {panels.topUp && (
              <CreditAmountField
                editingId={`drive-wallet-topup-${driveId}`}
                label="One-off top-up"
                hint={`Lasts until spent. From ${orgName ? 'the org pool' : 'your credits'}.`}
                actionLabel="Add"
                min={1}
                onSubmit={(cents) =>
                  write(
                    () => post(`/api/drives/${driveId}/wallet/top-up`, { amountCents: cents, idempotencyKey: crypto.randomUUID() }),
                    'The top-up could not be made.',
                    'Credits added to this wallet',
                  )
                }
              />
            )}
          </div>
        )}

        {panels.pause && (
          <>
            <Separator />
            <div className="flex items-start gap-3">
              <Switch
                id={`pause-${driveId}`}
                checked={wallet.status === 'paused'}
                disabled={pausing}
                onCheckedChange={(checked) => void setPaused(checked)}
                aria-label="Pause spending"
              />
              <div className="flex flex-col gap-0.5">
                <label htmlFor={`pause-${driveId}`} className="text-sm font-medium">Pause spending</label>
                <span className="text-xs text-muted-foreground">
                  Stops all spending from this wallet right away. While it is paused, each call moves to the next source under the fallback rule, or is refused.
                </span>
              </div>
            </div>
          </>
        )}

        <p className="text-xs text-muted-foreground">{status.hint}</p>
      </CardContent>
    </Card>
  );
}

function MyCapLine({ wallet }: { wallet: DriveWalletView }) {
  const { dailyRemainingCredits, monthlyRemainingCredits } = wallet.myCap;
  if (dailyRemainingCredits === null && monthlyRemainingCredits === null) {
    return <p className="text-xs text-muted-foreground">You have no cap on this wallet.</p>;
  }
  const parts = [
    dailyRemainingCredits !== null ? `${dailyRemainingCredits} credits left today` : null,
    monthlyRemainingCredits !== null ? `${monthlyRemainingCredits} credits left this month` : null,
  ].filter(Boolean);
  return <p className="text-xs text-muted-foreground tabular-nums" data-testid="wallet-my-cap">Your cap here: {parts.join(' · ')}</p>;
}
