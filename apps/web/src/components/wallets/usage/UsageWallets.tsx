'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Building2, Folder, HandCoins, Sparkles } from 'lucide-react';
import { spendFromRowCopy, spendMeterPercent } from '@pagespace/lib/billing/wallet-surface';
import type { WalletStatus } from '@pagespace/lib/billing/wallet-core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { put } from '@/lib/auth/auth-fetch';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { useCreditBalance } from '@/hooks/useCreditBalance';
import { useDriveStore } from '@/hooks/useDrive';
import { useMyOrganizations } from '@/hooks/useMyOrganizations';
import { useMyWallets, type MyWallets } from '@/hooks/useMyWallets';
import { formatCreditCount } from '@/lib/subscription/credits';
import { cn } from '@/lib/utils';
import { WalletStatusBadge } from '../drive-wallet/WalletStatusBadge';

/**
 * The body of Settings › Usage › Wallets (Spec UI-10; canvas v9 UsageWallets). Each row carries
 * only what the route answers this person: drive wallets and seats as their own remaining amount
 * (SPEND-9), pools they administer with the pool balance (SPEND-10), never another person's spend.
 */
export function UsageWallets() {
  const { wallets, isLoading, refresh } = useMyWallets(true);
  if (isLoading || !wallets) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <SpendFromSection wallets={wallets} />
      <FundSection wallets={wallets} />
      <DefaultSourceCard current={wallets.personal.defaultSpendSource} onChanged={refresh} />
    </div>
  );
}

function Row({ icon, title, detail, amount, meter, badge, href, testId }: {
  icon: React.ReactNode;
  title: string;
  detail: React.ReactNode;
  amount: string;
  meter?: number;
  badge?: React.ReactNode;
  href?: string;
  testId?: string;
}) {
  const body = (
    <div className="flex items-center gap-3 px-4 py-3.5" data-testid={testId}>
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </div>
      {meter !== undefined && <Progress value={meter} className="hidden w-24 md:block" aria-hidden="true" />}
      <span className="whitespace-nowrap text-sm font-medium tabular-nums">{amount}</span>
      <span className="hidden w-24 justify-end sm:flex">{badge}</span>
    </div>
  );
  return href ? <Link href={href} className="block hover:bg-accent/50">{body}</Link> : body;
}

