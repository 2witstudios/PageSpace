'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ArrowLeft, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import { StripeProvider } from '@/components/billing/StripeProvider';
import { EmbeddedCheckoutForm } from '@/components/billing/EmbeddedCheckoutForm';
import { PlanChangeConfirmation } from '@/components/billing/PlanChangeConfirmation';
import { PlanCard } from '@/components/billing/PlanCard';
import { getAllPlans, getPlan, getTierFromPriceId, type SubscriptionTier, type PlanDefinition } from '@/lib/subscription/plans';
import type { AppliedPromo } from '@/components/billing/PromoCodeInput';

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

export default function PlanPage() {
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

  // Plan change dialog state
  const [changePlanDialog, setChangePlanDialog] = useState(false);
  const [targetPlan, setTargetPlan] = useState<PlanDefinition | null>(null);

  // Schedule cancellation
  const [cancellingSchedule, setCancellingSchedule] = useState(false);

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
        setCheckoutPlan(plan);
        setClientSecret(result.clientSecret);
        setSubscriptionId(result.subscriptionId);
      } else {
        setError('Failed to initialize checkout');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start checkout');
    } finally {
      setCheckoutLoading(false);
    }
  };

  const handleCheckoutSuccess = () => {
    setCheckoutPlan(null);
    setClientSecret(null);
    setSubscriptionId(null);
    setAppliedPromo(null);
    fetchSubscriptionData();
    router.replace('/settings/plan?success=true');
  };

  const handleCheckoutCancel = () => {
    setCheckoutPlan(null);
    setClientSecret(null);
    setSubscriptionId(null);
    setAppliedPromo(null);
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
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center min-h-64">
          <div className="text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4" />
            <p>Loading plan information...</p>
          </div>
        </div>
      </div>
    );
  }

  const plans = getAllPlans();
  const currentPlan = subscriptionData ? getPlan(subscriptionData.subscriptionTier) : getPlan('free');
  const scheduledTier = subscriptionData?.subscription?.scheduledPriceId
    ? getTierFromPriceId(subscriptionData.subscription.scheduledPriceId)
    : null;

  return (
    <div className="container mx-auto p-6 space-y-8">
      {/* Header */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold">Choose Your Plan</h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Select the plan that best fits your needs. Upgrade or downgrade anytime.
          </p>
        </div>
      </div>

      {/* Success/Cancel Alerts */}
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

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Checkout Loading */}
      {checkoutLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          <span>Preparing checkout...</span>
        </div>
      )}

      {/* Embedded Checkout */}
      {checkoutPlan && clientSecret && subscriptionId && (
        <Card className="max-w-lg mx-auto relative">
          <CardHeader>
            <CardTitle>Complete Your Subscription</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Loading overlay during promo application */}
            {applyingPromo && (
              <div className="absolute inset-0 bg-background/80 backdrop-blur-sm z-10 flex items-center justify-center rounded-lg">
                <div className="text-center">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2" />
                  <p className="text-sm font-medium">Applying promo code...</p>
                </div>
              </div>
            )}
            <StripeProvider
              key={clientSecret}
              options={{
                clientSecret,
                appearance: {
                  theme: resolvedTheme === 'dark' ? 'night' : 'stripe',
                  variables: {
                    colorPrimary: '#0F172A',
                  },
                },
              }}
            >
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
          </CardContent>
        </Card>
      )}

      {/* Plan Cards - Only show when not in checkout */}
      {!checkoutPlan && (
        <div className="flex overflow-x-auto gap-4 pt-6 pb-4 snap-x snap-mandatory -mx-6 px-6 justify-center">
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              currentTier={subscriptionData?.subscriptionTier || 'free'}
              isCurrentPlan={plan.id === subscriptionData?.subscriptionTier}
              isScheduledPlan={plan.id === scheduledTier}
              hasPendingSchedule={!!scheduledTier}
              onUpgrade={handlePlanSelect}
              onManageBilling={() => router.push('/settings/billing')}
              onCancelSchedule={handleCancelSchedule}
              cancellingSchedule={cancellingSchedule}
              className={plan.highlighted ? 'relative z-10' : ''}
            />
          ))}
        </div>
      )}

      {/* Feature Comparison */}
      {!checkoutPlan && (
        <Card>
          <CardHeader>
            <CardTitle className="text-center">Feature Comparison</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-4 pr-6 font-medium">Feature</th>
                    {plans.map((plan) => (
                      <th key={plan.id} className="text-center py-4 px-4 font-medium min-w-32">
                        <div className="flex flex-col items-center gap-1">
                          <plan.icon className={`h-5 w-5 ${plan.iconColor}`} />
                          <span>{plan.name}</span>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="py-4 pr-6">AI Calls per Day</td>
                    {plans.map((plan) => (
                      <td key={plan.id} className="text-center py-4 px-4 font-semibold">
                        {plan.limits.aiCalls}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b">
                    <td className="py-4 pr-6">Pro AI Calls</td>
                    {plans.map((plan) => (
                      <td key={plan.id} className="text-center py-4 px-4">
                        {plan.limits.pro > 0 ? (
                          <span className="font-semibold">{plan.limits.pro}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b">
                    <td className="py-4 pr-6">Storage</td>
                    {plans.map((plan) => (
                      <td key={plan.id} className="text-center py-4 px-4 font-semibold">
                        {plan.limits.storage.formatted}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b">
                    <td className="py-4 pr-6">Max File Size</td>
                    {plans.map((plan) => (
                      <td key={plan.id} className="text-center py-4 px-4 font-semibold">
                        {plan.limits.maxFileSize.formatted}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Plan Change Confirmation Dialog */}
      {targetPlan && subscriptionData && (
        <PlanChangeConfirmation
          open={changePlanDialog}
          onOpenChange={setChangePlanDialog}
          currentPlan={currentPlan}
          targetPlan={targetPlan}
          onSuccess={handlePlanChangeSuccess}
        />
      )}
    </div>
  );
}
