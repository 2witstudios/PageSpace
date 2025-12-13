'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, CheckCircle, X, Tag } from 'lucide-react';
import { post } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';

export interface AppliedPromo {
  code: string;
  promotionCodeId: string;
  coupon: {
    id: string;
    name: string | null;
    percentOff: number | null;
    amountOff: number | null;
    currency: string | null;
    duration: 'forever' | 'once' | 'repeating';
    durationInMonths: number | null;
  };
  discount: {
    originalAmount: number;
    discountedAmount: number;
    savings: number;
    savingsFormatted: string;
  };
}

interface PromoCodeInputProps {
  priceId: string;
  onPromoApplied: (promo: AppliedPromo | null) => void;
  disabled?: boolean;
  className?: string;
}

interface ValidateResponse {
  valid: boolean;
  promotionCodeId?: string;
  coupon?: AppliedPromo['coupon'];
  discount?: AppliedPromo['discount'];
  error?: string;
}

/**
 * Reusable component for promo code entry and validation.
 * Shows input + Apply button, or success badge when promo is applied.
 */
export function PromoCodeInput({
  priceId,
  onPromoApplied,
  disabled = false,
  className,
}: PromoCodeInputProps) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null);

  const handleApply = async () => {
    if (!code.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const response = await post<ValidateResponse>(
        '/api/stripe/validate-promo-code',
        { code: code.trim(), priceId }
      );

      if (response.valid && response.promotionCodeId && response.coupon && response.discount) {
        const promo: AppliedPromo = {
          code: code.toUpperCase().trim(),
          promotionCodeId: response.promotionCodeId,
          coupon: response.coupon,
          discount: response.discount,
        };
        setAppliedPromo(promo);
        onPromoApplied(promo);
        setCode('');
      } else {
        setError(response.error || 'Invalid promotion code');
      }
    } catch {
      setError('Failed to validate promotion code');
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = () => {
    setAppliedPromo(null);
    onPromoApplied(null);
    setError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApply();
    }
  };

  // Duration label for display
  const getDurationLabel = (promo: AppliedPromo) => {
    switch (promo.coupon.duration) {
      case 'forever':
        return 'forever';
      case 'once':
        return 'first month';
      case 'repeating':
        return promo.coupon.durationInMonths
          ? `${promo.coupon.durationInMonths} months`
          : '';
      default:
        return '';
    }
  };

  return (
    <div className={cn('space-y-2', className)}>
      {!appliedPromo ? (
        <>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Tag className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Enter promo code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase());
                  setError(null);
                }}
                onKeyDown={handleKeyDown}
                disabled={loading || disabled}
                className={cn(
                  'pl-9',
                  error && 'border-destructive focus-visible:ring-destructive'
                )}
                aria-invalid={!!error}
                aria-describedby={error ? 'promo-error' : undefined}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleApply}
              disabled={!code.trim() || loading || disabled}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  <span className="sr-only">Validating</span>
                </>
              ) : (
                'Apply'
              )}
            </Button>
          </div>
          {error && (
            <p id="promo-error" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </>
      ) : (
        <div className="flex items-center justify-between p-3 rounded-lg border bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-800">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
            <span className="font-medium text-green-800 dark:text-green-200">
              {appliedPromo.code}
            </span>
            <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              {appliedPromo.discount.savingsFormatted} off
              {getDurationLabel(appliedPromo) && ` (${getDurationLabel(appliedPromo)})`}
            </Badge>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            disabled={disabled}
            className="h-8 w-8 p-0 hover:bg-green-100 dark:hover:bg-green-900"
            aria-label="Remove promotion code"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
