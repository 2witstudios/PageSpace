'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SubscriptionCard } from '@/components/billing/SubscriptionCard';
import { PlanComparisonTable } from '@/components/billing/PlanComparisonTable';
import { CheckCircle, XCircle, AlertCircle, ArrowLeft } from 'lucide-react';
import { getNextPlan, type SubscriptionTier } from '@/lib/subscription/plans';

// Stripe Payment Links for subscription upgrades
const STRIPE_PRO_PAYMENT_LINK = 'https://buy.stripe.com/8x2fZjdczc7ffz0eF0eEo01';
const STRIPE_BUSINESS_PAYMENT_LINK = 'https://buy.stripe.com/dRm9AV1tRfjrcmOdAWeEo03';

interface SubscriptionData {
  subscriptionTier: 'free' | 'pro' | 'business';
  subscription?: {
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
  };
  storage: {
    used: number;
    quota: number;
    tier: string;
  };
}

interface UsageData {
  standard: {
    current: number;
    limit: number;
    remaining: number;
  };
  pro: {
    current: number;
    limit: number;
    remaining: number;
  };
}

export default function BillingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [subscriptionData, setSubscriptionData] = useState<SubscriptionData | null>(null);
  const [usageData, setUsageData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);


  // Handle URL parameters for success/cancel states
  const success = searchParams.get('success');
  const canceled = searchParams.get('canceled');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);

      const [subscriptionRes, usageRes] = await Promise.all([
        fetch('/api/subscriptions/status'),
        fetch('/api/subscriptions/usage')
      ]);

      if (!subscriptionRes.ok || !usageRes.ok) {
        throw new Error('Failed to fetch subscription data');
      }

      const subscription = await subscriptionRes.json();
      const usage = await usageRes.json();

      setSubscriptionData(subscription);
      setUsageData({
        standard: usage.standard,
        pro: usage.pro,
      });

    } catch (err) {
      console.error('Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleUpgrade = (targetTier?: SubscriptionTier) => {
    if (!subscriptionData) return;

    let paymentLink: string;

    if (targetTier) {
      // Upgrade to specific tier
      if (targetTier === 'pro') {
        paymentLink = STRIPE_PRO_PAYMENT_LINK;
      } else if (targetTier === 'business') {
        paymentLink = STRIPE_BUSINESS_PAYMENT_LINK;
      } else {
        console.error('Invalid target tier for upgrade:', targetTier);
        return;
      }
    } else {
      // Legacy upgrade to next tier
      const nextPlan = getNextPlan(subscriptionData.subscriptionTier);
      if (!nextPlan) {
        console.error('No upgrade path available');
        return;
      }

      paymentLink = nextPlan.stripePaymentLink || '';
      if (!paymentLink) {
        console.error('No payment link for next plan:', nextPlan.id);
        return;
      }
    }

    window.open(paymentLink, '_blank');
  };

  const handleManageBilling = async () => {
    try {
      const response = await fetch('/api/stripe/portal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to open billing portal');
      }

      const { url } = await response.json();
      window.open(url, '_blank');

    } catch (err) {
      console.error('Error opening billing portal:', err);
      setError(err instanceof Error ? err.message : 'Failed to open billing portal');
    }
  };

  // Clear URL parameters after showing alerts
  useEffect(() => {
    if (success || canceled) {
      const timer = setTimeout(() => {
        router.replace('/settings/billing');
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [success, canceled, router]);

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center min-h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
            <p>Loading billing information...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-6">
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button
          onClick={fetchData}
          className="mt-4"
          variant="outline"
        >
          Try Again
        </Button>
      </div>
    );
  }

  if (!subscriptionData || !usageData) {
    return (
      <div className="container mx-auto p-6">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>No subscription data available</AlertDescription>
        </Alert>
      </div>
    );
  }

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
          <h1 className="text-4xl font-bold">Billing & Subscription</h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Manage your PageSpace subscription, view usage, and explore our plans
          </p>
        </div>
      </div>

      {/* Success/Cancel Alerts */}
      {success && (
        <Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/20">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800 dark:text-green-200">
            Welcome to PageSpace Pro! Your subscription is now active.
          </AlertDescription>
        </Alert>
      )}

      {canceled && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription>
            Subscription upgrade was canceled. You can try again anytime.
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

      {/* Current Subscription Overview */}
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold text-center">Your Current Subscription</h2>
        <SubscriptionCard
          subscription={subscriptionData}
          usage={usageData}
          onManageBilling={handleManageBilling}
        />
      </div>

      {/* Plan Comparison Table */}
      <PlanComparisonTable
        currentTier={subscriptionData.subscriptionTier}
        onUpgrade={handleUpgrade}
        onManageBilling={handleManageBilling}
      />
    </div>
  );
}