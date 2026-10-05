'use client';

import { useEffect, useState } from 'react';
import { notFound, useParams, useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { driveWalletPanels } from '@pagespace/lib/billing/wallet-surface';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDriveStore } from '@/hooks/useDrive';
import { useDriveWallet } from '@/hooks/useDriveWallet';
import { useDriveMemberNames } from '@/hooks/useDriveMemberNames';
import { useMyOrganizations } from '@/hooks/useMyOrganizations';
import { WalletBalanceCard } from '@/components/wallets/drive-wallet/WalletBalanceCard';
import { WalletRulesCard } from '@/components/wallets/drive-wallet/WalletRulesCard';
import { WalletCapsCard } from '@/components/wallets/drive-wallet/WalletCapsCard';
import { WalletSpendCard } from '@/components/wallets/drive-wallet/WalletSpendCard';
import { CreateWalletCard, DonateCard } from '@/components/wallets/drive-wallet/WalletFundingCards';

/**
 * Drive Settings › Wallet (Spec UI-9, SPEND-9, SPEND-10, WAL-3, WAL-4, WAL-7; canvas v9
 * DriveWallet). Every panel is picked from the viewer's own projection and actions
 * (wallet-surface driveWalletPanels), so a member sees the remaining amount and their own cap,
 * never the pool or anyone else's spend. Refreshes on `wallet:changed` (useDriveWallet).
 */
export default function DriveWalletSettingsPage() {
  if (!ORGS_ENABLED) notFound();
  return <DriveWalletSettings />;
}

function DriveWalletSettings() {
  const params = useParams();
  const router = useRouter();
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

  return (
    <div className="container mx-auto max-w-2xl px-4 py-10 sm:px-6 lg:px-10">
      <div className="mb-8">
        <Button variant="ghost" size="sm" onClick={() => router.push(`/dashboard/${driveId}/settings`)} className="mb-4">
          <ChevronLeft className="mr-1 h-4 w-4" />
          Back to Drive Settings
        </Button>
        <h1 className="text-3xl font-bold">Wallet</h1>
        <p className="text-muted-foreground">What AI usage in {driveName} spends from, and who funds it</p>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-6">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : !read ? (
        <p className="text-muted-foreground">You cannot see this drive&apos;s wallet.</p>
      ) : (
        <WalletSections driveId={driveId} driveName={driveName} orgName={orgName} read={read} memberNames={memberNames} capsRevision={capsRevision} refresh={refresh} />
      )}
    </div>
  );
}

function WalletSections({ driveId, driveName, orgName, read, memberNames, capsRevision, refresh }: {
  driveId: string;
  driveName: string;
  orgName: string | null;
  read: NonNullable<ReturnType<typeof useDriveWallet>['read']>;
  memberNames: Record<string, string>;
  capsRevision: number;
  refresh: () => Promise<unknown>;
}) {
  const panels = driveWalletPanels(read);
  const { wallet } = read;
  return (
    <div className="flex flex-col gap-8">
      {panels.create && <CreateWalletCard driveId={driveId} orgName={orgName} onChanged={refresh} />}
      {!wallet && !panels.create && (
        <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
          {driveName} has no wallet. AI usage here spends from {orgName ? 'your seat allowance or ' : ''}your own credits.
        </p>
      )}
      {wallet && (
        <>
          <WalletBalanceCard driveId={driveId} driveName={driveName} orgName={orgName} wallet={wallet} panels={panels} onChanged={refresh} />
          {panels.rules && 'allocationCents' in wallet && (
            <WalletRulesCard driveId={driveId} orgName={orgName} wallet={wallet} editable={panels.editRules} onChanged={refresh} />
          )}
          {panels.caps && <WalletCapsCard driveId={driveId} orgName={orgName} memberNames={memberNames} editable={panels.editCaps} revision={capsRevision} />}
          {panels.spendByMember && 'spendByConsumer' in wallet && <WalletSpendCard rows={wallet.spendByConsumer} spentCredits={wallet.spentCredits} />}
          {panels.donate && <DonateCard driveId={driveId} driveName={driveName} onChanged={refresh} />}
        </>
      )}
    </div>
  );
}
