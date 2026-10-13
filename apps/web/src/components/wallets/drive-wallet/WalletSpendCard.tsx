'use client';

import Link from 'next/link';
import type { ConsumerSpendView } from '@pagespace/lib/billing/wallet-views';
import { spendMeterPercent, spendRowLabel } from '@pagespace/lib/billing/wallet-surface';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';

/**
 * Spend this month by member (Spec SPEND-10, UI-9; canvas v9 DriveWallet): for the drive lead and
 * org admins only — the projection a member gets carries no such list. Automation runs count under
 * the member who created them (D-OW-34), so they are inside that person's row; each row says how
 * much of it was today and how much via automations.
 */
export function WalletSpendCard({ rows, spentCredits }: { rows: ConsumerSpendView[]; spentCredits: string }) {
  const top = Math.max(1, ...rows.map((r) => r.spentCents));
  const people = rows.length;
  return (
    <Card data-testid="wallet-spend-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Spend this month</CardTitle>
          <Link href="/settings/usage" className="text-sm text-primary hover:underline">Full usage</Link>
        </div>
        <CardDescription>
          {spentCredits} credits across {people} {people === 1 ? 'person' : 'people'}. Automation runs count under the member who created them, shown as via automations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing spent from this wallet yet this month.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => (
              <li key={row.consumerKey} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate">{spendRowLabel(row)}</span>
                  <span className="truncate text-xs text-muted-foreground" data-testid="wallet-spend-split">
                    {row.spentTodayCredits} today · {row.viaAutomationsCredits} via automations
                  </span>
                </span>
                <Progress value={spendMeterPercent(row.spentCents, top)} className="hidden w-32 sm:block" aria-hidden="true" />
                <span className="w-28 text-right tabular-nums">{row.spentCredits} credits</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
