'use client';

import { useState } from 'react';
import { Gift } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmActionDialog } from '@/components/admin/users/confirm-action-dialog';
import { giftOrganization } from '@/components/admin/users/actions';

/**
 * SEAT-8: gift an organization ON its own Business subscription. The server reads the
 * subscription from the org id; the pool is funded at list price × the included-credit
 * ratio when the gift's $0 invoice reaches the webhook.
 */
export function OrgGiftCard() {
  const [orgId, setOrgId] = useState('');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const confirm = async (reason: string) => {
    setPending(true);
    setError(null);
    try {
      const result = await giftOrganization(orgId.trim(), reason);
      setOpen(false);
      setOrgId('');
      setStatus(result.message ?? 'Organization gifted');
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
          Applies a 100% gift coupon to the organization&apos;s own Business subscription. The org must
          already have a subscription Stripe invoices (not one awaiting its first payment).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-2">
          <Input placeholder="Organization id" value={orgId} onChange={(e) => setOrgId(e.target.value)} disabled={pending} />
          <Button size="sm" onClick={() => { setError(null); setOpen(true); }} disabled={pending || orgId.trim().length === 0}>
            <Gift className="h-4 w-4 mr-2" />
            Gift
          </Button>
        </div>
        {status && <p className="text-xs text-success" role="status">{status}</p>}
      </CardContent>
      <ConfirmActionDialog
        open={open}
        onOpenChange={(next) => !next && setOpen(false)}
        title="Gift this organization?"
        description={<span>Organization <strong>{orgId.trim()}</strong> is gifted on its own subscription. This is audited.</span>}
        confirmLabel="Gift organization"
        destructive={false}
        reasonPlaceholder="Why is this organization being gifted?"
        pending={pending}
        error={error}
        onConfirm={({ reason }) => { void confirm(reason); }}
      />
    </Card>
  );
}
