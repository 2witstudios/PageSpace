'use client';

import { useEffect, useState } from 'react';
import Link from '@/retained-adapters/link';
import { toast } from 'sonner';
import { Building2, Coins, Folder, HandCoins } from 'lucide-react';
import { spendFromRowCopy, spendMeterPercent } from '@pagespace/lib/billing/wallet-surface';
import { effectiveDefaultSpendSource } from '@pagespace/lib/billing/spend-target';
import { isHomeDrive } from '@pagespace/lib/services/drive-guards';
import { Badge } from '@/retained/components/ui/badge';
import { Button } from '@/retained/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/retained/components/ui/dropdown-menu';
import { Progress } from '@/retained/components/ui/progress';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { Switch } from '@/retained/components/ui/switch';
import { fetchWithAuth, put } from '@/retained/lib/auth/auth-fetch';
import { orgErrorMessage } from '@/retained/lib/orgs/org-error-copy';
import { useCreditBalance } from '@/retained/hooks/useCreditBalance';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useMyOrganizations } from '@/retained/hooks/useMyOrganizations';
import { useMyWallets, type MyWallets } from '@/retained/hooks/useMyWallets';
import { formatCreditCount } from '@/retained/lib/subscription/credits';
import { cn } from '@/retained/lib/utils';
import { SettingsGroup, SettingsRow, SettingsSection } from '@/ui/settings/settings-screen/settings-screen';
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
      <>
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </>
    );
  }
  return (
    <>
      <SpendFromSection wallets={wallets} />
      <FundSection wallets={wallets} />
      <DefaultSourceSection stored={wallets.personal.defaultSpendSource} onChanged={refresh} />
      <AbsoluteOwnCreditsSection drives={wallets.driveWallets} onChanged={refresh} />
    </>
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
    <div className="flex items-center gap-3 px-4 py-3" data-testid={testId}>
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </div>
      {meter !== undefined && <Progress value={meter} className="hidden w-24 md:block" aria-hidden="true" />}
      <span className="whitespace-nowrap text-sm font-medium tabular-nums text-foreground">{amount}</span>
      <span className="hidden w-24 justify-end sm:flex">{badge}</span>
    </div>
  );
  return href ? <Link href={href} className="block first:rounded-t-xl last:rounded-b-xl hover:bg-accent/50">{body}</Link> : body;
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
    <SettingsSection title="You spend from" description="Every source your AI usage can draw on, and what is left in each.">
      <SettingsGroup label="You spend from">
        <Row
          testId="usage-wallet-personal"
          icon={<Coins className="h-4 w-4" />}
          title="My credits"
          detail={personalDetail}
          amount={`${wallets.personal.remainingCredits} credits`}
          badge={<Badge variant="secondary">Personal</Badge>}
          href="/settings/usage"
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
            detail={`${spendFromRowCopy({ status: w.status, orgName: orgNameOfDrive(w.driveId), fundedByMe: fundedByMe.has(w.walletId) })} · You spent ${w.mySpentCredits} credits this month`}
            amount={`${w.remainingCredits} credits left`}
            badge={w.status === 'active' ? <Badge variant="outline">Drive wallet</Badge> : <WalletStatusBadge status={w.status} />}
            href={`/dashboard/${w.driveId}/settings/wallet`}
          />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}

function FundSection({ wallets }: { wallets: MyWallets }) {
  const drives = useDriveStore((state) => state.drives);
  const funded = new Set(wallets.funds.driveWallets.map((w) => w.driveId));
  // A personal drive you own can be funded from your credits (WAL-2); its wallet page creates it.
  // Never Home: AI usage there is already your own spend, so there is nothing to fund.
  const fundable = drives.filter((d) => d.isOwned && !d.orgId && !d.isTrashed && !isHomeDrive(d) && !funded.has(d.id));
  const { funds } = wallets;
  const empty = funds.driveWallets.length === 0 && funds.pools.length === 0 && funds.donations.length === 0;

  return (
    <SettingsSection
      title="You fund"
      description="Shared wallets and pools you pay for, and credits you have donated."
      actions={fundable.length > 0 ? (
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
        ) : undefined}
    >
      <SettingsGroup label="You fund">
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
            badge={w.status === 'active' ? <Badge variant="outline">Drive wallet</Badge> : <WalletStatusBadge status={w.status} />}
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
        <p className={cn('px-4 py-3 text-xs text-muted-foreground', empty && 'py-5')}>
          {empty ? 'You fund nothing yet. ' : ''}Funding a drive you own gives its members a shared wallet instead of spending their own credits. The allocation comes out of your balance each month. As the funder you set member caps in the drive&apos;s Wallet settings and get the 80% and 100% cap alerts. Your Home drive is never funded: what you spend there is your own credits.
        </p>
      </SettingsGroup>
    </SettingsSection>
  );
}

