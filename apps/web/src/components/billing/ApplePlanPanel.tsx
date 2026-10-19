'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
import { MarketingLink } from '@/components/ui/MarketingLink';
import { useAppleProducts } from '@/hooks/useAppleProducts';
import type { PlanDefinition } from '@/lib/subscription/plans';
import {
  APPLE_AUTO_RENEW_DISCLOSURE,
  MANAGED_ON_WEB_TEXT,
  ORG_PLAN_MANAGED_TEXT,
  applePlanAction,
  formatAppleProductPrice,
  purchaseResultMessage,
  type BillingProvider,
} from '@/lib/iap/apple-store-core';

interface ApplePlanPanelProps {
  /** The Pro plan definition (credit figures already patched from the server). */
  plan: PlanDefinition;
  subscriptionTier: string;
  billingProvider: BillingProvider | undefined;
  /** Called after the server confirmed a purchase or restore changed something. */
  onChanged: () => void | Promise<void>;
}

type Busy = 'subscribe' | 'restore' | 'manage' | null;
type Notice = { tone: 'success' | 'info' | 'error'; text: string } | null;

const NOTICE_CLASS: Record<'success' | 'info' | 'error', string> = {
  success: 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/20 dark:text-green-200',
  info: '',
  error: '',
};

/**
 * The plan page on the Apple billing channel (the iOS app with StoreKit):
 * the Pro subscription at StoreKit's localized price, sold through In-App
 * Purchase, with Restore Purchases, Manage Subscription, the auto-renewal
 * disclosure, and the Terms of Use and Privacy Policy links App Review requires.
 *
 * Never renders a Stripe control, a web price, or a link off the App Store.
 */
export function ApplePlanPanel({ plan, subscriptionTier, billingProvider, onChanged }: ApplePlanPanelProps) {
  const { pro, isLoading, isError } = useAppleProducts(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const action = applePlanAction({ subscriptionTier, billingProvider });
  const sellsHere = action === 'subscribe' || action === 'manage';

  const subscribe = async () => {
    if (!pro) return;
    setBusy('subscribe');
    setNotice(null);
    try {
      const { purchaseAppleProduct } = await import('@/lib/iap/apple-store');
      const result = await purchaseAppleProduct(pro.productId);
      setNotice(purchaseResultMessage(result));
      if (result.status === 'success') await onChanged();
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error && err.message ? err.message : 'The purchase could not start. Please try again.' });
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy('restore');
    setNotice(null);
    try {
      const { restoreApplePurchases } = await import('@/lib/iap/apple-store');
      const summary = await restoreApplePurchases();
      if (summary.applied > 0) {
        setNotice({ tone: 'success', text: 'Purchases restored.' });
        await onChanged();
      } else if (summary.refused > 0) {
        setNotice({ tone: 'error', text: 'These App Store purchases belong to a different PageSpace account.' });
      } else if (summary.failed > 0) {
        setNotice({ tone: 'error', text: "We couldn't restore your purchases right now. Please try again." });
      } else {
        setNotice({ tone: 'info', text: 'No purchases to restore.' });
      }
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error && err.message ? err.message : 'Restore failed. Please try again.' });
    } finally {
      setBusy(null);
    }
  };

  const manage = async () => {
    setBusy('manage');
    try {
      const { manageAppleSubscriptions } = await import('@/lib/iap/apple-store');
      await manageAppleSubscriptions();
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error && err.message ? err.message : 'Could not open subscription settings.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-lg space-y-4 pt-6" data-testid="apple-plan-panel">
      {notice && (
        <Alert variant={notice.tone === 'error' ? 'destructive' : 'default'} className={NOTICE_CLASS[notice.tone]}>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}

      <Card className="relative ring-2 ring-zinc-400 dark:ring-zinc-500">
        {action === 'manage' && (
          <div className="absolute -top-3 right-4">
            <Badge className="bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100">
              Current Plan
            </Badge>
          </div>
        )}
        <CardHeader className="text-center pb-4">
          <div className="flex flex-col items-center gap-2">
            <plan.icon className={`h-6 w-6 ${plan.iconColor}`} />
            <CardTitle className="text-xl font-bold">{pro?.displayName || plan.displayName}</CardTitle>
          </div>
          {sellsHere && (
            <div className="pt-2" data-testid="apple-plan-price">
              {pro ? (
                <span className="text-3xl font-bold">{formatAppleProductPrice(pro)}</span>
              ) : isLoading ? (
                <Skeleton className="mx-auto h-8 w-32" />
              ) : (
                <span className="text-sm text-muted-foreground">
                  {isError ? 'The App Store is unavailable right now.' : 'Not available in your region.'}
                </span>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <CardDescription className="text-center text-sm">{plan.description}</CardDescription>
          <dl className="rounded-lg border border-border text-sm">
            <div className="flex items-start justify-between gap-4 px-4 py-3">
              <dt className="text-muted-foreground shrink-0">Included</dt>
              <dd className="font-medium text-right">{plan.includedCredits}</dd>
            </div>
          </dl>

          {action === 'subscribe' && (
            <Button className="w-full" onClick={subscribe} disabled={!pro || busy !== null}>
              {busy === 'subscribe' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Subscribe
            </Button>
          )}
          {action === 'manage' && (
            <Button className="w-full" variant="outline" onClick={manage} disabled={busy !== null}>
              {busy === 'manage' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Manage Subscription
            </Button>
          )}
          {action === 'managed-on-web' && (
            <p className="text-center text-sm text-muted-foreground">{MANAGED_ON_WEB_TEXT}</p>
          )}
          {action === 'managed-by-org' && (
            <p className="text-center text-sm text-muted-foreground">{ORG_PLAN_MANAGED_TEXT}</p>
          )}
          {action === 'included' && (
            <p className="text-center text-sm text-muted-foreground">Your account already includes {plan.displayName}.</p>
          )}

          {sellsHere && (
            <>
              <Button className="w-full" variant="ghost" onClick={restore} disabled={busy !== null}>
                {busy === 'restore' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Restore Purchases
              </Button>
              <p className="text-xs text-muted-foreground" data-testid="apple-auto-renew-disclosure">
                {APPLE_AUTO_RENEW_DISCLOSURE}
              </p>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            <MarketingLink href="/terms" className="underline">Terms of Use</MarketingLink>
            {' · '}
            <MarketingLink href="/privacy" className="underline">Privacy Policy</MarketingLink>
          </p>
        </CardContent>
      </Card>

      {action !== 'managed-by-org' && (
        <p className="text-center text-xs text-muted-foreground">{ORG_PLAN_MANAGED_TEXT}</p>
      )}
    </div>
  );
}
