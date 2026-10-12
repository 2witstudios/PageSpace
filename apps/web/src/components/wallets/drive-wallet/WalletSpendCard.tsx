'use client';

import Link from 'next/link';
import type { ConsumerSpendView } from '@pagespace/lib/billing/wallet-views';
import { spendMeterPercent, spendRowDetail, spendRowLabel } from '@pagespace/lib/billing/wallet-surface';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';

/**
 * Spend this month by member and by automation (Spec SPEND-10; canvas v9 DriveWallet): for the drive
 * lead and org admins only — the projection a member gets carries no such list. An automation that ran
 * with no person present is its own row, named by its workflow and the member it runs as ([D-OW-34]),
 * never folded into that member's own spend.
 */
export function WalletSpendCard({ rows, spentCredits }: { rows: ConsumerSpendView[]; spentCredits: string }) {
  const top = Math.max(1, ...rows.map((r) => r.spentCents));
  const people = rows.filter((r) => r.kind === 'member').length;
  const automations = rows.length - people;
  const across = [
    `${people} ${people === 1 ? 'person' : 'people'}`,
    ...(automations > 0 ? [`${automations} ${automations === 1 ? 'automation' : 'automations'}`] : []),
  ].join(' and ');
  return (
    <Card data-testid="wallet-spend-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Spend this month</CardTitle>
          <Link href="/settings/usage" className="text-sm text-primary hover:underline">Full usage</Link>
        </div>
        <CardDescription>
          {spentCredits} credits across {across}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing spent from this wallet yet this month.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => {
              const detail = spendRowDetail(row);
              return (
                <li key={row.consumerKey} data-testid="wallet-spend-row" className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{spendRowLabel(row)}</span>
                    {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
                  </span>
                  <Progress value={spendMeterPercent(row.spentCents, top)} className="hidden w-32 sm:block" aria-hidden="true" />
                  <span className="w-28 text-right tabular-nums">{row.spentCredits} credits</span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