function DefaultSourceSection({ stored, onChanged }: { stored: MyWallets['personal']['defaultSpendSource']; onChanged: () => Promise<unknown> }) {
  const [pending, setPending] = useState(false);
  // SPEND-3: no saved default is the out-of-box one, which the gate preselects (chooseSource).
  const current = effectiveDefaultSpendSource(stored);
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
    { value: 'drive_wallet' as const, label: "The drive's wallet, if it has one", hint: "Where there isn't one you can spend, your own credits." },
    // JOURNEYS-1: this is a PRESELECTION, not the absolute switch — a conversation (or its
    // window) can still choose a drive wallet, and the label may not promise otherwise.
    { value: 'own_credits' as const, label: 'My own credits', hint: 'What new conversations start on. A conversation can still switch to a wallet — the absolute switch below never can.' },
  ];
  return (
    <SettingsSection title="Default when you open a drive" description="You always see the source before you send. This only decides what is preselected.">
        <div role="radiogroup" aria-label="Default source" className="flex flex-col gap-2">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={current === o.value}
              disabled={pending}
              onClick={() => void choose(o.value)}
              className={cn('flex flex-col gap-px rounded-xl border px-4 py-3 text-left transition-colors', current === o.value ? 'border-primary bg-primary/10' : 'hover:bg-accent')}
            >
              <span className="text-sm font-medium text-foreground">{o.label}</span>
              <span className="text-xs text-muted-foreground">{o.hint}</span>
            </button>
          ))}
        </div>
    </SettingsSection>
  );
}

interface AlwaysOwnCreditsState {
  alwaysOwnCredits: boolean;
  alwaysOwnCreditsInDrive: boolean | null;
}

/**
 * The SPEND-5 ABSOLUTE switches (JOURNEYS-1): one global, one per drive. Either makes every
 * call own-credits-or-refusal — no default, no preselection, no conversation switch can open
 * another wallet. This is the control the old "Always my own credits" radio label promised
 * and the default never delivered.
 */
function AbsoluteOwnCreditsSection({ drives, onChanged }: { drives: MyWallets['driveWallets']; onChanged: () => Promise<unknown> }) {
  const [state, setState] = useState<AlwaysOwnCreditsState | null>(null);
  const [selectedDriveId, setSelectedDriveId] = useState<string>(drives[0]?.driveId ?? '');
  const [pending, setPending] = useState(false);

  const read = async () => {
    try {
      const driveParam = selectedDriveId ? `?driveId=${encodeURIComponent(selectedDriveId)}` : '';
      const response = await fetchWithAuth(`/api/wallets/always-own-credits${driveParam}`);
      if (!response.ok) throw new Error(`Failed to read: ${response.status}`);
      setState(await response.json() as AlwaysOwnCreditsState);
    } catch {
      toast.error('Your spend switches could not be read. Try again.');
    }
  };

  // Re-read when the selected drive changes or the wallets behind us refresh.
  useEffect(() => { void read(); /* eslint-disable-line react-hooks/exhaustive-deps -- re-reads on the selected drive only */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDriveId]);

  const setSwitch = async (driveId: string | null, enabled: boolean) => {
    if (pending) return;
    setPending(true);
    const optimistic = driveId === null
      ? { alwaysOwnCredits: enabled, alwaysOwnCreditsInDrive: state?.alwaysOwnCreditsInDrive ?? null }
      : { alwaysOwnCredits: state?.alwaysOwnCredits ?? false, alwaysOwnCreditsInDrive: enabled };
    setState(optimistic); // the switch must never lie while the request is in flight
    try {
      await put('/api/wallets/always-own-credits', { driveId, enabled });
      await onChanged(); // refresh wallets (and, via the spend-preference event, other windows' previews)
    } catch (error) {
      toast.error(orgErrorMessage(error, 'Your switch could not be saved. Try again.'));
      await read(); // read the truth back before claiming anything
    } finally {
      setPending(false);
    }
  };

  const selectedDrive = drives.find((d) => d.driveId === selectedDriveId) ?? null;
  return (
    <SettingsSection
      title="Always my own credits"
      description="The absolute switch: while on, nothing you do can spend a drive wallet — calls either use your credits or are refused."
    >
      <SettingsGroup label="Always my own credits">
        <SettingsRow label="Everywhere, always" hint="No conversation, window or drive can choose anything else.">
          <Switch
            checked={state?.alwaysOwnCredits ?? false}
            disabled={pending || state === null}
            onCheckedChange={(enabled) => void setSwitch(null, enabled)}
            aria-label="Always my own credits, globally"
            data-testid="always-own-credits-global"
          />
        </SettingsRow>
        {drives.length > 0 && (
          <SettingsRow label="One drive only" hint="The same absolute rule, scoped to the drive you pick.">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" data-testid="always-own-credits-drive-picker">
                  {selectedDrive?.driveName ?? 'Pick a drive'}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Drives you can spend in</DropdownMenuLabel>
                {drives.map((d) => (
                  <DropdownMenuItem key={d.driveId} onClick={() => setSelectedDriveId(d.driveId)}>
                    {d.driveName ?? d.driveId}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {selectedDrive && (
              <Switch
                checked={state?.alwaysOwnCreditsInDrive ?? false}
                disabled={pending || state === null}
                onCheckedChange={(enabled) => void setSwitch(selectedDrive.driveId, enabled)}
                aria-label={`Always my own credits in ${selectedDrive.driveName ?? 'this drive'}`}
                data-testid="always-own-credits-drive"
              />
            )}
          </SettingsRow>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
