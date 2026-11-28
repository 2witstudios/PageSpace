'use client';

import { useState } from 'react';
import { Gift } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmActionDialog } from '@/components/admin/users/confirm-action-dialog';
import { giftOrganization, revokeOrganizationGift } from '@/components/admin/users/actions';

/**
 * SEAT-8 / D-OW-54: gift an organization ON its own Business subscription for a fixed number
 * of extra seats, or revoke that gift. The server reads the subscription from the org id; the
 * pool is funded at list price × the included-credit ratio for the gifted seats when each $0
 * gift invoice reaches the webhook.
 */
export function OrgGiftCard() {
  const [orgId, setOrgId] = useState('');
  const [extraSeats, setExtraSeats] = useState('0');
  const [open, setOpen] = useState<'gift' | 'revoke' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const seats = Number(extraSeats);
  const seatsValid = extraSeats.trim() !== '' && Number.isInteger(seats) && seats >= 0;

  const confirm = async (reason: string) => {
    setPending(true);
    setError(null);
    try {
      const result = open === 'revoke'
        ? await revokeOrganizationGift(orgId.trim(), reason)
        : await giftOrganization(orgId.trim(), reason, seats);
      setOpen(null);
      setOrgId('');
      setStatus(result.message ?? (open === 'revoke' ? 'Gift revoked' : 'Organization gifted'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center space-x-2">
          <Gift className="h-5 w-5" />
          <span>Gift an Organization</span>
        </CardTitle>
        <CardDescription>
          Applies a 100% gift coupon to the organization&apos;s own Business subscription for the base
          seats plus the extra seats you set; the gift stays at that seat count. The org must already
          have a subscription Stripe invoices (not one awaiting its first payment). Revoking removes
          the gift; the organization pays from its next renewal.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-2">
          <Input placeholder="Organization id" value={orgId} onChange={(e) => setOrgId(e.target.value)} disabled={pending} />
          <Input
            aria-label="Gifted extra seats"
            className="w-28"
            type="number"
            min={0}
            step={1}
            value={extraSeats}
            onChange={(e) => setExtraSeats(e.target.value)}
            disabled={pending}
          />
          <Button size="sm" onClick={() => { setError(null); setOpen('gift'); }} disabled={pending || orgId.trim().length === 0 || !seatsValid}>
            <Gift className="h-4 w-4 mr-2" />
            Gift
          </Button>
          <Button size="sm" variant="outline" onClick={() => { setError(null); setOpen('revoke'); }} disabled={pending || orgId.trim().length === 0}>
            Revoke gift
          </Button>
        </div>
        {status && <p className="text-xs text-success" role="status">{status}</p>}
      </CardContent>
      <ConfirmActionDialog
        open={open !== null}
        onOpenChange={(next) => !next && setOpen(null)}
        title={open === 'revoke' ? 'Revoke this organization\'s gift?' : 'Gift this organization?'}
        description={open === 'revoke'
          ? <span>Organization <strong>{orgId.trim()}</strong> loses its gift and pays from its next renewal. This is audited.</span>
          : <span>Organization <strong>{orgId.trim()}</strong> is gifted on its own subscription for the base seats plus <strong>{seatsValid ? seats : 0}</strong> extra. This is audited.</span>}
        confirmLabel={open === 'revoke' ? 'Revoke gift' : 'Gift organization'}
        destructive={open === 'revoke'}
        reasonPlaceholder={open === 'revoke' ? 'Why is this gift being revoked?' : 'Why is this organization being gifted?'}
        pending={pending}
        error={error}
        onConfirm={({ reason }) => { void confirm(reason); }}
      />
    </Card>
  );
}
