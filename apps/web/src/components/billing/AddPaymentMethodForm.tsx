'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { useStripe, useElements, PaymentElement } from '@stripe/react-stripe-js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertCircle } from 'lucide-react';
import { StripeProvider } from './StripeProvider';
import { post } from '@/lib/auth/auth-fetch';

interface AddPaymentMethodFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

function AddPaymentMethodFormContent({
  onSuccess,
  onCancel,
}: {
  onSuccess: () => void;
  onCancel: () => void;
}) {
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

      const result = await stripe.confirmSetup({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/settings/billing?pm_added=true`,
        },
        redirect: 'if_required',
      });

      if (result.error) {
        setError(result.error.message || 'Failed to add payment method');
        setProcessing(false);
      } else {
        onSuccess();
      }
    } catch {
      setError('An unexpected error occurred');
      setProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement
        options={{
          layout: 'tabs',
        }}
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

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
        <Button type="submit" disabled={!stripe || processing} className="flex-1">
          {processing ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Adding...
            </>
          ) : (
            'Add Card'
          )}
        </Button>
      </div>
    </form>
  );
}

export function AddPaymentMethodForm({
  open,
  onOpenChange,
  onSuccess,
}: AddPaymentMethodFormProps) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !clientSecret) {
      createSetupIntent();
    }
  }, [open, clientSecret]);

  const createSetupIntent = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await post<{ clientSecret: string }>('/api/stripe/setup-intent', {});
      if (result.clientSecret) {
        setClientSecret(result.clientSecret);
      } else {
        setError('Failed to initialize payment form');
      }
    } catch {
      setError('Failed to initialize payment form');
    } finally {
      setLoading(false);
    }
  };

  const handleSuccess = () => {
    setClientSecret(null);
    toast.success('Card added successfully');
    onSuccess();
    onOpenChange(false);
  };

  const handleCancel = () => {
    setClientSecret(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Payment Method</DialogTitle>
          <DialogDescription>
            Add a new card to your account for future payments.
            <br />
            <span className="text-xs text-muted-foreground mt-1 block">
              Note: Adding the same card again will create a new entry.
            </span>
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />
            <span>Loading payment form...</span>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {clientSecret && (
          <StripeProvider
            options={{
              clientSecret,
              appearance: {
                theme: 'stripe',
                variables: {
                  colorPrimary: '#0F172A',
                },
              },
            }}
          >
            <AddPaymentMethodFormContent
              onSuccess={handleSuccess}
              onCancel={handleCancel}
            />
          </StripeProvider>
        )}
      </DialogContent>
    </Dialog>
  );
}
