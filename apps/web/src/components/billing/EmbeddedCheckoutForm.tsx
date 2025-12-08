'use client';

import { useState } from 'react';
import { useStripe, useElements, PaymentElement } from '@stripe/react-stripe-js';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertCircle } from 'lucide-react';
import type { PlanDefinition } from '@/lib/subscription/plans';

interface EmbeddedCheckoutFormProps {
  plan: PlanDefinition;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Embedded checkout form using Stripe PaymentElement.
 * Used for new subscriptions (free -> paid).
 */
export function EmbeddedCheckoutForm({
  plan,
  onSuccess,
  onCancel,
}: EmbeddedCheckoutFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setProcessing(true);
    setError(null);

    try {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        setError(submitError.message || 'An error occurred');
        setProcessing(false);
        return;
      }

      const result = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/settings/plan?success=true`,
        },
        redirect: 'if_required',
      });

      if (result.error) {
        setError(result.error.message || 'Payment failed');
        setProcessing(false);
      } else if (result.paymentIntent?.status === 'succeeded') {
        onSuccess();
      }
    } catch (err) {
      setError('An unexpected error occurred');
      setProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Plan Summary */}
      <div className="bg-muted/50 rounded-lg p-4 border">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">{plan.displayName}</h3>
            <p className="text-sm text-muted-foreground">{plan.description}</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold">{plan.price.formatted}</div>
            <div className="text-sm text-muted-foreground">per month</div>
          </div>
        </div>
      </div>

      {/* Payment Element */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Payment Details</label>
        <PaymentElement
          options={{
            layout: 'tabs',
          }}
        />
      </div>

      {/* Error Display */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={processing}
          className="flex-1"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!stripe || processing}
          className="flex-1"
        >
          {processing ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Processing...
            </>
          ) : (
            `Subscribe to ${plan.name}`
          )}
        </Button>
      </div>

      {/* Terms */}
      <p className="text-xs text-muted-foreground text-center">
        By subscribing, you agree to our terms of service. You can cancel anytime.
      </p>
    </form>
  );
}
