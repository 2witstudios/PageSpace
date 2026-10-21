'use client';

import { useEffect, useState } from 'react';
import { useParams } from '@/retained-adapters/navigation';
import Link from '@/retained-adapters/link';
import { driveWalletPanels } from '@pagespace/lib/billing/wallet-surface';
import { isHomeDrive } from '@pagespace/lib/services/drive-guards';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useDriveWallet } from '@/retained/hooks/useDriveWallet';
import { useDriveMemberNames } from '@/retained/hooks/useDriveMemberNames';
import { useMyOrganizations } from '@/retained/hooks/useMyOrganizations';
import { WalletBalanceCard } from '@/retained/components/wallets/drive-wallet/WalletBalanceCard';
import { WalletRulesCard } from '@/retained/components/wallets/drive-wallet/WalletRulesCard';
import { WalletCapsCard } from '@/retained/components/wallets/drive-wallet/WalletCapsCard';
import { WalletSpendCard } from '@/retained/components/wallets/drive-wallet/WalletSpendCard';
import { CreateWalletCard, DonateCard } from '@/retained/components/wallets/drive-wallet/WalletFundingCards';
import { SettingsScreen } from '@/ui/settings/settings-screen/settings-screen';

/**
 * Drive Settings › Wallet (Spec UI-9, SPEND-9, SPEND-10, WAL-3, WAL-4, WAL-7; canvas v9
 * DriveWallet). Every panel is picked from the viewer's own projection and actions
 * (wallet-surface driveWalletPanels), so a member sees the remaining amount and their own cap,
 * never the pool or anyone else's spend. Refreshes on `wallet:changed` (useDriveWallet).
 */
export default function DriveWalletSettingsPage() {
  const params = useParams();
  const driveId = params.driveId as string;
  const drive = useDriveStore((state) => state.drives.find((d) => d.id === driveId));
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const { read, isLoading, refresh } = useDriveWallet(driveId);
  const { orgById } = useMyOrganizations();
  const memberNames = useDriveMemberNames(driveId);
  const [capsRevision, setCapsRevision] = useState(0);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);
  // Any wallet change (a caps write included) refetches the view; the caps table follows it.
  useEffect(() => {
    if (read) setCapsRevision((r) => r + 1);
  }, [read]);

  const driveName = drive?.name ?? 'This drive';
  const orgName = orgById(drive?.orgId)?.name ?? (drive?.orgId ? 'the organization' : null);
  const isHome = drive ? isHomeDrive(drive) : false;

  return (
    <SettingsScreen
      title="Wallet"
      lede={isHome ? 'Home is your own space: AI usage here spends your own credits, and nothing needs funding.' : `What AI usage in ${driveName} spends from, and who funds it.`}
    >
      {isLoading ? (
        <>
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </>
      ) : !read ? (
        <p className="text-sm text-muted-foreground">You cannot see this drive&apos;s wallet.</p>
      ) : (
        <WalletSections driveId={driveId} driveName={driveName} orgName={orgName} isHome={isHome} read={read} memberNames={memberNames} capsRevision={capsRevision} refresh={refresh} />
      )}
    </SettingsScreen>
  );
}

function WalletSections({ driveId, driveName, orgName, isHome, read, memberNames, capsRevision, refresh }: {
  driveId: string;
  driveName: string;
  orgName: string | null;
  isHome: boolean;
  read: NonNullable<ReturnType<typeof useDriveWallet>['read']>;
  memberNames: Record<string, string>;
  capsRevision: number;
  refresh: () => Promise<unknown>;
}) {
  const panels = driveWalletPanels(read);
  const { wallet } = read;
  return (
    <>
      {panels.create && <CreateWalletCard driveId={driveId} orgName={orgName} onChanged={refresh} />}
      {!wallet && isHome && (
        <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground" data-testid="wallet-home-note">
          Nothing here needs funding. Only you work in Home, so every call spends your own credits — see them in{' '}
          <Link href="/settings/usage" className="text-accent-deep hover:underline">Usage</Link>.
        </p>
      )}
      {!wallet && !isHome && !panels.create && (
        <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
          {driveName} has no wallet. AI usage here spends from {orgName ? 'your seat allowance or ' : ''}your own credits.
        </p>
      )}
      {wallet && isHome && (
        <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground" data-testid="wallet-home-legacy-note">
          This wallet was made before Home stopped taking funding. What is left in it is spent first, then your own credits. Nothing can add to it: set its allocation to 0, or pause or delete it.
        </p>
      )}
      {wallet && (
        <>
          <WalletBalanceCard driveId={driveId} driveName={driveName} orgName={orgName} wallet={wallet} panels={panels} onChanged={refresh} />
          {panels.rules && 'allocationCents' in wallet && (
            <WalletRulesCard driveId={driveId} orgName={orgName} wallet={wallet} editable={panels.editRules} guestsEditable={panels.editAllocation} onChanged={refresh} />
          )}
          {panels.caps && <WalletCapsCard driveId={driveId} orgName={orgName} memberNames={memberNames} editable={panels.editCaps} revision={capsRevision} />}
          {panels.spendByMember && 'spendByConsumer' in wallet && <WalletSpendCard rows={wallet.spendByConsumer} spentCredits={wallet.spentCredits} />}
          {panels.donate && <DonateCard driveId={driveId} driveName={driveName} onChanged={refresh} />}
        </>
      )}
    </>
  );
}
