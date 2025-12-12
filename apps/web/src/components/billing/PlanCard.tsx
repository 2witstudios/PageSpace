'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PlanDefinition, SubscriptionTier } from '@/lib/subscription/plans';

interface PlanCardProps {
  plan: PlanDefinition;
  currentTier: SubscriptionTier;
  isCurrentPlan?: boolean;
  onUpgrade?: (targetTier: SubscriptionTier) => void;
  onManageBilling?: () => void;
  className?: string;
}

export function PlanCard({
  plan,
  currentTier,
  isCurrentPlan = false,
  onUpgrade,
  onManageBilling,
  className,
}: PlanCardProps) {
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
    if (isCurrentPlan) {
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
    const planOrder = ['free', 'pro', 'founder', 'business'];
    const currentIndex = planOrder.indexOf(currentTier);
    const targetIndex = planOrder.indexOf(plan.id);
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
          variant="outline"
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
        'relative transition-all duration-300 hover:shadow-lg flex flex-col min-w-[280px] shrink-0 snap-center',
        plan.highlighted && 'ring-2 ring-zinc-400 dark:ring-zinc-500 shadow-lg',
        isCurrentPlan && 'ring-2 ring-zinc-900 dark:ring-zinc-100',
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

      <CardHeader className="text-center pb-4">
        <div className="flex flex-col items-center gap-2">
          <div className={cn('p-2 rounded-full bg-white/10 backdrop-blur-sm')}>
            <plan.icon className={cn('h-6 w-6', plan.iconColor)} />
          </div>
          <CardTitle className="text-xl font-bold">{plan.displayName}</CardTitle>
        </div>
        <div className="pt-2">
          <span className="text-3xl font-bold">{plan.price.formatted}</span>
          {plan.price.monthly > 0 && (
            <span className="text-sm text-muted-foreground">/month</span>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex-grow flex flex-col justify-between">
        <CardDescription className="text-center text-sm mb-4 h-10">
          {plan.description}
        </CardDescription>
        
        <div className="mt-auto">
          {getActionButton()}
        </div>
      </CardContent>
    </Card>
  );
}