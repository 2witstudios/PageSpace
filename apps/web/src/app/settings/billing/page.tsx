'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SubscriptionCard } from '@/components/billing/SubscriptionCard';
import { CheckCircle, XCircle, AlertCircle, ArrowLeft } from 'lucide-react';
// Stripe Payment Links for subscription upgrades
const STRIPE_PRO_PAYMENT_LINK = 'https://buy.stripe.com/8x2fZjdczc7ffz0eF0eEo01';
const STRIPE_BUSINESS_PAYMENT_LINK = 'https://buy.stripe.com/dRm9AV1tRfjrcmOdAWeEo03';

interface SubscriptionData {
  subscriptionTier: 'normal' | 'pro' | 'business';
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
  normal: {
    current: number;
    limit: number;
    remaining: number;
  };
  extraThinking: {
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
        normal: usage.normal,
        extraThinking: usage.extraThinking,
      });

    } catch (err) {
      console.error('Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleUpgrade = () => {
    // Choose payment link based on current subscription tier
    const paymentLink = subscriptionData?.subscriptionTier === 'normal'
      ? STRIPE_PRO_PAYMENT_LINK
      : STRIPE_BUSINESS_PAYMENT_LINK;

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
    <div className="container mx-auto p-6 space-y-6">
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
        <h1 className="text-3xl font-bold">Billing & Subscription</h1>
        <p className="text-muted-foreground">
          Manage your PageSpace subscription and usage
        </p>
      </div>

      {/* Success/Cancel Alerts */}
      {success && (
        <Alert className="border-green-200 bg-green-50">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800">
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

      {/* Main Subscription Card */}
      <SubscriptionCard
        subscription={subscriptionData}
        usage={usageData}
        onUpgrade={handleUpgrade}
        onManageBilling={handleManageBilling}
      />

      {/* FAQ or Additional Info */}
      <Card>
        <CardHeader>
          <CardTitle>Frequently Asked Questions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="font-medium mb-2">What happens when I hit my daily limit?</h4>
            <p className="text-sm text-muted-foreground">
              Daily limits only apply to built-in PageSpace AI. Your own API keys (OpenAI, Anthropic, Google, etc.) have no limits.
              Normal tier: 20 calls/day. Pro tier: 50 calls/day. Business tier: 500 calls/day.
              Usage resets daily at midnight UTC. Extra Thinking is available for Pro (10/day) and Business (50/day) users.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-2">What are PageSpace&apos;s pricing options?</h4>
            <p className="text-sm text-muted-foreground">
              Normal: Free with 20 AI calls/day and 500MB storage.
              Pro: $29.99/month with 50 AI calls/day, 10 Extra Thinking calls, and 2GB storage.
              Business: $199.99/month with 500 AI calls/day, 50 Extra Thinking calls, and 50GB storage.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-2">Can I cancel anytime?</h4>
            <p className="text-sm text-muted-foreground">
              Yes! You can cancel your Pro or Business subscription anytime through the billing portal.
              You&apos;ll keep your paid features until the end of your current billing period.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}