function SpendFromSection({ wallets }: { wallets: MyWallets }) {
  const { balance } = useCreditBalance();
  const { orgById } = useMyOrganizations();
  const drives = useDriveStore((state) => state.drives);
  const fundedByMe = new Set(wallets.funds.driveWallets.map((w) => w.walletId));
  const orgNameOfDrive = (driveId: string) => orgById(drives.find((d) => d.id === driveId)?.orgId)?.name ?? null;
  const renews = balance?.monthly.periodEnd ? new Date(balance.monthly.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  const plan = balance?.subscriptionTier ? `${balance.subscriptionTier.charAt(0).toUpperCase()}${balance.subscriptionTier.slice(1)} plan` : null;
  const personalDetail = ['Personal balance', plan, balance && balance.monthly.allowance > 0 && renews ? `${formatCreditCount(balance.monthly.allowance)} credits included on ${renews}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-medium text-muted-foreground">You spend from</h2>
      <div className="divide-y overflow-hidden rounded-lg border bg-card">
        <Row
          testId="usage-wallet-personal"
          icon={<Sparkles className="h-4 w-4" />}
          title="My credits"
          detail={personalDetail}
          amount={`${wallets.personal.remainingCredits} credits`}
          badge={<Badge variant="secondary">Personal</Badge>}
        />
        {wallets.seats.map((seat) => (
          <Row
            key={seat.walletId}
            testId="usage-wallet-seat"
            icon={<Building2 className="h-4 w-4" />}
            title={`Seat allowance · ${seat.orgName ?? 'Organization'}`}
            detail={`${seat.allowanceCredits} credits a month inside org drives · ${seat.spentCredits} credits spent`}
            amount={`${seat.remainingCredits} credits left`}
            meter={spendMeterPercent(seat.spentCents, seat.allowanceCents)}
            badge={<Badge variant="outline">Allowance</Badge>}
          />
        ))}
        {wallets.driveWallets.map((w) => (
          <Row
            key={w.walletId}
            testId="usage-wallet-drive"
            icon={<Folder className="h-4 w-4" />}
            title={`${w.driveName ?? 'Drive'} wallet`}
            detail={spendFromRowCopy({ status: w.status as WalletStatus, orgName: orgNameOfDrive(w.driveId), fundedByMe: fundedByMe.has(w.walletId) })}
            amount={`${w.remainingCredits} credits left`}
            badge={w.status === 'active' ? <Badge variant="outline">Drive wallet</Badge> : <WalletStatusBadge status={w.status as WalletStatus} />}
            href={`/dashboard/${w.driveId}/settings/wallet`}
          />
        ))}
      </div>
    </section>
  );
}

function FundSection({ wallets }: { wallets: MyWallets }) {
  const drives = useDriveStore((state) => state.drives);
  const funded = new Set(wallets.funds.driveWallets.map((w) => w.driveId));
  // A personal drive you own can be funded from your credits (WAL-2); its wallet page creates it.
  const fundable = drives.filter((d) => d.isOwned && !d.orgId && !d.isTrashed && !funded.has(d.id));
  const { funds } = wallets;
  const empty = funds.driveWallets.length === 0 && funds.pools.length === 0 && funds.donations.length === 0;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="text-sm font-medium text-muted-foreground">You fund</h2>
        {fundable.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">Fund a drive</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Drives you own</DropdownMenuLabel>
              {fundable.map((d) => (
                <DropdownMenuItem key={d.id} asChild>
                  <Link href={`/dashboard/${d.id}/settings/wallet`}>{d.name}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="divide-y overflow-hidden rounded-lg border bg-card">
        {funds.pools.map((p) => (
          <Row
            key={p.walletId}
            testId="usage-fund-pool"
            icon={<Building2 className="h-4 w-4" />}
            title={`${p.orgName ?? 'Organization'} pool`}
            detail={`${p.unallocatedCredits} credits not yet allocated to drives`}
            amount={`${p.availableCredits} credits`}
            badge={<Badge variant="outline">Pool</Badge>}
          />
        ))}
        {funds.driveWallets.map((w) => (
          <Row
            key={w.walletId}
            testId="usage-fund-drive"
            icon={<Folder className="h-4 w-4" />}
            title={`${w.driveName ?? 'Drive'} wallet`}
            detail="From your credits · set member caps and see spend in the drive's Wallet settings"
            amount={`${w.remainingCredits} credits left`}
            badge={w.status === 'active' ? <Badge variant="outline">Drive wallet</Badge> : <WalletStatusBadge status={w.status as WalletStatus} />}
            href={`/dashboard/${w.driveId}/settings/wallet`}
          />
        ))}
        {funds.donations.map((d) => (
          <Row
            key={`${d.walletId}-${d.createdAt}`}
            testId="usage-fund-donation"
            icon={<HandCoins className="h-4 w-4" />}
            title={`Donated to ${d.driveName ?? 'a drive'}`}
            detail={`${d.originalCredits} credits on ${new Date(d.createdAt).toLocaleDateString()}`}
            amount={`${d.remainingCredits} credits unspent`}
            badge={<Badge variant="outline">Donation</Badge>}
          />
        ))}
        <p className={cn('px-4 py-3.5 text-xs text-muted-foreground', empty && 'py-5')}>
          Funding a drive you own gives its members a shared wallet instead of spending their own credits. The allocation comes out of your balance each month. As the funder you set member caps in the drive&apos;s Wallet settings and get the 80% and 100% cap alerts.
        </p>
      </div>
    </section>
  );
}

function DefaultSourceCard({ current, onChanged }: { current: MyWallets['personal']['defaultSpendSource']; onChanged: () => Promise<unknown> }) {
  const [pending, setPending] = useState(false);
  const choose = async (source: 'drive_wallet' | 'own_credits') => {
    if (source === current || pending) return;
    setPending(true);
    try {
      await put('/api/wallets/default', { source });
      await onChanged();
    } catch (error) {
      toast.error(orgErrorMessage(error, 'Your default could not be saved. Try again.'));
    } finally {
      setPending(false);
    }
  };
  const options = [
    { value: 'drive_wallet' as const, label: "The drive's wallet, if it has one", hint: "Then your allowance, then your own credits, following each drive's fallback rule." },
    { value: 'own_credits' as const, label: 'Always my own credits', hint: 'Never spend a wallet or an allowance unless you switch for that conversation.' },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Default when you open a drive</CardTitle>
        <CardDescription>You always see the source before you send. This only decides what is preselected.</CardDescription>
      </CardHeader>
      <CardContent>
        <div role="radiogroup" aria-label="Default source" className="flex flex-col gap-2">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={current === o.value}
              disabled={pending}
              onClick={() => void choose(o.value)}
              className={cn('flex flex-col gap-0.5 rounded-lg border px-3.5 py-3 text-left transition-colors', current === o.value ? 'border-primary bg-primary/10' : 'hover:bg-accent')}
            >
              <span className="text-sm font-medium">{o.label}</span>
              <span className="text-xs text-muted-foreground">{o.hint}</span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
