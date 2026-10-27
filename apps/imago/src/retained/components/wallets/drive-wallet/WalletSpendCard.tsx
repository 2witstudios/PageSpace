'use client';

import Link from '@/retained-adapters/link';
import type { ConsumerSpendView } from '@pagespace/lib/billing/wallet-views';
import { spendMeterPercent, spendRowDetail, spendRowLabel } from '@pagespace/lib/billing/wallet-surface';
import { SettingsSection } from '@/ui/settings/settings-screen/settings-screen';
import { Progress } from '@/retained/components/ui/progress';

/**
 * Spend this month by member (Spec UI-9, SPEND-10; canvas v9 DriveWallet): for the drive lead and
 * org admins only — the projection a member gets carries no such list. D-OW-67: one row per person
 * from the one ledger read model; automation runs count under the member who created them (D-OW-34),
 * so they are inside that person's row, said as "via automations" and listed beneath it by workflow,
 * never counted twice.
 */
export function WalletSpendCard({ rows, spentCredits }: { rows: ConsumerSpendView[]; spentCredits: string }) {
  const top = Math.max(1, ...rows.map((r) => r.spentCents));
  const people = rows.length;
  const automations = rows.reduce((n, r) => n + r.automations.length, 0);
  const across = [
    `${people} ${people === 1 ? 'person' : 'people'}`,
    ...(automations > 0 ? [`${automations} ${automations === 1 ? 'automation' : 'automations'}`] : []),
  ].join(' and ');
  return (
    <SettingsSection
      title="Spend this month"
      description={`${spentCredits} credits across ${across}. Automation runs count under the member who created them, shown as via automations.`}
      actions={<Link href="/settings/usage" className="text-sm text-accent-deep hover:underline">Full usage</Link>}
    >
      <div data-testid="wallet-spend-card">
        {rows.length === 0 ? (
          <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">Nothing spent from this wallet yet this month.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {rows.map((row) => (
              <li key={row.consumerKey} data-testid="wallet-spend-row" className="px-4 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate">{spendRowLabel({ kind: 'member', displayName: row.displayName })}</span>
                    <span className="truncate text-xs text-muted-foreground" data-testid="wallet-spend-split">
                      {row.spentTodayCredits} today · {row.viaAutomationsCredits} via automations
                    </span>
                  </span>
                  <Progress value={spendMeterPercent(row.spentCents, top)} className="hidden w-32 sm:block" aria-hidden="true" />
                  <span className="w-28 text-right tabular-nums">{row.spentCredits} credits</span>
                </div>
                {row.automations.length > 0 && (
                  <ul className="mt-2 space-y-1.5 border-l pl-3">
                    {row.automations.map((a) => (
                      <li key={a.consumerKey} data-testid="wallet-spend-automation-row" className="flex items-center gap-3 text-xs">
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{spendRowLabel({ kind: 'automation', displayName: a.displayName })}</span>
                          <span className="truncate text-muted-foreground">{spendRowDetail({ kind: 'automation', creatorName: a.creatorName })}</span>
                        </span>
                        <span className="w-28 text-right tabular-nums">{a.spentCredits} credits</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
