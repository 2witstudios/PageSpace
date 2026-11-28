'use client';

import { useState, type ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PLAN_ORDER, type PlanDefinition, type SubscriptionTier } from '@/lib/subscription/plans';
import { planFacts } from '@pagespace/lib/billing/credit-copy';

interface PlanCardProps {
  plan: PlanDefinition;
  currentTier: SubscriptionTier;
  isCurrentPlan?: boolean;
  isScheduledPlan?: boolean;
  hasPendingSchedule?: boolean;
  onUpgrade?: (targetTier: SubscriptionTier) => void;
  onManageBilling?: () => void;
  onCancelSchedule?: () => void;
  cancellingSchedule?: boolean;
  /**
   * Rendered in place of the action button — e.g. "Managed in the App Store"
   * when the plan was bought in the iOS app and Stripe must not change it.
   */
  actionOverride?: ReactNode;
  className?: string;
}

export function PlanCard({
  plan,
  currentTier,
  isCurrentPlan = false,
  isScheduledPlan = false,
  hasPendingSchedule = false,
  onUpgrade,
  onManageBilling,
  onCancelSchedule,
  cancellingSchedule = false,
  actionOverride,
  className,
}: PlanCardProps) {
  // MON-6 / SEAT-2: price, seat terms, and per-seat credits from the same source as the
  // marketing pricing page. Included credits stay on `plan`: withCreditOverrides may patch them.
  const facts = planFacts(plan.id);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleAction = async () => {
    setIsProcessing(true);
    try {
      if (isCurrentPlan) {
        // Current plan - open billing portal
        if (onManageBilling) {
          await onManageBilling();
        }
      } else {
        // Different plan - handle upgrade/downgrade
        if (onUpgrade) {
          await onUpgrade(plan.id);
        }
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const getActionButton = () => {
    // If this plan is scheduled (where they're downgrading TO), show manage billing
    if (isScheduledPlan) {
      return (
        <Button
          variant="outline"
          onClick={handleAction}
          disabled={isProcessing}
          className="w-full flex items-center gap-2"
        >
          <ExternalLink className="h-4 w-4" />
          {isProcessing ? "Opening..." : "Manage Billing"}
        </Button>
      );
    }

    if (isCurrentPlan) {
      // If there's a pending schedule (downgrade), show cancel button
      if (hasPendingSchedule) {
        return (
          <Button
            variant="outline"
            onClick={onCancelSchedule}
            disabled={cancellingSchedule}
            className="w-full"
          >
            {cancellingSchedule ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Cancelling...
              </>
            ) : (
              'Cancel Downgrade'
            )}
          </Button>
        );
      }

      // Normal case - show manage billing
      return (
        <Button
          variant="outline"
          onClick={handleAction}
          disabled={isProcessing}
          className="w-full flex items-center gap-2"
        >
          <ExternalLink className="h-4 w-4" />
          {isProcessing ? "Opening..." : "Manage Billing"}
        </Button>
      );
    }

    // Determine if this is an upgrade or downgrade
    const currentIndex = PLAN_ORDER.indexOf(currentTier);
    const targetIndex = PLAN_ORDER.indexOf(plan.id);
    const isUpgrade = targetIndex > currentIndex;
    const isDowngrade = targetIndex < currentIndex;

    if (isUpgrade) {
      return (
        <Button
          onClick={handleAction}
          disabled={isProcessing}
          className="w-full"
          variant="default"
        >
          {isProcessing ? "Processing..." : `Upgrade to ${plan.displayName}`}
        </Button>
      );
    }

    if (isDowngrade) {
      return (
        <Button
          onClick={handleAction}
          disabled={isProcessing}
          className="w-full"
          variant="secondary"
        >
          {isProcessing ? "Processing..." : `Downgrade to ${plan.displayName}`}
        </Button>
      );
    }

    // Same tier but not current (shouldn't happen)
    return (
      <Button
        disabled
        className="w-full"
        variant="secondary"
      >
        Current Plan
      </Button>
    );
  };

  return (
    <Card
      className={cn(
        'relative transition-all duration-300 hover:shadow-lg flex flex-col w-full',
        plan.highlighted && 'ring-2 ring-zinc-400 dark:ring-zinc-500 shadow-lg',
        isCurrentPlan && 'ring-2 ring-zinc-900 dark:ring-zinc-100',
        isScheduledPlan && !isCurrentPlan && 'ring-2 ring-blue-400 dark:ring-blue-500',
        plan.accentColor,
        className
      )}
    >
      {/* Badge */}
      {plan.badge && (
        <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
          <Badge
            variant={plan.badge.variant}
            className={cn(
              'px-3 py-1 text-xs font-medium',
              plan.badge.className
            )}
          >
            {plan.badge.text}
          </Badge>
        </div>
      )}

      {/* Current Plan Badge */}
      {isCurrentPlan && (
        <div className="absolute -top-3 right-4">
          <Badge className="bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100">
            Current Plan
          </Badge>
        </div>
      )}

      {/* Scheduled Plan Badge */}
      {isScheduledPlan && !isCurrentPlan && (
        <div className="absolute -top-3 right-4">
          <Badge variant="secondary" className="bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200 dark:border-blue-800">
            Scheduled
          </Badge>
        </div>
      )}

      <CardHeader className="text-center pb-4">
        <div className="flex flex-col items-center gap-2">
          <div className={cn('p-2 rounded-full bg-white/10 backdrop-blur-sm')}>
            <plan.icon className={cn('h-6 w-6', plan.iconColor)} />
          </div>
          <CardTitle className="text-xl font-bold">{plan.displayName}</CardTitle>
        </div>
        <div className="pt-2">
          <span className="text-3xl font-bold" data-testid="plan-price">{facts.priceCents > 0 ? facts.price : plan.price.formatted}</span>
          {facts.period && <span className="text-sm text-muted-foreground">{facts.period}</span>}
        </div>
      </CardHeader>

      <CardContent className="flex-grow flex flex-col justify-between">
        <CardDescription className="text-center text-sm mb-6 min-h-[2.5rem]">
          {plan.description}
        </CardDescription>

        <div className="space-y-4">
          {/* MON-6: included credits and the top-up rate as separate facts from the price. */}
          <dl className="divide-y divide-border rounded-lg border border-border text-sm">
            <div className="flex items-start justify-between gap-4 px-4 py-3">
              <dt className="text-muted-foreground shrink-0">Included</dt>
              <dd className="font-medium text-right" data-testid="plan-included-credits">{plan.includedCredits}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 px-4 py-3">
              <dt className="text-muted-foreground shrink-0">Top up</dt>
              <dd className="font-medium text-right" data-testid="plan-topup-rate">{plan.topUpRate}</dd>
            </div>
          </dl>

          {/* SEAT-2: Business is the org plan; A-7 / D-OW-30: no org trial, card at checkout. */}
          {facts.org && (
            <div className="rounded-lg bg-muted/60 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Team terms</p>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Seats</dt>
                  <dd className="font-medium mt-0.5" data-testid="plan-seats">{facts.org.seatTerms}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Extra seat credits</dt>
                  <dd className="font-medium mt-0.5" data-testid="plan-seat-credits">{facts.org.extraSeatCredits}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Checkout</dt>
                  <dd className="font-medium mt-0.5" data-testid="plan-checkout">{facts.org.checkout}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>

        <div className="mt-auto">
          {actionOverride ?? getActionButton()}
        </div>
      </CardContent>
    </Card>
  );
}