'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from '@/retained-adapters/navigation';
import { useSWRConfig } from 'swr';
import { useTheme } from '@/retained-adapters/theme';
import { Button } from '@/retained/components/ui/button';
import { Alert, AlertDescription } from '@/retained/components/ui/alert';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { fetchWithAuth, post, getCachedCSRFToken } from '@/retained/lib/auth/auth-fetch';
import { StripeProvider } from '@/retained/components/billing/StripeProvider';
import { EmbeddedCheckoutForm } from '@/retained/components/billing/EmbeddedCheckoutForm';
import { PlanChangeConfirmation } from '@/retained/components/billing/PlanChangeConfirmation';
import { BillingGuard } from '@/retained/components/billing/BillingGuard';
import { PromoCodeInput, type AppliedPromo } from '@/retained/components/billing/PromoCodeInput';
import Link from '@/retained-adapters/link';
import { useCreditBalance } from '@/retained/hooks/useCreditBalance';
import { getPlan, getTierFromPriceId, type SubscriptionTier, type PlanDefinition } from '@/retained/lib/subscription/plans';
import {
  CREDIT_PACK_LIST,
  MONTHLY_CREDIT_CENTS,
  centsFromCredits,
  creditsCellPhrase,
  formatCreditCount,
  formatDollars,
  creditPackPriceCents,
  includedCreditsPhraseForCents,
  topUpRatePhrase,
} from '@/retained/lib/subscription/credits';
import {
  SettingsGroup,
  SettingsRow,
  SettingsScreen,
  SettingsSection,
} from '@/ui/settings/settings-screen/settings-screen';

interface ApplyPromoResponse {
  success: boolean;
  subscriptionId: string;
  clientSecret?: string;
}

interface SubscriptionData {
  subscriptionTier: SubscriptionTier;
  subscription?: {
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    scheduledPriceId?: string | null;
    scheduledChangeDate?: string | null;
  };
}

