'use client';

import { ORGS_ENABLED } from '@pagespace/lib/organizations/orgs-enabled';
import { spendChoiceLabel } from '@pagespace/lib/billing/spend-target';
import type { AutomationSpendContext } from '@/components/wallets/AutomationSpendState';
import { useDriveStore } from '@/hooks/useDrive';
import { useDriveMemberNames } from './useDriveMemberNames';
import { useDriveWallet } from './useDriveWallet';
import { useMyOrganizations } from './useMyOrganizations';

/**
 * What the workflow and trigger surfaces of one drive need to say whom an automation spends as
 * and why a run was skipped (SPEND-6, D-OW-34): members' names, the drive wallet's label (the
 * same label the spending-from popover uses), and the drive's org. Undefined while orgs are dark;
 * with no drive in hand, the copy falls back to generic names.
 */
export function useAutomationSpendContext(driveId: string | null, driveName: string | null = null): AutomationSpendContext | undefined {
  const creatorNames = useDriveMemberNames(driveId);
  const { wallet } = useDriveWallet(driveId);
  const { orgById } = useMyOrganizations();
  const drive = useDriveStore((state) => (driveId ? state.drives.find((d) => d.id === driveId) ?? null : null));
  const orgId = drive?.orgId ?? null;
  const name = driveName ?? drive?.name ?? null;
  if (!ORGS_ENABLED) return undefined;
  return {
    creatorNames,
    walletLabel: wallet ? spendChoiceLabel({ source: 'drive_wallet', driveName: name, orgName: null }) : null,
    orgName: orgById(orgId)?.name ?? null,
  };
}
