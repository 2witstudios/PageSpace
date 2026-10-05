'use client';

import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { post } from '@/lib/auth/auth-fetch';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { CreditAmountField } from './CreditAmountField';

/**
 * Create the drive's wallet (Spec UI-9, WAL-2): for org admins on an org drive (from the pool) and
 * the lead on a personal drive (from their own credits).
 */
export function CreateWalletCard({ driveId, orgName, onChanged }: { driveId: string; orgName: string | null; onChanged: () => Promise<unknown> }) {
  return (
    <Card data-testid="wallet-create-card">
      <CardHeader>
        <CardTitle>Give this drive a wallet</CardTitle>
        <CardDescription>
          Members then spend a shared budget here instead of {orgName ? 'their seat allowance or ' : ''}their own credits. The allocation is drawn from {orgName ? `the ${orgName} pool` : 'your credits'} each month as it is spent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <CreditAmountField
          editingId={`drive-wallet-create-${driveId}`}
          label="Monthly allocation"
          actionLabel="Create wallet"
          onSubmit={async (cents) => {
            try {
              await post(`/api/drives/${driveId}/wallet`, { allocationCents: cents });
              toast.success('Wallet created');
              await onChanged();
            } catch (error) {
              toast.error(orgErrorMessage(error, 'The wallet could not be created.'));
            }
          }}
        />
      </CardContent>
    </Card>
  );
}

/** Donate to the drive's wallet from your own balance (WAL-4). A donation is not refundable (D-OW-13). */
export function DonateCard({ driveId, driveName, onChanged }: { driveId: string; driveName: string; onChanged: () => Promise<unknown> }) {
  return (
    <Card data-testid="wallet-donate-card">
      <CardHeader>
        <CardTitle>Add to this wallet</CardTitle>
        <CardDescription>Give credits from your own balance to everyone who spends in {driveName}. Donations are not refundable.</CardDescription>
      </CardHeader>
      <CardContent>
        <CreditAmountField
          editingId={`drive-wallet-donate-${driveId}`}
          label="Amount"
          actionLabel="Donate"
          min={1}
          onSubmit={async (cents) => {
            try {
              await post(`/api/drives/${driveId}/wallet/donate`, { amountCents: cents, idempotencyKey: crypto.randomUUID() });
              toast.success('Thank you — your credits were added');
              await onChanged();
            } catch (error) {
              toast.error(orgErrorMessage(error, 'The donation could not be made.'));
            }
          }}
        />
      </CardContent>
    </Card>
  );
}
