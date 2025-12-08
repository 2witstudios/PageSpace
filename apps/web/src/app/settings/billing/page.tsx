'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  Loader2,
  CreditCard,
  Receipt,
  MapPin,
  Sparkles,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { PaymentMethodsList, type PaymentMethod } from '@/components/billing/PaymentMethodsList';
import { AddPaymentMethodForm } from '@/components/billing/AddPaymentMethodForm';
import { InvoiceList, type Invoice } from '@/components/billing/InvoiceList';
import { UpcomingInvoice } from '@/components/billing/UpcomingInvoice';
import { BillingAddressForm, type BillingAddress } from '@/components/billing/BillingAddressForm';
import { getPlan, type SubscriptionTier } from '@/lib/subscription/plans';

interface SubscriptionData {
  subscriptionTier: SubscriptionTier;
  subscription?: {
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
  };
}

interface UpcomingInvoiceData {
  invoice: {
    amountDue: number;
    total: number;
    currency: string;
    nextPaymentAttempt: string | null;
    lines: Array<{ description: string | null; amount: number }>;
  } | null;
}

export default function BillingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // State
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Subscription
  const [subscriptionData, setSubscriptionData] = useState<SubscriptionData | null>(null);

  // Payment Methods
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [addPaymentMethodOpen, setAddPaymentMethodOpen] = useState(false);

  // Invoices
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesHasMore, setInvoicesHasMore] = useState(false);
  const [invoicesLoading, setInvoicesLoading] = useState(false);

  // Upcoming Invoice
  const [upcomingInvoice, setUpcomingInvoice] = useState<UpcomingInvoiceData['invoice']>(null);

  // Billing Address
  const [billingAddress, setBillingAddress] = useState<BillingAddress | null>(null);
  const [billingName, setBillingName] = useState<string | null>(null);

  // URL params
  const pmAdded = searchParams.get('pm_added');
  const success = searchParams.get('success');

  useEffect(() => {
    fetchAllData();
  }, []);

  // Clear URL params after showing alerts
  useEffect(() => {
    if (pmAdded || success) {
      const timer = setTimeout(() => {
        router.replace('/settings/billing');
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [pmAdded, success, router]);

  const fetchAllData = async () => {
    setLoading(true);
    setError(null);

    try {
      await Promise.all([
        fetchSubscription(),
        fetchPaymentMethods(),
        fetchInvoices(),
        fetchUpcomingInvoice(),
        fetchBillingAddress(),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load billing data');
    } finally {
      setLoading(false);
    }
  };

  const fetchSubscription = async () => {
    const res = await fetchWithAuth('/api/subscriptions/status');
    if (res.ok) {
      const data = await res.json();
      setSubscriptionData(data);
    }
  };

  const fetchPaymentMethods = async () => {
    const res = await fetchWithAuth('/api/stripe/payment-methods');
    if (res.ok) {
      const data = await res.json();
      setPaymentMethods(data.paymentMethods || []);
    }
  };

  const fetchInvoices = async (startingAfter?: string) => {
    setInvoicesLoading(true);
    try {
      const url = startingAfter
        ? `/api/stripe/invoices?limit=10&starting_after=${startingAfter}`
        : '/api/stripe/invoices?limit=10';
      const res = await fetchWithAuth(url);
      if (res.ok) {
        const data = await res.json();
        if (startingAfter) {
          setInvoices(prev => [...prev, ...(data.invoices || [])]);
        } else {
          setInvoices(data.invoices || []);
        }
        setInvoicesHasMore(data.hasMore || false);
      }
    } finally {
      setInvoicesLoading(false);
    }
  };

  const fetchUpcomingInvoice = async () => {
    const res = await fetchWithAuth('/api/stripe/upcoming-invoice');
    if (res.ok) {
      const data = await res.json();
      setUpcomingInvoice(data.invoice);
    }
  };

  const fetchBillingAddress = async () => {
    const res = await fetchWithAuth('/api/stripe/billing-address');
    if (res.ok) {
      const data = await res.json();
      setBillingAddress(data.address);
      setBillingName(data.name);
    }
  };

  const handleLoadMoreInvoices = () => {
    if (invoices.length > 0) {
      fetchInvoices(invoices[invoices.length - 1].id);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center min-h-64">
          <div className="text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4" />
            <p>Loading billing information...</p>
          </div>
        </div>
      </div>
    );
  }

  const plan = subscriptionData ? getPlan(subscriptionData.subscriptionTier) : getPlan('free');
  const isPaid = subscriptionData?.subscriptionTier !== 'free';
  const isCanceling = subscriptionData?.subscription?.cancelAtPeriodEnd;

  return (
    <div className="container mx-auto p-6 space-y-8 max-w-4xl">
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
          <h1 className="text-4xl font-bold">Billing</h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Manage your payment methods, view invoices, and update billing information
          </p>
        </div>
      </div>

      {/* Success Alerts */}
      {pmAdded && (
        <Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/20">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800 dark:text-green-200">
            Payment method added successfully!
          </AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/20">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800 dark:text-green-200">
            Billing updated successfully!
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

      {/* Current Subscription */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Current Subscription
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-full ${plan.accentColor}`}>
                <plan.icon className={`h-5 w-5 ${plan.iconColor}`} />
              </div>
              <div>
                <div className="font-semibold flex items-center gap-2">
                  {plan.displayName}
                  {isPaid && (
                    <Badge variant={isCanceling ? 'secondary' : 'default'}>
                      {isCanceling ? 'Canceling' : subscriptionData?.subscription?.status}
                    </Badge>
                  )}
                </div>
                <div className="text-sm text-muted-foreground">
                  {plan.price.formatted}{plan.price.monthly > 0 && '/month'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isPaid && subscriptionData?.subscription && (
                <div className="text-sm text-muted-foreground flex items-center gap-1 mr-4">
                  <Clock className="h-4 w-4" />
                  {isCanceling ? 'Ends' : 'Renews'}{' '}
                  {new Date(subscriptionData.subscription.currentPeriodEnd).toLocaleDateString()}
                </div>
              )}
              <Link href="/settings/plan">
                <Button variant="outline">
                  {isPaid ? 'Change Plan' : 'Upgrade'}
                </Button>
              </Link>
            </div>
          </div>

          {isCanceling && (
            <Alert className="mt-4">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Your subscription will end on{' '}
                {new Date(subscriptionData!.subscription!.currentPeriodEnd).toLocaleDateString()}.
                You can reactivate anytime before then.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Payment Methods */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Payment Methods
          </CardTitle>
          <CardDescription>
            Manage your saved payment methods for subscriptions and purchases
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PaymentMethodsList
            paymentMethods={paymentMethods}
            onRefresh={fetchPaymentMethods}
            onAddNew={() => setAddPaymentMethodOpen(true)}
          />
        </CardContent>
      </Card>

      {/* Upcoming Invoice */}
      {isPaid && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Receipt className="h-5 w-5" />
              Upcoming Invoice
            </CardTitle>
            <CardDescription>
              Your next scheduled payment
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UpcomingInvoice invoice={upcomingInvoice} />
          </CardContent>
        </Card>
      )}

      {/* Invoice History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            Invoice History
          </CardTitle>
          <CardDescription>
            View and download your past invoices
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InvoiceList
            invoices={invoices}
            hasMore={invoicesHasMore}
            onLoadMore={handleLoadMoreInvoices}
            loading={invoicesLoading}
          />
        </CardContent>
      </Card>

      {/* Billing Address */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Billing Address
          </CardTitle>
          <CardDescription>
            Your billing address for invoices and receipts
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BillingAddressForm
            address={billingAddress}
            name={billingName}
            onUpdate={fetchBillingAddress}
          />
        </CardContent>
      </Card>

      {/* Add Payment Method Dialog */}
      <AddPaymentMethodForm
        open={addPaymentMethodOpen}
        onOpenChange={setAddPaymentMethodOpen}
        onSuccess={() => {
          fetchPaymentMethods();
        }}
      />
    </div>
  );
}
