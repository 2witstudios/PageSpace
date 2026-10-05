'use client';

import { useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { AlertTriangle, CreditCard, Info, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { OrgBillingNotice } from '@pagespace/lib/organizations/status-core';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StripeProvider } from '@/components/billing/StripeProvider';
import { openOrgBillingPortal, startOrgSubscription } from '@/lib/orgs/org-api';
import { orgErrorMessage } from '@/lib/orgs/org-error-copy';
import { cn } from '@/lib/utils/index';
import { OrgPaymentForm } from './OrgPaymentForm';

/** Opens the org's Stripe billing portal (it returns to /orgs/[orgId]/settings). */
export async function goToOrgBillingPortal(orgId: string): Promise<void> {
  try {
    const { url } = await openOrgBillingPortal(orgId);
    window.location.assign(url);
  } catch (error) {
    toast.error(orgErrorMessage(error, 'The billing portal could not be opened. Try again.'));
  }
}

/**
 * The lapse banners (SEAT-9 / D-OW-33, canvas OrgLapsed) on every org surface, from GET
 * /api/orgs/[orgId] billingNotice: reactivate and payment_failed for the Owner and Admins, read_only
 * for Members. Reactivating pays what is owed with the Payment Element (POST billing/subscription).
 */
export function OrgBillingBanner({ orgId, orgName, notice, onReactivated }: {
  orgId: string;
  orgName: string;
  notice: OrgBillingNotice | undefined;
  onReactivated?: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const [busy, setBusy] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const stripeOptions = useMemo(
    () => (clientSecret ? { clientSecret, appearance: { theme: (resolvedTheme === 'dark' ? 'night' : 'stripe') as 'night' | 'stripe' } } : undefined),
    [clientSecret, resolvedTheme],
  );

  if (!notice || notice.kind === 'trial') return null;

  const reactivate = async () => {
    setBusy(true);
    try {
      const res = await startOrgSubscription(orgId);
      if (res.payment.kind === 'confirm_payment') setClientSecret(res.payment.clientSecret);
      else {
        toast.success(`${orgName} is active again`);
        onReactivated?.();
      }
    } catch (error) {
      toast.error(orgErrorMessage(error, 'Reactivation could not start. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const tone =
    notice.kind === 'reactivate'
      ? 'border-destructive/30 bg-destructive/5'
      : notice.kind === 'payment_failed'
        ? 'border-warning/40 bg-warning/10'
        : 'border-border bg-card';
  const Icon = notice.kind === 'read_only' ? Info : notice.kind === 'payment_failed' ? CreditCard : AlertTriangle;

  return (
    <div role="status" className={cn('mb-8 flex items-start gap-2.5 rounded-xl border px-3.5 py-3', tone)}>
      <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', notice.kind === 'reactivate' ? 'text-destructive' : 'text-muted-foreground')} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {notice.kind === 'reactivate' ? (
          <>
            <span className="text-sm font-medium">{orgName} is unpaid and read-only</span>
            <span className="text-xs text-foreground/80">
              The subscription has ended. Every drive stays readable. Spending credits, inviting, publishing, and loosening policies are paused until you reactivate. Restricting access still works.
            </span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void reactivate()} disabled={busy}>
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Reactivate
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void goToOrgBillingPortal(orgId)}>
                Billing portal
              </Button>
            </div>
          </>
        ) : notice.kind === 'payment_failed' ? (
          <>
            <span className="text-sm font-medium">The last payment for {orgName} failed</span>
            <span className="text-xs text-foreground/80">Update the card to keep {orgName} active.</span>
            <div className="mt-1.5">
              <Button size="sm" variant="outline" onClick={() => void goToOrgBillingPortal(orgId)}>
                Update payment method
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="text-sm font-medium">{orgName} is read-only</span>
            <span className="text-xs text-foreground/80">
              You can open and read every drive you could before. AI, invites, and publishing are paused until the Owner or an Admin reactivates the organization.
            </span>
          </>
        )}
      </div>
      <Dialog open={clientSecret !== null} onOpenChange={(open) => !open && setClientSecret(null)}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Reactivate {orgName}</DialogTitle>
            <DialogDescription>Pay what is owed to turn spending, inviting and publishing back on.</DialogDescription>
          </DialogHeader>
          {clientSecret ? (
            <StripeProvider options={stripeOptions}>
              <OrgPaymentForm
                orgId={orgId}
                submitLabel="Pay and reactivate"
                backLabel="Cancel"
                onBack={() => setClientSecret(null)}
                onPaid={() => {
                  setClientSecret(null);
                  toast.success('Payment received. Reactivating…');
                  onReactivated?.();
                }}
              />
            </StripeProvider>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
