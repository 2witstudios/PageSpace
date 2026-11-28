'use client';

import { useState } from 'react';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * Confirms an org subscription's open invoice with the Stripe Payment Element (D-OW-30: a card at
 * checkout, no trial). Used by the create dialog's payment step and by reactivation. Must render
 * inside <StripeProvider options={{ clientSecret }}>.
 */
export function OrgPaymentForm({ orgId, submitLabel, backLabel, onBack, onPaid }: {
  orgId: string;
  submitLabel: string;
  backLabel: string;
  onBack: () => void;
  onPaid: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    setError(null);
    try {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        setError(submitError.message ?? 'Check the card details and try again.');
        return;
      }
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: `${window.location.origin}/orgs/${orgId}/settings` },
        redirect: 'if_required',
      });
      if (result.error) {
        // Stripe's own card message ("Your card was declined.") is written for the payer.
        setError(result.error.message ?? 'The payment did not go through. Try another card.');
        return;
      }
      const status = result.paymentIntent?.status;
      if (status === 'succeeded' || status === 'processing') onPaid();
      else setError('The payment did not go through. Try another card.');
    } catch {
      setError('Something went wrong with the payment. Try again.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <span className="text-sm font-medium">Card</span>
        <div className="rounded-lg border bg-background p-3">
          <PaymentElement
            options={{ layout: 'tabs', wallets: { googlePay: 'never', applePay: 'never' } }}
            onReady={() => setReady(true)}
            onLoadError={() => setError('The payment form could not load. Try again.')}
          />
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onBack} disabled={processing}>
          {backLabel}
        </Button>
        <Button type="submit" disabled={!stripe || !ready || processing}>
          {processing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