function PlanPageContent() {
  const { mutate: mutate } = useSWRConfig();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { resolvedTheme } = useTheme();
  const [subscriptionData, setSubscriptionData] = useState<SubscriptionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Checkout state
  const [checkoutPlan, setCheckoutPlan] = useState<PlanDefinition | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null);
  const [applyingPromo, setApplyingPromo] = useState(false);
  // Promo entered in the page header; applied to the subscription when Pro checkout starts.
  const [pendingPromo, setPendingPromo] = useState<AppliedPromo | null>(null);
  const { balance } = useCreditBalance();

  // Plan change dialog state
  const [changePlanDialog, setChangePlanDialog] = useState(false);
  const [targetPlan, setTargetPlan] = useState<PlanDefinition | null>(null);

  // Schedule cancellation
  const [cancellingSchedule, setCancellingSchedule] = useState(false);

  // Ref to track subscriptionId for cleanup (avoids stale closure)
  const subscriptionIdRef = useRef<string | null>(null);

  // Stable reference: a fresh object here on every render makes <Elements> keep
  // re-syncing with Stripe.js, which can loop with its hidden-frame lifecycle
  const stripeElementsOptions = useMemo(() => (
    clientSecret
      ? {
          clientSecret,
          appearance: {
            theme: (resolvedTheme === 'dark' ? 'night' : 'stripe') as 'night' | 'stripe',
            variables: {
              colorPrimary: resolvedTheme === 'dark' ? '#818cf8' : '#0F172A',
            },
          },
        }
      : undefined
  ), [clientSecret, resolvedTheme]);

  const success = searchParams.get('success');
  const canceled = searchParams.get('canceled');

  useEffect(() => {
    fetchSubscriptionData();
  }, []);

  // Clear URL params after showing alerts
  useEffect(() => {
    if (success || canceled) {
      const timer = setTimeout(() => {
        router.replace('/settings/plan');
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [success, canceled, router]);

  // Keep ref in sync with subscriptionId state
  useEffect(() => {
    subscriptionIdRef.current = subscriptionId;
  }, [subscriptionId]);

  // Cleanup incomplete subscription on unmount (client-side navigation)
  useEffect(() => {
    return () => {
      if (subscriptionIdRef.current) {
        post('/api/stripe/cancel-checkout', {
          subscriptionId: subscriptionIdRef.current,
        }).catch((err) => console.error('Checkout cleanup failed:', err));
      }
    };
  }, []);

  // Cleanup incomplete subscription on browser/tab close
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!subscriptionIdRef.current) return;

      // Reuse the already-fetched in-memory CSRF token (there's no time to await a fresh one here)
      const csrfToken = getCachedCSRFToken();

      // Use fetch with keepalive - continues after page unloads
      fetch('/api/stripe/cancel-checkout', {
        method: 'POST',
        keepalive: true,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken && { 'X-CSRF-Token': csrfToken }),
        },
        body: JSON.stringify({ subscriptionId: subscriptionIdRef.current }),
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const fetchSubscriptionData = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetchWithAuth('/api/subscriptions/status');
      if (!res.ok) throw new Error('Failed to fetch subscription data');
      const data = await res.json();
      setSubscriptionData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handlePlanSelect = async (targetTier: SubscriptionTier) => {
    if (!subscriptionData) return;

    const target = getPlan(targetTier);
    const currentTier = subscriptionData.subscriptionTier;

    // If currently on free and selecting a paid plan, start checkout
    if (currentTier === 'free' && targetTier !== 'free') {
      await startCheckout(target);
      return;
    }

    // If on a paid plan, show change confirmation dialog
    if (currentTier !== 'free' && targetTier !== currentTier) {
      setTargetPlan(target);
      setChangePlanDialog(true);
      return;
    }
  };

  const startCheckout = async (plan: PlanDefinition) => {
    if (!plan.stripePriceId) {
      setError('This plan is not available for purchase');
      return;
    }

    setCheckoutLoading(true);
    setError(null);

    try {
      // Ensure customer exists
      await post('/api/stripe/customer', {});

      // Create subscription and get client secret
      const result = await post<{ clientSecret: string; subscriptionId: string }>(
        '/api/stripe/create-subscription',
        { priceId: plan.stripePriceId }
      );

      if (result.clientSecret && result.subscriptionId) {
        let checkoutSecret = result.clientSecret;
        let checkoutSubscriptionId = result.subscriptionId;
        if (pendingPromo && plan.id === 'pro') {
          // Apply the header promo by recreating the incomplete subscription with it, the same
          // path the checkout form's own promo field takes.
          const applied = await post<ApplyPromoResponse>('/api/stripe/apply-promo', {
            subscriptionId: checkoutSubscriptionId,
            promotionCodeId: pendingPromo.promotionCodeId,
          });
          checkoutSubscriptionId = applied.subscriptionId;
          if (applied.clientSecret) checkoutSecret = applied.clientSecret;
          setAppliedPromo(pendingPromo);
        }
        setCheckoutPlan(plan);
        setClientSecret(checkoutSecret);
        setSubscriptionId(checkoutSubscriptionId);
      } else {
        setError('Failed to initialize checkout');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start checkout');
    } finally {
      setCheckoutLoading(false);
    }
  };

  const handleCheckoutSuccess = async () => {
    // Clear checkout UI
    setCheckoutPlan(null);
    setClientSecret(null);
    setSubscriptionId(null);
    setAppliedPromo(null);

    // Show loading state while webhook processes
    setLoading(true);

    // Brief delay for webhook to process
    await new Promise(r => setTimeout(r, 2000));

    // Refetch in place rather than reloading the document. A hard navigation to a
    // path outside /dashboard is cancelled and punted to Safari by the iOS shell,
    // blanking the WebView (see lib/navigation/app-navigator.ts); router.replace is
    // pushState and never reaches that policy check.
    //
    // The document reload this replaces refreshed the navbar as well as this page,
    // so the SWR caches it used to blow away must be invalidated by hand — the tier
    // label in UserDropdown (/api/subscriptions/status, a 5-minute refreshInterval)
    // and the credit balance (/api/credits, no polling at all) would otherwise show
    // the pre-checkout plan for minutes after a successful upgrade.
    router.replace('/settings/plan?success=true');
    router.refresh();
    try {
      await Promise.all([
        fetchSubscriptionData(),
        mutate('/api/subscriptions/status'),
        mutate('/api/credits'),
      ]);
    } catch (err) {
      // The checkout itself already succeeded; a failed revalidation only means
      // stale display data, so it must not reject out of here as an unhandled
      // rejection. The SWR keys recover on their next poll or focus.
      console.error('Post-checkout cache refresh failed', err);
    }
  };

  const handleCheckoutCancel = () => {
    // Capture subscriptionId before clearing
    const currentSubscriptionId = subscriptionId;

    // Clear UI immediately
    setCheckoutPlan(null);
    setClientSecret(null);
    setSubscriptionId(null);
    setAppliedPromo(null);

    // Cleanup Stripe resources (fire-and-forget)
    if (currentSubscriptionId) {
      post('/api/stripe/cancel-checkout', {
        subscriptionId: currentSubscriptionId,
      }).catch((err) => console.error('Checkout cleanup failed:', err));
    }
  };

  // Handle subscription recreation (when promo code is applied)
  const handleSubscriptionRecreated = (newSubscriptionId: string, newClientSecret: string) => {
    setSubscriptionId(newSubscriptionId);
    setClientSecret(newClientSecret);
  };

  const handlePlanChangeSuccess = () => {
    setChangePlanDialog(false);
    setTargetPlan(null);
    fetchSubscriptionData();
  };

  const handleCancelSchedule = async () => {
    setCancellingSchedule(true);
    try {
      const result = await post<{ success?: boolean; error?: string }>('/api/stripe/cancel-schedule', {});
      if (result.success) {
        await fetchSubscriptionData();
      } else {
        setError(result.error || 'Failed to cancel pending plan change');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel pending plan change');
    } finally {
      setCancellingSchedule(false);
    }
  };


  if (loading) {
    return (
      <SettingsScreen title="Plan">
        <div className="flex min-h-64 items-center justify-center text-muted-foreground">
          <div className="text-center">
            <Loader2 className="mx-auto mb-4 h-8 w-8 animate-spin" />
            <p>Loading plan information...</p>
          </div>
        </div>
      </SettingsScreen>
    );
  }

  const currentTier: SubscriptionTier = subscriptionData?.subscriptionTier ?? 'free';
  const currentPlan = getPlan(currentTier);
  const scheduledTier = subscriptionData?.subscription?.scheduledPriceId
    ? getTierFromPriceId(subscriptionData.subscription.scheduledPriceId)
    : null;
  const allowanceCents = balance?.monthly.allowance ?? MONTHLY_CREDIT_CENTS[currentTier];
  const renewsOn = balance?.monthly.periodEnd
    ? new Date(balance.monthly.periodEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;
  const lede = `You're on ${currentPlan.name} · ${includedCreditsPhraseForCents(currentTier, allowanceCents)}${
    renewsOn ? ` · renews ${renewsOn}` : ''
  }`;

  // Free and Pro are the personal columns. Business is an organization plan and is not
  // rendered on this branch (orgs are off), so it has no column and no org note here.
  const tierColumns: PlanDefinition[] = [getPlan('free'), getPlan('pro')];
  const proPriceId = getPlan('pro').stripePriceId ?? '';

  const packCredits = CREDIT_PACK_LIST.map((pack) => formatCreditCount(centsFromCredits(pack.credits)));
  const packPrices = CREDIT_PACK_LIST.map((pack) => formatDollars(creditPackPriceCents(pack)));
  const joinOr = (items: string[]): string =>
    items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;

  const featureRows = [
    { label: 'Credits', values: tierColumns.map((p) => creditsCellPhrase(p.id, MONTHLY_CREDIT_CENTS[p.id])) },
    { label: 'AI models', values: tierColumns.map((p) => (p.limits.proModels ? 'Standard + Pro' : 'Standard')) },
    { label: 'Buy more credits', values: tierColumns.map(() => topUpRatePhrase()) },
    { label: 'Storage', values: tierColumns.map((p) => p.limits.storage.formatted) },
    { label: 'Max File Size', values: tierColumns.map((p) => p.limits.maxFileSize.formatted) },
  ];

  const columnCta = (plan: PlanDefinition) => {
    if (plan.id === 'free') {
      return currentTier === 'free' ? null : (
        <Button variant="outline" className="w-full" onClick={() => handlePlanSelect('free')} disabled={cancellingSchedule}>
          Downgrade to Free Plan
        </Button>
      );
    }
    if (currentTier === 'pro') {
      return (
        <Button variant="outline" className="w-full" onClick={() => router.push('/settings/billing')}>
          Manage Billing
        </Button>
      );
    }
    if (currentTier === 'free') {
      return (
        <Button className="w-full" onClick={() => handlePlanSelect('pro')} disabled={checkoutLoading}>
          Upgrade to Pro
        </Button>
      );
    }
    return null;
  };

  const promoField = (
    <div role="group" aria-label="Promo code" className="w-72">
      <PromoCodeInput
        priceId={proPriceId}
        onPromoApplied={setPendingPromo}
        disabled={!proPriceId || checkoutPlan !== null}
      />
    </div>
  );

  return (
    <SettingsScreen title="Plan" lede={lede} actions={promoField}>
        {success && (
          <Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/20">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-800 dark:text-green-200">
              Your subscription has been updated successfully!
            </AlertDescription>
          </Alert>
        )}

        {canceled && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertDescription>
              Subscription change was canceled. You can try again anytime.
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {checkoutLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="mr-2 h-6 w-6 animate-spin" />
            <span>Preparing checkout...</span>
          </div>
        )}

        {checkoutPlan && clientSecret && subscriptionId && (
          <SettingsSection title="Complete your subscription">
            <div className="relative">
              {applyingPromo && (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/80 backdrop-blur-sm">
                  <div className="text-center">
                    <Loader2 className="mx-auto mb-2 h-8 w-8 animate-spin" />
                    <p className="text-sm font-medium">Applying promo code...</p>
                  </div>
                </div>
              )}
              <StripeProvider key={clientSecret} options={stripeElementsOptions}>
                <EmbeddedCheckoutForm
                  plan={checkoutPlan}
                  subscriptionId={subscriptionId}
                  appliedPromo={appliedPromo}
                  onPromoApplied={setAppliedPromo}
                  onApplyingPromoChange={setApplyingPromo}
                  onSuccess={handleCheckoutSuccess}
                  onCancel={handleCheckoutCancel}
                  onSubscriptionRecreated={handleSubscriptionRecreated}
                />
              </StripeProvider>
            </div>
          </SettingsSection>
        )}

        {!checkoutPlan && (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-border sm:grid-cols-2">
              {tierColumns.map((plan, index) => {
                const isCurrent = plan.id === currentTier;
                return (
                  <div
                    key={plan.id}
                    className={[
                      'flex flex-col p-5',
                      index > 0 ? 'border-t border-border sm:border-l sm:border-t-0' : '',
                      isCurrent ? 'bg-primary/5' : '',
                    ].join(' ')}
                  >
                    <div className="flex min-h-[22px] items-center justify-between gap-2">
                      <span className="text-[15px] font-semibold">{plan.name}</span>
                      {isCurrent && (
                        <span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] font-semibold text-background">
                          Current Plan
                        </span>
                      )}
                    </div>
                    <div className="mt-3 text-3xl font-bold tracking-tight">{plan.price.formatted}</div>
                    <p className="mb-3 mt-1 min-h-9 text-xs leading-relaxed text-muted-foreground">{plan.description}</p>
                    <dl className="mb-5 flex flex-col gap-1.5 text-sm">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Included</dt>
                        <dd className="text-right font-medium">
                          {includedCreditsPhraseForCents(plan.id, MONTHLY_CREDIT_CENTS[plan.id])}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Top up</dt>
                        <dd className="text-right font-medium">{topUpRatePhrase()}</dd>
                      </div>
                    </dl>
                    <div className="mt-auto">{columnCta(plan)}</div>
                  </div>
                );
              })}
            </div>

            {scheduledTier && scheduledTier !== currentTier && (
              <SettingsGroup label="Pending plan change">
                <SettingsRow
                  label={`Changing to ${getPlan(scheduledTier).name} at the end of this period`}
                  hint="Your current plan stays active until then."
                >
                  <Button variant="outline" size="sm" onClick={handleCancelSchedule} disabled={cancellingSchedule}>
                    {cancellingSchedule ? 'Cancelling...' : 'Keep Current Plan'}
                  </Button>
                </SettingsRow>
              </SettingsGroup>
            )}

            <SettingsSection title="Feature comparison">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="border-b border-border pb-2 font-medium">Feature</th>
                      {tierColumns.map((plan) => (
                        <th key={plan.id} className="border-b border-border pb-2 font-medium">
                          {plan.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {featureRows.map((row) => (
                      <tr key={row.label}>
                        <td className="border-b border-border/60 py-2.5 pr-4">{row.label}</td>
                        {row.values.map((value, index) => (
                          <td key={tierColumns[index].id} className="border-b border-border/60 py-2.5 pr-4 font-medium">
                            {value}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SettingsSection>

            <p className="text-xs text-muted-foreground">
              <Link href="/account/usage" className="text-accent-deep hover:underline">Buy more credits</Link>
              {` — ${joinOr(packCredits)} credits for ${joinOr(packPrices)}. Top-ups never expire.`}
            </p>
          </div>
        )}

        {targetPlan && subscriptionData && (
          <PlanChangeConfirmation
            open={changePlanDialog}
            onOpenChange={setChangePlanDialog}
            currentPlan={currentPlan}
            targetPlan={targetPlan}
            onSuccess={handlePlanChangeSuccess}
          />
        )}
    </SettingsScreen>
  );
}

/**
 * Billing-only route: the guard sits outside the page so that on iOS or a non-cloud deployment
 * nothing renders and no /api/stripe or subscription request fires, including while loading.
 */
export default function PlanPage() {
  return (
    <BillingGuard>
      <PlanPageContent />
    </BillingGuard>
  );
}
