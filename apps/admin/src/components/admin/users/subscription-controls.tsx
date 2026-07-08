'use client';

import { useState } from 'react';
import { CreditCard, Crown, ExternalLink, Gift, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { stripeMode } from '@/lib/stripe-config';
import { ConfirmActionDialog } from './confirm-action-dialog';
import { giftSubscription, revokeSubscription } from './actions';
import { tierLabel } from './user-format';
import type { AdminUser, SubscriptionTier } from './types';

const GIFTABLE_TIERS: Array<Exclude<SubscriptionTier, 'free'>> = ['pro', 'founder', 'business'];

// Env-aware Stripe dashboard link — never hardcode test mode.
const STRIPE_DASHBOARD_BASE = `https://dashboard.stripe.com/${stripeMode === 'test' ? 'test/' : ''}`;

interface SubscriptionControlsProps {
  user: AdminUser;
  onActionComplete: () => void;
}

type DialogKind = 'gift' | 'revoke-gift' | 'revoke-paid' | null;

export function SubscriptionControls({ user, onActionComplete }: SubscriptionControlsProps) {
  const [selectedTier, setSelectedTier] = useState<Exclude<SubscriptionTier, 'free'> | ''>('');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const openDialog = (kind: DialogKind) => {
    setDialogError(null);
    setDialog(kind);
  };

  const run = async (action: () => Promise<{ message?: string }>) => {
    setPending(true);
    setDialogError(null);
    try {
      const result = await action();
      setDialog(null);
      setSelectedTier('');
      setStatus(result.message ?? 'Done');
      onActionComplete();
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <h4 className="text-sm font-medium mb-3 flex items-center">
        <CreditCard className="h-4 w-4 mr-2" />
        Subscription
      </h4>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Current Plan:</span>
          <Badge variant={
            user.subscriptionTier === 'business' ? 'destructive' :
              user.subscriptionTier === 'founder' || user.subscriptionTier === 'pro' ? 'default' : 'secondary'
          }>
            {user.subscription?.isGifted && <Gift className="h-3 w-3 mr-1" />}
            {!user.subscription?.isGifted && user.subscriptionTier !== 'free' && <Crown className="h-3 w-3 mr-1" />}
            {user.subscriptionTier === 'free' && <CreditCard className="h-3 w-3 mr-1" />}
            {tierLabel(user.subscriptionTier)}
            {user.subscription?.isGifted && ' (Gifted)'}
          </Badge>
        </div>

        {user.subscription && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Status:</span>
            <Badge variant={user.subscription.status === 'active' ? 'default' : 'secondary'}>
              {user.subscription.status}
              {user.subscription.cancelAtPeriodEnd && ' (ends at period end)'}
            </Badge>
          </div>
        )}

        {user.subscription?.isGifted && (
          <div className="p-2 bg-warning/10 border border-warning/30 rounded text-xs">
            <div className="flex items-center gap-1 text-warning">
              <Gift className="h-3 w-3" />
              <span>Gifted subscription</span>
            </div>
            {user.subscription.giftReason && (
              <div className="mt-1 text-muted-foreground">
                Reason: {user.subscription.giftReason}
              </div>
            )}
          </div>
        )}

        {status && (
          <p className="text-xs text-success" role="status">{status}</p>
        )}

        {!user.subscription ? (
          <div className="space-y-2">
            <Select
              value={selectedTier}
              onValueChange={(value) => setSelectedTier(value as Exclude<SubscriptionTier, 'free'>)}
              disabled={pending}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select tier to gift..." />
              </SelectTrigger>
              <SelectContent>
                {GIFTABLE_TIERS.map((tier) => (
                  <SelectItem key={tier} value={tier}>{tierLabel(tier)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={() => openDialog('gift')}
              disabled={pending || !selectedTier}
              className="w-full"
            >
              <Gift className="h-4 w-4 mr-2" />
              Gift Subscription
            </Button>
          </div>
        ) : user.subscription.isGifted ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => openDialog('revoke-gift')}
            disabled={pending}
            className="w-full"
          >
            <XCircle className="h-4 w-4 mr-2" />
            Revoke Gift
          </Button>
        ) : (
          <div className="space-y-2">
            <div className="p-2 bg-info/10 border border-info/30 rounded text-xs">
              <div className="flex items-center gap-1 text-info">
                <CreditCard className="h-3 w-3" />
                <span>Paid subscription - manage in Stripe</span>
              </div>
            </div>
            {user.stripeCustomerId && (
              <Button size="sm" variant="outline" className="w-full" asChild>
                <a
                  href={`${STRIPE_DASHBOARD_BASE}customers/${user.stripeCustomerId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Open in Stripe
                </a>
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              onClick={() => openDialog('revoke-paid')}
              disabled={pending}
              className="w-full"
            >
              <XCircle className="h-4 w-4 mr-2" />
              Force Revoke Subscription
            </Button>
          </div>
        )}
      </div>

      <ConfirmActionDialog
        open={dialog === 'gift'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Gift ${selectedTier ? tierLabel(selectedTier) : ''} subscription?`}
        description={
          <span>
            This creates a real Stripe subscription with a 100% discount coupon for{' '}
            <strong>{user.email}</strong>. The user is upgraded as soon as the webhook lands.
          </span>
        }
        confirmLabel="Gift subscription"
        destructive={false}
        reasonPlaceholder="Why is this account being gifted?"
        pending={pending}
        error={dialogError}
        onConfirm={({ reason }) => {
          if (!selectedTier) return;
          void run(() => giftSubscription(user.id, selectedTier, reason));
        }}
      />

      <ConfirmActionDialog
        open={dialog === 'revoke-gift'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Revoke gifted subscription?"
        description={
          <span>
            The gifted subscription for <strong>{user.email}</strong> is canceled immediately and
            the user drops to the free tier.
          </span>
        }
        confirmLabel="Revoke gift"
        reasonPlaceholder="Why is this gift being revoked?"
        pending={pending}
        error={dialogError}
        onConfirm={({ reason }) => {
          void run(() => revokeSubscription(user.id, reason, false));
        }}
      />

      <ConfirmActionDialog
        open={dialog === 'revoke-paid'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Force revoke a PAID subscription?"
        description={
          <span>
            <strong>{user.email}</strong> is a paying customer. By default the subscription is
            canceled at the end of the current billing period (they keep what they paid for).
          </span>
        }
        confirmLabel="Revoke subscription"
        typedConfirmation={{
          expected: user.email,
          label: `Type the user's email (${user.email}) to confirm`,
        }}
        checkbox={{
          label: 'Cancel immediately',
          description: 'Skips the paid period and downgrades the user right now.',
        }}
        reasonPlaceholder="Why is this paid subscription being revoked?"
        pending={pending}
        error={dialogError}
        onConfirm={({ reason, checked }) => {
          void run(() => revokeSubscription(user.id, reason, !checked));
        }}
      />
    </div>
  );
}
