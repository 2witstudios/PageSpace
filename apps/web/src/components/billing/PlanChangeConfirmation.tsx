'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertCircle, ArrowUp, ArrowDown } from 'lucide-react';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import type { PlanDefinition } from '@/lib/subscription/plans';

interface PlanChangeConfirmationProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPlan: PlanDefinition;
  targetPlan: PlanDefinition;
  onSuccess: () => void;
}

interface ProrationPreview {
  amount: number;
  items: Array<{ description: string; amount: number }>;
}

interface UpcomingInvoiceResponse {
  invoice: {
    amountDue: number;
    total: number;
    currency: string;
    nextPaymentAttempt: string | null;
  } | null;
  proration: ProrationPreview | null;
}

/**
 * Dialog for confirming plan changes (upgrades and downgrades).
 * Shows proration preview for upgrades.
 */
export function PlanChangeConfirmation({
  open,
  onOpenChange,
  currentPlan,
  targetPlan,
  onSuccess,
}: PlanChangeConfirmationProps) {
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<UpcomingInvoiceResponse | null>(null);

  const isDowngrade = targetPlan.price.monthly < currentPlan.price.monthly;

  // Fetch proration preview for upgrades
  useEffect(() => {
    if (!open || !targetPlan.stripePriceId) return;

    const fetchPreview = async () => {
      setPreviewLoading(true);
      try {
        const res = await fetchWithAuth(
          `/api/stripe/upcoming-invoice?priceId=${targetPlan.stripePriceId}`
        );
        if (res.ok) {
          const data = await res.json();
          setPreview(data);
        }
      } catch (err) {
        console.error('Failed to fetch preview:', err);
      } finally {
        setPreviewLoading(false);
      }
    };

    fetchPreview();
  }, [open, targetPlan.stripePriceId]);

  const handleConfirm = async () => {
    if (!targetPlan.stripePriceId) {
      setError('Invalid plan configuration');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await post<{ error?: string }>('/api/stripe/update-subscription', {
        priceId: targetPlan.stripePriceId,
        isDowngrade,
      });

      if (response.error) {
        setError(response.error);
      } else {
        onSuccess();
        onOpenChange(false);
      }
    } catch {
      setError('Failed to update subscription');
    } finally {
      setLoading(false);
    }
  };

  const formatAmount = (cents: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(cents / 100);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isDowngrade ? (
              <>
                <ArrowDown className="h-5 w-5 text-orange-500" />
                Downgrade to {targetPlan.name}
              </>
            ) : (
              <>
                <ArrowUp className="h-5 w-5 text-green-500" />
                Upgrade to {targetPlan.name}
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {isDowngrade
              ? "You'll keep your current plan features until the end of your billing period."
              : "Your new plan will be effective immediately."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Plan comparison */}
          <div className="grid grid-cols-2 gap-4 text-center">
            <div className="p-3 rounded-lg border bg-muted/30">
              <div className="text-sm text-muted-foreground">Current Plan</div>
              <div className="font-semibold">{currentPlan.name}</div>
              <div className="text-lg">{currentPlan.price.formatted}</div>
            </div>
            <div className="p-3 rounded-lg border bg-primary/5 border-primary/20">
              <div className="text-sm text-muted-foreground">New Plan</div>
              <div className="font-semibold">{targetPlan.name}</div>
              <div className="text-lg">{targetPlan.price.formatted}</div>
            </div>
          </div>

          {/* Proration preview for upgrades */}
          {!isDowngrade && previewLoading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              <span className="text-sm text-muted-foreground">Calculating...</span>
            </div>
          )}

          {!isDowngrade && preview?.proration && (
            <div className="p-3 rounded-lg border bg-muted/30 space-y-2">
              <div className="text-sm font-medium">Amount due today</div>
              <div className="text-2xl font-bold">
                {formatAmount(preview.invoice?.amountDue || 0)}
              </div>
              {preview.proration.items.length > 0 && (
                <div className="text-xs text-muted-foreground space-y-1">
                  {preview.proration.items.map((item, i) => (
                    <div key={i} className="flex justify-between">
                      <span className="truncate mr-2">{item.description}</span>
                      <span>{formatAmount(item.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Downgrade notice */}
          {isDowngrade && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Your {currentPlan.name} features will remain active until your next billing date.
                After that, you&apos;ll be on the {targetPlan.name} plan at {targetPlan.price.formatted}/month.
              </AlertDescription>
            </Alert>
          )}

          {/* Error */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
            className="sm:flex-1"
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading || previewLoading}
            className="sm:flex-1"
            variant={isDowngrade ? 'outline' : 'default'}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Processing...
              </>
            ) : isDowngrade ? (
              'Confirm Downgrade'
            ) : (
              'Confirm Upgrade'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
